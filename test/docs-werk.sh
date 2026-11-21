#!/usr/bin/env bash
# Toetst wv3688 (besluitenpagina nr 400 = 3C100): Deel als link en Bewerken bij markdown-werkbestanden.
# - docs-delen.js met een werkbestand als bron ("werk:<job>/<n>"): voorbeeld (titel uit de bestandsnaam), poort (sleutel, namen, privé-herinnering),
#   delen alleen met de sha van het voorbeeld, bron_tot in register/stand/voorbeeld/Gedeeld, bijwerken onder dezelfde slug, intrekken.
# - server.js (knipsel appWerkZoek … appWerkBewerk): bewerk/bewaar op een nagebootste app-bestanden-map: verwijzing van een bericht naar de
#   agent, alleen .md, versie/409, frontmatter blijft, .vorige, meta-grootte, vaste plek alleen lezen, sleutel geweigerd, 404 na opruimen.
# Raakt de echte app-bestanden, vault en Cloudflare niet. Toetsdata verzonnen. Gebruik: bash test/docs-werk.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const S = require('./secondbrain.js'), D = require('./docs-delen.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const sv = fs.readFileSync('server.js', 'utf8');
const knip = (a, z) => { const i = sv.indexOf(a), j = sv.indexOf(z, i); if (i < 0 || j < 0) throw new Error('niet gevonden in server.js: ' + a); return sv.slice(i, j); };

(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'werk3688-'));
  const AB = path.join(W, 'app-bestanden'), V = path.join(W, 'vault'), DD = path.join(W, 'docs');
  fs.mkdirSync(path.join(V, '20_Prive/Contacten'), { recursive: true });
  const contacten = ['# Contacten', ''];
  for (let i = 0; i < 120; i++) contacten.push('- **Proefpersoon' + i + ' Achternaam' + i + '** — buur');
  contacten.push('- **Jan Klaassen** — buurman');
  fs.writeFileSync(path.join(V, '20_Prive/Contacten/Contacten.md'), contacten.join('\n') + '\n');
  const op = new Date(Date.now() - 2 * 86400000).toISOString(), dag = op.slice(0, 10);
  const JA = 'aaaaaaaaaaaaaaaa', JB = 'bbbbbbbbbbbbbbbb';
  const zetJob = (job, soort, bestanden, inhoud) => {
    const d = path.join(AB, dag, job); fs.mkdirSync(path.join(d, 'b'), { recursive: true });
    for (const [n, t] of Object.entries(inhoud)) fs.writeFileSync(path.join(d, 'b', n), t);
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ job_id: job, soort, op, bestanden }));
  };
  const plan = '---\ntitel: proef\n---\n# Plan voor de proefweek\n\nEerste versie van het plan.\n';
  zetJob(JA, 'agent', [{ n: 1, naam: 'Plan.md', grootte: plan.length }, { n: 2, naam: 'Pagina.html', grootte: 10 }, { n: 3, naam: 'Herinnering.md', grootte: 50 },
    { n: 4, naam: 'Sleutel.md', grootte: 60 }, { n: 5, naam: 'Buur.md', grootte: 40 }, { n: 6, naam: 'zonder-kop.md', grootte: 10 }, { n: 7, naam: 'Crlf.md', grootte: 60 }], {
    1: plan, 2: '<p>x</p>', 3: '---\ngevoelig: prive\n---\n# Verzonnen herinnering\n', 4: '# s\nToken: abcd_Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR\n',
    5: '# Overleg\n\nMet Jan Klaassen besproken.\n', 6: 'Alleen tekst.\n',
    7: '---\r\ngevoelig: prive\r\ntitel: x\r\n---\r\n# Verzonnen herinnering\r\n' });
  zetJob(JB, 'socev', [{ n: 1, naam: 'Plan.md', grootte: plan.length, sha: 'x', van: { job_id: JA, n: 1 } }], {});

  // server.js-knipsel met nagebootste helpers
  const appLeesJson = (f, s) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return s; } };
  const appStaat = {};
  const appBewaardVan = (job) => { for (const d of fs.readdirSync(AB)) { const m = appLeesJson(path.join(AB, d, job, 'meta.json'), null); if (m) { m.dag = d; return m; } } return null; };
  let vastDicht = false;
  const omgeving = { fs, path, crypto, __dirname: process.cwd(), require, APP_BESTANDEN_DIR: AB, APP_BESTANDEN_MS: 30 * 86400000, APP_JOB_RE: /^[a-f0-9]{16}$/,
    appBewaardVan, appLeesJson, appStaat, appVastBeheerDicht: () => vastDicht, appPoortGeheim: () => 'proef', logError: () => {},
    appWeiger: (res, st, fout) => { res.st = st; res.j = { ok: false, fout }; }, appStuur: (res, st, j) => { res.st = st; res.j = j; } };
  const bestandPad = knip('function appBestandPad(m, b) {', '\n// Het bestand van agent agentJob');
  const blok = knip('const WERK_PAD_RE', '\nasync function appDocs(');
  const F = new Function(...Object.keys(omgeving), bestandPad + '\n' + blok + '\nreturn { appWerkZoek, appWerkBron, appWerkBewerk };')(...Object.values(omgeving));
  const roep = (route, d) => { const res = { _app: {} }; F.appWerkBewerk(res, {}, d, 'POST /app/docs/' + route); return res; };

  // ── 1. bron ──
  const b1 = F.appWerkBron('werk:' + JA + '/1');
  toets('1 bron: werkbestand gelezen, d = werk, tot = op + 30 dagen', b1 && b1.d === 'werk' && b1.tekst === plan && b1.tot === new Date(Date.parse(op) + 30 * 86400000).toISOString() && b1.naam === 'Plan.md', b1);
  const b2 = F.appWerkBron('werk:' + JB + '/1');
  toets('1 bron: verwijzing van een bericht leest het bestand van de agent', b2 && b2.tekst === plan && b2.p === 'werk:' + JB + '/1', b2);
  toets('1 bron: html, onbekend nummer, vreemd pad en padsprong = null',
    F.appWerkBron('werk:' + JA + '/2') === null && F.appWerkBron('werk:' + JA + '/9') === null && F.appWerkBron('werk:../x/1') === null && F.appWerkBron('werk:' + JA + '/1/../2') === null);

  // ── 2. delen via docs-delen.js ──
  const db = new Map();
  const d1 = async (sql, p) => {
    if (/^INSERT INTO deel/.test(sql)) { const oud = db.get(p[0]); db.set(p[0], { slug: p[0], soort: p[1], titel: p[2], html: p[3], sinds: oud ? oud.sinds : p[4], bijgewerkt: p[5] }); return { ok: true, rijen: [] }; }
    if (/^DELETE FROM deel/.test(sql)) { db.delete(p[0]); return { ok: true, rijen: [] }; }
    if (/^SELECT soort, access_app FROM deel WHERE slug/.test(sql)) { const r = db.get(p[0]); return { ok: true, rijen: r ? [{ soort: r.soort, access_app: null }] : [] }; }
    if (/^SELECT slug, soort, titel, sinds, bijgewerkt FROM deel/.test(sql)) return { ok: true, rijen: Array.from(db.values()).map((r) => ({ slug: r.slug, soort: r.soort, titel: r.titel, sinds: r.sinds, bijgewerkt: r.bijgewerkt })) };
    throw new Error('onbekende sql ' + sql);
  };
  const bron = (pad) => typeof pad === 'string' && pad.indexOf('werk:') === 0 ? F.appWerkBron(pad) : null;
  const dd = D.maak({ dir: DD, vault: V, host: 'deel.socev.dev', fout: () => {}, bron, masker: S.masker, bsnMasker: (t) => t, isVastDicht: () => { throw new Error('vaultregel op werkpad'); },
    isVerborgen: () => { throw new Error('vaultregel op werkpad'); }, hmac: (p) => crypto.createHmac('sha256', 'proef').update(p).digest('hex').slice(0, 16), d1, lees: (p) => fs.readFileSync(p, 'utf8') });
  const app = (r, d, c) => dd.app(r === 'gedeeld' ? 'GET /app/docs/gedeeld' : 'POST /app/docs/' + r, d, c || {});
  const P = 'werk:' + JA + '/1';
  let st = await app('stand', { pad: P });
  toets('2 stand: werkbestand kan gedeeld worden, bron_tot erbij, vaultregels niet aangeroepen', st.status === 200 && st.j.kan_delen === true && st.j.bron_tot === b1.tot && !st.j.gedeeld, st.j);
  let v = await app('voorbeeld', { pad: P });
  toets('2 voorbeeld: titel uit de kop, frontmatter niet in de pagina, geen namen', v.status === 200 && v.j.titel === 'Plan voor de proefweek' && v.j.body.indexOf('proef\n') < 0 && v.j.namen.length === 0 && v.j.bron_tot === b1.tot, v.j);
  const zk = await app('voorbeeld', { pad: 'werk:' + JA + '/6' });
  toets('2 zonder kop: titel = bestandsnaam zonder .md (niet "6")', zk.j.titel === 'zonder-kop', zk.j);
  const hr = await app('voorbeeld', { pad: 'werk:' + JA + '/3' });
  const hs = await app('stand', { pad: 'werk:' + JA + '/3' });
  toets('2 privé-herinnering (gevoelig: prive) deel je niet', hr.status === 403 && hs.j.kan_delen === false && /MemoryLane/.test(hs.j.reden), [hr, hs.j]);
  const crlf = await app('stand', { pad: 'werk:' + JA + '/7' });
  toets('2 privé-herinnering met CRLF-regeleinden en een veld erna: ook niet te delen (Codex MOET 1)', crlf.j.kan_delen === false, crlf.j);
  const sl = await app('voorbeeld', { pad: 'werk:' + JA + '/4' });
  toets('2 sleutel in het werkbestand: 422', sl.status === 422, sl);
  const nm = await app('voorbeeld', { pad: 'werk:' + JA + '/5' });
  toets('2 naam uit de contacten: namenvraag', nm.status === 200 && nm.j.namen.indexOf('Jan Klaassen') >= 0, nm.j);
  const nmd = await app('delen', { pad: 'werk:' + JA + '/5', soort: 'openbaar', sha: nm.j.sha });
  toets('2 delen zonder de namen te bevestigen: 409', nmd.status === 409 && Array.isArray(nmd.j.namen), nmd.j);
  const html = await app('voorbeeld', { pad: 'werk:' + JA + '/2' });
  toets('2 html-werkbestand: niet te delen (404)', html.status === 404, html);
  const vst = await app('voorbeeld', { pad: P }, { vast: true });
  toets('2 vaste plek: 403', vst.status === 403, vst);
  let dl = await app('delen', { pad: P, soort: 'openbaar', sha: 'f'.repeat(64) });
  toets('2 delen met een andere sha dan het voorbeeld: 409', dl.status === 409, dl.j);
  dl = await app('delen', { pad: P, soort: 'openbaar', sha: v.j.sha });
  const reg = JSON.parse(fs.readFileSync(path.join(DD, 'gedeeld.json'), 'utf8'));
  toets('2 delen: 200, link /p/, register heeft bron_tot, D1 heeft de html', dl.status === 200 && /^https:\/\/deel\.socev\.dev\/p\/[A-Za-z0-9_-]{22}$/.test(dl.j.gedeeld.url) &&
    reg.delingen[0].bron_tot === b1.tot && dl.j.gedeeld.bron_tot === b1.tot && db.get(dl.j.gedeeld.slug).html.indexOf('Eerste versie') > 0, [dl.j, reg]);
  const slug = dl.j.gedeeld.slug;

  // ── 3. bewerken (server.js) ──
  let bw = roep('werk-bewerk', { pad: P });
  toets('3 bewerk: md zonder frontmatter, versie 32 hex, bewerkbaar', bw.st === 200 && bw.j.md === '# Plan voor de proefweek\n\nEerste versie van het plan.\n' && /^[0-9a-f]{32}$/.test(bw.j.versie) && bw.j.bewerkbaar === true, bw.j);
  toets('3 audit: route + HMAC, geen pad of job-id', /^docs werk-bewerk werk h=[0-9a-f]{16}$/.test(bw._app.reden) && bw._app.reden.indexOf(JA) < 0, bw._app);
  let bs = roep('werk-bewaar', { pad: P, versie: '0'.repeat(32), md: 'x' });
  toets('3 bewaar met een oude versie: 409', bs.st === 409, bs.j);
  bs = roep('werk-bewaar', { pad: P, versie: bw.j.versie, md: '# Plan voor de proefweek\n\nTweede versie, bewerkt.' });
  const na = fs.readFileSync(path.join(AB, dag, JA, 'b', '1'), 'utf8');
  toets('3 bewaar: 200, frontmatter blijft, slotregeleinde blijft, .vorige = oude inhoud', bs.st === 200 && bs.j.gewijzigd === true &&
    na === '---\ntitel: proef\n---\n# Plan voor de proefweek\n\nTweede versie, bewerkt.\n' && fs.readFileSync(path.join(AB, dag, JA, 'b', '1.vorige'), 'utf8') === plan, [bs.j, na]);
  const meta = JSON.parse(fs.readFileSync(path.join(AB, dag, JA, 'meta.json'), 'utf8'));
  toets('3 meta: nieuwe grootte en bewerkt-tijd', meta.bestanden[0].grootte === Buffer.byteLength(na) && !!meta.bestanden[0].bewerkt, meta.bestanden[0]);
  const zelfde = roep('werk-bewaar', { pad: P, versie: bs.j.versie, md: '# Plan voor de proefweek\n\nTweede versie, bewerkt.\n' });
  toets('3 niets veranderd: gewijzigd false', zelfde.st === 200 && zelfde.j.gewijzigd === false, zelfde.j);
  const viaBericht = roep('werk-bewerk', { pad: 'werk:' + JB + '/1' });
  toets('3 via het bericht (verwijzing) zie je de bewerkte tekst', viaBericht.st === 200 && /Tweede versie/.test(viaBericht.j.md), viaBericht.j);
  const sleutel = roep('werk-bewaar', { pad: P, versie: bs.j.versie, md: '# x\nToken: abcd_Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR\n' });
  toets('3 sleutel in de tekst: 422, bestand ongewijzigd', sleutel.st === 422 && fs.readFileSync(path.join(AB, dag, JA, 'b', '1'), 'utf8') === na, sleutel.j);
  toets('3 html bewerken: 404', roep('werk-bewerk', { pad: 'werk:' + JA + '/2' }).st === 404);
  toets('3 onvolledig verzoek: 400', roep('werk-bewaar', { pad: P, versie: 'abc', md: 'x' }).st === 400);
  vastDicht = true;
  const vb = roep('werk-bewerk', { pad: P }), vw = roep('werk-bewaar', { pad: P, versie: bs.j.versie, md: 'y' });
  toets('3 vaste plek: alleen lezen (bewerkbaar false, bewaren 403)', vb.st === 200 && vb.j.bewerkbaar === false && vw.st === 403, [vb.j, vw.j]);
  vastDicht = false;

  // ── 4. na bewerken: dezelfde link, nieuwe tekst ──
  st = await app('stand', { pad: P });
  toets('4 stand na bewerken: gedeeld, veranderd = true', st.j.gedeeld && st.j.gedeeld.slug === slug && st.j.veranderd === true, st.j);
  v = await app('voorbeeld', { pad: P });
  dl = await app('delen', { pad: P, soort: 'openbaar', sha: v.j.sha });
  toets('4 bijwerken: zelfde slug, bijgewerkt, D1 toont de nieuwe tekst', dl.status === 200 && dl.j.bijgewerkt === true && dl.j.gedeeld.slug === slug && /Tweede versie/.test(db.get(slug).html) && !/Eerste versie/.test(db.get(slug).html), dl.j);
  const g = await app('gedeeld', {});
  toets('4 Gedeeld: rij met bron_tot', g.status === 200 && g.j.delingen.length === 1 && g.j.delingen[0].bron_tot === b1.tot, g.j);
  toets('4 health telt werkdelingen', dd.health().werk === 1, dd.health());

  // ── 5. na opruimen: link blijft (D1-kopie), bijwerken/bewerken niet meer; intrekken wel ──
  fs.rmSync(path.join(AB, dag, JA), { recursive: true });
  toets('5 werkbestand opgeruimd: bewerk 404, D1-kopie staat er nog', roep('werk-bewerk', { pad: P }).st === 404 && db.has(slug));
  const st5 = await app('stand', { pad: P });
  toets('5 stand na opruimen: 404 (geen nieuwe deling mogelijk)', st5.status === 404, st5);
  const g5 = await app('gedeeld', {});
  toets('5 Gedeeld toont de deling nog (met bron_tot voorbij)', g5.j.delingen.length === 1 && g5.j.delingen[0].slug === slug, g5.j);
  const ik = await app('intrekken', { slug });
  toets('5 intrekken: 200, D1-rij weg, register leeg', ik.status === 200 && !db.has(slug) && JSON.parse(fs.readFileSync(path.join(DD, 'gedeeld.json'), 'utf8')).delingen.length === 0, ik);

  // ── 6. koppeling in server.js ──
  toets('6 server.js: bron kiest appWerkBron voor werk:-paden', /indexOf\('werk:'\) === 0 \? appWerkBron\(pad\) : secondbrain\.bron\(pad, \{\}\)/.test(sv));
  toets('6 server.js: werk-routes vóór docsDelen, eigen teller', /if \(route === 'POST \/app\/docs\/werk-bewerk' \|\| route === 'POST \/app\/docs\/werk-bewaar'\) \{\n    if \(!appTeller\('docs-werk'/.test(sv));
  toets('6 server.js: delen blijft beheerroute (vingerafdruk, niet vanaf vaste plek)', /'POST \/app\/docs\/delen',\n  'POST \/app\/werkers\/schakel'/.test(sv) && /route === 'POST \/app\/docs\/delen' && !appVersOk\(a, s\)/.test(sv));
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + (e && e.stack)); process.exit(1); });
JS
