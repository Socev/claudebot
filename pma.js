'use strict';
// ── OVIS PMA fase 1 (wv3037, 14-11-2026; plan vault "01_Ontwikkeling/OVIS PMA - plan (Fable 5.2, 14-11-2026)" § 2, § 4, § 5) ──
// Declaratie-inzicht uit Davids eigen Promedico-exports (gegevensset "PMA"): een ZIP met export_info.csv en één …_PMA_VERRICHTING.csv.
// Eigen databank pma.sqlite op de pod (map 700, bestand 600); de ZIP's zelf in bron/ (600) zodat alles opnieuw op te bouwen is.
//
// Harde grenzen (grondwet 1, 3; plan § 5):
// - Het patiëntnummer is een pseudoniem: het wordt meteen bij het lezen omgezet met HMAC-SHA256 (geheime sleutel van de pod, over praktijk +
//   nummer, ingekort) en alleen die uitkomst staat in de databank. Geen antwoord, reden, fout of info bevat ooit een (pseudo)patiëntnummer;
//   het scherm krijgt alleen aantallen, en een aantal patiënten onder de vijf wordt "< 5". De kolom `id` wordt niet bewaard.
// - Geen uitgaand verzoek, geen log, geen proces: deze module laadt alleen fs, path, crypto, zlib en node:sqlite (CI-poort test/pma.sh).
//   De controle tegen fin-datahub krijgt hij als getallen van server.js (o.finPatienten), nooit zelf.
// - Strikt: andere kolommen, een onbekende soort of type, een datum buiten de periode, inschrijfgeld op een andere dag dan de eerste van een
//   kwartaal, een onbekende praktijk (AGB) of een ZIP met andere bestanden = weigeren met de reden; nooit gokken.
//
// Overlap (plan § 2): er is geen regelnummer en volledig gelijke regels komen echt voor. Een export is de waarheid voor elke boekingsdag binnen
// zijn begin- en eindperiode; de export met de jongste exportdatum wint per dag (bij gelijke datum de laatst ingelezen). Inschrijfgeld per
// praktijk per kwartaaldatum als geheel. Sleutel van een verrichting = inhoud (zonder id en factuurdatum) + volgnummer binnen gelijke regels
// op die dag. Zelfde sha256 = niets. Regels zonder factuurdatum zijn voorlopig en worden door een latere export ververst.
// Twee stappen: Controleer (ZIP in wacht/, alleen tellen) en Inlezen (opnieuw tellen; anders dan bij Controleer = weigeren; daarna schrijven,
// nacontrole in dezelfde transactie, ZIP naar bron/). Intrekken = stand 'ingetrokken' en de praktijk opnieuw opbouwen uit de overige ZIP's.
//
// wv3045 (14-11-2026): ook de export zonder kolom patientnummer (Davids normale vorm sinds 14-11). Patient = '' in de databank; patiënten per
// kwartaal = aantal basisregels, dubbel en in-/uitstroom = "niet in deze export". Een latere export in de andere vorm vervangt de dagen gewoon
// (vergelijking op inhoud zonder patiënt, alleen voor de tellingen bij Controleer).
//
// Gebruik vanuit server.js: require('./pma.js').maak({ map, finPatienten() }) → { app({ pad, methode, body }), info(), herbouw(praktijk) }.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const SCHEMA_VERSIE = 4;   // 2 = wv3045: export.met_patient (export zonder kolom patientnummer); 3 = wv3047: persoon, rol_periode, rooster_hand, registreerder.bevestigd; 4 = wv3111: registreerder.negeer
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);
CREATE TABLE IF NOT EXISTS praktijk (code TEXT PRIMARY KEY, naam TEXT NOT NULL, agb TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS export (id INTEGER PRIMARY KEY AUTOINCREMENT, praktijk TEXT NOT NULL REFERENCES praktijk(code), sha256 TEXT NOT NULL UNIQUE,
  naam TEXT, exportdatum TEXT NOT NULL, begin TEXT NOT NULL, eind TEXT NOT NULL, gegevensset TEXT NOT NULL, op TEXT NOT NULL,
  n_inschrijf INTEGER NOT NULL, n_regel INTEGER NOT NULL, n_voorlopig INTEGER NOT NULL, n_gelijk INTEGER NOT NULL,
  stand TEXT NOT NULL CHECK (stand IN ('actief','ingetrokken')), samenvatting TEXT NOT NULL, met_patient INTEGER NOT NULL DEFAULT 1 CHECK (met_patient IN (0,1)));
CREATE TABLE IF NOT EXISTS inschrijf (praktijk TEXT NOT NULL, peildatum TEXT NOT NULL, patient TEXT NOT NULL, code TEXT NOT NULL, tarief_cent INTEGER NOT NULL,
  registreerder TEXT NOT NULL, volgnr INTEGER NOT NULL, export_id INTEGER NOT NULL REFERENCES export(id),
  UNIQUE (praktijk, peildatum, patient, code, volgnr));
CREATE TABLE IF NOT EXISTS regel (sleutel TEXT PRIMARY KEY, praktijk TEXT NOT NULL, dag TEXT NOT NULL, patient TEXT NOT NULL, code TEXT, omschrijving TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('V','O')), reg_agb TEXT, registreerder TEXT NOT NULL, tarief_cent INTEGER NOT NULL, factuurdatum TEXT,
  volgnr INTEGER NOT NULL, voorlopig INTEGER NOT NULL CHECK (voorlopig IN (0,1)), export_id INTEGER NOT NULL REFERENCES export(id));
CREATE INDEX IF NOT EXISTS regel_dag ON regel (praktijk, dag);
CREATE TABLE IF NOT EXISTS dagbron (praktijk TEXT NOT NULL, dag TEXT NOT NULL, export_id INTEGER NOT NULL REFERENCES export(id), PRIMARY KEY (praktijk, dag));
CREATE TABLE IF NOT EXISTS kwartaalbron (praktijk TEXT NOT NULL, peildatum TEXT NOT NULL, export_id INTEGER NOT NULL REFERENCES export(id), PRIMARY KEY (praktijk, peildatum));
CREATE TABLE IF NOT EXISTS code (code TEXT NOT NULL, van_jaar INTEGER NOT NULL, tot_jaar INTEGER, naam TEXT NOT NULL, groep TEXT NOT NULL, subgroep TEXT,
  ritme TEXT CHECK (ritme IN ('kwartaal','jaar')), telt_patient INTEGER NOT NULL DEFAULT 0, telt_werkdag INTEGER NOT NULL DEFAULT 1,
  bron TEXT NOT NULL CHECK (bron IN ('start','david','gezien')), PRIMARY KEY (code, van_jaar));
CREATE TABLE IF NOT EXISTS registreerder (praktijk TEXT NOT NULL, naam TEXT NOT NULL, persoon INTEGER, soort TEXT NOT NULL CHECK (soort IN ('persoon','verzamel')),
  eerst TEXT NOT NULL, PRIMARY KEY (praktijk, naam));
CREATE TABLE IF NOT EXISTS instelling (praktijk TEXT NOT NULL, sleutel TEXT NOT NULL, waarde TEXT NOT NULL, PRIMARY KEY (praktijk, sleutel));
CREATE TABLE IF NOT EXISTS persoon (id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT NOT NULL, dossier TEXT, nmbrs TEXT,
  dienst TEXT NOT NULL DEFAULT 'onbekend' CHECK (dienst IN ('loondienst','pot','zzp','praktijkhouder','onbekend')), groep INTEGER NOT NULL DEFAULT 0 CHECK (groep IN (0,1)), op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rol_periode (id INTEGER PRIMARY KEY AUTOINCREMENT, persoon INTEGER NOT NULL REFERENCES persoon(id), praktijk TEXT NOT NULL REFERENCES praktijk(code),
  rol TEXT NOT NULL, van TEXT NOT NULL, tot TEXT, op TEXT NOT NULL, CHECK (tot IS NULL OR tot >= van));
CREATE TABLE IF NOT EXISTS rooster_hand (persoon INTEGER NOT NULL REFERENCES persoon(id), praktijk TEXT NOT NULL REFERENCES praktijk(code), ingang TEXT NOT NULL,
  uren TEXT NOT NULL, op TEXT NOT NULL, PRIMARY KEY (persoon, praktijk, ingang));
`;

// Praktijken op het AGB zoals het in export_info staat (zonder de voorloop "01"); onbekend = weigeren met de vraag.
const PRAKTIJKEN = { '009870': { code: 'TG', naam: 'Tolgaarde' }, '010710': { code: 'GH', naam: 'Groenhouten' } };

// Groepen (plan § 2 "Indeling van verrichtingen"). Volgorde = volgorde op het scherm.
const GROEPEN = ['inschrijving', 'module', 'consult', 'visite', 'poh-ggz', 'mi', 'materiaal', 'overig', 'niet-gedeclareerd', 'nog-in-te-delen'];
const GROEP_NAAM = { inschrijving: 'Inschrijving', module: 'Modules', consult: 'Regulier – consult', visite: 'Regulier – visite', 'poh-ggz': 'POH-GGZ',
  mi: 'M&I', materiaal: 'Materiaal', overig: 'Overig', 'niet-gedeclareerd': 'Niet gedeclareerd', 'nog-in-te-delen': 'Nog in te delen' };
// Startvulling: fin-datahub `prestatie` (14-11-2026; categorie consult/mi/materiaal/module/ion) plus de groepen uit het plan. [code, naam, groep, subgroep, ritme, telt_patient]
const CODES_START = [
  ['11115', 'Inschrijving tot 65 jaar', 'inschrijving', 'tot 65', 'kwartaal', 1], ['11116', 'Inschrijving 65 tot 75 jaar', 'inschrijving', '65–75', 'kwartaal', 1],
  ['11117', 'Inschrijving 75 tot 85 jaar', 'inschrijving', '75–85', 'kwartaal', 1], ['11118', 'Inschrijving vanaf 85 jaar', 'inschrijving', '85+', 'kwartaal', 1],
  ['11119', 'Opslag opslagwijk', 'inschrijving', 'opslag', 'kwartaal', 0],
  ['11201', 'Opslag POH-GGZ', 'module', null, 'kwartaal', 0], ['13050', 'Meer tijd voor de patiënt', 'module', null, 'kwartaal', 0],
  ['30121', 'Resultaatbeloning service en bereikbaarheid', 'module', null, 'kwartaal', 0], ['31080', 'POH-S', 'module', null, 'kwartaal', 0],
  ['31174', 'Praktijkmanagement', 'module', null, 'kwartaal', 0], ['31279', 'Spiegelinformatie', 'module', null, 'kwartaal', 0],
  ['31315', 'Afspraken apothekers en huisartsen (FTO)', 'module', null, 'jaar', 0], ['31343', 'Zorgvernieuwing POH-GGZ', 'module', null, 'kwartaal', 0],
  ['31453', 'Meer tijd voor de patiënt', 'module', null, 'kwartaal', 0],
  ['12010', 'Consult korter dan 5 min', 'consult', 'kort', null, 0], ['12011', 'Consult 5 tot 20 min', 'consult', 'middel', null, 0],
  ['12001', 'Consult 20 min en langer', 'consult', 'lang', null, 0], ['12410', 'Passant korter dan 5 min', 'consult', 'passant', null, 0],
  ['12411', 'Passant 5 tot 20 min', 'consult', 'passant', null, 0], ['12401', 'Passant 20 min en langer', 'consult', 'passant', null, 0],
  ['12507', 'Militair korter dan 5 min', 'consult', 'militair', null, 0], ['12519', 'Militair 5 tot 20 min', 'consult', 'militair', null, 0],
  ['12501', 'Militair 20 min en langer', 'consult', 'militair', null, 0], ['12151', 'Eerstelijns verblijf, 20 min en langer', 'consult', 'elv', null, 0],
  ['12002', 'Visite korter dan 20 min', 'visite', 'kort', null, 0], ['12003', 'Visite 20 min en langer', 'visite', 'lang', null, 0],
  ['12402', 'Visite passant korter dan 20 min', 'visite', 'passant', null, 0], ['12403', 'Visite passant 20 min en langer', 'visite', 'passant', null, 0],
  ['12117', 'POH-GGZ consult korter dan 5 min', 'poh-ggz', 'consult', null, 0], ['12118', 'POH-GGZ consult 5 tot 20 min', 'poh-ggz', 'consult', null, 0],
  ['12111', 'POH-GGZ consult 20 min en langer', 'poh-ggz', 'consult', null, 0], ['12112', 'POH-GGZ visite korter dan 20 min', 'poh-ggz', 'visite', null, 0],
  ['12113', 'POH-GGZ visite 20 min en langer', 'poh-ggz', 'visite', null, 0], ['12116', 'POH-GGZ groepsconsult', 'poh-ggz', 'groep', null, 0],
  ['13001', 'Doppler', 'mi', 'Doppler', null, 0], ['13004', 'Spirometrie', 'mi', 'Spirometrie', null, 0], ['13005', 'ECG', 'mi', 'ECG', null, 0],
  ['13008', '24-uurs bloeddruk', 'mi', '24-uurs bloeddruk', null, 0], ['13009', 'Teledermatologie', 'mi', 'Teledermatologie', null, 0],
  ['13010', 'Cognitieve functietest', 'mi', 'MMSE', null, 0], ['13011', 'Hartritmestoornissen', 'mi', 'Hartritme', null, 0],
  ['13012', 'Chirurgie', 'mi', 'Chirurgie', null, 0], ['13015', 'Compressietherapie', 'mi', 'Compressie', null, 0],
  ['13023', 'Therapeutische injectie', 'mi', 'Cyriax', null, 0], ['13024', 'Oogboring', 'mi', 'Oogboring', null, 0],
  ['13034', 'Intensieve zorg, dag', 'mi', 'Intensieve zorg', null, 0], ['13036', 'Intensieve zorg, ANW', 'mi', 'Intensieve zorg', null, 0],
  ['13038', 'Euthanasie', 'mi', 'Euthanasie', null, 0], ['13042', 'IUD of implantaat', 'mi', 'IUD', null, 0],
  ['13049', 'Polyfarmacie', 'mi', 'Polyfarmacie', null, 0], ['13051', 'Meedenkadvies', 'mi', 'Meedenkadvies', null, 0],
  ['12850', 'Stoppen met roken', 'mi', 'Stoppen met roken', null, 0], ['31242', 'Polireview of update behandelwens', 'mi', 'Behandelwens', null, 0],
  ['31244', 'Behandelwensgesprek', 'mi', 'Behandelwens', null, 0],
  ['12900', 'Hechtmateriaal', 'materiaal', null, null, 0], ['12901', 'Tapemateriaal', 'materiaal', null, null, 0], ['12902', 'Zwangerschapstest', 'materiaal', null, null, 0],
  ['12903', 'Dipslides', 'materiaal', null, null, 0], ['12904', 'Teststrips bloedsuiker', 'materiaal', null, null, 0], ['12905', 'Stikstof', 'materiaal', null, null, 0],
  ['12906', 'Blaaskatheter', 'materiaal', null, null, 0], ['12907', 'CRP-sneltest', 'materiaal', null, null, 0],
  ['12820', 'Informatieverstrekking', 'overig', null, null, 0], ['12100', 'Kardia', 'overig', null, null, 0],
];

const KOP_INFO = ['AGB', 'Export datum', 'Begin periode', 'Eind periode', 'Naam populatie', 'Naam gegevensset', 'Type'];
const KOP_DATA = ['id', 'patientnummer', 'Verrichting', 'Omschrijving', 'Type', 'Registreerder AGB', 'Registreerder', 'Soort', 'Tarief', 'Boekingsdatum', 'Factuurdatum'];
// wv3045 (David 14-11-2026, bewust): de export zonder de kolom patientnummer is de normale vorm. Dan staat patient = '' in de databank
// (ZONDER); alles wat niet van het nummer afhangt werkt gewoon, unieke patiënten, dubbele basisregels en in-/uitstroom worden NIET.
const KOP_ZONDER = KOP_DATA.filter((k) => k !== 'patientnummer');
const ZONDER = '';
const NIET = 'niet in deze export';
const ZIP_MAX = 8 * 1024 * 1024;            // één ZIP (een jaar Tolgaarde ± 1,2 MB)
const UITGEPAKT_MAX = 60 * 1024 * 1024;     // samen uitgepakt (een jaar ± 27 MB); daarboven weigeren (ZIP-bom). wv3409: was 200 MB; een
                                            // kleine ZIP vol ';' kostte dan GB's geheugen (Fable-review 19-11, P3)
const LEEG_MAX = 100;                       // wv3409: lege regels achter elkaar (een echte export heeft er hooguit één aan het eind)
const VELD_MAX = 1000;                      // wv3409: tekens per veld (omschrijving hooguit 300); langer = meteen weigeren tijdens het splitsen
const WACHT_MS = 24 * 3600 * 1000;          // een gecontroleerde ZIP blijft een dag in wacht/
const KLEIN = 5;                            // patiëntaantallen onder de vijf: "< 5"

class Fout extends Error { constructor(status, bericht) { super(bericht); this.status = status; } }
class LeesFout extends Fout { constructor(bericht) { super(400, bericht); } }

// ── ZIP lezen (centrale map; deflate of opgeslagen; CRC-controle; geen versleuteling, geen ZIP64) ──
function leesZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new LeesFout('dit is geen ZIP-bestand');
  if (buf.length > ZIP_MAX) throw new LeesFout('de ZIP is te groot (hooguit 8 MB); exporteer per kalenderjaar');
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; } }
  if (e < 0) throw new LeesFout('dit is geen ZIP-bestand');
  const aantal = buf.readUInt16LE(e + 10), cdGroot = buf.readUInt32LE(e + 12), cdStart = buf.readUInt32LE(e + 16);
  if (aantal === 0xffff || cdStart === 0xffffffff) throw new LeesFout('ZIP64 wordt niet gelezen');
  if (aantal < 1 || aantal > 10 || cdStart + cdGroot > e) throw new LeesFout('de ZIP is beschadigd of bevat te veel bestanden');
  const uit = []; let p = cdStart, totaal = 0;
  for (let k = 0; k < aantal; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new LeesFout('de ZIP is beschadigd (centrale map)');
    const vlag = buf.readUInt16LE(p + 8), methode = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lh = buf.readUInt32LE(p + 42);
    const naam = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    p += 46 + nl + xl + cl;
    if (vlag & 1) throw new LeesFout('de ZIP is versleuteld');
    if (naam.endsWith('/')) continue;
    if (!/^[^\\/:*?"<>|\u0000-\u001f]{1,200}$/.test(naam)) throw new LeesFout('de ZIP bevat een bestand in een map of met een vreemde naam');
    totaal += usize;
    if (totaal > UITGEPAKT_MAX) throw new LeesFout('de ZIP is uitgepakt te groot');
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw new LeesFout('de ZIP is beschadigd (bestandskop)');
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    if (start + csize > buf.length) throw new LeesFout('de ZIP is afgebroken');
    const ruw = buf.slice(start, start + csize);
    let data;
    if (methode === 0) data = Buffer.from(ruw);
    else if (methode === 8) { try { data = zlib.inflateRawSync(ruw, { maxOutputLength: usize + 1 }); } catch (x) { throw new LeesFout('de ZIP is beschadigd (uitpakken)'); } }
    else throw new LeesFout('de ZIP gebruikt een onbekende compressie');
    if (data.length !== usize || (zlib.crc32(data) >>> 0) !== crc) throw new LeesFout('de ZIP is beschadigd (controlegetal)');
    uit.push({ naam, data });
  }
  return uit;
}

// ── CSV (';', velden tussen aanhalingstekens met "" als aanhalingsteken; CRLF of LF) ──
// wv3409: opt.maxVelden, opt.maxVeld en opt.maxRijen breken af bij de eerste te brede rij of het eerste te lange veld; met opt.rij(rij, index) gaat elke rij
// meteen naar de lezer en bewaart splitsCsv niets (de lezer weigert de eerste foute rij, dus een bestand vol lege of halve rijen kost geen geheugen).
// Lege regels aan het eind vallen weg; een lege regel gevolgd door een gevulde komt gewoon door (als rij [''], die de lezer weigert).
function splitsCsv(tekst, opt) {
  const o = opt || {}, maxVelden = o.maxVelden || Infinity, maxVeld = o.maxVeld || Infinity, maxRijen = o.maxRijen || Infinity, perRij = o.rij;
  const rijen = []; let rij = [], veld = '', i = 0, inQ = false, wasQ = false, nRij = 0, leeg = 0;
  const n = tekst.length;
  const waar = () => 'regel ' + (nRij + leeg + 1);
  const klaar = (r) => {
    if (r.length === 1 && r[0] === '') { if (++leeg > LEEG_MAX) throw new LeesFout(waar() + ': meer dan ' + LEEG_MAX + ' lege regels achter elkaar'); return; }
    for (; leeg > 0; leeg--) { if (nRij >= maxRijen) throw new LeesFout('meer dan ' + maxRijen + ' regels'); if (perRij) perRij([''], nRij); else rijen.push(['']); nRij++; }
    if (nRij >= maxRijen) throw new LeesFout('meer dan ' + maxRijen + ' regels');
    if (perRij) perRij(r, nRij); else rijen.push(r);
    nRij++;
  };
  const erbij = () => {
    if (rij.length >= maxVelden) throw new LeesFout(waar() + ': meer dan ' + maxVelden + ' velden');
    rij.push(veld); veld = ''; wasQ = false;
  };
  while (i < n) {
    const c = tekst[i];
    if (veld.length > maxVeld) throw new LeesFout(waar() + ': een veld is langer dan ' + maxVeld + ' tekens');
    if (inQ) {
      if (c === '"') { if (tekst[i + 1] === '"') { veld += '"'; i += 2; continue; } inQ = false; i++; continue; }
      veld += c; i++; continue;
    }
    if (c === '"') { if (veld !== '' || wasQ) throw new LeesFout(waar() + ': aanhalingsteken midden in een veld'); inQ = true; wasQ = true; i++; continue; }
    if (c === ';') { erbij(); i++; continue; }
    if (c === '\r' || c === '\n') {
      erbij(); const r = rij; rij = []; klaar(r);
      if (c === '\r' && tekst[i + 1] === '\n') i++;
      i++; continue;
    }
    if (wasQ) throw new LeesFout(waar() + ': tekst na een aanhalingsteken');
    veld += c; i++;
  }
  if (inQ) throw new LeesFout('het bestand eindigt midden in een veld');
  if (veld.length > maxVeld) throw new LeesFout(waar() + ': een veld is langer dan ' + maxVeld + ' tekens');
  if (veld !== '' || rij.length) { erbij(); const r = rij; rij = []; klaar(r); }
  return rijen;
}
function utf8(buf, naam) {
  let t;
  try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { throw new LeesFout(naam + ' is geen UTF-8'); }
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}
function datum(s, wat) {   // dd-mm-jjjj → jjjj-mm-dd
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (!m) throw new LeesFout(wat + ': datum niet als dd-mm-jjjj');
  const iso = m[3] + '-' + m[2] + '-' + m[1];
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== iso) throw new LeesFout(wat + ': geen bestaande datum');
  return iso;
}
function cent(s, wat) {
  const m = /^(-?)(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new LeesFout(wat + ': tarief niet als getal met een punt');
  const c = Number(m[2]) * 100 + Number(((m[3] || '') + '00').slice(0, 2));
  return m[1] ? -c : c;
}
const isKwartaalStart = (iso) => /^\d{4}-(01|04|07|10)-01$/.test(iso);
function volgendKwartaal(q) { const d = new Date(q + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 3); return d.toISOString().slice(0, 10); }
function plusDag(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dagenTussen(a, b) { const u = []; for (let d = a; d <= b; d = plusDag(d, 1)) u.push(d); return u; }
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

// ── een export lezen; pseudo(praktijk, nummer) zet het patiëntnummer METEEN om (het ruwe nummer verlaat deze functie niet) ──
function leesExport(zipBuf, pseudo) {
  const bestanden = leesZip(zipBuf);
  const info = bestanden.filter((b) => b.naam === 'export_info.csv');
  const data = bestanden.filter((b) => /_PMA_VERRICHTING\.csv$/.test(b.naam));
  if (info.length !== 1 || data.length !== 1 || bestanden.length !== 2) {
    throw new LeesFout('de ZIP moet precies export_info.csv en één …_PMA_VERRICHTING.csv bevatten (nu: ' + bestanden.map((b) => b.naam.replace(/^.*_(PMA_[A-Z]+\.csv)$/, '…_$1')).join(', ') + ')');
  }
  const ir = splitsCsv(utf8(info[0].data, 'export_info.csv'), { maxVelden: KOP_INFO.length, maxVeld: VELD_MAX, maxRijen: 2 });
  if (ir.length !== 2 || ir[0].join(';') !== KOP_INFO.join(';') || ir[1].length !== KOP_INFO.length) throw new LeesFout('export_info.csv heeft niet de bekende kolommen');
  const [agb, exd, bg, ed, , set, soortExp] = ir[1];
  const pr = PRAKTIJKEN[agb];
  if (!pr) throw new LeesFout('onbekende praktijk (AGB ' + String(agb).replace(/[^0-9]/g, '').slice(0, 12) + '): bij welke praktijk hoort deze export? Vraag de machinekamer om hem toe te voegen.');
  if (set !== 'PMA') throw new LeesFout('dit is niet de gegevensset "PMA"');
  if (soortExp !== 'Praktijk') throw new LeesFout('export_info: onbekend type export');
  const exportdatum = datum(exd, 'export_info: exportdatum'), begin = datum(bg, 'export_info: begin periode'), eind = datum(ed, 'export_info: eind periode');
  if (begin > eind) throw new LeesFout('export_info: begin ligt na het eind');
  if (eind > exportdatum) throw new LeesFout('export_info: de periode loopt door na de exportdatum');
  // wv3409: elke rij gaat tijdens het splitsen meteen door de controle; de eerste foute rij breekt af (geen lijst van alle rijen vooraf)
  const inschrijf = [], regels = [];
  const volgI = new Map(), volgR = new Map();
  let voorlopig = 0, gelijk = 0, metPatient = null, nKol = 0;
  splitsCsv(utf8(data[0].data, 'het verrichtingenbestand'), { maxVelden: KOP_DATA.length, maxVeld: VELD_MAX, rij: (v, r) => {
    if (r === 0) {
      const kop = v.join(';');
      metPatient = kop === KOP_DATA.join(';');
      if (!metPatient && kop !== KOP_ZONDER.join(';')) throw new LeesFout('het verrichtingenbestand heeft niet de bekende kolommen');
      nKol = metPatient ? KOP_DATA.length : KOP_ZONDER.length;
      return;
    }
    const wat = 'regel ' + (r + 1);
    if (v.length !== nKol) throw new LeesFout(wat + ': ' + v.length + ' velden in plaats van ' + nKol);
    const [pnr, code, oms, type, ragb, reg, soort, tar, bd, fd] = metPatient ? v.slice(1) : [null].concat(v.slice(1));
    if (metPatient && !/^\d{1,20}$/.test(pnr)) throw new LeesFout(wat + ': patiëntnummer niet in de bekende vorm');
    if (!['I', 'V', 'O'].includes(type)) throw new LeesFout(wat + ': onbekend type "' + type.slice(0, 10) + '"');
    if (!['INSCHRIJFGELD', 'NORMAAL'].includes(soort)) throw new LeesFout(wat + ': onbekende soort "' + soort.slice(0, 20) + '"');
    if ((type === 'I') !== (soort === 'INSCHRIJFGELD')) throw new LeesFout(wat + ': type ' + type + ' hoort niet bij soort ' + soort);
    if (type === 'O' ? code !== '' : !/^\d{5}$/.test(code)) throw new LeesFout(wat + ': prestatiecode niet in de bekende vorm');
    if (oms.length > 300 || reg.length > 120 || !reg.trim()) throw new LeesFout(wat + ': omschrijving of registreerder ontbreekt of is te lang');
    if (ragb !== '' && !/^\d{8}$/.test(ragb)) throw new LeesFout(wat + ': registreerder-AGB niet in de bekende vorm');
    const dag = datum(bd, wat + ' boekingsdatum');
    const fdag = fd === '' ? null : datum(fd, wat + ' factuurdatum');
    const tc = cent(tar, wat);
    if (dag < begin || dag > eind) throw new LeesFout(wat + ': boekingsdatum ' + bd + ' ligt buiten de periode van de export');
    const patient = metPatient ? pseudo(pr.code, pnr) : ZONDER;
    if (type === 'I') {
      if (!isKwartaalStart(dag)) throw new LeesFout(wat + ': inschrijfgeld op ' + bd + ', niet op de eerste dag van een kwartaal');
      const k = dag + '|' + patient + '|' + code;
      const n = (volgI.get(k) || 0) + 1; volgI.set(k, n);
      inschrijf.push({ peildatum: dag, patient, code, tarief_cent: tc, registreerder: reg, volgnr: n, naam: oms });
    } else {
      const inhoud = [pr.code, dag, patient, code, oms, type, ragb, reg, tc].join('\u0001');
      const n = (volgR.get(inhoud) || 0) + 1; volgR.set(inhoud, n);
      if (n > 1) gelijk++;
      const vl = type === 'V' && !fdag ? 1 : 0;   // type O (niet declareren, Philadelphia) krijgt nooit een factuurdatum
      voorlopig += vl;
      regels.push({ sleutel: sha(inhoud + '\u0001' + n).slice(0, 32), dag, patient, code: code || null, omschrijving: oms, type, reg_agb: ragb || null,
        registreerder: reg, tarief_cent: tc, factuurdatum: fdag, volgnr: n, voorlopig: vl });
    }
  } });
  if (metPatient === null) throw new LeesFout('het verrichtingenbestand heeft niet de bekende kolommen');
  return { praktijk: pr.code, praktijk_naam: pr.naam, agb, exportdatum, begin, eind, gegevensset: set, inschrijf, regels, voorlopig, gelijk, met_patient: metPatient };
}


// ── fase 2 (wv3047): registreerder → persoon → rol, roosters en werkdagen (plan § 2 "Registreerder → medewerker → rol", § 3) ──
// Rollen in de tijd per praktijk; de eerste zes vergelijkt het scherm Medewerkers, de laatste vier het scherm Artsen. Alleen binnen een rol.
// wv3111: praktijkmanager erbij (David 15-11-2026; Nmbrs noemt de functie "Praktijkbegeleidster"). Artsen vergelijkt het scherm Artsen als één groep.
const ROLLEN = ['assistente', 'poh-s', 'poh-ggz', 'praktijkmanager', 'paio', 'stagiair', 'overig', 'huisarts-praktijkhouder', 'huisarts-loondienst', 'waarnemer', 'aios'];
const ROL_NAAM = { assistente: 'Assistente', 'poh-s': 'POH-S', 'poh-ggz': 'POH-GGZ', praktijkmanager: 'Praktijkmanager', paio: 'PA(io)', stagiair: 'Stagiair', overig: 'Overig',
  'huisarts-praktijkhouder': 'Huisarts (praktijkhouder)', 'huisarts-loondienst': 'Huisarts in loondienst', waarnemer: 'Waarnemer', aios: 'Aios' };
const ARTS_ROLLEN = ['huisarts-praktijkhouder', 'huisarts-loondienst', 'waarnemer', 'aios'];
// wv3111: rollen waarvan het werk zelden een declaratie geeft (David 15-11-2026 over de praktijkmanager: vaste dagen, incidenteel andere).
// Met een rooster telt een roosterdag dan als gewerkt, ook zonder declaratie (nooit afwezig); een andere doordeweekse dag met activiteit is een extra dag.
const ROOSTER_IS_WERK = new Set(['praktijkmanager']);
// wv3136: rollen zonder afwezige dagen (David 15-11-2026, Ja op de kaart): een POH-GGZ declareert op Tolgaarde gemiddeld maar ± 1,7 keer
// per gewerkte dag, dus een roosterdag zonder declaratie zegt niets. Gewerkt, invaldag, los en uren blijven; een lege roosterdag geeft geen rij.
const GEEN_AFWEZIG_ROLLEN = new Set(['poh-ggz']);
const DIENSTEN = ['loondienst', 'pot', 'zzp', 'praktijkhouder', 'onbekend'];
const TUSSEN = new Set(['van', 'de', 'der', 'den', 'het', 'ter', 'ten', 'te', 't', 'in', 'op', 'la', 'le', 'du', 'da', 'dos', 'el', 'al', 'v', 'vd', 'v d']);
// Verzamelnaam: "Waarnemer Tolgaarde", sinds de export van 14-11-2026 ook "Waarnemer2 Tolgaarde"; een naam die op de praktijknaam eindigt
const VERZAMEL_RE = /^waarnemer|\b(tolgaarde|groenhouten)$/i;
const isoGoed = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && new Date(x + 'T12:00:00Z').toISOString().slice(0, 10) === x;
function kaal(x) { return String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim(); }
// "A. de Vries", "A.B. van Dijk-Jansen", "Anke Proef", "ABC Proef" → { initiaal, voornaam (alleen als uitgeschreven), achter (zonder tussenvoegsel), delen }
function ontleed(voor, rest) {
  const v = String(voor || '').trim(), vk = kaal(v);
  if (!vk) return null;
  const letters = /^(\p{Lu}\.?\s?)+$/u.test(v) || /^\p{Lu}{1,4}$/u.test(v) || /\./.test(v);
  const delen = kaal(rest).split(/[\s-]+/).filter((x) => x && !TUSSEN.has(x) && x.length > 1);
  if (!delen.length) return null;
  return { initiaal: vk[0], voornaam: letters ? null : vk.split(' ')[0], achter: delen.join(''), delen };
}
function ontleedNaam(ruw) { const t = String(ruw || '').trim().split(/\s+/); return t.length < 2 ? null : ontleed(t[0], t.slice(1).join(' ')); }
// 0 = past niet, 1 = één deel van de achternaam gelijk (dubbele naam), 2 = achternaam gelijk; voorletter moet altijd kloppen
function lijkt(a, b) {
  if (!a || !b || a.initiaal !== b.initiaal) return 0;
  if (a.voornaam && b.voornaam && !(a.voornaam.startsWith(b.voornaam) || b.voornaam.startsWith(a.voornaam))) return 0;
  if (a.achter === b.achter) return 2;
  return a.delen.some((x) => b.delen.includes(x)) ? 1 : 0;
}
// Functie (Nmbrs) of dossiernaam → rol (voorstel; David bevestigt)
function rolUit(t) {
  const x = kaal(t);
  if (!x) return null;
  if (/\bggz\b|pohggz/.test(x)) return 'poh-ggz';
  if (/\bpoh ?-?s\b|somati/.test(x)) return 'poh-s';
  if (/praktijkbegeleid|praktijkmanag/.test(x)) return 'praktijkmanager';
  if (/stagi/.test(x)) return 'stagiair';
  if (/physician|\bpa\b|\bpaio\b|\bpa ?-?io\b/.test(x)) return 'paio';
  if (/\baios\b|huisarts in opleiding/.test(x)) return 'aios';
  if (/waarne/.test(x)) return 'waarnemer';
  if (/praktijkhouder/.test(x)) return 'huisarts-praktijkhouder';
  if (/huisarts/.test(x)) return 'huisarts-loondienst';
  if (/assist|doktersass|\bda\b/.test(x)) return 'assistente';
  return 'overig';
}
const WEEKDAG = (iso) => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7;   // 0 = maandag … 6 = zondag
const maandagVan = (iso) => plusDag(iso, -WEEKDAG(iso));
// Feestdagen van de CAO Huisartsenzorg (Nieuwjaar, 2e Paas- en Pinksterdag, Koningsdag, Hemelvaart, Kerst; Bevrijdingsdag eens per vijf jaar)
function feestdagen(jaar) {
  const a = jaar % 19, b = Math.floor(jaar / 100), c = jaar % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const maand = Math.floor((h + l - 7 * m + 114) / 31), dag = ((h + l - 7 * m + 114) % 31) + 1;
  const pasen = jaar + '-' + String(maand).padStart(2, '0') + '-' + String(dag).padStart(2, '0');
  const koning = new Date(Date.UTC(jaar, 3, 27, 12)).getUTCDay() === 0 ? jaar + '-04-26' : jaar + '-04-27';
  const u = [jaar + '-01-01', plusDag(pasen, 1), koning, plusDag(pasen, 39), plusDag(pasen, 50), jaar + '-12-25', jaar + '-12-26'];
  if (jaar % 5 === 0) u.push(jaar + '-05-05');
  return u;
}
// Is een Nmbrs-rooster per weekdag een echt patroon? Niet als het leeg is, als week 1 en week 2 verschillen (welke week is welke weten we
// niet) of als de uren gewoon gelijk over ma–vr verdeeld zijn terwijl iemand minder dan vijf dagen werkt.
function nmbrsDagenEcht(r) {
  if (!r || !Array.isArray(r.dagen1)) return null;
  const a = r.dagen1, b = Array.isArray(r.dagen2) ? r.dagen2 : null;
  if (!a.some((n) => n > 0)) return null;
  if (b && b.some((n, i) => n !== a[i])) return null;   // review MOET 3: ook een ingevulde nulweek 2 = om de week
  const werk = a.slice(0, 5);
  if (werk.every((n) => n > 0 && n === werk[0]) && r.dagen_per_week != null && r.dagen_per_week < 4.5) return null;
  return a;
}
// wv3053: twee Nmbrs-roosters met dezelfde begindatum (17 keer gemeten, steeds met andere uren of dagen): het laatst aangemaakte geldt,
// niet de volgorde in de lijst. Zonder `aangemaakt` (handrooster) blijft de laatste in de lijst winnen.
const laatsteOp = (rijen, veld, d) => {
  let u = null;
  for (const r of rijen) if (r[veld] && r[veld] <= d && (!u || r[veld] > u[veld] || (r[veld] === u[veld] && String(r.aangemaakt || '') >= String(u.aangemaakt || '')))) u = r;
  return u;
};
// De werkdagen van één persoon bij één praktijk (pure functie; de 30 gevallen in test/pma-werkdag.test.js).
// i.dagen: Map dag → { n, kort, middel, lang, vk, vl, mi, poh, cent } (alleen declaraties die voor de werkdag tellen; nooit inschrijfgeld)
// i.gedekt: Set van dagen die door een export gedekt zijn; i.rollen [{ rol, van, tot }]; i.hand [{ ingang, uren[7] }];
// i.nmbrs { dienst [{ begin, eind }], rooster [{ begin, uren, dagen_per_week, dagen1, dagen2 }], contract [{ begin, eind, uren }] } of null;
// i.drempel (invaldag), i.feest Set, i.groep (verzamelnaam: geen rooster, dus nooit afwezig; wv3054). Uit: [{ dag, soort, uren, rol, bron, t }] met soort gewerkt | afwezig | invaldag | los | weekend | feestdag.
function werkdagenVan(i) {
  const dagen = i.dagen, rollen = i.rollen || [], hand = i.hand || [], nm = i.nmbrs || null, drempel = i.drempel || 5, feest = i.feest || new Set();
  const alle = [...dagen.keys()].sort();
  const gedekt = [...i.gedekt].sort();
  // wv3054: het declaratiepatroon zegt alleen iets tussen de eerste en de laatste dag met declaraties; daarbuiten (nog niet begonnen,
  // vertrokken, of het venster van 4 weken loopt door) is een lege patroondag geen afwezigheid. Een rooster (hand of Nmbrs per dag) blijft gelden.
  const metDecl = alle.filter((d) => dagen.get(d) && dagen.get(d).n > 0), declVan = metDecl[0] || null, declTot = metDecl[metDecl.length - 1] || null;
  if (!gedekt.length || (!alle.length && !rollen.length)) return [];
  let van = alle[0] || gedekt[0], tot = alle[alle.length - 1] || gedekt[gedekt.length - 1];
  if (rollen.length) {
    van = rollen.reduce((a, r) => (r.van < a ? r.van : a), rollen[0].van);
    tot = rollen.some((r) => !r.tot) ? gedekt[gedekt.length - 1] : rollen.reduce((a, r) => (r.tot > a ? r.tot : a), rollen[0].tot);
    if (alle.length && alle[0] < van) van = alle[0];
    if (alle.length && alle[alle.length - 1] > tot) tot = alle[alle.length - 1];
  }
  // patroon uit de declaraties: per week (maandag) de weekdagen met minstens één declaratie
  const weken = new Map();
  for (const [d, t] of dagen) { const wd = WEEKDAG(d); if (wd > 4 || !t.n) continue; const w = maandagVan(d); if (!weken.has(w)) weken.set(w, new Set()); weken.get(w).add(wd); }
  const patroonCache = new Map();
  const patroon = (w) => {   // weekdagen die in minstens de helft van de actieve weken in het venster (4 weken ervoor t/m 3 erna) een declaratie hadden
    if (patroonCache.has(w)) return patroonCache.get(w);
    const actief = [];
    for (let k = -4; k <= 3; k++) { const x = weken.get(plusDag(w, 7 * k)); if (x) actief.push(x); }
    let u = null;
    if (actief.length >= 2) { u = new Set(); for (let wd = 0; wd < 5; wd++) if (actief.filter((x) => x.has(wd)).length * 2 >= actief.length) u.add(wd); }
    patroonCache.set(w, u);
    return u;
  };
  const rolOp = (d) => { let u = null; for (const r of rollen) if (r.van <= d && (!r.tot || r.tot >= d) && (!u || r.van >= u.van)) u = r; return u ? u.rol : null; };
  const inDienst = (d) => !nm || !nm.dienst || !nm.dienst.length || nm.dienst.some((x) => x.begin <= d && (!x.eind || x.eind >= d));
  const gem = (u) => { const w = u.slice(0, 5).filter((n) => n > 0); return w.length ? Math.round(w.reduce((a, n) => a + n, 0) / w.length * 100) / 100 : null; };
  const uit = [];
  for (const d of gedekt) {
    if (d < van || d > tot) continue;
    const t = dagen.get(d) || null, n = t ? t.n : 0;
    const rol = rolOp(d), binnen = (!rollen.length || rol) && inDienst(d);
    if (!binnen && !n) continue;
    const wd = WEEKDAG(d), w = maandagVan(d);
    // rooster van die dag: handrooster (David) > Nmbrs per weekdag (als echt en gelijk aan het patroon) > Nmbrs uren per week met het declaratiepatroon > alleen het patroon
    let bron, uren = null, weekUren = null;
    const h = laatsteOp(hand, 'ingang', d);
    const nr = nm && nm.rooster ? laatsteOp(nm.rooster, 'begin', d) : null;
    const nd = nmbrsDagenEcht(nr);
    // wv3053: Nmbrs zet de uren vaak op andere weekdagen dan waarop iemand werkt (gemeten 15-11-2026: 5 van 11 medewerkers, 141 van 338
    // weken; 128 onterechte afwezige dagen). Heeft die week een declaratiepatroon met andere dagen, dan wint het patroon en gelden alleen
    // de Nmbrs-uren per week. Zonder (of met leeg) patroon blijven de Nmbrs-dagen gelden.
    const pw = nd && !h ? patroon(w) : null;
    const ndPast = nd && (!pw || !pw.size || [0, 1, 2, 3, 4].every((x) => (nd[x] > 0) === pw.has(x)));
    if (h) { bron = 'hand'; uren = h.uren; }
    else if (ndPast) { bron = 'nmbrs-dag'; uren = nd; }
    else {
      const nc = nm && nm.contract ? laatsteOp(nm.contract.filter((c) => !c.eind || c.eind >= d), 'begin', d) : null;
      weekUren = nr && nr.uren > 0 ? nr.uren : nc && nc.uren > 0 ? nc.uren : null;
      bron = weekUren != null ? 'nmbrs-week' : 'patroon';
    }
    let werk, daguren = null, invaluren = null;
    if (uren) { werk = uren[wd] > 0; daguren = werk ? uren[wd] : null; invaluren = gem(uren); }
    else {
      const p = patroon(w);
      werk = p ? p.has(wd) : null;
      // wv3111: de weekuren over minstens het aantal dagen per week uit Nmbrs (gemeten 15-11-2026: over alleen de declaratiedagen gaf 38 uur
      // over 3 dagen 12,7 uur per dag, en bij de POH-GGZ, wier POT-uren ook andere praktijken dekken, tot 36 uur per dag)
      const dpw = nr && nr.dagen_per_week > 0 ? nr.dagen_per_week : 0;
      if (weekUren != null && p && p.size) { invaluren = Math.round(weekUren / Math.max(p.size, dpw) * 100) / 100; if (werk) daguren = invaluren; }
    }
    let soort;
    if (wd > 4) { if (!n) continue; soort = 'weekend'; daguren = null; }
    else if (werk === true) {
      if (!n && (i.groep || (!uren && (!declVan || d < declVan || d > declTot)))) continue;   // wv3054: groep of buiten de declaratiespanne
      if (!n && GEEN_AFWEZIG_ROLLEN.has(rol)) continue;   // wv3136: bij de POH-GGZ nooit afwezig
      soort = n ? 'gewerkt' : feest.has(d) ? 'feestdag' : binnen ? (uren && ROOSTER_IS_WERK.has(rol) ? 'gewerkt' : 'afwezig') : null;   // wv3111
    }
    else if (werk === false) { if (!n) continue; soort = n >= drempel || (uren && ROOSTER_IS_WERK.has(rol)) ? 'invaldag' : 'los'; daguren = soort === 'invaldag' ? invaluren : null; }
    else { if (!n) continue; soort = 'gewerkt'; bron = bron === 'nmbrs-week' ? 'nmbrs-week-zonder-patroon' : 'zonder-patroon'; }
    if (!soort) continue;
    uit.push({ dag: d, soort, uren: soort === 'gewerkt' || soort === 'invaldag' ? daguren : null, rol, bron, t });
  }
  return uit;
}

function nuIso() { return new Date().toISOString(); }
const groepVan = (codes, code, type) => (type === 'O' ? 'niet-gedeclareerd' : (codes.get(code) || {}).groep || 'nog-in-te-delen');
// wv4213 (L27, David 25-11-2026 Ja): ISO-week van een dag ('2026-W14'; de week hoort bij het jaar van zijn donderdag) en de rolgroep voor de
// weekdagstrook: artsen altijd samen (David 15-11-2026), assistente, POH-S en POH-GGZ apart, de rest 'ander'; geen koppeling of geen rol op die dag = 'los'.
function isoWeek(iso) {
  const don = plusDag(iso, 3 - WEEKDAG(iso)), j = don.slice(0, 4);
  return j + '-W' + String(Math.floor(Math.round((Date.parse(don + 'T12:00:00Z') - Date.parse(j + '-01-01T12:00:00Z')) / 864e5) / 7) + 1).padStart(2, '0');
}
const ROLGROEP = (rol) => (!rol ? 'los' : ARTS_ROLLEN.includes(rol) ? 'arts' : rol === 'assistente' || rol === 'poh-s' || rol === 'poh-ggz' ? rol : 'ander');
// Eén regelgroep bij de tellers van een registreerder optellen (per maand en per week dezelfde indeling)
function regTel(x, codes, code, type, n) {
  const g = groepVan(codes, code, type), sub = (codes.get(code) || {}).subgroep;
  x.totaal += n;
  if (g === 'consult' && (sub === 'kort' || sub === 'middel' || sub === 'lang')) x[sub] += n;
  else if (g === 'visite' && (sub === 'kort' || sub === 'lang')) x['visite_' + sub] += n;
  else if (g === 'mi') x.mi += n; else if (g === 'poh-ggz') x.poh += n; else x.overig += n;
}
const regNul = () => ({ kort: 0, middel: 0, lang: 0, visite_kort: 0, visite_lang: 0, mi: 0, poh: 0, overig: 0, totaal: 0 });
const klein = (n) => (n > 0 && n < KLEIN ? '< 5' : n);
// Controleer ↔ Inlezen vergelijken zonder de fin-datahub-cijfers (die kunnen tussendoor ververst zijn)
const vergelijkbaar = (sv) => JSON.stringify(Object.assign({}, sv, { kwartalen: (sv.kwartalen || []).map((k) => ({ peildatum: k.peildatum, regels: k.regels, patienten: k.patienten, stand: k.stand })) }));
const pct1 = (a, b) => (b ? Math.round((a / b - 1) * 1000) / 10 : null);

function maak(o) {
  const map = o.map;
  const dbPad = path.join(map, 'pma.sqlite'), bronMap = path.join(map, 'bron'), wachtMap = path.join(map, 'wacht'), sleutelPad = path.join(map, 'sleutel');
  const finPatienten = typeof o.finPatienten === 'function' ? o.finPatienten : () => null;
  // wv3047: personeel uit Nmbrs (nmbrs-data.js 'pma': namen, functies, dienstverband, roosters; geen bedragen) en de dossiernamen uit de vault,
  // van server.js als gegeven: { peil, medewerkers: [...], dossiers: [{ pad, naam, entiteit }] } of null (dan alleen koppelen op naam)
  const personeelVan = typeof o.personeel === 'function' ? o.personeel : () => null;
  let sleutel = null;
  function mappen() {
    for (const m of [map, bronMap, wachtMap]) { if (!fs.existsSync(m)) fs.mkdirSync(m, { recursive: true, mode: 0o700 }); try { fs.chmodSync(m, 0o700); } catch (e) { /* niet van ons */ } }
  }
  function hmac() {
    if (sleutel) return sleutel;
    mappen();
    if (!fs.existsSync(sleutelPad)) {
      const tmp = sleutelPad + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
      try { fs.linkSync(tmp, sleutelPad); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      fs.unlinkSync(tmp);
    }
    const t = fs.readFileSync(sleutelPad, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(t)) throw new Fout(503, 'de sleutel van OVIS PMA is onleesbaar; vraag de machinekamer');
    sleutel = Buffer.from(t, 'hex');
    return sleutel;
  }
  function pseudo(praktijk, nummer) { return crypto.createHmac('sha256', hmac()).update(praktijk + ':' + nummer).digest('hex').slice(0, 16); }

  let bijgewerkt = false;   // wv3045: een databank van schema 1 eerst bijwerken, ook als de eerste opening alleen leest (GET na de uitrol)
  function open(alleenLezen) {
    const { DatabaseSync } = require('node:sqlite');
    mappen();
    const nieuw = !fs.existsSync(dbPad);
    if (alleenLezen && nieuw) return null;
    if (alleenLezen && !bijgewerkt) open(false).close();
    const db = new DatabaseSync(dbPad, alleenLezen ? { readOnly: true } : {});
    if (!alleenLezen) {
      if (nieuw) { try { fs.chmodSync(dbPad, 0o600); } catch (e) { /* bestaat al */ } }
      db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;');
      db.exec(SCHEMA);
      if (!db.prepare('PRAGMA table_info(export)').all().some((k) => k.name === 'met_patient')) {
        db.exec('ALTER TABLE export ADD COLUMN met_patient INTEGER NOT NULL DEFAULT 1 CHECK (met_patient IN (0,1))');   // alle exports van schema 1 hadden het nummer
      }
      if (!db.prepare('PRAGMA table_info(registreerder)').all().some((k) => k.name === 'bevestigd')) {
        db.exec('ALTER TABLE registreerder ADD COLUMN bevestigd TEXT');   // wv3047: wanneer David de koppeling naam → persoon bevestigde (leeg = nog te koppelen)
      }
      if (!db.prepare('PRAGMA table_info(registreerder)').all().some((k) => k.name === 'negeer')) {
        db.exec('ALTER TABLE registreerder ADD COLUMN negeer TEXT');   // wv3111: wanneer David zei "deze naam negeren" (niet koppelen, niet meetellen bij personen, niet meer tonen bij te koppelen)
      }
      db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('schema', ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde WHERE CAST(waarde AS INTEGER) < CAST(excluded.waarde AS INTEGER)").run(String(SCHEMA_VERSIE));
      bijgewerkt = true;
      const p = db.prepare('INSERT INTO praktijk (code, naam, agb) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING');
      for (const [agb, x] of Object.entries(PRAKTIJKEN)) p.run(x.code, x.naam, agb);
      const c = db.prepare("INSERT INTO code (code, van_jaar, tot_jaar, naam, groep, subgroep, ritme, telt_patient, telt_werkdag, bron) VALUES (?, 2000, NULL, ?, ?, ?, ?, ?, ?, 'start') ON CONFLICT(code, van_jaar) DO NOTHING");
      for (const [code, naam, groep, sub, ritme, tp] of CODES_START) c.run(code, naam, groep, sub, ritme, tp, groep === 'inschrijving' || groep === 'module' ? 0 : 1);
      const s = db.prepare("INSERT INTO instelling (praktijk, sleutel, waarde) VALUES ('*', ?, ?) ON CONFLICT DO NOTHING");
      s.run('klein_aantal', '30'); s.run('fin_afwijking_pct', '1'); s.run('invaldag_min', '5');   // wv3047: zoveel declaraties op een niet-roosterdag = invaldag
    }
    return db;
  }
  function metDb(f, schrijf) {
    const db = open(!schrijf);
    if (!db) return f(null);
    try {
      if (!schrijf) return f(db);
      db.exec('BEGIN IMMEDIATE');
      try { const u = f(db); db.exec('COMMIT'); return u; } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* al weg */ } throw e; }
    } finally { db.close(); }
  }
  function codeKaart(db) {
    const m = new Map();
    if (!db) { for (const [code, naam, groep, sub, ritme, tp] of CODES_START) m.set(code, { naam, groep, subgroep: sub, ritme, telt_patient: tp }); return m; }
    for (const r of db.prepare('SELECT code, naam, groep, subgroep, ritme, telt_patient FROM code ORDER BY van_jaar').all()) m.set(r.code, r);
    return m;
  }

  // ── plan: wat zou deze export doen (zonder schrijven); ook de basis van Inlezen ──
  function plan(db, ex, nieuwId) {
    const codes = codeKaart(db);
    const eigen = db ? db.prepare('SELECT id, exportdatum, met_patient FROM export WHERE stand = ?').all('actief') : [];
    const datumVan = new Map(eigen.map((e) => [e.id, e.exportdatum]));
    const vormVan = new Map(eigen.map((e) => [e.id, !!e.met_patient]));
    const wint = (eid) => { const d = datumVan.get(eid); return d === undefined || d <= ex.exportdatum || eid === nieuwId; };   // gelijke datum: de laatst ingelezen wint
    // verrichtingen per dag
    const nieuwPerDag = new Map();
    for (const r of ex.regels) { if (!nieuwPerDag.has(r.dag)) nieuwPerDag.set(r.dag, []); nieuwPerDag.get(r.dag).push(r); }
    const oudPerDag = new Map(), bronDag = new Map();
    if (db) {
      for (const r of db.prepare('SELECT dag, sleutel, factuurdatum, patient, code, omschrijving, type, reg_agb, registreerder, tarief_cent FROM regel WHERE praktijk = ? AND dag BETWEEN ? AND ?').iterate(ex.praktijk, ex.begin, ex.eind)) {
        if (!oudPerDag.has(r.dag)) oudPerDag.set(r.dag, new Map()); oudPerDag.get(r.dag).set(r.sleutel, r);
      }
      for (const r of db.prepare('SELECT dag, export_id FROM dagbron WHERE praktijk = ? AND dag BETWEEN ? AND ?').iterate(ex.praktijk, ex.begin, ex.eind)) bronDag.set(r.dag, r.export_id);
    }
    const d = { nieuw: 0, gelijk: 0, wijzigt: 0, ouder: 0, andere_vorm: 0 }, rg = { erbij: 0, eraf: 0, factuur: 0 };
    const winDagen = [], wijzigDagen = [];
    // wv3045: inhoud zonder patiënt (voor dagen waar de opgeslagen export de andere vorm had: met ↔ zonder patiëntnummer)
    const inh = (r) => [r.code || '', r.omschrijving, r.type, r.reg_agb || '', r.registreerder, r.tarief_cent].join('\u0001');
    const telOp = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    const overschot = (a, b) => { let n = 0; for (const [k, x] of a) n += Math.max(0, x - (b.get(k) || 0)); return n; };
    for (const dag of dagenTussen(ex.begin, ex.eind)) {
      const eid = bronDag.get(dag);
      const nu = nieuwPerDag.get(dag) || [], oud = oudPerDag.get(dag) || new Map();
      if (eid === undefined) { d.nieuw++; winDagen.push(dag); rg.erbij += nu.length; if (oud.size) { rg.eraf += oud.size; } continue; }
      if (!wint(eid)) { d.ouder++; continue; }
      winDagen.push(dag);
      let erbij = 0, factuur = 0, eraf = 0;
      // review Codex MOET 1: altijd als multiset (een volgnummer hangt bij gelijke inhoud af van de volgorde, de factuurdatum niet); in dezelfde vorm
      // telt de patiënt mee, bij de andere vorm (met ↔ zonder nummer) niet: daar verschillen de sleutels altijd
      const zelfde = vormVan.get(eid) === ex.met_patient;
      if (!zelfde) d.andere_vorm++;
      const k = (r) => (zelfde ? r.patient + '\u0001' : '') + inh(r);
      const a = new Map(), b = new Map(), af = new Map(), bf = new Map();
      for (const r of nu) { telOp(a, k(r)); telOp(af, k(r) + '\u0001' + (r.factuurdatum || '')); }
      for (const r of oud.values()) { telOp(b, k(r)); telOp(bf, k(r) + '\u0001' + (r.factuurdatum || '')); }
      erbij = overschot(a, b); eraf = overschot(b, a); factuur = overschot(af, bf) - erbij;
      if (erbij || eraf || factuur) { d.wijzigt++; wijzigDagen.push(dag); rg.erbij += erbij; rg.eraf += eraf; rg.factuur += factuur; } else d.gelijk++;
    }
    // inschrijfgeld per kwartaaldatum
    const nieuwPerQ = new Map();
    for (const r of ex.inschrijf) { if (!nieuwPerQ.has(r.peildatum)) nieuwPerQ.set(r.peildatum, []); nieuwPerQ.get(r.peildatum).push(r); }
    const kwartalen = [], winQ = [];
    const fin = finPatienten() || {};
    for (const q of dagenTussen(ex.begin, ex.eind).filter(isKwartaalStart)) {
      const nu = nieuwPerQ.get(q) || [];
      const basisR = nu.filter((r) => (codes.get(r.code) || {}).telt_patient);
      // wv3045: zonder patiëntnummer = het aantal basisregels (in de echte exports ± 0,03 % meer dan unieke patiënten)
      const pat = ex.met_patient ? new Set(basisR.map((r) => r.patient)).size : basisR.length;
      const k = { peildatum: q, regels: nu.length, patienten: klein(pat), stand: 'leeg' };
      if (!ex.met_patient) k.zonder_patientnummer = true;
      const finJaar = fin[ex.praktijk] && fin[ex.praktijk][q.slice(0, 4)];
      if (finJaar && pat) { k.fin = Math.round(finJaar * 100) / 100; k.fin_afwijking_pct = pct1(pat, finJaar); k.fin_melding = Math.abs(pat / finJaar - 1) > 0.01; }
      const eid = db ? (db.prepare('SELECT export_id FROM kwartaalbron WHERE praktijk = ? AND peildatum = ?').get(ex.praktijk, q) || {}).export_id : undefined;
      if (eid !== undefined && !wint(eid)) k.stand = 'ouder dan wat er staat';
      else if (!nu.length) {   // review MOET 1: de export dekt de dag maar heeft geen inschrijfgeld → die dag is leeg (oude regels vervallen)
        const oud = db && eid !== undefined ? db.prepare('SELECT COUNT(*) AS n FROM inschrijf WHERE praktijk = ? AND peildatum = ?').get(ex.praktijk, q).n : 0;
        k.stand = oud ? 'vervalt' : 'geen inschrijfgeld in deze export'; k.vervalt = oud; winQ.push(q);
      }
      else if (eid === undefined) { k.stand = 'nieuw'; winQ.push(q); }
      else {
        // wv3045: als multiset zonder volgnummer (zonder patiëntnummer hangt het volgnummer af van de volgorde in het bestand)
        const sleutelI = (r) => [r.patient, r.code, r.tarief_cent, r.registreerder].join('|');
        const oudS = db.prepare('SELECT patient, code, tarief_cent, registreerder FROM inschrijf WHERE praktijk = ? AND peildatum = ?').all(ex.praktijk, q).map(sleutelI).sort();
        const nieuwS = nu.map(sleutelI).sort();
        const gelijk = oudS.length === nieuwS.length && nieuwS.every((x, i) => x === oudS[i]);
        k.stand = gelijk ? 'gelijk' : 'vervangen'; winQ.push(q);
      }
      kwartalen.push(k);
    }
    // nog in te delen codes in deze export (alleen code + aantal)
    const onbekend = new Map();
    for (const r of ex.regels) if (r.type === 'V' && !codes.has(r.code)) onbekend.set(r.code, (onbekend.get(r.code) || 0) + 1);
    for (const r of ex.inschrijf) if (!codes.has(r.code)) onbekend.set(r.code, (onbekend.get(r.code) || 0) + 1);
    const samenvatting = {
      praktijk: ex.praktijk, praktijk_naam: ex.praktijk_naam, exportdatum: ex.exportdatum, begin: ex.begin, eind: ex.eind, met_patientnummer: ex.met_patient,
      regels: { inschrijf: ex.inschrijf.length, verrichting: ex.regels.filter((r) => r.type === 'V').length, overig: ex.regels.filter((r) => r.type === 'O').length,
        voorlopig: ex.voorlopig, gelijke_regels: ex.gelijk },
      dagen: d, regelverschil: rg, kwartalen,
      nog_in_te_delen: [...onbekend.entries()].sort().map(([code, n]) => ({ code, n })),
    };
    return { samenvatting, winDagen, winQ, nieuwPerDag, nieuwPerQ };
  }

  function schrijfExport(db, ex, exportId, p) {
    const delR = db.prepare('DELETE FROM regel WHERE praktijk = ? AND dag = ?');
    const insR = db.prepare('INSERT INTO regel (sleutel, praktijk, dag, patient, code, omschrijving, type, reg_agb, registreerder, tarief_cent, factuurdatum, volgnr, voorlopig, export_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const zetDag = db.prepare('INSERT INTO dagbron (praktijk, dag, export_id) VALUES (?, ?, ?) ON CONFLICT(praktijk, dag) DO UPDATE SET export_id = excluded.export_id');
    const reg = db.prepare('INSERT INTO registreerder (praktijk, naam, persoon, soort, eerst) VALUES (?, ?, NULL, ?, ?) ON CONFLICT(praktijk, naam) DO NOTHING');
    const namen = new Set();
    let verwachtR = 0;
    for (const dag of p.winDagen) {
      delR.run(ex.praktijk, dag);
      for (const r of p.nieuwPerDag.get(dag) || []) {
        insR.run(r.sleutel, ex.praktijk, dag, r.patient, r.code, r.omschrijving, r.type, r.reg_agb, r.registreerder, r.tarief_cent, r.factuurdatum, r.volgnr, r.voorlopig, exportId);
        namen.add(r.registreerder); verwachtR++;
      }
      zetDag.run(ex.praktijk, dag, exportId);
    }
    const delI = db.prepare('DELETE FROM inschrijf WHERE praktijk = ? AND peildatum = ?');
    const insI = db.prepare('INSERT INTO inschrijf (praktijk, peildatum, patient, code, tarief_cent, registreerder, volgnr, export_id) VALUES (?,?,?,?,?,?,?,?)');
    const zetQ = db.prepare('INSERT INTO kwartaalbron (praktijk, peildatum, export_id) VALUES (?, ?, ?) ON CONFLICT(praktijk, peildatum) DO UPDATE SET export_id = excluded.export_id');
    const nieuwCode = db.prepare("INSERT INTO code (code, van_jaar, tot_jaar, naam, groep, subgroep, ritme, telt_patient, telt_werkdag, bron) VALUES (?, 2000, NULL, ?, 'nog-in-te-delen', NULL, NULL, 0, 1, 'gezien') ON CONFLICT(code, van_jaar) DO NOTHING");
    let verwachtI = 0;
    for (const q of p.winQ) {
      delI.run(ex.praktijk, q);
      for (const r of p.nieuwPerQ.get(q) || []) { insI.run(ex.praktijk, q, r.patient, r.code, r.tarief_cent, r.registreerder, r.volgnr, exportId); verwachtI++; }
      zetQ.run(ex.praktijk, q, exportId);
    }
    for (const r of ex.regels) if (r.type === 'V') nieuwCode.run(r.code, String(r.omschrijving).slice(0, 120));
    for (const r of ex.inschrijf) nieuwCode.run(r.code, String(r.naam).slice(0, 120));
    for (const n of namen) reg.run(ex.praktijk, n, VERZAMEL_RE.test(n) ? 'verzamel' : 'persoon', ex.exportdatum);
    // nacontrole in dezelfde transactie: telt de databank op tot wat de export zei?
    const nR = db.prepare('SELECT COUNT(*) AS n FROM regel WHERE export_id = ?').get(exportId).n;
    const nI = db.prepare('SELECT COUNT(*) AS n FROM inschrijf WHERE export_id = ?').get(exportId).n;
    if (nR !== verwachtR || nI !== verwachtI) throw new Fout(409, 'na het inlezen klopten de aantallen niet met de export; er is niets veranderd');
  }

  function wachtOpruimen() {
    try {
      for (const f of fs.readdirSync(wachtMap)) {
        const p = path.join(wachtMap, f);
        try { if (Date.now() - fs.statSync(p).mtimeMs > WACHT_MS) fs.unlinkSync(p); } catch (e) { /* weg */ }
      }
    } catch (e) { /* geen map */ }
  }
  function zipUit(b) {
    const t = typeof b.zip === 'string' ? b.zip.replace(/\s+/g, '') : '';
    if (!t || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new Fout(400, 'kies een ZIP-bestand uit Promedico');
    const buf = Buffer.from(t, 'base64');
    if (buf.length > ZIP_MAX) throw new Fout(413, 'de ZIP is te groot (hooguit 8 MB); exporteer per kalenderjaar');
    return buf;
  }
  const naamUit = (b) => String(b.naam || 'export.zip').replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 120) || 'export.zip';

  // wv4212: kern van Controleer, ook voor een ZIP die David in het gesprek aan Socev gaf (via 'chat'); wacht/<sha>.json weet waar hij vandaan kwam
  function controleerBuf(buf, naam, via) {
    mappen(); wachtOpruimen();
    const s = sha(buf);
    const al = metDb((db) => (db ? db.prepare('SELECT id, op, naam, stand FROM export WHERE sha256 = ?').get(s) : null), false);
    if (al && al.stand === 'actief') return { body: { ok: true, al: { op: al.op, naam: al.naam }, sha: s }, reden: 'pma controleer al' };
    const ex = leesExport(buf, pseudo);
    const p = metDb((db) => plan(db, ex, null), false);
    const tmp = path.join(wachtMap, s + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, path.join(wachtMap, s + '.zip'));
    const jtmp = path.join(wachtMap, s + '.' + crypto.randomBytes(4).toString('hex') + '.jtmp');
    fs.writeFileSync(jtmp, JSON.stringify({ naam, samenvatting: p.samenvatting, terug: al ? al.id : null, via: via === 'chat' ? 'chat' : 'app', op: nuIso() }), { mode: 0o600 });
    fs.renameSync(jtmp, path.join(wachtMap, s + '.json'));
    return { body: { ok: true, sha: s, naam, eerder_ingetrokken: !!al, samenvatting: p.samenvatting }, reden: 'pma controleer' };
  }
  function controleer(b) { return controleerBuf(zipUit(b), naamUit(b), 'app'); }

  // wv4212 (L26): een ZIP uit het gesprek met Socev. Geen export_info.csv erin = geen PMA-export (soort 'geen', niets gedaan). Anders
  // dezelfde Controle als op het Inlezen-scherm; de uitkomst bevat alleen de praktijk, de periode en aantallen (nooit een patiënt of een
  // registreerder): server.js zet die in de prompt van Socev met een link naar PMA › Inlezen. Inlezen blijft Davids tik daar.
  function chatControleer(buf, naam) {
    if (!Buffer.isBuffer(buf)) return { soort: 'geen' };
    if (buf.length > ZIP_MAX) return { soort: 'fout', fout: 'de ZIP is te groot (hooguit 8 MB); exporteer per kalenderjaar' };
    let namen;
    try { namen = leesZip(buf).map((b) => b.naam); } catch (e) { return { soort: 'geen' }; }   // geen (leesbare) ZIP: niet van PMA
    if (!namen.some((n) => n === 'export_info.csv' || /(^|\/)export_info\.csv$/i.test(n))) return { soort: 'geen' };
    let u;
    try { u = controleerBuf(buf, String(naam || 'export.zip').replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 120) || 'export.zip', 'chat'); }
    catch (e) { if (e instanceof Fout) return { soort: 'fout', fout: e.message }; throw e; }
    if (u.body.al) return { soort: 'pma', al: true, op: u.body.al.op };
    const s = u.body.samenvatting || {};
    return { soort: 'pma', al: false, praktijk: s.praktijk_naam || s.praktijk || '', begin: s.begin || null, eind: s.eind || null, exportdatum: s.exportdatum || null,
      verrichtingen: (s.regels && s.regels.verrichting) || 0, dagen: s.dagen ? { nieuw: s.dagen.nieuw || 0, gelijk: s.dagen.gelijk || 0, wijzigt: s.dagen.wijzigt || 0, ouder: s.dagen.ouder || 0 } : null,
      eerder_ingetrokken: !!u.body.eerder_ingetrokken, nog_in_te_delen: Array.isArray(s.nog_in_te_delen) ? s.nog_in_te_delen.length : 0 };
  }
  // wv4212: wat via het gesprek gecontroleerd is en nog op Davids tik wacht (hooguit 5, nieuwste eerst; ouder dan WACHT_MS telt niet)
  function wachtLijst() {
    const uit = [];
    let namen = [];
    try { namen = fs.readdirSync(wachtMap).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)); } catch (e) { return uit; }
    for (const f of namen) {
      const s = f.slice(0, 64), jp = path.join(wachtMap, f), zp = path.join(wachtMap, s + '.zip');
      try {
        const st = fs.statSync(jp);
        if (Date.now() - st.mtimeMs > WACHT_MS || !fs.existsSync(zp)) continue;
        const w = JSON.parse(fs.readFileSync(jp, 'utf8'));
        if (w.via !== 'chat' || !w.samenvatting) continue;
        uit.push({ sha: s, naam: String(w.naam || ''), op: w.op || new Date(st.mtimeMs).toISOString(), eerder_ingetrokken: !!w.terug, samenvatting: w.samenvatting });
      } catch (e) { /* half geschreven of weg: overslaan */ }
    }
    return uit.sort((a, b) => (a.op < b.op ? 1 : -1)).slice(0, 5);
  }
  // wv4212: per praktijk per jaar (2024 t/m dit jaar) hoeveel dagen een export dekt; lopend jaar t/m gisteren. Alleen tellingen.
  const ONTBREEKT_VAN = 2024;
  function ontbreektIn(db) {
    const vandaag = nuIso().slice(0, 10), gisteren = plusDag(vandaag, -1), dit = Number(vandaag.slice(0, 4));
    const uit = [];
    for (const p of db.prepare('SELECT code, naam FROM praktijk ORDER BY code DESC').all()) {
      for (let j = ONTBREEKT_VAN; j <= dit; j++) {
        const a = j + '-01-01', b = j === dit ? gisteren : j + '-12-31';
        if (b < a) continue;
        const r = db.prepare('SELECT COUNT(*) AS n, MAX(dag) AS tot FROM dagbron WHERE praktijk = ? AND dag BETWEEN ? AND ?').get(p.code, a, b);
        const dagen = dagenTussen(a, b).length;
        uit.push({ praktijk: p.code, naam: p.naam, jaar: j, gedekt: r.n, dagen, tot: r.tot || null, lopend: j === dit });
      }
    }
    return uit;
  }

  function inlees(b) {
    const s = String(b.sha || '');
    if (!/^[0-9a-f]{64}$/.test(s)) throw new Fout(400, 'controleer eerst een ZIP');
    const zp = path.join(wachtMap, s + '.zip'), jp = path.join(wachtMap, s + '.json');
    if (!fs.existsSync(zp) || !fs.existsSync(jp)) throw new Fout(409, 'deze controle is verlopen; kies de ZIP opnieuw en controleer');
    const buf = fs.readFileSync(zp);
    if (sha(buf) !== s) throw new Fout(409, 'het bestand is veranderd sinds Controleer; controleer opnieuw');
    const w = JSON.parse(fs.readFileSync(jp, 'utf8'));
    const ex = leesExport(buf, pseudo);
    // review MOET 2: eerst de bron-ZIP veilig wegschrijven (tijdelijk bestand, fsync, hernoemen, controle), pas daarna de databank
    const doel = path.join(bronMap, s + '.zip');
    let bronNieuw = false;
    if (!fs.existsSync(doel) || sha(fs.readFileSync(doel)) !== s) {
      const tmp = doel + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, doel); bronNieuw = true;
      if (sha(fs.readFileSync(doel)) !== s) throw new Fout(503, 'de ZIP kon niet goed bewaard worden; er is niets ingelezen');
    }
    let u;
    try {
      u = metDb((db) => {
        const al = db.prepare('SELECT id, stand FROM export WHERE sha256 = ?').get(s);
        if (al && al.stand === 'actief') return { al: true };
        const p = plan(db, ex, null);   // review MOET 4: ook terugzetten alleen als de stand nog is wat Controleer liet zien
        if (vergelijkbaar(p.samenvatting) !== vergelijkbaar(w.samenvatting)) throw new Fout(409, 'de stand is veranderd sinds Controleer; controleer opnieuw');
        if (al) {   // eerder ingetrokken → terugzetten en de praktijk opnieuw opbouwen
          db.prepare("UPDATE export SET stand = 'actief' WHERE id = ?").run(al.id);
          herbouwIn(db, ex.praktijk);
          return { id: al.id, terug: true };
        }
      const r = db.prepare("INSERT INTO export (praktijk, sha256, naam, exportdatum, begin, eind, gegevensset, op, n_inschrijf, n_regel, n_voorlopig, n_gelijk, stand, samenvatting, met_patient) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'actief',?,?)")
        .run(ex.praktijk, s, w.naam, ex.exportdatum, ex.begin, ex.eind, ex.gegevensset, nuIso(), ex.inschrijf.length, ex.regels.length, ex.voorlopig, ex.gelijk, JSON.stringify(p.samenvatting), ex.met_patient ? 1 : 0);
        const id = Number(r.lastInsertRowid);
        schrijfExport(db, ex, id, plan(db, ex, id));
        return { id };
      }, true);
    } catch (e) {
      if (bronNieuw) { try { if (!metDb((db) => (db ? db.prepare('SELECT 1 AS x FROM export WHERE sha256 = ?').get(s) : null), false)) fs.unlinkSync(doel); } catch (e2) { /* blijft als wees; onschadelijk */ } }
      throw e;
    }
    if (u.al) { try { fs.unlinkSync(zp); fs.unlinkSync(jp); } catch (e) { /* weg */ } return { body: { ok: true, al: true }, reden: 'pma inlees al' }; }
    try { fs.unlinkSync(zp); fs.unlinkSync(jp); } catch (e) { /* weg */ }
    return { body: { ok: true, id: u.id, terug: !!u.terug }, reden: u.terug ? 'pma inlees terug' : 'pma inlees' };
  }

  // Opnieuw opbouwen uit bron/ (intrekken, terugzetten, of DM7-herbouw): alles van de praktijk weg, actieve exports oplopend op datum.
  function herbouwIn(db, praktijk) {
    for (const t of ['regel', 'dagbron', 'inschrijf', 'kwartaalbron']) db.prepare('DELETE FROM ' + t + ' WHERE praktijk = ?').run(praktijk);
    const ex = db.prepare("SELECT id, sha256 FROM export WHERE praktijk = ? AND stand = 'actief' ORDER BY exportdatum, id").all(praktijk);
    for (const e of ex) {
      const zp = path.join(bronMap, e.sha256 + '.zip');
      if (!fs.existsSync(zp)) throw new Fout(409, 'een eerder ingelezen ZIP ontbreekt in de bron; opnieuw opbouwen kan niet');
      const buf = fs.readFileSync(zp);
      if (sha(buf) !== e.sha256) throw new Fout(409, 'een ZIP in de bron is veranderd; opnieuw opbouwen kan niet');
      const x = leesExport(buf, pseudo);
      if (x.praktijk !== praktijk) throw new Fout(409, 'een ZIP in de bron hoort bij een andere praktijk');
      schrijfExport(db, x, e.id, plan(db, x, e.id));
    }
    return ex.length;
  }
  function intrek(b) {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 1) throw new Fout(400, 'welke export?');
    return metDb((db) => {
      const e = db.prepare('SELECT praktijk, stand FROM export WHERE id = ?').get(id);
      if (!e) throw new Fout(404, 'deze export bestaat niet');
      if (e.stand === 'ingetrokken') return { body: { ok: true, al: true }, reden: 'pma intrek al' };
      db.prepare("UPDATE export SET stand = 'ingetrokken' WHERE id = ?").run(id);
      herbouwIn(db, e.praktijk);
      return { body: { ok: true }, reden: 'pma intrek' };
    }, true);
  }
  function zetCode(b) {
    const code = String(b.code || ''), groep = String(b.groep || '');
    if (!/^\d{5}$/.test(code)) throw new Fout(400, 'code als vijf cijfers');
    if (!GROEPEN.includes(groep) || groep === 'inschrijving' || groep === 'niet-gedeclareerd') throw new Fout(400, 'kies een groep');
    const sub = b.subgroep == null ? null : String(b.subgroep).trim().slice(0, 40) || null;
    return metDb((db) => {
      const r = db.prepare('SELECT naam FROM code WHERE code = ? ORDER BY van_jaar LIMIT 1').get(code);
      if (!r) throw new Fout(404, 'deze code is nog niet gezien');
      db.prepare("UPDATE code SET groep = ?, subgroep = ?, ritme = CASE WHEN ? = 'module' THEN COALESCE(ritme, 'kwartaal') ELSE NULL END, telt_werkdag = CASE WHEN ? = 'module' THEN 0 ELSE 1 END, bron = 'david' WHERE code = ?")
        .run(groep, sub, groep, groep, code);
      return { body: { ok: true }, reden: 'pma code' };
    }, true);
  }

  // ── Overzicht: alleen aantallen per kwartaal / maand / registreerder ──
  // wv4148 (2C50): wat opvalt in de declaraties van één praktijk, over alle ingelezen dagen.
  // - voorlopig_oud: type V zonder factuurdatum terwijl de boekingsdatum op de exportdatum van zijn eigen export al meer dan twee
  //   kalendermaanden oud was (die export is de stand van de dag; een latere export ververst hem). Een jongere regel is gewoon nog in de maand.
  // - nultarief: type V (om te declareren) met tarief € 0. Type O (niet declareren) telt niet.
  // - meer_tarieven: een code met in één kalenderjaar meer dan één tarief boven € 0 (€ 0 staat al onder nultarief).
  // - te_koppelen: Promedico-namen met regels die nog niet bevestigd of genegeerd zijn (zelfde regel als Koppelen in de app).
  function valtOp(db, codes, praktijk) {
    const naam = (code, oms) => (codes.get(code) || {}).naam || oms || code || '';
    const oud = db.prepare("SELECT substr(r.dag, 1, 7) AS maand, r.code, MIN(r.omschrijving) AS oms, COUNT(*) AS n FROM regel r JOIN export e ON e.id = r.export_id " +
      "WHERE r.praktijk = ? AND r.voorlopig = 1 AND r.dag < MIN(date(e.exportdatum, '-2 months'), date(e.exportdatum, 'start of month', '-1 month', '-1 day')) " +   // review ZOU 1: 30-4 → 28-2, niet 2-3
      "GROUP BY maand, r.code ORDER BY maand, r.code").all(praktijk)
      .map((r) => ({ maand: r.maand, code: r.code, naam: naam(r.code, r.oms), n: r.n }));
    const nul = db.prepare("SELECT code, MIN(omschrijving) AS oms, COUNT(*) AS n, SUM(voorlopig) AS v FROM regel WHERE praktijk = ? AND type = 'V' AND tarief_cent = 0 GROUP BY code ORDER BY n DESC, code").all(praktijk)
      .map((r) => ({ code: r.code, naam: naam(r.code, r.oms), n: r.n, voorlopig: r.v }));
    const meer = db.prepare("SELECT substr(dag, 1, 4) AS jaar, code, MIN(omschrijving) AS oms, GROUP_CONCAT(DISTINCT tarief_cent) AS t FROM regel WHERE praktijk = ? AND type = 'V' AND tarief_cent > 0 " +
      "GROUP BY jaar, code HAVING COUNT(DISTINCT tarief_cent) > 1 ORDER BY jaar DESC, code").all(praktijk)
      .map((r) => ({ jaar: r.jaar, code: r.code, naam: naam(r.code, r.oms), tarieven: String(r.t).split(',').map(Number).sort((a, b) => a - b) }));
    const st = namenStand(db);
    const koppel = db.prepare('SELECT naam, bevestigd, negeer FROM registreerder WHERE praktijk = ?').all(praktijk)
      .filter((r) => !r.bevestigd && !r.negeer && ((st.get(praktijk + '\u0001' + r.naam) || {}).n || 0) > 0).length;
    return { voorlopig_oud: { n: oud.reduce((a, r) => a + r.n, 0), per: oud }, nultarief: { n: nul.reduce((a, r) => a + r.n, 0), per: nul }, meer_tarieven: meer, te_koppelen: koppel };
  }

  // wv4213 (L27, David 25-11-2026 Ja): PMA per week en het patroon per weekdag. Zet p.weken (zelfde vorm als een maand, sleutel week =
  // ISO-week, van = maandag; per registreerder bewust niet: per week vooral te kleine aantallen en 100 kB extra), en bij elke maand én week: wd[rolgroep] = verrichtingen ma–vr, wd_open = gedekte
  // werkdagen zonder feestdag per weekdag (de deler voor 'gemiddeld per dag'), weekend = verrichtingen op za/zo. Verrichtingen = alles
  // behalve niet-gedeclareerd, zoals het maandtotaal. Een week over een maandgrens telt in beide maanden alleen zijn eigen dagen; de week
  // zelf heeft alle zeven. Alleen aantallen per week, weekdag en rolgroep; nooit per patiënt.
  function weekEnDag(db, codes, p, mnd, gedekt) {
    const naarP = new Map(db.prepare('SELECT naam, persoon FROM registreerder WHERE praktijk = ? AND bevestigd IS NOT NULL AND persoon IS NOT NULL AND negeer IS NULL').all(p.code).map((r) => [r.naam, r.persoon]));
    const rollenVan = new Map();
    for (const r of db.prepare('SELECT persoon, rol, van, tot FROM rol_periode WHERE praktijk = ? ORDER BY van, id').all(p.code)) { if (!rollenVan.has(r.persoon)) rollenVan.set(r.persoon, []); rollenVan.get(r.persoon).push(r); }
    const groepCache = new Map();
    const groepOp = (naam, dag) => {
      const k = naam + '\u0001' + dag; if (groepCache.has(k)) return groepCache.get(k);
      const pid = naarP.get(naam); let rol = null;
      for (const r of (pid != null && rollenVan.get(pid)) || []) if (r.van <= dag && (!r.tot || r.tot >= dag)) rol = r.rol;
      const g = ROLGROEP(rol); groepCache.set(k, g); return g;
    };
    const feest = new Set();
    for (const j of new Set([...gedekt].map((d) => Number(d.slice(0, 4))))) for (const f of feestdagen(j)) feest.add(f);
    const metWd = (x) => { if (!x.wd) { x.wd = {}; x.wd_open = [0, 0, 0, 0, 0]; x.weekend = 0; } return x; };
    const weken = new Map();
    const wk = (d) => { const k = isoWeek(d); if (!weken.has(k)) weken.set(k, metWd({ week: k, van: maandagVan(d), groepen: {}, sub: {}, subc: {}, voorlopig: 0, dagen: 7, dagen_gedekt: 0, kalender: '' })); return weken.get(k); };
    for (const r of db.prepare('SELECT dag, registreerder AS naam, code, type, COUNT(*) AS n, SUM(tarief_cent) AS c, SUM(voorlopig) AS v FROM regel WHERE praktijk = ? GROUP BY dag, naam, code, type').iterate(p.code)) {
      const x = wk(r.dag), g = groepVan(codes, r.code, r.type);
      const gg = x.groepen[g] || (x.groepen[g] = { n: 0, cent: 0 }); gg.n += r.n; gg.cent += r.c;
      const sub = r.type === 'O' ? null : (codes.get(r.code) || {}).subgroep;
      if (sub && (g === 'consult' || g === 'visite' || g === 'mi' || g === 'poh-ggz')) { const sk = g + ':' + sub; x.sub[sk] = (x.sub[sk] || 0) + r.n; x.subc[sk] = (x.subc[sk] || 0) + r.c; }
      x.voorlopig += r.v;
      if (g === 'niet-gedeclareerd') continue;
      const wd = WEEKDAG(r.dag);
      for (const t of [x, metWd(mnd(r.dag.slice(0, 7)))]) {
        if (wd > 4) { t.weekend += r.n; continue; }
        const rg = groepOp(r.naam, r.dag); (t.wd[rg] || (t.wd[rg] = [0, 0, 0, 0, 0]))[wd] += r.n;
      }
    }
    for (const d of gedekt) {
      const x = wk(d), w = WEEKDAG(d); x.dagen_gedekt++;
      if (w < 5 && !feest.has(d)) { x.wd_open[w]++; metWd(mnd(d.slice(0, 7))).wd_open[w]++; }
    }
    for (const x of weken.values()) { let k = ''; for (let i = 0; i < 7; i++) k += gedekt.has(plusDag(x.van, i)) ? '1' : '0'; x.kalender = k; }
    for (const x of p.maanden) metWd(x);
    p.weken = [...weken.values()].sort((a, b) => (a.van < b.van ? -1 : 1));
  }

  function overzicht() {
    return metDb((db) => {
      const leeg = { ok: true, groepen: GROEPEN.map((g) => ({ id: g, naam: GROEP_NAAM[g] })), praktijken: [], exports: [], nog_in_te_delen: [], wacht: wachtLijst(), ontbreekt: [] };
      if (!db) return leeg;
      const codes = codeKaart(db);
      const fin = finPatienten() || {};
      const uit = Object.assign(leeg, {
        praktijken: db.prepare('SELECT code, naam FROM praktijk ORDER BY code DESC').all().map((p) => Object.assign({}, p)),
        exports: db.prepare('SELECT id, praktijk, naam, exportdatum, begin, eind, op, n_inschrijf, n_regel, n_voorlopig, n_gelijk, stand, met_patient FROM export ORDER BY exportdatum DESC, id DESC').all()
          .map((r) => Object.assign({}, r, { met_patient: !!r.met_patient })),
        nog_in_te_delen: db.prepare("SELECT c.code, c.naam, (SELECT COUNT(*) FROM regel r WHERE r.code = c.code) + (SELECT COUNT(*) FROM inschrijf i WHERE i.code = c.code) AS n FROM code c WHERE c.groep = 'nog-in-te-delen' ORDER BY c.code").all().map((r) => Object.assign({}, r)),
        ontbreekt: ontbreektIn(db),   // wv4212 (L26); wacht staat al in leeg
      });
      for (const p of uit.praktijken) {
        // kwartalen: patiënten per leeftijdsklasse (unieke pseudoniemen met een basiscode), in- en uitstroom, doorschuiven, modules
        const qs = db.prepare('SELECT DISTINCT peildatum FROM inschrijf WHERE praktijk = ? ORDER BY peildatum').all(p.code).map((r) => r.peildatum);
        const basis = [...codes.entries()].filter(([, c]) => c.telt_patient).map(([k]) => k).sort();
        const klasseVan = (code) => basis.indexOf(code);
        let vorige = null, vorigeQ = null;
        p.kwartalen = [];
        const inBasis = 'code IN (' + basis.map(() => '?').join(',') + ')';
        for (const q of qs) {
          // wv3045: een kwartaaldatum komt als geheel uit één export; zonder patiëntnummer (patient = '') tellen we basisregels per klasse
          const zonder = !!db.prepare('SELECT 1 AS x FROM inschrijf WHERE praktijk = ? AND peildatum = ? AND patient = ? LIMIT 1').get(p.code, q, ZONDER);
          const klassen = basis.map(() => 0);
          let perPat = null, nPat;
          const k = { peildatum: q };
          if (zonder) {
            for (const r of db.prepare('SELECT code, COUNT(*) AS n FROM inschrijf WHERE praktijk = ? AND peildatum = ? AND ' + inBasis + ' GROUP BY code').iterate(p.code, q, ...basis)) klassen[klasseVan(r.code)] += r.n;
            nPat = klassen.reduce((a, n) => a + n, 0);
            Object.assign(k, { patienten: klein(nPat), klassen: klassen.map(klein), dubbel: NIET, zonder_patientnummer: true });
          } else {
            perPat = new Map();
            for (const r of db.prepare('SELECT patient, code FROM inschrijf WHERE praktijk = ? AND peildatum = ? AND ' + inBasis).iterate(p.code, q, ...basis)) {
              const kl = klasseVan(r.code); const o = perPat.get(r.patient);
              perPat.set(r.patient, o === undefined ? kl : Math.max(o, kl));
            }
            const dubbel = db.prepare('SELECT COUNT(*) AS n FROM (SELECT patient FROM inschrijf WHERE praktijk = ? AND peildatum = ? AND ' + inBasis + ' GROUP BY patient HAVING COUNT(*) > 1)').get(p.code, q, ...basis).n;
            for (const kl of perPat.values()) klassen[kl]++;
            nPat = perPat.size;
            Object.assign(k, { patienten: klein(nPat), klassen: klassen.map(klein), dubbel: klein(dubbel) });   // review MOET 3: ook het totaal
          }
          if (vorigeQ && volgendKwartaal(vorigeQ) === q) {
            if (!perPat || !vorige) { k.instroom = NIET; k.uitstroom = NIET; k.doorschuif = NIET; }
            else {
              let inn = 0, uitS = 0, door = 0;
              for (const [pt, kl] of perPat) { if (!vorige.has(pt)) inn++; else if (kl > vorige.get(pt)) door++; }
              for (const pt of vorige.keys()) if (!perPat.has(pt)) uitS++;
              k.instroom = klein(inn); k.uitstroom = klein(uitS); k.doorschuif = klein(door);
            }
          }
          const mods = db.prepare('SELECT code, COUNT(*) AS n, SUM(tarief_cent) AS c FROM inschrijf WHERE praktijk = ? AND peildatum = ? GROUP BY code ORDER BY code').all(p.code, q);
          k.inschrijfgeld = { basis: 0, opslag: 0, modules: 0, jaarmodule: 0 };
          k.modules = [];
          for (const m of mods) {
            const c = codes.get(m.code) || { groep: 'nog-in-te-delen', naam: m.code };
            if (c.telt_patient) k.inschrijfgeld.basis += m.c;
            else if (c.groep === 'inschrijving') k.inschrijfgeld.opslag += m.c;
            else if (c.groep === 'module' && c.ritme === 'jaar') k.inschrijfgeld.jaarmodule += m.c;
            else k.inschrijfgeld.modules += m.c;
            if (c.groep === 'module' || c.groep === 'nog-in-te-delen') k.modules.push({ code: m.code, naam: c.naam, ritme: c.ritme || null, n: m.n, cent: m.c, dekking_pct: nPat ? Math.round(m.n / nPat * 1000) / 10 : null });
          }
          const fj = fin[p.code] && fin[p.code][q.slice(0, 4)];
          if (fj) { k.fin = Math.round(fj * 100) / 100; k.fin_afwijking_pct = pct1(nPat, fj); k.fin_melding = Math.abs(nPat / fj - 1) > 0.01; }
          p.kwartalen.push(k);
          vorige = perPat; vorigeQ = q;
        }
        p.klassen = basis.map((c) => (codes.get(c) || {}).subgroep || c);
        // maanden: verrichtingen per groep en per subgroep (consultduur, visite kort/lang, M&I per soort), dekking
        const maanden = new Map();
        const mnd = (m) => { if (!maanden.has(m)) maanden.set(m, { maand: m, groepen: {}, sub: {}, subc: {}, voorlopig: 0, dagen: 0, dagen_gedekt: 0, kalender: '' }); return maanden.get(m); };
        for (const r of db.prepare('SELECT substr(dag, 1, 7) AS m, code, type, COUNT(*) AS n, SUM(tarief_cent) AS c, SUM(voorlopig) AS v FROM regel WHERE praktijk = ? GROUP BY m, code, type').iterate(p.code)) {
          const x = mnd(r.m), g = groepVan(codes, r.code, r.type);
          const gg = x.groepen[g] || (x.groepen[g] = { n: 0, cent: 0 }); gg.n += r.n; gg.cent += r.c;
          const sub = r.type === 'O' ? null : (codes.get(r.code) || {}).subgroep;
          if (sub && (g === 'consult' || g === 'visite' || g === 'mi' || g === 'poh-ggz')) { const sk = g + ':' + sub; x.sub[sk] = (x.sub[sk] || 0) + r.n; x.subc[sk] = (x.subc[sk] || 0) + r.c; }   // wv4148: subc = bedrag per soort
          x.voorlopig += r.v;
        }
        const gedekt = new Set(db.prepare('SELECT dag FROM dagbron WHERE praktijk = ?').all(p.code).map((r) => r.dag));
        if (gedekt.size) {
          const alle = [...gedekt].sort();
          for (let m = alle[0].slice(0, 7); m <= alle[alle.length - 1].slice(0, 7);) {
            const x = mnd(m);
            const [j, mm] = m.split('-').map(Number), n = new Date(Date.UTC(j, mm, 0)).getUTCDate();
            let kal = ''; for (let d = 1; d <= n; d++) { const g = gedekt.has(m + '-' + String(d).padStart(2, '0')); kal += g ? '1' : '0'; if (g) x.dagen_gedekt++; }
            x.dagen = n; x.kalender = kal;
            const v = new Date(Date.UTC(j, mm, 1)); m = v.toISOString().slice(0, 7);
          }
        }
        p.maanden = [...maanden.values()].sort((a, b) => (a.maand < b.maand ? -1 : 1));
        // registreerders (ruwe namen; alleen op Davids scherm): per maand consultduur, visites, M&I, POH-GGZ, overig
        const regs = new Map();
        for (const r of db.prepare('SELECT substr(dag, 1, 7) AS m, registreerder AS naam, code, type, COUNT(*) AS n FROM regel WHERE praktijk = ? GROUP BY m, naam, code, type').iterate(p.code)) {
          if (!regs.has(r.naam)) regs.set(r.naam, new Map());
          const per = regs.get(r.naam); if (!per.has(r.m)) per.set(r.m, regNul());
          regTel(per.get(r.m), codes, r.code, r.type, r.n);
        }
        const soort = new Map(db.prepare('SELECT naam, soort FROM registreerder WHERE praktijk = ?').all(p.code).map((r) => [r.naam, r.soort]));
        p.registreerders = [...regs.entries()].sort((a, b) => a[0].localeCompare(b[0], 'nl')).map(([naam, per]) => ({ naam, soort: soort.get(naam) || 'persoon',
          maanden: [...per.entries()].sort().map(([m, x]) => Object.assign({ maand: m }, x)) }));
        weekEnDag(db, codes, p, mnd, gedekt);   // wv4213 (L27)
        p.voorlopig = db.prepare('SELECT COUNT(*) AS n FROM regel WHERE praktijk = ? AND voorlopig = 1').get(p.code).n;
        // wv4148 (2C50, David 25-11-2026 Ja): datastand bovenaan en blok "Valt op". Alleen tellingen per code en maand, nooit per patiënt.
        const db0 = db.prepare('SELECT MIN(dag) AS a, MAX(dag) AS b FROM dagbron WHERE praktijk = ?').get(p.code);
        p.data_van = db0.a || null; p.data_tot = db0.b || null;
        p.laatste_export = (db.prepare("SELECT MAX(exportdatum) AS d FROM export WHERE praktijk = ? AND stand = 'actief'").get(p.code) || {}).d || null;
        p.valt_op = valtOp(db, codes, p.code);
      }
      uit.praktijken = uit.praktijken.filter((p) => p.kwartalen.length || p.maanden.length || uit.exports.some((e) => e.praktijk === p.code));
      uit.bekend = Object.values(PRAKTIJKEN).map((x) => ({ code: x.code, naam: x.naam }));   // wv4148: ook "Groenhouten: nog geen export"
      uit.klein_aantal = 30;
      return uit;
    }, false);
  }


  // ── fase 2 (wv3047): personeel ──
  function bron() {
    const b = personeelVan() || {};
    return { peil: b.peil || null, medewerkers: Array.isArray(b.medewerkers) ? b.medewerkers : [], dossiers: Array.isArray(b.dossiers) ? b.dossiers : [] };
  }
  const ENT_VAN = { TG: ['TG', 'POT'], GH: ['GH', 'POT'] };
  const DOSSIER_ENT = { Tolgaarde: 'TG', Groenhouten: 'GH', POT_POH_GGZ: 'POT' };
  const dossierEnt = (pad) => DOSSIER_ENT[String(pad).split('/')[1]] || null;
  const functieNu = (m) => (m.functies || []).slice().sort((a, b) => String(a.begin || '').localeCompare(String(b.begin || '')) || String(a.aangemaakt || '').localeCompare(String(b.aangemaakt || ''))).pop() || null;
  // Per ruwe naam: aantallen, AGB aanwezig, aandeel POH-GGZ (alleen voor het voorstel)
  function namenStand(db) {
    const codes = codeKaart(db), st = new Map();
    for (const r of db.prepare('SELECT praktijk, registreerder AS naam, code, type, COUNT(*) AS n, MIN(dag) AS eerste, MAX(dag) AS laatste, MAX(reg_agb) AS agb FROM regel GROUP BY praktijk, registreerder, code, type').iterate()) {
      const k = r.praktijk + '\u0001' + r.naam;
      const x = st.get(k) || { n: 0, poh: 0, eerste: r.eerste, laatste: r.laatste, agb: null };
      x.n += r.n; if (groepVan(codes, r.code, r.type) === 'poh-ggz') x.poh += r.n;
      if (r.eerste < x.eerste) x.eerste = r.eerste; if (r.laatste > x.laatste) x.laatste = r.laatste; if (r.agb) x.agb = r.agb;
      st.set(k, x);
    }
    return st;
  }
  function voorstel(db, reg, st, alle, personen, b) {
    const x = st.get(reg.praktijk + '\u0001' + reg.naam) || { n: 0, poh: 0, eerste: null, laatste: null, agb: null };
    const ik = ontleedNaam(reg.naam);
    // 1. zelfde AGB of bijna dezelfde naam als een naam die al bevestigd is (Promedico schreef iemand anders: één keer bevestigen)
    for (const a of alle) {
      if (!a.persoon || !a.bevestigd || a.naam === reg.naam) continue;
      const y = st.get(a.praktijk + '\u0001' + a.naam);
      if (x.agb && y && y.agb === x.agb) return { persoon: a.persoon, reden: 'zelfde AGB als "' + a.naam + '"' };
      if (lijkt(ik, ontleedNaam(a.naam)) === 2) return { persoon: a.persoon, reden: 'lijkt op "' + a.naam + '" (andere schrijfwijze?)' };
    }
    for (const p of personen) if (!p.groep && lijkt(ik, ontleedNaam(p.naam)) === 2) return { persoon: p.id, reden: 'lijkt op ' + p.naam };
    if (reg.soort === 'verzamel' || VERZAMEL_RE.test(reg.naam)) return { nieuw: { naam: reg.naam, groep: true, dienst: 'zzp' }, rollen: [{ rol: 'waarnemer', van: x.eerste || reg.eerst, tot: null }], reden: 'verzamelnaam: één groep (waarnemer), telt mee in de praktijk- en rolcijfers, niet in een vergelijking tussen personen' };
    // 2. Nmbrs (dezelfde praktijk of POT) en een dossier in de vault
    const kies = (lijst, ontl) => { let best = 0, u = []; for (const m of lijst) { const sc = lijkt(ik, ontl(m)); if (sc > best) { best = sc; u = [m]; } else if (sc && sc === best) u.push(m); } return u; };
    const nm = kies(b.medewerkers.filter((m) => (ENT_VAN[reg.praktijk] || []).includes(m.entiteit)), (m) => ontleed(m.voornaam, [m.tussen, m.achternaam].filter(Boolean).join(' ')));
    const ds = kies(b.dossiers.filter((d) => (ENT_VAN[reg.praktijk] || []).includes(dossierEnt(d.pad))), (d) => ontleedNaam(d.naam));
    const m = nm.length === 1 ? nm[0] : null;
    const dossier = m && m.dossier ? m.dossier : ds.length === 1 ? ds[0].pad : null;
    const dNaam = dossier ? (b.dossiers.find((d) => d.pad === dossier) || {}) : {};
    const redenen = [];
    if (m) redenen.push('Nmbrs: ' + m.naam + (functieNu(m) && functieNu(m).omschrijving ? ' (' + functieNu(m).omschrijving + ')' : ''));
    else if (nm.length > 1) redenen.push(nm.length + ' medewerkers in Nmbrs passen; kies er één');
    if (dossier) redenen.push('dossier ' + (dNaam.naam || 'in de vault'));
    else if (ds.length > 1) redenen.push(ds.length + ' dossiers passen');
    // rollen: uit de Nmbrs-functies (met hun begindatum), anders uit de dossiernaam, anders uit de codes
    let rollen = [];
    if (m) {
      const f = (m.functies || []).filter((y) => y.omschrijving).slice().sort((a, c) => String(a.begin || '').localeCompare(String(c.begin || '')));
      for (const y of f) { const r = rolUit(y.omschrijving), v = y.begin && isoGoed(y.begin) ? y.begin : null; if (!r) continue; if (rollen.length && rollen[rollen.length - 1].rol === r) continue; rollen.push({ rol: r, van: v, tot: null }); }
      for (let k = 0; k < rollen.length; k++) { if (!rollen[k].van) rollen[k].van = k === 0 ? (x.eerste || reg.eerst) : rollen[k - 1].van; if (k > 0) rollen[k - 1].tot = rollen[k].van > rollen[k - 1].van ? plusDag(rollen[k].van, -1) : rollen[k - 1].van; }
      if (rollen.length) rollen[0].van = (m.dienst || []).map((y) => y.begin).filter(isoGoed).sort()[0] || rollen[0].van;
      rollen = rollen.filter((y) => !y.tot || y.tot >= y.van);
    }
    if (!rollen.length) {
      let r = dNaam.naam ? rolUit(dNaam.rol || '') : null;
      if ((!r || r === 'overig') && x.n && x.poh / x.n >= 0.8) r = 'poh-ggz';
      if (r) rollen = [{ rol: r, van: x.eerste || reg.eerst, tot: null }];
      else if (x.agb) redenen.push('heeft een AGB: waarschijnlijk een arts; kies de rol');
    }
    if (!m && !dossier && !rollen.length) return { reden: redenen.join('; ') || 'geen dossier of Nmbrs-medewerker gevonden' };
    return { nieuw: { naam: m ? m.naam : dNaam.naam || reg.naam, dossier, nmbrs: m ? m.id : null, dienst: m ? (m.entiteit === 'POT' ? 'pot' : 'loondienst') : 'onbekend' }, rollen, reden: redenen.join('; ') };
  }
  function personenLees(db) {
    const ps = db.prepare('SELECT id, naam, dossier, nmbrs, dienst, groep FROM persoon ORDER BY naam').all().map((p) => Object.assign({}, p, { groep: !!p.groep, rollen: [], rooster: [] }));
    const by = new Map(ps.map((p) => [p.id, p]));
    for (const r of db.prepare('SELECT id, persoon, praktijk, rol, van, tot FROM rol_periode ORDER BY van').all()) { const p = by.get(r.persoon); if (p) p.rollen.push(Object.assign({}, r)); }
    for (const r of db.prepare('SELECT persoon, praktijk, ingang, uren FROM rooster_hand ORDER BY ingang').all()) { const p = by.get(r.persoon); if (p) p.rooster.push({ praktijk: r.praktijk, ingang: r.ingang, uren: JSON.parse(r.uren) }); }
    return ps;
  }
  function personeel() {
    return metDb((db) => {
      const b = bron();
      const leeg = { ok: true, rollen: ROLLEN.map((r) => ({ id: r, naam: ROL_NAAM[r], arts: ARTS_ROLLEN.includes(r) })), diensten: DIENSTEN, praktijken: [], personen: [], registreerders: [], werkdagen: {},
        nmbrs_peil: b.peil, nmbrs: [], dossiers: [], klein_aantal: 30, invaldag_min: 5 };
      if (!db) return leeg;
      const inst = (k, d) => Number((db.prepare("SELECT waarde FROM instelling WHERE praktijk = '*' AND sleutel = ?").get(k) || {}).waarde) || d;
      leeg.klein_aantal = inst('klein_aantal', 30); leeg.invaldag_min = inst('invaldag_min', 5);
      const st = namenStand(db), personen = personenLees(db);
      const alle = db.prepare('SELECT praktijk, naam, persoon, soort, eerst, bevestigd, negeer FROM registreerder ORDER BY praktijk, naam').all().map((r) => Object.assign({}, r));
      leeg.praktijken = db.prepare('SELECT code, naam FROM praktijk WHERE code IN (SELECT DISTINCT praktijk FROM dagbron) ORDER BY code DESC').all().map((r) => Object.assign({}, r));
      leeg.personen = personen;
      leeg.registreerders = alle.map((r) => {
        const x = st.get(r.praktijk + '\u0001' + r.naam) || { n: 0, eerste: null, laatste: null, agb: null };
        const u = { praktijk: r.praktijk, naam: r.naam, soort: r.soort === 'verzamel' || VERZAMEL_RE.test(r.naam) ? 'verzamel' : 'persoon', n: x.n, eerste: x.eerste, laatste: x.laatste, met_agb: !!x.agb, persoon: r.bevestigd ? r.persoon : null, bevestigd: r.bevestigd || null, negeer: r.negeer || null };
        if (!r.bevestigd && !r.negeer && x.n) u.voorstel = voorstel(db, r, st, alle, personen, b);
        return u;
      });
      leeg.nmbrs = b.medewerkers.map((m) => ({ id: m.id, naam: m.naam, entiteit: m.entiteit, functie: (functieNu(m) || {}).omschrijving || null, dossier: m.dossier || null }));
      leeg.dossiers = b.dossiers.map((d) => ({ pad: d.pad, naam: d.naam, entiteit: dossierEnt(d.pad) }));
      // werkdagen per praktijk per persoon (compact: [dag, soort, uren, rol, bron, n, d, kort, middel, lang, vk, vl, mi, poh, cent])
      const codes = codeKaart(db), drempel = leeg.invaldag_min;
      const nmVan = new Map(b.medewerkers.map((m) => [m.id, m]));
      for (const pr of leeg.praktijken) {
        const gedekt = new Set(db.prepare('SELECT dag FROM dagbron WHERE praktijk = ?').all(pr.code).map((r) => r.dag));
        const jaren = new Set([...gedekt].map((d) => Number(d.slice(0, 4)))), feest = new Set();
        for (const j of jaren) for (const f of feestdagen(j)) feest.add(f);
        const naarPersoon = new Map(alle.filter((r) => r.praktijk === pr.code && r.bevestigd && r.persoon && !r.negeer).map((r) => [r.naam, r.persoon]));
        const perP = new Map();
        for (const r of db.prepare('SELECT registreerder AS naam, dag, code, type, COUNT(*) AS n, SUM(tarief_cent) AS c FROM regel WHERE praktijk = ? GROUP BY registreerder, dag, code, type').iterate(pr.code)) {
          const pid = naarPersoon.get(r.naam); if (!pid) continue;
          const c = r.type === 'O' ? null : codes.get(r.code);
          if (c && !(c.telt_werkdag === undefined ? 1 : c.telt_werkdag)) continue;
          if (!perP.has(pid)) perP.set(pid, new Map());
          const m = perP.get(pid); if (!m.has(r.dag)) m.set(r.dag, { n: 0, d: 0, kort: 0, middel: 0, lang: 0, vk: 0, vl: 0, mi: 0, poh: 0, cent: 0 });
          const t = m.get(r.dag), g = groepVan(codes, r.code, r.type), sub = c ? c.subgroep : null;
          t.n += r.n;
          if (r.type === 'V') { t.d += r.n; t.cent += r.c; }
          if (g === 'consult' && (sub === 'kort' || sub === 'middel' || sub === 'lang')) t[sub] += r.n;
          else if (g === 'visite' && sub === 'kort') t.vk += r.n; else if (g === 'visite' && sub === 'lang') t.vl += r.n;
          else if (g === 'mi') t.mi += r.n; else if (g === 'poh-ggz') t.poh += r.n;
        }
        const uitP = {};
        for (const p of personen) {
          const dagen = perP.get(p.id) || new Map();
          const rollen = p.rollen.filter((r) => r.praktijk === pr.code);
          if (!dagen.size && !rollen.length) continue;
          const m = p.nmbrs ? nmVan.get(p.nmbrs) : null;
          // review wv3047 MOET 1: rooster en contracturen uit Nmbrs gelden alleen bij de praktijk van dat bedrijf (TG bij TG, GH bij GH). Bij POT
          // (POH-GGZ, werkt bij meer praktijken) en bij de andere praktijk: geen Nmbrs-uren, alleen het patroon of een handrooster; het
          // dienstverband geldt overal (uit dienst = nergens).
          // wv3111 (David 15-11-2026: "Wat jij ziet is de hele salarisadministratie van de POT. Zeker wel de uren uit Nmbrs overnemen!"): het
          // POT-rooster geldt bij de praktijk waar de POH-GGZ een rol heeft, zolang die persoon geen rol bij een andere praktijk heeft (anders
          // zou hetzelfde rooster bij twee praktijken tellen; dan blijft het patroon).
          const elders = p.rollen.some((r) => r.praktijk !== pr.code);
          const eigen = m && (m.entiteit === pr.code || (m.entiteit === 'POT' && !elders));
          const w = werkdagenVan({ groep: p.groep, dagen, gedekt, rollen, hand: p.rooster.filter((r) => r.praktijk === pr.code), nmbrs: m ? { dienst: m.dienst, rooster: eigen ? m.rooster : [], contract: eigen ? m.contract : [] } : null, drempel, feest });
          uitP[p.id] = w.map((x) => { const t = x.t || { n: 0, d: 0, kort: 0, middel: 0, lang: 0, vk: 0, vl: 0, mi: 0, poh: 0, cent: 0 }; return [x.dag, x.soort, x.uren, x.rol, x.bron, t.n, t.d, t.kort, t.middel, t.lang, t.vk, t.vl, t.mi, t.poh, t.cent]; });
        }
        leeg.werkdagen[pr.code] = uitP;
        // Nmbrs-rooster per persoon (voor het scherm: welke uren gelden, en of de daguren een echt patroon zijn)
      }
      for (const p of personen) {
        const m = p.nmbrs ? nmVan.get(p.nmbrs) : null;
        p.nmbrs_rooster = m ? (m.rooster || []).map((r) => ({ begin: r.begin, uren: r.uren, dagen_per_week: r.dagen_per_week, dagen: nmbrsDagenEcht(r), dagen_ingevuld: Array.isArray(r.dagen1) })) : null;
        p.nmbrs_naam = m ? m.naam : null;
        p.nmbrs_entiteit = m ? m.entiteit : null;   // review MOET 1: Nmbrs-uren gelden alleen bij deze praktijk
      }
      return leeg;
    }, false);
  }
  // ── fase 2: schrijven (alleen David, op het koppelscherm) ──
  const tekstVeld = (x, max) => String(x == null ? '' : x).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  function rollenGoed(rollen) {
    if (!Array.isArray(rollen) || rollen.length > 10) throw new Fout(400, 'rollen als lijst');
    return rollen.map((r) => {
      if (!ROLLEN.includes(r && r.rol)) throw new Fout(400, 'kies een rol');
      if (!isoGoed(r.van)) throw new Fout(400, 'begindatum van de rol als jjjj-mm-dd');
      if (r.tot != null && r.tot !== '' && (!isoGoed(r.tot) || r.tot < r.van)) throw new Fout(400, 'einddatum van de rol leeg of na het begin');
      return { rol: r.rol, van: r.van, tot: r.tot || null };
    });
  }
  function nieuwPersoon(db, n, b) {
    const naam = tekstVeld(n.naam, 120);
    if (naam.length < 2) throw new Fout(400, 'naam van de medewerker');
    const dossier = n.dossier ? String(n.dossier) : null, nmbrs = n.nmbrs ? String(n.nmbrs) : null;
    if (dossier && !b.dossiers.some((d) => d.pad === dossier)) throw new Fout(400, 'onbekend dossier');
    if (nmbrs && !b.medewerkers.some((m) => m.id === nmbrs)) throw new Fout(400, 'onbekende Nmbrs-medewerker');
    const dienst = DIENSTEN.includes(n.dienst) ? n.dienst : 'onbekend';
    // dezelfde Nmbrs-medewerker of hetzelfde dossier = dezelfde persoon (nooit twee personen voor één medewerker)
    const al = nmbrs ? db.prepare('SELECT id FROM persoon WHERE nmbrs = ?').get(nmbrs) : dossier ? db.prepare('SELECT id FROM persoon WHERE dossier = ?').get(dossier) : null;
    if (al) return al.id;
    return Number(db.prepare('INSERT INTO persoon (naam, dossier, nmbrs, dienst, groep, op) VALUES (?, ?, ?, ?, ?, ?)').run(naam, dossier, nmbrs, dienst, n.groep ? 1 : 0, nuIso()).lastInsertRowid);
  }
  function koppel(body) {
    const praktijk = String(body.praktijk || ''), naam = String(body.naam || '');
    const b = bron();
    return metDb((db) => {
      const reg = db.prepare('SELECT praktijk, naam FROM registreerder WHERE praktijk = ? AND naam = ?').get(praktijk, naam);
      if (!reg) throw new Fout(404, 'deze naam staat niet in de exports');
      if (body.los === true) { db.prepare('UPDATE registreerder SET persoon = NULL, bevestigd = NULL, negeer = NULL WHERE praktijk = ? AND naam = ?').run(praktijk, naam); return { body: { ok: true }, reden: 'pma koppel los' }; }
      // wv3111: een naam negeren (David 15-11-2026: een regel van iemand van een andere praktijk) = los van elke persoon en niet meer te koppelen
      if (body.negeer === true) { db.prepare('UPDATE registreerder SET persoon = NULL, bevestigd = NULL, negeer = ? WHERE praktijk = ? AND naam = ?').run(nuIso(), praktijk, naam); return { body: { ok: true }, reden: 'pma koppel negeer' }; }
      let pid;
      if (body.persoon != null) {
        pid = Number(body.persoon);
        if (!Number.isInteger(pid) || !db.prepare('SELECT 1 AS x FROM persoon WHERE id = ?').get(pid)) throw new Fout(404, 'deze medewerker bestaat niet');
      } else if (body.nieuw && typeof body.nieuw === 'object') pid = nieuwPersoon(db, body.nieuw, b);
      else throw new Fout(400, 'kies een medewerker');
      const rollen = body.rollen == null ? [] : rollenGoed(body.rollen);
      if (rollen.length && !db.prepare('SELECT 1 AS x FROM rol_periode WHERE persoon = ? AND praktijk = ?').get(pid, praktijk)) {
        const ins = db.prepare('INSERT INTO rol_periode (persoon, praktijk, rol, van, tot, op) VALUES (?, ?, ?, ?, ?, ?)');
        for (const r of rollen) ins.run(pid, praktijk, r.rol, r.van, r.tot, nuIso());
      }
      db.prepare('UPDATE registreerder SET persoon = ?, bevestigd = ?, negeer = NULL WHERE praktijk = ? AND naam = ?').run(pid, nuIso(), praktijk, naam);
      return { body: { ok: true, persoon: pid }, reden: 'pma koppel' };
    }, true);
  }
  function rolZet(body) {
    return metDb((db) => {
      if (body.weg === true) {
        const id = Number(body.id); if (!Number.isInteger(id)) throw new Fout(400, 'welke rol?');
        if (!db.prepare('DELETE FROM rol_periode WHERE id = ?').run(id).changes) throw new Fout(404, 'deze rol bestaat niet');
        return { body: { ok: true }, reden: 'pma rol weg' };
      }
      const pid = Number(body.persoon), praktijk = String(body.praktijk || '');
      if (!Number.isInteger(pid) || !db.prepare('SELECT 1 AS x FROM persoon WHERE id = ?').get(pid)) throw new Fout(404, 'deze medewerker bestaat niet');
      if (!db.prepare('SELECT 1 AS x FROM praktijk WHERE code = ?').get(praktijk)) throw new Fout(400, 'kies een praktijk');
      const [r] = rollenGoed([body]);
      if (body.id != null) {
        const id = Number(body.id);
        if (!db.prepare('UPDATE rol_periode SET rol = ?, van = ?, tot = ?, praktijk = ?, op = ? WHERE id = ? AND persoon = ?').run(r.rol, r.van, r.tot, praktijk, nuIso(), id, pid).changes) throw new Fout(404, 'deze rol bestaat niet');
        return { body: { ok: true, id }, reden: 'pma rol' };
      }
      const id = Number(db.prepare('INSERT INTO rol_periode (persoon, praktijk, rol, van, tot, op) VALUES (?, ?, ?, ?, ?, ?)').run(pid, praktijk, r.rol, r.van, r.tot, nuIso()).lastInsertRowid);
      return { body: { ok: true, id }, reden: 'pma rol' };
    }, true);
  }
  function roosterZet(body) {
    const pid = Number(body.persoon), praktijk = String(body.praktijk || ''), ingang = String(body.ingang || '');
    if (!isoGoed(ingang)) throw new Fout(400, 'ingangsdatum als jjjj-mm-dd');
    return metDb((db) => {
      if (!Number.isInteger(pid) || !db.prepare('SELECT 1 AS x FROM persoon WHERE id = ?').get(pid)) throw new Fout(404, 'deze medewerker bestaat niet');
      if (!db.prepare('SELECT 1 AS x FROM praktijk WHERE code = ?').get(praktijk)) throw new Fout(400, 'kies een praktijk');
      if (body.weg === true) { db.prepare('DELETE FROM rooster_hand WHERE persoon = ? AND praktijk = ? AND ingang = ?').run(pid, praktijk, ingang); return { body: { ok: true }, reden: 'pma rooster weg' }; }
      const u = body.uren;
      if (!Array.isArray(u) || u.length !== 7 || !u.every((n) => typeof n === 'number' && n >= 0 && n <= 14)) throw new Fout(400, 'uren per dag (ma t/m zo) tussen 0 en 14');
      const uren = u.map((n) => Math.round(n * 4) / 4);
      db.prepare('INSERT INTO rooster_hand (persoon, praktijk, ingang, uren, op) VALUES (?, ?, ?, ?, ?) ON CONFLICT(persoon, praktijk, ingang) DO UPDATE SET uren = excluded.uren, op = excluded.op').run(pid, praktijk, ingang, JSON.stringify(uren), nuIso());
      return { body: { ok: true }, reden: 'pma rooster' };
    }, true);
  }
  function persoonZet(body) {
    const pid = Number(body.id), b = bron();
    return metDb((db) => {
      const p = Number.isInteger(pid) ? db.prepare('SELECT id FROM persoon WHERE id = ?').get(pid) : null;
      if (!p) throw new Fout(404, 'deze medewerker bestaat niet');
      if (body.naam !== undefined) { const n = tekstVeld(body.naam, 120); if (n.length < 2) throw new Fout(400, 'naam van de medewerker'); db.prepare('UPDATE persoon SET naam = ? WHERE id = ?').run(n, pid); }
      if (body.dienst !== undefined) { if (!DIENSTEN.includes(body.dienst)) throw new Fout(400, 'kies een soort dienstverband'); db.prepare('UPDATE persoon SET dienst = ? WHERE id = ?').run(body.dienst, pid); }
      if (body.dossier !== undefined) {
        const d = body.dossier ? String(body.dossier) : null;
        if (d && !b.dossiers.some((x) => x.pad === d)) throw new Fout(400, 'onbekend dossier');
        db.prepare('UPDATE persoon SET dossier = ? WHERE id = ?').run(d, pid);
      }
      if (body.nmbrs !== undefined) {
        const m = body.nmbrs ? String(body.nmbrs) : null;
        if (m && !b.medewerkers.some((x) => x.id === m)) throw new Fout(400, 'onbekende Nmbrs-medewerker');
        if (m && db.prepare('SELECT 1 AS x FROM persoon WHERE nmbrs = ? AND id <> ?').get(m, pid)) throw new Fout(409, 'deze Nmbrs-medewerker hoort al bij iemand anders');
        db.prepare('UPDATE persoon SET nmbrs = ? WHERE id = ?').run(m, pid);
      }
      if (body.groep !== undefined) db.prepare('UPDATE persoon SET groep = ? WHERE id = ?').run(body.groep ? 1 : 0, pid);
      return { body: { ok: true }, reden: 'pma persoon' };
    }, true);
  }
  const SCHRIJF = { '/app/pma/controleer': controleer, '/app/pma/inlees': inlees, '/app/pma/intrek': intrek, '/app/pma/code': zetCode,
    '/app/pma/koppel': koppel, '/app/pma/rol': rolZet, '/app/pma/rooster': roosterZet, '/app/pma/persoon': persoonZet };   // wv3047: fase 2
  function app(v) {
    try {
      if (v.methode === 'GET' && v.pad === '/app/pma') return { status: 200, body: overzicht(), reden: 'pma' };
      if (v.methode === 'GET' && v.pad === '/app/pma/personeel') return { status: 200, body: personeel(), reden: 'pma personeel' };   // wv3047
      const f = v.methode === 'POST' ? SCHRIJF[v.pad] : null;
      if (!f) return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'pma onbekend' };
      const u = f(v.body && typeof v.body === 'object' ? v.body : {});
      return { status: 200, body: u.body, reden: u.reden };
    } catch (e) {
      if (e instanceof Fout) return { status: e.status, body: { ok: false, fout: e.message }, reden: 'pma ' + e.status };
      throw e;
    }
  }
  function info() {
    return metDb((db) => {
      if (!db) return { aan: true, databank: false };
      const n = (t, w) => db.prepare('SELECT COUNT(*) AS n FROM ' + t + (w || '')).get().n;
      let bron = 0; try { bron = fs.readdirSync(bronMap).filter((f) => f.endsWith('.zip')).length; } catch (e) { /* geen map */ }
      return { aan: true, databank: true, exports: n('export', " WHERE stand = 'actief'"), zonder_patientnummer: n('export', " WHERE stand = 'actief' AND met_patient = 0"), ingetrokken: n('export', " WHERE stand = 'ingetrokken'"), regels: n('regel'),
        inschrijf: n('inschrijf'), dagen: n('dagbron'), kwartalen: n('kwartaalbron'), nog_in_te_delen: n('code', " WHERE groep = 'nog-in-te-delen'"), bron_zips: bron,
        personen: n('persoon'), namen_gekoppeld: n('registreerder', ' WHERE bevestigd IS NOT NULL'), namen_open: n('registreerder', ' WHERE bevestigd IS NULL'),   // wv3047
        schema: Number((db.prepare("SELECT waarde FROM meta WHERE sleutel = 'schema'").get() || {}).waarde) || null };
    }, false);
  }
  // wv3098 (PMA › Jaarcijfers, heden): bedragen van het lopende jaar per praktijk — alleen bedragen per maand en sommen, nooit een
  // patiënt of registreerder. Alleen de aaneengesloten gedekte dagen vanaf 1 januari tellen (een gat = daar houdt "tot nu" op); inschrijfgeld
  // (inschrijving + modules, tabel inschrijf) alleen van kwartalen waarvan de peildatum binnen die dekking valt én die een kwartaalbron hebben.
  // `knip` = { TG: 'jjjj-mm-dd' }: dezelfde sommen t/m die dag (de pod geeft de einddatum van de VIP-export mee, geen invoer van de app).
  function jaarBedragen(jaar, knip) {
    jaar = Number(jaar);
    if (!Number.isInteger(jaar) || jaar < 2000 || jaar > 2100) throw new Fout(400, 'jaar');
    const k = knip && typeof knip === 'object' ? knip : {};
    return metDb((db) => {
      const uit = [];
      for (const x of Object.values(PRAKTIJKEN)) {
        const p = x.code, j1 = jaar + '-01-01';
        const r = { code: p, naam: x.naam, jaar, stand: 'geen-export', van: null, tot: null, inschrijf_cent: 0, verricht_cent: 0, maanden: [], kwartalen: [], knip: null };
        uit.push(r);
        if (!db) continue;
        const dagen = db.prepare('SELECT dag FROM dagbron WHERE praktijk = ? AND dag >= ? AND dag <= ? ORDER BY dag').all(p, j1, jaar + '-12-31').map((d) => d.dag);
        if (!dagen.length) continue;
        if (dagen[0] !== j1) { r.stand = 'begint-later'; r.van = dagen[0]; continue; }   // zonder 1 januari geen "dit jaar tot nu"
        let tot = j1;
        for (let i = 1; i < dagen.length && dagen[i] === plusDag(tot, 1); i++) tot = dagen[i];
        const kw = new Set(db.prepare('SELECT peildatum FROM kwartaalbron WHERE praktijk = ? AND peildatum >= ? AND peildatum <= ?').all(p, j1, tot).map((q) => q.peildatum));
        const kwartalen = [];
        for (let q = j1; q <= tot && q.slice(0, 4) === String(jaar); q = volgendKwartaal(q)) kwartalen.push(q);
        // een kwartaal zonder bron, of met een bron maar zonder één euro inschrijfgeld (de export had het niet), telt als ontbrekend (review MOET 1)
        const somQ = (q) => db.prepare('SELECT COALESCE(SUM(tarief_cent), 0) AS c FROM inschrijf WHERE praktijk = ? AND peildatum = ?').get(p, q).c;
        const missen = kwartalen.filter((q) => !kw.has(q) || !(somQ(q) > 0));
        Object.assign(r, { stand: missen.length ? 'kwartaal-mist' : 'ok', van: j1, tot, kwartalen: kwartalen.filter((q) => kw.has(q)) });
        const maanden = new Map();
        const mnd = (m) => { if (!maanden.has(m)) maanden.set(m, { maand: m, inschrijf_cent: 0, verricht_cent: 0 }); return maanden.get(m); };
        for (const q of r.kwartalen) {
          const c = db.prepare('SELECT COALESCE(SUM(tarief_cent), 0) AS c FROM inschrijf WHERE praktijk = ? AND peildatum = ?').get(p, q).c;
          mnd(q.slice(0, 7)).inschrijf_cent += c; r.inschrijf_cent += c;
        }
        for (const m of db.prepare("SELECT substr(dag, 1, 7) AS m, COALESCE(SUM(tarief_cent), 0) AS c FROM regel WHERE praktijk = ? AND type = 'V' AND dag >= ? AND dag <= ? GROUP BY m").all(p, j1, tot)) {
          mnd(m.m).verricht_cent += m.c; r.verricht_cent += m.c;
        }
        r.maanden = [...maanden.values()].sort((a, b) => (a.maand < b.maand ? -1 : 1));
        const kd = typeof k[p] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k[p]) ? k[p] : null;
        if (kd && kd >= j1 && kd <= tot && !missen.some((q) => q <= kd)) {   // alleen binnen de dekking en met elk kwartaal inschrijfgeld t/m die dag (review MOET 1): anders is de vergelijking niet eerlijk
          const ins = r.kwartalen.filter((q) => q <= kd).reduce((s, q) => s + (r.maanden.find((m) => m.maand === q.slice(0, 7)) || { inschrijf_cent: 0 }).inschrijf_cent, 0);
          const ver = db.prepare("SELECT COALESCE(SUM(tarief_cent), 0) AS c FROM regel WHERE praktijk = ? AND type = 'V' AND dag >= ? AND dag <= ?").get(p, j1, kd).c;
          r.knip = { tot: kd, inschrijf_cent: ins, verricht_cent: ver };
        }
      }
      return uit;
    }, false);
  }
  function herbouw(praktijk) {
    return metDb((db) => {
      const ps = praktijk ? [praktijk] : db.prepare("SELECT DISTINCT praktijk FROM export WHERE stand = 'actief'").all().map((r) => r.praktijk);
      let n = 0; for (const p of ps) n += herbouwIn(db, p);
      return n;
    }, true);
  }
  return { app, info, herbouw, jaarBedragen, chatControleer, _plan: plan, _pseudo: pseudo };   // wv4212: chatControleer
}

module.exports = { isoWeek, ROLGROEP, maak, leesZip, splitsCsv, leesExport, LeesFout, GROEPEN, CODES_START, PRAKTIJKEN, ROLLEN, werkdagenVan, ontleedNaam, lijkt, rolUit, feestdagen, nmbrsDagenEcht };
