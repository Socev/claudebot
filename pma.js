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

const SCHEMA_VERSIE = 2;   // 2 = wv3045: export.met_patient (export zonder kolom patientnummer)
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
const UITGEPAKT_MAX = 200 * 1024 * 1024;    // samen uitgepakt (een jaar ± 27 MB); daarboven weigeren (ZIP-bom)
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
function splitsCsv(tekst) {
  const rijen = []; let rij = [], veld = '', i = 0, inQ = false, wasQ = false;
  const n = tekst.length;
  while (i < n) {
    const c = tekst[i];
    if (inQ) {
      if (c === '"') { if (tekst[i + 1] === '"') { veld += '"'; i += 2; continue; } inQ = false; i++; continue; }
      veld += c; i++; continue;
    }
    if (c === '"') { if (veld !== '' || wasQ) throw new LeesFout('regel ' + (rijen.length + 1) + ': aanhalingsteken midden in een veld'); inQ = true; wasQ = true; i++; continue; }
    if (c === ';') { rij.push(veld); veld = ''; wasQ = false; i++; continue; }
    if (c === '\r' || c === '\n') {
      rij.push(veld); veld = ''; wasQ = false; rijen.push(rij); rij = [];
      if (c === '\r' && tekst[i + 1] === '\n') i++;
      i++; continue;
    }
    if (wasQ) throw new LeesFout('regel ' + (rijen.length + 1) + ': tekst na een aanhalingsteken');
    veld += c; i++;
  }
  if (inQ) throw new LeesFout('het bestand eindigt midden in een veld');
  if (veld !== '' || rij.length) { rij.push(veld); rijen.push(rij); }
  while (rijen.length && rijen[rijen.length - 1].length === 1 && rijen[rijen.length - 1][0] === '') rijen.pop();
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
  const ir = splitsCsv(utf8(info[0].data, 'export_info.csv'));
  if (ir.length !== 2 || ir[0].join(';') !== KOP_INFO.join(';') || ir[1].length !== KOP_INFO.length) throw new LeesFout('export_info.csv heeft niet de bekende kolommen');
  const [agb, exd, bg, ed, , set, soortExp] = ir[1];
  const pr = PRAKTIJKEN[agb];
  if (!pr) throw new LeesFout('onbekende praktijk (AGB ' + String(agb).replace(/[^0-9]/g, '').slice(0, 12) + '): bij welke praktijk hoort deze export? Vraag de machinekamer om hem toe te voegen.');
  if (set !== 'PMA') throw new LeesFout('dit is niet de gegevensset "PMA"');
  if (soortExp !== 'Praktijk') throw new LeesFout('export_info: onbekend type export');
  const exportdatum = datum(exd, 'export_info: exportdatum'), begin = datum(bg, 'export_info: begin periode'), eind = datum(ed, 'export_info: eind periode');
  if (begin > eind) throw new LeesFout('export_info: begin ligt na het eind');
  if (eind > exportdatum) throw new LeesFout('export_info: de periode loopt door na de exportdatum');
  const rijen = splitsCsv(utf8(data[0].data, 'het verrichtingenbestand'));
  const kop = rijen.length ? rijen[0].join(';') : '';
  const metPatient = kop === KOP_DATA.join(';');
  if (!metPatient && kop !== KOP_ZONDER.join(';')) throw new LeesFout('het verrichtingenbestand heeft niet de bekende kolommen');
  const nKol = metPatient ? KOP_DATA.length : KOP_ZONDER.length;
  const inschrijf = [], regels = [];
  const volgI = new Map(), volgR = new Map();
  let voorlopig = 0, gelijk = 0;
  for (let r = 1; r < rijen.length; r++) {
    const v = rijen[r], wat = 'regel ' + (r + 1);
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
  }
  return { praktijk: pr.code, praktijk_naam: pr.naam, agb, exportdatum, begin, eind, gegevensset: set, inschrijf, regels, voorlopig, gelijk, met_patient: metPatient };
}

function nuIso() { return new Date().toISOString(); }
const groepVan = (codes, code, type) => (type === 'O' ? 'niet-gedeclareerd' : (codes.get(code) || {}).groep || 'nog-in-te-delen');
const klein = (n) => (n > 0 && n < KLEIN ? '< 5' : n);
// Controleer ↔ Inlezen vergelijken zonder de fin-datahub-cijfers (die kunnen tussendoor ververst zijn)
const vergelijkbaar = (sv) => JSON.stringify(Object.assign({}, sv, { kwartalen: (sv.kwartalen || []).map((k) => ({ peildatum: k.peildatum, regels: k.regels, patienten: k.patienten, stand: k.stand })) }));
const pct1 = (a, b) => (b ? Math.round((a / b - 1) * 1000) / 10 : null);

function maak(o) {
  const map = o.map;
  const dbPad = path.join(map, 'pma.sqlite'), bronMap = path.join(map, 'bron'), wachtMap = path.join(map, 'wacht'), sleutelPad = path.join(map, 'sleutel');
  const finPatienten = typeof o.finPatienten === 'function' ? o.finPatienten : () => null;
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
      db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('schema', ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde WHERE CAST(waarde AS INTEGER) < CAST(excluded.waarde AS INTEGER)").run(String(SCHEMA_VERSIE));
      bijgewerkt = true;
      const p = db.prepare('INSERT INTO praktijk (code, naam, agb) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING');
      for (const [agb, x] of Object.entries(PRAKTIJKEN)) p.run(x.code, x.naam, agb);
      const c = db.prepare("INSERT INTO code (code, van_jaar, tot_jaar, naam, groep, subgroep, ritme, telt_patient, telt_werkdag, bron) VALUES (?, 2000, NULL, ?, ?, ?, ?, ?, ?, 'start') ON CONFLICT(code, van_jaar) DO NOTHING");
      for (const [code, naam, groep, sub, ritme, tp] of CODES_START) c.run(code, naam, groep, sub, ritme, tp, groep === 'inschrijving' || groep === 'module' ? 0 : 1);
      const s = db.prepare("INSERT INTO instelling (praktijk, sleutel, waarde) VALUES ('*', ?, ?) ON CONFLICT DO NOTHING");
      s.run('klein_aantal', '30'); s.run('fin_afwijking_pct', '1');
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
    for (const n of namen) reg.run(ex.praktijk, n, /^waarnemer\b/i.test(n) ? 'verzamel' : 'persoon', ex.exportdatum);
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

  function controleer(b) {
    mappen(); wachtOpruimen();
    const buf = zipUit(b), s = sha(buf), naam = naamUit(b);
    const al = metDb((db) => (db ? db.prepare('SELECT id, op, naam, stand FROM export WHERE sha256 = ?').get(s) : null), false);
    if (al && al.stand === 'actief') return { body: { ok: true, al: { op: al.op, naam: al.naam }, sha: s }, reden: 'pma controleer al' };
    const ex = leesExport(buf, pseudo);
    const p = metDb((db) => plan(db, ex, null), false);
    const tmp = path.join(wachtMap, s + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, path.join(wachtMap, s + '.zip'));
    fs.writeFileSync(path.join(wachtMap, s + '.json'), JSON.stringify({ naam, samenvatting: p.samenvatting, terug: al ? al.id : null }), { mode: 0o600 });
    return { body: { ok: true, sha: s, naam, eerder_ingetrokken: !!al, samenvatting: p.samenvatting }, reden: 'pma controleer' };
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
  function overzicht() {
    return metDb((db) => {
      const leeg = { ok: true, groepen: GROEPEN.map((g) => ({ id: g, naam: GROEP_NAAM[g] })), praktijken: [], exports: [], nog_in_te_delen: [] };
      if (!db) return leeg;
      const codes = codeKaart(db);
      const fin = finPatienten() || {};
      const uit = Object.assign(leeg, {
        praktijken: db.prepare('SELECT code, naam FROM praktijk ORDER BY code DESC').all().map((p) => Object.assign({}, p)),
        exports: db.prepare('SELECT id, praktijk, naam, exportdatum, begin, eind, op, n_inschrijf, n_regel, n_voorlopig, n_gelijk, stand, met_patient FROM export ORDER BY exportdatum DESC, id DESC').all()
          .map((r) => Object.assign({}, r, { met_patient: !!r.met_patient })),
        nog_in_te_delen: db.prepare("SELECT c.code, c.naam, (SELECT COUNT(*) FROM regel r WHERE r.code = c.code) + (SELECT COUNT(*) FROM inschrijf i WHERE i.code = c.code) AS n FROM code c WHERE c.groep = 'nog-in-te-delen' ORDER BY c.code").all().map((r) => Object.assign({}, r)),
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
        const mnd = (m) => { if (!maanden.has(m)) maanden.set(m, { maand: m, groepen: {}, sub: {}, voorlopig: 0, dagen: 0, dagen_gedekt: 0, kalender: '' }); return maanden.get(m); };
        for (const r of db.prepare('SELECT substr(dag, 1, 7) AS m, code, type, COUNT(*) AS n, SUM(tarief_cent) AS c, SUM(voorlopig) AS v FROM regel WHERE praktijk = ? GROUP BY m, code, type').iterate(p.code)) {
          const x = mnd(r.m), g = groepVan(codes, r.code, r.type);
          const gg = x.groepen[g] || (x.groepen[g] = { n: 0, cent: 0 }); gg.n += r.n; gg.cent += r.c;
          const sub = r.type === 'O' ? null : (codes.get(r.code) || {}).subgroep;
          if (sub && (g === 'consult' || g === 'visite' || g === 'mi' || g === 'poh-ggz')) { const sk = g + ':' + sub; x.sub[sk] = (x.sub[sk] || 0) + r.n; }
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
          const per = regs.get(r.naam); if (!per.has(r.m)) per.set(r.m, { kort: 0, middel: 0, lang: 0, visite_kort: 0, visite_lang: 0, mi: 0, poh: 0, overig: 0, totaal: 0 });
          const x = per.get(r.m), g = groepVan(codes, r.code, r.type), sub = (codes.get(r.code) || {}).subgroep;
          x.totaal += r.n;
          if (g === 'consult' && (sub === 'kort' || sub === 'middel' || sub === 'lang')) x[sub] += r.n;
          else if (g === 'visite' && (sub === 'kort' || sub === 'lang')) x['visite_' + sub] += r.n;
          else if (g === 'mi') x.mi += r.n; else if (g === 'poh-ggz') x.poh += r.n; else x.overig += r.n;
        }
        const soort = new Map(db.prepare('SELECT naam, soort FROM registreerder WHERE praktijk = ?').all(p.code).map((r) => [r.naam, r.soort]));
        p.registreerders = [...regs.entries()].sort((a, b) => a[0].localeCompare(b[0], 'nl')).map(([naam, per]) => ({ naam, soort: soort.get(naam) || 'persoon',
          maanden: [...per.entries()].sort().map(([m, x]) => Object.assign({ maand: m }, x)) }));
        p.voorlopig = db.prepare('SELECT COUNT(*) AS n FROM regel WHERE praktijk = ? AND voorlopig = 1').get(p.code).n;
      }
      uit.praktijken = uit.praktijken.filter((p) => p.kwartalen.length || p.maanden.length || uit.exports.some((e) => e.praktijk === p.code));
      uit.klein_aantal = 30;
      return uit;
    }, false);
  }

  const SCHRIJF = { '/app/pma/controleer': controleer, '/app/pma/inlees': inlees, '/app/pma/intrek': intrek, '/app/pma/code': zetCode };
  function app(v) {
    try {
      if (v.methode === 'GET' && v.pad === '/app/pma') return { status: 200, body: overzicht(), reden: 'pma' };
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
        schema: Number((db.prepare("SELECT waarde FROM meta WHERE sleutel = 'schema'").get() || {}).waarde) || null };
    }, false);
  }
  function herbouw(praktijk) {
    return metDb((db) => {
      const ps = praktijk ? [praktijk] : db.prepare("SELECT DISTINCT praktijk FROM export WHERE stand = 'actief'").all().map((r) => r.praktijk);
      let n = 0; for (const p of ps) n += herbouwIn(db, p);
      return n;
    }, true);
  }
  return { app, info, herbouw, _plan: plan, _pseudo: pseudo };
}

module.exports = { maak, leesZip, splitsCsv, leesExport, LeesFout, GROEPEN, CODES_START, PRAKTIJKEN };
