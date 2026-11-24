'use strict';
// wv3949 (3C103): steunbord Gambia — toezeggingen uit de vaste plek, koppelen zeker/niet zeker/niet toe te wijzen, sommen. Verzonnen data.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const S = require(path.join(__dirname, '..', 'gambia-steunbord.js'));
let n = 0; const t = function (naam, fn) { fn(); n++; console.log('ok', naam); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), pers = path.join(dir, '20_Prive', 'Gambia', 'Personen');
fs.mkdirSync(pers, { recursive: true });
fs.writeFileSync(path.join(pers, 'Abdou Jallow.md'), '---\ntype: persoon\n---\n# Abdou Jallow\n\n## Toezeggingen\n\n| Datum | Toezegging | Bedrag | Citaat | Stand |\n|---|---|---|---|---|\n' +
  '| 2026-09-07 | Watertank | D 10.000 | "when the bank works" | open |\n| 2026-10-01 | Zaaigoed | D 3.000 | "yes" | open |\n| 2026-10-02 | Fiets | € 80 | "ok" | betaald 2026-10-03 (Taptap) |\n\n## Karakter\n\n## 11 oktober 2026 — D 7.000 gestuurd\n\nDavid stuurde D 7.000 via Xpress Cash.\n');
fs.writeFileSync(path.join(pers, 'Binta.md'), '---\ntype: persoon\n---\n# Binta\n\n- 12-10: medicijngeld, D 4.000 gestuurd.\n- 1-11: weer D 4.000.\n');
fs.writeFileSync(path.join(pers, 'Lamin Ceesay.md'), '# Lamin Ceesay\n\n- 1-11: D 4.000 voor de markt.\n');
fs.writeFileSync(path.join(pers, 'David Schaap.md'), '# David\n');
const D = S.leesDossiers(dir);

t('vaste plek gelezen, David Schaap overgeslagen', function () {
  assert.deepStrictEqual(D.dossiers.map(function (d) { return d.naam; }), ['Abdou Jallow', 'Binta', 'Lamin Ceesay']);
  const a = D.dossiers[0];
  assert.strictEqual(a.toezeggingen.length, 3); assert.deepStrictEqual(a.toezeggingen[0].bedrag, { bedrag: 10000, valuta: 'GMD' });
  assert.strictEqual(a.toezeggingen[2].stand_dossier, 'betaald'); assert.deepStrictEqual(a.toezeggingen[2].bedrag, { bedrag: 80, valuta: 'EUR' });
  assert.strictEqual(D.dossiers[1].heeft_plek, false);
});
t('bedragen en datums', function () {
  assert.deepStrictEqual(S.leesBedrag('D10.000'), { bedrag: 10000, valuta: 'GMD' });
  assert.deepStrictEqual(S.leesBedrag('GMD 25,000'), { bedrag: 25000, valuta: 'GMD' });
  assert.deepStrictEqual(S.leesBedrag('€ 75,95'), { bedrag: 75.95, valuta: 'EUR' });
  assert.deepStrictEqual(S.datumsIn('## 16–17 november 2026 — x; 3-9 en 2026-10-05', 2026), ['2026-09-03', '2026-10-05', '2026-11-16', '2026-11-17']);
});
const eco = [
  { datum: '2026-09-20', soort: 'af', valuta: 'GMD', bedrag: -10000, omschrijving: 'REF:1 TRANSFERT INTERBANCAIRE B/O DAVID SCHAAP IFO ABDOU JALLOW Interbank Watertank' },
  { datum: '2026-09-20', soort: 'af', valuta: 'GMD', bedrag: -12.24, omschrijving: 'CHARGE REF:1 TRANSFERT INTERBANCAIRE B/O DAVID SCHAAP IFO ABDOU JALLOW Interbank' },
  { datum: '2026-09-20', soort: 'af', valuta: 'GMD', bedrag: -10.6, omschrijving: 'GAMSWITCH CHARGE REF:1 TRANSFERT INTERBANCAIRE B/O DAVID SCHAAP IFO ABDOU JALLOW Int' },
  { datum: '2026-10-12', soort: 'af', valuta: 'GMD', bedrag: -7000, omschrijving: 'REF: Q1 XPRESS CASH' },        // spoor: alleen Abdou (11 okt, D 7.000)
  { datum: '2026-10-12', soort: 'af', valuta: 'GMD', bedrag: -4000, omschrijving: 'REF: Q2 XPRESS CASH' },        // spoor: alleen Binta (12-10)
  { datum: '2026-11-02', soort: 'af', valuta: 'GMD', bedrag: -4000, omschrijving: 'REF: Q3 XPRESS CASH' },        // spoor: Binta én Lamin → twijfel
  { datum: '2026-11-02', soort: 'af', valuta: 'GMD', bedrag: -14, omschrijving: 'REF: Q3 XPRESS CASH CHARGE' },
  { datum: '2026-11-02', soort: 'af', valuta: 'GMD', bedrag: -80, omschrijving: 'MONTHLY E-BANKING CHARGE' },
  { datum: '2026-09-28', soort: 'af', valuta: 'EUR', bedrag: -500, omschrijving: 'REF:9 IFO DAVID SCHAAP Binta' },   // eigen omzetting
  { datum: '2026-09-28', soort: 'bij', valuta: 'GMD', bedrag: 42000, omschrijving: 'REF:9 B/O DAVID SCHAAP Binta' },
  { datum: '2026-11-02', soort: 'bij', valuta: 'GMD', bedrag: 1500, omschrijving: 'REF:8 B/O LAMIN CEESAY 3/36' },
  { datum: '2026-08-31', soort: 'bij', valuta: 'GMD', bedrag: 6.8, omschrijving: 'GAMBIA SAVINGS CREDIT INTEREST' },
  { datum: '2025-12-31', soort: 'af', valuta: 'GMD', bedrag: -999, omschrijving: 'REF: Q0 XPRESS CASH' },           // vóór van
];
const nl = [{ datum: '2026-10-03', bedrag: -80.5, valuta: 'EUR', tegenpartij: 'Taptap Send EU', omschrijving: 'x' }];
const b = S.bereken({ ecobank: eco, nl: nl, dossiers: D.dossiers, van: '2026-01-01' });
const P = function (n) { return b.personen.find(function (p) { return p.naam === n; }); };

t('zeker: de bank noemt de ontvanger; toezegging betaald', function () {
  const a = P('Abdou Jallow');
  assert.strictEqual(a.betaald.filter(function (x) { return x.zeker; }).length, 1);
  assert.strictEqual(a.toezeggingen[0].stand, 'betaald'); assert.strictEqual(a.toezeggingen[0].zeker, true);
  assert.strictEqual(a.toezeggingen[1].stand, 'open');
  assert.strictEqual(a.toezeggingen[2].stand, 'betaald volgens dossier'); assert.strictEqual(a.toezeggingen[2].zeker, false);   // Codex MOET 1
  assert.strictEqual(a.open, 1); assert.strictEqual(a.niet_zeker, 1);
});
t('niet zeker: één dossier noemt bedrag en datum; twee dossiers = niet toe te wijzen met kandidaten', function () {
  const a = P('Abdou Jallow'), bi = P('Binta');
  assert.ok(a.betaald.some(function (x) { return !x.zeker && x.bedrag === 7000; }));
  assert.ok(bi.betaald.some(function (x) { return !x.zeker && x.bedrag === 4000 && x.datum === '2026-10-12'; }));
  assert.strictEqual(bi.betaald.length, 1);
  assert.strictEqual(b.twijfel.length, 1); assert.deepStrictEqual(b.twijfel[0].kandidaten.sort(), ['Binta', 'Lamin Ceesay']);
});
t('Codex MOET 2: één betaling dekt hooguit één toezegging', function () {
  const d = [{ naam: 'Abdou Jallow', aliassen: [], heeft_plek: true, stukken: [], toezeggingen: [
    { datum: '2026-09-01', wat: 'Tank een', bedrag: { bedrag: 10000, valuta: 'GMD' }, bedrag_tekst: 'D 10.000', citaat: '', stand_dossier: 'open', stand_tekst: 'open' },
    { datum: '2026-09-02', wat: 'Tank twee', bedrag: { bedrag: 10000, valuta: 'GMD' }, bedrag_tekst: 'D 10.000', citaat: '', stand_dossier: 'open', stand_tekst: 'open' }] }];
  const x = S.bereken({ ecobank: [eco[0]], nl: [], dossiers: d, van: '2026-01-01' }).personen[0];
  assert.deepStrictEqual(x.toezeggingen.map(function (t) { return t.stand; }), ['betaald', 'open']);
});
t('Codex MOET 3: ontvangen per valuta', function () {
  const x = S.bereken({ ecobank: [eco[10], { datum: '2026-11-03', soort: 'bij', valuta: 'EUR', bedrag: 50, omschrijving: 'REF:7 B/O LAMIN CEESAY x' }], nl: [], dossiers: D.dossiers, van: '2026-01-01' });
  const l = x.personen.find(function (p) { return p.naam === 'Lamin Ceesay'; });
  assert.deepStrictEqual(l.ontvangen_som, { GMD: 1500, EUR: 50 });
  assert.ok(/D 1\.500 en € 50/.test(S.md(x)), S.md(x));
});
t('kosten en maandkosten nooit aan een persoon; eigen omzetting = intern; ontvangen apart', function () {
  assert.strictEqual(b.kosten.aantal, 4);
  assert.strictEqual(b.intern.length, 2);
  assert.strictEqual(P('Lamin Ceesay').ontvangen.length, 1);
  assert.ok(!b.personen.some(function (p) { return p.betaald.some(function (x) { return x.bedrag === 80 || x.bedrag === 14; }); }));
});
t('som betaald = som van alles wat uitging (los nagerekend), per valuta', function () {
  const gmd = eco.filter(function (p) { return p.soort === 'af' && p.datum >= '2026-01-01' && p.valuta === 'GMD'; }).reduce(function (s, p) { return s - p.bedrag; }, 0);
  assert.strictEqual(b.sommen.uit.GMD, Math.round(gmd * 100) / 100);
  assert.strictEqual(b.sommen.uit.EUR, 80.5);   // de EUR-omzetting naar de eigen GMD-rekening telt niet
  assert.deepStrictEqual(b.klopt, { GMD: true, EUR: true });
  const delen = ['zeker', 'waarschijnlijk', 'onherleid', 'kosten'].reduce(function (s, k) { return s + (b.sommen[k].GMD || 0); }, 0);
  assert.strictEqual(Math.round(delen * 100) / 100, b.sommen.uit.GMD);
});
t('md: niet zeker staat erbij, som klopt', function () {
  const m = S.md(b);
  assert.ok(/Abdou Jallow\*\*: toegezegd 7-9 Watertank D 10\.000 → betaald 20-9 \(bank\)/.test(m), m);
  assert.ok(/niet zeker/.test(m)); assert.ok(/klopt met de bank/.test(m));
});
t('symlink in de dossiermap wordt niet gevolgd', function () {
  fs.writeFileSync(path.join(dir, 'geheim.md'), '## Toezeggingen\n| 2026-01-01 | GEHEIM | D 1 | x | open |\n');
  fs.symlinkSync(path.join(dir, 'geheim.md'), path.join(pers, 'Link.md'));
  const D2 = S.leesDossiers(dir);
  assert.ok(!D2.dossiers.some(function (d) { return d.naam === 'Link'; }));
  assert.ok(D2.fouten.some(function (f) { return /^Link: niet te lezen/.test(f); }));
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(n + '/' + n + ' groen');
