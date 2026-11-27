'use strict';
// wv4193 (3C11 + 3C52): Voor jou — wat Ja en Nee betekenen bij de knoppen; een datum alleen als er buiten Socev iets afloopt (met reden).
// Verzonnen kaarten; de functies uit server.js geknipt en in een vm-context gedraaid (zoals vj-knoplink.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const knip = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i > 0 && j > i, a); return src.slice(i, j); };
const ctx = vm.createContext({ console });
vm.runInContext([
  knip('function appYmdPlus(', 'function appKort('), knip('function appKort(', '\n}\n') + '\n}\n',
  knip('const APP_VJ_WAAR =', '\n'), knip('function appVjGewoon(', '\n}\n') + '\n}\n',
  knip('function appVjDag(', '\n'), knip('function appVjRegel2(', 'async function appVjPunten('),
  knip('function appVjModuleKaart(', '\n}\n') + '\n}\n',
  'globalThis.H = { appVjRegel2, appVjDichtbij, appVjDeadline, appVjVolgorde, appVjVrijTel, appVjJaNee };'].join('\n'), ctx);
const H = ctx.H;
const V = '2026-11-27';
const wvKaart = (o) => Object.assign({ id: 1, soort: 'doen', titel: 'Proef', deadline: '2026-12-04', herkomst: { wv: [9001], auto: 'wv' }, volgorde: 100, aangemaakt: '2026-11-20T10:00:00Z' }, o);

test('3C52: agentkaart zonder reden = geen datum, geen chip, geen regel', function () {
  const p = wvKaart({ deadline: '2026-11-28' });
  assert.strictEqual(H.appVjDeadline(p), null);
  assert.strictEqual(H.appVjDichtbij(p, V), false);
  assert.strictEqual(H.appVjRegel2(p, V), '');
  assert.strictEqual(H.appVjRegel2(Object.assign({}, p, { soort: 'besluit' }), V), 'besluit');
});

test('3C52: met reden = datum, reden bij de datum, chip binnen 48 uur', function () {
  const p = wvKaart({ deadline: '2026-11-28', herkomst: { wv: [9001], deadline_reden: 'De loonmutaties moeten vrijdag bij de salarisadministratie zijn' } });
  assert.deepStrictEqual(Object.assign({}, H.appVjDeadline(p)), { datum: '2026-11-28', reden: 'De loonmutaties moeten vrijdag bij de salarisadministratie zijn' });
  assert.strictEqual(H.appVjDichtbij(p, V), true);
  assert.match(H.appVjRegel2(p, V), /^uiterlijk morgen · De loonmutaties moeten vrijdag bij de salarisadmin/);
  assert.ok(H.appVjRegel2(p, V).length <= 'uiterlijk morgen · '.length + 60);
  assert.strictEqual(H.appVjDeadline(wvKaart({ herkomst: { wv: [1], deadline_reden: '   ' } })), null, 'lege reden telt niet');
});

test('3C52: modulekaart houdt zijn datum (module rekent hem uit echte gegevens); met wv erbij niet', function () {
  assert.deepStrictEqual(Object.assign({}, H.appVjDeadline(wvKaart({ herkomst: { module: 'pot' } }))), { datum: '2026-12-04', reden: null });
  assert.strictEqual(H.appVjDeadline(wvKaart({ herkomst: { module: 'harvester', wv: [3] } })), null);
  assert.strictEqual(H.appVjDeadline(wvKaart({ deadline: 'morgen', herkomst: { module: 'pot' } })), null, 'geen geldige datum');
});

test('3C52: volgorde = echte datum, dan werk dat vrijkomt, dan volgorde en leeftijd', function () {
  const items = [{ id: 9001, status: 'geblokkeerd' }, { id: 9002, status: 'geblokkeerd' }, { id: 9003, status: 'open', wacht_op: ['item:9002'] },
    { id: 9004, status: 'open', wacht_op: ['item:9002'] }, { id: 9005, status: 'klaar', wacht_op: ['item:9001'] }, { id: 9006, status: 'gestart' }];
  const k = [
    wvKaart({ id: 1, deadline: '2026-11-29', herkomst: { wv: [9001] }, volgorde: 10 }),                                  // standaarddatum: telt niet
    wvKaart({ id: 2, deadline: null, herkomst: { wv: [9002] }, volgorde: 100 }),                                         // maakt 3 rijen vrij
    wvKaart({ id: 3, deadline: '2026-12-10', herkomst: { wv: [9006], deadline_reden: 'Termijn van de gemeente' } }),     // echte datum, later
    wvKaart({ id: 4, deadline: '2026-12-01', herkomst: { module: 'pot' } }),                                             // modulekaart, vroeger
    wvKaart({ id: 5, deadline: null, herkomst: { module: 'intake' }, volgorde: 5 }),                                     // geen werk, lage volgorde
    wvKaart({ id: 6, deadline: null, herkomst: { wv: [9001] }, volgorde: 100, aangemaakt: '2026-11-01T00:00:00Z' }),    // 1 rij, ouder
  ];
  const vrij = H.appVjVrijTel(k, items);
  assert.deepStrictEqual(Object.assign({}, vrij), { 1: 1, 2: 3, 6: 1 });
  assert.deepStrictEqual(k.slice().sort(H.appVjVolgorde(vrij)).map((p) => p.id), [4, 3, 2, 1, 6, 5]);
  assert.deepStrictEqual(k.slice().sort(H.appVjVolgorde(null)).map((p) => p.id), [4, 3, 5, 1, 6, 2], 'zonder werkvoorraad: volgorde, leeftijd');
});

test('3C11: Ja/Nee uit de stappen (losse stappen, één stap, haakjes, dubbele punt)', function () {
  const st = (a) => a.map((t) => ({ tekst: t, commando: null }));
  let r = H.appVjJaNee(st(['Lees de waarom.', 'Ja = ik ruim de oude mappen op.', 'Nee = alles blijft staan.']));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ja: 'ik ruim de oude mappen op.', nee: 'alles blijft staan.', stappen: [1, 2] });
  r = H.appVjJaNee(st(['Ja = ik geef ze later; Nee = laat zo, zij komen niet op het scherm.']));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ja: 'ik geef ze later', nee: 'laat zo, zij komen niet op het scherm.', stappen: [0] });
  r = H.appVjJaNee(st(['Ja = beide boxen zijn verhuurd. Nee = je gebruikt ze allebei zelf.']));
  assert.strictEqual(r.ja, 'beide boxen zijn verhuurd'); assert.strictEqual(r.nee, 'je gebruikt ze allebei zelf.');
  r = H.appVjJaNee(st(['Ja (met je vingerafdruk) = de pagina komt op de tv.', 'Nee: niets verandert.']));
  assert.strictEqual(r.ja, '(met je vingerafdruk) de pagina komt op de tv.'); assert.strictEqual(r.nee, 'niets verandert.');
  assert.strictEqual(H.appVjJaNee(st(['Tik op Ja als je akkoord bent.', 'Bij Nee doe ik niets.'])), null, 'vrije zin blijft een stap');
  assert.strictEqual(H.appVjJaNee(st(['Janneke = de contactpersoon.'])), null, 'woordgrens');
  assert.strictEqual(H.appVjJaNee([{ tekst: 'Ja = voer uit', commando: 'iets' }]), null, 'stap met commando blijft');
  r = H.appVjJaNee(st(['Ja = eerst.', 'Ja = tweede keer.']));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ja: 'eerst.', nee: null, stappen: [0] }, 'tweede Ja blijft een stap');
});

test('server.js: lijst gesorteerd vóór de knip, detail geeft ja_nee alleen bij een besluit met knoppen', function () {
  assert.match(src, /\.sort\(appVjVolgorde\(await appVjVrij\(eigen\)\)\)\.slice\(0, APP_VJ_MAX\)/);
  assert.match(src, /ja_nee: p\.soort === 'besluit' && !sw \? appVjJaNee\(stappen\) \|\| undefined : undefined/);
  assert.match(src, /deadline: appVjDeadline\(p\) \? p\.deadline : null, deadline_reden:/);
});
