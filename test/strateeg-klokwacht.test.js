'use strict';
// wv4357: klokwacht van de Strateeg in server.js (stille klok of vastzittende vlag → één logregel en één box-rij per dag) en de kop om de kale
// box-zin van strateeg.js. Knipt de echte functies uit server.js en draait ze in een vm met nep-strateegApp. Alle toetsdata verzonnen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function knipFunctie(naam) {
  const i = SRV.indexOf('\nfunction ' + naam + '(');
  assert.ok(i >= 0, naam + ' gevonden');
  const j = SRV.indexOf('\n}\n', i);
  return SRV.slice(i + 1, j + 2);
}
function knipRegel(begin) { const i = SRV.indexOf(begin); assert.ok(i >= 0, begin); return SRV.slice(i, SRV.indexOf('\n', i) + 1); }

// NL-tijd → ms (november = UTC+1)
const NL = (s) => Date.parse(s.replace(' ', 'T') + ':00+01:00');

function omgeving(o) {
  const meta = Object.assign({}, o.meta || {});
  const box = [], log = [];
  const ctx = {
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(ctx.__nu); } static now() { return ctx.__nu; } },
    __nu: o.nu, Math, Object, Number, String, Infinity, require: function () { return { REGELS: { beurzen: { A: { gesloten: o.gesloten || [] }, B: { gesloten: o.gesloten || [] } } } }; },
    path: { join: function () { return 'strateeg.js'; } }, __dirname: '.',
    SERVER_ECHT: true, rolPrimair: function () { return o.primair !== false; }, APP_PROCES_START: o.procesStart || 0,
    strateegBezig: !!o.bezigSinds, strateegBezigSinds: o.bezigSinds || 0,
    strateegApp: { info: function () { return o.info; }, _M: { get: function (k) { return meta[k] == null ? null : meta[k]; }, zet: function (k, v) { meta[k] = String(v); } } },
    ovisBoxRij: function (t) { if (o.boxFaalt) return false; box.push(t); return true; }, schrijfLog: function (t) { log.push(t); }, nu: function () { return 'T'; },
    velden: function (x) { return Object.keys(x).map(function (k) { return k + '=' + x[k]; }).join(' '); }, logError: function (w) { log.push('fout ' + w); },
  };
  vm.createContext(ctx);
  vm.runInContext(knipRegel('const STRATEEG_STIL_MS = ') + knipRegel('let strateegKlokLogDag = ') + knipFunctie('strateegBoxTekst') + knipFunctie('strateegKlokOordeel') + knipFunctie('strateegKlokWacht') +
    '\nthis.wacht = strateegKlokWacht; this.oordeel = strateegKlokOordeel; this.boxTekst = strateegBoxTekst;', ctx);
  return { ctx, meta, box, log };
}

test('26-11 nagespeeld: laatste kwartier 11:01, pod terug om 17:25 → eerste controle meldt stil (385 min) met herstartspoor', function () {
  const e = omgeving({ nu: NL('2026-11-26 17:26'), procesStart: NL('2026-11-26 17:25'), info: { stand: 'aan', laatste_tik: NL('2026-11-26 11:01'), tikken_vandaag: 9 } });
  const o = e.ctx.wacht();
  assert.strictEqual(o.soort, 'stil'); assert.strictEqual(o.minuten, 385);
  assert.strictEqual(e.box.length, 1);
  assert.match(e.box[0], /^\n## \[direct\] 2026-11-26 17:26 — Strateeg-klok stil: geen kwartier afgerond sinds 11:01 \(385 min\) #beleggen-strateeg\n- status: open\n/);
  assert.match(e.box[0], /de pod herstartte ná de laatste tik/);
  assert.match(e.log[0], /stap=klokwacht soort=stil minuten=385 herstart=1/);
  assert.strictEqual(e.meta.klokwacht_dag, '2026-11-26');
});

test('hooguit één box-rij per dag, ook na een herstart (meta), en de volgende dag weer', function () {
  const info = { stand: 'aan', laatste_tik: NL('2026-11-26 11:01'), tikken_vandaag: 9 };
  const e = omgeving({ nu: NL('2026-11-26 17:26'), info, meta: { klokwacht_dag: '2026-11-26' } });
  assert.strictEqual(e.ctx.wacht().soort, 'stil');
  assert.strictEqual(e.box.length, 0); assert.strictEqual(e.log.length, 0);
  const f = omgeving({ nu: NL('2026-11-27 10:00'), info: { stand: 'aan', laatste_tik: NL('2026-11-26 22:01'), tikken_vandaag: 0 }, meta: { klokwacht_dag: '2026-11-26' } });
  f.ctx.wacht();
  assert.strictEqual(f.box.length, 1, 'nieuwe dag = nieuwe rij');
  assert.match(f.box[0], /sinds 09:00 \(60 min\)/, 'stilte telt vanaf 09:00, niet vanaf gisteravond');
});

test('box-rij faalt (Codex MOET 1): niet gemarkeerd, volgende minuut opnieuw; logregel maar één keer', function () {
  const e = omgeving({ nu: NL('2026-11-26 17:26'), boxFaalt: true, info: { stand: 'aan', laatste_tik: NL('2026-11-26 11:01'), tikken_vandaag: 9 } });
  e.ctx.wacht(); e.ctx.__nu = NL('2026-11-26 17:27'); e.ctx.wacht();
  assert.strictEqual(e.meta.klokwacht_dag, undefined, 'niet gemarkeerd');
  assert.strictEqual(e.log.filter(function (l) { return /klokwacht/.test(l); }).length, 1, 'één logregel');
});

test('normale dag: geen melding (kwartier 14 min geleden, ochtend vóór 09:46, na 22:00, weekend, feestdag, stand wacht/klaar, rol passief)', function () {
  const gewoon = { stand: 'aan', laatste_tik: NL('2026-11-26 14:01'), tikken_vandaag: 21 };
  const geval = [
    { nu: NL('2026-11-26 14:15'), info: gewoon },
    { nu: NL('2026-11-26 09:44'), info: { stand: 'aan', laatste_tik: NL('2026-11-25 22:01'), tikken_vandaag: 0 } },   // 44 min na 09:00
    { nu: NL('2026-11-26 22:30'), info: { stand: 'aan', laatste_tik: NL('2026-11-26 12:01') } },
    { nu: NL('2026-11-28 14:00'), info: { stand: 'aan', laatste_tik: NL('2026-11-27 22:01') } },   // zaterdag
    { nu: NL('2026-12-25 14:00'), info: { stand: 'aan', laatste_tik: NL('2026-12-24 22:01') }, gesloten: ['2026-12-25'] },
    { nu: NL('2026-11-26 14:00'), info: { stand: 'wacht', laatste_tik: null } },
    { nu: NL('2026-12-28 14:00'), info: { stand: 'klaar', laatste_tik: NL('2026-12-23 22:01') } },
    { nu: NL('2026-11-26 17:26'), info: { stand: 'aan', laatste_tik: NL('2026-11-26 11:01') }, primair: false },
  ];
  geval.forEach(function (g, n) {
    const e = omgeving(g);
    const o = e.ctx.wacht();
    assert.ok(!o, 'geval ' + n + ' gaf ' + JSON.stringify(o));
    assert.strictEqual(e.box.length, 0, 'geval ' + n);
  });
});

test('grens 45 min: 09:46 zonder kwartier vandaag = stil; pauze telt mee (pauze schrijft ook tikken)', function () {
  const e = omgeving({ nu: NL('2026-11-26 09:46'), info: { stand: 'pauze', laatste_tik: NL('2026-11-25 22:01'), tikken_vandaag: 0 } });
  assert.strictEqual(e.ctx.wacht().soort, 'stil');
  const f = omgeving({ nu: NL('2026-11-26 14:46'), info: { stand: 'aan', laatste_tik: NL('2026-11-26 14:01') } });
  assert.ok(!f.ctx.wacht(), 'precies 45 min = nog niet');
});

test('vastzittende vlag: bezig > 10 min = vast (ook als het laatste kwartier vers is); 9 min = niets', function () {
  const info = { stand: 'aan', laatste_tik: NL('2026-11-26 14:01'), tikken_vandaag: 21 };
  const e = omgeving({ nu: NL('2026-11-26 14:13'), bezigSinds: NL('2026-11-26 14:02'), info });
  const o = e.ctx.wacht();
  assert.strictEqual(o.soort, 'vast'); assert.strictEqual(o.minuten, 11);
  assert.match(e.box[0], /Strateeg-klok hangt: de minuuttik is al 11 min bezig/);
  const f = omgeving({ nu: NL('2026-11-26 14:11'), bezigSinds: NL('2026-11-26 14:02'), info });
  assert.ok(!f.ctx.wacht());
});

test('info met fout of een gooiende module: geen melding, geen crash', function () {
  const e = omgeving({ nu: NL('2026-11-26 17:26'), info: { aan: true, fout: true } });
  assert.strictEqual(e.ctx.wacht(), null); assert.strictEqual(e.box.length, 0);
  const f = omgeving({ nu: NL('2026-11-26 17:26'), info: null });
  f.ctx.strateegApp.info = function () { throw new Error('kapot'); };
  assert.strictEqual(f.ctx.wacht(), null); assert.match(f.log[0], /fout strateeg-klokwacht/);
});

test('kale box-zin uit strateeg.js krijgt een kop; een tekst met kop blijft gelijk', function () {
  const e = omgeving({ nu: NL('2026-11-26 10:31'), info: {} });
  const t = e.ctx.boxTekst('Strateeg (OVIS Beleggen, fictief): drie kwartieren op rij geen enkele verse koers van L&S. #beleggen-strateeg');
  assert.match(t, /^\n## \[direct\] 2026-11-26 10:31 — Strateeg \(OVIS Beleggen, fictief\): drie kwartieren .* #beleggen-strateeg\n- status: open\n- van: pod strateeg\.js/);
  assert.strictEqual(e.ctx.boxTekst('\n## [log] x\n- a\n'), '\n## [log] x\n- a\n');
  assert.strictEqual(e.ctx.boxTekst('## [log] x\n'), '\n## [log] x\n');
});

test('bedrading: de minuutklok roept eerst de klokwacht aan; strateegTik zet de bezig-tijd', function () {
  assert.match(SRV, /setInterval\(function \(\) \{ strateegKlokWacht\(\); strateegTik\(\); \}, 60000\)/);
  assert.match(SRV, /strateegBezig = true; strateegBezigSinds = Date\.now\(\);/);
  assert.match(SRV, /boxRij: function \(t\) \{ return ovisBoxRij\(strateegBoxTekst\(t\)\); \}/);
});
