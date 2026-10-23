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
    const req = mod.request(u, { method: 'GET', headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'socev-app-gezondheid' }, koppen), timeout: ms },
      function (res) {
        const st = res.statusCode || 0;
        let n = 0; const delen = [];
        res.on('data', function (c) { n += c.length; if (n > MAX_BYTES) { af = true; req.destroy(); return faal(new GezFout('te groot')); } delen.push(c); });
        res.on('end', function () {
          if (af) return;
          if (st >= 300 && st < 400) return faal(new GezFout('weigert'));   // een redirect volgen we nooit
          if (st === 502 || st === 503 || st === 504) return faal(new GezFout('weg'));
          if (st !== 200) return faal(new GezFout(st === 401 || st === 403 ? 'weigert' : 'fout ' + st));
          let j;
          try { j = JSON.parse(Buffer.concat(delen).toString('utf8')); } catch (e) { return faal(new GezFout('geen json')); }   // Access-loginpagina e.d.
          klaar(j);
        });
        res.on('error', function () { if (!af) { af = true; faal(new GezFout('weg')); } });
      });
    req.on('timeout', function () { af = true; req.destroy(); faal(new GezFout('tijdgrens')); });
    req.on('error', function () { if (!af) { af = true; faal(new GezFout('weg')); } });
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
    zin: tekst(k.tekst, 1200),
  };
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
  function rapporten() {
    if (rapCache && nu() - rapCache.op < RAPPORT_MS) return Promise.resolve(rapCache.j);
    return pod('/rapporten').then(function (j) { rapCache = { op: nu(), j: j }; return j; });
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

  async function overzicht() {
    const b = await blokken({
      metingen: () => pod('/metingen/overzicht'), gebeurtenissen: () => pod('/gebeurtenissen'), diagnoses: () => pod('/diagnoses'),
      medicatie: () => pod('/medicatie'), rapporten: rapporten, knie: knie,
    });
    if (allesWeg(b)) return { status: 503, j: { ok: false, fout: 'De health-pod is nu niet bereikbaar; probeer het over een paar minuten.', pod_weg: true } };
    const rap = b.rapporten;
    return { status: 200, j: {
      ok: true,
      metingen: b.metingen ? metingenBlok(b.metingen) : null,
      lopend: { gebeurtenissen: b.gebeurtenissen ? gebeurtenissenBlok(b.gebeurtenissen) : null, diagnoses: b.diagnoses ? diagnosesBlok(b.diagnoses) : null,
        medicatie: b.medicatie ? medicatieBlok(b.medicatie) : null },
      knie: b.knie ? knieBlok(b.knie) : null,
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
    overzicht: overzicht, genoom: genoom,
    leeg: function () { rapCache = null; },
    health: function () { return Object.assign({ aan: true, adres_ok: adresToegestaan(basis, sleutels, STANDAARD_SLEUTELS, POD_HOSTS), rapporten_cache: !!rapCache }, tellers); },
  };
}

module.exports = { maak: maak, _t: { metingenBlok, gebeurtenissenBlok, diagnosesBlok, medicatieBlok, rapportBlok, dnaRij, knieBlok, adresToegestaan, naamVan, LINKS } };
