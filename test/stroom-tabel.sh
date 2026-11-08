#!/usr/bin/env bash
# Toetst stroom-tabel.js (wv2704: maandtabel op de energiepagina vanzelf bij uit de Tibber-factuur in de Facturen-app) op een verzonnen
# pagina, verzonnen factuurtekst en een nagebootste facturen.sqlite: nieuwe maand erbij op zijn plek (+ 12-maandenregel en updated:),
# zelfde maand gelijk = niets, afwijkende rij / onleesbare factuur / totaal wijkt af / twee facturen per maand / geen tabel = niets schrijven
# en één box-rij per geval (niet twee keer), idempotent, financien-bijsturen.js leest de nieuwe rij. Raakt pod, Facturen en vault niet.
# Gebruik: bash test/stroom-tabel.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
let S = null;
try { S = require(path.resolve('stroom-tabel.js')); } catch (e) { S = null; }
toets('stroom-tabel.js laadt', !!S);
if (!S) { console.log('KLAAR 0 groen, 1 rood'); process.exit(1); }

// ── verzonnen factuurtekst (vorm van pdftotext -layout) ──
function factuur(maand, kwh, ct, totaal, extra) {
  return 'Factuurdatum: 5 dec. 2026\n\n    Variabele kosten ' + maand + '        € 300,00\n\n' + (extra || '') +
    '              Stroomverbruik ' + maand + '                         € 200,00\n              ' + kwh + ' kWh à ' + ct + ' ct/kWh\n\n' +
    '              Energiebelasting (tarief 1) ' + maand + '            € 100,00\n              ' + kwh + ' kWh à 9,16 ct/kWh\n\n' +
    '                                   Totaal incl. btw\n\n\n                                  € ' + totaal + '\n';
}
const f1 = S.factuurUit(factuur('november 2026', '1.234,56', '20,10', '345,67'), 34567);
toets('factuurUit: maand, kWh, kale prijs, incl', f1.maand === '2026-11' && f1.kwh === 1234.56 && f1.kaal === 20.1 && f1.incl === 345.67, f1);
toets('factuurUit: totaal in de tekst wijkt af van de databank → twijfel', !!S.factuurUit(factuur('november 2026', '1.234,56', '20,10', '345,67'), 34568).twijfel);
toets('factuurUit: twee regels Stroomverbruik → twijfel', !!S.factuurUit(factuur('november 2026', '1.234,56', '20,10', '345,67', '              Stroomverbruik oktober 2026   € 1,00\n              1,00 kWh à 1,00 ct/kWh\n'), 34567).twijfel);
toets('factuurUit: geen kWh-regel → twijfel', !!S.factuurUit('Stroomverbruik november 2026  € 1\n\nTotaal incl. btw € 345,67', 34567).twijfel);
toets('factuurUit: lege tekst → twijfel', !!S.factuurUit('', 34567).twijfel);
toets('factuurUit: onder de 1.000 kWh zonder punt', S.factuurUit(factuur('juli 2026', '925,10', '11,91', '237,12'), 23712).kwh === 925.1);

// ── verzonnen pagina ──
const MK = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
let rijen = '';
for (let i = 0; i < 12; i++) { const m = (i + 10) % 12, j = i < 2 ? 2025 : 2026; rijen += '| ' + MK[m] + ' ' + j + ' | 1.000 | 10,00 | 250,00 | 25,0 |\n'; }   // nov 2025 … okt 2026
const PAG = '---\ntype: themapagina\nupdated: 2026-11-07\n---\n\n# Energie (proef)\n\n| Maand | Verbruik (kWh) | Kale stroomprijs (ct/kWh) | Factuur incl. btw (€) | Alles-in (ct/kWh) |\n|---|--:|--:|--:|--:|\n' +
  rijen + '\n- **Laatste 12 maanden (nov 2025–okt 2026):** 12.000 kWh, € 3.000,00 incl. btw, gemiddeld 25,0 ct/kWh alles-in.\n- andere regel\n\n## Verder\ntekst\n';
const z = S.tabelZet(PAG, [f1], '2026-12-05');
toets('tabelZet: nov 2026 erbij, na okt 2026', z.toegevoegd.join() === '2026-11' && /\| okt 2026 \|[^\n]*\n\| nov 2026 \| 1\.235 \| 20,10 \| 345,67 \| 28,0 \|\n\n/.test(z.tekst), z.tekst);
toets('tabelZet: 12-maandenregel schuift naar dec 2025–nov 2026', z.tekst.indexOf('- **Laatste 12 maanden (dec 2025–nov 2026):** 12.235 kWh, € 3.095,67 incl. btw, gemiddeld 25,3 ct/kWh alles-in.') >= 0, z.tekst);
toets('tabelZet: updated: in de kop bijgewerkt, rest gelijk', /^---\ntype: themapagina\nupdated: 2026-12-05\n---\n/.test(z.tekst) && z.tekst.endsWith('- andere regel\n\n## Verder\ntekst\n'));
toets('tabelZet: alleen de rij en twee kopregels anders', z.tekst.split('\n').length === PAG.split('\n').length + 1);
const z2 = S.tabelZet(z.tekst, [f1], '2026-12-06');
toets('tabelZet: tweede keer gelijk → niets (idempotent)', z2.tekst === null && z2.gelijk.join() === '2026-11' && !z2.twijfel.length, z2);
const z3 = S.tabelZet(z.tekst, [Object.assign({}, f1, { incl: 345.68 })], '2026-12-06');
toets('tabelZet: bestaande rij wijkt af → twijfel, niets schrijven', z3.tekst === null && z3.twijfel.length === 1, z3);
const sep = { maand: '2025-09', kwh: 900, kaal: 9, incl: 200 };
const z4 = S.tabelZet(PAG, [sep], '2026-12-05');
toets('tabelZet: oudere maand komt bovenaan op zijn plek', /\|---\|--:\|--:\|--:\|--:\|\n\| sep 2025 \| 900 \| 9,00 \| 200,00 \| 22,2 \|\n\| nov 2025 /.test(z4.tekst || ''), z4.tekst);
toets('tabelZet: onleesbare getalcel in een bestaande rij → twijfel (review MOET 2)', S.tabelZet(PAG.replace('| mrt 2026 | 1.000 | 10,00 | 250,00 |', '| mrt 2026 | 1.000 | ? | 250,00 |'), [f1], '2026-12-05').tekst === null);
const gat = S.tabelZet(PAG.replace(/\| mrt 2026 [^\n]*\n/, ''), [f1], '2026-12-05');
toets('tabelZet: gat in de laatste 12 maanden → rij erbij, 12-maandenregel ongemoeid (review ZOU 1)', gat.toegevoegd.join() === '2026-11' && gat.tekst.indexOf('(nov 2025–okt 2026):** 12.000 kWh') >= 0, gat.tekst);
toets('tabelZet: geen tabel → twijfel', S.tabelZet('# leeg\n', [f1], '2026-12-05').twijfel.length === 1);
toets('tabelZet: andere kolommen → twijfel', S.tabelZet(PAG.replace('| Kale stroomprijs (ct/kWh) ', '| Prijs '), [f1], '2026-12-05').twijfel.length === 1);

// ── bijsturen leest de nieuwe rij (zelfde tabelvorm als wv2700) ──
let B = null; try { B = require(path.resolve('financien-bijsturen.js')); } catch (e) { B = null; }
if (B && typeof B.stroomUit === 'function') {
  const s = B.stroomUit(z.tekst), l = s.rijen[s.rijen.length - 1];
  toets('financien-bijsturen leest nov 2026 als laatste maand', l.maand === '2026-11' && l.kwh === 1235 && l.eur === 345.67 && l.ct === 28 && l.kaal === 20.1, l);
} else toets('financien-bijsturen.stroomUit beschikbaar (of bewust overgeslagen)', true);

// ── ronde() met nagebootste facturen.sqlite ──
async function ronde(facturen, pagina, staat) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE factuur(id TEXT, document TEXT, soort TEXT, leverancier_kvk TEXT, entiteit TEXT, valuta TEXT, status TEXT, factuurdatum TEXT, incl_eur INTEGER);" +
    'CREATE TABLE document(id TEXT, sha256 TEXT, mime TEXT)');
  const teksten = {};
  facturen.forEach(function (f, i) {
    db.prepare('INSERT INTO factuur VALUES (?,?,?,?,?,?,?,?,?)').run(f.id || 'f' + i, 'd' + i, 'factuur', f.kvk || S.KVK_TIBBER, f.entiteit || 'prive', 'EUR', f.status || 'prive_archief', f.datum || '2026-12-05', f.incl);
    db.prepare('INSERT INTO document VALUES (?,?,?)').run('d' + i, 'sha' + i, 'application/pdf'); teksten['sha' + i] = f.tekst;
  });
  const io = { pagina: pagina, box: [], staat: staat || null, gesloten: false, schrijf: 0 };
  const u = await S.ronde({ openFacturen: function () { return { db: db, sluit: function () { io.gesloten = true; } }; },
    stukLees: function (sha) { return Buffer.from(teksten[sha] == null ? '' : teksten[sha]); },
    pdfNaarTekst: async function (b) { const t = b.toString(); return t ? { ok: true, tekst: t } : { ok: false }; },
    vaultWijzig: function (fn) { const n = fn(io.pagina); if (n == null) return false; io.pagina = n; io.schrijf++; return true; },
    boxRij: function (t) { io.box.push(t); return true; }, staatLees: function () { return io.staat; }, staatZet: function (o) { io.staat = o; },
    ams: function () { return { datum: '2026-12-06', klok: '2026-12-06 08:05' }; } });
  return { u: u, io: io };
}
(async function () {
  const nov = { incl: 34567, tekst: factuur('november 2026', '1.234,56', '20,10', '345,67') };
  let r = await ronde([nov], PAG);
  toets('ronde: nieuwe maand geschreven, geen box', r.u.ok && r.u.toegevoegd.join() === '2026-11' && r.io.schrijf === 1 && !r.io.box.length && r.io.gesloten, r.u);
  toets('ronde: staat zonder bedragen', r.io.staat.dag === '2026-12-06' && !/345|1234/.test(JSON.stringify(r.io.staat)), r.io.staat);
  const r2 = await ronde([nov], r.io.pagina, r.io.staat);
  toets('ronde: tweede keer niets', r2.io.schrijf === 0 && r2.u.gelijk.join() === '2026-11' && !r2.io.box.length, r2.u);
  const r3 = await ronde([nov, { incl: 34500, tekst: factuur('november 2026', '1.234,56', '20,10', '345,00') }], PAG);
  toets('ronde: twee verschillende facturen voor één maand → niets, één box-rij', r3.io.schrijf === 0 && r3.io.box.length === 1 && /twee Tibber-facturen/.test(r3.io.box[0]), r3.u);
  const r4 = await ronde([nov, { id: 'fx', incl: 34567, tekst: factuur('november 2026', '1.234,56', '20,10', '345,67') }], PAG);
  toets('ronde: dezelfde factuur twee keer (herhaalde mail) → één rij', r4.io.schrijf === 1 && !r4.io.box.length && (r4.io.pagina.match(/\| nov 2026 \|/g) || []).length === 1, r4.u);
  const kapot = { id: 'fk', incl: 40000, tekst: 'scan zonder tekst' };
  const r5 = await ronde([kapot], PAG);
  toets('ronde: onleesbare factuur → één box-rij, niets geschreven', r5.io.schrijf === 0 && r5.io.box.length === 1 && /#stroomtabel/.test(r5.io.box[0]) && !/40000|400,00/.test(r5.io.box[0]), r5.io.box);
  const r6 = await ronde([kapot], PAG, r5.io.staat);
  toets('ronde: hetzelfde geval niet twee keer gemeld', r6.io.box.length === 0);
  const r7 = await ronde([Object.assign({}, nov, { status: 'geen_factuur' }), Object.assign({}, nov, { kvk: '12345678' }), Object.assign({}, nov, { entiteit: 'tolgaarde' }), Object.assign({}, nov, { datum: '2026-06-01' })], PAG);
  toets('ronde: geen factuur / andere leverancier / zakelijk / ouder dan 120 dagen tellen niet', r7.u.facturen === 0 && r7.io.schrijf === 0, r7.u);
  const r9 = await ronde([nov, { id: 'fc', incl: 1000, datum: '2026-12-10', tekst: 'correctie zonder leesbare regels' }], PAG);
  toets('ronde: onleesbare factuur rond dezelfde maand blokkeert de toevoeging (review MOET 1)', r9.io.schrijf === 0 && r9.io.box.length === 1, r9.u);
  const r10 = await ronde([nov, { id: 'fo', incl: 1000, datum: '2026-08-10', tekst: 'oude scan' }], PAG);
  toets('ronde: onleesbare factuur van maanden eerder blokkeert nov niet', r10.io.schrijf === 1 && r10.io.box.length === 1, r10.u);
  const r8 = await ronde([Object.assign({}, nov, { incl: 34600 })], z.tekst);
  toets('ronde: tabel heeft al een andere nov-rij → niets, box-rij', r8.io.schrijf === 0 && r8.io.box.length === 1, r8.u);

  // ── aansluiting ──
  const src = fs.readFileSync('server.js', 'utf8'), mod = fs.readFileSync('stroom-tabel.js', 'utf8');
  toets('server.js: na de bankronde, één keer per dag, alleen-lezen Facturen, vault-veilig', /tibberNaBankRonde\(\); \} catch[^\n]*\n\s*try \{ stroomTabelNaBankRonde\(\); \}/.test(src) &&
    /vorige\.dag === dag\) return;/.test(src) && /facturenMod\.open\(FACTUREN_DIR, \{ alleenLezen: true \}\)/.test(src) && /VV\(\)\.wijzig\(path\.join\(VAULT, stroomTabel\.P_ENERGIE\)/.test(src));
  toets('stroom-tabel.js: geen netwerk-, proces- of bestandsmodule', !/require\(/.test(mod));
  toets('uitrol.sh en Dockerfile: stroom-tabel.js gaat mee in de release', /RELEASE_OPTIONEEL="[^"]*\bstroom-tabel\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
    /COPY stroom-tabel\.js \/app\/release-bootstrap\/stroom-tabel\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  console.log('KLAAR ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering ' + (e && e.stack)); process.exit(1); });
JS
