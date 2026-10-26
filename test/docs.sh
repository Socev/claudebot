#!/usr/bin/env bash
# Toetst OVIS Docs (wv1378; bouwplan "01_Ontwikkeling/OVIS Docs - bouwplan (26-10-2026).md" § 3.2 en § 5): de routes bewerk en bewaar in
# secondbrain.js met de echte vault-veilig.js. Raakt de echte vault niet. Gebruik: bash test/docs.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const S = require('./secondbrain.js'), VV = require('./vault-veilig.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'docs1378-'));
  const V = path.join(W, 'vault'), D = path.join(W, 'staat');
  const zet = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
  const lees = (p) => fs.readFileSync(path.join(V, p), 'utf8');
  const TOKEN = 'abcd_' + 'Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR';
  zet('01_Ontwikkeling/Plan.md', '# Plan\n\nTekst met [[Link]].\n');
  zet('01_Ontwikkeling/Fm.md', '﻿---\r\ntitel: x\r\nverwant:\r\n  - "[[Plan]]"\r\n---\r\n# Kop\r\nregel\r\n');
  zet('01_Ontwikkeling/Sleutel.md', '# s\nToken ' + TOKEN + '\n');
  zet('00_Systeem/Systeemoverzicht.md', '# sys\n');
  zet('10_Zakelijk/Tolgaarde/Bronnen/bron.md', '# bron\n');
  zet('10_Zakelijk/Tolgaarde/actueel.md', '# actueel\n');
  zet('CLAUDE.md', '# instructie\n');
  zet('20_Prive/Notitie.md', '# privé\n');
  zet('01_Ontwikkeling/Plan.sync-conflict-20261026-120000-ABC.md', '# conflict\n');
  fs.chmodSync(path.join(V, '01_Ontwikkeling/Plan.md'), 0o644);
  let onderhoud = false, grendel = true;
  const sb = S.maak({ vault: V, dir: D, fout: (w, e) => console.error('fout', w, e && e.message), hmac: (p) => 'h' + Buffer.from(p).toString('hex').slice(0, 15),
    bsnMasker: (t) => t, lees: (p) => VV.lees(p, 'utf8'), wijzig: (p, f) => VV.wijzig(p, f), versieDir: path.join(D, 'versies'),
    onderhoud: () => onderhoud, grendelVrij: () => grendel });
  sb.mkdir();
  const tel = { telefoon: {}, vast: { vast: true } };
  const app = (r, d, c) => sb.app('POST /app/secondbrain/' + r, d, c || tel.telefoon);

  // bewerk
  let b = await app('bewerk', { pad: '01_Ontwikkeling/Plan.md' });
  toets('bewerk: gewone pagina bewerkbaar, md zonder masker, versie 32 hex', b.status === 200 && b.j.bewerkbaar && b.j.md === '# Plan\n\nTekst met [[Link]].\n' && /^[0-9a-f]{32}$/.test(b.j.versie), b);
  let r = await app('bewaar', { pad: '01_Ontwikkeling/Plan.md', versie: b.j.versie, md: '# Plan\n\nNieuwe tekst met [[Link]].' });
  toets('bewaar: 200, geschreven, slot-\\n terug', r.status === 200 && r.j.gewijzigd && lees('01_Ontwikkeling/Plan.md') === '# Plan\n\nNieuwe tekst met [[Link]].\n', [r, lees('01_Ontwikkeling/Plan.md')]);
  toets('bewaar: modus 0644 blijft na rename', (fs.statSync(path.join(V, '01_Ontwikkeling/Plan.md')).mode & 0o777) === 0o644);
  let r2 = await app('bewaar', { pad: '01_Ontwikkeling/Plan.md', versie: r.j.versie, md: '# Plan\n\nDerde.\n' });
  toets('bewaar: tweede keer met de teruggegeven versie lukt', r2.status === 200 && lees('01_Ontwikkeling/Plan.md') === '# Plan\n\nDerde.\n', r2);
  let r3 = await app('bewaar', { pad: '01_Ontwikkeling/Plan.md', versie: b.j.versie, md: 'oud' });
  toets('bewaar: oude versie = 409, niets geschreven', r3.status === 409 && lees('01_Ontwikkeling/Plan.md') === '# Plan\n\nDerde.\n', r3);
  let r4 = await app('bewaar', { pad: '01_Ontwikkeling/Plan.md', versie: r2.j.versie, md: '# Plan\n\nDerde.\n' });
  toets('bewaar: ongewijzigd = 200 gewijzigd:false, zelfde versie', r4.status === 200 && r4.j.gewijzigd === false && r4.j.versie === r2.j.versie, r4);
  const vmap = path.join(D, 'versies', 'h' + Buffer.from('01_Ontwikkeling/Plan.md').toString('hex').slice(0, 15));
  let vs = fs.readdirSync(vmap);
  toets('versies: 2 vorige inhouden, 0600, buiten de vault', vs.length === 2 && vs.every((n) => (fs.statSync(path.join(vmap, n)).mode & 0o777) === 0o600) &&
    vs.map((n) => fs.readFileSync(path.join(vmap, n), 'utf8')).sort().join('|') === ['# Plan\n\nNieuwe tekst met [[Link]].\n', '# Plan\n\nTekst met [[Link]].\n'].sort().join('|'), vs);
  let v = r2.j.versie;
  for (let i = 0; i < 12; i++) { const x = await app('bewaar', { pad: '01_Ontwikkeling/Plan.md', versie: v, md: 'versie ' + i + '\n' }); v = x.j.versie; }
  toets('versies: hooguit 10 per pagina', fs.readdirSync(vmap).length === 10, fs.readdirSync(vmap).length);
  let r5 = await app('bewaar', { pad: '01_Ontwikkeling/Plan.md', versie: v, md: 'met ' + TOKEN });
  toets('bewaar: sleutel in de nieuwe tekst = 422', r5.status === 422 && lees('01_Ontwikkeling/Plan.md') === 'versie 11\n', r5);

  // frontmatter, BOM, CRLF
  b = await app('bewerk', { pad: '01_Ontwikkeling/Fm.md' });
  toets('bewerk: frontmatter eraf, CRLF → LF, eigenschappen erbij', b.j.bewerkbaar && b.j.md === '# Kop\nregel\n' && b.j.eigenschappen.some((e) => e.naam === 'titel'), b);
  r = await app('bewaar', { pad: '01_Ontwikkeling/Fm.md', versie: b.j.versie, md: '# Kop\nnieuwe regel\n' });
  toets('bewaar: BOM, frontmatter-bytes en CRLF terug', r.status === 200 && lees('01_Ontwikkeling/Fm.md') === '﻿---\r\ntitel: x\r\nverwant:\r\n  - "[[Plan]]"\r\n---\r\n# Kop\r\nnieuwe regel\r\n', [r, lees('01_Ontwikkeling/Fm.md')]);

  // niet bewerkbaar
  b = await app('bewerk', { pad: '01_Ontwikkeling/Sleutel.md' });
  toets('bewerk: pagina met sleutel = alleen lezen, gemaskeerd', b.status === 200 && !b.j.bewerkbaar && b.j.md.indexOf(TOKEN) < 0 && /sleutel/.test(b.j.reden), b);
  r = await app('bewaar', { pad: '01_Ontwikkeling/Sleutel.md', versie: b.j.versie, md: '# s\nToken [sleutel weggelaten]\n' });
  toets('bewaar: pagina met sleutel = 403, echte waarde blijft', r.status === 403 && lees('01_Ontwikkeling/Sleutel.md').indexOf(TOKEN) > 0, r);
  for (const p of ['00_Systeem/Systeemoverzicht.md', '10_Zakelijk/Tolgaarde/Bronnen/bron.md', '10_Zakelijk/Tolgaarde/actueel.md', 'CLAUDE.md']) {
    const x = await app('bewerk', { pad: p });
    const y = await app('bewaar', { pad: p, versie: x.j.versie, md: 'weg\n' });
    toets('alleen lezen: ' + p, x.status === 200 && !x.j.bewerkbaar && y.status === 403 && lees(p) !== 'weg\n', [x.j.reden, y]);
  }
  b = await app('bewerk', { pad: '01_Ontwikkeling/Plan.sync-conflict-20261026-120000-ABC.md' });
  toets('Syncthing-conflictkopie staat niet in de kaart (404)', b.status === 404, b);
  // vaste plek
  b = await app('bewerk', { pad: '01_Ontwikkeling/Fm.md' }, tel.vast);
  let bt = await app('bewerk', { pad: '01_Ontwikkeling/Fm.md' });
  r = await app('bewaar', { pad: '01_Ontwikkeling/Fm.md', versie: bt.j.versie, md: 'vast\n' }, tel.vast);
  toets('vaste plek: bewerk alleen lezen, bewaar 403', b.status === 200 && !b.j.bewerkbaar && r.status === 403, [b.j.reden, r]);
  r = await app('bewaar', { pad: '20_Prive/Notitie.md', versie: '0'.repeat(32), md: 'x' }, tel.vast);
  toets('vaste plek: privé = 404', r.status === 404, r);
  // onderhoud en grendel
  onderhoud = true; r = await app('bewaar', { pad: '01_Ontwikkeling/Fm.md', versie: bt.j.versie, md: 'x\n' }); onderhoud = false;
  toets('onderhoudsstand = 423', r.status === 423, r);
  grendel = false; r = await app('bewaar', { pad: '01_Ontwikkeling/Fm.md', versie: bt.j.versie, md: 'x\n' }); grendel = true;
  toets('vault-grendel vast (sync) = 423', r.status === 423, r);
  // invoer
  r = await app('bewaar', { pad: '01_Ontwikkeling/Fm.md', versie: 'kort', md: 'x' });
  toets('ongeldige versie = 400', r.status === 400, r);
  r = await app('bewaar', { pad: '01_Ontwikkeling/Fm.md', versie: bt.j.versie, md: 'x'.repeat(1024 * 1024 + 1) });
  toets('te groot = 413', r.status === 413, r);
  r = await app('bewaar', { pad: '../buiten.md', versie: bt.j.versie, md: 'x' });
  toets('pad buiten de vault = 404', r.status === 404, r);
  // symlink op de plek van een pagina na de kaartbouw
  fs.writeFileSync(path.join(W, 'doel.md'), 'geheim\n');
  fs.unlinkSync(path.join(V, '01_Ontwikkeling/Fm.md'));
  fs.symlinkSync(path.join(W, 'doel.md'), path.join(V, '01_Ontwikkeling/Fm.md'));
  r = await app('bewaar', { pad: '01_Ontwikkeling/Fm.md', versie: bt.j.versie, md: 'x\n' });
  toets('symlink op de plek = geweigerd, doel ongemoeid', r.status !== 200 && fs.readFileSync(path.join(W, 'doel.md'), 'utf8') === 'geheim\n', r);
  // verplaatst
  b = await app('bewerk', { pad: '01_Ontwikkeling/Plan.md' });
  fs.renameSync(path.join(V, '01_Ontwikkeling/Plan.md'), path.join(V, '01_Ontwikkeling/Plan2.md'));
  r = await app('bewaar', { pad: '01_Ontwikkeling/Plan.md', versie: b.j.versie, md: 'x\n' });
  toets('verplaatst = 404 met "tekst staat nog hier"', r.status === 404 && /nog hier/.test(r.j.fout) && !fs.existsSync(path.join(V, '01_Ontwikkeling/Plan.md')), r);
  toets('audit zonder pad', JSON.stringify(r.audit || {}).indexOf('Plan') < 0, r.audit);
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
