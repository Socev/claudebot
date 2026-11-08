-- GEGENEREERD uit Socev/ovis-pot 4fd0303cb2b6440872d6405e9ab9b7858e0cc2b7: migrations/0001_pot_tabellen_uit_fin.sql, migrations/0002_nieuw_model.sql, migrations/0003_begroting_jaarronde.sql, migrations/0004_maand_bank.sql, migrations/0005_geen_leningen.sql, migrations/0006_historie.sql, migrations/0007_jan_feb.sql, migrations/0008_historie_blind.sql, migrations/0009_subsidie_totaal.sql, migrations/0010_notadag_25.sql, migrations/0011_nmbrs_koppeling.sql
-- OVIS POT — migratie 0001: de POT-tabellen zoals ze in D1 `fin` stonden (kolommen en ids gelijk), zodat de pod-modules
-- (pot-datahub.js, pot-verzend.js) bij het overstapmoment alleen een andere database krijgen. Gegenereerd uit fin.sqlite_master op 8-11-2026.
-- Geen gegevens in deze repo; de inhoud komt met scripts/kopieer-uit-fin.py.

CREATE TABLE entiteit (code TEXT PRIMARY KEY, naam TEXT NOT NULL, rechtsvorm TEXT, kvk TEXT, agb TEXT, eigenaar TEXT, boekjaar TEXT DEFAULT 'kalenderjaar', vault_pad TEXT, opmerking TEXT, iban TEXT, tnv TEXT, adres TEXT, postcode_plaats TEXT, naam_document TEXT);

CREATE TABLE bron (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT REFERENCES entiteit(code), soort TEXT NOT NULL, titel TEXT NOT NULL, datum TEXT, periode_van TEXT, periode_tot TEXT, r2_sleutel TEXT, sha256 TEXT, geladen_op TEXT NOT NULL, gecontroleerd INTEGER NOT NULL DEFAULT 0, opmerking TEXT);

CREATE TABLE praktijk (id TEXT PRIMARY KEY, naam TEXT NOT NULL, naam_vorig TEXT, eigenaar TEXT, opmerking TEXT, naam_brief TEXT, tav TEXT, adres TEXT, postcode_plaats TEXT, email TEXT);

CREATE TABLE praktijk_naam (id INTEGER PRIMARY KEY AUTOINCREMENT, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), naam TEXT, iban TEXT, geldig_van TEXT, geldig_tot TEXT, herkomst TEXT, opmerking TEXT);

CREATE TABLE deelname (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), praktijk_id TEXT NOT NULL REFERENCES praktijk(id), geldig_van TEXT, geldig_tot TEXT, regel TEXT, UNIQUE(entiteit, praktijk_id, geldig_van));

CREATE TABLE praktijk_patienten (id INTEGER PRIMARY KEY AUTOINCREMENT, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), peildatum TEXT NOT NULL, aantal REAL, status TEXT, bron_id INTEGER REFERENCES bron(id), opmerking TEXT, UNIQUE(praktijk_id, peildatum));

CREATE TABLE verdeelsleutel (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), soort TEXT NOT NULL, versie TEXT NOT NULL, grondslag REAL, aandeel REAL NOT NULL, bron_id INTEGER REFERENCES bron(id), opmerking TEXT, UNIQUE(entiteit, jaar, praktijk_id, soort, versie));

CREATE TABLE jaarlast (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, bedrag REAL NOT NULL, bron TEXT, opmerking TEXT, ingevoerd_op TEXT, UNIQUE(entiteit, jaar));

CREATE TABLE afrekening (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), versie TEXT NOT NULL, aandeel REAL, jaarlast_toegerekend REAL, voorschotten REAL, saldo REAL, status TEXT, bron_id INTEGER REFERENCES bron(id), opmerking TEXT, openstaand_vorig REAL, betaald_afrekening REAL, jaarlast_totaal REAL, UNIQUE(entiteit, jaar, praktijk_id, versie));

CREATE TABLE bankrekening (iban TEXT PRIMARY KEY, entiteit TEXT REFERENCES entiteit(code), bank TEXT, tenaamstelling TEXT, opmerking TEXT);

CREATE TABLE bankmutatie (id INTEGER PRIMARY KEY AUTOINCREMENT, rekening TEXT NOT NULL REFERENCES bankrekening(iban), entiteit TEXT NOT NULL REFERENCES entiteit(code), boekdatum TEXT NOT NULL, bedrag REAL NOT NULL, tegenrekening TEXT, naam TEXT, omschrijving TEXT, kenmerk TEXT, banksoort TEXT, saldo_na REAL, bron_bestand TEXT, sleutel TEXT UNIQUE, bron_id INTEGER REFERENCES bron(id), geladen_op TEXT NOT NULL);
CREATE INDEX idx_bm_ent_datum ON bankmutatie(entiteit, boekdatum);

CREATE TABLE bank_toewijzing (id INTEGER PRIMARY KEY AUTOINCREMENT, bankmutatie_id INTEGER NOT NULL REFERENCES bankmutatie(id), soort TEXT NOT NULL, praktijk_id TEXT REFERENCES praktijk(id), tegen_entiteit TEXT, persoon TEXT, boekjaar INTEGER, bedrag REAL NOT NULL, herkomst TEXT, opmerking TEXT);
CREATE INDEX idx_bt_praktijk ON bank_toewijzing(praktijk_id, boekjaar, soort);

CREATE TABLE controlebevinding (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT, jaar INTEGER, praktijk_id TEXT, bron TEXT, omschrijving TEXT NOT NULL, bedrag REAL, status TEXT DEFAULT 'open', besluit TEXT, aangemaakt_op TEXT, opmerking TEXT);

CREATE TABLE plan (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, versie TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'concept', termijn TEXT NOT NULL DEFAULT 'kwartaal', marge_pct REAL NOT NULL DEFAULT 0, totaal REAL, sleutel_toelichting TEXT, gemaakt_op TEXT, vastgesteld_op TEXT, opmerking TEXT, UNIQUE(entiteit, jaar, versie));

CREATE TABLE plan_post (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL REFERENCES plan(id), volgorde INTEGER NOT NULL DEFAULT 0, omschrijving TEXT NOT NULL, bedrag REAL NOT NULL, per TEXT NOT NULL DEFAULT 'jaar', aantal REAL NOT NULL DEFAULT 1, indexatie_pct REAL NOT NULL DEFAULT 0, jaarbedrag REAL NOT NULL, opmerking TEXT);

CREATE TABLE plan_deelnemer (plan_id INTEGER NOT NULL REFERENCES plan(id), praktijk_id TEXT NOT NULL REFERENCES praktijk(id), actief INTEGER NOT NULL DEFAULT 1, grondslag REAL, aandeel REAL, termijnbedrag REAL, PRIMARY KEY(plan_id, praktijk_id));

CREATE TABLE begroting (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, versie TEXT NOT NULL, status TEXT DEFAULT 'concept', totaal REAL NOT NULL, termijn TEXT NOT NULL, methode TEXT, grondslag TEXT, gemaakt_op TEXT, opmerking TEXT, UNIQUE(entiteit, jaar, versie));

CREATE TABLE begroting_regel (id INTEGER PRIMARY KEY AUTOINCREMENT, begroting_id INTEGER NOT NULL REFERENCES begroting(id), praktijk_id TEXT NOT NULL REFERENCES praktijk(id), aandeel REAL NOT NULL, jaarbedrag REAL NOT NULL, termijnbedrag REAL NOT NULL, opmerking TEXT, UNIQUE(begroting_id, praktijk_id));

CREATE TABLE document (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, praktijk_id TEXT REFERENCES praktijk(id), soort TEXT NOT NULL, nummer TEXT, datum TEXT, bedrag REAL, titel TEXT, bestand TEXT, status TEXT DEFAULT 'concept', gemaakt_op TEXT, UNIQUE(entiteit, jaar, praktijk_id, soort));

CREATE TABLE nota (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, nummer TEXT NOT NULL, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), datum TEXT NOT NULL, soort TEXT NOT NULL, periode TEXT, titel TEXT, regels TEXT NOT NULL, bedrag REAL NOT NULL, status TEXT NOT NULL DEFAULT 'definitief', bron TEXT, plan_id INTEGER REFERENCES plan(id), aangemaakt_op TEXT, opmerking TEXT, UNIQUE(entiteit, nummer));
CREATE INDEX ix_nota_ent_jaar ON nota(entiteit, jaar);

CREATE TABLE "nota_verzending" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nota_id INTEGER NOT NULL REFERENCES nota(id),
  entiteit TEXT NOT NULL,
  nummer TEXT NOT NULL,
  praktijk_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('wacht','bezig','concept','verzonden','wacht_op_adres','onzeker','fout','geannuleerd','vervangen','concept_weg',
    'auto_gevraagd','auto_vrij','verzenden','auto_verstuurd','onzeker_verzonden','verstuurd_door_david')),
  niet_voor TEXT NOT NULL,
  plan_datum TEXT,
  onderwerp TEXT NOT NULL,
  bericht TEXT NOT NULL,
  van TEXT,
  pdf_naam TEXT NOT NULL,
  pdf_b64 TEXT,
  pdf_sha256 TEXT NOT NULL,
  pdf_bytes INTEGER NOT NULL,
  aangevraagd_op TEXT NOT NULL,
  reden TEXT,
  geclaimd_op TEXT,
  pogingen INTEGER NOT NULL DEFAULT 0,
  aan TEXT, cc TEXT, bron_pagina TEXT,
  concept_id TEXT, thread_id TEXT, bericht_id TEXT, concept_op TEXT, verzonden_op TEXT, gemeten_op TEXT,
  opmerking TEXT, fout TEXT,
  bijgewerkt_op TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  vrijgave_id INTEGER,
  verzend_reservering_op TEXT,
  message_id TEXT
);
CREATE UNIQUE INDEX nota_verzending_actief ON nota_verzending(nota_id)
  WHERE status IN ('wacht','bezig','concept','verzonden','wacht_op_adres','onzeker','auto_gevraagd','auto_vrij','verzenden','auto_verstuurd','onzeker_verzonden','verstuurd_door_david');
CREATE INDEX nota_verzending_status ON nota_verzending(status, niet_voor);
CREATE INDEX nota_verzending_nota ON nota_verzending(nota_id, id);
CREATE INDEX nota_verzending_vrijgave ON nota_verzending(vrijgave_id);

CREATE TABLE nota_vrijgave (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entiteit TEXT NOT NULL,
  plan_datum TEXT NOT NULL,           -- verzenddag (lokaal)
  nota_ids TEXT NOT NULL,             -- JSON-lijst van nota_verzending.id
  nota_hashes TEXT NOT NULL,          -- JSON {verzending_id: sha256}
  batch_hash TEXT NOT NULL,
  kaart_sleutel TEXT UNIQUE,          -- pot-vrijgave-<id>
  kaart_tekst_hash TEXT,              -- pas gezet als de kaart in de databank staat
  vraag_id TEXT, bevestiging TEXT, bevestigd_op TEXT,
  vervalt_op TEXT NOT NULL,           -- = plan_datum (een vrijgave geldt alleen voor die dag; gemaakt hooguit 45 dagen vooraf)
  ingetrokken_op TEXT,
  herinnerd_op TEXT, gemeld_op TEXT,
  gemaakt_op TEXT NOT NULL
);

CREATE TABLE pot_pod_stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL, op TEXT NOT NULL);

-- OVIS POT — migratie 0002: het nieuwe model (ontwerp § 3) naast de tabellen uit `fin`.
-- Regel: niets wordt overschreven; een wijziging is een nieuwe regel met een datum (geldig_van). Woorden (David 8-11-2026):
-- POT/KM = bijdrage (bijdragenota), SLOEL = doorbelaste huur (nota doorbelaste huur); nooit "factuur", geen btw.

-- Praktijk per datum (overname, naamswijziging, nieuw adres): een nota pakt de versie die op haar datum gold (R10).
-- `praktijk` blijft de huidige stand (de pod leest daar naam_brief/email); de app werkt beide in één batch bij.
CREATE TABLE praktijk_versie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  praktijk_id TEXT NOT NULL REFERENCES praktijk(id),
  geldig_van TEXT NOT NULL CHECK (geldig_van GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  naam TEXT NOT NULL,
  houder TEXT,
  tav TEXT,
  adres TEXT,
  postcode_plaats TEXT,
  email TEXT,
  kvk TEXT,
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (praktijk_id, geldig_van)
);

-- Patiëntenstand: de bestaande tabel praktijk_patienten blijft de enige; twee kolommen erbij.
ALTER TABLE praktijk_patienten ADD COLUMN opgegeven_door TEXT;
ALTER TABLE praktijk_patienten ADD COLUMN bron_tekst TEXT;

-- Een praktijk die voor één kostencomponent niet meebetaalt (KM-overeenkomst sluit enkele kostensoorten uit; open punt O1).
CREATE TABLE deelname_uitzondering (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kostencomponent_id INTEGER NOT NULL REFERENCES kostencomponent(id),
  praktijk_id TEXT NOT NULL REFERENCES praktijk(id),
  geldig_van TEXT NOT NULL,
  geldig_tot TEXT,
  reden TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE kostencomponent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entiteit TEXT NOT NULL CHECK (entiteit IN ('POT','KM','SLOEL')),
  naam TEXT NOT NULL,
  soort TEXT NOT NULL CHECK (soort IN ('vast','personeel','variabel')),
  per TEXT NOT NULL CHECK (per IN ('maand','kwartaal','jaar')),
  betaalmoment TEXT,
  volgorde INTEGER NOT NULL DEFAULT 0,
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Bedrag van een component vanaf een datum ("huur € 12.219,20 per kwartaal, vanaf 1-7-2027 € 13.400" = twee regels).
-- bedrag NULL = de component stopt per die datum.
CREATE TABLE kostenmutatie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kostencomponent_id INTEGER NOT NULL REFERENCES kostencomponent(id),
  geldig_van TEXT NOT NULL CHECK (geldig_van GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  bedrag REAL,
  reden TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (kostencomponent_id, geldig_van)
);

-- Opbrengst (alleen inzicht, staat los van de nota's): subsidie gemeente per praktijk per jaar en het inschrijftarief POH-GGZ.
CREATE TABLE subsidie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  praktijk_id TEXT NOT NULL REFERENCES praktijk(id),
  jaar INTEGER NOT NULL,
  soort TEXT NOT NULL CHECK (soort IN ('aangevraagd','verleend','vastgesteld','prognose')),
  bedrag REAL NOT NULL,
  bron TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (praktijk_id, jaar, soort)
);

CREATE TABLE inschrijftarief (
  jaar INTEGER PRIMARY KEY,
  tarief REAL NOT NULL,            -- € per ingeschreven patiënt per kwartaal (prestatie 11201, opslag POH-GGZ)
  bron TEXT,
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Nota's: vervaldag en de debiteur zoals die bij het maken gold (R10, verandert daarna niet).
ALTER TABLE nota ADD COLUMN vervaldag TEXT;
ALTER TABLE nota ADD COLUMN debiteur TEXT;          -- JSON {praktijk_id, versie_id, naam, houder, tav, adres, postcode_plaats, email}

-- Verwachte termijnen 2026 voor de betaalmonitor (§ 0): Davids eigen stukken (bron 'david-2026') of, tot die er zijn, de reconstructie.
CREATE TABLE verwachting (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entiteit TEXT NOT NULL CHECK (entiteit IN ('POT','KM','SLOEL')),
  praktijk_id TEXT NOT NULL REFERENCES praktijk(id),
  jaar INTEGER NOT NULL,
  termijn TEXT NOT NULL,           -- JJJJ-MM of JJJJ-Qn
  vervaldag TEXT NOT NULL,
  bedrag REAL NOT NULL,
  bron TEXT NOT NULL CHECK (bron IN ('reconstructie','david-2026','nota')),
  nummer TEXT,
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (entiteit, praktijk_id, jaar, termijn, bron)
);

-- Bankmutatie ↔ nota (fase 3: betaalstatus vanaf 2027).
CREATE TABLE koppeling (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bankmutatie_id INTEGER NOT NULL REFERENCES bankmutatie(id),
  nota_id INTEGER NOT NULL REFERENCES nota(id),
  bedrag REAL NOT NULL,
  herkomst TEXT NOT NULL,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (bankmutatie_id, nota_id)
);

-- Spoor voor een opvolger en de boekhouder: elke wijziging uit de app.
CREATE TABLE logboek (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  wie TEXT NOT NULL,
  tabel TEXT NOT NULL,
  sleutel TEXT,
  actie TEXT NOT NULL,
  oud TEXT,
  nieuw TEXT
);
CREATE INDEX ix_logboek_op ON logboek(op);

CREATE TABLE instelling (
  sleutel TEXT PRIMARY KEY,
  waarde TEXT NOT NULL,
  opmerking TEXT
);
INSERT INTO instelling (sleutel, waarde, opmerking) VALUES
  ('notadag', '1', 'nota''s als concept op de 1e van de maand (vanaf 1-1-2027, samen met David)'),
  ('betaaldag', '15', 'iedereen betaalt op de 15e'),
  ('overname_vragen', '2027-01-01', 'David vroeg 2026 zelf; de app monitort 2026 en neemt het vragen per 1-1-2027 over (besluit 8-11-2026)'),
  ('overstap_fin', '', 'datum/tijd waarop de POT-tabellen in fin op alleen lezen gingen (leeg = nog niet; pot is dan een kopie)');

-- OVIS POT — migratie 0003 (fase 2, wv2761): personeel (R5), buffer en leningen (R7), jaarplan (R4/R6/R9), correcties, januari-ronde,
-- deelname per soort, verkoopadres Exact per entiteit. Niets overschrijven: wijzigingen zijn nieuwe regels met een datum.
-- Woorden (David 8-11-2026): POT/KM = bijdragenota, SLOEL = nota doorbelaste huur; nooit "factuur", geen btw.

-- Deelname per soort: 'beide' (standaard), alleen 'bijdrage' (maandbijdragen) of alleen 'afrekening' (wel het aandeel in de afrekening).
ALTER TABLE deelname ADD COLUMN geldt_voor TEXT NOT NULL DEFAULT 'beide' CHECK (geldt_voor IN ('beide','bijdrage','afrekening'));

-- ---------- personeel (R5) ----------
CREATE TABLE medewerker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  naam TEXT NOT NULL,
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- Een contract (of een vacature met een datum). Schaal/trede zijn afgeleid uit de loonstrook (trede_bron) tot David bevestigt.
CREATE TABLE contract (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medewerker_id INTEGER REFERENCES medewerker(id),
  soort TEXT NOT NULL DEFAULT 'dienst' CHECK (soort IN ('dienst','vacature')),
  functie TEXT,
  van TEXT NOT NULL CHECK (van GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  tot TEXT,
  uren REAL NOT NULL CHECK (uren > 0 AND uren <= 60),
  cao TEXT NOT NULL,
  schaal TEXT,
  trede INTEGER,
  trede_peildatum TEXT,             -- de datum waarop de trede bekend was (periodieken tellen daarna)
  periodiekmaand INTEGER CHECK (periodiekmaand BETWEEN 1 AND 12),
  bruto_maand REAL,                 -- alleen als er geen schaal/trede is
  uren_jeugd REAL,
  uren_volwassen REAL,
  trede_bron TEXT,                  -- bv. 'afgeleid uit loonstrook 2026-09 (exact)'
  bevestigd_op TEXT,
  bevestigd_door TEXT,
  herkomst TEXT,                    -- bv. 'fin dienstverband 7'
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE contractmutatie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contract(id),
  geldig_van TEXT NOT NULL CHECK (geldig_van GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  uren REAL, schaal TEXT, trede INTEGER,
  reden TEXT NOT NULL,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (contract_id, geldig_van)
);
CREATE TABLE afwezigheid (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contract(id),
  van TEXT NOT NULL, tot TEXT,
  soort TEXT NOT NULL CHECK (soort IN ('ziekte','verlof','overig')),
  loondoorbetaling_pct REAL NOT NULL DEFAULT 1 CHECK (loondoorbetaling_pct BETWEEN 0 AND 1),
  uitkering_pct REAL NOT NULL DEFAULT 0 CHECK (uitkering_pct BETWEEN 0 AND 1),   -- verwachte uitkering verzuimverzekering
  vertraging_maanden INTEGER NOT NULL DEFAULT 2 CHECK (vertraging_maanden BETWEEN 0 AND 12),
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE inhuur (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  omschrijving TEXT NOT NULL,
  van TEXT NOT NULL, tot TEXT,
  uren_week REAL NOT NULL CHECK (uren_week > 0),
  tarief REAL NOT NULL CHECK (tarief >= 0),        -- € per uur
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE cao_tabel (
  cao TEXT NOT NULL, ingang TEXT NOT NULL, schaal TEXT NOT NULL, trede INTEGER NOT NULL,
  bruto REAL NOT NULL, uren_voltijd REAL NOT NULL, bron TEXT,
  PRIMARY KEY (cao, ingang, schaal, trede)
);
-- Per jaar: gemeten werkgeverslasten en reserveringen (op de loonstroken), aannames (verzuim, cao), en de verdeling van de loonkosten
-- over salaris / loonheffing / pensioen (gemeten uit de bank, voor de kasstroomtoets). Het nieuwste jaar ≤ het begrotingsjaar geldt.
CREATE TABLE loonparameter (
  jaar INTEGER PRIMARY KEY,
  werkgeverslasten REAL NOT NULL, vakantiegeld_res REAL NOT NULL, eindejaar_res REAL NOT NULL,
  verzuim_pct REAL NOT NULL DEFAULT 0, cao_aanname_pct REAL NOT NULL DEFAULT 0, cao_aanname_maanddag TEXT NOT NULL DEFAULT '07-01',
  verdeling TEXT,                   -- JSON {salaris, loonheffing, pensioen}
  bron TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- Loonsom per maand (totalen POT uit de loonstroken): voor het meten van de werkgeverslasten en de kasstroomtoets.
CREATE TABLE loonsom (
  jaar INTEGER NOT NULL, maand INTEGER NOT NULL CHECK (maand BETWEEN 1 AND 12),
  bruto REAL NOT NULL, loonkosten REAL NOT NULL, res_vakantiegeld REAL, res_eindejaar REAL, aantal INTEGER, bron TEXT,
  PRIMARY KEY (jaar, maand)
);

-- ---------- buffer en leningen (R7) ----------
CREATE TABLE buffer (
  entiteit TEXT NOT NULL CHECK (entiteit IN ('POT','KM','SLOEL')),
  geldig_van TEXT NOT NULL,
  doel REAL NOT NULL CHECK (doel >= 0),
  opbouw_maanden INTEGER NOT NULL DEFAULT 12 CHECK (opbouw_maanden BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'voorstel' CHECK (status IN ('voorstel','besloten')),
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (entiteit, geldig_van)
);
-- Open liquiditeitsleningen aan een entiteit (de bufferopbouw lost die eerst af).
CREATE TABLE lening (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entiteit TEXT NOT NULL CHECK (entiteit IN ('POT','KM','SLOEL')),
  verstrekt_door TEXT NOT NULL,
  bedrag_open REAL NOT NULL,
  peildatum TEXT NOT NULL,
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------- jaarplan (R4, R6, R9) ----------
-- Een jaarplan heeft versies; hooguit één is vastgesteld. Een wijziging tussendoor = een nieuwe versie (concept).
CREATE TABLE jaarplan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entiteit TEXT NOT NULL CHECK (entiteit IN ('POT','KM','SLOEL')),
  jaar INTEGER NOT NULL,
  versie INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'concept' CHECK (status IN ('concept','vastgesteld','vervallen')),
  totaal REAL NOT NULL,
  reden TEXT,
  grondslag TEXT NOT NULL,          -- JSON: begroting, maandpatroon, buffer, kasstroom (samenvatting) en "hoe berekend"
  gemaakt_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  gemaakt_door TEXT,
  vastgesteld_op TEXT,
  UNIQUE (entiteit, jaar, versie)
);
CREATE UNIQUE INDEX ux_jaarplan_vastgesteld ON jaarplan(entiteit, jaar) WHERE status = 'vastgesteld';
CREATE TABLE jaarplan_regel (
  jaarplan_id INTEGER NOT NULL REFERENCES jaarplan(id),
  praktijk_id TEXT NOT NULL REFERENCES praktijk(id),
  aandeel REAL NOT NULL,
  stand REAL,
  maanden TEXT NOT NULL,            -- JSON 12 bedragen (hele euro's), bijdrage of doorbelaste huur
  buffer TEXT NOT NULL,             -- JSON 12 bedragen bufferopbouw
  jaar_bedrag REAL NOT NULL,
  PRIMARY KEY (jaarplan_id, praktijk_id)
);

-- Correctie die op de eerstvolgende nota komt: SLOEL-afrekening (Davids regel) en het verschil voorlopige → definitieve kosten (R2).
CREATE TABLE correctie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entiteit TEXT NOT NULL CHECK (entiteit IN ('POT','KM','SLOEL')),
  praktijk_id TEXT NOT NULL REFERENCES praktijk(id),
  jaar INTEGER NOT NULL,            -- het jaar waar de correctie over gaat
  bedrag REAL NOT NULL,
  omschrijving TEXT NOT NULL,
  toelichting TEXT,
  nota_id INTEGER REFERENCES nota(id),   -- gevuld zodra hij op een nota staat
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Januari-ronde: vinkjes per stap ("akkoord"), halverwege te bewaren.
CREATE TABLE ronde_stap (
  jaar INTEGER NOT NULL,
  stap TEXT NOT NULL,
  akkoord_op TEXT,
  wie TEXT,
  notitie TEXT,
  PRIMARY KEY (jaar, stap)
);

-- Nota: welk deel bufferopbouw is (telt niet mee in de afrekening), uit welk jaarplan, hoeveel van een tegoed al verrekend is.
ALTER TABLE nota ADD COLUMN buffer REAL NOT NULL DEFAULT 0;
ALTER TABLE nota ADD COLUMN jaarplan_id INTEGER;
ALTER TABLE nota ADD COLUMN verrekend REAL NOT NULL DEFAULT 0;
ALTER TABLE nota ADD COLUMN toelichting TEXT;

-- Elk stuk gaat óók naar het verkoopadres van de entiteit in Exact (David 8-11-2026); leeg tot David ze geeft.
INSERT INTO instelling (sleutel, waarde, opmerking) VALUES
  ('verkoopadres_exact_POT', '', 'verkoopadres van de POT in Exact (boekhouding); elk stuk gaat ook daarheen. Leeg = ontbreekt'),
  ('verkoopadres_exact_KM', '', 'verkoopadres van de Kostenmaatschap in Exact; leeg = ontbreekt'),
  ('verkoopadres_exact_SLOEL', '', 'verkoopadres van de SLOEL in Exact; leeg = ontbreekt');

-- OVIS POT fase 3 (wv2762, 8-11-2026): maandronde, betaalstatus, herinnering, overname.
-- De pod (Socev) maakt vanaf instelling.overname_vragen elke 1e de nota's van de maand en zet per praktijk één Gmail-concept klaar
-- (mail_concept); David verstuurt. Een herinnering vraagt David in de app (pod_verzoek); de pod zet hem als concept klaar.
-- Niets in deze tabellen verstuurt mail of beweegt geld.

-- Eén regel per mail die de pod als concept klaarzet: aan een praktijk (alle stukken van één notadatum), aan het verkoopadres van een
-- entiteit in Exact (de stukken van die entiteit op die datum), of een herinnering. De pod schrijft; de app leest.
CREATE TABLE mail_concept (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sleutel TEXT NOT NULL UNIQUE,            -- praktijk:P03:2027-02-01 · exact:POT:2027-02-01 · herinnering:<verzoek-id>
  soort TEXT NOT NULL CHECK (soort IN ('praktijk','exact','herinnering')),
  entiteit TEXT CHECK (entiteit IS NULL OR entiteit IN ('POT','KM','SLOEL')),
  praktijk_id TEXT REFERENCES praktijk(id),
  datum TEXT NOT NULL,                     -- notadatum van de stukken (herinnering: de dag van het verzoek)
  nota_ids TEXT NOT NULL,                  -- JSON [nota.id]
  nummers TEXT NOT NULL,                   -- JSON ["POT 2027010", …]
  aan TEXT,
  onderwerp TEXT,
  status TEXT NOT NULL DEFAULT 'wacht' CHECK (status IN ('wacht','bezig','concept','onzeker','fout','verzonden','concept_weg','geen_adres','wacht_op_adres')),
  reden TEXT,                              -- waarom wacht/fout/geen_adres, in gewone taal
  concept_id TEXT,
  thread_id TEXT,
  concept_op TEXT,
  verzonden_op TEXT,
  gemeten_op TEXT,
  pogingen INTEGER NOT NULL DEFAULT 0,
  geclaimd_op TEXT,
  aangemaakt_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  bijgewerkt_op TEXT
);
CREATE INDEX ix_mail_concept_status ON mail_concept(status);
CREATE INDEX ix_mail_concept_datum ON mail_concept(datum);

-- Verzoeken uit de app aan de pod (nu alleen: herinnering als concept voor één open nota).
CREATE TABLE pod_verzoek (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  soort TEXT NOT NULL CHECK (soort IN ('herinnering')),
  nota_id INTEGER NOT NULL REFERENCES nota(id),
  open_bedrag REAL NOT NULL,               -- wat de app op het moment van de klik open zag (komt in de mail)
  status TEXT NOT NULL DEFAULT 'wacht' CHECK (status IN ('wacht','klaar','fout','geannuleerd')),
  uitkomst TEXT,
  gevraagd_door TEXT NOT NULL,
  gevraagd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  bijgewerkt_op TEXT
);
CREATE INDEX ix_pod_verzoek_status ON pod_verzoek(status);

-- R10: een overname met een datum. verdeling = 'maanden' (afrekening van dat jaar naar maanden over oude en nieuwe houder) of
-- 'nieuwe_houder' (alles naar de houder op de notadatum). De gegevens van de nieuwe houder staan in praktijk_versie (geldig_van = datum).
CREATE TABLE overname (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  praktijk_id TEXT NOT NULL REFERENCES praktijk(id),
  datum TEXT NOT NULL,
  verdeling TEXT NOT NULL CHECK (verdeling IN ('maanden','nieuwe_houder')),
  opmerking TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (praktijk_id, datum)
);

INSERT INTO instelling (sleutel, waarde, opmerking) VALUES
  ('maandronde_uur', '06:00', 'de pod maakt op de 1e vanaf dit uur (Nederlandse tijd) de nota''s van de maand en zet de concepten klaar'),
  ('ondertekening', 'David Schaap', 'naam onder de mailconcepten aan de praktijken');

-- Koppelingen bank ↔ nota: samen nooit meer dan het bedrag van de bankpost (atomair in de database, ook bij twee gelijktijdige verzoeken;
-- Codex r1 M3), en alleen binnen dezelfde entiteit.
CREATE TRIGGER koppeling_som_in BEFORE INSERT ON koppeling
WHEN (SELECT coalesce(sum(bedrag), 0) FROM koppeling WHERE bankmutatie_id = NEW.bankmutatie_id AND nota_id <> NEW.nota_id) + NEW.bedrag
     > abs((SELECT bedrag FROM bankmutatie WHERE id = NEW.bankmutatie_id)) + 0.004
  OR (SELECT entiteit FROM bankmutatie WHERE id = NEW.bankmutatie_id) IS NOT (SELECT entiteit FROM nota WHERE id = NEW.nota_id)
BEGIN SELECT RAISE(ABORT, 'koppeling: meer dan de bankpost of een andere entiteit'); END;
CREATE TRIGGER koppeling_som_upd BEFORE UPDATE ON koppeling
WHEN (SELECT coalesce(sum(bedrag), 0) FROM koppeling WHERE bankmutatie_id = NEW.bankmutatie_id AND id <> OLD.id) + NEW.bedrag
     > abs((SELECT bedrag FROM bankmutatie WHERE id = NEW.bankmutatie_id)) + 0.004
  OR (SELECT entiteit FROM bankmutatie WHERE id = NEW.bankmutatie_id) IS NOT (SELECT entiteit FROM nota WHERE id = NEW.nota_id)
BEGIN SELECT RAISE(ABORT, 'koppeling: meer dan de bankpost of een andere entiteit'); END;

-- OVIS POT — migratie 0005 (wv2773, David 8-11-2026): er zijn geen leningen.
-- Wat een praktijk buiten de nota's om extra stort (bank: soort 'liquiditeit' met een praktijk, bv. Tolgaarde € 10.000 aan de
-- Kostenmaatschap in 2026) is een extra bijdrage van die praktijk in dat boekjaar; de afrekening verrekent het (kern: tegenUitGeld,
-- vanaf boekjaar 2026). De bankposten zelf blijven zoals ze zijn. De lening-rij(en) gaan als 'vervallen' in het logboek (oud = de rij)
-- en de tabel wordt leeg: hij blijft bestaan zolang de pod-bundel van vóór wv2773 hem nog leest; opruimen in een latere migratie.
INSERT INTO logboek (wie, tabel, sleutel, actie, oud, nieuw)
  SELECT 'machinekamer wv2773', 'lening', entiteit || '/' || id, 'vervallen',
    json_object('id', id, 'entiteit', entiteit, 'verstrekt_door', verstrekt_door, 'bedrag_open', bedrag_open, 'peildatum', peildatum, 'opmerking', opmerking, 'ingevoerd_op', ingevoerd_op),
    json_quote('geen lening (David 8-11-2026): de stortingen van ' || verstrekt_door || ' zijn een extra bijdrage in het boekjaar van de storting (bank: liquiditeit) en worden in de afrekening van dat jaar verrekend')
  FROM lening;
DELETE FROM lening;

-- buffer in gekozen maanden (wv2770): bv. '1,7' = helft met januari, helft met juli; leeg = opbouw_maanden gelijke delen vanaf januari
ALTER TABLE buffer ADD COLUMN opbouw_in TEXT;

-- OVIS POT — migratie 0006 (wv2782, David 8-11-2026: "alles mag gerust in 1 grote databank"): de geschiedenis 2022–2026 voor het
-- naspelen. Eén rij per bedrag uit één stuk van David (begroting vooraf, aanvulling, correctie op de huur, eindafrekening) of een
-- beginsaldo, altijd met de bron. Alleen lezen voor de app; raakt de lopende stand (jaarplan, nota's, buffer) niet.
-- categorie:
--   begroting_vooraf      wat vooraf per maand gevraagd is (per praktijk; SLOEL 2022 alleen als jaartotaal, maand en praktijk leeg)
--   aanvulling            tussentijds extra (of minder) gevraagd
--   correctie_vorig_jaar  SLOEL: afrekening van het vorige jaar als regel op de huur
--   begroting_plan        een begroting die zo niet als nota's de deur uitging (ter info)
--   begroting_vervallen   een vervangen versie (ter info)
--   eind_kosten / eind_betaald / eind_saldo   Davids eindafrekening per praktijk (kosten toegerekend, betaald, verschil)
--   beginsaldo            saldo op de rekening op 31-12 van `jaar` (jaarrekening of bankketen)
CREATE TABLE historie (
  id INTEGER PRIMARY KEY,
  soort TEXT NOT NULL DEFAULT 'historie' CHECK (soort = 'historie'),
  entiteit TEXT NOT NULL CHECK (entiteit IN ('POT', 'KM', 'SLOEL')),
  jaar INTEGER NOT NULL CHECK (jaar BETWEEN 2014 AND 2100),
  maand INTEGER CHECK (maand BETWEEN 1 AND 12),
  praktijk_id TEXT REFERENCES praktijk(id),
  categorie TEXT NOT NULL CHECK (categorie IN ('begroting_vooraf', 'aanvulling', 'correctie_vorig_jaar', 'begroting_plan', 'begroting_vervallen',
    'eind_kosten', 'eind_betaald', 'eind_saldo', 'beginsaldo')),
  bedrag REAL NOT NULL,
  titel TEXT NOT NULL,
  bron TEXT NOT NULL CHECK (length(bron) > 0),
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX historie_ent_jaar ON historie (entiteit, jaar, categorie);

-- OVIS POT (wv2787, David 8-11-2026): POT-bijdrage in januari zwaarder, in februari evenveel lichter.
-- Januari + f × jaarbegroting, februari − f × jaarbegroting (jaarpremies en loonheffing over de eindejaarsuitkering vallen in januari);
-- het jaar per praktijk blijft gelijk. Geldt voor de jaarbegroting vanaf 2027 (kern JAN_FEB.vanaf). Wijzigen: scherm Begroting (POT).
INSERT INTO instelling (sleutel, waarde, opmerking) VALUES
  ('pot_jan_feb', '0.03', 'POT: januari + deze fractie van de jaarbegroting, februari evenveel minder (vanaf 2027; wv2787)')
ON CONFLICT(sleutel) DO NOTHING;

-- OVIS POT — migratie 0008 (wv2789, David 8-11-2026: "doen alsof het eind van het vorige jaar is"): de blinde terugtoets in de
-- historie. Drie categorieën erbij (de rest is ongewijzigd; SQLite kan een CHECK niet wijzigen, dus de tabel wordt herbouwd):
--   blind_vooraf        de begroting per maand die de rekenkern op 31-12 van het jaar ervoor zelf had gemaakt, alleen met wat toen
--                       bekend was (personeel × cao-tabel van dat moment, kosten vorig jaar uit de bank × index); entiteitstotaal
--   blind_vakantiegeld  het vakantiegeldpakket daarin (POT, voor het maandpatroon)
--   blind_eindejaar     het eindejaarspakket daarin (POT, voor het maandpatroon)
-- (nummer 0008: 0007 is gereserveerd voor wv2787; de twee raken elkaar niet)
CREATE TABLE historie_nieuw (
  id INTEGER PRIMARY KEY,
  soort TEXT NOT NULL DEFAULT 'historie' CHECK (soort = 'historie'),
  entiteit TEXT NOT NULL CHECK (entiteit IN ('POT', 'KM', 'SLOEL')),
  jaar INTEGER NOT NULL CHECK (jaar BETWEEN 2014 AND 2100),
  maand INTEGER CHECK (maand BETWEEN 1 AND 12),
  praktijk_id TEXT REFERENCES praktijk(id),
  categorie TEXT NOT NULL CHECK (categorie IN ('begroting_vooraf', 'aanvulling', 'correctie_vorig_jaar', 'begroting_plan', 'begroting_vervallen',
    'eind_kosten', 'eind_betaald', 'eind_saldo', 'beginsaldo', 'blind_vooraf', 'blind_vakantiegeld', 'blind_eindejaar')),
  bedrag REAL NOT NULL,
  titel TEXT NOT NULL,
  bron TEXT NOT NULL CHECK (length(bron) > 0),
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO historie_nieuw (id, soort, entiteit, jaar, maand, praktijk_id, categorie, bedrag, titel, bron, ingevoerd_op)
  SELECT id, soort, entiteit, jaar, maand, praktijk_id, categorie, bedrag, titel, bron, ingevoerd_op FROM historie;
DROP TABLE historie;
ALTER TABLE historie_nieuw RENAME TO historie;
CREATE INDEX historie_ent_jaar ON historie (entiteit, jaar, categorie);

-- Subsidie van de gemeente als TOTAAL per jaar (60 uur POH Jeugd-GGZ, ex btw). De app verdeelt het zelf naar rato van de patiëntaantallen
-- (laatst bekende stand op 1 januari van dat jaar); een bedrag per praktijk in `subsidie` gaat voor. Bron = de stukken van David.
CREATE TABLE subsidie_totaal (
  jaar INTEGER NOT NULL,
  soort TEXT NOT NULL CHECK (soort IN ('aangevraagd','verleend','vastgesteld','prognose')),
  bedrag REAL NOT NULL,
  bron TEXT,
  ingevoerd_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (jaar, soort)
);

-- wv2795 (David 8-11-2026): de maandnota's niet meer op de 1e maar bijtijds, de 25e van de maand ervoor, met het verzoek ze na binnenkomst meteen in te
-- boeken zodat het bedrag de 15e binnen is. notadag = de dag voor alle drie (1 = de 1e van de maand zelf, 2–28 = die dag van de maand ervoor);
-- per entiteit kan notadag_<E> (scherm Nota's) ervan afwijken. Januari blijft de januari-ronde.
update instelling set waarde = '25', opmerking = 'maandnota''s als concept op deze dag van de maand ervoor (1 = de 1e van de maand zelf); per entiteit notadag_<E>; januari = januari-ronde (wv2795)' where sleutel = 'notadag';
insert or ignore into instelling (sleutel, waarde, opmerking) values ('notadag', '25', 'maandnota''s als concept op deze dag van de maand ervoor (1 = de 1e van de maand zelf); per entiteit notadag_<E>; januari = januari-ronde (wv2795)');
update instelling set opmerking = 'de pod maakt op de notadag vanaf dit uur (Nederlandse tijd) de nota''s van de volgende maand en zet de concepten klaar (wv2795)' where sleutel = 'maandronde_uur';

-- OVIS POT — migratie 0011 (wv2800): personeel POT uit Nmbrs (salarisadministratie). Een contract kan gekoppeld zijn aan een
-- Nmbrs-dienstverband; nmbrs_stand = wat de koppeling de vorige keer schreef (drie-weg: een handmatige correctie wordt nooit stil
-- overschreven). einde_bron = waarom het contract een einddatum heeft (uit dienst, of einde bepaalde tijd zonder aangenomen verlenging).
-- Geen bedragen: de koppeling kent alleen schaal, trede, uren, data en functie.
ALTER TABLE contract ADD COLUMN nmbrs_dienst TEXT;
ALTER TABLE contract ADD COLUMN nmbrs_medewerker TEXT;
ALTER TABLE contract ADD COLUMN nmbrs_stand TEXT;
ALTER TABLE contract ADD COLUMN einde_bron TEXT;
-- Een wijziging per datum is van de koppeling als nmbrs_stand gevuld is (wat de koppeling schreef: uren, schaal, trede); dezelfde drie-weg.
ALTER TABLE contractmutatie ADD COLUMN nmbrs_stand TEXT;
CREATE UNIQUE INDEX ux_contract_nmbrs ON contract(nmbrs_dienst) WHERE nmbrs_dienst IS NOT NULL;
