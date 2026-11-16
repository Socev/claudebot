// ovis-code.js — OVIS Code fase 1 (wv3227; bouwplan vault 01_Ontwikkeling/OVIS Code - bouwplan (16-11-2026).md § 5b, § 5c, § 5f).
// Drie dingen zonder taalmodel:
//  1. Werkbestanden per app: /opt/data/ovis-code/<id>/INSTRUCTIE.md en STAND.md (claude, map 0700, bestanden 0600). De pod maakt ze bij
//     het eerste gesprek uit het register (code-apps.js) en toetst vóór elke beurt eigenaar, rechten, symlinks en harde links (zelfde
//     toets als het machinekamer-geheugen, mk-tekst.js geheugenToets). Niet in orde = de beurt start NIET (review MOET 1, dicht).
//  2. Stand-meting (uurstap): GitHub-repolijst, Cloudflare Pages en Workers → stand.json (laatste push, laatste productie-uitrol,
//     main verder dan live). Fout = de vorige stand blijft staan, met de vorige meettijd en de fout erbij; nooit een verzonnen stand.
//  3. Opbouw van GET /app/code/apps: register zonder interne paden + stand + open klussen per app (op label-voorvoegsel) + gesprek.
// Geen netwerk buiten api.github.com en api.cloudflare.com; alleen lezen.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const C = require('./code-apps.js');

const INSTRUCTIE = 'INSTRUCTIE.md', STAND = 'STAND.md';
const MAX_INSTRUCTIE = 16000, MAX_STAND = 8000;   // tekens (bouwplan § 5c)
const NETWERK_MS = 20000;

function maak(o) {
  const basis = o.basis;                                   // /opt/data/ovis-code
  const standPad = path.join(basis, 'stand.json');
  const fout = o.fout || function () {};
  const geheugenToets = o.geheugenToets;                   // MK_TEKST.geheugenToets(pad) → {ok, reden}
  const nu = o.nu || function () { return Date.now(); };
  const uid = typeof o.uid === 'number' ? o.uid : process.getuid();

  function werkmap(id) { return C.app(id) ? path.join(basis, id) : null; }

  // Basismap: bestaat (anders maken, 0700), echte map, eigen, geen groep/anderen.
  function basisKlaar() {
    let st;
    try { st = fs.lstatSync(basis); }
    catch (e) {
      if (e.code !== 'ENOENT') return 'basismap niet te lezen: ' + e.code;
      try { fs.mkdirSync(basis, { mode: 0o700 }); fs.chmodSync(basis, 0o700); st = fs.lstatSync(basis); } catch (e2) { return 'basismap niet te maken: ' + (e2.code || e2.message); }
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return 'basismap is geen echte map';
    if (st.uid !== uid) return 'basismap heeft een andere eigenaar (' + st.uid + ')';
    if (st.mode & 0o077) return 'basismap open voor groep/anderen of ACL-masker (' + (st.mode & 0o777).toString(8) + ')';
    return '';
  }
  // Eén bestand nieuw (O_EXCL: volgt geen symlink, overschrijft niets).
  function nieuwBestand(p, tekst) {
    try { fs.writeFileSync(p, tekst, { flag: 'wx', mode: 0o600 }); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  }
  // Toets en (eerste gesprek) aanmaak. {ok, reden, gemaakt: [namen]}. Nooit een bestaand bestand overschrijven of herstellen:
  // herstel gebeurt vanuit de machinekamer (§ 5f.4).
  function werkKlaar(id) {
    const map = werkmap(id);
    if (!map) return { ok: false, reden: 'onbekende app' };
    const b = basisKlaar();
    if (b) return { ok: false, reden: b };
    const gemaakt = [];
    try {
      let st = null;
      try { st = fs.lstatSync(map); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!st) { fs.mkdirSync(map, { mode: 0o700 }); fs.chmodSync(map, 0o700); gemaakt.push(id + '/'); }
      else if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reden: 'werkmap is geen echte map' };
      // Ontbrekende bestanden aanmaken alleen in een map die zelf al door de toets komt (anders schrijven we in een vreemde map)
      const t0 = geheugenToets(map);
      if (!t0.ok) return { ok: false, reden: t0.reden };
      if (nieuwBestand(path.join(map, INSTRUCTIE), C.instructieZaad(id))) gemaakt.push(INSTRUCTIE);
      if (nieuwBestand(path.join(map, STAND), C.standZaad(id, new Date(nu()).toISOString()))) gemaakt.push(STAND);
    } catch (e) { return { ok: false, reden: 'werkmap niet te maken: ' + (e.code || e.message) }; }
    const t = geheugenToets(map);
    if (!t.ok) return { ok: false, reden: t.reden, gemaakt: gemaakt };
    for (const [naam, max] of [[INSTRUCTIE, MAX_INSTRUCTIE], [STAND, MAX_STAND]]) {
      let st;
      try { st = fs.lstatSync(path.join(map, naam)); } catch (e) { return { ok: false, reden: naam + ' ontbreekt', gemaakt: gemaakt }; }
      if (!st.isFile()) return { ok: false, reden: naam + ' is geen gewoon bestand', gemaakt: gemaakt };
      if (st.nlink !== 1) return { ok: false, reden: naam + ' heeft een harde link', gemaakt: gemaakt };
      if (st.size > max * 4) return { ok: false, reden: naam + ' te groot', gemaakt: gemaakt };
    }
    return { ok: true, reden: '', gemaakt: gemaakt };
  }

  // ── stand-meting ──
  function haalJson(url, kop) {
    if (o.haal) return o.haal(url, kop);
    return new Promise(function (klaar, mis) {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: NETWERK_MS,
        headers: Object.assign({ 'User-Agent': 'socev-pod-ovis-code', Accept: 'application/json' }, kop || {}) }, function (res) {
        const delen = [];
        res.on('data', function (d) { delen.push(d); });
        res.on('end', function () {
          const t = Buffer.concat(delen).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) return mis(new Error(u.hostname + ' ' + res.statusCode));
          try { klaar(JSON.parse(t)); } catch (e) { mis(new Error(u.hostname + ' geen json')); }
        });
      });
      req.on('timeout', function () { req.destroy(new Error(u.hostname + ' timeout')); });
      req.on('error', mis);
      req.end();
    });
  }
  function standLees() {
    try { const s = JSON.parse(fs.readFileSync(standPad, 'utf8')); return s && typeof s === 'object' ? s : null; } catch (e) { return null; }
  }
  function standSchrijf(s) {
    const tmp = standPad + '.nieuw.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, standPad);
  }
  // Eén meting. Geeft de nieuwe stand; bij een fout de vorige met {fout, poging}.
  async function standMeet() {
    const t0 = new Date(nu()).toISOString();
    const b = basisKlaar();
    if (b) throw new Error(b);
    try {
      const gh = o.ghToken ? o.ghToken() : '';
      const cf = o.cfToken ? o.cfToken() : '';
      if (!gh || !cf || !o.cfAccount) throw new Error('sleutel voor GitHub of Cloudflare ontbreekt');
      const ghKop = { Authorization: 'Bearer ' + gh, 'X-GitHub-Api-Version': '2022-11-28' }, cfKop = { Authorization: 'Bearer ' + cf };
      const repos = {};
      for (let p = 1; p <= 5; p++) {
        const lijst = await haalJson('https://api.github.com/user/repos?per_page=100&affiliation=owner&page=' + p, ghKop);
        if (!Array.isArray(lijst)) throw new Error('GitHub: geen lijst');
        lijst.forEach(function (r) { if (r && r.name) repos[r.name] = { push: r.pushed_at || null, prive: r.private === true, branch: r.default_branch || 'main', url: r.html_url || null }; });
        if (lijst.length < 100) break;
      }
      const pages = {};
      for (let p = 1; p <= 5; p++) {
        const d = await haalJson('https://api.cloudflare.com/client/v4/accounts/' + o.cfAccount + '/pages/projects?page=' + p, cfKop);
        if (!d || d.success === false || !Array.isArray(d.result)) throw new Error('Cloudflare Pages: geen lijst');
        d.result.forEach(function (x) {
          const dep = x.canonical_deployment || x.latest_deployment || {};
          const meta = (dep.deployment_trigger && dep.deployment_trigger.metadata) || {};
          const bron = x.source && x.source.config ? x.source.config.repo_name : null;
          pages[x.name] = { op: dep.created_on || null, commit: meta.commit_hash ? String(meta.commit_hash).slice(0, 40) : null, branch: meta.branch || null, bron_repo: bron || null };
        });
        const ri = d.result_info || {};
        if (!(ri.total_pages > p)) break;
      }
      const wd = await haalJson('https://api.cloudflare.com/client/v4/accounts/' + o.cfAccount + '/workers/scripts', cfKop);
      if (!wd || wd.success === false || !Array.isArray(wd.result)) throw new Error('Cloudflare Workers: geen lijst');
      const workers = {};
      wd.result.forEach(function (x) { if (x && x.id) workers[x.id] = { op: x.modified_on || null }; });
      // main van de repo achter elk Pages-project (hooguit ± 15 vragen): verder dan wat live staat?
      const main = {};
      for (const a of C.APPS) {
        for (const pn of (a.pages || [])) {
          const pg = pages[pn];
          const repo = pg && (pg.bron_repo || ((a.repos || []).length === 1 ? a.repos[0] : null));
          if (!pg || !repo || !repos[repo] || main[repo] !== undefined) continue;
          try { const br = await haalJson('https://api.github.com/repos/Socev/' + encodeURIComponent(repo) + '/branches/' + encodeURIComponent(repos[repo].branch), ghKop); main[repo] = br && br.commit && br.commit.sha ? String(br.commit.sha) : null; }
          catch (e) { main[repo] = null; }
        }
      }
      const inReg = { pages: new Set(), workers: new Set(), repos: new Set(C.SLAPEND) };
      C.APPS.forEach(function (a) { (a.pages || []).forEach(function (x) { inReg.pages.add(x); }); (a.workers || []).forEach(function (x) { inReg.workers.add(x); }); (a.repos || []).forEach(function (x) { inReg.repos.add(x); }); });
      const s = { gemeten: t0, poging: t0, fout: null, repos: repos, pages: pages, workers: workers, main: main,
        onbekend: { pages: Object.keys(pages).filter(function (x) { return !inReg.pages.has(x); }), workers: Object.keys(workers).filter(function (x) { return !inReg.workers.has(x); }),
          repos: Object.keys(repos).filter(function (x) { return !inReg.repos.has(x); }) } };
      standSchrijf(s);
      return s;
    } catch (e) {
      const oud = standLees() || { gemeten: null, repos: {}, pages: {}, workers: {}, main: {} };
      oud.poging = t0; oud.fout = String(e && e.message || e).replace(/Bearer\s+\S+/g, 'Bearer …').slice(0, 200);
      try { standSchrijf(oud); } catch (e2) { fout('ovis-code-stand', e2); }
      return oud;
    }
  }

  // Uitrol van een app uit de stand: eerste Pages-project, anders eerste Worker.
  function uitrolVan(a, s) {
    if (!s) return null;
    const pn = (a.pages || []).filter(function (x) { return s.pages && s.pages[x]; })[0];
    if (pn) {
      const pg = s.pages[pn], repo = pg.bron_repo || ((a.repos || []).length === 1 ? a.repos[0] : null);
      const m = repo && s.main ? s.main[repo] : null;
      return { soort: 'pages', naam: pn, op: pg.op || null, commit: pg.commit ? pg.commit.slice(0, 7) : null,
        main_verder: m && pg.commit ? m.indexOf(pg.commit) !== 0 && pg.commit.indexOf(m) !== 0 : null };
    }
    const wn = (a.workers || []).filter(function (x) { return s.workers && s.workers[x]; })[0];
    if (wn) {
      const w = s.workers[wn], r = (a.repos || [])[0], push = r && s.repos && s.repos[r] ? Date.parse(s.repos[r].push) : NaN, op = Date.parse(w.op);
      // Worker: geen commit in de API; "verder" = push ruim (> 10 min) na de laatste uitrol (benadering, zo benoemd in de app)
      return { soort: 'worker', naam: wn, op: w.op || null, commit: null, main_verder: isFinite(push) && isFinite(op) ? push - op > 10 * 60 * 1000 : null };
    }
    return null;
  }

  // Podpaden horen niet in de app (bouwplan § 6 stap 6): '; data pod `/opt/data/x`' en losse /opt/-paden weg.
  function waarVoorApp(t) {
    return String(t || '').replace(/\s*;?\s*(?:data |index )?pod\s*`\/opt\/[^`]*`/g, '').replace(/`?\/opt\/[^\s`;,)]*`?/g, '').replace(/`/g, '').replace(/\s*;\s*$/, '').trim();
  }
  // Route-opbouw. inv: {stand, klussen: {id: [..]}, gesprek: {id: {loopt, in_rij, laatste}}, vraagOpen: {id: true}, lopend}
  function appsUit(inv) {
    const s = inv.stand || null, klussen = inv.klussen || {}, gesprek = inv.gesprek || {}, vraagOpen = inv.vraagOpen || {};
    const repoVan = function (r) { const x = s && s.repos ? s.repos[r] : null; return { naam: r, url: 'https://github.com/Socev/' + r, push: x ? x.push || null : null }; };
    const apps = C.APPS.map(function (a) {
      const kl = klussen[a.id] || [], g = gesprek[a.id] || { loopt: false, in_rij: 0, laatste: null };
      const chip = vraagOpen[a.id] || kl.some(function (k) { return k.stand === 'wacht_op_jou'; }) ? 'wacht_op_jou'
        : g.loopt || kl.some(function (k) { return k.stand === 'loopt'; }) ? 'loopt' : 'stil';
      return { id: a.id, naam: a.naam, groep: C.weergaveGroep(a.groep), wat: a.wat, waar: waarVoorApp(a.waar), adressen: a.adressen || [], inlog: a.inlog === true,
        repos: (a.repos || []).map(repoVan), scherm: a.scherm || null, uitrol: uitrolVan(a, s), klussen: kl, chip: chip, gesprek: g };
    });
    return { ok: true, gemeten: s ? s.gemeten || null : null, stand_fout: s ? s.fout || null : 'nog niet gemeten',
      tegelijk: { max: inv.max || 2, lopend: inv.lopend || 0 }, groepen: C.GROEPEN, apps: apps,
      slapend: C.SLAPEND.map(function (r) { const x = repoVan(r); return x; }) };
  }

  return { werkmap, werkKlaar, standLees, standMeet, appsUit, uitrolVan, basis: basis, INSTRUCTIE, STAND, MAX_INSTRUCTIE, MAX_STAND };
}

module.exports = { maak, INSTRUCTIE, STAND, MAX_INSTRUCTIE, MAX_STAND };
