'use strict';
/*
 * Facturen-app — opslag op de pod (wv824, F1c, 22-10-2026; bouwplan vault "01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md"
 * § 4.1, § 4.2 en § 7; datamodel uit ontwerp v2 § 4.4 in /opt/data/mk-scripts/facturen/overdracht-2210/bouwplan.md).
 *
 * SQLite (node:sqlite) in /opt/data/facturen/facturen.sqlite (600, WAL; map 700), stukken in stukken/<sha256[0:2]>/<sha256> (map 700,
 * bestand 600), back-ups in backup/ (VACUUM INTO, 14 dagen). Het schema staat in genummerde migraties; een migratie verandert nooit meer
 * nadat hij is uitgerold (een wijziging wordt een nieuwe migratie).
 *
 * De database dwingt zelf af wat nooit mag, ook als de code een fout maakt:
 * - Privé gaat nooit naar de boekhouder: entiteit prive heeft geen boekhoud- of afschriftadres (CHECK); een opdracht voor prive kan niet
 *   bestaan (CHECK); een factuur onderweg naar de boekhouder heeft een entiteit die niet prive is (CHECK); een triggerpaar houdt
 *   opdracht.entiteit gelijk aan de entiteit van de factuur of het afschrift (insert én update, ook van de factuur of de rekening).
 * - Het doeladres van een opdracht is het adres uit de entiteitentabel, nooit iets anders (trigger).
 * - Een opdracht is na het aanmaken onveranderlijk in wat er verstuurd wordt (doel, bijlagen, vingerafdruk, sleutel); hooguit één levende
 *   opdracht per factuur of afschrift, en een verstuurde factuur krijgt nooit een tweede.
 * - Een document is hooguit één factuur (splitsen bestaat niet); een factuur heeft precies één entiteit (één kolom).
 * - Regels van een rekening met controle 0 (Privé) worden nooit opgeslagen; POT-regels houden alleen_eigenaar (trigger).
 * - Een praktijkmanager kan niet aan Privé gekoppeld worden (trigger). Het auditlog is alleen-toevoegen (trigger).
 * - Geen kolom voor factuurtekst of mailtekst: alleen velden, besluitrijen en audit.
 *
 * Geen netwerk- of procesmodule (CI-poort in .github/workflows/build.yml): versturen doet de koerier (F4), routes doet facturen.js (F2).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const K = require('./facturen-kern.js');

const BESTAND = 'facturen.sqlite';
const MAX_STUK = 20 * 1024 * 1024;
const BACKUP_DAGEN = 14;
const SHA_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[0-9a-f]{16}$/;
const WACHT = new Int32Array(new SharedArrayBuffer(4));   // voor een korte synchrone pauze (Atomics.wait)

class DbFout extends Error {
  constructor(code, uitleg) { super(uitleg || code); this.code = code; this.uitleg = uitleg || code; }
}

// ───────────────────────────── schema (genummerde migraties) ─────────────────────────────
// De lijsten staan hier bevroren (een migratie verandert nooit); de toets vergelijkt ze met facturen-kern.js en facturen-bank.js.
const L = {
  status: ['te_beoordelen', 'geen_factuur', 'dubbel', 'in_wachtrij', 'prive_archief', 'wordt_verstuurd', 'concept_klaar', 'verstuurd', 'verzending_mislukt'],
  onderweg: ['in_wachtrij', 'wordt_verstuurd', 'concept_klaar', 'verstuurd', 'verzending_mislukt'],
  betaalspoor: ['te_betalen', 'ingevoerd', 'incasso_verwacht', 'betaald_vooraf', 'betaald_gezien'],
  betaalwijze: ['zelf', 'incasso', 'betaald', 'onbekend'],
  opdrachtStatus: ['wacht', 'opgehaald', 'gelukt', 'mislukt', 'geweigerd', 'teruggedraaid'],
  besluitBron: ['anker', 'leverancier', 'regel', 'bank', 'model', 'mens'],
  formaat: ['ing_csv', 'abn_tab', 'abn_mt940', 'bankluis'],
  categorie: ['loon', 'loonheffing', 'btw', 'belasting', 'declaraties', 'rekening_courant', 'eigen_overboeking', 'bankkosten', 'creditcard',
    'prive_opname', 'abonnement_zonder_factuur', 'subsidie', 'rente', 'overig'],
  signaal: ['geen_factuur', 'dubbel_betaald', 'dubbele_factuur', 'verzending_mislukt', 'incasso_niet_gezien', 'te_betalen_niet_betaald',
    'ingevoerd_niet_gezien', 'onbekend_iban', 'mogelijk_dubbel_geupload'],
};
const IN = (l) => '(' + l.map((x) => "'" + x + "'").join(',') + ')';
const ID = (k) => 'CHECK (length(' + k + ') = 16 AND ' + k + " NOT GLOB '*[^0-9a-f]*')";
const SHA = (k) => 'CHECK (length(' + k + ') = 64 AND ' + k + " NOT GLOB '*[^0-9a-f]*')";
const BOOL = (k) => 'CHECK (' + k + ' IN (0,1))';
const JSONL = (k) => 'CHECK (json_valid(' + k + ") AND json_type(" + k + ") = 'array')";
const JSONO = (k) => 'CHECK (' + k + ' IS NULL OR json_valid(' + k + '))';
const DATUM = (k) => 'CHECK (' + k + ' IS NULL OR ' + k + " GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')";
const ADRES = (k) => 'CHECK (' + k + ' IS NULL OR (length(' + k + ') BETWEEN 3 AND 254 AND ' + k + " LIKE '%_@_%' AND " + k + " NOT GLOB '*[ ,;<>]*'))";
const IBAN = (k) => 'CHECK (' + k + ' IS NULL OR (length(' + k + ') BETWEEN 15 AND 34 AND ' + k + " NOT GLOB '*[^A-Z0-9]*'))";
// Een opdracht "leeft" zolang hij nog verstuurd kan worden of verstuurd is (mislukt met poging < 3 komt nog een keer mee).
const LEVEND = "(status IN ('wacht','opgehaald','gelukt') OR (status = 'mislukt' AND poging < 3))";

const M1 = `
CREATE TABLE meta (sleutel TEXT PRIMARY KEY, waarde TEXT);

CREATE TABLE entiteit (
  sleutel TEXT PRIMARY KEY CHECK (length(sleutel) BETWEEN 2 AND 32 AND sleutel NOT GLOB '*[^a-z_]*'),
  naam TEXT NOT NULL, naam_kort TEXT, aliassen TEXT NOT NULL DEFAULT '[]' ${JSONL('aliassen')},
  fin_code TEXT, kvk TEXT, btw TEXT,
  actief INTEGER NOT NULL DEFAULT 1 ${BOOL('actief')},
  boekhoud_doel TEXT ${ADRES('boekhoud_doel')},
  boekhoud_route TEXT CHECK (boekhoud_route IS NULL OR boekhoud_route IN ('exact','mail')),
  afschrift_doel TEXT ${ADRES('afschrift_doel')},
  -- Privé gaat nooit naar de boekhouder: geen adres, geen route
  CHECK (sleutel <> 'prive' OR (boekhoud_doel IS NULL AND afschrift_doel IS NULL AND boekhoud_route IS NULL))
);

CREATE TABLE rekening (
  id TEXT PRIMARY KEY ${ID('id')},
  entiteit TEXT NOT NULL REFERENCES entiteit(sleutel),
  iban TEXT NOT NULL UNIQUE ${IBAN('iban')},
  bank TEXT CHECK (bank IS NULL OR bank IN ('ABN','ING')),
  bank_formaat TEXT NOT NULL CHECK (bank_formaat IN ${IN(L.formaat)}),
  bankluis_rek TEXT,
  afschrift_doorsturen INTEGER NOT NULL DEFAULT 0 ${BOOL('afschrift_doorsturen')},
  controle INTEGER NOT NULL ${BOOL('controle')},
  alleen_eigenaar INTEGER NOT NULL DEFAULT 0 ${BOOL('alleen_eigenaar')},
  waarschuw_na_dagen INTEGER NOT NULL DEFAULT 5 CHECK (waarschuw_na_dagen > 0),
  rood_na_dagen INTEGER NOT NULL DEFAULT 10 CHECK (rood_na_dagen >= waarschuw_na_dagen),
  laatste_invoer_op TEXT,
  CHECK ((bank_formaat = 'bankluis') = (bankluis_rek IS NOT NULL))
);

CREATE TABLE gebruiker (
  id TEXT PRIMARY KEY ${ID('id')},
  email TEXT UNIQUE, naam TEXT,
  ingang TEXT NOT NULL CHECK (ingang IN ('app','fac')),
  rol TEXT NOT NULL CHECK (rol IN ('eigenaar','praktijkmanager')),
  mag_bevestigen INTEGER NOT NULL DEFAULT 1 ${BOOL('mag_bevestigen')},
  actief INTEGER NOT NULL DEFAULT 1 ${BOOL('actief')}
);
CREATE TABLE gebruiker_entiteit (
  gebruiker TEXT NOT NULL REFERENCES gebruiker(id) ON DELETE CASCADE,
  entiteit TEXT NOT NULL REFERENCES entiteit(sleutel),
  PRIMARY KEY (gebruiker, entiteit)
);

CREATE TABLE bron (
  id TEXT PRIMARY KEY ${ID('id')},
  soort TEXT NOT NULL CHECK (soort IN ('verzamelpostvak','upload','bankluis')),
  naam TEXT NOT NULL UNIQUE,
  actief INTEGER NOT NULL DEFAULT 0 ${BOOL('actief')}
);
CREATE TABLE bron_ronde (
  id INTEGER PRIMARY KEY,
  bron TEXT NOT NULL REFERENCES bron(id),
  start TEXT NOT NULL, eind TEXT,
  ok INTEGER CHECK (ok IS NULL OR ok IN (0,1)),
  aantallen TEXT ${JSONO('aantallen')}, fouten TEXT ${JSONO('fouten')}, niet_gelezen TEXT ${JSONO('niet_gelezen')}
);

CREATE TABLE bericht (
  id TEXT PRIMARY KEY ${ID('id')},
  bron TEXT NOT NULL REFERENCES bron(id),
  message_id TEXT NOT NULL, draad_id TEXT,
  afzender TEXT CHECK (afzender IS NULL OR length(afzender) <= 320),
  onderwerp TEXT CHECK (onderwerp IS NULL OR length(onderwerp) <= 300),
  datum_lokaal TEXT, bron_link TEXT CHECK (bron_link IS NULL OR length(bron_link) <= 500),
  ontvangen_op TEXT NOT NULL,
  UNIQUE (bron, message_id)
);

CREATE TABLE document (
  id TEXT PRIMARY KEY ${ID('id')},
  sha256 TEXT NOT NULL UNIQUE ${SHA('sha256')},
  bericht TEXT REFERENCES bericht(id),
  naam TEXT CHECK (naam IS NULL OR length(naam) <= 255),
  mime TEXT CHECK (mime IS NULL OR length(mime) <= 100),
  bytes INTEGER CHECK (bytes IS NULL OR bytes BETWEEN 0 AND ${MAX_STUK}),
  soort TEXT NOT NULL CHECK (soort IN ('pdf','ubl','afbeelding','mt940','overig')),
  tekstlaag INTEGER CHECK (tekstlaag IS NULL OR tekstlaag IN (0,1)),
  patientkenmerk INTEGER NOT NULL DEFAULT 0 ${BOOL('patientkenmerk')},
  te_lezen INTEGER NOT NULL DEFAULT 0 ${BOOL('te_lezen')},
  geupload_door TEXT,
  aangemaakt_op TEXT NOT NULL
);

CREATE TABLE leverancier (
  id TEXT PRIMARY KEY ${ID('id')},
  naam TEXT NOT NULL CHECK (length(naam) BETWEEN 1 AND 200),
  genormaliseerd TEXT NOT NULL,
  domeinen TEXT NOT NULL DEFAULT '[]' ${JSONL('domeinen')},
  kvk TEXT, btw TEXT,
  standaard_entiteit TEXT REFERENCES entiteit(sleutel),
  standaard_betaalwijze TEXT CHECK (standaard_betaalwijze IS NULL OR standaard_betaalwijze IN ('zelf','incasso','betaald')),
  mediaan TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mediaan) AND json_type(mediaan) = 'object'),
  alleen_portaal INTEGER NOT NULL DEFAULT 0 ${BOOL('alleen_portaal')},
  incassant_ids TEXT NOT NULL DEFAULT '[]' ${JSONL('incassant_ids')},
  incasso_tolerantie_pct REAL CHECK (incasso_tolerantie_pct IS NULL OR incasso_tolerantie_pct BETWEEN 0 AND 100),
  aangemaakt_op TEXT NOT NULL, bijgewerkt_op TEXT
);
-- bekende IBAN's, alleen na een menselijk oordeel (Nagebeld): wie en wanneer zijn verplicht
CREATE TABLE leverancier_iban (
  leverancier TEXT NOT NULL REFERENCES leverancier(id),
  iban TEXT NOT NULL ${IBAN('iban')},
  toegevoegd_door TEXT NOT NULL, toegevoegd_op TEXT NOT NULL,
  PRIMARY KEY (leverancier, iban)
);

CREATE TABLE tekstanker (
  id INTEGER PRIMARY KEY,
  tekst TEXT NOT NULL UNIQUE CHECK (length(tekst) BETWEEN 3 AND 200),
  entiteit TEXT NOT NULL REFERENCES entiteit(sleutel),
  actief INTEGER NOT NULL DEFAULT 1 ${BOOL('actief')},
  aangemaakt_door TEXT, aangemaakt_op TEXT
);
CREATE TABLE geen_factuur (
  id INTEGER PRIMARY KEY,
  patroon TEXT NOT NULL CHECK (length(patroon) BETWEEN 2 AND 200),
  leverancier TEXT REFERENCES leverancier(id),
  toelichting TEXT,
  actief INTEGER NOT NULL DEFAULT 1 ${BOOL('actief')},
  aangemaakt_door TEXT, aangemaakt_op TEXT,
  UNIQUE (patroon, leverancier)
);

CREATE TABLE factuur (
  id TEXT PRIMARY KEY ${ID('id')},
  document TEXT NOT NULL UNIQUE REFERENCES document(id),
  ubl_document TEXT UNIQUE REFERENCES document(id),
  bericht TEXT REFERENCES bericht(id),
  soort TEXT NOT NULL DEFAULT 'factuur' CHECK (soort IN ('factuur','creditnota')),
  leverancier TEXT REFERENCES leverancier(id),
  leverancier_naam TEXT CHECK (leverancier_naam IS NULL OR length(leverancier_naam) <= 200), leverancier_kvk TEXT,
  nummer TEXT CHECK (nummer IS NULL OR length(nummer) <= 100),
  factuurdatum TEXT ${DATUM('factuurdatum')}, vervaldatum TEXT ${DATUM('vervaldatum')},
  excl INTEGER, btw INTEGER, incl INTEGER,
  valuta TEXT NOT NULL DEFAULT 'EUR' CHECK (length(valuta) = 3 AND valuta NOT GLOB '*[^A-Z]*'),
  incl_eur INTEGER,
  iban TEXT ${IBAN('iban')},
  ibans_betaal TEXT NOT NULL DEFAULT '[]' ${JSONL('ibans_betaal')},
  iban_nieuw INTEGER NOT NULL DEFAULT 0 ${BOOL('iban_nieuw')},
  ibans_onbekend TEXT NOT NULL DEFAULT '[]' ${JSONL('ibans_onbekend')},
  nagebeld_door TEXT, nagebeld_op TEXT,
  nagebeld_ibans TEXT NOT NULL DEFAULT '[]' ${JSONL('nagebeld_ibans')},
  kenmerk TEXT CHECK (kenmerk IS NULL OR length(kenmerk) <= 100),
  betaalwijze TEXT NOT NULL DEFAULT 'onbekend' CHECK (betaalwijze IN ${IN(L.betaalwijze)}),
  entiteit TEXT REFERENCES entiteit(sleutel),
  intern INTEGER NOT NULL DEFAULT 0 ${BOOL('intern')},
  status TEXT NOT NULL CHECK (status IN ${IN(L.status)}),
  redenen TEXT NOT NULL DEFAULT '[]' ${JSONL('redenen')},
  controles TEXT NOT NULL DEFAULT '[]' ${JSONL('controles')},
  patientkenmerk INTEGER NOT NULL DEFAULT 0 ${BOOL('patientkenmerk')},
  alleen_eigenaar INTEGER NOT NULL DEFAULT 0 ${BOOL('alleen_eigenaar')},
  dubbel_van TEXT REFERENCES factuur(id),
  bevestigd_door TEXT, bevestigd_op TEXT,
  betaalspoor TEXT CHECK (betaalspoor IS NULL OR betaalspoor IN ${IN(L.betaalspoor)}),
  ingevoerd_door TEXT, ingevoerd_op TEXT, betaald_gezien_op TEXT,
  aangemaakt_op TEXT NOT NULL, bijgewerkt_op TEXT NOT NULL,
  versie INTEGER NOT NULL DEFAULT 1,
  -- Privé gaat nooit naar de boekhouder: wat onderweg is naar de boekhouder heeft een entiteit, en die is niet prive
  CHECK (status NOT IN ${IN(L.onderweg)} OR (entiteit IS NOT NULL AND entiteit <> 'prive')),
  CHECK (status <> 'prive_archief' OR entiteit = 'prive'),
  -- bevestigd = betaalwijze bekend + betaalspoor + wie/wanneer
  CHECK (status NOT IN ${IN(L.onderweg.concat(['prive_archief']))} OR (betaalwijze <> 'onbekend' AND betaalspoor IS NOT NULL AND bevestigd_op IS NOT NULL AND bevestigd_door IS NOT NULL)),
  CHECK (ubl_document IS NULL OR ubl_document <> document),
  CHECK (dubbel_van IS NULL OR dubbel_van <> id)
);

CREATE TABLE besluit (
  id INTEGER PRIMARY KEY,
  factuur TEXT NOT NULL REFERENCES factuur(id),
  stap TEXT NOT NULL, veld TEXT,
  waarde TEXT CHECK (waarde IS NULL OR length(waarde) <= 500),
  bron TEXT NOT NULL CHECK (bron IN ${IN(L.besluitBron)}),
  toelichting TEXT CHECK (toelichting IS NULL OR length(toelichting) <= 500),
  wie TEXT, wanneer TEXT NOT NULL
);

CREATE TABLE pot_afschrift (
  id TEXT PRIMARY KEY ${ID('id')},
  rekening TEXT NOT NULL REFERENCES rekening(id),
  periode TEXT NOT NULL CHECK (periode GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR periode GLOB '[0-9][0-9][0-9][0-9]-W[0-5][0-9]'),
  mt940_document TEXT REFERENCES document(id),
  pdf_document TEXT REFERENCES document(id),
  status TEXT NOT NULL DEFAULT 'onvolledig' CHECK (status IN ('onvolledig','klaar','in_wachtrij','verstuurd')),
  aangemaakt_op TEXT NOT NULL, bijgewerkt_op TEXT NOT NULL,
  UNIQUE (rekening, periode),
  CHECK (status = 'onvolledig' OR (mt940_document IS NOT NULL AND pdf_document IS NOT NULL))
);

CREATE TABLE opdracht (
  id TEXT PRIMARY KEY ${ID('id')},
  soort TEXT NOT NULL CHECK (soort IN ('boekhouder_factuur','boekhouder_afschrift')),
  factuur TEXT REFERENCES factuur(id),
  afschrift TEXT REFERENCES pot_afschrift(id),
  entiteit TEXT NOT NULL REFERENCES entiteit(sleutel) CHECK (entiteit <> 'prive'),
  doeladres TEXT NOT NULL ${ADRES('doeladres')},
  bijlagen TEXT NOT NULL CHECK (json_valid(bijlagen) AND json_type(bijlagen) = 'array' AND json_array_length(bijlagen) >= 1),
  vingerafdruk TEXT NOT NULL ${SHA('vingerafdruk')},
  vingerafdruk_koerier TEXT CHECK (vingerafdruk_koerier IS NULL OR (length(vingerafdruk_koerier) = 64 AND vingerafdruk_koerier NOT GLOB '*[^0-9a-f]*')),
  verstuur_na TEXT NOT NULL CHECK (verstuur_na GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]*'),
  idempotentiesleutel TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'wacht' CHECK (status IN ${IN(L.opdrachtStatus)}),
  opgehaald_op TEXT,
  poging INTEGER NOT NULL DEFAULT 0 CHECK (poging BETWEEN 0 AND 3),
  verzend_reservering TEXT, verzend_reservering_op TEXT,
  modus TEXT CHECK (modus IS NULL OR modus IN ('concept','versturen')),
  extern_id TEXT, fout TEXT CHECK (fout IS NULL OR length(fout) <= 500),
  aangemaakt_door TEXT NOT NULL, aangemaakt_op TEXT NOT NULL, bijgewerkt_op TEXT NOT NULL,
  CHECK ((soort = 'boekhouder_factuur' AND factuur IS NOT NULL AND afschrift IS NULL) OR (soort = 'boekhouder_afschrift' AND afschrift IS NOT NULL AND factuur IS NULL)),
  CHECK (status <> 'opgehaald' OR opgehaald_op IS NOT NULL),
  CHECK ((verzend_reservering IS NULL) = (verzend_reservering_op IS NULL))
);

CREATE TABLE bank_bestand (
  id TEXT PRIMARY KEY ${ID('id')},
  sha256 TEXT NOT NULL UNIQUE ${SHA('sha256')},
  formaat TEXT NOT NULL CHECK (formaat IN ('ing_csv','abn_tab','abn_mt940')),
  naam TEXT CHECK (naam IS NULL OR length(naam) <= 255),
  aantal INTEGER NOT NULL DEFAULT 0, prive_weggegooid INTEGER NOT NULL DEFAULT 0,
  per_rekening TEXT ${JSONO('per_rekening')},
  geupload_door TEXT NOT NULL, geupload_op TEXT NOT NULL
);

CREATE TABLE uitzondering (
  id TEXT PRIMARY KEY ${ID('id')},
  richting TEXT NOT NULL DEFAULT 'af' CHECK (richting IN ('af','bij','beide')),
  rekening TEXT ${IBAN('rekening')},
  tegenpartij TEXT, omschrijving TEXT, transactietype TEXT,
  bedrag_centen INTEGER, tolerantie_centen INTEGER, tolerantie_pct REAL,
  categorie TEXT NOT NULL CHECK (categorie IN ${IN(L.categorie)}),
  toelichting TEXT,
  actief INTEGER NOT NULL DEFAULT 1 ${BOOL('actief')},
  alleen_eigenaar INTEGER NOT NULL DEFAULT 0 ${BOOL('alleen_eigenaar')},
  aangemaakt_door TEXT NOT NULL, aangemaakt_op TEXT NOT NULL,
  -- een uitzondering zonder patroon zou alles slikken
  CHECK (tegenpartij IS NOT NULL OR omschrijving IS NOT NULL OR transactietype IS NOT NULL)
);

CREATE TABLE bank_transactie (
  id TEXT PRIMARY KEY ${ID('id')},
  bestand TEXT REFERENCES bank_bestand(id),
  rekening TEXT NOT NULL REFERENCES rekening(id),
  entiteit TEXT NOT NULL REFERENCES entiteit(sleutel) CHECK (entiteit <> 'prive'),
  eigen_iban TEXT NOT NULL ${IBAN('eigen_iban')},
  boekdatum TEXT NOT NULL ${DATUM('boekdatum')},
  bedrag_centen INTEGER NOT NULL,
  valuta TEXT NOT NULL DEFAULT 'EUR',
  tegenpartij_naam TEXT CHECK (tegenpartij_naam IS NULL OR length(tegenpartij_naam) <= 200),
  tegenpartij_iban TEXT,
  omschrijving TEXT CHECK (omschrijving IS NULL OR length(omschrijving) <= 200),
  kenmerk TEXT CHECK (kenmerk IS NULL OR length(kenmerk) <= 200),
  transactietype TEXT CHECK (transactietype IS NULL OR length(transactietype) <= 60),
  is_incasso INTEGER NOT NULL DEFAULT 0 ${BOOL('is_incasso')},
  incassant_id TEXT, machtiging TEXT,
  entry_ref TEXT NOT NULL UNIQUE,
  formaat TEXT NOT NULL CHECK (formaat IN ${IN(L.formaat)}),
  bankluis_sleutel TEXT,
  bestand_op TEXT,
  alleen_eigenaar INTEGER NOT NULL DEFAULT 0 ${BOOL('alleen_eigenaar')},
  categorie TEXT CHECK (categorie IS NULL OR categorie IN ${IN(L.categorie)}),
  uitzondering TEXT REFERENCES uitzondering(id),
  verwijderd_op TEXT, verwijderd_door TEXT,
  aangemaakt_op TEXT NOT NULL,
  CHECK ((formaat = 'bankluis') = (bestand IS NULL)),
  CHECK ((formaat = 'bankluis') = (bankluis_sleutel IS NOT NULL))
);

CREATE TABLE koppeling (
  id INTEGER PRIMARY KEY,
  transactie TEXT NOT NULL REFERENCES bank_transactie(id),
  factuur TEXT NOT NULL REFERENCES factuur(id),
  bron TEXT NOT NULL CHECK (bron IN ('auto','mens')),
  methode TEXT, zekerheid REAL CHECK (zekerheid IS NULL OR zekerheid BETWEEN 0 AND 1),
  volledig INTEGER CHECK (volledig IS NULL OR volledig IN (0,1)),
  alleen_eigenaar INTEGER NOT NULL DEFAULT 0 ${BOOL('alleen_eigenaar')},
  wie TEXT, wanneer TEXT NOT NULL,
  UNIQUE (transactie, factuur),
  CHECK (bron = 'auto' OR wie IS NOT NULL)
);

CREATE TABLE voorstel (
  id INTEGER PRIMARY KEY,
  sleutel TEXT NOT NULL UNIQUE,
  transactie TEXT NOT NULL REFERENCES bank_transactie(id),
  facturen TEXT NOT NULL ${JSONL('facturen')},
  methode TEXT, zekerheid REAL, details TEXT ${JSONO('details')},
  alleen_eigenaar INTEGER NOT NULL DEFAULT 0 ${BOOL('alleen_eigenaar')},
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','bevestigd','afgewezen')),
  aangemaakt_op TEXT NOT NULL, afgehandeld_door TEXT, afgehandeld_op TEXT,
  CHECK (status = 'open' OR (afgehandeld_door IS NOT NULL AND afgehandeld_op IS NOT NULL))
);

CREATE TABLE signaal (
  id TEXT PRIMARY KEY ${ID('id')},
  sleutel TEXT NOT NULL UNIQUE,
  soort TEXT NOT NULL CHECK (soort IN ${IN(L.signaal)}),
  titel TEXT NOT NULL,
  entiteit TEXT REFERENCES entiteit(sleutel),
  leverancier TEXT REFERENCES leverancier(id),
  transacties TEXT NOT NULL DEFAULT '[]' ${JSONL('transacties')},
  facturen TEXT NOT NULL DEFAULT '[]' ${JSONL('facturen')},
  bedrag_centen INTEGER, details TEXT ${JSONO('details')},
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','afgehandeld')),
  afhandeling TEXT, les TEXT CHECK (les IS NULL OR length(les) <= 300),
  wie TEXT, wanneer TEXT, sluimer_tot TEXT ${DATUM('sluimer_tot')},
  alleen_eigenaar INTEGER NOT NULL DEFAULT 0 ${BOOL('alleen_eigenaar')},
  aangemaakt_op TEXT NOT NULL,
  CHECK (status = 'open' OR (afhandeling IS NOT NULL AND wie IS NOT NULL AND wanneer IS NOT NULL))
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  wie TEXT NOT NULL, wat TEXT NOT NULL,
  object_soort TEXT NOT NULL, object_id TEXT, entiteit TEXT,
  voor TEXT ${JSONO('voor')}, na TEXT ${JSONO('na')},
  wanneer TEXT NOT NULL
);

-- ── triggers: wat nooit mag, ook niet bij een fout in de code ──

CREATE TRIGGER rekening_prive_ins BEFORE INSERT ON rekening
WHEN NEW.entiteit = 'prive' AND (NEW.controle <> 0 OR NEW.alleen_eigenaar <> 1 OR NEW.afschrift_doorsturen <> 0)
BEGIN SELECT RAISE(ABORT, 'rekening_prive: een privérekening heeft controle 0, alleen_eigenaar 1 en geen afschrift'); END;
CREATE TRIGGER rekening_prive_upd BEFORE UPDATE ON rekening
WHEN NEW.entiteit = 'prive' AND (NEW.controle <> 0 OR NEW.alleen_eigenaar <> 1 OR NEW.afschrift_doorsturen <> 0)
BEGIN SELECT RAISE(ABORT, 'rekening_prive: een privérekening heeft controle 0, alleen_eigenaar 1 en geen afschrift'); END;

CREATE TRIGGER gebruiker_entiteit_prive BEFORE INSERT ON gebruiker_entiteit
WHEN NEW.entiteit = 'prive' AND (SELECT rol FROM gebruiker WHERE id = NEW.gebruiker) IS NOT 'eigenaar'
BEGIN SELECT RAISE(ABORT, 'gebruiker_prive: alleen de eigenaar ziet Privé'); END;
CREATE TRIGGER gebruiker_entiteit_prive_upd BEFORE UPDATE ON gebruiker_entiteit
WHEN NEW.entiteit = 'prive' AND (SELECT rol FROM gebruiker WHERE id = NEW.gebruiker) IS NOT 'eigenaar'
BEGIN SELECT RAISE(ABORT, 'gebruiker_prive: alleen de eigenaar ziet Privé'); END;
CREATE TRIGGER gebruiker_rol_prive BEFORE UPDATE OF rol ON gebruiker
WHEN NEW.rol <> 'eigenaar' AND EXISTS (SELECT 1 FROM gebruiker_entiteit WHERE gebruiker = NEW.id AND entiteit = 'prive')
BEGIN SELECT RAISE(ABORT, 'gebruiker_prive: alleen de eigenaar ziet Privé'); END;

-- opdracht.entiteit = entiteit van de factuur of het afschrift; doeladres = adres uit de entiteitentabel
CREATE TRIGGER opdracht_ins BEFORE INSERT ON opdracht
BEGIN
  SELECT RAISE(ABORT, 'opdracht_prive: privé gaat nooit naar de boekhouder') WHERE NEW.entiteit = 'prive';
  SELECT RAISE(ABORT, 'opdracht_entiteit: wijkt af van de entiteit van de factuur')
    WHERE NEW.soort = 'boekhouder_factuur' AND NEW.entiteit IS NOT (SELECT entiteit FROM factuur WHERE id = NEW.factuur);
  SELECT RAISE(ABORT, 'opdracht_entiteit: wijkt af van de entiteit van het afschrift')
    WHERE NEW.soort = 'boekhouder_afschrift' AND NEW.entiteit IS NOT (SELECT r.entiteit FROM pot_afschrift a JOIN rekening r ON r.id = a.rekening WHERE a.id = NEW.afschrift);
  SELECT RAISE(ABORT, 'opdracht_doeladres: niet het boekhoudadres van de entiteit')
    WHERE NEW.soort = 'boekhouder_factuur' AND NEW.doeladres IS NOT (SELECT boekhoud_doel FROM entiteit WHERE sleutel = NEW.entiteit);
  SELECT RAISE(ABORT, 'opdracht_doeladres: niet het afschriftadres van de entiteit')
    WHERE NEW.soort = 'boekhouder_afschrift' AND NEW.doeladres IS NOT (SELECT afschrift_doel FROM entiteit WHERE sleutel = NEW.entiteit);
END;
-- wat er verstuurd wordt, verandert na het aanmaken niet meer (anders klopt de vingerafdruk van het akkoord niet); een nieuwe opdracht maken
CREATE TRIGGER opdracht_onveranderlijk BEFORE UPDATE ON opdracht
WHEN NEW.id IS NOT OLD.id OR NEW.soort IS NOT OLD.soort OR NEW.factuur IS NOT OLD.factuur OR NEW.afschrift IS NOT OLD.afschrift
  OR NEW.entiteit IS NOT OLD.entiteit OR NEW.doeladres IS NOT OLD.doeladres OR NEW.bijlagen IS NOT OLD.bijlagen
  OR NEW.vingerafdruk IS NOT OLD.vingerafdruk OR NEW.idempotentiesleutel IS NOT OLD.idempotentiesleutel OR NEW.aangemaakt_op IS NOT OLD.aangemaakt_op
BEGIN SELECT RAISE(ABORT, 'opdracht_onveranderlijk: entiteit, doel, bijlagen en vingerafdruk liggen vast; maak een nieuwe opdracht'); END;
-- levensloop: wat dood is (teruggedraaid, geweigerd, gelukt, drie keer mislukt) leeft niet meer op; poging gaat nooit omlaag; terug naar
-- wacht bestaat niet. Wordt een opdracht (weer) verzendbaar (wacht, opgehaald, mislukt met poging < 3), dan opnieuw toetsen tegen de verse
-- factuur of het verse afschrift: zelfde entiteit, niet prive, nog onderweg, en het doeladres is nog het adres uit de entiteitentabel.
-- (Diffreview wv824 #1: een oude opdracht mocht niet "herleven" nadat de factuur Privé werd.)
CREATE TRIGGER opdracht_levensloop BEFORE UPDATE OF status, poging ON opdracht
WHEN NEW.status IS NOT OLD.status OR NEW.poging IS NOT OLD.poging
BEGIN
  SELECT RAISE(ABORT, 'opdracht_dood: een teruggedraaide, geweigerde, gelukte of drie keer mislukte opdracht leeft niet meer op')
    WHERE OLD.status IN ('teruggedraaid','geweigerd','gelukt') OR (OLD.status = 'mislukt' AND OLD.poging >= 3);
  SELECT RAISE(ABORT, 'opdracht_poging: poging gaat nooit omlaag') WHERE NEW.poging < OLD.poging;
  SELECT RAISE(ABORT, 'opdracht_terug: alleen een wachtende opdracht kan terug') WHERE NEW.status = 'teruggedraaid' AND OLD.status <> 'wacht';
  SELECT RAISE(ABORT, 'opdracht_wacht: een opdracht gaat nooit terug naar wacht') WHERE NEW.status = 'wacht' AND OLD.status <> 'wacht';
  SELECT RAISE(ABORT, 'opdracht_prive: privé gaat nooit naar de boekhouder')
    WHERE (NEW.status IN ('wacht','opgehaald') OR (NEW.status = 'mislukt' AND NEW.poging < 3))
      AND (NEW.entiteit = 'prive' OR (NEW.soort = 'boekhouder_factuur' AND (SELECT entiteit FROM factuur WHERE id = NEW.factuur) IS 'prive'));
  SELECT RAISE(ABORT, 'opdracht_entiteit: de factuur is niet meer van deze entiteit of staat niet meer onderweg')
    WHERE (NEW.status IN ('wacht','opgehaald') OR (NEW.status = 'mislukt' AND NEW.poging < 3)) AND NEW.soort = 'boekhouder_factuur'
      AND NOT EXISTS (SELECT 1 FROM factuur f WHERE f.id = NEW.factuur AND f.entiteit IS NEW.entiteit AND f.status IN ('in_wachtrij','wordt_verstuurd'));
  SELECT RAISE(ABORT, 'opdracht_entiteit: het afschrift is niet meer van deze entiteit of staat niet meer in de wachtrij')
    WHERE (NEW.status IN ('wacht','opgehaald') OR (NEW.status = 'mislukt' AND NEW.poging < 3)) AND NEW.soort = 'boekhouder_afschrift'
      AND NOT EXISTS (SELECT 1 FROM pot_afschrift a JOIN rekening r ON r.id = a.rekening WHERE a.id = NEW.afschrift AND r.entiteit IS NEW.entiteit AND a.status = 'in_wachtrij');
  SELECT RAISE(ABORT, 'opdracht_doeladres: het adres van de entiteit is gewijzigd')
    WHERE (NEW.status IN ('wacht','opgehaald') OR (NEW.status = 'mislukt' AND NEW.poging < 3))
      AND NEW.doeladres IS NOT (SELECT CASE NEW.soort WHEN 'boekhouder_factuur' THEN boekhoud_doel ELSE afschrift_doel END FROM entiteit WHERE sleutel = NEW.entiteit);
END;
-- INSERT OR REPLACE verwijdert en voegt opnieuw toe zonder UPDATE-trigger; met recursive_triggers (open() zet hem aan) vangen deze hem
CREATE TRIGGER factuur_weg_opdracht BEFORE DELETE ON factuur WHEN EXISTS (SELECT 1 FROM opdracht WHERE factuur = OLD.id)
BEGIN SELECT RAISE(ABORT, 'factuur_weg: er hoort een opdracht bij deze factuur'); END;
CREATE TRIGGER afschrift_weg_opdracht BEFORE DELETE ON pot_afschrift WHEN EXISTS (SELECT 1 FROM opdracht WHERE afschrift = OLD.id)
BEGIN SELECT RAISE(ABORT, 'afschrift_weg: er hoort een opdracht bij dit afschrift'); END;
CREATE TRIGGER rekening_weg BEFORE DELETE ON rekening
WHEN EXISTS (SELECT 1 FROM bank_transactie WHERE rekening = OLD.id) OR EXISTS (SELECT 1 FROM pot_afschrift WHERE rekening = OLD.id)
BEGIN SELECT RAISE(ABORT, 'rekening_weg: er horen bankregels of afschriften bij deze rekening'); END;
-- de andere kant: een factuur met een levende opdracht wisselt niet van entiteit (eerst terugdraaien)
CREATE TRIGGER factuur_entiteit_opdracht BEFORE UPDATE OF entiteit ON factuur
WHEN NEW.entiteit IS NOT OLD.entiteit AND EXISTS (SELECT 1 FROM opdracht WHERE factuur = NEW.id AND ${LEVEND})
BEGIN SELECT RAISE(ABORT, 'factuur_entiteit: er loopt een opdracht voor deze factuur; eerst terugdraaien'); END;
CREATE TRIGGER rekening_entiteit_opdracht BEFORE UPDATE OF entiteit ON rekening
WHEN NEW.entiteit IS NOT OLD.entiteit AND EXISTS (SELECT 1 FROM opdracht o JOIN pot_afschrift a ON a.id = o.afschrift WHERE a.rekening = NEW.id AND ${LEVEND.replace(/status|poging/g, (x) => 'o.' + x)})
BEGIN SELECT RAISE(ABORT, 'rekening_entiteit: er loopt een afschriftopdracht voor deze rekening'); END;
CREATE TRIGGER afschrift_rekening_opdracht BEFORE UPDATE OF rekening ON pot_afschrift
WHEN NEW.rekening IS NOT OLD.rekening AND EXISTS (SELECT 1 FROM opdracht WHERE afschrift = NEW.id AND ${LEVEND})
BEGIN SELECT RAISE(ABORT, 'afschrift_rekening: er loopt een opdracht voor dit afschrift'); END;
CREATE TRIGGER afschrift_prive_ins BEFORE INSERT ON pot_afschrift
WHEN (SELECT entiteit FROM rekening WHERE id = NEW.rekening) = 'prive'
BEGIN SELECT RAISE(ABORT, 'afschrift_prive: privé gaat nooit naar de boekhouder'); END;
CREATE TRIGGER afschrift_prive_upd BEFORE UPDATE OF rekening ON pot_afschrift
WHEN (SELECT entiteit FROM rekening WHERE id = NEW.rekening) = 'prive'
BEGIN SELECT RAISE(ABORT, 'afschrift_prive: privé gaat nooit naar de boekhouder'); END;

-- bankregels: Privé (controle 0) nooit opslaan; entiteit en eigenaar-only volgen de rekening
CREATE TRIGGER transactie_ins BEFORE INSERT ON bank_transactie
BEGIN
  SELECT RAISE(ABORT, 'transactie_prive: regels van een rekening zonder controle worden niet opgeslagen')
    WHERE (SELECT controle FROM rekening WHERE id = NEW.rekening) IS NOT 1;
  SELECT RAISE(ABORT, 'transactie_entiteit: wijkt af van de rekening')
    WHERE NEW.entiteit IS NOT (SELECT entiteit FROM rekening WHERE id = NEW.rekening);
  SELECT RAISE(ABORT, 'transactie_eigenaar: deze rekening is alleen voor de eigenaar')
    WHERE NEW.alleen_eigenaar < (SELECT alleen_eigenaar FROM rekening WHERE id = NEW.rekening);
END;
CREATE TRIGGER transactie_upd BEFORE UPDATE OF rekening, entiteit, alleen_eigenaar ON bank_transactie
BEGIN
  SELECT RAISE(ABORT, 'transactie_entiteit: wijkt af van de rekening')
    WHERE NEW.entiteit IS NOT (SELECT entiteit FROM rekening WHERE id = NEW.rekening);
  SELECT RAISE(ABORT, 'transactie_eigenaar: deze rekening is alleen voor de eigenaar')
    WHERE NEW.alleen_eigenaar < (SELECT alleen_eigenaar FROM rekening WHERE id = NEW.rekening);
END;

-- een rekening met opgeslagen regels wordt niet Privé, wisselt niet van entiteit en wordt niet "strenger" dan zijn regels (diffreview #3)
CREATE TRIGGER rekening_regels_upd BEFORE UPDATE OF entiteit, controle, alleen_eigenaar ON rekening
WHEN EXISTS (SELECT 1 FROM bank_transactie t WHERE t.rekening = NEW.id AND (NEW.controle IS NOT 1 OR t.entiteit IS NOT NEW.entiteit OR t.alleen_eigenaar < NEW.alleen_eigenaar))
BEGIN SELECT RAISE(ABORT, 'rekening_regels: er staan bankregels die daarna niet meer kloppen; eerst opruimen'); END;

-- het auditlog is alleen-toevoegen
CREATE TRIGGER audit_geen_wijziging BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit: alleen toevoegen'); END;
CREATE TRIGGER audit_geen_verwijdering BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit: alleen toevoegen'); END;
`;

const M2 = `
-- hooguit één levende opdracht per factuur of afschrift; een verstuurde (gelukt) krijgt er nooit een tweede
CREATE UNIQUE INDEX opdracht_levend_factuur ON opdracht (factuur) WHERE factuur IS NOT NULL AND ${LEVEND};
CREATE UNIQUE INDEX opdracht_levend_afschrift ON opdracht (afschrift) WHERE afschrift IS NOT NULL AND ${LEVEND};
CREATE INDEX opdracht_status ON opdracht (status, verstuur_na);
CREATE INDEX factuur_status ON factuur (status, entiteit);
CREATE INDEX factuur_lev_nummer ON factuur (leverancier, nummer);
CREATE INDEX factuur_betaalspoor ON factuur (betaalspoor);
CREATE INDEX besluit_factuur ON besluit (factuur);
CREATE INDEX leverancier_norm ON leverancier (genormaliseerd);
CREATE INDEX leverancier_iban_iban ON leverancier_iban (iban);
CREATE INDEX bron_ronde_bron ON bron_ronde (bron, start);
CREATE INDEX transactie_rek_datum ON bank_transactie (rekening, boekdatum);
CREATE INDEX transactie_tegen ON bank_transactie (tegenpartij_iban);
CREATE INDEX koppeling_factuur ON koppeling (factuur);
CREATE INDEX signaal_status ON signaal (status, soort);
CREATE INDEX audit_object ON audit (object_soort, object_id);
CREATE INDEX audit_wanneer ON audit (wanneer);
-- instellingen (modus concept tot Davids Ja na de schaduwweek, F5; verzenden op het volgende hele uur)
CREATE TRIGGER meta_modus_ins BEFORE INSERT ON meta WHEN NEW.sleutel = 'verzendmodus' AND NEW.waarde NOT IN ('concept','versturen')
BEGIN SELECT RAISE(ABORT, 'verzendmodus: concept of versturen'); END;
CREATE TRIGGER meta_modus_upd BEFORE UPDATE ON meta WHEN NEW.sleutel = 'verzendmodus' AND NEW.waarde NOT IN ('concept','versturen')
BEGIN SELECT RAISE(ABORT, 'verzendmodus: concept of versturen'); END;
INSERT INTO meta (sleutel, waarde) VALUES ('verzendmodus', 'concept');
INSERT INTO meta (sleutel, waarde) VALUES ('verstuur_instelling', '{"soort":"uur"}');
`;

const MIGRATIES = [
  { versie: 1, naam: 'tabellen, CHECKs en triggers (ontwerp v2 § 4.4 + App-bouwplan § 4.2)', sql: M1 },
  { versie: 2, naam: 'indexen, één levende opdracht per factuur, instellingen', sql: M2 },
];
const SCHEMA_VERSIE = MIGRATIES[MIGRATIES.length - 1].versie;
const TABELLEN = ['meta', 'entiteit', 'rekening', 'gebruiker', 'gebruiker_entiteit', 'bron', 'bron_ronde', 'bericht', 'document', 'leverancier',
  'leverancier_iban', 'tekstanker', 'geen_factuur', 'factuur', 'besluit', 'pot_afschrift', 'opdracht', 'bank_bestand', 'uitzondering',
  'bank_transactie', 'koppeling', 'voorstel', 'signaal', 'audit'];

// ───────────────────────────── openen, migreren, transacties ─────────────────────────────

function nuIso(nu) { return new Date(nu === undefined ? Date.now() : nu).toISOString(); }
function nieuwId() { return crypto.randomBytes(8).toString('hex'); }
function maakMap(p) { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); fs.chmodSync(p, 0o700); }

// Past ontbrekende migraties toe, elk in één BEGIN IMMEDIATE met hercontrole (twee processen die tegelijk openen botsen niet).
// Een database met een nieuwer schema dan deze code kent (terugrollen): weigeren, niet schrijven met oude code.
function migreer(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migratie (versie INTEGER PRIMARY KEY, naam TEXT NOT NULL, toegepast_op TEXT NOT NULL)');
  const hoogste = () => Number((db.prepare('SELECT max(versie) AS v FROM schema_migratie').get() || {}).v || 0);
  if (hoogste() > SCHEMA_VERSIE) throw new DbFout('schema_nieuwer', 'de database heeft schema ' + hoogste() + ', deze code kent ' + SCHEMA_VERSIE);
  const toegepast = [];
  for (const m of MIGRATIES) {
    if (db.prepare('SELECT 1 FROM schema_migratie WHERE versie = ?').get(m.versie)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT 1 FROM schema_migratie WHERE versie = ?').get(m.versie)) {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migratie (versie, naam, toegepast_op) VALUES (?, ?, ?)').run(m.versie, m.naam, nuIso());
        toegepast.push(m.versie);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} throw e; }
  }
  return { schema: hoogste(), toegepast };
}

/*
 * Opent (en maakt zo nodig) de database in `dir`: map 700, bestand 600 (ook -wal/-shm), WAL, foreign keys aan, migraties bijwerken.
 * → fdb = { db, pad, dir, stukken, backup, schema, toegepast }. opties.alleenLezen: geen migraties, query_only.
 */
function open(dir, opties) {
  opties = opties || {};
  if (!dir || typeof dir !== 'string') throw new DbFout('dir', 'open(dir): map ontbreekt');
  maakMap(dir);
  const pad = path.join(dir, BESTAND);
  if (!fs.existsSync(pad)) fs.closeSync(fs.openSync(pad, 'a', 0o600));
  fs.chmodSync(pad, 0o600);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad);
  try {
    // busy_timeout vóór journal_mode: de omschakeling naar WAL wil een slot, en twee processen die tegelijk een lege database openen
    // gaven anders 'database is locked' (toets "acht processen tegelijk"). De omschakeling roept de busy-handler niet altijd aan
    // (SQLite geeft dan meteen BUSY): kort opnieuw proberen, hooguit ± 5 s.
    db.exec('PRAGMA busy_timeout = 15000;');
    for (let i = 0; ; i++) {
      try { db.exec('PRAGMA journal_mode = WAL;'); break; }
      catch (e) { if (i >= 250 || !/locked|busy/i.test(String(e.message))) throw e; Atomics.wait(WACHT, 0, 0, 20); }
    }
    // recursive_triggers: dan vuren de DELETE-triggers ook bij INSERT OR REPLACE (anders omzeilt REPLACE de UPDATE-triggers; diffreview #1)
    db.exec('PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA synchronous = NORMAL;');
    ['-wal', '-shm'].forEach(function (s) { try { fs.chmodSync(pad + s, 0o600); } catch (e) {} });
    const fdb = { db, pad, dir, stukken: path.join(dir, 'stukken'), backup: path.join(dir, 'backup'), _inTx: false };
    if (opties.alleenLezen) {
      db.exec('PRAGMA query_only = ON');
      const r = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migratie'").get();
      fdb.schema = r ? Number(db.prepare('SELECT max(versie) AS v FROM schema_migratie').get().v || 0) : 0;
      fdb.toegepast = [];
    } else {
      const m = migreer(db);
      fdb.schema = m.schema; fdb.toegepast = m.toegepast;
      maakMap(fdb.stukken); maakMap(fdb.backup);
    }
    return fdb;
  } catch (e) { try { db.close(); } catch (e2) {} throw e; }
}
function sluit(fdb) { if (fdb && fdb.db) { try { fdb.db.close(); } catch (e) {} } }

// Re-entrant: binnen een lopende transactie gewoon doorlopen. Altijd BEGIN IMMEDIATE (schrijfslot vooraf): lezen-toetsen-schrijven
// kan niet door een ander proces onderbroken worden.
function transactie(fdb, fn) {
  if (fdb._inTx) return fn();
  fdb.db.exec('BEGIN IMMEDIATE');
  fdb._inTx = true;
  try { const r = fn(); fdb.db.exec('COMMIT'); return r; }
  catch (e) { try { fdb.db.exec('ROLLBACK'); } catch (e2) {} throw e; }
  finally { fdb._inTx = false; }
}

// ───────────────────────────── rijen ─────────────────────────────

const kolomCache = new WeakMap();
function kolommen(fdb, tabel) {
  if (!TABELLEN.includes(tabel)) throw new DbFout('tabel', 'onbekende tabel ' + tabel);
  let m = kolomCache.get(fdb.db);
  if (!m) { m = {}; kolomCache.set(fdb.db, m); }
  if (!m[tabel]) m[tabel] = new Set(fdb.db.prepare('PRAGMA table_info(' + tabel + ')').all().map((k) => k.name));
  return m[tabel];
}
function sqlWaarde(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}
// Eén rij toevoegen; kolomnamen gaan langs de lijst van de tabel (nooit tekst van buiten in de SQL). Lijsten en objecten → JSON.
function voegToe(fdb, tabel, rij) {
  const k = kolommen(fdb, tabel);
  const namen = Object.keys(rij).filter((n) => rij[n] !== undefined);
  for (const n of namen) if (!k.has(n)) throw new DbFout('kolom', tabel + ' kent geen kolom ' + n);
  const r = fdb.db.prepare('INSERT INTO ' + tabel + ' (' + namen.join(', ') + ') VALUES (' + namen.map(() => '?').join(', ') + ')')
    .run(...namen.map((n) => sqlWaarde(rij[n])));
  return rij.id !== undefined ? rij.id : Number(r.lastInsertRowid);
}
function audit(fdb, a) {
  if (!a || !a.wie || !a.wat || !a.object_soort) throw new DbFout('audit', 'audit vraagt wie, wat en object_soort');
  return voegToe(fdb, 'audit', { wie: String(a.wie).slice(0, 100), wat: String(a.wat).slice(0, 100), object_soort: a.object_soort,
    object_id: a.object_id || null, entiteit: a.entiteit || null, voor: a.voor === undefined ? null : a.voor, na: a.na === undefined ? null : a.na,
    wanneer: a.wanneer || nuIso() });
}
function metaLees(fdb, k) { const r = fdb.db.prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k); return r ? r.waarde : null; }
function metaZet(fdb, k, v) { fdb.db.prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, v == null ? null : String(v)); }

const JSON_KOLOMMEN = ['aliassen', 'domeinen', 'mediaan', 'incassant_ids', 'ibans_betaal', 'ibans_onbekend', 'nagebeld_ibans', 'redenen', 'controles',
  'bijlagen', 'aantallen', 'fouten', 'niet_gelezen', 'per_rekening', 'facturen', 'transacties', 'details', 'voor', 'na'];
function leesJson(rij) {
  if (!rij) return rij;
  const uit = Object.assign({}, rij);
  for (const k of JSON_KOLOMMEN) if (typeof uit[k] === 'string') { try { uit[k] = JSON.parse(uit[k]); } catch (e) { /* laat staan */ } }
  return uit;
}

// Factuur in de vorm die facturen-kern.js verwacht: document/ubl_document = sha256 (zoals in de bijlagen van een opdracht), lijsten als
// lijsten, vlaggen als booleans, leverancier_id naast leverancier. document_id/ubl_document_id blijven voor de routes.
function factuurVoorKern(fdb, id) {
  const r = fdb.db.prepare('SELECT f.*, d.sha256 AS doc_sha, u.sha256 AS ubl_sha FROM factuur f JOIN document d ON d.id = f.document ' +
    'LEFT JOIN document u ON u.id = f.ubl_document WHERE f.id = ?').get(id);
  if (!r) return null;
  const f = leesJson(r);
  f.document_id = r.document; f.ubl_document_id = r.ubl_document;
  f.document = r.doc_sha; f.ubl_document = r.ubl_sha || null;
  delete f.doc_sha; delete f.ubl_sha;
  f.leverancier_id = f.leverancier;
  for (const k of ['iban_nieuw', 'intern', 'patientkenmerk', 'alleen_eigenaar']) f[k] = !!f[k];
  return f;
}

// ───────────────────────────── opdrachten: claimen en terugdraaien ─────────────────────────────

// Terugdraaien kan alleen zolang de opdracht wacht: UPDATE … WHERE status = 'wacht' en changes() == 1. Wint een claim (koerier), dan
// verandert er niets en komt { ok:false, fout:'al_opgehaald' } terug. Privé-archief draait terug zonder opdracht.
function terugdraaien(fdb, factuurId, o) {
  o = o || {};
  if (!o.wie) throw new DbFout('wie', 'terugdraaien vraagt wie');
  if (!ID_RE.test(String(factuurId || ''))) return { ok: false, fout: 'onbekend' };
  const wanneer = o.wanneer || nuIso();
  return transactie(fdb, function () {
    const f = fdb.db.prepare('SELECT id, status, entiteit FROM factuur WHERE id = ?').get(factuurId);
    if (!f) return { ok: false, fout: 'onbekend' };
    if (f.status === 'prive_archief') {
      const ov = K.statusOvergang('prive_archief', 'terugdraaien', {});
      if (!ov.ok) return { ok: false, fout: ov.fout, reden: ov.reden };
      const r = fdb.db.prepare("UPDATE factuur SET status = 'te_beoordelen', bevestigd_door = NULL, bevestigd_op = NULL, bijgewerkt_op = ?, versie = versie + 1 " +
        "WHERE id = ? AND status = 'prive_archief'").run(wanneer, f.id);
      if (r.changes !== 1) throw new DbFout('race', 'factuur veranderde tijdens terugdraaien');
      audit(fdb, { wie: o.wie, wat: 'terugdraaien', object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit, voor: { status: f.status }, na: { status: 'te_beoordelen' }, wanneer });
      return { ok: true, factuur: f.id, opdracht: null };
    }
    if (f.status !== 'in_wachtrij') return { ok: false, fout: 'ongeldige_overgang', reden: f.status + ' → terugdraaien' };
    const op = fdb.db.prepare("SELECT id FROM opdracht WHERE factuur = ? AND status = 'wacht'").get(f.id);
    const r = fdb.db.prepare("UPDATE opdracht SET status = 'teruggedraaid', bijgewerkt_op = ? WHERE factuur = ? AND status = 'wacht'").run(wanneer, f.id);
    if (r.changes !== 1) return { ok: false, fout: 'al_opgehaald', reden: 'de koerier heeft de opdracht al opgehaald; terugdraaien kan niet meer' };
    const ov = K.statusOvergang('in_wachtrij', 'terugdraaien', { opdracht_status: 'wacht' });
    if (!ov.ok) throw new DbFout(ov.fout, ov.reden);
    const r2 = fdb.db.prepare("UPDATE factuur SET status = 'te_beoordelen', bevestigd_door = NULL, bevestigd_op = NULL, bijgewerkt_op = ?, versie = versie + 1 " +
      "WHERE id = ? AND status = 'in_wachtrij'").run(wanneer, f.id);
    if (r2.changes !== 1) throw new DbFout('race', 'factuur veranderde tijdens terugdraaien');
    audit(fdb, { wie: o.wie, wat: 'terugdraaien', object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit,
      voor: { status: 'in_wachtrij', opdracht: op && op.id, opdracht_status: 'wacht' }, na: { status: 'te_beoordelen', opdracht_status: 'teruggedraaid' }, wanneer });
    return { ok: true, factuur: f.id, opdracht: op && op.id };
  });
}

/*
 * Claimen voor de koerier (bouwplan § 4.4): in één BEGIN IMMEDIATE alles wat `wacht` met verstuur_na ≤ nu, `opgehaald` > 30 min zonder
 * resultaat, of `mislukt` met poging < 3 → `opgehaald` (opgehaald_op = nu, poging + 1). Vanaf dan geen terugdraaien meer. Drie keer
 * opgehaald zonder resultaat → definitief mislukt: factuur naar verzending_mislukt (afschrift terug naar klaar) en signaal
 * "verzending mislukt" in dezelfde transactie (storingen zichtbaar). Elke statuswijziging is voorwaardelijk (WHERE status = oud).
 * Vóór elke claim: klopt de opdracht nog met de verse factuur of het verse afschift (entiteit, niet prive, onderweg, doeladres)? Zo niet →
 * `geweigerd` + signaal, geen nieuwe poging (zelfde regel als de consistentiecontrole van de koerier). Elke opdracht in een eigen
 * SAVEPOINT: één kapotte rij houdt de rest niet tegen (diffreview #4).
 * nu in ms. → { opdrachten: [rij met bijlagen als lijst], definitief: [id], geweigerd: [{ id, reden }], fouten: [{ id, fout }] }
 */
function claimOpdrachten(fdb, nu, o) {
  o = o || {};
  if (!Number.isFinite(nu)) throw new DbFout('nu', 'claimOpdrachten vraagt nu (ms)');
  const wie = o.wie || 'koerier', max = Number.isInteger(o.max) && o.max > 0 ? o.max : 50;
  const tijd = nuIso(nu);
  return transactie(fdb, function () {
    const kand = fdb.db.prepare("SELECT * FROM opdracht WHERE status IN ('wacht','opgehaald','mislukt') ORDER BY verstuur_na, id").all();
    const uit = { opdrachten: [], definitief: [], geweigerd: [], fouten: [] };
    for (const op of kand) {
      if (uit.opdrachten.length >= max) break;
      fdb.db.exec('SAVEPOINT claim');
      try {
        claimEen(fdb, op, nu, tijd, wie, uit);
        fdb.db.exec('RELEASE claim');
      } catch (e) {
        fdb.db.exec('ROLLBACK TO claim'); fdb.db.exec('RELEASE claim');
        fdb.db.exec('SAVEPOINT weiger');
        try {
          if (weigerOpdracht(fdb, op, 'fout bij claimen: ' + String(e && e.message || e).slice(0, 200), tijd, wie)) uit.geweigerd.push({ id: op.id, reden: 'fout' });
          fdb.db.exec('RELEASE weiger');
        } catch (e2) { fdb.db.exec('ROLLBACK TO weiger'); fdb.db.exec('RELEASE weiger'); }
        uit.fouten.push({ id: op.id, fout: String(e && e.message || e).slice(0, 200) });
      }
    }
    return uit;
  });
}
function claimEen(fdb, op, nu, tijd, wie, uit) {
  const ov = K.opdrachtOvergang(op, 'claim', nu);
  if (!ov.ok) return;
  if (ov.naar === 'opgehaald') {
    const klopt = opdrachtKlopt(fdb, op);
    if (klopt) { if (weigerOpdracht(fdb, op, klopt, tijd, wie)) uit.geweigerd.push({ id: op.id, reden: klopt }); return; }
    const r = fdb.db.prepare("UPDATE opdracht SET status = 'opgehaald', opgehaald_op = ?, poging = ?, bijgewerkt_op = ? WHERE id = ? AND status = ? AND poging = ?")
      .run(ov.opgehaald_op, ov.poging, tijd, op.id, op.status, op.poging);
    if (r.changes !== 1) return;
    if (ov.factuur === 'koerier_haalt_op' && op.factuur) {
      const r2 = fdb.db.prepare("UPDATE factuur SET status = 'wordt_verstuurd', bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND status = 'in_wachtrij'").run(tijd, op.factuur);
      if (r2.changes !== 1) throw new DbFout('race', 'factuur ' + op.factuur + ' staat niet in de wachtrij');
    }
    uit.opdrachten.push(leesJson(Object.assign({}, op, { status: 'opgehaald', opgehaald_op: ov.opgehaald_op, poging: ov.poging })));
    audit(fdb, { wie, wat: 'opdracht_opgehaald', object_soort: 'opdracht', object_id: op.id, entiteit: op.entiteit, voor: { status: op.status, poging: op.poging }, na: { status: 'opgehaald', poging: ov.poging }, wanneer: tijd });
  } else if (ov.naar === 'mislukt' && ov.definitief) {
    const r = fdb.db.prepare("UPDATE opdracht SET status = 'mislukt', fout = ?, bijgewerkt_op = ? WHERE id = ? AND status = 'opgehaald' AND poging = ?")
      .run(String(ov.reden || 'drie pogingen zonder resultaat').slice(0, 500), tijd, op.id, op.poging);
    if (r.changes !== 1) return;
    verzendingMislukt(fdb, op, ov.reden, tijd, wie, 'mislukt_definitief');
    uit.definitief.push(op.id);
  }
}
// Klopt de opdracht nog met de verse rijen? null = ja, anders de reden (zonder inhoud).
function opdrachtKlopt(fdb, op) {
  if (op.entiteit === 'prive') return 'opdracht voor privé';
  const doelKol = op.soort === 'boekhouder_factuur' ? 'boekhoud_doel' : 'afschrift_doel';
  const e = fdb.db.prepare('SELECT ' + doelKol + ' AS doel FROM entiteit WHERE sleutel = ?').get(op.entiteit);
  if (!e || e.doel !== op.doeladres) return 'doeladres wijkt af van de entiteitentabel';
  if (op.soort === 'boekhouder_factuur') {
    const f = fdb.db.prepare('SELECT entiteit, status FROM factuur WHERE id = ?').get(op.factuur);
    if (!f) return 'factuur ontbreekt';
    if (f.entiteit === 'prive') return 'factuur is privé';
    if (f.entiteit !== op.entiteit) return 'entiteit van de factuur wijkt af';
    if (!['in_wachtrij', 'wordt_verstuurd'].includes(f.status)) return 'factuur staat niet meer onderweg (' + f.status + ')';
  } else {
    const a = fdb.db.prepare('SELECT a.status, r.entiteit FROM pot_afschrift a JOIN rekening r ON r.id = a.rekening WHERE a.id = ?').get(op.afschrift);
    if (!a) return 'afschrift ontbreekt';
    if (a.entiteit !== op.entiteit) return 'entiteit van het afschrift wijkt af';
    if (a.status !== 'in_wachtrij') return 'afschrift staat niet meer in de wachtrij (' + a.status + ')';
  }
  return null;
}
// Geweigerd: opdracht dood, factuur naar verzending_mislukt (alleen als hij onderweg was), afschrift terug naar klaar, signaal.
function weigerOpdracht(fdb, op, reden, tijd, wie) {
  const r = fdb.db.prepare("UPDATE opdracht SET status = 'geweigerd', fout = ?, bijgewerkt_op = ? WHERE id = ? AND status = ?").run(String(reden).slice(0, 500), tijd, op.id, op.status);
  if (r.changes !== 1) return false;
  verzendingMislukt(fdb, op, reden, tijd, wie, 'geweigerd');
  return true;
}
// Factuur naar verzending_mislukt (of afschrift terug naar klaar) + signaal, met dezelfde sleutel als facturen-bank.js (geen tweede melding).
// De factuur gaat alleen mee als hij onderweg was (in_wachtrij → wordt_verstuurd → verzending_mislukt, langs de kern); een factuur die
// intussen elders staat (bv. een oude opdracht na terugdraaien), blijft staan.
function verzendingMislukt(fdb, op, reden, tijd, wie, gebeurtenis) {
  const B = require('./facturen-bank.js');
  let f = null, eigenaar = false;
  if (op.factuur) {
    f = fdb.db.prepare('SELECT id, status, entiteit, leverancier, incl, alleen_eigenaar, patientkenmerk FROM factuur WHERE id = ?').get(op.factuur);
    if (f && ['in_wachtrij', 'wordt_verstuurd'].includes(f.status)) {
      let st = f.status;
      if (st === 'in_wachtrij') { const o1 = K.statusOvergang(st, 'koerier_haalt_op', {}); if (!o1.ok) throw new DbFout(o1.fout, o1.reden); st = o1.naar; }
      const ov = K.statusOvergang(st, gebeurtenis, {});
      if (!ov.ok) throw new DbFout(ov.fout, ov.reden);
      const r = fdb.db.prepare('UPDATE factuur SET status = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND status = ?').run(ov.naar, tijd, f.id, f.status);
      if (r.changes !== 1) throw new DbFout('race', 'factuur veranderde');
    }
    eigenaar = !!(f && (f.alleen_eigenaar || f.patientkenmerk || f.entiteit === 'prive'));
  } else {
    fdb.db.prepare("UPDATE pot_afschrift SET status = 'klaar', bijgewerkt_op = ? WHERE id = ? AND status = 'in_wachtrij'").run(tijd, op.afschrift);
    eigenaar = true;   // POT-afschriften en alles wat ervan afgeleid is: alleen de eigenaar (App-bouwplan § 4.2; diffreview #6)
  }
  const s = B.maakSignaal('verzending_mislukt', { entiteit: op.entiteit, leverancier: f ? f.leverancier : null, facturen: f ? [f.id] : [],
    bedrag_centen: f ? f.incl : null, details: { opdracht: op.id, status: gebeurtenis === 'geweigerd' ? 'geweigerd' : 'mislukt', afschrift: op.afschrift || undefined, reden: String(reden || '').slice(0, 200) },
    sleutel_extra: 'op=' + op.id, alleen_eigenaar: eigenaar });
  fdb.db.prepare('INSERT INTO signaal (id, sleutel, soort, titel, entiteit, leverancier, transacties, facturen, bedrag_centen, details, alleen_eigenaar, aangemaakt_op) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sleutel) DO NOTHING')
    .run(nieuwId(), s.sleutel, s.soort, s.titel, s.entiteit || null, s.leverancier || null, JSON.stringify(s.transacties), JSON.stringify(s.facturen),
      s.bedrag_centen == null ? null : s.bedrag_centen, JSON.stringify(s.details), s.alleen_eigenaar ? 1 : 0, tijd);
  audit(fdb, { wie, wat: gebeurtenis === 'geweigerd' ? 'opdracht_geweigerd' : 'verzending_mislukt', object_soort: 'opdracht', object_id: op.id, entiteit: op.entiteit,
    na: { status: gebeurtenis === 'geweigerd' ? 'geweigerd' : 'mislukt', definitief: true, reden: String(reden || '').slice(0, 200) }, wanneer: tijd });
}

// ───────────────────────────── stukken (bestanden) ─────────────────────────────

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function stukPad(fdb, sha) {
  if (!SHA_RE.test(String(sha || ''))) throw new DbFout('sha256', 'stuk: sha256 is 64 hex kleine letters');
  return path.join(fdb.stukken, sha.slice(0, 2), sha);
}
function alsBuffer(b) {
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  throw new DbFout('bytes', 'stuk: bytes als Buffer of Uint8Array');
}
// Schrijft atomair: tijdelijk bestand in dezelfde map (600, wx), fsync, rename. Bestaat het stuk al met de goede inhoud, dan niets.
// Een beschadigd bestaand stuk (andere sha) wordt vervangen. → { sha256, bytes, nieuw }
function stukSchrijf(fdb, bytes) {
  const buf = alsBuffer(bytes);
  if (buf.length > MAX_STUK) throw new DbFout('te_groot', 'stuk groter dan 20 MB');
  const sha = sha256(buf), p = stukPad(fdb, sha), map = path.dirname(p);
  maakMap(fdb.stukken); maakMap(map);
  try {
    if (sha256(fs.readFileSync(p)) === sha) { fs.chmodSync(p, 0o600); return { sha256: sha, bytes: buf.length, nieuw: false }; }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = path.join(map, '.tmp-' + nieuwId());
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  }
  try { const d = fs.openSync(map, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (e) { /* niet elk bestandssysteem kent fsync op een map */ }
  return { sha256: sha, bytes: buf.length, nieuw: true };
}
// Leest een stuk en controleert de sha256 (een beschadigd stuk gaat nooit de deur uit).
function stukLees(fdb, sha) {
  const buf = fs.readFileSync(stukPad(fdb, sha));
  if (sha256(buf) !== sha) throw new DbFout('beschadigd', 'stuk komt niet overeen met zijn sha256');
  return buf;
}
function stukBestaat(fdb, sha) { try { return fs.statSync(stukPad(fdb, sha)).isFile(); } catch (e) { return false; } }

// ───────────────────────────── back-up ─────────────────────────────

function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
const BACKUP_RE = /^facturen-(\d{4}-\d{2}-\d{2})\.sqlite$/;
/*
 * VACUUM INTO backup/facturen-<dag>.sqlite (600; dezelfde dag overschrijft via een tijdelijk bestand), daarna quick_check op de kopie en
 * rotatie: kopieën van 14 dagen of ouder weg, achtergebleven tijdelijke bestanden ook. Gestart door de 02:00-tik (F2: POST /facturen-ronde).
 * → { ok, pad, bytes, dag, controle, verwijderd: [namen] }
 */
function backup(fdb, o) {
  o = o || {};
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const dagen = Number.isInteger(o.dagen) && o.dagen > 0 ? o.dagen : BACKUP_DAGEN;
  maakMap(fdb.backup);
  const dag = dagAmsterdam(nu);
  const doel = path.join(fdb.backup, 'facturen-' + dag + '.sqlite');
  const tmp = path.join(fdb.backup, '.tmp-' + nieuwId() + '.sqlite');
  try {
    fdb.db.prepare('VACUUM INTO ?').run(tmp);
    fs.chmodSync(tmp, 0o600);
    const { DatabaseSync } = require('node:sqlite');
    const k = new DatabaseSync(tmp, { readOnly: true });
    let controle;
    try { controle = k.prepare('PRAGMA quick_check').get(); } finally { k.close(); }
    const ok = controle && Object.values(controle)[0] === 'ok';
    if (!ok) throw new DbFout('backup_controle', 'kopie haalt quick_check niet');
    fs.renameSync(tmp, doel);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} throw e; }
  const verwijderd = [];
  for (const n of fs.readdirSync(fdb.backup)) {
    const m = BACKUP_RE.exec(n);
    if (m) { if (K.dagenTussen(m[1], dag) >= dagen) { fs.unlinkSync(path.join(fdb.backup, n)); verwijderd.push(n); } continue; }
    if (/^\.tmp-/.test(n)) {
      try { if (nu - fs.statSync(path.join(fdb.backup, n)).mtimeMs > 24 * 3600 * 1000) { fs.unlinkSync(path.join(fdb.backup, n)); verwijderd.push(n); } } catch (e) {}
    }
  }
  const bytes = fs.statSync(doel).size;
  metaZet(fdb, 'laatste_backup', JSON.stringify({ dag, op: nuIso(nu), bytes }));
  return { ok: true, pad: doel, bytes, dag, controle: 'ok', verwijderd };
}
// Terugzetten (handwerk na een verlies): kopie naar een map zonder database; weigert te overschrijven. Opent en migreert daarna.
function herstel(backupPad, dir) {
  maakMap(dir);
  const pad = path.join(dir, BESTAND);
  if (fs.existsSync(pad)) throw new DbFout('bestaat', 'in deze map staat al een database; eerst zelf wegzetten');
  // een achtergebleven -wal zou SQLite over de back-up heen afspelen (diffreview #5)
  for (const s of ['-wal', '-shm', '-journal']) if (fs.existsSync(pad + s)) throw new DbFout('bestaat', 'in deze map staat nog ' + BESTAND + s + '; eerst zelf wegzetten');
  fs.copyFileSync(backupPad, pad, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(pad, 0o600);
  return open(dir);
}

// ───────────────────────────── stand ─────────────────────────────

function tellingen(fdb) {
  const uit = {};
  for (const t of TABELLEN) uit[t] = Number(fdb.db.prepare('SELECT count(*) AS n FROM ' + t).get().n);
  return uit;
}
// Voor /health (open route): geen inhoud, alleen of het werkt en welk schema.
function health(fdb) {
  if (!fdb) return { aan: true, schema: null, schema_code: SCHEMA_VERSIE };
  let lb = null;
  try { lb = JSON.parse(metaLees(fdb, 'laatste_backup') || 'null'); } catch (e) { lb = null; }
  return { aan: true, schema: fdb.schema, schema_code: SCHEMA_VERSIE, laatste_backup: lb ? lb.dag : null };
}

module.exports = {
  DbFout, SCHEMA_VERSIE, MIGRATIES, TABELLEN, LIJSTEN: L, BESTAND, MAX_STUK, BACKUP_DAGEN,
  open, sluit, migreer, transactie, nieuwId, voegToe, audit, metaLees, metaZet, leesJson, factuurVoorKern,
  terugdraaien, claimOpdrachten,
  stukPad, stukSchrijf, stukLees, stukBestaat, sha256,
  backup, herstel, tellingen, health,
};
