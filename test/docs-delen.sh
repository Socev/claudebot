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
    if (/^INSERT INTO deel \(slug, soort, titel, html, sinds, bijgewerkt, aud, ontvangers, access_app\)/.test(sql)) { const oud = db.get(p[0]); db.set(p[0], { slug: p[0], soort: p[1], titel: p[2], html: p[3], sinds: oud ? oud.sinds : p[4], bijgewerkt: p[5], aud: p[6], ontvangers: p[7], access_app: p[8] }); return { ok: true, rijen: [] }; }
    if (/^DELETE FROM deel/.test(sql)) { db.delete(p[0]); return { ok: true, rijen: [] }; }
    if (/^SELECT soort, access_app FROM deel WHERE slug = \?1$/.test(sql)) { const r = db.get(p[0]); return { ok: true, rijen: r ? [{ soort: r.soort, access_app: r.access_app || null }] : [] }; }
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
  // wv1889: render draait bij Delen in het serverproces; elke vreemde regel van 2 MB moet lineair blijven (was kwadratisch/kubisch)
  const M2 = 2 * 1024 * 1024, herhaal = (p) => p.repeat(Math.ceil(M2 / p.length));
  const traag = [];
  for (const [naam, s] of [['[[', herhaal('[[')], ['[', herhaal('[')], ['**', herhaal('**')], ['![', herhaal('![')], ['![[', herhaal('![[')], ['[a](', herhaal('[a](')],
    ['![a](', herhaal('![a](')], ['[a](u "', herhaal('[a](u "')], ['kop met spaties', '# a' + ' '.repeat(M2) + 'b'], ['kop met hekjes', '# a' + '#'.repeat(M2) + 'b'],
    ['tabelscheiding', 'a|b\n|-' + ' '.repeat(M2) + 'x'], ['tabelscheiding 2', 'a|b\n-' + ' '.repeat(M2) + '|x']]) {
    const t0 = Date.now();
    try { D.render(s, 'x.md'); } catch (e) { traag.push(naam + ': ' + e.message); continue; }
    if (Date.now() - t0 >= 1000) traag.push(naam + ': ' + (Date.now() - t0) + ' ms');
  }
  toets('1 render lineair: 2 MB "[[", "[", "**", beeld, embed, link, kop, tabelscheiding elk < 1 s (wv1889)', traag.length === 0, traag);
  const r2 = D.render('## Kop ## \n\n- [a](https://example.org/a "t") ![b](x.png) ![[e]] [c]() [d](javascript:x)\n\nx|y\n|:-:| - |\n1|2\n\n * * *\n', 'b.md');
  toets('1 render na wv1889: kop zonder slothekjes, link met titel, beeld = alt, embed weg, tabel, lijn', /<h2>Kop<\/h2>/.test(r2.body) &&
    r2.body.indexOf('<a href="https://example.org/a" rel="noopener noreferrer nofollow">a</a> b  [c]() d') > 0 && /<table>/.test(r2.body) && /<hr>/.test(r2.body), r2.body);
  toets('1 pagina: OVIS-favicon als data:-URI (DS10, wv1783), gelijk aan huisstijl-pod', (r1.html.match(/<link rel="icon"/g) || []).length === 1 && r1.html.indexOf('href="' + require('./huisstijl-pod.js').POD_FAVICON + '"') > 0 && /^data:image\/png;base64,/.test(require('./huisstijl-pod.js').POD_FAVICON), r1.html.slice(0, 400));

  // ── 2. poort ──
  for (const [p, st, waarom] of [['00_Systeem/Systeemoverzicht.md', 403, 'systeem'], ['10_Zakelijk/DBH/Patiëntdossiers/x.md', 403, 'dossier'],
    ['10_Zakelijk/Groenhouten/Bronnen/bron.md', 403, 'bron'], ['10_Zakelijk/Tolgaarde/actueel.md', 403, 'actueel'], ['20_Prive/Reis.md', 403, 'privé'],
    ['30_Conversaties/x.md', 403, 'gesprek'], ['10_Zakelijk/Tolgaarde/Personeel/y.md', 403, 'personeel'], ['10_Zakelijk/Tolgaarde/Medewerkers/Pietje Puk - assistent.md', 403, 'medewerker']]) {
    const r = await app('voorbeeld', { pad: p });
    toets('2 nooit te delen: ' + waarom + ' (' + st + ')', r.status === st && r.j.kan_niet === true, r);
  }
  const bev = await app('voorbeeld', { pad: '01_Ontwikkeling/Beveiliging/Plan.md' });
  toets('2 Beveiliging: sinds wv1931 zichtbaar voor David, maar nooit te delen (403 kan_niet)', bev.status === 403 && bev.j.kan_niet === true, bev);
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
  let r = await app('delen', { pad: '01_Ontwikkeling/Reis.md', soort: 'beveiligd', sha: v.j.sha, ontvangers: ['a@example.org'] });
  toets('3 beveiligd zonder Access op de pod: 503, niets gedeeld', r.status === 503 && db.size === 0, r);
  r = await app('delen', { pad: '01_Ontwikkeling/Reis.md', soort: 'iets', sha: v.j.sha });
  toets('3 onbekende soort: 400', r.status === 400, r);
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

  // ── 6. beveiligd (wv1383): Access-app per deling, toestaanlijst, intrekken ruimt alles op ──
  const OTP = 'e9e612dc-1f11-4c07-bd74-5929e4704eec';
  const apps = new Map();   // id → body + aud
  const accLog = [];
  let accStuk = {};   // { maak, wijzig, weg, haal, zoek } = true → faalt
  const nieuwId = () => crypto.randomUUID();
  apps.set('11111111-1111-4111-8111-111111111111', { domain: 'deel.socev.dev', aud: 'davidaud' });   // de app van David op het hele subdomein
  apps.set('22222222-2222-4222-8222-222222222222', { domain: 'deel.socev.dev/p/*', aud: 'bypass' });
  const access = { idp: OTP,
    maak: async (body) => { accLog.push(['maak', body.domain]); if (accStuk.maak) return { ok: false }; const id = nieuwId(); apps.set(id, Object.assign({}, body, { aud: 'aud-' + id.slice(0, 8) })); return { ok: true, id, aud: 'aud-' + id.slice(0, 8) }; },
    wijzig: async (id, body) => { accLog.push(['wijzig', id]); if (accStuk.wijzig || !apps.has(id)) return { ok: false }; apps.set(id, Object.assign({}, body, { aud: apps.get(id).aud })); return { ok: true, aud: apps.get(id).aud }; },
    haal: async (id) => { accLog.push(['haal', id]); if (accStuk.haal) return { ok: false }; return apps.has(id) ? { ok: true, domein: apps.get(id).domain } : { ok: false, weg: true }; },
    weg: async (id) => { accLog.push(['weg', id]); if (accStuk.weg) return { ok: false }; apps.delete(id); return { ok: true }; },
    zoek: async (dom) => { accLog.push(['zoek', dom]); if (accStuk.zoek) return { ok: false }; return { ok: true, ids: Array.from(apps.entries()).filter(([, b]) => b.domain === dom).map(([i]) => i) }; } };
  const DD3 = path.join(W, 'docs3');
  const db3 = new Map();
  let d1Stuk3 = false;
  const d13 = async (sql, p) => { if (d1Stuk3) return { ok: false, rijen: null }; db.clear(); for (const [k, v2] of db3) db.set(k, v2); const r = await d1(sql, p); db3.clear(); for (const [k, v2] of db) db3.set(k, v2); return r; };
  const ddb = D.maak({ dir: DD3, vault: V, host: 'deel.socev.dev', fout: () => {}, bron: sb.bron, masker: S.masker, bsnMasker, isVastDicht: S.isVastDicht,
    isVerborgen: S.isVerborgen, hmac: (p) => crypto.createHmac('sha256', 'proef').update(p).digest('hex').slice(0, 16), d1: d13, lees: (p) => fs.readFileSync(p, 'utf8'), access });
  const appb = (r, d, c) => ddb.app(r === 'gedeeld' ? 'GET /app/docs/gedeeld' : 'POST /app/docs/' + r, d, c || tel);
  const reg3 = () => { try { return JSON.parse(fs.readFileSync(path.join(DD3, 'gedeeld.json'), 'utf8')).delingen; } catch (e) { return []; } };
  const pApps = () => Array.from(apps.values()).filter((b) => /\/b\//.test(b.domain));
  const P = '01_Ontwikkeling/Plan.md';
  let vb3 = await appb('voorbeeld', { pad: P });
  toets('6 voorbeeld meldt dat beveiligd kan', vb3.status === 200 && vb3.j.beveiligd === true, vb3.j);
  for (const [o, re, waarom] of [[[], /minstens/, 'geen adres'], [['geen-adres'], /geen mailadres/, 'onzin'], [['*@example.org'], /geen mailadres/, 'jokerteken'],
    [['a@example'], /geen mailadres/, 'zonder punt in het domein'], [['a..b@example.org'], /geen mailadres/, 'twee punten'], [Array.from({ length: 11 }, (_, i) => 'p' + i + '@example.org'), /hooguit 10/, '11 adressen']]) {
    r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: o });
    toets('6 ontvangers geweigerd: ' + waarom + ' (400, niets bij Access)', r.status === 400 && re.test(r.j.fout) && accLog.length === 0, r);
  }
  toets('6 ontvangers: kleine letters, uniek, ook als tekst met komma\'s', JSON.stringify(D.ontvangersUit('A@Example.org, a@example.org; b@x.nl').lijst) === '["a@example.org","b@x.nl"]');
  accStuk = { maak: true };
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['proef@example.org'] });
  toets('6 Access-app maken faalt: 502, niets in register of D1', r.status === 502 && reg3().length === 0 && db3.size === 0, r);
  accStuk = {};
  d1Stuk3 = true;
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['proef@example.org'] });
  toets('6 D1 faalt na de Access-app: app weer weg, register leeg', r.status === 502 && pApps().length === 0 && reg3().length === 0, { r, apps: pApps() });
  d1Stuk3 = false;
  accLog.length = 0;
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['Proef@Example.org', 'tweede@example.org'] });
  const bs = r.j && r.j.gedeeld && r.j.gedeeld.slug;
  toets('6 beveiligd delen: 200, link deel.socev.dev/b/<22>, ontvangers terug', r.status === 200 && /^https:\/\/deel\.socev\.dev\/b\/[A-Za-z0-9_-]{22}$/.test(r.j.gedeeld.url) &&
    JSON.stringify(r.j.gedeeld.ontvangers) === '["proef@example.org","tweede@example.org"]', r);
  const ap = pApps();
  toets('6 één Access-app op precies deel.socev.dev/b/<slug>: alleen One-time PIN, 24 u, beleid = de twee adressen', ap.length === 1 && ap[0].domain === 'deel.socev.dev/b/' + bs &&
    ap[0].destinations.length === 1 && ap[0].destinations[0].uri === ap[0].domain && JSON.stringify(ap[0].allowed_idps) === JSON.stringify([OTP]) && ap[0].session_duration === '24h' &&
    ap[0].policies.length === 1 && ap[0].policies[0].decision === 'allow' && JSON.stringify(ap[0].policies[0].include) === JSON.stringify([{ email: { email: 'proef@example.org' } }, { email: { email: 'tweede@example.org' } }]) &&
    !/plan/i.test(ap[0].name), ap);
  const rij3 = db3.get(bs);
  toets('6 D1: soort beveiligd, aud van die app, alleen hashes van de adressen', rij3 && rij3.soort === 'beveiligd' && rij3.aud === ap[0].aud && rij3.access_app &&
    JSON.stringify(JSON.parse(rij3.ontvangers)) === JSON.stringify([D.mailHash('proef@example.org'), D.mailHash('tweede@example.org')]) && rij3.ontvangers.indexOf('@') < 0, rij3);
  toets('6 register: soort, ontvangers, app-id, aud (0600)', reg3().length === 1 && reg3()[0].access_app === rij3.access_app && reg3()[0].aud === rij3.aud &&
    (fs.statSync(path.join(DD3, 'gedeeld.json')).mode & 0o777) === 0o600, reg3());
  r = await appb('delen', { pad: P, soort: 'openbaar', sha: vb3.j.sha });
  toets('6 van soort wisselen: 409 (eerst intrekken), niets veranderd', r.status === 409 && r.j.soort_anders === true && db3.get(bs).soort === 'beveiligd' && pApps().length === 1, r);
  accLog.length = 0;
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['tweede@example.org', 'proef@example.org'] });
  toets('6 opnieuw delen met dezelfde adressen: zelfde slug, app alleen opgehaald (niet gewijzigd)', r.status === 200 && r.j.bijgewerkt && r.j.gedeeld.slug === bs &&
    accLog.every((x) => x[0] === 'haal') && accLog.length === 1, { r, accLog });
  accLog.length = 0;
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['derde@example.org'] });
  toets('6 andere adressen: beleid van dezelfde app bijgewerkt, D1-hashes mee', r.status === 200 && pApps().length === 1 && JSON.stringify(pApps()[0].policies[0].include) === JSON.stringify([{ email: { email: 'derde@example.org' } }]) &&
    JSON.parse(db3.get(bs).ontvangers)[0] === D.mailHash('derde@example.org') && pApps()[0].aud === rij3.aud, { r, accLog });
  d1Stuk3 = true;
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['vierde@example.org'] });
  d1Stuk3 = false;
  toets('6 D1 faalt bij andere adressen: beleid terug naar de vorige adressen, register ongewijzigd', r.status === 502 &&
    JSON.stringify(pApps()[0].policies[0].include) === JSON.stringify([{ email: { email: 'derde@example.org' } }]) && JSON.stringify(reg3()[0].ontvangers) === '["derde@example.org"]', { r, inc: pApps()[0].policies[0].include });
  let g3 = await appb('gedeeld', {});
  toets('6 gedeeld: beveiligd met de ontvangers', g3.j.delingen.length === 1 && g3.j.delingen[0].soort === 'beveiligd' && JSON.stringify(g3.j.delingen[0].ontvangers) === '["derde@example.org"]', g3.j);
  // toestaanlijst: een vervalst app-id in het register raakt een andere app niet
  const echt = reg3()[0].access_app;
  const rr = JSON.parse(fs.readFileSync(path.join(DD3, 'gedeeld.json'), 'utf8'));
  rr.delingen[0].access_app = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(DD3, 'gedeeld.json'), JSON.stringify(rr), { mode: 0o600 });
  accLog.length = 0;
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['vijfde@example.org'] });
  toets('6 toestaanlijst: app-id van een andere app (domein klopt niet) wordt niet gewijzigd', r.status === 502 && apps.get('11111111-1111-4111-8111-111111111111').domain === 'deel.socev.dev' &&
    !apps.get('11111111-1111-4111-8111-111111111111').policies && !accLog.some((x) => x[0] !== 'haal'), { r, accLog });
  r = await appb('intrekken', { slug: bs });
  toets('6 toestaanlijst: intrekken met dat vervalste id laat die app staan; de echte (via zoeken) gaat weg', r.status === 200 && apps.has('11111111-1111-4111-8111-111111111111') &&
    !apps.has(echt) && pApps().length === 0 && !db3.has(bs) && reg3().length === 0, { r, accLog });
  // intrekken: Access faalt → pagina toch weg, regel blijft, tweede keer ruimt op
  vb3 = await appb('voorbeeld', { pad: P });
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['proef@example.org'] });
  const bs2 = r.j.gedeeld.slug;
  toets('6 nieuwe deling na intrekken krijgt een nieuwe slug', r.status === 200 && bs2 !== bs && pApps().length === 1, r);
  accStuk = { weg: true };
  r = await appb('intrekken', { slug: bs2 });
  toets('6 intrekken, Access faalt: D1-rij weg (link dood), 502 deels, regel blijft met access_open', r.status === 502 && r.j.deels === true && !db3.has(bs2) && reg3().length === 1 && reg3()[0].access_open === true && pApps().length === 1, r);
  accStuk = {};
  r = await appb('intrekken', { slug: bs2 });
  toets('6 nog eens intrekken: app weg, regel weg', r.status === 200 && pApps().length === 0 && reg3().length === 0, r);
  // wees-app: D1-rij beveiligd buiten het register (register kwijt) → intrekken ruimt app via D1-id op
  const wees = 'Wwwwwwwwwwwwwwwwwwwwww';
  const wid = nieuwId();
  apps.set(wid, { domain: 'deel.socev.dev/b/' + wees, aud: 'w' });
  db3.set(wees, { slug: wees, soort: 'beveiligd', titel: 't', html: 'x', sinds: 's', bijgewerkt: 's', aud: 'w', ontvangers: '[]', access_app: wid });
  r = await appb('intrekken', { slug: wees });
  toets('6 D1-rij buiten het register: intrekken haalt rij en app weg (D1 = deelregister)', r.status === 200 && !apps.has(wid) && !db3.has(wees), r);
  const vreemd = 'Vvvvvvvvvvvvvvvvvvvvvv';
  apps.set('33333333-3333-4333-8333-333333333333', { domain: 'deel.socev.dev/b/' + vreemd, aud: 'v' });
  r = await appb('intrekken', { slug: vreemd });
  toets('6 toestaanlijst: slug in geen enkel register = geen Access-aanroep op die app', r.status === 200 && apps.has('33333333-3333-4333-8333-333333333333'), r);
  apps.delete('33333333-3333-4333-8333-333333333333');
  // app met de hand weggehaald → opnieuw delen maakt een nieuwe
  vb3 = await appb('voorbeeld', { pad: P });
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['proef@example.org'] });
  const bs3 = r.j.gedeeld.slug;
  apps.delete(reg3()[0].access_app);
  r = await appb('delen', { pad: P, soort: 'beveiligd', sha: vb3.j.sha, ontvangers: ['proef@example.org'] });
  toets('6 app met de hand weggehaald: opnieuw delen maakt een nieuwe (nieuwe aud in D1)', r.status === 200 && pApps().length === 1 && db3.get(bs3).access_app === reg3()[0].access_app && db3.get(bs3).aud === pApps()[0].aud, r);
  r = await appb('intrekken', { slug: bs3 }, vast);
  toets('6 intrekken (ook vaste plek) laat niets achter: geen /b/-app, geen D1-rij, geen regel', r.status === 200 && pApps().length === 0 && db3.size === 0 && reg3().length === 0, r);
  toets('6 health telt beveiligd, zonder links', ddb.health().beveiligd === 0 && ddb.health().beveiligd_aan === true && JSON.stringify(ddb.health()).indexOf(bs3) < 0, ddb.health());

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
  const fetchLog = [];
  let fetchAntw = () => ({ success: true, result: {} });
  const ctx = vm.createContext({ require, process: { env: { SECONDBRAIN_DIR: path.join(W, 'sd2'), DOCS_DIR: path.join(W, 'docs2'), CLOUDFLARE_API_TOKEN: 'proef' } }, __dirname: process.cwd(), path, fs, crypto, console,
    setInterval: () => ({ unref() {} }), VAULT: V, logError: () => {}, appBsnMasker: bsnMasker, appPoortGeheim: () => 'proefgeheim', VV: () => VV, onderhoud: { stand: () => ({ aan: false }) }, ONDERHOUD_LOCK: '/tmp/x',
    smalCf: async (url, body) => { cfAanroep.push({ url, body }); return { status: 200, j: { success: true, result: [{ success: true, results: [] }] } }; },
    SMAL_CF_BASIS: 'https://cf', SMAL_CF_ACCOUNT: 'acc', appTeller: () => true, appVersOk: (a, s) => s.vers === true,
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Date, Promise, JSON, String, Number, Array, Object, Math, Buffer, Map, Set,
    AbortSignal, encodeURIComponent, fetch: async (url, o) => { fetchLog.push({ url, o }); return { status: 200, json: async () => fetchAntw(url, o) }; } });
  vm.runInContext((/^const APP_VAST_AFSCHERMEN = [^\n]*\n/m.exec(src)[0] + /^function appAfscherm\(a\) \{[\s\S]*?\n\}\n/m.exec(src)[0]) + src.slice(hb, he) + '\n' + src.slice(db0, de) + ';globalThis.__dd = { docsDelen, appDocs, docsDelenInfo, docsCf, docsAccess, docsAccessBodyOk };', ctx, { filename: 'server.js#docs' });
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
  // wv1901 (David 28-10: op alle pc's alles): een vaste plek leest ook een privépagina (stand 200), maar delen blijft beheer
  res = { _app: {} };
  const nG = gestuurd.length;
  await ctx.__dd.appDocs({}, res, { soort: 'vast' }, {}, { pad: '20_Prive/Reis.md' }, 'POST /app/docs/stand');
  const sv = gestuurd[nG];
  toets('5 wv1901: vaste plek, privépagina: stand 200 (niet 404), kan_delen false met de vaste-plekreden', sv && sv.s === 200 && sv.j.kan_delen === false && /vaste plek/.test(sv.j.reden), sv);
  res = { _app: {} };
  await ctx.__dd.appDocs({}, res, { soort: 'vast' }, {}, { pad: '01_Ontwikkeling/Reis.md' }, 'POST /app/docs/voorbeeld');
  toets('5 wv1901: vaste plek: voorbeeld (de deelstap) blijft 403', gestuurd[nG + 1] && gestuurd[nG + 1].s === 403 && /vaste plek/.test(gestuurd[nG + 1].j.fout), gestuurd[nG + 1]);
  // wv1383: Access-toestaanlijst in server.js
  const X = ctx.__dd;
  toets('5 Access-koppeling aan met het pod-token, One-time PIN', !!X.docsAccess && X.docsAccess.idp === 'e9e612dc-1f11-4c07-bd74-5929e4704eec' && X.docsDelenInfo().beveiligd_aan === true, X.docsDelenInfo());
  const goedB = { name: 'Gedeelde pagina', type: 'self_hosted', domain: 'deel.socev.dev/b/AAAAAAAAAAAAAAAAAAAAAA', destinations: [{ type: 'public', uri: 'deel.socev.dev/b/AAAAAAAAAAAAAAAAAAAAAA' }],
    session_duration: '24h', allowed_idps: ['e9e612dc-1f11-4c07-bd74-5929e4704eec'], policies: [{ name: 'Ontvangers', decision: 'allow', precedence: 1, include: [{ email: { email: 'a@example.org' } }] }] };
  const kopie = (f) => { const b = JSON.parse(JSON.stringify(goedB)); f(b); return b; };
  toets('5 body: de goede wordt toegestaan', X.docsAccessBodyOk(goedB));
  for (const [naam, b] of [['ander domein', kopie((b) => { b.domain = 'deel.socev.dev'; b.destinations[0].uri = 'deel.socev.dev'; })],
    ['/p/', kopie((b) => { b.domain = b.destinations[0].uri = 'deel.socev.dev/p/AAAAAAAAAAAAAAAAAAAAAA'; })],
    ['jokerteken in het pad', kopie((b) => { b.domain = b.destinations[0].uri = 'deel.socev.dev/b/*'; })],
    ['tweede bestemming', kopie((b) => { b.destinations.push({ type: 'public', uri: 'socev.dev' }); })],
    ['self_hosted_domains erbij', kopie((b) => { b.self_hosted_domains = ['socev.dev']; })],
    ['andere identity provider (Google)', kopie((b) => { b.allowed_idps = ['c1e59597-0ceb-47c6-b6e8-76ae4c903b0d']; })],
    ['bypass-beleid', kopie((b) => { b.policies[0].decision = 'bypass'; })],
    ['iedereen', kopie((b) => { b.policies[0].include = [{ everyone: {} }]; })],
    ['heel een maildomein', kopie((b) => { b.policies[0].include = [{ email_domain: { domain: 'example.org' } }]; })],
    ['jokerteken in het adres', kopie((b) => { b.policies[0].include = [{ email: { email: '*@example.org' } }]; })],
    ['twee beleidsregels', kopie((b) => { b.policies.push(b.policies[0]); })]]) toets('5 body geweigerd: ' + naam, !X.docsAccessBodyOk(b));
  let gooit = 0;
  for (const [m, a, b] of [['GET', '/access/service_tokens'], ['DELETE', '/access/apps'], ['POST', '/access/apps/11111111-1111-4111-8111-111111111111', goedB],
    ['PUT', '/access/apps', goedB], ['POST', '/access/apps', kopie((b) => { b.policies[0].decision = 'bypass'; })], ['GET', '/access/apps?domain=deel.socev.dev%2Fp%2F*'],
    ['GET', '/access/identity_providers'], ['DELETE', '/access/apps/11111111-1111-4111-8111-111111111111', goedB], ['POST', '/access/apps']]) {
    try { await X.docsCf(m, a, b); } catch (e) { gooit++; }
  }
  toets('5 docsCf weigert alles buiten de toestaanlijst vóór er iets de deur uit gaat (9 van 9)', gooit === 9 && fetchLog.length === 0, { gooit, n: fetchLog.length });
  fetchAntw = () => ({ success: true, result: { id: '44444444-4444-4444-8444-444444444444', aud: 'x', domain: goedB.domain } });
  const mk = await X.docsAccess.maak(goedB);
  toets('5 maak: POST naar accounts/<id>/access/apps met het pod-token', mk.ok && mk.id === '44444444-4444-4444-8444-444444444444' && fetchLog.length === 1 && fetchLog[0].url === 'https://cf/client/v4/accounts/acc/access/apps' &&
    fetchLog[0].o.method === 'POST' && fetchLog[0].o.headers.Authorization === 'Bearer proef', fetchLog[0] && fetchLog[0].url);
  fetchAntw = () => ({ success: true, result: { id: '44444444-4444-4444-8444-444444444444', aud: 'x', domain: 'deel.socev.dev' } });
  toets('5 maak: antwoord met een ander domein telt niet als gelukt', (await X.docsAccess.maak(goedB)).ok === false);
  fetchAntw = () => ({ success: false, errors: [{ code: 11021, message: 'access.api.error.unknown_application' }] });
  const hw = await X.docsAccess.haal('44444444-4444-4444-8444-444444444444');
  toets('5 haal: onbekende app (11021) = weg', hw.ok === false && hw.weg === true, hw);
  fetchAntw = () => ({ success: true, result: [{ id: 'a1', domain: 'deel.socev.dev/b/AAAAAAAAAAAAAAAAAAAAAA' }, { id: 'a2', domain: 'deel.socev.dev/b/AAAAAAAAAAAAAAAAAAAAAA/x' }] });
  const zq = await X.docsAccess.zoek('deel.socev.dev/b/AAAAAAAAAAAAAAAAAAAAAA');
  toets('5 zoek: alleen precies dat domein', zq.ok && JSON.stringify(zq.ids) === '["a1"]' && /\?domain=deel\.socev\.dev%2Fb%2FAAAAAAAAAAAAAAAAAAAAAA$/.test(fetchLog[fetchLog.length - 1].url), zq);

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
