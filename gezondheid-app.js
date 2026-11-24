// gezondheid-app.js — App Gezondheid (wv937, David 23-10-2026: "We moeten de health pod ook nog toegankelijk maken via een App hier
// in OVIS"). Alleen lezen. Haalt Davids eigen gegevens bij de health-pod (metingen, dossier, AI-rapporten, bloedgroep, dragerschap) en
// de knie-app (revalidatie, medicatie vandaag) en bouwt het antwoord veld voor veld op: nooit een object van de health-pod of de knie-app
// doorgeven. server.js geeft het door aan GET /app/gezondheid en GET /app/gezondheid/genoom. Ontwerp + Fable-review: mk-scripts/wv937.
//
// Toegang (ontwerp § 4, Fable wv937): alleen de LEESSLEUTEL + het doorgeefgeheim uit /opt/data/bin/socev-health-lezen.env (het bestand dat
// alleen die twee bevat), naar de vaste host van de health-pod (dezelfde allowlist als de skill hp.py), alleen https, geen redirects,
// alleen vaste GET-paden (de app kiest geen pad of query). De knie-app met het bestaande Socev-servicetoken (knie-app-access.env), ook
// alleen GET /api/samenvatting. Een ander adres kan alleen met een eigen sleutelbestand en http op 127.0.0.1 (de toets).
// Opgaven schrijft dit bestand niet: de App vult het gesprek met Davids eigen zin en Socev gebruikt de bestaande opgaveroute (skill
// health-pod, opgavenpagina + /smal/health-opgaven). Fable wv937 #11: geen tweede schrijfweg.
// Fouten: per blok (metingen, dossier, rapporten, knie) een vaste soort, nooit de foutbody van de pod of de knie-app (Fable #10).
'use strict';
const fs = require('fs'), http = require('http'), https = require('https');

const STANDAARD_URL = 'https://health.primumnonnocere.olares.com/api';
const POD_HOSTS = ['health.primumnonnocere.olares.com', '614c87b1.primumnonnocere.olares.com'];
const STANDAARD_SLEUTELS = '/opt/data/bin/socev-health-lezen.env';
const KNIE_STANDAARD = 'https://knie.socev.dev';
const KNIE_STANDAARD_SLEUTELS = '/opt/data/.ssh/knie-app-access.env';
const LINKS = { pod: 'https://health.primumnonnocere.olares.com/', knie: 'https://knie.socev.dev/' };
const MAX_BYTES = 2 * 1024 * 1024;   // per antwoord (rapporten ± 160 kB, metingenoverzicht ± 110 kB)
const PER_AANROEP_MS = 15000;        // samen onder de 25 s van de Pages Function (Fable #1): alle aanroepen tegelijk

// Volgorde en Nederlandse namen. Wat de pod niet kent, staat er niet; een onbekende soort krijgt zijn eigen naam zonder _.
const VOORAAN = ['gewicht', 'rusthartslag', 'slaapduur', 'stappen', 'hrv', 'saturatie'];
const NAMEN = {
  gewicht: 'Gewicht', rusthartslag: 'Rusthartslag', slaapduur: 'Slaap', stappen: 'Stappen', hrv: 'Hartslagvariabiliteit (hrv)',
  saturatie: 'Zuurstofsaturatie', hrv_diepe_slaap: 'Hrv in diepe slaap', ademfrequentie: 'Ademfrequentie', afstand: 'Afstand',
  actieve_calorieen: 'Actieve calorieën', calorieen_totaal: 'Calorieën totaal', actieve_minuten: 'Actieve minuten',
  actieve_zoneminuten: 'Zoneminuten', hartslag_dag_gem: 'Hartslag daggemiddelde', huidtemperatuur_afwijking: 'Huidtemperatuur (afwijking)',
  huidtemperatuur_nacht: 'Huidtemperatuur nacht', inslaaptijd: 'Inslaaptijd', lengte: 'Lengte', vetpercentage: 'Vetpercentage',
  slaap_diep: 'Diepe slaap', slaap_licht: 'Lichte slaap', slaap_rem: 'Remslaap', slaap_wakker: 'Wakker in de nacht', tijd_in_bed: 'Tijd in bed',
  trainingsduur: 'Trainingsduur', verdiepingen: 'Verdiepingen', vo2max: 'VO2max', vo2max_hardlopen: 'VO2max hardlopen', zittijd: 'Zittijd',
  lenssterkte_links: 'Lenssterkte links', lenssterkte_rechts: 'Lenssterkte rechts', naevi_een_been: 'Moedervlekken (één been)',
  legpress_8_herhalingen: 'Legpress (8 herhalingen)', knie_flexie_rechts: 'Kniebuiging rechts', pijnscore_knie: 'Pijnscore knie',
  bloeddruk_systolisch: 'Bloeddruk boven', bloeddruk_diastolisch: 'Bloeddruk onder', lichaamstemperatuur: 'Temperatuur',
};
const GENOOM_ONDERDELEN = ['farmacogenetica', 'kanker', 'hartvaten', 'stofwisseling', 'genetica_overig', 'genoom'];
const KANTTEKENING_FG = 'Check het originele rapport en de actuele DPWG/CPIC-richtlijn vóór een voorschrijfbeslissing.';

// ── kleine helpers: alleen gewone waarden door, met een lengtegrens ──
const tekst = (v, n) => (typeof v === 'string' ? v.slice(0, n || 300) : v == null ? null : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const getal = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const heel = (v) => (Number.isInteger(v) ? v : null);
const lijst = (v) => (Array.isArray(v) ? v : []);
const teksten = (v, max, n) => lijst(v).filter((x) => typeof x === 'string').slice(0, max).map((x) => x.slice(0, n || 600));
const naamVan = (s) => NAMEN[s] || String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

class GezFout extends Error { constructor(soort) { super(soort); this.soort = soort; } }

// ── adres en sleutels ──
function adresToegestaan(basis, sleutels, standaard, hosts) {
  let u;
  try { u = new URL(basis); } catch (e) { return false; }
  if (u.protocol === 'https:' && hosts.indexOf(u.hostname) >= 0 && !u.username && !u.password && (u.port === '' || u.port === '443')) return true;
  // proef: alleen met een eigen sleutelbestand, en dan alleen naar de eigen machine
  let eigen = true;
  try { eigen = fs.realpathSync(sleutels) !== fs.realpathSync(standaard); } catch (e) { eigen = sleutels !== standaard; }
  return eigen && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}
function leesSleutels(bestand) {
  let t;
  try { t = fs.readFileSync(bestand, 'utf8'); } catch (e) { throw new GezFout('sleutel'); }
  const uit = {};
  t.split('\n').forEach(function (r) { const m = /^([A-Z_]+)=(.*)$/.exec(r.trim()); if (m) uit[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2'); });
  return uit;
}

// Eén GET, zonder redirect (http.request volgt nooit), met tijdgrens en bodylimiet. Gooit GezFout met een vaste soort.
function haal(basis, pad, koppen, ms) {
  return new Promise(function (klaar, faal) {
    let u;
    try { u = new URL(basis.replace(/\/$/, '') + pad); } catch (e) { return faal(new GezFout('adres')); }
    const mod = u.protocol === 'https:' ? https : http;
    let af = false;
    // Totaalgrens (Fable wv937 diff #2): `timeout` van http.request is een stilte-grens; een druppelend antwoord houdt hem anders open.
    const klok = setTimeout(function () { if (af) return; af = true; req.destroy(); faal(new GezFout('tijdgrens')); }, ms);
    const req = mod.request(u, { method: 'GET', headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'socev-app-gezondheid' }, koppen), timeout: ms },
      function (res) {
        const st = res.statusCode || 0;
        let n = 0; const delen = [];
        res.on('data', function (c) { if (af) return; n += c.length; if (n > MAX_BYTES) { af = true; clearTimeout(klok); req.destroy(); return faal(new GezFout('te groot')); } delen.push(c); });
        res.on('end', function () {
          clearTimeout(klok);
          if (af) return;
          if (st >= 300 && st < 400) return faal(new GezFout('weigert'));   // een redirect volgen we nooit
          if (st === 502 || st === 503 || st === 504) return faal(new GezFout('weg'));
          if (st !== 200) return faal(new GezFout(st === 401 || st === 403 ? 'weigert' : 'fout ' + st));
          let j;
          try { j = JSON.parse(Buffer.concat(delen).toString('utf8')); } catch (e) { return faal(new GezFout('geen json')); }   // Access-loginpagina e.d.
          klaar(j);
        });
        res.on('error', function () { clearTimeout(klok); if (!af) { af = true; faal(new GezFout('weg')); } });
      });
    req.on('timeout', function () { clearTimeout(klok); if (af) return; af = true; req.destroy(); faal(new GezFout('tijdgrens')); });
    req.on('error', function () { clearTimeout(klok); if (!af) { af = true; faal(new GezFout('weg')); } });
    req.end();
  });
}

// ── opbouw: veld voor veld ──
function metingRij(m) {
  if (!m || typeof m !== 'object') return null;
  return { waarde: getal(m.waarde), tijdstip: tekst(m.tijdstip, 40), precisie: tekst(m.precisie, 20), bron: tekst(m.bron, 120), context: tekst(m.context, 200) };
}
const apparaat = (m) => !!m && m.bron === 'Google';
function metingenBlok(o) {
  const soorten = lijst(o && o.soorten).filter((s) => s && typeof s.soort === 'string' && /^[a-z0-9_]{1,60}$/.test(s.soort));
  const uit = soorten.map(function (s) {
    const laatste = metingRij(s.laatste);
    // Valkuil van de skill: `laatste` kan een handopgave zijn (vragenlijst); dan ook de jongste apparaatmeting met datum.
    let laatsteApp = null;
    if (s.laatste && !apparaat(s.laatste)) laatsteApp = metingRij(lijst(s.recent).find(apparaat));
    const reeks = s.reeks && typeof s.reeks === 'object' ? {
      per: tekst(s.reeks.per, 20),
      punten: lijst(s.reeks.punten).slice(-150).map((p) => ({ t: tekst(p && p.t, 30), w: getal(p && p.w) })).filter((p) => p.t && p.w !== null),
    } : null;
    return { soort: s.soort, naam: naamVan(s.soort), eenheid: tekst(s.eenheid, 20), aantal: heel(s.aantal), eerste: tekst(s.eerste, 40),
      laatste: laatste, laatste_apparaat: laatsteApp, bronnen: teksten(s.bronnen, 6, 120), reeks: reeks };
  });
  uit.sort(function (a, b) {
    const ia = VOORAAN.indexOf(a.soort), ib = VOORAAN.indexOf(b.soort);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.naam.localeCompare(b.naam, 'nl');
  });
  return uit.map((m) => Object.assign(m, { kern: VOORAAN.indexOf(m.soort) >= 0 }));
}
function herkomst(r) { return { id: heel(r.id), bron_id: heel(r.bron_id), run_id: tekst(r.run_id, 80), vastgelegd_op: tekst(r.vastgelegd_op, 40), citaat: tekst(r.bron_citaat, 300) }; }
function gebeurtenissenBlok(o) {
  const r = lijst(o && o.rijen).map((g) => ({ soort: tekst(g.soort, 40), datum: tekst(g.datum, 40), omschrijving: tekst(g.omschrijving, 600), status: tekst(g.status, 120), herkomst: herkomst(g) }));
  // gepland eerst (wat er aankomt), dan de rest, jongste bovenaan (datum is tekst: '2014/2016', '2026-11-05')
  const gepland = (g) => /^gepland/i.test(g.status || '') ? 0 : 1;
  return r.sort((a, b) => gepland(a) - gepland(b) || String(b.datum || '').localeCompare(String(a.datum || '')));
}
function diagnosesBlok(o) {
  return lijst(o && o.rijen).map((d) => ({ omschrijving: tekst(d.omschrijving, 600), status: tekst(d.status, 120), begin: tekst(d.begin, 40), eind: tekst(d.eind, 40),
    zijde: tekst(d.zijde, 20), code: tekst(d.code, 40), herkomst: herkomst(d) }));
}
function medicatieBlok(o) {
  return lijst(o && o.rijen).map((m) => ({ middel: tekst(m.middel, 120), dosering: tekst(m.dosering, 120), start: tekst(m.start, 40), stop: tekst(m.stop, 40), status: tekst(m.status, 200), herkomst: herkomst(m) }));
}
// Een rapporttekst: alleen bij controle `geslaagd` (skill: "alleen teksten met controle geslaagd"), anders titel + status.
function rapportBlok(o, metAdviezen) {
  const t = o && o.tekst;
  if (!t || typeof t !== 'object') return { naam: tekst(o && o.naam, 80), onderdeel: tekst(o && o.onderdeel, 40), controle: null, beweringen: [] };
  const geslaagd = t.controle === 'geslaagd' && t.actueel !== false;
  const uit = { naam: tekst(o.naam, 80), onderdeel: tekst(o.onderdeel, 40), rapport_id: heel(t.id), titel: tekst(t.titel, 200), controle: tekst(t.controle, 40),
    schrijver: tekst(t.schrijver, 60), controleur: tekst(t.controleur, 60), vastgelegd_op: tekst(t.vastgelegd_op, 40), beweringen: [] };
  if (!geslaagd) return uit;
  uit.beweringen = lijst(t.beweringen).filter((b) => b && b.ingetrokken !== true).slice(0, 30).map((b) => ({
    id: tekst(b.id, 20), tekst: tekst(b.tekst, 1500), uitleg: tekst(b.uitleg, 1500), details: teksten(b.details, 12, 800), rijen: teksten(b.rijen, 200, 60) }));
  if (metAdviezen) uit.adviezen = lijst(t.adviezen).slice(0, 20).map((a) => ({ id: tekst(a && a.id, 20), advies: tekst(a && a.advies, 1500), soort: tekst(a && a.soort, 80),
    redenering: tekst(a && a.redenering, 2000), onderbouwing: teksten(a && a.onderbouwing, 20, 60) }));
  return uit;
}
function dnaRij(r) {
  return { gen: tekst(r.gen, 40), genotype: tekst(r.genotype, 80), fenotype: tekst(r.fenotype, 300), classificatie: tekst(r.classificatie, 120),
    klinisch_bevestigd: r.klinisch_bevestigd === 1 || r.klinisch_bevestigd === true, kanttekening: tekst(r.kanttekening, 300), uitleg: tekst(r.uitleg, 800),
    herkomst: herkomst(r) };
}
// Knie-app: wat de App laat zien, nooit doseeradvies (alleen wat en wanneer; Capaciteiten handmatig:knie-app).
function knieBlok(k) {
  if (!k || typeof k !== 'object') return null;
  const v = k.vandaag || {}, med = k.medicatie || {};
  const hs = lijst(k.heelslides), laatsteHs = hs.length ? hs[hs.length - 1] : null;
  return {
    datum: tekst(v.datum, 20), dag_na_ok: heel(v.dag_na_ok), fase: tekst(v.fase_id, 60), gepland: heel(v.gepland), gedaan: heel(v.gedaan), overgeslagen: heel(v.overgeslagen),
    compex_gepland: heel(v.compex_gepland), compex_gedaan: heel(v.compex_gedaan), pijn_gemiddeld_7d: getal(k.pijn_gemiddeld_7d),
    heelslide: laatsteHs ? { datum: tekst(laatsteHs.datum, 20), tijd: tekst(laatsteHs.tijd, 10), graden: getal(laatsteHs.graden) } : null,
    medicatie: lijst(med.per_middel).slice(0, 8).map((m) => ({ naam: tekst(m.naam, 60), vandaag_aantal: heel(m.vandaag_aantal), vandaag_mg: getal(m.vandaag_mg),
      laatste: m.laatste && typeof m.laatste === 'object' ? { datum: tekst(m.laatste.datum, 20), tijd: tekst(m.laatste.tijd, 10) } : null })),
    mijlpalen: lijst(k.komende_mijlpalen).slice(0, 3).map((m) => ({ datum: tekst(m.datum, 20), titel: tekst(m.titel, 200), ongeveer: !!(m && m.ongeveer) })),
  };
}

// ── wv3936 (besluitenpagina nr 164 = 2C64, David Ja 22-11): "Deze week" — gewoon rekenen, geen taalmodel ──
// Per soort de dagwaarden van de laatste 7 hele dagen (t/m gisteren; vandaag is nog niet af) tegen de 8 weken (56 dagen) ervoor.
// Eén waarde per dag: twee apparaten (Pixel Watch + band) geven elk een rusthartslag/hrv → gemiddelde van die dag; slaap en stappen →
// de grootste rij van die dag (dubbele sessie of een dutje telt nooit op). Onvolledige nachten (< 3 uur) en dagen zonder dragen
// (< 300 stappen) tellen niet mee. "Je eigen normaal" = de band tussen het laagste en hoogste weekgemiddelde van die 8 weken. Een
// afwijking is alleen: de slechte kant op, buiten die band EN minstens de vaste drempel; te weinig dagen = geen oordeel.
const WEEK_SOORTEN = [
  { soort: 'slaapduur', naam: 'Slaap', kort: 'slaap', eenheid: 'uur', slecht: 'lager', abs: 0.75, dag: 'max', min: 3, max: 16 },
  { soort: 'rusthartslag', naam: 'Rusthartslag', kort: 'rusthartslag', eenheid: 'bpm', slecht: 'hoger', abs: 4, dag: 'gem', min: 30, max: 130 },
  { soort: 'hrv', naam: 'Herstel (hrv)', kort: 'hrv', eenheid: 'ms', slecht: 'lager', rel: 0.15, dag: 'gem', min: 1, max: 300 },
  { soort: 'stappen', naam: 'Beweging', kort: 'stappen', eenheid: 'stappen', slecht: 'lager', rel: 0.3, dag: 'max', min: 300, max: 100000 },
];
const WEEK_MIN_DAGEN = 4, BASIS_MIN_DAGEN = 28, BAND_MIN_WEKEN = 5, BAND_WEEK_MIN_DAGEN = 3;
const DAG_RE = /^\d{4}-\d{2}-\d{2}$/;
function dagPlus(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function dagenTussen(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
const gem = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const rond = (v, n) => { const f = Math.pow(10, n); return Math.round(v * f) / f; };
// Kalenderdag in Nederland: een datum zonder tijd blijft zoals hij is; een tijdstip met zone (Z of +hh:mm) gaat naar Europe/Amsterdam
// (Codex MOET 1, ronde 2). Gemeten 24-11: de vier soorten komen als datum zonder tijd binnen.
function dagNL(t) {
  if (typeof t !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(t)) { const ms = Date.parse(t); return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }) : null; }
  return t.slice(0, 10);
}
// rijen: [{ t, w }] van één soort → { dag: waarde } binnen [van, tot], plus hoeveel dagen wel rijen hadden maar geen geldige waarde
function dagwaarden(rijen, s, van, tot) {
  const per = {};
  lijst(rijen).forEach(function (r) {
    const d = r ? dagNL(r.t) : null, w = r ? getal(r.w) : null;
    if (!d || !DAG_RE.test(d) || d < van || d > tot || w === null) return;
    (per[d] = per[d] || []).push(w);
  });
  const uit = {}; let weg = 0;
  Object.keys(per).forEach(function (d) {
    const v = per[d].filter((w) => w >= s.min && w <= s.max);
    if (!v.length) { weg++; return; }
    uit[d] = s.dag === 'max' ? Math.max.apply(null, v) : gem(v);
  });
  return { per: uit, weg: weg };
}
function weekSoort(rijen, s, vandaag) {
  const eind = dagPlus(vandaag, -1), weekVan = dagPlus(eind, -6), basisTot = dagPlus(eind, -7), basisVan = dagPlus(eind, -62);
  const w = dagwaarden(rijen, s, weekVan, eind), b = dagwaarden(rijen, s, basisVan, basisTot);
  const wv = Object.values(w.per), bv = Object.values(b.per);
  const uit = { soort: s.soort, naam: s.naam, eenheid: s.eenheid, slecht: s.slecht, week: { van: weekVan, tot: eind, dagen: wv.length, gem: null, weggelaten: w.weg },
    basis: { van: basisVan, tot: basisTot, dagen: bv.length, gem: null, lo: null, hi: null, weken: 0 }, verschil: null, drempel: null, richting: 'onbekend', afwijking: false };
  if (wv.length < WEEK_MIN_DAGEN || bv.length < BASIS_MIN_DAGEN) return uit;
  const wg = gem(wv), bg = gem(bv);
  // de 8 basisweken, elk van 7 dagen terug vanaf basisTot; een week telt met minstens 3 geldige dagen
  const weken = [];
  for (let k = 0; k < 8; k++) {
    const tot = dagPlus(basisTot, -7 * k), van = dagPlus(tot, -6);
    const v = Object.keys(b.per).filter((d) => d >= van && d <= tot).map((d) => b.per[d]);
    if (v.length >= BAND_WEEK_MIN_DAGEN) weken.push(gem(v));
  }
  const drempel = s.abs != null ? s.abs : s.rel * bg;
  const verschil = wg - bg;
  const lo = weken.length >= BAND_MIN_WEKEN ? Math.min.apply(null, weken) : bg - drempel;
  const hi = weken.length >= BAND_MIN_WEKEN ? Math.max.apply(null, weken) : bg + drempel;
  const buiten = wg > hi ? 'hoger' : wg < lo ? 'lager' : null;
  const richting = buiten && Math.abs(verschil) >= drempel ? buiten : 'normaal';
  const n = s.soort === 'stappen' ? 0 : s.soort === 'slaapduur' ? 2 : 1;
  Object.assign(uit.week, { gem: rond(wg, n) });
  Object.assign(uit.basis, { gem: rond(bg, n), lo: rond(lo, n), hi: rond(hi, n), weken: weken.length });
  uit.verschil = rond(verschil, n); uit.drempel = rond(drempel, n); uit.richting = richting; uit.afwijking = richting === s.slecht;
  return uit;
}
// reeksen: { soort: [{t,w}] } (null = niet te lezen); gebeurtenissen: uitvoer van gebeurtenissenBlok (of null); vandaag: 'JJJJ-MM-DD'
function weekBlok(reeksen, gebeurtenissen, vandaag) {
  if (!reeksen || !DAG_RE.test(String(vandaag))) return null;
  const soorten = WEEK_SOORTEN.map((s) => weekSoort(reeksen[s.soort], s, vandaag));
  let afspraak = null;
  if (Array.isArray(gebeurtenissen)) {
    const komt = gebeurtenissen.filter((g) => g && /^gepland/i.test(g.status || '') && DAG_RE.test(String(g.datum || '').slice(0, 10)) && String(g.datum).slice(0, 10) >= vandaag)
      .sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
    if (komt.length) afspraak = { datum: komt[0].datum.slice(0, 10), omschrijving: komt[0].omschrijving, over_dagen: dagenTussen(vandaag, komt[0].datum.slice(0, 10)) };
  }
  return { vandaag: vandaag, soorten: soorten, afwijkingen: soorten.filter((x) => x.afwijking).map((x) => x.soort), afspraak: afspraak,
    afspraken_te_lezen: Array.isArray(gebeurtenissen) };
}
const nl = (v, n) => (n === 0 ? Math.round(v).toLocaleString('nl-NL') : Number(v).toFixed(n).replace('.', ','));
function weekWaarde(x, v) {
  if (x.soort === 'slaapduur') { const m = Math.round(v * 60); return Math.floor(m / 60) + ' u ' + String(m % 60).padStart(2, '0'); }
  if (x.soort === 'stappen') return nl(Math.round(v / 100) * 100, 0) + ' stappen';
  return nl(v, 0) + ' ' + x.eenheid;
}
// één regel voor het ochtendbericht, alleen bij een afwijking (anders null); alleen = de soorten die nieuw zijn (Codex ZOU 1: een eerder
// gemelde afwijking komt niet opnieuw mee als er een andere bijkomt)
function weekRegel(dw, alleen) {
  if (!dw) return null;
  const a = dw.soorten.filter((x) => x.afwijking && (!Array.isArray(alleen) || alleen.indexOf(x.soort) >= 0));
  if (!a.length) return null;
  const delen = a.map(function (x) {
    const s = WEEK_SOORTEN.find((y) => y.soort === x.soort);
    return s.kort + ' ' + weekWaarde(x, x.week.gem) + (x.soort === 'slaapduur' ? ' per nacht' : ' per dag') + ' tegen je normaal ' + weekWaarde(x, x.basis.gem);
  });
  const zin = delen.join('; ');
  return 'Deze week afwijkend: ' + zin + '. Gemiddelde van de laatste 7 dagen tegen de 8 weken ervoor.';
}
// Herhaal geen melding: een soort die in de 7 dagen vóór vandaag al gemeld is, telt niet als nieuw. gemeld: { soort: 'JJJJ-MM-DD' }.
// Een soort die berekend weer normaal is, valt uit gemeld (de volgende afwijking is dan weer nieuws); bij "onbekend" (te weinig metingen)
// blijft de melddatum staan (Codex ZOU 2: anders telt dezelfde afwijking na een gat binnen 7 dagen opnieuw als nieuw).
function weekNieuw(dw, gemeld, vandaag) {
  const g = gemeld && typeof gemeld === 'object' ? gemeld : {};
  const af = dw ? dw.afwijkingen : [];
  const recent = (s) => typeof g[s] === 'string' && DAG_RE.test(g[s]) && dagenTussen(g[s], vandaag) < 7 && dagenTussen(g[s], vandaag) >= 0;
  const nieuw = af.filter((s) => !recent(s));
  const onbekend = dw ? dw.soorten.filter((x) => x.richting === 'onbekend').map((x) => x.soort) : Object.keys(g);
  const uit = {};
  Object.keys(g).forEach(function (s) { if (onbekend.indexOf(s) >= 0 && recent(s)) uit[s] = g[s]; });
  af.forEach(function (s) { uit[s] = nieuw.indexOf(s) >= 0 ? vandaag : g[s]; });
  return { nieuw: nieuw, gemeld: uit };
}

// ── de module ──
function maak(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const basis = String(env.HEALTH_POD_URL || STANDAARD_URL).replace(/\/+$/, '');
  const sleutels = env.HEALTH_POD_SLEUTELS || STANDAARD_SLEUTELS;
  const knieBasis = String(env.KNIE_APP_URL || KNIE_STANDAARD).replace(/\/+$/, '');
  const knieSleutels = env.KNIE_APP_SLEUTELS || KNIE_STANDAARD_SLEUTELS;
  const fout = typeof o.fout === 'function' ? o.fout : function () {};
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const ms = Number(env.GEZONDHEID_MS) || PER_AANROEP_MS;
  const RAPPORT_MS = 30 * 60000;   // /rapporten verandert 's nachts en na een correctie; 30 min (Fable #10)
  let rapCache = null;             // { op, j } — alleen in het geheugen
  const tellers = { gelezen: 0, fouten: 0, laatst_ok: null, laatst_fout: null };

  function pod(pad) {
    if (!adresToegestaan(basis, sleutels, STANDAARD_SLEUTELS, POD_HOSTS)) return Promise.reject(new GezFout('adres'));
    let s;
    try { s = leesSleutels(sleutels); } catch (e) { return Promise.reject(e); }
    if (!s.HEALTH_LEZENSLEUTEL) return Promise.reject(new GezFout('sleutel'));
    const koppen = { Authorization: 'Bearer ' + s.HEALTH_LEZENSLEUTEL };
    if (s.HEALTH_DOORGEEFGEHEIM) koppen['X-Health-Doorgeef'] = s.HEALTH_DOORGEEFGEHEIM;
    return haal(basis, pad, koppen, ms);
  }
  function knie() {
    if (!adresToegestaan(knieBasis, knieSleutels, KNIE_STANDAARD_SLEUTELS, ['knie.socev.dev'])) return Promise.reject(new GezFout('adres'));
    let s;
    try { s = leesSleutels(knieSleutels); } catch (e) { return Promise.reject(e); }
    if (!s.KNIE_APP_ACCESS_CLIENT_ID || !s.KNIE_APP_ACCESS_CLIENT_SECRET) return Promise.reject(new GezFout('sleutel'));
    return haal(knieBasis, '/api/samenvatting', { 'CF-Access-Client-Id': s.KNIE_APP_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': s.KNIE_APP_ACCESS_CLIENT_SECRET }, ms);
  }
  let rapLoopt = null;             // lopende aanroep: Overzicht en Genoom tegelijk = één keer /rapporten (Fable diff #12)
  function rapporten() {
    if (rapCache && nu() - rapCache.op < RAPPORT_MS) return Promise.resolve(rapCache.j);
    if (!rapLoopt) rapLoopt = pod('/rapporten').then(function (j) { rapCache = { op: nu(), j: j }; return j; }).finally(function () { rapLoopt = null; });
    return rapLoopt;
  }
  // Elk blok apart: een fout maakt alleen dat blok leeg en noemt de soort (geen foutbody, geen inhoud in de log).
  async function blokken(spec) {
    const namen = Object.keys(spec);
    const r = await Promise.allSettled(namen.map((n) => spec[n]()));
    const uit = { fouten: [] };
    r.forEach(function (x, i) {
      if (x.status === 'fulfilled') uit[namen[i]] = x.value;
      else {
        const soort = x.reason instanceof GezFout ? x.reason.soort : 'fout';
        uit[namen[i]] = null; uit.fouten.push({ blok: namen[i], soort: soort });
        if (!(x.reason instanceof GezFout)) fout('gezondheid-' + namen[i], new Error('onverwacht'));
      }
    });
    tellers.gelezen++;
    if (uit.fouten.length) { tellers.fouten++; tellers.laatst_fout = new Date(nu()).toISOString(); } else tellers.laatst_ok = new Date(nu()).toISOString();
    return uit;
  }
  const podBlokken = ['metingen', 'gebeurtenissen', 'diagnoses', 'medicatie', 'rapporten', 'bloedgroep', 'dragerschap'];
  const allesWeg = (b) => b.fouten.filter((f) => podBlokken.indexOf(f.blok) >= 0).length === Object.keys(b).filter((k) => podBlokken.indexOf(k) >= 0).length;

  // wv3936: datum in Nederland; de dagwaarden van de vier soorten van "Deze week" (63 dagen terug, vaste paden; soort en datum kiest de pod zelf)
  function vandaagAms() { return new Date(nu()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
  async function weekReeksen() {
    const van = dagPlus(vandaagAms(), -64);
    const r = await Promise.all(WEEK_SOORTEN.map((s) => pod('/metingen?soort=' + s.soort + '&van=' + van + '&limiet=2000')));
    const uit = {};
    WEEK_SOORTEN.forEach(function (s, i) {
      if (!r[i] || !Array.isArray(r[i].rijen)) throw new GezFout('vorm');
      uit[s.soort] = r[i].rijen.map((x) => ({ t: tekst(x && x.tijdstip, 40), w: getal(x && x.waarde) }));
    });
    return uit;
  }
  // voor de nachtstap gezondheid-week (server.js): alleen "Deze week"; gooit als de metingen niet te lezen zijn (geen oordeel = geen regel)
  async function week() {
    const b = await blokken({ week: weekReeksen, gebeurtenissen: () => pod('/gebeurtenissen') });
    if (!b.week) throw new GezFout((b.fouten.find((f) => f.blok === 'week') || {}).soort || 'fout');
    return weekBlok(b.week, b.gebeurtenissen ? gebeurtenissenBlok(b.gebeurtenissen) : null, vandaagAms());
  }
  async function overzicht() {
    const b = await blokken({
      metingen: () => pod('/metingen/overzicht'), gebeurtenissen: () => pod('/gebeurtenissen'), diagnoses: () => pod('/diagnoses'),
      medicatie: () => pod('/medicatie'), rapporten: rapporten, knie: knie, week: weekReeksen,
    });
    if (allesWeg(b)) return { status: 503, j: { ok: false, fout: 'De health-pod is nu niet bereikbaar; probeer het over een paar minuten.', pod_weg: true } };
    const rap = b.rapporten;
    return { status: 200, j: {
      ok: true,
      metingen: b.metingen ? metingenBlok(b.metingen) : null,
      lopend: { gebeurtenissen: b.gebeurtenissen ? gebeurtenissenBlok(b.gebeurtenissen) : null, diagnoses: b.diagnoses ? diagnosesBlok(b.diagnoses) : null,
        medicatie: b.medicatie ? medicatieBlok(b.medicatie) : null },
      knie: b.knie ? knieBlok(b.knie) : null,
      deze_week: b.week ? weekBlok(b.week, b.gebeurtenissen ? gebeurtenissenBlok(b.gebeurtenissen) : null, vandaagAms()) : null,
      totaal: rap && rap.totaal ? rapportBlok(rap.totaal, false) : null,
      advies: rap && rap.advies ? rapportBlok(rap.advies, true) : null,
      links: LINKS, fouten: b.fouten,
    } };
  }
  async function genoom() {
    const b = await blokken({
      rapporten: rapporten, bloedgroep: () => pod('/dna-basis?categorie=bloedgroep'), dragerschap: () => pod('/dna-basis?categorie=dragerschap'),
    });
    if (allesWeg(b)) return { status: 503, j: { ok: false, fout: 'De health-pod is nu niet bereikbaar; probeer het over een paar minuten.', pod_weg: true } };
    const ond = b.rapporten ? lijst(b.rapporten.onderdelen) : [];
    const kant = (b.bloedgroep && b.bloedgroep.kanttekening) || (b.dragerschap && b.dragerschap.kanttekening);
    return { status: 200, j: {
      ok: true,
      onderdelen: b.rapporten ? GENOOM_ONDERDELEN.map((n) => ond.find((x) => x && x.onderdeel === n)).filter(Boolean).map((x) => rapportBlok(x, false)) : null,
      bloedgroep: b.bloedgroep ? lijst(b.bloedgroep.rijen).map(dnaRij) : null,
      dragerschap: b.dragerschap ? lijst(b.dragerschap.rijen).map(dnaRij) : null,
      kanttekening: tekst(kant, 600), kanttekening_farmacogenetica: KANTTEKENING_FG,
      links: LINKS, fouten: b.fouten,
    } };
  }
  return {
    overzicht: overzicht, genoom: genoom, week: week, weekRegel: weekRegel, weekNieuw: weekNieuw,
    leeg: function () { rapCache = null; },
    health: function () { return Object.assign({ aan: true, adres_ok: adresToegestaan(basis, sleutels, STANDAARD_SLEUTELS, POD_HOSTS), rapporten_cache: !!rapCache }, tellers); },
  };
}

module.exports = { maak: maak, _t: { dagNL, weekBlok, weekSoort, weekRegel, weekNieuw, dagwaarden, WEEK_SOORTEN, metingenBlok, gebeurtenissenBlok, diagnosesBlok, medicatieBlok, rapportBlok, dnaRij, knieBlok, adresToegestaan, naamVan, LINKS } };
