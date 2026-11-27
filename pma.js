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

// wv4218 (besluitenpagina nr 930 = L30, David Ja 25-11-2026): waarnemers uit de verzamelnaam halen met het DocPlan-rooster. Gemeten 27-11-2026:
// DocPlan levert het rooster per persoon per dag (public.sb_dienst_dagen) en de rollen per praktijk (sb_dienst_alias_lijst); server.js geeft
// die als gegeven: { dagen: [{ pr, obj, datum, dagen }], personen: [{ object_id, naam, rollen: [{ praktijk, rol }] }] } of null.
// Regel per dag: kandidaten = de personen in het rooster van die praktijk met een waarnemerrol daar, min de waarnemers die die dag onder hun
// eigen Promedico-naam declareerden (zij gebruikten de verzamelnaam niet; koppeling DocPlan → PMA-persoon op naam, lijkt() = 2 en uniek,
// alleen personen met een artsrol bij die praktijk). Precies één kandidaat = de regels van de verzamelnaam (een groep met rol waarnemer op die
// dag) gaan naar die persoon, bron "docplan-rooster". Nul of meer kandidaten = de dag blijft bij de groep. DocPlan alleen lezen.
const WAARNEMER_DP = /waarne/i;
const rolOpDag = (rollen, praktijk, d) => { let u = null; for (const r of rollen || []) if (r.praktijk === praktijk && r.van <= d && (!r.tot || r.tot >= d) && (!u || r.van >= u.van)) u = r; return u ? u.rol : null; };
function dpId(obj) { let h = 0x811c9dc5; for (const c of String(obj)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return -((h % 2000000000) + 1); }   // vaste negatieve id: nooit een PMA-persoon
// i: { praktijk, rooster, personen (PMA, met rollen), eigen: Map dag → Set pid (declareerde onder eigen naam) }. Uit: Map dag → { obj, naam, pid }
// (pid = PMA-persoon als de waarnemer daar al staat, anders null), plus i.match (obj → pid) voor de toets.
function waarnemerDagen(i) {
  const uit = new Map(), r = i.rooster;
  if (!r || !Array.isArray(r.dagen) || !Array.isArray(r.personen)) return uit;
  const wn = new Map();
  for (const p of r.personen) if (p && p.object_id && (p.rollen || []).some((x) => x && x.praktijk === i.praktijk && WAARNEMER_DP.test(String(x.rol || '')))) wn.set(String(p.object_id), String(p.naam || '').trim());
  const artsen = (i.personen || []).filter((p) => !p.groep && (p.rollen || []).some((x) => x.praktijk === i.praktijk && ARTS_ROLLEN.includes(x.rol)));
  const match = new Map();
  for (const [obj, naam] of wn) {
    const a = ontleedNaam(naam);
    const hits = a ? artsen.filter((p) => lijkt(a, ontleedNaam(p.naam)) === 2) : [];
    if (hits.length === 1) match.set(obj, hits[0].id);
  }
  const perDag = new Map();
  for (const x of r.dagen) {
    if (!x || x.pr !== i.praktijk || !wn.has(String(x.obj)) || !isoGoed(x.datum) || !(Number(x.dagen) > 0)) continue;
    if (!perDag.has(x.datum)) perDag.set(x.datum, new Set());
    perDag.get(x.datum).add(String(x.obj));
  }
  for (const [d, s] of perDag) {
    const eigen = (i.eigen && i.eigen.get(d)) || new Set();
    const kand = [...s].filter((o) => !(match.has(o) && eigen.has(match.get(o))));
    if (kand.length === 1) uit.set(d, { obj: kand[0], naam: wn.get(kand[0]) || 'Waarnemer', pid: match.has(kand[0]) ? match.get(kand[0]) : null });
  }
  if (i.uitMatch) for (const [o, p] of match) i.uitMatch.set(o, p);
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
  const roosterVan = typeof o.rooster === 'function' ? o.rooster : () => null;   // wv4218: DocPlan-rooster per persoon per dag (of null)
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
    // wv4220 (L32): de brief van vijf regels over de nieuwe stand van deze praktijk; mislukt hij, dan blijft de inlezing gewoon geslaagd
    let br = null;
    try { br = brief((overzicht().praktijken || []).find((x) => x.code === ex.praktijk)); } catch (e) { br = null; }
    return { body: { ok: true, id: u.id, terug: !!u.terug, brief: br }, reden: u.terug ? 'pma inlees terug' : 'pma inlees' };
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
      // wv4218: DocPlan-rooster (gegeven van server.js; null = niet te lezen, dan blijft alles bij de groep zoals vóór L30)
      const rooster = roosterVan();
      const byId = new Map(personen.map((p) => [p.id, p])), virt = new Map();
      leeg.docplan = { stand: rooster && Array.isArray(rooster.dagen) ? 'ok' : 'niet te lezen', praktijken: {} };
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
        const rijen = db.prepare('SELECT registreerder AS naam, dag, code, type, COUNT(*) AS n, SUM(tarief_cent) AS c FROM regel WHERE praktijk = ? GROUP BY registreerder, dag, code, type').all(pr.code);
        // wv4218 (L30): wie die dag onder een eigen naam declareerde, en per dag de ene waarnemer uit het DocPlan-rooster (of geen)
        const eigen = new Map();
        for (const r of rijen) { const pid = naarPersoon.get(r.naam); if (pid && byId.has(pid) && !byId.get(pid).groep) { if (!eigen.has(r.dag)) eigen.set(r.dag, new Set()); eigen.get(r.dag).add(pid); } }
        const wnDag = waarnemerDagen({ praktijk: pr.code, rooster, personen, eigen });
        const verschoven = new Map();   // pid → Set van dagen die uit de verzamelnaam kwamen
        const dpT = { persoon: new Set(), groep: new Set(), regels_persoon: 0, regels_groep: 0, wie: new Set() };
        for (const r of rijen) {
          let pid = naarPersoon.get(r.naam); if (!pid) continue;
          const gp = byId.get(pid);
          if (gp && gp.groep && rolOpDag(gp.rollen, pr.code, r.dag) === 'waarnemer') {
            const w = wnDag.get(r.dag);
            if (w) {
              pid = w.pid != null ? w.pid : dpId(w.obj);
              if (w.pid == null && !virt.has(pid)) virt.set(pid, { id: pid, naam: w.naam || 'Waarnemer', dossier: null, nmbrs: null, dienst: 'zzp', groep: false, rollen: [], rooster: [], docplan: true });
              if (!verschoven.has(pid)) verschoven.set(pid, new Set());
              verschoven.get(pid).add(r.dag); dpT.persoon.add(r.dag); dpT.regels_persoon += r.n; dpT.wie.add(pid);
            } else { dpT.groep.add(r.dag); dpT.regels_groep += r.n; }
          }
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
          // wv4218: een dag uit de verzamelnaam staat in het DocPlan-rooster, dus gewerkt (ook buiten het eigen patroon), als waarnemer
          const vs = verschoven.get(p.id);
          if (vs) for (const x of w) if (vs.has(x.dag)) { if (x.soort === 'los' || x.soort === 'invaldag') x.soort = 'gewerkt'; x.bron = 'docplan-rooster'; if (!x.rol) x.rol = 'waarnemer'; }
          uitP[p.id] = w.map((x) => { const t = x.t || { n: 0, d: 0, kort: 0, middel: 0, lang: 0, vk: 0, vl: 0, mi: 0, poh: 0, cent: 0 }; return [x.dag, x.soort, x.uren, x.rol, x.bron, t.n, t.d, t.kort, t.middel, t.lang, t.vk, t.vl, t.mi, t.poh, t.cent]; });
        }
        // wv4218: waarnemers die alleen in DocPlan staan (geen eigen Promedico-naam): alleen hun roosterdagen, nooit afwezig, uren onbekend
        for (const [vid] of virt) {
          const dagen = perP.get(vid); if (!dagen || !dagen.size) continue;
          uitP[vid] = [...dagen.keys()].sort().map((d) => { const t = dagen.get(d); return [d, WEEKDAG(d) > 4 ? 'weekend' : 'gewerkt', null, 'waarnemer', 'docplan-rooster', t.n, t.d, t.kort, t.middel, t.lang, t.vk, t.vl, t.mi, t.poh, t.cent]; });
        }
        leeg.docplan.praktijken[pr.code] = { dagen_persoon: dpT.persoon.size, dagen_groep: [...dpT.groep].filter((d) => !dpT.persoon.has(d)).length, regels_persoon: dpT.regels_persoon, regels_groep: dpT.regels_groep, personen: dpT.wie.size };
        leeg.werkdagen[pr.code] = uitP;
        // Nmbrs-rooster per persoon (voor het scherm: welke uren gelden, en of de daguren een echt patroon zijn)
      }
      for (const p of personen) {
        const m = p.nmbrs ? nmVan.get(p.nmbrs) : null;
        p.nmbrs_rooster = m ? (m.rooster || []).map((r) => ({ begin: r.begin, uren: r.uren, dagen_per_week: r.dagen_per_week, dagen: nmbrsDagenEcht(r), dagen_ingevuld: Array.isArray(r.dagen1) })) : null;
        p.nmbrs_naam = m ? m.naam : null;
        p.nmbrs_entiteit = m ? m.entiteit : null;   // review MOET 1: Nmbrs-uren gelden alleen bij deze praktijk
      }
      // wv4218: DocPlan-waarnemers achteraan (negatieve id, docplan: true; niet te koppelen of te bewerken, geen rollen in PMA)
      for (const [vid, v] of [...virt].sort((a, b) => a[1].naam.localeCompare(b[1].naam, 'nl') || a[0] - b[0])) if (Object.values(leeg.werkdagen).some((w) => w[vid])) leeg.personen.push(Object.assign(v, { nmbrs_rooster: null, nmbrs_naam: null, nmbrs_entiteit: null }));
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
          r.knip = { tot: kd, inschrijf_cent: ins, verricht_cent: ver, codes: knipCodes(db, p, j1, kd, r.kwartalen.filter((q) => q <= kd)) };
        }
      }
      return uit;
    }, false);
  }
  // wv4217 (L29): dezelfde sommen als de knip, per code (aantal regels en bedrag; verrichtingen type V t/m die dag, inschrijfgeld + modules van de
  // kwartalen t/m die dag). Alleen code, naam, groep en tellingen: nooit een patiënt of registreerder. Som over de codes = knip-bedragen.
  function knipCodes(db, p, j1, kd, kwartalen) {
    const kaart = codeKaart(db), per = new Map();
    const zet = (code, n, c) => {
      const k = code == null || code === '' ? '' : String(code);
      if (!per.has(k)) { const i = kaart.get(k); per.set(k, { code: k, naam: i ? i.naam : (k || 'zonder code'), groep: i ? i.groep : 'nog-in-te-delen', n: 0, cent: 0 }); }
      const x = per.get(k); x.n += n; x.cent += c;
    };
    for (const x of db.prepare("SELECT code, COUNT(*) AS n, COALESCE(SUM(tarief_cent), 0) AS c FROM regel WHERE praktijk = ? AND type = 'V' AND dag >= ? AND dag <= ? GROUP BY code").all(p, j1, kd)) zet(x.code, x.n, x.c);
    const q = db.prepare('SELECT code, COUNT(*) AS n, COALESCE(SUM(tarief_cent), 0) AS c FROM inschrijf WHERE praktijk = ? AND peildatum = ? GROUP BY code');
    for (const d of kwartalen) for (const x of q.all(p, d)) zet(x.code, x.n, x.c);
    return [...per.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  }
  // wv4217: de indeling van codes in groepen (zoals Codes indelen), voor codes die alleen in de VIP-export staan; volgorde en namen van de groepen
  function indeling() {
    return metDb((db) => {
      const codes = {};
      for (const [c, i] of codeKaart(db)) codes[c] = { groep: i.groep, naam: i.naam };
      return { codes, groepen: GROEPEN.map((g) => ({ id: g, naam: GROEP_NAAM[g] })) };
    }, false);
  }
  function herbouw(praktijk) {
    return metDb((db) => {
      const ps = praktijk ? [praktijk] : db.prepare("SELECT DISTINCT praktijk FROM export WHERE stand = 'actief'").all().map((r) => r.praktijk);
      let n = 0; for (const p of ps) n += herbouwIn(db, p);
      return n;
    }, true);
  }
  // wv4219 (L31): per praktijk met data de laatste gedekte dag (alleen datums; geen databank = lege lijst)
  function dataTot() {
    return metDb((db) => {
      if (!db) return [];
      return db.prepare('SELECT d.praktijk AS code, p.naam AS naam, MAX(d.dag) AS data_tot FROM dagbron d LEFT JOIN praktijk p ON p.code = d.praktijk GROUP BY d.praktijk ORDER BY d.praktijk DESC').all()
        .map((r) => ({ code: r.code, naam: r.naam || r.code, data_tot: r.data_tot }));
    }, false);
  }
  return { app, info, herbouw, jaarBedragen, indeling, chatControleer, dataTot, _plan: plan, _pseudo: pseudo };   // wv4212: chatControleer
}

// ── wv4219 (besluitenpagina nr 931 = L31, David Ja 25-11-2026): exportherinnering. Puur (geen I/O, geen klok); server.js (nachtketenstap
// pma-export, 06:30) leest dataTot(), de open Voor jou-kaarten en de eigen staat, en voert uit wat dit teruggeeft. Ontwerp + Codex-
// ontwerpreview: mk-scripts/wv4219/ontwerp.md (GO-MET-WIJZIGINGEN, MOET 1 verwerkt: een oude kwartaalkaart blokkeert de nieuwe niet).
// Inschrijfgeld staat alleen op dag 1 van een kwartaal: een export die die dag mist, mist het inschrijfgeld.
//   a. eerste week van een kwartaal, een praktijk met data loopt tot vóór dag 1, nog geen kaart voor dit kwartaal, geen andere open
//      PMA-exportkaart (L26) → één kaart pma-kwartaal-<jaar>-q<n>; oude kwartaalkaarten die nog open staan gaan dan dicht.
//   b. kwartaalkaart open en alle praktijken met data bij tot dag 1 → kaart dicht met bewijs.
//   c. > 45 dagen achter en die data_tot nog niet gemeld → één regel voor het ochtendbericht (niet naast een open/nieuwe kwartaalkaart).
//   d. data bij: niets.
const EXPORT_ACHTER_DAGEN = 45, EXPORT_KAART_DAGEN = 7;
const KWARTAAL_SL_RE = /^pma-kwartaal-\d{4}-q[1-4]$/;
function dagNl(iso) { const [j, m, d] = String(iso).split('-').map(Number); return d + '-' + m + '-' + j; }
function dagenVerschil(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function kwartaalVan(dag) {
  const j = Number(dag.slice(0, 4)), q = Math.floor((Number(dag.slice(5, 7)) - 1) / 3) + 1;
  return { jaar: j, q, start: j + '-' + String((q - 1) * 3 + 1).padStart(2, '0') + '-01', sleutel: 'pma-kwartaal-' + j + '-q' + q };
}
function exportKaart(k, achter, vandaag) {
  const vorig = achter.filter((p) => p.data_tot < (k.jaar - 1) + '-12-31' && p.data_tot.slice(0, 4) === String(k.jaar - 1));
  const stappen = ['Exporteer in Promedico met de gegevensset PMA, per praktijk, van 1-1-' + k.jaar + ' t/m vandaag.'];
  if (k.q === 1 && vorig.length) stappen.push(vorig.map((p) => p.naam).join(' en ') + ': exporteer ook ' + (k.jaar - 1) + ' (1-1 t/m 31-12), want die cijfers lopen nu tot ' + vorig.map((p) => dagNl(p.data_tot)).join(' en ') + '.');
  stappen.push('Geef de ZIP in het gesprek aan Socev (paperclip): de pod controleert hem en je krijgt een link naar PMA. Of kies hem zelf in PMA bij Inlezen.');
  stappen.push('Tik in PMA bij Inlezen op Inlezen. Deze kaart gaat vanzelf dicht als het inschrijfgeld van dit kwartaal erin staat.');
  return {
    sleutel: k.sleutel, soort: 'doen', waar: 'pc', duur_min: 10,
    titel: 'PMA — nieuw kwartaal: export t/m vandaag inlezen',
    waarom: 'Het ' + k.q + 'e kwartaal van ' + k.jaar + ' is begonnen. Het inschrijfgeld staat alleen op de eerste dag van het kwartaal (' + dagNl(k.start) +
      '); PMA heeft van ' + achter.map((p) => p.naam + ' cijfers tot ' + dagNl(p.data_tot)).join(' en van ') + ', dus dat inschrijfgeld ontbreekt nog. Een export t/m vandaag (' + dagNl(vandaag) + ') heeft het wel.',
    stappen,
    herkomst: { module: 'pma', handmatig: 'pma-export', kwartaal: k.jaar + '-q' + k.q, doel: { scherm: 'pma' } },
  };
}
function exportHerinnering(o) {
  const vandaag = String(o.vandaag), st = o.staat && typeof o.staat === 'object' ? o.staat : {};
  const kaarten = Object.assign({}, st.kaarten || {}), gemeld = Object.assign({}, st.gemeld || {});
  const pr = (o.praktijken || []).filter((p) => p && p.data_tot);
  const open = (o.open || []).filter((x) => x && (x.status === 'open' || x.status === 'later'));
  const k = kwartaalVan(vandaag);
  const uit = { kaart: null, sluit: [], regel: null, staat: { dag: vandaag, kaarten, gemeld }, reden: [] };
  if (!pr.length) { uit.reden.push('geen data'); return uit; }
  const achter = pr.filter((p) => p.data_tot < k.start);
  const eigenOpen = open.find((x) => x.sleutel === k.sleutel);
  // b. kaart van dit kwartaal open en alles bij → dicht
  if (eigenOpen && !achter.length) uit.sluit.push({ sleutel: k.sleutel, van: eigenOpen.status, bewijs: 'Gezien: PMA heeft nu cijfers t/m ' + pr.map((p) => dagNl(p.data_tot)).join(' en ') + '.' });
  // a. kaart in de eerste week
  const ander = open.find((x) => !KWARTAAL_SL_RE.test(String(x.sleutel)) && /^PMA\b/i.test(String(x.titel || '')) && /export/i.test(String(x.titel || '')));
  if (achter.length && dagenVerschil(k.start, vandaag) < EXPORT_KAART_DAGEN && !kaarten[k.sleutel]) {
    if (ander) uit.reden.push('andere exportkaart open');
    else {
      uit.kaart = exportKaart(k, achter, vandaag);
      kaarten[k.sleutel] = vandaag;
      for (const x of open) if (KWARTAAL_SL_RE.test(String(x.sleutel)) && x.sleutel !== k.sleutel) uit.sluit.push({ sleutel: x.sleutel, van: x.status, bewijs: 'Vervangen door de kaart van het nieuwe kwartaal.' });
    }
  }
  // c. ochtendregel bij > 45 dagen achter, één keer per data_tot; niet naast de kwartaalkaart
  const lang = pr.filter((p) => dagenVerschil(p.data_tot, vandaag) > EXPORT_ACHTER_DAGEN && gemeld[p.code] !== p.data_tot);
  const kaartLoopt = !!uit.kaart || (!!eigenOpen && !uit.sluit.some((s) => s.sleutel === k.sleutel));
  if (lang.length && !kaartLoopt) {
    uit.regel = 'De cijfers van ' + lang.map((p) => p.naam + ' lopen tot ' + dagNl(p.data_tot) + ' (' + dagenVerschil(p.data_tot, vandaag) + ' dagen)').join(', die van ') +
      '. Een nieuwe export uit Promedico (gegevensset PMA, 1-1-' + k.jaar + ' t/m vandaag) maakt ze weer bij.';
    uit.regel_voor = lang.map((p) => ({ code: p.code, data_tot: p.data_tot }));   // pas na een gelukte melding in gemeld (server.js)
  }
  for (const c of Object.keys(kaarten)) if (c < 'pma-kwartaal-' + (k.jaar - 2)) delete kaarten[c];   // staat klein houden
  return uit;
}

// ── wv4220 (besluitenpagina nr 932 = L32, David Ja 25-11-2026): de brief na een inlezing. Puur: krijgt het praktijkobject uit overzicht()
// (hetzelfde dat het PMA-scherm krijgt) en rekent met de regels van het scherm (socev-app src/pma/pmaTekst.ts: periodes, dekking, somBakken,
// patientenTussen, per1000), zodat elk getal in de brief in PMA › Overzicht terug te vinden is. Alleen aantallen op praktijkniveau; nooit per
// patiënt of per medewerker. Ontwerp + Codex-ontwerpreview: mk-scripts/wv4220/ontwerp.md.
//   K = nieuwste kwartaal dat helemaal gedekt is (= de startperiode van het scherm); geen = het nieuwste met data ("deels").
//   V = het kwartaal ervoor; vergelijken alleen als K en V allebei helemaal gedekt zijn.
const BRIEF_MI_MIN = 10, BRIEF_MI_DREMPEL = 0.5;
function bMaandDagen(m) { const [j, mm] = m.split('-').map(Number); return new Date(Date.UTC(j, mm, 0)).getUTCDate(); }
function bKwMaanden(kw) { const j = kw.slice(0, 4), q = Number(kw.slice(6)); return [1, 2, 3].map((i) => j + '-' + String((q - 1) * 3 + i).padStart(2, '0')); }
function bKwVan(m) { const [j, mm] = m.split('-').map(Number); return j + '-K' + (Math.floor((mm - 1) / 3) + 1); }
function bKwVorig(kw) { const j = Number(kw.slice(0, 4)), q = Number(kw.slice(6)); return q === 1 ? (j - 1) + '-K4' : j + '-K' + (q - 1); }
function bDekking(p, maanden) {
  let heel = true, iets = false;
  for (const m of maanden) { const x = p.maanden.find((y) => y.maand === m); if (!x || !x.dagen_gedekt) { heel = false; continue; } iets = true; if (x.dagen_gedekt < x.dagen) heel = false; }
  return heel ? 'heel' : iets ? 'deels' : 'niets';
}
function bSom(p, maanden) {
  const u = { groepen: {}, sub: {}, n: 0, voorlopig: 0 };
  for (const x of p.maanden) {
    if (!maanden.includes(x.maand)) continue;
    for (const [g, v] of Object.entries(x.groepen || {})) { const t = u.groepen[g] || (u.groepen[g] = { n: 0, cent: 0 }); t.n += v.n; t.cent += v.cent; if (g !== 'niet-gedeclareerd') u.n += v.n; }
    for (const [k, v] of Object.entries(x.sub || {})) u.sub[k] = (u.sub[k] || 0) + v;
    u.voorlopig += x.voorlopig || 0;
  }
  return u;
}
function bPatienten(p, maanden) {
  const van = maanden[0] + '-01', l = maanden[maanden.length - 1], tot = l + '-' + String(bMaandDagen(l)).padStart(2, '0');
  const getal = (xs) => xs.map((k) => k.patienten).filter((n) => typeof n === 'number');
  const ks = p.kwartalen.filter((k) => k.peildatum >= van && k.peildatum <= tot);
  if (ks.length) { const g = getal(ks); return g.length ? g.reduce((a, n) => a + n, 0) / g.length : null; }
  const voor = getal(p.kwartalen.filter((k) => k.peildatum <= van));
  return voor.length ? voor[voor.length - 1] : null;
}
const bPer1000 = (n, pat) => (pat ? n / pat * 1000 : null);
function bNl(x, d) { const v = Math.round(x * Math.pow(10, d)) / Math.pow(10, d); const [h, f] = Math.abs(v).toFixed(d).split('.'); return (v < 0 ? '−' : '') + h.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (f && Number(f) ? ',' + f.replace(/0+$/, '') : ''); }
function bPct(nu, toen) { if (nu == null || !toen) return null; const v = (nu / toen - 1) * 100; return (v > 0 ? '+' : v < 0 ? '−' : '±') + bNl(Math.abs(v), 1) + ' %'; }
const bKwTekst = (kw) => 'K' + kw.slice(6) + ' ' + kw.slice(0, 4);
function brief(p, opt) {
  const o = opt || {};
  if (!p || !Array.isArray(p.maanden) || !Array.isArray(p.kwartalen)) return null;
  const kws = [...new Set(p.maanden.filter((m) => m.dagen_gedekt > 0).map((m) => bKwVan(m.maand)))].sort().reverse();
  if (!kws.length) return null;
  const K = kws.find((k) => bDekking(p, bKwMaanden(k)) === 'heel') || kws[0];
  const kHeel = bDekking(p, bKwMaanden(K)) === 'heel', V = bKwVorig(K), vHeel = kHeel && bDekking(p, bKwMaanden(V)) === 'heel';
  const s = bSom(p, bKwMaanden(K)), t = vHeel ? bSom(p, bKwMaanden(V)) : null;
  const pat = bPatienten(p, bKwMaanden(K)), patV = t ? bPatienten(p, bKwMaanden(V)) : null;
  const pr = String(p.code || '').toLowerCase(), kl = K.toLowerCase();
  const link = '/pma#overzicht/' + pr + '/' + kl, linkV = '/pma#overzicht/' + pr;
  const kt = bKwTekst(K) + (kHeel ? '' : ' (nog niet helemaal ingelezen)'), vt = 'vorig kwartaal';
  const regels = [];
  // 1. verrichtingen per 1000
  const v1 = bPer1000(s.n, pat), v1v = t ? bPer1000(t.n, patV) : null;
  regels.push({ id: 'per1000', link, tekst: v1 == null ? 'Verrichtingen ' + kt + ': ' + bNl(s.n, 0) + ' (geen patiëntenaantal bekend, dus geen per 1000).'
    : 'Verrichtingen ' + kt + ': ' + bNl(v1, 0) + ' per 1000 patiënten' + (v1v != null ? ' (' + vt + ' ' + bNl(v1v, 0) + '; ' + bPct(v1, v1v) + ')' : '') + '.' });
  // 2. aandeel lange consulten
  const cons = (x) => (x.sub['consult:kort'] || 0) + (x.sub['consult:middel'] || 0) + (x.sub['consult:lang'] || 0);
  const c = cons(s), lang = c ? (s.sub['consult:lang'] || 0) / c * 100 : null, cv = t ? cons(t) : 0, langV = cv ? (t.sub['consult:lang'] || 0) / cv * 100 : null;
  regels.push({ id: 'lang', link, tekst: lang == null ? 'Consulten van 20 minuten en langer: geen consulten in ' + kt + '.'
    : 'Consulten van 20 minuten en langer: ' + bNl(lang, 1) + ' % van ' + bNl(c, 0) + ' consulten' + (langV != null ? ' (' + vt + ' ' + bNl(langV, 1) + ' %; ' + (lang - langV >= 0 ? '+' : '−') + bNl(Math.abs(lang - langV), 1) + ' procentpunt)' : '') + '.' });
  // 3. ECG's per 1000
  const ecg = s.sub['mi:ECG'] || 0, e1 = bPer1000(ecg, pat), e1v = t ? bPer1000(t.sub['mi:ECG'] || 0, patV) : null;
  regels.push({ id: 'ecg', link, tekst: 'ECG\'s: ' + bNl(ecg, 0) + (e1 != null ? ', ' + bNl(e1, 1) + ' per 1000' : '') + (e1v != null ? ' (' + vt + ' ' + bNl(e1v, 1) + ')' : '') + '.' });
  // 4. M&I: grootste stijger en daler per soort (per 1000), alleen soorten met genoeg aantallen
  if (!t || pat == null || patV == null) regels.push({ id: 'mi', link, tekst: 'M&I: ' + bNl((s.groepen.mi || {}).n || 0, 0) + ' verrichtingen; ' + (t ? 'geen patiëntenaantal om te vergelijken' : 'het kwartaal ervoor is niet helemaal ingelezen, dus geen stijger of daler') + '.' });
  else {
    const soorten = new Set([...Object.keys(s.sub), ...Object.keys(t.sub)].filter((k) => k.startsWith('mi:')));
    const d = [...soorten].map((k) => ({ naam: k.slice(3), nu: s.sub[k] || 0, toen: t.sub[k] || 0 })).filter((x) => Math.max(x.nu, x.toen) >= BRIEF_MI_MIN)
      .map((x) => Object.assign(x, { delta: bPer1000(x.nu, pat) - bPer1000(x.toen, patV) })).sort((a, b) => b.delta - a.delta || (a.naam < b.naam ? -1 : 1));
    const op = d.length && d[0].delta >= BRIEF_MI_DREMPEL ? d[0] : null, af = d.length && d[d.length - 1].delta <= -BRIEF_MI_DREMPEL ? d[d.length - 1] : null;
    const zin = (x) => x.naam + ' ' + bNl(x.toen, 0) + ' → ' + bNl(x.nu, 0) + ' (' + (x.delta >= 0 ? '+' : '−') + bNl(Math.abs(x.delta), 1) + ' per 1000)';
    regels.push({ id: 'mi', link, tekst: !op && !af ? 'M&I: geen soort veranderde wezenlijk tegenover ' + vt + '.' : 'M&I tegenover ' + vt + ': ' + [op ? 'meeste groei ' + zin(op) : null, af ? 'grootste daling ' + zin(af) : null].filter(Boolean).join('; ') + '.' });
  }
  // 5. nog niet gefactureerd (alle ingelezen dagen, zoals Valt op)
  const vl = Number(p.voorlopig) || 0, oud = (p.valt_op && p.valt_op.voorlopig_oud && p.valt_op.voorlopig_oud.n) || 0;
  regels.push({ id: 'factuur', link: linkV, tekst: !vl ? 'Nog niet gefactureerd: niets; alles in de ingelezen dagen heeft een factuurdatum.'
    : 'Nog niet gefactureerd: ' + bNl(vl, 0) + (vl === 1 ? ' regel' : ' regels') + (oud ? ', waarvan ' + bNl(oud, 0) + ' bij de export al meer dan twee maanden oud' : '') + '.' });
  return { praktijk: p.code, naam: p.naam, kwartaal: K, heel: kHeel, vergeleken: !!t, data_tot: p.data_tot || null, link, regels, gemaakt: o.vandaag || null };
}

// ── wv4354 (besluitenpagina nr 932 = L32 stap 2, David Ja 25-11-2026 22:15): Socev beantwoordt PMA-vragen in de chat. Puur (geen I/O, geen
// klok): server.js (POST /smal/pma, skill pma-lezen) geeft het overzicht (= GET /app/pma, wat het scherm krijgt) en de vraag; dit telt met de
// regels van PMA › Overzicht (socev-app pmaTekst.ts: bakkenVan, somBakken, dekkingPeriode, patientenTussen, vorigJaar; Kengetallen/Verrichtingen),
// zodat het getal in de chat gelijk is aan het scherm. Alleen praktijk- en rolgroepniveau; per medewerker alleen als o.perMedewerker (schakelaar
// /opt/data/pma/chat.json, Davids keuze op een Voor jou-kaart). Nooit iets op patiëntniveau (het overzicht kent dat ook niet).
// Ontwerp + Codex-ontwerpreview: mk-scripts/wv4354/ontwerp.md.
const CHAT_MAAND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const CHAT_MND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const CHAT_ROLGROEP = { arts: 'Artsen (samen)', assistente: 'Assistentes', 'poh-s': 'POH-S', 'poh-ggz': 'POH-GGZ', ander: 'Anderen', los: 'Niet gekoppeld' };
const CHAT_ROLGROEP_ZIN = { arts: 'artsen (samen)', assistente: 'assistentes', 'poh-s': 'POH-S', 'poh-ggz': 'POH-GGZ', ander: 'anderen', los: 'niet gekoppeld' };
// wat → [soort, sleutel, naam]; soort g = groep, s = subgroep, x = bijzonder
const CHAT_WAT = {
  verrichtingen: ['x', 'n', 'Verrichtingen'], alles: ['x', 'n', 'Verrichtingen'],
  consulten: ['g', 'consult', 'Consulten'], consult: ['g', 'consult', 'Consulten'],
  'consult-kort': ['s', 'consult:kort', 'Consulten korter dan 5 min'], 'consult-middel': ['s', 'consult:middel', 'Consulten 5 tot 20 min'],
  'consult-lang': ['s', 'consult:lang', 'Consulten 20 min en langer'], 'consulten-20': ['s', 'consult:lang', 'Consulten 20 min en langer'],
  'aandeel-lang': ['x', 'lang', 'Aandeel consulten 20 min en langer'],
  visites: ['g', 'visite', 'Visites'], visite: ['g', 'visite', 'Visites'],
  'visite-kort': ['s', 'visite:kort', 'Visites korter dan 20 min'], 'visite-lang': ['s', 'visite:lang', 'Visites 20 min en langer'],
  'poh-ggz': ['g', 'poh-ggz', 'POH-GGZ'], mi: ['g', 'mi', 'M&I'], materiaal: ['g', 'materiaal', 'Materiaal'], overig: ['g', 'overig', 'Overig'],
  modules: ['g', 'module', 'Modules'], 'niet-gedeclareerd': ['g', 'niet-gedeclareerd', 'Niet gedeclareerd'], 'nog-in-te-delen': ['g', 'nog-in-te-delen', 'Nog in te delen'],
  inschrijfgeld: ['x', 'ig', 'Inschrijfgeld'], patienten: ['x', 'pat', 'Ingeschreven patiënten'],
};
const CHAT_ALIAS = { 'm&i': 'mi', 'm-en-i': 'mi', ggz: 'poh-ggz', pohggz: 'poh-ggz', 'poh ggz': 'poh-ggz', module: 'modules', patiënten: 'patienten', inschrijving: 'inschrijfgeld',
  'consulten-lang': 'consult-lang', 'lange-consulten': 'consult-lang', 'consult-20': 'consult-lang', 'consulten-20-min': 'consult-lang', 'visites-lang': 'visite-lang', 'visites-kort': 'visite-kort' };
class ChatFout extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || null; } }
function cWeekMaandag(week) {
  const j = Number(week.slice(0, 4)), n = Number(week.slice(6));
  const jan4 = Date.UTC(j, 0, 4, 12), wd = (new Date(jan4).getUTCDay() + 6) % 7;
  return new Date(jan4 + ((n - 1) * 7 - wd) * 864e5).toISOString().slice(0, 10);
}
function cMaandenVan(soort, w) {
  if (soort === 'maand') return [w];
  if (soort === 'week') { const a = cWeekMaandag(w), b = plusDag(a, 6); return a.slice(0, 7) === b.slice(0, 7) ? [a.slice(0, 7)] : [a.slice(0, 7), b.slice(0, 7)]; }
  const j = Number(w.slice(0, 4)), van = soort === 'kwartaal' ? (Number(w.slice(6)) - 1) * 3 + 1 : 1, tot = soort === 'kwartaal' ? van + 2 : 12, u = [];
  for (let m = van; m <= tot; m++) u.push(j + '-' + String(m).padStart(2, '0'));
  return u;
}
function cPeriodeDagen(soort, w) {
  if (soort === 'week') { const a = cWeekMaandag(w); return [a, plusDag(a, 6)]; }
  const ms = cMaandenVan(soort, w), l = ms[ms.length - 1];
  return [ms[0] + '-01', l + '-' + String(bMaandDagen(l)).padStart(2, '0')];
}
const cVorigJaar = (w) => String(Number(w.slice(0, 4)) - 1) + w.slice(4);
function cBakken(p, soort, w) { if (soort === 'week') return (p.weken || []).filter((x) => x.week === w); const ms = cMaandenVan(soort, w); return p.maanden.filter((m) => ms.includes(m.maand)); }
function cDekking(p, soort, w) {
  if (soort !== 'week') return bDekking(p, cMaandenVan(soort, w));
  const x = (p.weken || []).find((y) => y.week === w);
  return !x || !x.dagen_gedekt ? 'niets' : x.dagen_gedekt < x.dagen ? 'deels' : 'heel';
}
function cSom(bakken) {   // = somBakken van het scherm
  const u = { groepen: {}, sub: {}, subc: {}, voorlopig: 0, n: 0, cent: 0, dagen: 0, gedekt: 0, wd: {}, weekend: 0 };
  for (const x of bakken) {
    for (const [g, v] of Object.entries(x.groepen || {})) { const t = u.groepen[g] || (u.groepen[g] = { n: 0, cent: 0 }); t.n += v.n; t.cent += v.cent; if (g !== 'niet-gedeclareerd') { u.n += v.n; u.cent += v.cent; } }
    for (const [k, v] of Object.entries(x.sub || {})) u.sub[k] = (u.sub[k] || 0) + v;
    for (const [k, v] of Object.entries(x.subc || {})) u.subc[k] = (u.subc[k] || 0) + v;
    for (const [k, v] of Object.entries(x.wd || {})) { const t = u.wd[k] || (u.wd[k] = 0); u.wd[k] = t + v.reduce((a, n) => a + n, 0); }
    u.weekend += x.weekend || 0; u.voorlopig += x.voorlopig || 0; u.dagen += x.dagen || 0; u.gedekt += x.dagen_gedekt || 0;
  }
  return u;
}
function cPatienten(p, [van, tot]) {   // = patientenTussen van het scherm
  const getal = (xs) => xs.map((k) => k.patienten).filter((n) => typeof n === 'number');
  const ks = p.kwartalen.filter((k) => k.peildatum >= van && k.peildatum <= tot);
  if (ks.length) { const g = getal(ks); return g.length ? g.reduce((a, n) => a + n, 0) / g.length : null; }
  const voor = getal(p.kwartalen.filter((k) => k.peildatum <= van));
  return voor.length ? voor[voor.length - 1] : null;
}
function cInschrijfgeld(p, [van, tot]) {
  const ks = p.kwartalen.filter((k) => k.peildatum >= van && k.peildatum <= tot);
  if (!ks.length) return null;
  return ks.reduce((a, k) => a + k.inschrijfgeld.basis + k.inschrijfgeld.opslag + k.inschrijfgeld.modules + k.inschrijfgeld.jaarmodule, 0);
}
function cPeriodes(ps, soort) {
  const s = new Set();
  for (const p of ps) {
    if (soort === 'week') { for (const w of p.weken || []) if (w.dagen_gedekt > 0) s.add(w.week); continue; }
    for (const m of p.maanden) if (m.dagen_gedekt > 0) s.add(soort === 'maand' ? m.maand : soort === 'kwartaal' ? bKwVan(m.maand) : m.maand.slice(0, 4));
  }
  return [...s].sort().reverse();
}
// Periode uit Davids woorden; zonder jaar = de laatste met data. Geeft { soort, waarde } of gooit 400.
function chatPeriode(tekst, ps) {
  const t = String(tekst == null ? '' : tekst).trim().toLowerCase().replace(/\s+/g, ' ');
  const laatsteMet = (soort, pas) => cPeriodes(ps, soort).find(pas) || null;
  if (!t || t === 'laatste' || t === 'laatste kwartaal') {
    const lijst = cPeriodes(ps, 'kwartaal');
    const w = lijst.find((k) => ps.every((p) => cDekking(p, 'kwartaal', k) === 'heel')) || lijst[0];
    if (!w) throw new ChatFout(404, 'er is nog niets ingelezen');
    return { soort: 'kwartaal', waarde: w };
  }
  let m;
  if ((m = /^(\d{4})$/.exec(t))) return { soort: 'jaar', waarde: m[1] };
  if ((m = /^(\d{4})-(\d{2})$/.exec(t)) && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { soort: 'maand', waarde: t };
  if ((m = /^(\d{4})[- ]?[kq]([1-4])$/.exec(t))) return { soort: 'kwartaal', waarde: m[1] + '-K' + m[2] };
  if ((m = /^(\d{4})-?w(\d{1,2})$/.exec(t)) && Number(m[2]) >= 1 && Number(m[2]) <= 53) return { soort: 'week', waarde: m[1] + '-W' + String(Number(m[2])).padStart(2, '0') };
  if ((m = /^(?:[kq]|kwartaal )([1-4])(?: (\d{4}))?$/.exec(t))) {
    if (m[2]) return { soort: 'kwartaal', waarde: m[2] + '-K' + m[1] };
    const w = laatsteMet('kwartaal', (k) => k.endsWith('-K' + m[1]));
    if (!w) throw new ChatFout(404, 'geen K' + m[1] + ' met data');
    return { soort: 'kwartaal', waarde: w };
  }
  if ((m = /^week ?(\d{1,2})(?: (\d{4}))?$/.exec(t)) && Number(m[1]) >= 1 && Number(m[1]) <= 53) {
    const nn = String(Number(m[1])).padStart(2, '0');
    if (m[2]) return { soort: 'week', waarde: m[2] + '-W' + nn };
    const w = laatsteMet('week', (k) => k.endsWith('-W' + nn));
    if (!w) throw new ChatFout(404, 'geen week ' + Number(m[1]) + ' met data');
    return { soort: 'week', waarde: w };
  }
  if ((m = /^([a-z]+)\.?(?: (\d{4}))?$/.exec(t))) {
    let i = CHAT_MAAND.indexOf(m[1]); if (i < 0) i = CHAT_MND.indexOf(m[1].slice(0, 3)) >= 0 && m[1].length <= 4 ? CHAT_MND.indexOf(m[1].slice(0, 3)) : -1;
    if (m[1] === 'mar') i = 2;
    if (i >= 0) {
      const mm = String(i + 1).padStart(2, '0');
      if (m[2]) return { soort: 'maand', waarde: m[2] + '-' + mm };
      const w = laatsteMet('maand', (k) => k.endsWith('-' + mm));
      if (!w) throw new ChatFout(404, 'geen ' + CHAT_MAAND[i] + ' met data');
      return { soort: 'maand', waarde: w };
    }
  }
  throw new ChatFout(400, 'periode niet begrepen; gebruik jjjj, jjjj-Kn, jjjj-mm, jjjj-Wnn, een maandnaam, Kn, week n of laatste');
}
function chatPeriodeTekst(soort, w) {
  if (soort === 'maand') return CHAT_MAAND[Number(w.slice(5)) - 1] + ' ' + w.slice(0, 4);
  if (soort === 'kwartaal') return 'K' + w.slice(6) + ' ' + w.slice(0, 4);
  if (soort === 'week') { const a = cWeekMaandag(w), b = plusDag(a, 6); return 'week ' + Number(w.slice(6)) + ' ' + w.slice(0, 4) + ' (' + dagNl(a) + ' t/m ' + dagNl(b) + ')'; }
  return w;
}
const chatHash = (soort, w) => (soort === 'jaar' ? w : soort === 'kwartaal' ? w.slice(0, 4) + '-k' + w.slice(6) : soort === 'week' ? w.slice(0, 4) + '-w' + w.slice(6) : w);
function chatWat(lijst, ps) {
  const ruw = (Array.isArray(lijst) ? lijst : String(lijst == null ? '' : lijst).split(/[,;]/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const soorten = new Set();
  for (const p of ps) for (const b of p.maanden) for (const k of Object.keys(b.sub || {})) if (k.startsWith('mi:')) soorten.add(k.slice(3));
  const u = [], fout = [];
  for (const r0 of ruw.length ? ruw : ['verrichtingen']) {
    const r = CHAT_ALIAS[r0] || CHAT_ALIAS[r0.replace(/\s+/g, '-')] || r0.replace(/\s+/g, '-');
    if (CHAT_WAT[r]) { const [s, k, naam] = CHAT_WAT[r]; if (!u.some((x) => x.k === k && x.s === s)) u.push({ id: r, s, k, naam }); continue; }
    const mi = /^(?:mi[:-])?(.+)$/.exec(r)[1].replace(/-/g, ' ');
    const hit = [...soorten].find((x) => x.toLowerCase() === mi || (x.toLowerCase() === 'ecg' && /^ecg'?s?$/.test(mi)));
    if (hit) { if (!u.some((x) => x.k === 'mi:' + hit)) u.push({ id: 'mi:' + hit, s: 's', k: 'mi:' + hit, naam: hit }); continue; }
    fout.push(r0.slice(0, 40));
  }
  if (fout.length) throw new ChatFout(400, 'onbekend: ' + fout.join(', '), { kan: Object.keys(CHAT_WAT).concat([...soorten].sort().map((x) => 'mi:' + x)) });
  return u.slice(0, 12);
}
const cR = (x, d) => (x == null ? null : Math.round(x * Math.pow(10, d)) / Math.pow(10, d));
function chatWaarden(p, soort, w, wat) {
  const dagen = cPeriodeDagen(soort, w), s = cSom(cBakken(p, soort, w)), pat = cPatienten(p, dagen);
  const u = [];
  for (const x of wat) {
    if (x.k === 'pat') { u.push({ id: x.id, naam: x.naam, aantal: pat == null ? null : Math.round(pat) }); continue; }
    if (x.k === 'ig') { const c = cInschrijfgeld(p, dagen); u.push({ id: x.id, naam: x.naam, bedrag_eur: c == null ? null : Math.round(c / 100), kwartalen: p.kwartalen.filter((k) => k.peildatum >= dagen[0] && k.peildatum <= dagen[1]).map((k) => bKwTekst(bKwVan(k.peildatum.slice(0, 7)))) }); continue; }
    if (x.k === 'lang') {
      const c = (s.sub['consult:kort'] || 0) + (s.sub['consult:middel'] || 0) + (s.sub['consult:lang'] || 0);
      u.push({ id: x.id, naam: x.naam, procent: c ? cR((s.sub['consult:lang'] || 0) / c * 100, 1) : null, van_consulten: c }); continue;
    }
    const n = x.k === 'n' ? s.n : x.s === 'g' ? (s.groepen[x.k] || {}).n || 0 : s.sub[x.k] || 0;
    const cent = x.k === 'n' ? s.cent : x.s === 'g' ? (s.groepen[x.k] || {}).cent || 0 : s.subc[x.k];
    const p1 = bPer1000(n, pat);
    u.push({ id: x.id, naam: x.naam, aantal: n, bedrag_eur: cent == null ? null : Math.round(cent / 100), per_1000: p1 == null ? null : x.s === 's' && x.k.startsWith('mi:') ? cR(p1, 1) : Math.round(p1), _p1: p1 });
  }
  return { som: s, waarden: u, patienten: pat == null ? null : Math.round(pat) };
}
function chatDekTekst(p, soort, w, dek, s) {
  if (dek === 'heel') return 'helemaal ingelezen';
  if (dek === 'niets') return 'niets ingelezen';
  const [a, b] = cPeriodeDagen(soort, w), totaal = dagenVerschil(a, b) + 1;   // ook de maanden zonder enige data tellen mee
  return 'deels ingelezen (' + s.gedekt + ' van ' + totaal + ' dagen' + (p.data_tot ? '; data t/m ' + dagNl(p.data_tot) : '') + ')';
}
const cVerschil = (nu, toen) => (nu == null || toen == null || !toen ? null : cR((nu / toen - 1) * 100, 1));
function cGetal(x) { return x == null ? '–' : bNl(x, Number.isInteger(x) ? 0 : 1); }
function chatZinWaarde(v) {
  if (v.procent !== undefined) return v.naam.toLowerCase() + ' ' + (v.procent == null ? '–' : bNl(v.procent, 1) + ' %') + ' (van ' + bNl(v.van_consulten, 0) + ' consulten)';
  if (v.kwartalen !== undefined) return 'inschrijfgeld ' + (v.bedrag_eur == null ? 'geen (geen kwartaalbegin in deze periode)' : '€ ' + bNl(v.bedrag_eur, 0));
  if (v.id === 'patienten') return 'ingeschreven patiënten ' + cGetal(v.aantal);
  return v.naam.toLowerCase().replace(/^m&i$/, 'M&I').replace(/^poh-ggz$/, 'POH-GGZ').replace(/^ecg$/, 'ECG\'s') + ' ' + bNl(v.aantal, 0) + (v.per_1000 != null ? ' (' + cGetal(v.per_1000) + ' per 1000)' : '');
}
function chatVraag(ov, vraag, opt) {
  const q = vraag || {}, o = opt || {};
  try {
    if (!ov || !Array.isArray(ov.praktijken)) throw new ChatFout(503, 'PMA is nu niet te lezen');
    const pr = String(q.praktijk || 'beide').trim().toUpperCase().replace(/^TOLGAARDE$/, 'TG').replace(/^GROENHOUTEN$/, 'GH');
    if (!['TG', 'GH', 'BEIDE'].includes(pr)) throw new ChatFout(400, 'praktijk moet TG, GH of beide zijn');
    const ps = ov.praktijken.filter((p) => pr === 'BEIDE' || p.code === pr).filter((p) => Array.isArray(p.maanden) && p.maanden.some((m) => m.dagen_gedekt > 0));
    const bekend = Array.isArray(ov.bekend) && ov.bekend.length ? ov.bekend : Object.values(PRAKTIJKEN);
    const zonder = bekend.filter((b) => (pr === 'BEIDE' || b.code === pr) && !ps.some((p) => p.code === b.code)).map((b) => ({ praktijk: b.code, naam: b.naam, zin: b.naam + ': nog geen export ingelezen in PMA.' }));
    if (!ps.length) throw new ChatFout(404, pr === 'BEIDE' ? 'er is nog niets ingelezen' : (pr === 'TG' ? 'Tolgaarde' : 'Groenhouten') + ': nog geen export ingelezen');
    const per = String(q.per || 'praktijk').trim().toLowerCase();
    if (!['praktijk', 'rolgroep', 'medewerker'].includes(per)) throw new ChatFout(400, 'per moet praktijk, rolgroep of medewerker zijn');
    if ((per === 'medewerker' || (q.wie != null && String(q.wie).trim())) && !o.perMedewerker) {
      return { status: 403, body: { ok: false, geweigerd: 'per_medewerker', fout: 'Cijfers per medewerker noemt Socev niet in de chat; ze staan in PMA › Medewerkers.',
        links: ps.map((p) => ({ praktijk: p.code, link: '/pma#medewerkers/' + p.code.toLowerCase() })) } };
    }
    const { soort, waarde } = chatPeriode(q.periode, ps);
    const wat = per === 'praktijk' ? chatWat(q.wat, ps) : [];
    const vj = q.vorig_jaar === true || /^(ja|true|1|yes)$/i.test(String(q.vorig_jaar || ''));
    if (per === 'medewerker' && soort === 'week') throw new ChatFout(400, 'per medewerker alleen per maand, kwartaal of jaar (zoals het scherm)');
    const uit = [];
    for (const p of ps) {
      const dek = cDekking(p, soort, waarde), r = chatWaarden(p, soort, waarde, wat);
      const x = { praktijk: p.code, naam: p.naam, periode: waarde, periode_tekst: chatPeriodeTekst(soort, waarde), dekking: dek, dekking_tekst: chatDekTekst(p, soort, waarde, dek, r.som),
        data_van: p.data_van || null, data_tot: p.data_tot || null, link: '/pma#overzicht/' + p.code.toLowerCase() + '/' + chatHash(soort, waarde) };
      if (per === 'praktijk') {
        x.waarden = r.waarden;
        if (r.som.voorlopig) x.nog_niet_gefactureerd = r.som.voorlopig;
        if (vj) {
          const w2 = cVorigJaar(waarde), dek2 = cDekking(p, soort, w2);
          if (dek2 === 'niets') x.vorig_jaar = { periode: w2, periode_tekst: chatPeriodeTekst(soort, w2), dekking: 'niets', tekst: 'geen data van ' + chatPeriodeTekst(soort, w2) + ' in PMA' + (p.data_van ? ' (PMA heeft data vanaf ' + dagNl(p.data_van) + ')' : '') };
          else {
            const r2 = chatWaarden(p, soort, w2, wat), vergelijk = dek === 'heel' && dek2 === 'heel';
            x.vorig_jaar = { periode: w2, periode_tekst: chatPeriodeTekst(soort, w2), dekking: dek2, dekking_tekst: chatDekTekst(p, soort, w2, dek2, r2.som), waarden: r2.waarden, vergeleken: vergelijk };
            // zoals de tegels: verschil alleen als beide periodes helemaal gedekt zijn; per 1000 met de ongeronde waarden
            if (vergelijk) r.waarden.forEach((v, i) => { const t = r2.waarden[i];
              if (v.procent !== undefined) { if (v.procent != null && t.procent != null) v.verschil_procentpunt = cR(v.procent - t.procent, 1); return; }
              if (v.aantal !== undefined && v.kwartalen === undefined) v.verschil_pct = cVerschil(v.aantal, t.aantal);
              if (v._p1 != null && t._p1 != null) v.verschil_per_1000_pct = cVerschil(v._p1, t._p1);
              if (v.kwartalen !== undefined) v.verschil_pct = cVerschil(v.bedrag_eur, t.bedrag_eur); });
            for (const v of r2.waarden) delete v._p1;
          }
        }
        for (const v of x.waarden) delete v._p1;
        const delen = x.waarden.map(chatZinWaarde);
        let zin = p.naam + ', ' + x.periode_tekst + ': ' + delen.join('; ') + (dek === 'heel' ? '' : ' — ' + x.dekking_tekst) + '.';
        if (x.vorig_jaar) zin += x.vorig_jaar.dekking === 'niets' ? ' Een jaar eerder: ' + x.vorig_jaar.tekst + '.'
          : ' Een jaar eerder (' + x.vorig_jaar.periode_tekst + (x.vorig_jaar.dekking === 'heel' ? '' : ', ' + x.vorig_jaar.dekking_tekst) + '): ' + x.vorig_jaar.waarden.map(chatZinWaarde).join('; ') + '.';
        x.zin = zin;
      } else if (per === 'rolgroep') {
        x.rolgroepen = Object.keys(CHAT_ROLGROEP).filter((k) => r.som.wd[k]).map((k) => ({ rolgroep: k, naam: CHAT_ROLGROEP[k], verrichtingen_ma_vr: r.som.wd[k] }));
        x.weekend = r.som.weekend;
        x.uitleg = 'verrichtingen maandag t/m vrijdag per rolgroep (artsen altijd samen), zoals PMA › Overzicht › week en weekdag; weekend apart';
        x.zin = p.naam + ', ' + x.periode_tekst + ' (ma–vr): ' + x.rolgroepen.map((g) => CHAT_ROLGROEP_ZIN[g.rolgroep] + ' ' + bNl(g.verrichtingen_ma_vr, 0)).join('; ') + (x.weekend ? '; weekend ' + bNl(x.weekend, 0) : '') + (dek === 'heel' ? '' : ' — ' + x.dekking_tekst) + '.';
      } else {
        const ms = cMaandenVan(soort, waarde), wie = q.wie ? kaal(q.wie) : '';
        const regs = (p.registreerders || []).map((g) => { const t = { kort: 0, middel: 0, lang: 0, visite_kort: 0, visite_lang: 0, mi: 0, poh: 0, overig: 0, totaal: 0 };
          for (const m of g.maanden) if (ms.includes(m.maand)) for (const k of Object.keys(t)) t[k] += m[k] || 0; return Object.assign({ naam: g.naam, groep: g.soort === 'verzamel' }, t); })
          .filter((g) => g.totaal > 0 && (!wie || kaal(g.naam).includes(wie))).sort((a, b) => (a.naam < b.naam ? -1 : 1));
        x.medewerkers = regs.slice(0, 40); x.meer = Math.max(0, regs.length - 40);
        x.uitleg = 'per naam zoals Promedico de regel boekt (wie boekte, niet altijd wie het werk deed), zoals PMA › Overzicht › per registreerder';
        x.link_medewerkers = '/pma#medewerkers/' + p.code.toLowerCase();
      }
      uit.push(x);
    }
    return { status: 200, body: Object.assign({ ok: true, per, soort, periode: waarde, praktijken: uit }, zonder.length ? { zonder_data: zonder } : {}) };
  } catch (e) {
    if (e instanceof ChatFout) return { status: e.status, body: Object.assign({ ok: false, fout: e.message }, e.extra || {}) };
    throw e;
  }
}

module.exports = { isoWeek, ROLGROEP, waarnemerDagen, dpId, maak, leesZip, splitsCsv, leesExport, LeesFout, GROEPEN, CODES_START, PRAKTIJKEN, ROLLEN, werkdagenVan, ontleedNaam, lijkt, rolUit, feestdagen, nmbrsDagenEcht, exportHerinnering, kwartaalVan, brief, chatVraag, chatPeriode };
