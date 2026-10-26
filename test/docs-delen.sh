#!/usr/bin/env bash
# Toetst OVIS Docs › Delen (wv1382; bouwplan "01_Ontwikkeling/OVIS Docs - bouwplan (26-10-2026).md" § 3.3, Opus-review § 7 #8 en #10):
# docs-delen.js (renderer: escapen, alleen http(s)-links, wikilinks/embeds/%%/HTML-commentaar; poort: nooit-mappen, sleutel, IBAN, BSN, naam in
# titel en linklabel ter bevestiging; sha van het voorbeeld; register 0600; D1 bijwerken onder dezelfde slug; intrekken; D1 faalt = niets
# in het register), vorige versie terugzetten in secondbrain.js (versies, bewaar-terug: 409, 422, 423, terug te draaien), en de koppeling
# in server.js (verse vingerafdruk, vaste plek, slotvrij intrekken, audit zonder pad of link, /health, uitrol-lijst, Dockerfile).
# Raakt de echte vault en Cloudflare niet. Gebruik: bash test/docs-delen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const S = require('./secondbrain.js'), D = require('./docs-delen.js'), VV = require('./vault-veilig.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
// BSN-masker zoals appBsnMasker (elfproef), voor de toets
const elf = (c) => { if (!/^\d{9}$/.test(c)) return false; let s = 0; for (let i = 0; i < 8; i++) s += Number(c[i]) * (9 - i); return (s - Number(c[8])) % 11 === 0; };
const bsnMasker = (t) => String(t).replace(/(?<!\d)\d(?:[ .-]?\d){8}(?![ .-]?\d)/g, (m) => elf(m.replace(/\D/g, '')) ? '[BSN]' : m);

(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'deel1382-'));
  const V = path.join(W, 'vault'), SD = path.join(W, 'sb'), DD = path.join(W, 'docs');
  const zet = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
  const lees = (p) => fs.readFileSync(path.join(V, p), 'utf8');
  const contacten = ['# Contacten', ''];
  for (let i = 0; i < 120; i++) contacten.push('- **Proefpersoon' + i + ' Achternaam' + i + '** — 06-0000000' + (i % 10));
  contacten.push('- **Jan Klaassen** — buurman', '- **David Schaap** — zelf', '- **Praktijk Groenhouten** — praktijk');
  zet('20_Prive/Contacten/Contacten.md', contacten.join('\n') + '\n');
  zet('10_Zakelijk/Tolgaarde/Medewerkers/Pietje Puk - assistent.md', '# Pietje Puk\n');
  zet('01_Ontwikkeling/Reis.md', '---\ntitel: geheim-fm\n---\n# Reis naar Keulen\n\nWe gaan **samen**. Zie [site](https://example.org/x) en [[Andere pagina|de andere]].\n\n%% interne notitie %%\n');
  zet('01_Ontwikkeling/Zonder kop.md', 'Alleen tekst.\n');
  zet('01_Ontwikkeling/Sleutel.md', '# s\nToken: abcd_Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR\n');
  zet('01_Ontwikkeling/Sleutel-in-link.md', '# s\n[hier](https://example.org/?token=Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb)\n');
  zet('01_Ontwikkeling/Iban.md', '# Betalen\nRekening NL91 ABNA 0417 1643 00.\n');
  zet('01_Ontwikkeling/Bsn.md', '# Formulier\nNummer 111222333.\n');
  zet('01_Ontwikkeling/Naam-titel.md', '# Afspraak met Jan Klaassen\n\nNiets bijzonders.\n');
  zet('01_Ontwikkeling/Naam-link.md', '# Overleg\n\nZie [Pietje Puk](https://example.org/p).\n');
  zet('01_Ontwikkeling/Naam-medewerker.md', '# Overleg\n\nMet pietje puk besproken.\n');
  zet('01_Ontwikkeling/Naam-href.md', '# Overleg\n\nZie [profiel](https://example.org/in/jan-klaassen).\n');
  zet('01_Ontwikkeling/Stuur.md', '# S\n\n[a](https://example.org/) en \u00010\u0001 en `c`\n');
  zet('01_Ontwikkeling/Alleen-david.md', '# Notitie van David Schaap\n\nOver Praktijk Groenhouten.\n');
  zet('01_Ontwikkeling/Xss.md', '# T <b>x</b>\n\n<script>alert(1)</script> [a](javascript:alert(1)) [b](data:text/html,x) ![img](https://evil.example/p.png) <img src=x onerror=alert(1)>\n');
  zet('00_Systeem/Systeemoverzicht.md', '# sys\n');
  zet('01_Ontwikkeling/Plan.md', '---\nt: 1\n---\n# Plan\n\nEerste.\n');
  zet('01_Ontwikkeling/Beveiliging/Plan.md', '# bev\n');
  zet('10_Zakelijk/DBH/Patiëntdossiers/x.md', '# dossier\n');
  zet('10_Zakelijk/Groenhouten/Bronnen/bron.md', '# bron\n');
  zet('10_Zakelijk/Tolgaarde/actueel.md', '# actueel\n');
  zet('20_Prive/Reis.md', '# privé\n');
  zet('30_Conversaties/x.md', '# gesprek\n');
  zet('10_Zakelijk/Tolgaarde/Personeel/y.md', '# p\n');

  const sb = S.maak({ vault: V, dir: SD, fout: () => {}, hmac: (p) => crypto.createHmac('sha256', 'proef').update(p).digest('hex').slice(0, 16),
    bsnMasker, lees: (p) => VV.lees(p, 'utf8'), wijzig: (p, f) => VV.wijzig(p, f), versieDir: path.join(SD, 'versies'),
    onderhoud: () => onderhoud, grendelVrij: () => grendel });
  let onderhoud = false, grendel = true;
  sb.mkdir();
  // D1 nagebootst
  const db = new Map();
  let d1Stuk = false;
  const d1 = async (sql, p) => {
    if (d1Stuk) return { ok: false, rijen: null };
    if (/^INSERT INTO deel/.test(sql)) { const oud = db.get(p[0]); db.set(p[0], { slug: p[0], soort: p[1], titel: p[2], html: p[3], sinds: oud ? oud.sinds : p[4], bijgewerkt: p[5] }); return { ok: true, rijen: [] }; }
    if (/^DELETE FROM deel/.test(sql)) { db.delete(p[0]); return { ok: true, rijen: [] }; }
    if (/^SELECT slug, soort, titel, sinds, bijgewerkt FROM deel/.test(sql)) return { ok: true, rijen: Array.from(db.values()).map((r) => ({ slug: r.slug, soort: r.soort, titel: r.titel, sinds: r.sinds, bijgewerkt: r.bijgewerkt })) };
    throw new Error('onbekende sql ' + sql);
  };
  const dd = D.maak({ dir: DD, vault: V, host: 'deel.socev.dev', fout: () => {}, bron: sb.bron, masker: S.masker, bsnMasker, isVastDicht: S.isVastDicht,
    isVerborgen: S.isVerborgen, hmac: (p) => crypto.createHmac('sha256', 'proef').update(p).digest('hex').slice(0, 16), d1, lees: (p) => fs.readFileSync(p, 'utf8') });
  const tel = {}, vast = { vast: true };
  const app = (r, d, c) => dd.app(r === 'gedeeld' ? 'GET /app/docs/gedeeld' : 'POST /app/docs/' + r, d, c || tel);

  // ── 1. renderer ──
  let v = await app('voorbeeld', { pad: '01_Ontwikkeling/Reis.md' });
  toets('1 voorbeeld: 200, titel uit de kop, geen namen', v.status === 200 && v.j.titel === 'Reis naar Keulen' && v.j.namen.length === 0 && /^[0-9a-f]{64}$/.test(v.j.sha), v.j);
  toets('1 frontmatter en %%…%% niet in de pagina', v.j.body.indexOf('geheim-fm') < 0 && v.j.body.indexOf('interne notitie') < 0, v.j.body);
  toets('1 wikilink = platte tekst (label), http-link blijft link', /de andere/.test(v.j.body) && v.j.body.indexOf('[[') < 0 && /<a href="https:\/\/example\.org\/x" rel="noopener noreferrer nofollow">site<\/a>/.test(v.j.body), v.j.body);
  const x = await app('voorbeeld', { pad: '01_Ontwikkeling/Xss.md' });
  toets('1 escapen: geen <script>, geen <img>, geen <b> uit de bron', x.status === 200 && !/<script|<img|<b>/i.test(x.j.body) && /&lt;script&gt;/.test(x.j.body), x.j.body);
  toets('1 alleen http(s)-links: javascript:/data: worden tekst', !/href="(javascript|data):/i.test(x.j.body) && (x.j.body.match(/<a /g) || []).length === 0, x.j.body);
  toets('1 beeld wordt alt-tekst', /img/.test(x.j.body) && x.j.body.indexOf('evil.example') < 0, x.j.body);
  const zk = await app('voorbeeld', { pad: '01_Ontwikkeling/Zonder kop.md' });
  toets('1 zonder kop: titel uit de bestandsnaam', zk.j.titel === 'Zonder kop' && /^<h1>Zonder kop<\/h1>/.test(zk.j.body), zk.j);
  const r1 = D.render('# A\n\n- een\n  vervolg\n- twee\n  - sub\n\n| a | b |\n|---|---|\n| [[x\\|y]] | z<br>q |\n\n%% open tot het eind', 'a.md');
  toets('1 lijst teruggevouwen, sublijst, tabel met \\| in wikilink en <br>, open %% weg', /<li>\s*een vervolg\s*<\/li>/.test(r1.body) && /<ul><li>\s*sub/.test(r1.body) && /<td>y<\/td><td>z<br>q<\/td>/.test(r1.body) && r1.body.indexOf('open tot') < 0, r1.body);
  toets('1 pagina: CSP-vriendelijk (geen script, geen externe bronnen), noindex, licht', !/<script|src=|@import|url\(/i.test(r1.html) && /noindex/.test(r1.html) && /color-scheme:light/.test(r1.html), r1.html.slice(0, 300));

  // ── 2. poort ──
  for (const [p, st, waarom] of [['00_Systeem/Systeemoverzicht.md', 403, 'systeem'], ['10_Zakelijk/DBH/Patiëntdossiers/x.md', 403, 'dossier'],
    ['10_Zakelijk/Groenhouten/Bronnen/bron.md', 403, 'bron'], ['10_Zakelijk/Tolgaarde/actueel.md', 403, 'actueel'], ['20_Prive/Reis.md', 403, 'privé'],
    ['30_Conversaties/x.md', 403, 'gesprek'], ['10_Zakelijk/Tolgaarde/Personeel/y.md', 403, 'personeel'], ['10_Zakelijk/Tolgaarde/Medewerkers/Pietje Puk - assistent.md', 403, 'medewerker']]) {
    const r = await app('voorbeeld', { pad: p });
    toets('2 nooit te delen: ' + waarom + ' (' + st + ')', r.status === st && r.j.kan_niet === true, r);
  }
  const bev = await app('voorbeeld', { pad: '01_Ontwikkeling/Beveiliging/Plan.md' });
  toets('2 Beveiliging staat niet eens in de kaart (404)', bev.status === 404, bev);
  for (const [p, re, waarom] of [['01_Ontwikkeling/Sleutel.md', /sleutel/, 'sleutel'], ['01_Ontwikkeling/Sleutel-in-link.md', /sleutel/, 'sleutel in een linkadres'],
    ['01_Ontwikkeling/Iban.md', /IBAN/, 'IBAN'], ['01_Ontwikkeling/Bsn.md', /BSN/, 'BSN']]) {
    const r = await app('voorbeeld', { pad: p });
    toets('2 weigeren: ' + waarom + ' (422, waarde niet in de melding)', r.status === 422 && re.test(r.j.fout) && !/Qw3r|0417|111222333/.test(JSON.stringify(r.j)), r);
  }
  let n = await app('voorbeeld', { pad: '01_Ontwikkeling/Naam-titel.md' });
  toets('2 naam in de titel: getoond ter bevestiging', n.status === 200 && JSON.stringify(n.j.namen) === '["Jan Klaassen"]', n.j.namen);
  n = await app('voorbeeld', { pad: '01_Ontwikkeling/Naam-link.md' });
  toets('2 naam in een linklabel (medewerker)', n.status === 200 && JSON.stringify(n.j.namen) === '["Pietje Puk"]', n.j.namen);
  n = await app('voorbeeld', { pad: '01_Ontwikkeling/Naam-medewerker.md' });
  toets('2 naam in kleine letters in lopende tekst', n.status === 200 && n.j.namen.length === 1, n.j.namen);
  n = await app('voorbeeld', { pad: '01_Ontwikkeling/Naam-href.md' });
  toets('2 naam in een linkadres', n.status === 200 && JSON.stringify(n.j.namen) === '["Jan Klaassen"]', n.j.namen);
  n = await app('voorbeeld', { pad: '01_Ontwikkeling/Stuur.md' });
  toets('2 stuurtekens in de bron kunnen geen plaatshouder namaken', n.status === 200 && (n.j.body.match(/<a /g) || []).length === 1 && (n.j.body.match(/<\/a>/g) || []).length === 1 && !/[\u0001\u0002]/.test(n.j.body), n.j.body);
  n = await app('voorbeeld', { pad: '01_Ontwikkeling/Alleen-david.md' });
  toets('2 David zelf en de praktijknaam tellen niet als naam', n.status === 200 && n.j.namen.length === 0, n.j.namen);
  const vv = await app('voorbeeld', { pad: '01_Ontwikkeling/Reis.md' }, vast);
  toets('2 vaste plek: 403', vv.status === 403, vv);
  fs.renameSync(path.join(V, '20_Prive/Contacten/Contacten.md'), path.join(V, '20_Prive/Contacten/weg.md'));
  const dd2 = D.maak({ dir: DD, vault: V, host: 'deel.socev.dev', fout: () => {}, bron: sb.bron, masker: S.masker, bsnMasker, isVastDicht: S.isVastDicht,
    isVerborgen: S.isVerborgen, hmac: (p) => 'h', d1, lees: (p) => fs.readFileSync(p, 'utf8') });
  const blind = await dd2.app('POST /app/docs/voorbeeld', { pad: '01_Ontwikkeling/Reis.md' }, tel);
  toets('2 namenlijst onleesbaar = poort dicht (503)', blind.status === 503, blind);
  fs.renameSync(path.join(V, '20_Prive/Contacten/weg.md'), path.join(V, '20_Prive/Contacten/Contacten.md'));

  // ── 3. delen, register, bijwerken, intrekken ──
  v = await app('voorbeeld', { pad: '01_Ontwikkeling/Reis.md' });
  let r = await app('delen', { pad: '01_Ontwikkeling/Reis.md', soort: 'beveiligd', sha: v.j.sha });
  toets('3 beveiligd: volgt nog (400)', r.status === 400 && /volgt/.test(r.j.fout), r);
  r = await app('delen', { pad: '01_Ontwikkeling/Reis.md', soort: 'openbaar', sha: 'f'.repeat(64) });
  toets('3 andere sha dan het voorbeeld: 409, niets in D1', r.status === 409 && db.size === 0, r);
  d1Stuk = true;
  r = await app('delen', { pad: '01_Ontwikkeling/Reis.md', soort: 'openbaar', sha: v.j.sha });
  toets('3 D1 faalt: 502 en niets in het register', r.status === 502 && (await app('stand', { pad: '01_Ontwikkeling/Reis.md' })).j.gedeeld === null, r);
  d1Stuk = false;
  r = await app('delen', { pad: '01_Ontwikkeling/Reis.md', soort: 'openbaar', sha: v.j.sha });
  toets('3 delen: 200, link op deel.socev.dev/p/<22 willekeurige tekens>', r.status === 200 && /^https:\/\/deel\.socev\.dev\/p\/[A-Za-z0-9_-]{22}$/.test(r.j.gedeeld.url) && !/reis|keulen/i.test(r.j.gedeeld.slug), r);
  const slug = r.j.gedeeld.slug;
  toets('3 D1 kreeg precies de HTML van het voorbeeld', db.get(slug) && crypto.createHash('sha256').update(db.get(slug).html).digest('hex') === v.j.sha && db.get(slug).soort === 'openbaar');
  const regPad = path.join(DD, 'gedeeld.json');
  const reg = JSON.parse(fs.readFileSync(regPad, 'utf8'));
  toets('3 register 0600 (map 0700), HMAC i.p.v. pad, sha erbij', (fs.statSync(regPad).mode & 0o777) === 0o600 && (fs.statSync(DD).mode & 0o777) === 0o700 &&
    reg.delingen.length === 1 && /^[0-9a-f]{16}$/.test(reg.delingen[0].h) && fs.readFileSync(regPad, 'utf8').indexOf('01_Ontwikkeling') < 0 && reg.delingen[0].sha === v.j.sha, reg);
  let s = await app('stand', { pad: '01_Ontwikkeling/Reis.md' });
  toets('3 stand: gedeeld, niet veranderd', s.j.kan_delen && s.j.gedeeld && s.j.gedeeld.slug === slug && s.j.veranderd === false, s.j);
  zet('01_Ontwikkeling/Reis.md', lees('01_Ontwikkeling/Reis.md') + '\nNieuwe alinea.\n');
  s = await app('stand', { pad: '01_Ontwikkeling/Reis.md' });
  toets('3 stand: pagina veranderd sinds het delen', s.j.veranderd === true, s.j);
  const v2 = await app('voorbeeld', { pad: '01_Ontwikkeling/Reis.md' });
  r = await app('delen', { pad: '01_Ontwikkeling/Reis.md', soort: 'openbaar', sha: v2.j.sha });
  toets('3 opnieuw delen = bijwerken onder dezelfde slug', r.status === 200 && r.j.bijgewerkt === true && r.j.gedeeld.slug === slug && db.size === 1 && /Nieuwe alinea/.test(db.get(slug).html), r);
  // namen bevestigen
  const vn = await app('voorbeeld', { pad: '01_Ontwikkeling/Naam-titel.md' });
  r = await app('delen', { pad: '01_Ontwikkeling/Naam-titel.md', soort: 'openbaar', sha: vn.j.sha });
  toets('3 naam niet bevestigd: 409 met de namen, niets gedeeld', r.status === 409 && JSON.stringify(r.j.namen) === '["Jan Klaassen"]' && db.size === 1, r);
  r = await app('delen', { pad: '01_Ontwikkeling/Naam-titel.md', soort: 'openbaar', sha: vn.j.sha, bevestig_namen: ['Jan Klaassen'] });
  toets('3 naam bevestigd: gedeeld (niets weggehaald)', r.status === 200 && db.size === 2 && /Jan Klaassen/.test(db.get(r.j.gedeeld.slug).html), r);
  const slug2 = r.j.gedeeld.slug;
  let g = await app('gedeeld', {});
  toets('3 gedeeld: twee, uit D1, met titel en link', g.status === 200 && g.j.d1 === true && g.j.delingen.length === 2 && g.j.delingen.every((x) => x.in_register && /^https:\/\/deel\.socev\.dev\/p\//.test(x.url)), g.j);
  d1Stuk = true;
  g = await app('gedeeld', {});
  toets('3 gedeeld zonder D1: register, met d1:false', g.status === 200 && g.j.d1 === false && g.j.delingen.length === 2 && g.j.delingen.every((x) => x.buiten === null), g.j);
  r = await app('intrekken', { slug: slug2 });
  toets('3 intrekken terwijl D1 faalt: 502, blijft in het register', r.status === 502 && JSON.parse(fs.readFileSync(regPad, 'utf8')).delingen.length === 2, r);
  d1Stuk = false;
  r = await app('intrekken', { slug: slug2 });
  toets('3 intrekken: D1-rij weg en registerregel weg', r.status === 200 && !db.has(slug2) && JSON.parse(fs.readFileSync(regPad, 'utf8')).delingen.length === 1, r);
  r = await app('intrekken', { slug: '../../etc' });
  toets('3 intrekken: onzin-slug 400', r.status === 400, r);
  r = await app('intrekken', { slug: slug }, vast);
  toets('3 intrekken mag ook vanaf een vaste plek', r.status === 200 && db.size === 0, r);
  db.set('Zzzzzzzzzzzzzzzzzzzzzz', { slug: 'Zzzzzzzzzzzzzzzzzzzzzz', soort: 'openbaar', titel: 't', html: 'x', sinds: 's', bijgewerkt: 's' });
  g = await app('gedeeld', {});
  toets('3 gedeeld: een D1-rij buiten het register staat er ook (in_register:false)', g.j.delingen.length === 1 && g.j.delingen[0].in_register === false, g.j);
  toets('3 health zonder links', JSON.stringify(dd.health()).indexOf(slug) < 0 && dd.health().aan === true);

  // ── 4. vorige versie terugzetten (secondbrain.js) ──
  const sbapp = (r, d, c) => sb.app('POST /app/secondbrain/' + r, d, c || tel);
  let b = await sbapp('bewerk', { pad: '01_Ontwikkeling/Plan.md' });
  let w = await sbapp('bewaar', { pad: '01_Ontwikkeling/Plan.md', versie: b.j.versie, md: '# Plan\n\nTweede.\n' });
  let vs = await sbapp('versies', { pad: '01_Ontwikkeling/Plan.md' });
  toets('4 versies: één vorige, met tijd, versie van nu', vs.status === 200 && vs.j.versies.length === 1 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(vs.j.versies[0].op) && vs.j.versie === w.j.versie, vs.j);
  let t = await sbapp('bewaar-terug', { pad: '01_Ontwikkeling/Plan.md', versie: b.j.versie, id: vs.j.versies[0].id });
  toets('4 terugzetten met een oude versie: 409, niets geschreven', t.status === 409 && /Tweede/.test(lees('01_Ontwikkeling/Plan.md')), t);
  onderhoud = true;
  t = await sbapp('bewaar-terug', { pad: '01_Ontwikkeling/Plan.md', versie: vs.j.versie, id: vs.j.versies[0].id });
  toets('4 terugzetten in onderhoud: 423', t.status === 423, t);
  onderhoud = false;
  t = await sbapp('bewaar-terug', { pad: '01_Ontwikkeling/Plan.md', versie: vs.j.versie, id: vs.j.versies[0].id });
  toets('4 terugzetten: hele vorige inhoud terug (met frontmatter)', t.status === 200 && t.j.gewijzigd && lees('01_Ontwikkeling/Plan.md') === '---\nt: 1\n---\n# Plan\n\nEerste.\n', [t, lees('01_Ontwikkeling/Plan.md')]);
  vs = await sbapp('versies', { pad: '01_Ontwikkeling/Plan.md' });
  toets('4 terugzetten is terug te draaien (de tweede staat nu als vorige)', vs.j.versies.length === 2 && fs.readFileSync(path.join(SD, 'versies', crypto.createHmac('sha256', 'proef').update('01_Ontwikkeling/Plan.md').digest('hex').slice(0, 16), vs.j.versies[0].id), 'utf8').indexOf('Tweede') > 0, vs.j);
  t = await sbapp('bewaar-terug', { pad: '01_Ontwikkeling/Plan.md', versie: vs.j.versie, id: '../../../etc/passwd' });
  toets('4 onzin-id: 400', t.status === 400, t);
  t = await sbapp('bewaar-terug', { pad: '01_Ontwikkeling/Plan.md', versie: vs.j.versie, id: '2020-01-01T00-00-00-000Z-abcdef.md' });
  toets('4 onbekende versie: 404', t.status === 404, t);
  const vmap = path.join(SD, 'versies', crypto.createHmac('sha256', 'proef').update('01_Ontwikkeling/Plan.md').digest('hex').slice(0, 16));
  fs.writeFileSync(path.join(vmap, '2020-01-01T00-00-00-000Z-abcdef.md'), 'Token: abcd_Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR\n', { mode: 0o600 });
  t = await sbapp('bewaar-terug', { pad: '01_Ontwikkeling/Plan.md', versie: vs.j.versie, id: '2020-01-01T00-00-00-000Z-abcdef.md' });
  toets('4 vorige versie met een sleutel: 422', t.status === 422, t);
  fs.unlinkSync(path.join(vmap, '2020-01-01T00-00-00-000Z-abcdef.md'));
  fs.symlinkSync(path.join(V, '01_Ontwikkeling/Sleutel.md'), path.join(vmap, '2020-01-02T00-00-00-000Z-abcdef.md'));
  t = await sbapp('bewaar-terug', { pad: '01_Ontwikkeling/Plan.md', versie: vs.j.versie, id: '2020-01-02T00-00-00-000Z-abcdef.md' });
  toets('4 symlink als versie: 404', t.status === 404, t);
  t = await sbapp('versies', { pad: '01_Ontwikkeling/Plan.md' }, vast);
  toets('4 versies op een vaste plek: 403', t.status === 403, t);

  // ── 5. server.js ──
  const src = fs.readFileSync('server.js', 'utf8');
  const beheer = /const APP_BEHEER_ROUTES = new Set\(\[([\s\S]*?)\]\);/.exec(src)[1];
  const slotVrij = /const APP_SLOT_VRIJ = new Set\(\[([^\]]*)\]\)/.exec(src)[1];
  toets('5 delen in APP_BEHEER_ROUTES (nooit vanaf een vaste plek), intrekken in APP_SLOT_VRIJ', beheer.indexOf("'POST /app/docs/delen'") >= 0 && slotVrij.indexOf("'POST /app/docs/intrekken'") >= 0 && slotVrij.indexOf('docs/delen') < 0);
  toets('5 dispatch /app/docs/* via appDocs', /route === 'GET \/app\/docs\/gedeeld' \|\| route\.indexOf\('POST \/app\/docs\/'\) === 0\) return typeof appDocs === 'function'/.test(src));
  toets('5 teller docs vooraf in appStaat', /tellers: \{[^}]*docs: \[\]/.test(src));
  toets('5 /health.docs_delen', /docs_delen: docsDelenInfo\(\),/.test(src));
  toets('5 uitrol-lijst en Dockerfile', /RELEASE_OPTIONEEL="[^"]*docs-delen\.js/.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY docs-delen\.js \/app\/release-bootstrap\/docs-delen\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  toets('5 D1-id ingevuld (geen plaatshouder meer)', !/__DOCS_D1_ID__/.test(src) && /const DOCS_D1_ID = process\.env\.DOCS_D1_ID \|\| '[0-9a-f-]{36}';/.test(src));
  const vm = require('vm');
  const hb = src.indexOf('// ── Second Brain (wv832'), he = src.indexOf('// ── einde secondbrain');
  const db0 = src.indexOf('// ── OVIS Docs › Delen (wv1382'), de = src.indexOf('// ── einde docs delen');
  const gestuurd = [];
  const cfAanroep = [];
  const ctx = vm.createContext({ require, process: { env: { SECONDBRAIN_DIR: path.join(W, 'sd2'), DOCS_DIR: path.join(W, 'docs2'), CLOUDFLARE_API_TOKEN: 'proef' } }, __dirname: process.cwd(), path, fs, crypto, console,
    setInterval: () => ({ unref() {} }), VAULT: V, logError: () => {}, appBsnMasker: bsnMasker, appPoortGeheim: () => 'proefgeheim', VV: () => VV, onderhoud: { stand: () => ({ aan: false }) }, ONDERHOUD_LOCK: '/tmp/x',
    smalCf: async (url, body) => { cfAanroep.push({ url, body }); return { status: 200, j: { success: true, result: [{ success: true, results: [] }] } }; },
    SMAL_CF_BASIS: 'https://cf', SMAL_CF_ACCOUNT: 'acc', appTeller: () => true, appVersOk: (a, s) => s.vers === true,
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Date, Promise, JSON, String, Number, Array, Object, Math, Buffer, Map, Set });
  vm.runInContext(src.slice(hb, he) + '\n' + src.slice(db0, de) + ';globalThis.__dd = { docsDelen, appDocs, docsDelenInfo };', ctx, { filename: 'server.js#docs' });
  toets('5 koppeling laadt (docsDelen aan)', !!ctx.__dd.docsDelen && ctx.__dd.docsDelenInfo().aan === true, ctx.__dd.docsDelenInfo());
  let res = { _app: {} };
  await ctx.__dd.appDocs({}, res, { soort: 'meereizend' }, { vers: false }, { pad: '01_Ontwikkeling/Reis.md', soort: 'openbaar', sha: 'a'.repeat(64) }, 'POST /app/docs/delen');
  toets('5 delen zonder verse vingerafdruk: 403 vers_nodig, geen D1', gestuurd[0].s === 403 && gestuurd[0].j.vers_nodig === true && cfAanroep.length === 0, gestuurd[0]);
  res = { _app: {} };
  await ctx.__dd.appDocs({}, res, { soort: 'meereizend' }, {}, { pad: '01_Ontwikkeling/Reis.md' }, 'POST /app/docs/voorbeeld');
  const vb = gestuurd[1];
  toets('5 voorbeeld: 200, reden zonder pad', vb.s === 200 && /^docs voorbeeld Ontwikkeling h=[0-9a-f]{16}$/.test(res._app.reden), { s: vb.s, r: res._app.reden });
  const sess = { vers: true, vers_tot: 1 };
  res = { _app: {} };
  await ctx.__dd.appDocs({}, res, { soort: 'meereizend' }, sess, { pad: '01_Ontwikkeling/Reis.md', soort: 'openbaar', sha: vb.j.sha }, 'POST /app/docs/delen');
  const dl = gestuurd[2];
  toets('5 delen met verse vingerafdruk: 200, D1-query naar de juiste databank, vingerafdruk verbruikt', dl.s === 200 && cfAanroep.length === 1 &&
    /^https:\/\/cf\/client\/v4\/accounts\/acc\/d1\/database\/[0-9a-f-]{36}\/query$/.test(cfAanroep[0].url) && /^INSERT INTO deel/.test(cfAanroep[0].body.sql) && sess.vers_tot === 0, { dl, cf: cfAanroep[0] && cfAanroep[0].url });
  toets('5 audit: geen pad en geen link in de reden', res._app.reden.indexOf(dl.j.gedeeld.slug) < 0 && res._app.reden.indexOf('Reis') < 0, res._app.reden);

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
