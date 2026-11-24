'use strict';
// wv3954 (besluitenpagina nr 903 = L03, nr 904 = L04): op een VERZONNEN site (lokale bare repo) en een VERZONNEN databank.
// L04: de bedragenknop zet alleen Donatiedoelen op staging (main ongemoeid), alleen met de eigen schakelaar; de poort laat buiten het
// begrotingsblok alleen cijfers toe; concept en publiceren blijven werken met de bedragen op staging; zonder schakelaar weigert alles.
// L03: aanleiding mijlpaal (niet de al gehaalde bij de eerste ronde) en acht weken stilte (hooguit één per periode, ook na Nee), één open
// nieuws-voorstel tegelijk, foto's uit eerdere nieuws-voorstellen, geen donateurs in de feiten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const S = require('../ghawa-site.js');
const VS = require('../ghawa-voorstel.js');

const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
const PAGINA = `---
import Basis from '../layouts/Basis.astro';
---
<Basis titel="Donatiedoelen">
    <section class="doelen-intro"><p>Proefstichting kent drie bouwfases.</p></section>
    <section class="begroting-sectie">
      <h2>Kosten bouw</h2>
      <table class="totaal-tabel"><tbody>
        <tr><td><strong>Fase 1</strong></td><td>Basis</td><td class="bedrag">GMD 700.000</td><td class="bedrag">€ 10.000</td></tr>
        <tr class="totaal-rij"><td colspan="2"><strong>Totaal bouw</strong></td><td class="bedrag"><strong>GMD 700.000</strong></td><td class="bedrag"><strong>€ 10.000</strong></td></tr>
      </tbody></table>
    </section>
    <section class="jaarlijks-sectie">
      <table class="totaal-tabel"><tbody>
            <tr><td>Proefpost</td><td class="bedrag">70.000</td><td class="bedrag">€ 1.000</td></tr>
            <tr class="totaal-rij"><td><strong>Totaal per jaar</strong></td><td class="bedrag"><strong>70.000</strong></td><td class="bedrag"><strong>€ 1.000</strong></td></tr>
      </tbody></table>
      <p class="wisselkoers-noot">Wisselkoers circa GMD 70 = €1 (fluctueert).</p>
    </section>
</Basis>
`;
const APP = { koers: 85, datastand: '2026-10-06', bouw_gmd: 1700000, fasen: [
  { naam: 'Fase 1A', omschrijving: 'fundering & <hek>', gmd: 850000, posten: [{ naam: 'Fundering {proef}', gmd: 500000 }, { naam: 'Hek', gmd: 350000 }] },
  { naam: 'Fase 2', omschrijving: 'verdieping', gmd: 850000, posten: [{ naam: 'Muren', gmd: 850000 }] },
  { naam: 'Niet begroot', omschrijving: '', gmd: 0, posten: [] }] };

function bouwSite() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3954-'));
  const bron = path.join(t, 'bron'), bare = path.join(t, 'origin.git');
  fs.mkdirSync(path.join(bron, 'src/content/nieuws'), { recursive: true });
  fs.mkdirSync(path.join(bron, 'src/pages'), { recursive: true });
  fs.writeFileSync(path.join(bron, 'src/content/nieuws/2026-07-27-oud.md'), '---\ntitel: "Oud"\ndatum: 2026-07-27\nsamenvatting: "Een oud proefbericht met genoeg tekens."\n---\n\nTekst.\n');
  fs.writeFileSync(path.join(bron, 'src/pages/donatiedoelen.astro'), PAGINA);
  fs.writeFileSync(path.join(bron, 'src/pages/doneren.astro'), '<p>Doneren</p>');
  sh(bron, 'init', '-q', '-b', 'main'); sh(bron, 'add', '-A'); sh(bron, 'commit', '-qm', 'start');
  sh(bron, 'branch', 'staging');
  sh(t, 'clone', '-q', '--bare', bron, bare);
  const x = { t, bare, map: path.join(t, 'kopie'), aanPad: path.join(t, 'aan.json'), bedragenAanPad: path.join(t, 'bedragen.json'), logPad: path.join(t, 'log.jsonl') };
  fs.writeFileSync(x.aanPad, JSON.stringify({ aan: true }));
  return x;
}
const maak = (x) => S.maak({ map: x.map, url: x.bare, cred: path.join(x.t, 'geen'), aanPad: x.aanPad, bedragenAanPad: x.bedragenAanPad, logPad: x.logPad, bouwen: false,
  proefsite: 'https://proef.example', site: 'https://site.example', namen: () => [], nu: () => new Date('2026-11-24T12:00:00Z') });
const toonOp = (x, b, p) => sh(x.bare, 'show', b + ':' + p);
const tak = (x, b) => sh(x.bare, 'rev-parse', b).trim();

test('L04 pagina: begroting uit de app, euro\'s jaarlijks en koers mee, rest letterlijk; poort en vergelijking', () => {
  const r = S.bedragenPagina(PAGINA, APP);
  assert.ok(r.tekst, r.fout);
  assert.match(r.tekst, /GMD 1\.700\.000/); assert.match(r.tekst, /€ 20\.000/);
  assert.match(r.tekst, /Fase 1A — Fundering &amp; &lt;hek&gt; \(€ 10\.000\)/);
  assert.match(r.tekst, /Fundering &#123;proef&#125;/);
  assert.ok(!/Niet begroot/.test(r.tekst), 'fase zonder begroting weg');
  assert.match(r.tekst, /twee delen/);
  assert.match(r.tekst, /70\.000<\/td><td class="bedrag">€ 824</);
  assert.match(r.tekst, /GMD 85 = €1/);
  assert.match(r.tekst, /Proefstichting kent drie bouwfases\./);
  assert.strictEqual(S.alleenBedragen(PAGINA, r.tekst), true);
  assert.strictEqual(S.bedragenPagina(r.tekst, APP).tekst, r.tekst, 'tweede keer = gelijk');
  const v = S.vergelijk({ donatiedoelen: r.tekst, doneren: '' }, { bouw_gmd: 1700000, koers: 85, afas_eur: null });
  assert.strictEqual(v.verschillen, 0);
  // poort: tekst buiten het blok, script/expressie/link in het blok → nee
  assert.strictEqual(S.alleenBedragen(PAGINA, r.tekst.replace('drie bouwfases', 'vier bouwfases')), false);
  assert.strictEqual(S.alleenBedragen(PAGINA, r.tekst.replace('<h2>Kosten bouw</h2>', '<h2>Kosten bouw</h2><script>x()</script>')), false);
  assert.strictEqual(S.alleenBedragen(PAGINA, r.tekst.replace('<h2>Kosten bouw</h2>', '<h2>{Astro.url}</h2>')), false);
  assert.strictEqual(S.alleenBedragen(PAGINA, r.tekst.replace('<h2>Kosten bouw</h2>', '<h2><a href="https://x.example">x</a></h2>')), false);
  assert.strictEqual(S.alleenBedragen(PAGINA, r.tekst.replace('<h2>Kosten bouw</h2>', '<h2 onclick="x">Kosten</h2>')), false);
  assert.ok(S.bedragenPagina(PAGINA, Object.assign({}, APP, { koers: 0 })).fout);
  assert.ok(S.bedragenPagina('<p>geen blok</p>', APP).fout);
});

test('L04 knop: zonder schakelaar dicht; met schakelaar alleen Donatiedoelen op staging; concept en publiceren daarna', async () => {
  const x = bouwSite(); const s = maak(x);
  const main0 = tak(x, 'main');
  assert.strictEqual((await s.bedragen(APP)).status, 403, 'schakelaar uit');
  fs.writeFileSync(x.bedragenAanPad, JSON.stringify({ aan: true }));
  const r = await s.bedragen(APP);
  assert.strictEqual(r.status, 200, r.fout);
  assert.strictEqual(r.proef_url, 'https://proef.example/donatiedoelen/');
  assert.strictEqual(tak(x, 'main'), main0, 'main ongemoeid');
  const pag = toonOp(x, 'staging', 'src/pages/donatiedoelen.astro');
  assert.match(pag, /GMD 1\.700\.000/);
  assert.deepStrictEqual(sh(x.bare, 'diff', '--name-only', 'main', 'staging').trim().split('\n'), ['src/pages/donatiedoelen.astro']);
  const r2 = await s.bedragen(APP);
  assert.strictEqual(r2.ongewijzigd, true);
  const st = await s.stand();
  assert.strictEqual(st.proef.bedragen, true); assert.strictEqual(st.proef.andere_aantal, 0); assert.strictEqual(st.proef.te_publiceren, true);
  const pp = await s.sitePaginas('origin/staging');
  assert.match(pp.donatiedoelen, /GMD 1\.700\.000/);
  // een bericht erbij kan nog, en publiceren neemt beide mee
  const c = await s.concept({ titel: 'Proefnieuws', tekst: 'Een verzonnen proefbericht met genoeg tekens erin.' });
  assert.strictEqual(c.status, 200, c.fout);
  const p = await s.publiceer({ sha: tak(x, 'staging') });
  assert.strictEqual(p.status, 200, p.fout);
  assert.match(toonOp(x, 'main', 'src/pages/donatiedoelen.astro'), /GMD 1\.700\.000/);
  // schakelaar weer uit terwijl er iets anders op staging staat → concept dicht
  const x2 = bouwSite(); const s2 = maak(x2);
  fs.writeFileSync(x2.bedragenAanPad, JSON.stringify({ aan: true }));
  assert.strictEqual((await s2.bedragen(APP)).status, 200);
  fs.writeFileSync(x2.bedragenAanPad, JSON.stringify({ aan: false }));
  const c2 = await s2.concept({ titel: 'Proefnieuws', tekst: 'Een verzonnen proefbericht met genoeg tekens erin.' });
  assert.strictEqual(c2.status, 422);
});

test('L04 poort: iemand zet tekst op Donatiedoelen in staging → geen bedragen, geen concept', async () => {
  const x = bouwSite(); const s = maak(x);
  fs.writeFileSync(x.bedragenAanPad, JSON.stringify({ aan: true }));
  const w = path.join(x.t, 'w'); sh(x.t, 'clone', '-q', '-b', 'staging', x.bare, w);
  fs.writeFileSync(path.join(w, 'src/pages/donatiedoelen.astro'), PAGINA.replace('drie bouwfases', 'een andere tekst'));
  sh(w, 'commit', '-qam', 'tekst'); sh(w, 'push', '-q', 'origin', 'staging');
  assert.strictEqual((await s.bedragen(APP)).status, 422);
  assert.strictEqual((await s.concept({ titel: 'Proefnieuws', tekst: 'Een verzonnen proefbericht met genoeg tekens erin.' })).status, 422);
});

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE meta (sleutel TEXT PRIMARY KEY, waarde TEXT);' + VS.SCHEMA);
  return d;
}
const M = (sleutel, stand, volgorde) => ({ sleutel, volgorde, wanneer: '2026', tekst: 'Proefmijlpaal ' + sleutel, stand });

test('L03 aanleiding: eerste ronde onthoudt gehaalde mijlpalen; nieuwe gehaalde = concept; één open tegelijk', () => {
  const d = db(); const nu = '2026-11-24T10:00:00Z';
  // eerste ronde: twee al gehaald, laatste bericht recent → niets
  assert.strictEqual(VS.socevAanleiding(d, { mijlpalen: [M('a', 'gehaald', 1), M('b', 'gehaald', 2), M('c', 'bezig', 3)], laatste: '2026-11-01', nu }), null);
  // c komt op gehaald → aanleiding mijlpaal
  const a = VS.socevAanleiding(d, { mijlpalen: [M('a', 'gehaald', 1), M('b', 'gehaald', 2), M('c', 'gehaald', 3)], laatste: '2026-11-01', nu });
  assert.strictEqual(a.soort, 'mijlpaal'); assert.strictEqual(a.mijlpaal.sleutel, 'c');
  const z = VS.socevZet(d, a, { titel: 'Proeftitel', tekst: 'Een verzonnen concept met genoeg tekens erin.' }, nu);
  assert.strictEqual(z.ok, true); assert.strictEqual(z.nieuw, true);
  const v = VS.haal(d, z.id);
  assert.strictEqual(v.soort, 'nieuws'); assert.strictEqual(v.bron.chat, 'socev'); assert.strictEqual(v.gegevens.door, 'socev');
  // open nieuws-voorstel → geen tweede
  assert.strictEqual(VS.socevAanleiding(d, { mijlpalen: [M('a', 'gehaald', 1), M('c', 'gehaald', 3), M('d', 'gehaald', 4)], laatste: '2026-01-01', nu }), null);
  // na Nee: c niet opnieuw, d wel
  d.prepare("UPDATE voorstel SET staat = 'nee' WHERE id = ?").run(z.id);
  const a2 = VS.socevAanleiding(d, { mijlpalen: [M('a', 'gehaald', 1), M('c', 'gehaald', 3), M('d', 'gehaald', 4)], laatste: '2026-11-01', nu });
  assert.strictEqual(a2.mijlpaal.sleutel, 'd');
});

test('L03 stilte: na 56 dagen één concept per periode, ook na Nee; niet als er al iets op de proefsite staat', () => {
  const d = db(); const nu = '2026-11-24T10:00:00Z';
  assert.strictEqual(VS.socevAanleiding(d, { mijlpalen: [], laatste: '2026-10-01', nu }), null, '54 dagen');
  assert.strictEqual(VS.socevAanleiding(d, { mijlpalen: [], laatste: '2026-07-27', op_proef: true, nu }), null, 'al iets op de proefsite');
  const a = VS.socevAanleiding(d, { mijlpalen: [], laatste: '2026-07-27', nu });
  assert.strictEqual(a.soort, 'stilte'); assert.strictEqual(a.dagen, 120);
  assert.match(a.citaat, /27-7-2026 \(120 dagen\)/);
  const z = VS.socevZet(d, a, { titel: 'Proeftitel', tekst: 'Een verzonnen concept met genoeg tekens erin.' }, nu);
  d.prepare("UPDATE voorstel SET staat = 'nee' WHERE id = ?").run(z.id);
  assert.strictEqual(VS.socevAanleiding(d, { mijlpalen: [], laatste: '2026-07-27', nu }), null, 'zelfde periode na Nee');
  assert.ok(VS.socevAanleiding(d, { mijlpalen: [], laatste: '2026-07-27', nu: '2027-01-15T10:00:00Z' }), 'volgende periode wel');
  assert.strictEqual(VS.socevZet(d, a, { titel: 'x', tekst: 'kort' }, nu).ok, false);
});

test('L03 foto\'s: uit eerdere nieuws-voorstellen (niet afgewezen, niet ouder dan 60 dagen, geen pdf)', () => {
  const d = db(); const nu = '2026-11-24T10:00:00Z';
  const zet = (id, staat, bij, op) => d.prepare("INSERT INTO voorstel (id, sleutel, soort, staat, gegevens, bron, bijlagen, gemaakt_op) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, 's' + id, 'nieuws', staat, '{}', '{}', JSON.stringify(bij), op);
  zet('V001', 'ja', ['aaaaaaaaaaaaaaaa.jpg', 'bbbbbbbbbbbbbbbb.pdf'], '2026-11-01T00:00:00Z');
  zet('V002', 'nee', ['cccccccccccccccc.jpg'], '2026-11-02T00:00:00Z');
  zet('V003', 'ja', ['dddddddddddddddd.jpg'], '2026-08-01T00:00:00Z');
  assert.deepStrictEqual(VS.socevFotos(d, nu), ['aaaaaaaaaaaaaaaa.jpg']);
});

test('L03 cijfers: het model schrijft geen cijfers of data; de feitenregel komt uit de administratie (Codex r1+r2 MOET 1)', () => {
  assert.strictEqual(VS.socevZonderCijfers({ titel: 'Het dak komt eraan', tekst: 'De tweede verdieping staat. Dank voor jullie steun.' }).ok, true);
  for (const t of ['Begroot € 166.819.', 'Al 65 % klaar.', 'Ruim honderdduizend euro nodig.', 'Sinds juli staat de verdieping.', 'Klaar in 2027.', 'Over twee weken begint het dak.', 'De helft van de begroting is besteed.'])
    assert.strictEqual(VS.socevZonderCijfers({ titel: 'Proef', tekst: t }).ok, false, t);
  const r = VS.socevFeitenregel({ mijlpaal: { tekst: 'Proefdak erop', wanneer: 'najaar 2026', gehaald_op: '2026-11-20' },
    cijfers: { stand_van: '2026-10-06', bouw_begroot_eur: 166819, bouw_uitgegeven_eur: 108678, bouw_klaar_procent: 65, nog_nodig_eur: 58141 } });
  assert.strictEqual(r, 'Mijlpaal: Proefdak erop (gehaald op 20-11-2026).\n\nStand van de bouw op 6-10-2026: € 108.678 besteed van de begroting van € 166.819 (65 %); nog nodig voor de bouw: € 58.141.');
  assert.strictEqual(VS.socevFeitenregel({ cijfers: {} }), '');
});
