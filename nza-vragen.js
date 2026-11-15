'use strict';
// OVIS NZa fase 3a (wv3156, 15-11-2026): tab "Vragen" — elk antwoord van de NZa-agent (kanaal ovis-nza) wordt een vraagdraad die David
// terugvindt, waarop hij doorvraagt (in dezelfde draad) en die hij downloadt (md/pdf/docx via de bestaande omzetter POST /app/omzet).
// David 15-11-2026 17:45 ("Mooie analyse die hij gaf!"), Ja 21:07. Opslag: één JSON per draad in /opt/data/ovis-nza/vragen/ (map 0700,
// bestand 0600, alleen de pod: de agent hoeft er niet bij — de pod zet de draad zelf als context in de prompt van een doorvraag). Niet in de
// vault en niet in de dossiermap 10_Zakelijk/DBH/Bronnen. De bron van waarheid blijft het app-log (app-log/ovis-nza.jsonl, 30 dagen):
// lijst() neemt elke regel die nog niet in een draad staat alsnog op (eerste keer: wat David al vroeg; daarna: een schrijffout of een
// herstart vangt zich zo vanzelf op). Een regel met veld `draad` (doorvraag) komt in die draad; zonder = een nieuwe draad.
// Plek voor rij B (Dubbelcheck, wv3157): elke wisseling heeft `aanhangsels: []`; zetAanhangsel() voegt er één toe ({soort, t, model, md}).
// Geen patiëntgegevens in het dossier; geen tekst uit een draad in een logregel (alleen id's en tellingen).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DRAAD_RE = /^d-[a-f0-9]{16}$/;
const JOB_RE = /^[a-f0-9]{16}$/;
const MAX_WISSELINGEN = 30;            // per draad: daarna weigert appBeurt een doorvraag (context().vol); opslaan gooit nooit iets weg
const MAX_OPSLAG = 2 * MAX_WISSELINGEN; // vangnet: een draad groeit niet eindeloos; erboven = eigen draad (niets weg; Codex wv3156 MOET 1)
const CONTEXT_VRAAG_MAX = 2000;        // een vraag in de context hooguit zo lang (Codex ZOU 1)
const MAX_ANTWOORD = 60000;            // zelfde grens als het app-log
const MAX_VRAAG = 8000;
const CONTEXT_MAX = 40000;             // tekens draadcontext in de prompt van een doorvraag
const MAX_AANHANGSEL = 60000;

function draadIdVan(jobId) { return 'd-' + jobId; }

// Bronlinks van het NZa-scherm uit het antwoord: [label](/nza#stuk=…&plek=…) — ook absoluut (https://…/nza#…)
function bronnenUit(md) {
  const uit = [], gezien = new Set();
  const re = /\[([^\]\n]{0,300})\]\(\s*(?:https?:\/\/[^\s/)]+)?(\/nza#[^)\s]{1,600})\s*\)/g;
  let m;
  while ((m = re.exec(String(md || ''))) && uit.length < 200) {
    const hash = m[2].slice(m[2].indexOf('#') + 1);
    let p;
    try { p = new URLSearchParams(hash); } catch (e) { continue; }
    const stuk = p.get('stuk') || '';
    if (!/^[a-z0-9][a-z0-9.-]{0,120}$/.test(stuk)) continue;
    const plek = (p.get('plek') || '').slice(0, 80);
    const sleutel = stuk + '|' + plek;
    if (gezien.has(sleutel)) continue;
    gezien.add(sleutel);
    uit.push({ stuk: stuk, plek: plek || undefined, label: m[1].replace(/\s+/g, ' ').trim().slice(0, 200), link: '/nza#' + hash });
  }
  return uit;
}

function nietInDossier(md) { return /niet in het dossier/i.test(String(md || '')); }

function eersteRegel(md) {
  // eerste regel tekst (geen kopje, geen tabelrand); alleen kopjes = het eerste kopje
  const schoon = function (x) { return x.replace(/^[#>*\-\s|]+/, '').replace(/[*_`|]+/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim(); };
  const regels = String(md || '').split('\n').filter(function (x) { return x.trim() && !/^\s*\|?[\s:|-]+\|?\s*$/.test(x); });
  const tekst = regels.find(function (x) { return !/^\s*#/.test(x) && schoon(x); });
  const r = schoon(tekst || regels[0] || '');
  return r.length > 160 ? r.slice(0, 157) + '…' : r;
}

function maak(opts) {
  const map = opts.map;
  const leesAppLog = opts.leesAppLog;                       // async () => [regels van app-log/ovis-nza.jsonl]
  const leesNzaLog = opts.leesNzaLog || function () { return []; };   // () => [regels van log/vragen.jsonl van de agent], best effort
  const nu = opts.nu || function () { return Date.now(); };
  const ketting = {};                                        // per draad één schrijver tegelijk
  let importBezig = null;

  function zekerMap() { fs.mkdirSync(map, { recursive: true, mode: 0o700 }); }
  function pad(id) { return path.join(map, id + '.json'); }
  function lees(id) {
    if (!DRAAD_RE.test(id)) return null;
    try { const d = JSON.parse(fs.readFileSync(pad(id), 'utf8')); return d && d.id === id && Array.isArray(d.wisselingen) ? d : null; }
    catch (e) { return null; }
  }
  function schrijf(d) {
    zekerMap();
    const tmp = pad(d.id) + '.nieuw.' + process.pid + '.' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    fs.renameSync(tmp, pad(d.id));
  }
  function alle() {
    let namen = [];
    try { namen = fs.readdirSync(map); } catch (e) { return []; }
    return namen.filter(function (n) { return /^d-[a-f0-9]{16}\.json$/.test(n); }).map(function (n) { return lees(n.slice(0, -5)); }).filter(Boolean);
  }
  function opBeurt(id, f) {
    const deze = (ketting[id] || Promise.resolve()).then(f, f);
    const staart = deze.then(function () {}, function () {});
    ketting[id] = staart;
    staart.then(function () { if (ketting[id] === staart) delete ketting[id]; });
    return deze;
  }

  // Wat de agent zelf in nza.py log zette (bronnen als tekst, niet_in_dossier), als er precies één regel in het tijdvak van de beurt valt.
  function logBij(getypt, klaar) {
    let rijen;
    try { rijen = leesNzaLog() || []; } catch (e) { return null; }
    const van = Date.parse(getypt || '') - 60000, tot = Date.parse(klaar || '') + 60000;
    if (!(van > 0) || !(tot > van)) return null;
    const raak = rijen.filter(function (r) {
      if (!r || typeof r.t !== 'string') return false;
      // nza.py schrijft lokale tijd op minuten zonder zone; de zone van het agentproces is niet vast (UTC of Nederland): elk van de drie telt
      const t0 = Date.parse(r.t.replace(' ', 'T') + 'Z');
      if (!(t0 > 0)) return false;
      return [0, 3600000, 7200000].some(function (o) { const t = t0 - o; return t >= van - 60000 && t <= tot; });
    });
    if (raak.length !== 1) return null;
    const r = raak[0];
    return { bronnen: Array.isArray(r.bronnen) ? r.bronnen.slice(0, 60).map(function (b) { return String(b).slice(0, 200); }) : [], niet_in_dossier: r.niet_in_dossier === true };
  }

  function wisselingVan(r) {
    const antwoord = String(r.antwoord || '');
    const ok = r.ok !== false && !!antwoord;
    const w = {
      job_id: r.job_id, vraag: String(r.tekst || '').slice(0, MAX_VRAAG), getypt: r.getypt || r.t, t: r.t || new Date(nu()).toISOString(),
      ok: ok, antwoord: ok ? antwoord.slice(0, MAX_ANTWOORD) : '', fout: ok ? undefined : String(r.fout || 'geen antwoord').slice(0, 200),
      bronnen: ok ? bronnenUit(antwoord) : [], niet_in_dossier: ok ? nietInDossier(antwoord) : false, aanhangsels: [],
    };
    const lg = ok ? logBij(w.getypt, w.t) : null;
    if (lg) { w.log = lg; if (lg.niet_in_dossier) w.niet_in_dossier = true; }
    return w;
  }

  // Na een beurt in kanaal ovis-nza (appNaBeurt) of bij het inhalen uit het app-log. Geeft het draad-id of null.
  async function naAntwoord(r) {
    if (!r || !JOB_RE.test(String(r.job_id || ''))) return null;
    if (r.soort && r.soort !== 'bericht') return null;      // knop/tel/telegram komen hier niet voor; alleen getypte vragen
    const doel = r.draad && DRAAD_RE.test(r.draad) ? r.draad : null;
    if (!doel && (r.ok === false || !r.antwoord)) return null;   // een mislukte eerste vraag wordt geen draad
    const id = doel || draadIdVan(r.job_id);
    return opBeurt(id, async function () {
      let d = lees(id);
      if (d && d.wisselingen.some(function (w) { return w.job_id === r.job_id; })) return id;
      if (!d) {
        if (doel && !fs.existsSync(pad(doel))) {
          // doorvraag op een draad die niet (meer) bestaat: dan een eigen draad, niets weggooien
          return naAntwoord(Object.assign({}, r, { draad: undefined }));
        }
        d = { id: id, versie: 1, gemaakt: r.getypt || r.t || new Date(nu()).toISOString(), wisselingen: [] };
      }
      if (d.wisselingen.length >= MAX_OPSLAG) return naAntwoord(Object.assign({}, r, { draad: undefined }));   // nooit stil weg
      d.wisselingen.push(wisselingVan(r));
      d.wisselingen.sort(function (a, b) { return Date.parse(a.getypt || a.t) - Date.parse(b.getypt || b.t); });
      d.bijgewerkt = new Date(nu()).toISOString();
      schrijf(d);
      return id;
    });
  }

  // Alles uit het app-log dat nog in geen draad staat (fail-open: een leesfout geeft gewoon de draden die er zijn).
  async function inhalen() {
    if (importBezig) return importBezig;
    importBezig = (async function () {
      let regels = [];
      try { regels = (await leesAppLog()) || []; } catch (e) { regels = []; }
      if (!regels.length) return 0;
      const bekend = new Set();
      alle().forEach(function (d) { d.wisselingen.forEach(function (w) { bekend.add(w.job_id); }); });
      let n = 0;
      // eerst de eerste vragen, dan de doorvragen (die hun draad nodig hebben)
      const open = regels.filter(function (r) { return r && JOB_RE.test(String(r.job_id || '')) && !bekend.has(r.job_id) && (!r.soort || r.soort === 'bericht'); });
      open.sort(function (a, b) { return (a.draad ? 1 : 0) - (b.draad ? 1 : 0) || Date.parse(a.getypt || a.t) - Date.parse(b.getypt || b.t); });
      for (const r of open) { if (await naAntwoord(r)) n++; }
      return n;
    })();
    try { return await importBezig; } finally { importBezig = null; }
  }

  function samenvatting(d) {
    const w0 = d.wisselingen[0] || {}, wl = d.wisselingen[d.wisselingen.length - 1] || {};
    const laatsteOk = d.wisselingen.slice().reverse().find(function (w) { return w.ok; });
    return { id: d.id, vraag: String(w0.vraag || '').slice(0, 300), gemaakt: d.gemaakt, laatst: wl.t || d.bijgewerkt || d.gemaakt,
      eerste_regel: laatsteOk ? eersteRegel(laatsteOk.antwoord) : '', wisselingen: d.wisselingen.length,
      bronnen: d.wisselingen.reduce(function (a, w) { return a + (w.bronnen ? w.bronnen.length : 0); }, 0),
      niet_in_dossier: d.wisselingen.some(function (w) { return w.niet_in_dossier; }),
      aanhangsels: d.wisselingen.reduce(function (a, w) { return a + (w.aanhangsels ? w.aanhangsels.length : 0); }, 0) };
  }

  async function lijst() {
    await inhalen();
    const l = alle().map(samenvatting);
    l.sort(function (a, b) { return Date.parse(b.laatst) - Date.parse(a.laatst); });
    return l;
  }

  function tijdNl(iso) {
    const t = Date.parse(iso || '');
    if (!(t > 0)) return '';
    try { return new Date(t).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
  }

  // De draad als markdown (download; ook de bron voor pdf en docx via /app/omzet). Bronlinks absoluut als er een basis is.
  function markdown(d, basis) {
    const b = typeof basis === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(basis) ? basis : '';
    const abs = function (t) { return b ? String(t).replace(/\]\(\s*(\/nza#)/g, '](' + b + '$1') : String(t); };
    const regels = ['# OVIS NZa — ' + (String((d.wisselingen[0] || {}).vraag || 'vraag').split('\n')[0].slice(0, 120)), '',
      '_Vraagdraad ' + d.id + ' · ' + d.wisselingen.length + (d.wisselingen.length === 1 ? ' vraag' : ' vragen') + ' · ' + tijdNl(d.gemaakt) +
      '. Antwoorden van OVIS NZa, alleen uit het NZa-dossier; een citaat is pas gecontroleerd met het vinkje in het NZa-scherm._', ''];
    d.wisselingen.forEach(function (w, i) {
      regels.push('## ' + (i === 0 ? 'Vraag' : 'Doorvraag ' + i) + ' · ' + tijdNl(w.getypt || w.t), '');
      regels.push(String(w.vraag || '').split('\n').map(function (x) { return '> ' + x; }).join('\n'), '');
      regels.push('### Antwoord · ' + tijdNl(w.t), '');
      regels.push(w.ok ? abs(w.antwoord) : '_Geen antwoord: ' + (w.fout || 'onbekend') + '_', '');
      (w.aanhangsels || []).forEach(function (a) {
        regels.push('### ' + (a.titel || (a.soort === 'dubbelcheck' ? 'Dubbelcheck' : 'Aanhangsel')) + ' · ' + tijdNl(a.t) + (a.model ? ' · ' + a.model : ''), '');
        regels.push(abs(String(a.md || '')), '');
      });
    });
    return regels.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  async function draad(id) {
    await inhalen();
    const d = lees(id);
    return d ? { draad: d, samenvatting: samenvatting(d) } : null;
  }

  // Context voor de prompt van een doorvraag: eerdere vragen en antwoorden van deze draad (DATA), jongste het volledigst.
  function context(id) {
    const d = lees(id);
    if (!d) return null;
    const ws = d.wisselingen.filter(function (w) { return w.ok; });
    if (!ws.length) return null;
    if (d.wisselingen.length >= MAX_WISSELINGEN) return { vol: true };
    // Het hele blok (vragen + antwoorden) binnen CONTEXT_MAX: van jong naar oud; past een ouder antwoord niet meer heel, dan ingekort; past
    // ook de vraag niet meer, dan stopt het daar (oudere wisselingen weggelaten, met een regel). De jongste vraag+antwoord gaan altijd mee.
    const delen = ws.map(function (w, i) {
      const v = String(w.vraag || '');
      return { kop: (i === 0 ? 'Vraag' : 'Doorvraag ' + i) + ' (' + tijdNl(w.getypt || w.t) + '): ' + (v.length > CONTEXT_VRAAG_MAX ? v.slice(0, CONTEXT_VRAAG_MAX) + ' […]' : v), a: w.antwoord };
    });
    let ruimte = CONTEXT_MAX;
    const mee = [];
    for (let i = delen.length - 1; i >= 0; i--) {
      const x = delen[i];
      const vast = x.kop.length + 40;
      if (mee.length && vast + 200 > ruimte) { mee.unshift({ kop: '[' + (i + 1) + ' eerdere vraag/vragen weggelaten wegens lengte]', a: '' }); break; }
      ruimte -= vast;
      if (x.a.length > ruimte) {
        const k = Math.max(0, ruimte - 60);
        x.a = mee.length && k <= 400 ? '[eerder antwoord weggelaten wegens lengte]' : x.a.slice(0, Math.max(k, mee.length ? 0 : 1000)) + '\n[… rest van dit antwoord weggelaten]';
      }
      ruimte -= x.a.length;
      mee.unshift(x);
    }
    const tekst = mee.map(function (x) { return x.a ? x.kop + '\nJouw antwoord toen:\n' + x.a : x.kop; }).join('\n\n---\n\n');
    return { tekst: tekst, wisselingen: d.wisselingen.length };
  }

  // Rij B (Dubbelcheck): één aanhangsel bij een wisseling. a = {soort, titel?, t?, model?, md}
  async function zetAanhangsel(id, jobId, a) {
    if (!DRAAD_RE.test(String(id)) || !JOB_RE.test(String(jobId)) || !a || typeof a.md !== 'string') return false;
    return opBeurt(id, async function () {
      const d = lees(id);
      const w = d && d.wisselingen.find(function (x) { return x.job_id === jobId; });
      if (!w) return false;
      w.aanhangsels = Array.isArray(w.aanhangsels) ? w.aanhangsels : [];
      w.aanhangsels.push({ soort: String(a.soort || 'aanhangsel').slice(0, 40), titel: a.titel ? String(a.titel).slice(0, 120) : undefined,
        t: a.t || new Date(nu()).toISOString(), model: a.model ? String(a.model).slice(0, 80) : undefined, md: a.md.slice(0, MAX_AANHANGSEL) });
      d.bijgewerkt = new Date(nu()).toISOString();
      schrijf(d);
      return true;
    });
  }

  function info() {
    let n = 0;
    try { n = fs.readdirSync(map).filter(function (x) { return /^d-[a-f0-9]{16}\.json$/.test(x); }).length; } catch (e) { n = 0; }
    return { draden: n };
  }

  return { naAntwoord: naAntwoord, inhalen: inhalen, lijst: lijst, draad: draad, markdown: markdown, context: context,
    zetAanhangsel: zetAanhangsel, info: info, bestaat: function (id) { return !!lees(id); } };
}

module.exports = { maak: maak, DRAAD_RE: DRAAD_RE, bronnenUit: bronnenUit, eersteRegel: eersteRegel, draadIdVan: draadIdVan };
