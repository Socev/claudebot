'use strict';
// OVIS NZa fase 1b (wv3099, 15-11-2026; plan vault "01_Ontwikkeling/OVIS NZa - plan (Fable 5.2, 14-11-2026)" § 3 "Waar de App woont").
// Het scherm op de pc (Dossier, Stukken, Zaken) en op de telefoon (Vraag, Nieuw, Stuk) leest het NZa-dossier via hetzelfde script als de
// agent: nza.py scherm overzicht | scherm stuk <id> [--plek] [--citaat]. Zo zijn de tellingen en de stand per stuk (geldt nu, komt eraan,
// vervangen, vernietigd) gelijk aan die van fase 1a, en komt het vinkje "citaat gecontroleerd" uit de citaatcontrole van 1a (nooit uit de
// tekst van de agent). Alleen lezen: geen schrijfroute, geen netwerk; de index /opt/data/ovis-nza/nza.db wordt read-only geopend.
// Fase 2 (wv3113): de wachter (mk-scripts/ovis-nza/wachter.py) schrijft <wacht>/scherm.json (titel + link-stukken, laatst gekeken per bron);
// nza.py zet die in het overzicht (nieuw_links, bronnen). De cache kijkt daarom ook naar dat bestand.
// wv3158: lijst Ontbreekt (overzicht.ontbreekt) = stand van de wachter + zoekrijen uit <log>/ontbreekt.jsonl; de cache kijkt ook daarnaar.
// Alleen child_process (execFile zonder shell, python3 -I) en fs.
const { execFile } = require('child_process');
const fs = require('fs');

const ID_RE = /^[a-z0-9][a-z0-9.-]{0,120}$/;
const PLEK_MAX = 80;
const CITAAT_MAX = 1500;

function maak(opts) {
  const script = opts.script;
  const db = opts.db;
  const wacht = opts.wacht || '';   // map met scherm.json van de wachter (wv3113)
  const logmap = opts.log || '';   // wv3158: map met ontbreekt.jsonl (zoekrijen van de agent; lijst Ontbreekt)
  const vandaag = opts.vandaag || '';   // alleen voor de toets met het proefdossier (NZA_VANDAAG)
  const timeoutMs = opts.timeoutMs || 20000;
  let cache = null;   // overzicht per stand van de index (mtime + grootte)
  let bezig = 0;
  // wv3153: kan de agent (gebruiker socev) bij index en vragenlog? 15-11 viel dat weg (rechtenronde 05:00 zette de map dicht).
  // mk-scripts/ovis-nza/toegang.py toets rekent het na uit de ACL's (de pod kan zich niet als socev voordoen). /health leest de laatste
  // uitkomst; een verouderde (> 10 min) wordt op de achtergrond ververst, zodat /health nooit wacht. null = (nog) niet vast te stellen.
  const toegangScript = opts.toegang || '';
  const toegangMs = opts.toegangMs || 600000;
  let toegang = { t: 0, waarde: null, bezig: false };
  function toegangVers() {
    if (!toegangScript || toegang.bezig || Date.now() - toegang.t < toegangMs) return;
    if (!fs.existsSync(toegangScript)) { toegang = { t: Date.now(), waarde: null, bezig: false }; return; }
    toegang.bezig = true;
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' };
    if (opts.toegangEnv) Object.assign(env, opts.toegangEnv);
    execFile('python3', ['-I', toegangScript, 'toets', '--json'], { env: env, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      function (e, out) {
        let d = null;
        try { d = JSON.parse(String(out || '')); } catch (x) { d = null; }
        const w = d && typeof d.index_leesbaar_agent === 'boolean' ? d.index_leesbaar_agent : null;
        const l = d && typeof d.log_schrijfbaar_agent === 'boolean' ? d.log_schrijfbaar_agent : null;
        toegang = { t: Date.now(), waarde: w, log: l, bezig: false };
      });
  }

  function aan() { return !!(script && fs.existsSync(script) && db && fs.existsSync(db)); }

  function draai(argv) {
    return new Promise(function (klaar) {
      if (bezig >= 3) return klaar({ status: 429, body: { ok: false, fout: 'even te druk; probeer het zo opnieuw' }, reden: 'nza druk' });
      bezig++;
      const env = { PATH: process.env.PATH || '/usr/bin:/bin', NZA_DB: db, LANG: 'C.UTF-8' };
      if (wacht) env.NZA_WACHT = wacht;
      if (logmap) env.NZA_LOG = logmap;
      if (vandaag) env.NZA_VANDAAG = vandaag;
      execFile('python3', ['-I', script, 'scherm'].concat(argv), { env: env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
        function (e, out) {
          bezig--;
          let d = null;
          try { d = JSON.parse(String(out || '')); } catch (x) { d = null; }
          if (d && typeof d === 'object' && d.ok === true) return klaar({ status: 200, body: d });
          if (d && typeof d === 'object' && d.ok === false) return klaar({ status: 404, body: { ok: false, fout: String(d.fout || 'niet gevonden').slice(0, 200) }, reden: 'nza niet gevonden' });
          klaar({ status: 503, body: { ok: false, fout: 'het dossier is nu niet te lezen; probeer het zo opnieuw' }, reden: e && e.killed ? 'nza tijd' : 'nza fout' });
        });
    });
  }

  async function overzicht() {
    let st;
    try { st = fs.statSync(db); } catch (e) { return { status: 503, body: { ok: false, fout: 'de dossierindex ontbreekt' }, reden: 'nza geen index' }; }
    let w = '-';
    if (wacht) { try { const ws = fs.statSync(wacht + '/scherm.json'); w = ws.mtimeMs + ':' + ws.size; } catch (e) { w = '-'; } }
    let o = '-';   // wv3158: een nieuwe zoekrij van de agent moet meteen op de lijst Ontbreekt staan
    if (logmap) { try { const os_ = fs.statSync(logmap + '/ontbreekt.jsonl'); o = os_.mtimeMs + ':' + os_.size; } catch (e) { o = '-'; } }
    const sleutel = st.mtimeMs + ':' + st.size + ':' + w + ':' + o + ':' + vandaagNu();
    if (cache && cache.sleutel === sleutel) return { status: 200, body: cache.body };
    const u = await draai(['overzicht']);
    if (u.status === 200) cache = { sleutel: sleutel, body: u.body };
    return u;
  }

  function vandaagNu() { return vandaag || new Date().toISOString().slice(0, 10); }

  async function stuk(body) {
    const b = body && typeof body === 'object' ? body : {};
    const id = typeof b.id === 'string' ? b.id : '';
    if (!ID_RE.test(id)) return { status: 400, body: { ok: false, fout: 'onbekend stuk' }, reden: 'nza id' };
    const argv = ['stuk', id];
    if (b.plek != null) {
      if (typeof b.plek !== 'string' || !b.plek.trim() || b.plek.length > PLEK_MAX || /[\u0000-\u001f]/.test(b.plek)) return { status: 400, body: { ok: false, fout: 'onbekende plek' }, reden: 'nza plek' };
      argv.push('--plek', b.plek.trim());
    }
    if (b.citaat != null) {
      if (typeof b.citaat !== 'string' || b.citaat.length > CITAAT_MAX || b.plek == null) return { status: 400, body: { ok: false, fout: 'citaat zonder plek of te lang' }, reden: 'nza citaat' };
      const c = b.citaat.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim();
      if (c) argv.push('--citaat', c);
    }
    if (b.van != null) {
      if (!Number.isInteger(b.van) || b.van < 0 || b.van > 100000) return { status: 400, body: { ok: false, fout: 'onbekende plek' }, reden: 'nza van' };
      argv.push('--van', String(b.van));
    }
    return draai(argv);
  }

  async function app(v) {
    if (!aan()) return { status: 503, body: { ok: false, fout: 'het NZa-dossier staat niet op deze pod' }, reden: 'nza uit' };
    if (v.methode === 'GET' && v.pad === '/app/nza') return overzicht();
    if (v.methode === 'POST' && v.pad === '/app/nza/stuk') return stuk(v.body);
    return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'nza onbekend' };
  }

  function info() {
    if (!aan()) return { aan: false };
    const t = cache && cache.body && cache.body.telling;
    const b = cache && cache.body && cache.body.bronnen;
    const i = { aan: true, gebouwd: cache ? cache.body.gebouwd : null, stukken: t ? t.stukken : null, bronnen_gekeken: b ? (b.laatst_gekeken || null) : null };
    if (toegangScript) {
      toegangVers();
      i.index_leesbaar_agent = toegang.waarde;
      i.vragenlog_schrijfbaar_agent = toegang.log === undefined ? null : toegang.log;
    }
    return i;
  }

  if (toegangScript) toegangVers();
  return { app: app, info: info, aan: aan };
}

module.exports = { maak: maak, ID_RE: ID_RE };
