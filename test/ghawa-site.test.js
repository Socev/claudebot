'use strict';
// wv2883: OVIS GHAWA fase 3 (website) op een VERZONNEN site in een lokale bare repo (geen GitHub, geen netwerk). Toetst: lijst en waar een
// bericht staat, aan-bestand (zonder: alles dicht), concept op staging (main ongemoeid), Davids tekst letterlijk en geldige kop (ook met
// aanhalingstekens en dubbele punt), foto's zonder exif, waarschuwing bij een donateursnaam of IBAN, weghalen (nooit iets wat live staat),
// publiceren alleen op de sha die David zag, niets te publiceren = 409, bytes-toets (geen donateursnaam in wat naar de site gaat), en het
// lezen van de bedragen op de site tegenover de app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../ghawa-site.js');

const DONOR = 'Proefgever Veldhuizen';   // verzonnen
const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
function bouwSite() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2883-'));
  const bron = path.join(t, 'bron'), bare = path.join(t, 'origin.git');
  fs.mkdirSync(path.join(bron, 'src/content/nieuws'), { recursive: true });
  fs.mkdirSync(path.join(bron, 'src/pages/anbi'), { recursive: true });
  fs.writeFileSync(path.join(bron, 'src/content/nieuws/2025-01-02-oud-bericht.md'), '---\ntitel: "Oud bericht"\ndatum: 2025-01-02\nsamenvatting: "Een oud proefbericht met genoeg tekens."\n---\n\nTekst.\n');
  fs.writeFileSync(path.join(bron, 'src/pages/index.astro'), '<h1>Home</h1>');
  fs.writeFileSync(path.join(bron, 'src/pages/anbi/statuten.astro'), '<h1>Statuten</h1>');
  fs.writeFileSync(path.join(bron, 'src/pages/donatiedoelen.astro'), '<table><tr class="totaal-rij"><td colspan="2"><strong>Totaal bouw</strong></td><td class="bedrag"><strong>GMD 1.234.567</strong></td><td class="bedrag"><strong>€ 17.637</strong></td></tr></table><p class="wisselkoers-noot">Wisselkoers circa GMD 70 = €1 (fluctueert).</p>');
  fs.writeFileSync(path.join(bron, 'src/pages/doneren.astro'), '<h3>AFAS Foundation</h3><p>De <em>AFAS Foundation</em> besloot € 12.000 te doneren voor de proef.</p>');
  sh(bron, 'init', '-q', '-b', 'main'); sh(bron, 'add', '-A'); sh(bron, 'commit', '-qm', 'start');
  sh(bron, 'branch', 'staging');
  sh(t, 'clone', '-q', '--bare', bron, bare);
  return { t, bare, map: path.join(t, 'kopie'), aanPad: path.join(t, 'aan.json'), logPad: path.join(t, 'log.jsonl') };
}
function maak(x, extra) {
  return S.maak(Object.assign({ map: x.map, url: x.bare, cred: path.join(x.t, 'geen-cred'), aanPad: x.aanPad, logPad: x.logPad, bouwen: false,
    proefsite: 'https://proef.example', site: 'https://site.example', namen: () => [DONOR, 'Kort'], nu: () => new Date('2026-11-10T12:00:00Z') }, extra || {}));
}
const aanZet = (x) => fs.writeFileSync(x.aanPad, JSON.stringify({ aan: true }));
const tak = (x, b) => sh(x.bare, 'rev-parse', b).trim();
const toonOp = (x, b, p) => sh(x.bare, 'show', b + ':' + p);
let sharp = null;
try { sharp = require(process.env.GHAWA_SITE_SHARP || '/opt/data/ghawa/site/node_modules/sharp'); } catch (e) { sharp = null; }

test('stand: lijst, pagina\'s, niets te publiceren; zonder aan-bestand dicht', async () => {
  const x = bouwSite(); const s = maak(x);
  const st = await s.stand();
  assert.strictEqual(st.aan, false);
  assert.deepStrictEqual(st.berichten.map((b) => [b.slug, b.waar]), [['2025-01-02-oud-bericht', 'live']]);
  assert.strictEqual(st.berichten[0].live_url, 'https://site.example/voortgang/2025-01-02-oud-bericht/');
  assert.deepStrictEqual(st.paginas.map((p) => p.pad), ['/', '/anbi/statuten', '/doneren', '/donatiedoelen'].sort((a, b) => a.localeCompare(b)));
  assert.strictEqual(st.proef.te_publiceren, false);
  const r = await s.concept({ titel: 'Proef', tekst: 'Een verzonnen proefbericht van genoeg tekens.' });
  assert.strictEqual(r.status, 403);
  const p = await s.publiceer({ sha: tak(x, 'staging') });
  assert.strictEqual(p.status, 403);
});

test('concept: op staging, main ongemoeid, tekst letterlijk, geldige kop; weghalen; publiceren op de juiste sha', async () => {
  const x = bouwSite(); aanZet(x); const s = maak(x);
  const main0 = tak(x, 'main');
  const titel = 'Proef: dak "klaar" in Sukuta';
  const tekst = 'Dit is een verzonnen proefbericht. Het dak is klaar!\n\nTweede alinea met *nadruk* en een: dubbele punt.';
  const r = await s.concept({ titel, tekst, categorie: 'bouw' });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.slug, '2026-11-10-proef-dak-klaar-in-sukuta');
  assert.strictEqual(r.proef_url, 'https://proef.example/voortgang/2026-11-10-proef-dak-klaar-in-sukuta/');
  assert.deepStrictEqual(r.let_op, []);
  assert.strictEqual(tak(x, 'main'), main0, 'main ongemoeid');
  const md = toonOp(x, 'staging', 'src/content/nieuws/' + r.slug + '.md');
  const k = S.kop(md);
  assert.strictEqual(k.titel, titel);
  assert.strictEqual(k.datum, '2026-11-10');
  assert.strictEqual(k.samenvatting, 'Dit is een verzonnen proefbericht. Het dak is klaar! Tweede alinea met nadruk en een: dubbele punt.');
  assert.ok(md.endsWith('\n\n' + tekst + '\n'), 'Davids tekst letterlijk');
  // tweede bericht met dezelfde titel krijgt -2
  const r2 = await s.concept({ titel, tekst });
  assert.strictEqual(r2.slug, r.slug + '-2');
  let st = await s.stand();
  assert.strictEqual(st.proef.te_publiceren, true);
  assert.deepStrictEqual(st.proef.berichten.map((b) => b.waar), ['proef', 'proef']);
  assert.strictEqual(st.proef.andere_aantal, 0);
  // weghalen van het tweede concept; het oude (live) bericht niet
  assert.strictEqual((await s.weg({ slug: r2.slug })).status, 200);
  assert.strictEqual((await s.weg({ slug: '2025-01-02-oud-bericht' })).status, 409);
  assert.strictEqual((await s.weg({ slug: '../x' })).status, 400);
  // publiceren: verkeerde sha → 409 en main ongemoeid
  const p0 = await s.publiceer({ sha: main0 });
  assert.strictEqual(p0.status, 409);
  assert.strictEqual(tak(x, 'main'), main0);
  st = await s.stand();
  const p = await s.publiceer({ sha: st.proef.sha });
  assert.strictEqual(p.status, 200, JSON.stringify(p));
  assert.deepStrictEqual(p.berichten, [r.slug]);
  assert.strictEqual(toonOp(x, 'main', 'src/content/nieuws/' + r.slug + '.md'), md);
  assert.throws(() => sh(x.bare, 'cat-file', '-e', 'main:src/content/nieuws/' + r2.slug + '.md'), 'weggehaald concept niet live');
  st = await s.stand();
  assert.strictEqual(st.berichten.find((b) => b.slug === r.slug).waar, 'live');
  assert.ok(!st.berichten.find((b) => b.slug === r2.slug), 'weggehaald concept nergens meer');
  assert.strictEqual(st.proef.te_publiceren, false);
  assert.strictEqual((await s.publiceer({ sha: st.proef.sha })).status, 409, 'niets nieuws');
  // volgende concept: staging wordt eerst bijgewerkt met main (proefsite = live + concepten)
  const r3 = await s.concept({ titel: 'Nog een proef', tekst: 'Weer een verzonnen proefbericht met genoeg tekens.' });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(sh(x.bare, 'merge-base', '--is-ancestor', 'main', 'staging'), '');
  const log = fs.readFileSync(x.logPad, 'utf8').trim().split('\n').map((l) => JSON.parse(l).wat);
  assert.deepStrictEqual(log, ['concept', 'concept', 'weg', 'publiceer', 'concept']);
  assert.ok(!/Tweede alinea|nadruk|proefbericht|"klaar"/i.test(fs.readFileSync(x.logPad, 'utf8')), 'geen tekst of titel in het log (alleen de slug)');
});

test('waarschuwing bij donateursnaam of IBAN, bytes-toets op wat naar de site gaat', async () => {
  const x = bouwSite(); aanZet(x); const s = maak(x);
  const r = await s.concept({ titel: 'Dank', tekst: 'Veel dank aan ' + DONOR + ' voor de steun, rekening NL91 ABNA 0417 1643 00.' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.let_op.length, 2, JSON.stringify(r.let_op));
  assert.ok(/donateurslijst/.test(r.let_op[0]) && /rekeningnummer/.test(r.let_op[1]));
  const st = await s.stand();
  assert.strictEqual(st.berichten.find((b) => b.slug === r.slug).let_op.length, 2);
  // bytes-toets: een concept zonder namen zet geen enkele donateursnaam op de site (de pod voegt niets toe)
  const y = bouwSite(); aanZet(y); const s2 = maak(y);
  const r2 = await s2.concept({ titel: 'Bouwupdate', tekst: 'De muren van de tweede verdieping staan. Verzonnen proeftekst.' });
  assert.strictEqual(r2.status, 200);
  // git grep geeft exit 1 als er niets gevonden is; kruisproef: de naam van het eerste concept wordt wél gevonden
  assert.throws(() => sh(y.bare, 'grep', '-i', '-I', '-l', '-e', 'Proefgever', '-e', 'Veldhuizen', 'staging', '--'), 'geen donateursnaam op staging');
  assert.ok(/nieuws/.test(sh(x.bare, 'grep', '-i', '-I', '-l', '-e', 'Proefgever', 'staging', '--')), 'kruisproef: toets ziet een naam als die er staat');
});

test('foto\'s: opnieuw gecodeerd, zonder exif; niet-foto geweigerd', { skip: !sharp && 'sharp niet aanwezig' }, async () => {
  const x = bouwSite(); aanZet(x); const s = maak(x, { sharpPad: process.env.GHAWA_SITE_SHARP || '/opt/data/ghawa/site/node_modules/sharp' });
  const jpg = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#2a6' } }).jpeg().withExif({ IFD0: { Copyright: 'PROEF-GPS-52.1' } }).toBuffer();
  assert.ok(jpg.includes(Buffer.from('PROEF-GPS-52.1')), 'proefbeeld heeft exif');
  const r = await s.concept({ titel: 'Met foto', tekst: 'Een verzonnen bericht met twee foto\'s erbij.', fotos: [{ naam: 'a.jpg', bestand: jpg.toString('base64'), alt: 'Muur in aanbouw' }, { naam: 'b.jpg', bestand: jpg.toString('base64') }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const md = toonOp(x, 'staging', 'src/content/nieuws/' + r.slug + '.md');
  assert.ok(/hoofdfoto: "\.\.\/assets\/nieuws\/2026-11-10-met-foto\/foto-01\.jpg"/.test(md) && /hoofdfoto_alt: "Muur in aanbouw"/.test(md) && /- bron: "\.\.\/assets\/nieuws\/2026-11-10-met-foto\/foto-02\.jpg"/.test(md) && /alt: "Foto bij: Met foto"/.test(md), md);
  const uit = execFileSync('git', ['show', 'staging:src/content/assets/nieuws/' + r.slug + '/foto-01.jpg'], { cwd: x.bare });
  assert.ok(!uit.includes(Buffer.from('PROEF-GPS-52.1')) && !uit.includes(Buffer.from('Exif\0\0')), 'exif weg');
  const m = await sharp(uit).metadata();
  assert.ok(m.width === 2000 && m.height === 667, m.width + 'x' + m.height);
  const fout = await s.concept({ titel: 'Geen foto', tekst: 'Een verzonnen bericht met een kapotte foto.', fotos: [{ naam: 'x.jpg', bestand: Buffer.from('geen beeld').toString('base64') }] });
  assert.strictEqual(fout.status, 400);
});

test('invoer: grenzen titel, tekst, foto\'s', async () => {
  const x = bouwSite(); aanZet(x); const s = maak(x);
  assert.strictEqual((await s.concept({ titel: 'ab', tekst: 'Een verzonnen tekst van genoeg tekens.' })).status, 400);
  assert.strictEqual((await s.concept({ titel: 'Goed', tekst: 'te kort' })).status, 400);
  assert.strictEqual((await s.concept({ titel: 'Goed', tekst: 'Een verzonnen tekst van genoeg tekens.', fotos: new Array(7).fill({}) })).status, 400);
  assert.strictEqual((await s.publiceer({ sha: 'abc' })).status, 400);
  assert.strictEqual(tak(x, 'staging'), tak(x, 'main'), 'niets gepusht');
});

test('cijfers: bedragen op de site tegenover de app (alleen totalen)', async () => {
  const x = bouwSite(); const s = maak(x);
  const v = S.vergelijk(await s.sitePaginas(), { bouw_gmd: 1234567, koers: 85, afas_eur: 12000 });
  assert.deepStrictEqual(v.rijen.map((r) => [r.id, r.site, r.app, r.gelijk]), [['bouw_gmd', 1234567, 1234567, true], ['koers', 70, 85, false], ['afas_eur', 12000, 12000, true]]);
  assert.strictEqual(v.verschillen, 1);
  const leeg = S.vergelijk({ donatiedoelen: '<p>niets</p>', doneren: '' }, { bouw_gmd: 1, koers: 85, afas_eur: null });
  assert.strictEqual(leeg.verschillen, 0);
  assert.deepStrictEqual(leeg.niet_gevonden, ['bouw_gmd', 'koers', 'afas_eur']);
});

test('samenvatting: eerste zinnen tot 280 tekens; slug zonder leestekens', () => {
  const lang = 'Eerste zin is hier, lang genoeg. ' + 'Woord '.repeat(80) + 'einde.';
  assert.strictEqual(S.samenvattingVan(lang), 'Eerste zin is hier, lang genoeg.');
  assert.ok(S.samenvattingVan('x'.repeat(400)).length <= 280);
  assert.strictEqual(S.slugVan('Één café: "Dak" klaar!'), 'een-cafe-dak-klaar');
  assert.deepStrictEqual(S.namenIn('Dank aan proefgever veldhuizen!', [DONOR, 'Kort']), [DONOR]);
  assert.deepStrictEqual(S.namenIn('Een kortere tekst', ['Kort']), []);
});
