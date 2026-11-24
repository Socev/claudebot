#!/usr/bin/env bash
# Toetst de versiewachter (wv3947, besluitenpagina nr 492 = 3C192): vault-versies.js met de echte secondbrain.js en vault-veilig.js in een
# proefvault. Raakt de echte vault niet. Gebruik: bash test/vault-versies.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const S = require('./secondbrain.js'), VV = require('./vault-veilig.js'), W8 = require('./vault-versies.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'vv3947-'));
  const V = path.join(W, 'vault'), D = path.join(W, 'staat');
  const zet = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
  const zetRename = (p, t) => { const tmp = path.join(V, p) + '.tmp'; fs.writeFileSync(tmp, t); fs.renameSync(tmp, path.join(V, p)); };
  const lees = (p) => fs.readFileSync(path.join(V, p));
  const ORIG = '﻿---\r\ntitel: Proef\r\n---\r\n# Proefpagina\r\n\r\nEerste regel.\r\nTweede regel.\r\n';   // BOM, frontmatter, CRLF: byte-gelijk terug
  zet('01_Ontwikkeling/Proef.md', ORIG);
  zet('01_Ontwikkeling/Tweede.md', '# Tweede\n');
  zet('00_Systeem/Systeemoverzicht.md', '# sys\n');
  zet('10_Zakelijk/X/Bronnen/bron.md', '# bron\n');
  zet('10_Zakelijk/X/actueel.md', '# actueel\n');
  zet('.claude/geheim.md', '# punt\n');
  let schuif = 10000;   // de wachter leest pas na RUST_MS rust; de proef schuift de klok vooruit
  const nu = () => Date.now() + schuif;
  const hm = (p) => 'h' + require('crypto').createHash('sha256').update(p).digest('hex').slice(0, 15);
  let sb = null;
  const vv = W8.maak({ vault: V, versieDir: path.join(D, 'versies'), schaduwDir: path.join(D, 'schaduw'), hmac: hm, socevUid: process.getuid(), nu: nu,
    fout: (w, e) => console.error('fout', w, e && e.message), kandidaat: (p, g) => sb.versieKandidaat(p, g) });
  sb = S.maak({ vault: V, dir: D, fout: (w, e) => console.error('fout', w, e && e.message), hmac: hm, bsnMasker: (t) => t, lees: (p) => VV.lees(p, 'utf8'),
    wijzig: (p, f) => VV.wijzig(p, f), versieDir: path.join(D, 'versies'), versies: vv, nu: nu, onderhoud: () => false, grendelVrij: () => true });
  sb.mkdir();
  const app = (r, d) => sb.app('POST /app/secondbrain/' + r, d, {});
  const P = '01_Ontwikkeling/Proef.md';

  let r = vv.ronde();
  toets('nulmeting: alleen bewerkbare pagina\'s (2), geen versie', r.nieuw === 2 && r.versies === 0 && r.pagina === 2, r);
  r = vv.ronde();
  toets('tweede ronde zonder wijziging: niets', r.nieuw === 0 && r.versies === 0, r);

  // Socev schrijft (nieuwe inode, uid = socevUid)
  zetRename(P, ORIG.replace('Tweede regel.', 'Tweede regel, door Socev aangepast.'));
  schuif = 0;
  r = vv.ronde();
  toets('net geschreven (binnen de rusttijd): wachtend, nog geen versie', r.versies === 0 && r.wachtend === 1, r);
  schuif = 10000;
  r = vv.ronde();
  toets('na de rust: één versie', r.versies === 1, r);
  let vs = await app('versies', { pad: P });
  const v0 = vs.j.versies[0];
  toets('Versies: door socev, na = sha van nu', vs.status === 200 && vs.j.versies.length === 1 && v0.door === 'socev' && v0.na === vs.j.versie, vs.j);
  const vmap = path.join(D, 'versies', hm(P));
  toets('versie = het hele bestand van vóór de wijziging (byte-gelijk), 0600', fs.readFileSync(path.join(vmap, v0.id)).equals(Buffer.from(ORIG)) &&
    (fs.statSync(path.join(vmap, v0.id)).mode & 0o777) === 0o600);

  // Bekijk wat
  let vz = await app('verschil', { pad: P, id: v0.id });
  toets('verschil: voor en na zonder BOM, LF', vz.status === 200 && vz.j.voor.indexOf('Tweede regel.\n') > 0 && vz.j.na.indexOf('door Socev aangepast.\n') > 0 && vz.j.voor[0] !== '﻿' && vz.j.na.indexOf('\r') < 0, vz.j);
  vz = await app('verschil', { pad: P, id: '../x.md' });
  toets('verschil: vreemd id = 400', vz.status === 400);

  // in-place schrijven (zelfde inode) = agent
  fs.writeFileSync(path.join(V, '01_Ontwikkeling/Tweede.md'), '# Tweede\nerbij\n');
  r = vv.ronde();
  vs = await app('versies', { pad: '01_Ontwikkeling/Tweede.md' });
  toets('in-place schrijven: door agent', r.versies === 1 && vs.j.versies[0].door === 'agent', vs.j);

  // Terugzetten: byte-gelijk, door david, en de ronde maakt er geen tweede versie van
  vs = await app('versies', { pad: P });
  let t = await app('bewaar-terug', { pad: P, versie: vs.j.versie, id: v0.id });
  toets('Terugzetten: 200 en byte-gelijk aan het origineel', t.status === 200 && lees(P).equals(Buffer.from(ORIG)), t);
  vs = await app('versies', { pad: P });
  toets('na Terugzetten: nieuwste versie door david (wat Socev schreef)', vs.j.versies.length === 2 && vs.j.versies[0].door === 'david' && vs.j.versies[0].na === vs.j.versie, vs.j);
  r = vv.ronde();
  toets('ronde na Terugzetten: geen dubbele versie', r.versies === 0, r);
  vs = await app('versies', { pad: P });
  toets('nog steeds 2 versies', vs.j.versies.length === 2, vs.j.versies.length);

  // Docs-opslag: door david, geen dubbele
  let b = await app('bewerk', { pad: P });
  let o = await app('bewaar', { pad: P, versie: b.j.versie, md: '# Proefpagina\n\nDoor David in Docs.\n' });
  r = vv.ronde();
  vs = await app('versies', { pad: P });
  toets('Docs-opslag: versie door david, ronde maakt geen tweede', o.status === 200 && r.versies === 0 && vs.j.versies.length === 3 && vs.j.versies[0].door === 'david', [o, r, vs.j.versies.map((x) => x.door)]);

  // daarna weer een agent: nieuwste = agent; na een verdere wijziging klopt na niet meer met nu (de app toont dan geen regel bovenaan)
  zet(P, 'agent 1\n'); r = vv.ronde();
  vs = await app('versies', { pad: P });
  toets('agent na David: nieuwste door agent', vs.j.versies[0].door === 'agent' && vs.j.versies[0].na === vs.j.versie, vs.j.versies[0]);

  // grens: hooguit 10 per pagina, door.json alleen voor bestaande versies
  for (let i = 0; i < 12; i++) { zet(P, 'agent ronde ' + i + '\n'); vv.ronde(); }
  const namen = fs.readdirSync(vmap).filter((n) => W8.VERSIE_NAAM.test(n));
  const dj = JSON.parse(fs.readFileSync(path.join(vmap, 'door.json'), 'utf8'));
  toets('hooguit 10 versies; door.json alleen voor die 10', namen.length === 10 && Object.keys(dj).length === 10 && Object.keys(dj).every((k) => namen.includes(k)), [namen.length, Object.keys(dj).length]);
  // Docs-opslag snoeit nu alleen versies (niet door.json)
  b = await app('bewerk', { pad: P });
  await app('bewaar', { pad: P, versie: b.j.versie, md: 'david weer\n' });
  toets('Docs-opslag laat door.json staan', fs.existsSync(path.join(vmap, 'door.json')) && fs.readdirSync(vmap).filter((n) => W8.VERSIE_NAAM.test(n)).length === 10);

  // niet-bewerkbare pagina's: geen schaduw, geen versie
  zet('00_Systeem/Systeemoverzicht.md', '# sys veranderd\n'); zet('10_Zakelijk/X/Bronnen/bron.md', '# bron 2\n'); zet('10_Zakelijk/X/actueel.md', '# actueel 2\n');
  r = vv.ronde();
  toets('00_Systeem, Bronnen, actueel.md: geen versies', r.versies === 0 && !fs.existsSync(path.join(D, 'versies', hm('00_Systeem/Systeemoverzicht.md'))), r);

  // verdwenen pagina, health
  fs.unlinkSync(path.join(V, '01_Ontwikkeling/Tweede.md'));
  vv.ronde();
  const h = vv.health();
  toets('health: rondes, schaduw_paginas, nulmeting klaar', h.rondes > 5 && h.schaduw_paginas === 2 && h.nulmeting_klaar === true, h);

  // opruimen: ouder dan 90 dagen weg
  schuif = 91 * 86400000;
  const op = vv.opruim();
  toets('opruimen: versies ouder dan 90 dagen weg, door.json mee bijgewerkt', op.weg >= 10 && fs.readdirSync(vmap).filter((n) => W8.VERSIE_NAAM.test(n)).length === 0 &&
    Object.keys(JSON.parse(fs.readFileSync(path.join(vmap, 'door.json'), 'utf8'))).length === 0, op);

  // half geschreven: een bestand dat tijdens het lezen verandert wordt geen schaduw (fstat voor/na) — hier: rusttijd + inode-gelijk gedekt; leesStabiel weigert een symlink
  schuif = 10000;
  fs.symlinkSync(path.join(V, P), path.join(V, '01_Ontwikkeling/Link.md'));
  r = vv.ronde();
  toets('symlink telt niet mee', r.pagina === 1, r);

  fs.rmSync(W, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
