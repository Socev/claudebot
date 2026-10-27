'use strict';
// Toets facturen-kaart.js (wv1705, OVIS M3a: verzamelkaart Facturen). Puur; io is een nep-tabel die mk_voor_jou_zet/-status nadoet
// (zet laat de status staan, status alleen bij de juiste van-status). De echte RPC is apart getoetst in een rollback (wv1705, vault § Log).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const K = require('../facturen-kaart.js');

function nepTabel(begin) {
  const t = new Map((begin || []).map((p) => [p.sleutel, Object.assign({}, p)]));
  const log = [];
  return {
    t, log,
    punten: () => Array.from(t.values()).map((p) => ({ sleutel: p.sleutel, status: p.status, gesloten_door: p.gesloten_door })),
    io: {
      zet: async (p) => { log.push(['zet', p.sleutel]); const o = t.get(p.sleutel); t.set(p.sleutel, Object.assign({}, o || { status: 'open' }, p, { status: o ? o.status : 'open', gesloten_door: o ? o.gesloten_door : null })); },
      status: async (s, van, naar, x) => {
        log.push(['status', s, van, naar, x.samengevoegd_in || x.bewijs || '']);
        const o = t.get(s);
        if (!o || o.status !== van) return { ok: false, fout: 'conflict', nu: o ? o.status : null };
        o.status = naar; o.gesloten_door = ['gedaan', 'vervallen', 'samengevoegd'].includes(naar) ? 'agent' : null;
        return { ok: true };
      },
    },
  };
}
const D = '2026-10-27', NK = '27-10 15:30';

test('1 kaart: tekst binnen de kaartgrenzen, herkomst module + doel, geen verwijzingen', () => {
  for (const n of [1, 3, 120]) {
    const k = K.kaart('facturen-' + D, n, NK);
    assert.ok(k.titel.length <= 90 && k.titel.length >= 3, 'titel');
    assert.ok(k.waarom.length <= 400, 'waarom');
    assert.ok(k.meting.length <= 300, 'meting');
    assert.ok(k.stappen.length >= 1 && k.stappen.length <= 12);
    assert.deepStrictEqual(k.herkomst, { module: 'facturen', handmatig: 'facturen', doel: { scherm: 'facturen', focus: 'stap:beoordelen' } });
    assert.ok(!/\bwv\d|\/opt\/|\.md\b|https?:/.test(JSON.stringify(k)), 'geen paden of wv-nummers');
    assert.ok(k.prive === false && k.soort === 'doen' && k.waar === 'overal');
  }
  assert.match(K.kaart('facturen-' + D, 1, NK).titel, /1 factuur beoordelen/);
  assert.match(K.kaart('facturen-' + D, 3, NK).titel, /3 facturen beoordelen/);
});

test('2 n > 0 zonder kaart: kaart van vandaag verschijnt', async () => {
  const n = nepTabel([{ sleutel: 'iets-anders', status: 'open' }]);
  const u = await K.bijwerken({ datum: D, n: 3, nuKort: NK, punten: n.punten() }, n.io);
  assert.strictEqual(u.gezet, 'facturen-' + D);
  assert.strictEqual(n.t.get('facturen-' + D).status, 'open');
  assert.match(n.t.get('facturen-' + D).titel, /3 facturen/);
  assert.strictEqual(n.t.get('iets-anders').status, 'open', 'andere kaarten ongemoeid');
});

test('3 aantal verandert: bijgewerkt; gelijk aantal: geen schrijfactie', async () => {
  const n = nepTabel();
  await K.bijwerken({ datum: D, n: 3, nuKort: NK, punten: n.punten() }, n.io);
  const u = await K.bijwerken({ datum: D, n: 1, nuKort: NK, punten: n.punten(), vorige: { sleutel: 'facturen-' + D, n: 3 } }, n.io);
  assert.strictEqual(u.gezet, 'facturen-' + D);
  assert.match(n.t.get('facturen-' + D).titel, /1 factuur/);
  const v = await K.bijwerken({ datum: D, n: 1, nuKort: NK, punten: n.punten(), vorige: { sleutel: 'facturen-' + D, n: 1 } }, n.io);
  assert.strictEqual(v.gezet, null, 'niets veranderd = niet schrijven');
});

test('4 n = 0: open en geparkeerde facturen-kaarten dicht met bewijs, andere ongemoeid', async () => {
  const n = nepTabel([{ sleutel: 'facturen-' + D, status: 'open' }, { sleutel: 'facturen-2026-10-20', status: 'later' }, { sleutel: 'facturen-2026-10-19', status: 'gedaan', gesloten_door: 'david' }, { sleutel: 'bank-verleng-ab', status: 'open' }]);
  const u = await K.bijwerken({ datum: D, n: 0, nuKort: NK, punten: n.punten() }, n.io);
  assert.deepStrictEqual(u.gesloten.sort(), ['facturen-2026-10-20', 'facturen-' + D].sort());
  assert.strictEqual(n.t.get('facturen-' + D).status, 'gedaan');
  assert.strictEqual(n.t.get('bank-verleng-ab').status, 'open');
  assert.ok(n.log.filter((l) => l[0] === 'status').every((l) => /geen facturen meer/.test(l[4])), 'bewijs gezet');
  assert.strictEqual(n.log.filter((l) => l[0] === 'zet').length, 0);
});

test('5 nieuwe dag: oudere open kaart samengevoegd in die van vandaag', async () => {
  const n = nepTabel([{ sleutel: 'facturen-2026-10-26', status: 'open' }]);
  const u = await K.bijwerken({ datum: D, n: 2, nuKort: NK, punten: n.punten() }, n.io);
  assert.strictEqual(u.gezet, 'facturen-' + D);
  assert.deepStrictEqual(u.samengevoegd, ['facturen-2026-10-26']);
  assert.strictEqual(n.t.get('facturen-2026-10-26').status, 'samengevoegd');
  assert.ok(n.log.some((l) => l[0] === 'status' && l[4] === 'facturen-' + D), 'samengevoegd_in = vandaag');
});

test('6 door de module gesloten en weer facturen dezelfde dag: kaart gaat weer open', async () => {
  const n = nepTabel([{ sleutel: 'facturen-' + D, status: 'gedaan', gesloten_door: 'agent' }]);
  const u = await K.bijwerken({ datum: D, n: 1, nuKort: NK, punten: n.punten(), vorige: { sleutel: 'facturen-' + D, n: 1 } }, n.io);
  assert.strictEqual(u.heropend, 'facturen-' + D);
  assert.strictEqual(u.gezet, 'facturen-' + D, 'na heropenen altijd schrijven, ook bij gelijk aantal');
  assert.strictEqual(n.t.get('facturen-' + D).status, 'open');
});

test('7 David sloot de kaart van vandaag zelf: blijft dicht tot morgen', async () => {
  for (const st of ['gedaan', 'vervallen']) {
    const n = nepTabel([{ sleutel: 'facturen-' + D, status: st, gesloten_door: 'david' }]);
    const u = await K.bijwerken({ datum: D, n: 4, nuKort: NK, punten: n.punten() }, n.io);
    assert.ok(u.overgeslagen && !u.gezet && !u.heropend, st);
    assert.strictEqual(n.t.get('facturen-' + D).status, st);
    assert.strictEqual(n.log.length, 0);
  }
  const n = nepTabel([{ sleutel: 'facturen-' + D, status: 'gedaan', gesloten_door: 'david' }]);
  const u = await K.bijwerken({ datum: '2026-10-28', n: 4, nuKort: NK, punten: n.punten() }, n.io);
  assert.strictEqual(u.gezet, 'facturen-2026-10-28', 'volgende dag een nieuwe kaart');
});

test('8 David parkeerde een kaart (later): die wordt bijgewerkt, geen nieuwe dagkaart, later blijft', async () => {
  const n = nepTabel([{ sleutel: 'facturen-2026-10-25', status: 'later' }, { sleutel: 'facturen-2026-10-26', status: 'open' }]);
  const u = await K.bijwerken({ datum: D, n: 5, nuKort: NK, punten: n.punten() }, n.io);
  assert.strictEqual(u.gezet, 'facturen-2026-10-25');
  assert.ok(!n.t.has('facturen-' + D), 'geen nieuwe kaart naast de geparkeerde');
  assert.strictEqual(n.t.get('facturen-2026-10-25').status, 'later');
  assert.match(n.t.get('facturen-2026-10-25').titel, /5 facturen/);
  assert.strictEqual(n.t.get('facturen-2026-10-26').status, 'samengevoegd');
});

test('9 conflict (David drukte net) is geen crash; heropenen mislukt = niet schrijven', async () => {
  const n = nepTabel([{ sleutel: 'facturen-' + D, status: 'gedaan', gesloten_door: 'agent' }]);
  const io = Object.assign({}, n.io, { status: async () => ({ ok: false, fout: 'conflict', nu: 'open' }) });
  const u = await K.bijwerken({ datum: D, n: 2, nuKort: NK, punten: n.punten() }, io);
  assert.strictEqual(u.gezet, null);
  assert.strictEqual(u.fouten.length, 1);
});

test('10 teBeoordelen telt alleen status te_beoordelen', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE factuur (id TEXT, status TEXT); INSERT INTO factuur VALUES ('a','te_beoordelen'),('b','te_beoordelen'),('c','in_wachtrij'),('d','prive_archief')");
  assert.strictEqual(K.teBeoordelen({ db }), 2);
});

test('11 koppeling server.js, release en schrijvers met module', () => {
  const s = fs.readFileSync('server.js', 'utf8');
  assert.match(s, /require\(p\)[^\n]*\n[^\n]*\}\)\(\);\nconst facturenKaartStaat/, 'facturen-kaart.js optioneel geladen');
  assert.match(s, /SERVER_ECHT && rolPrimair\(\) && process\.env\.FACTUREN_KAART !== 'uit'/, 'alleen echte pod, primair, uit te zetten');
  assert.match(s, /facturenRondeBezig = null; if \(typeof facturenKaartPlan === 'function'\) facturenKaartPlan\(0\)/, 'na de Facturen-ronde');
  assert.match(s, /if \(req\.method !== 'GET' && r\.status === 200\) facturenKaartPlan\(3000\)/, 'na een schrijvende Facturen-route');
  assert.match(s, /handmatig: 'bank-ronde', bank: t\.sessie_kort, module: 'financien'/);
  assert.match(s, /handmatig: 'geld-briefing', module: 'financien'/);
  assert.strictEqual((s.match(/herkomst: potAfHerkomst\(maand\)/g) || []).length, 3);
  assert.strictEqual((fs.readFileSync('aix.js', 'utf8').match(/handmatig: 'aix-ronde'[^}]*module: 'ideeen'/g) || []).length, 2);
  assert.strictEqual((fs.readFileSync('ideeen.js', 'utf8').match(/handmatig: 'aix-bundel'[^}]*module: 'ideeen'/g) || []).length, 2);
  assert.match(fs.readFileSync('uitrol.sh', 'utf8'), /^RELEASE_OPTIONEEL="[^"]*\bfacturen-kaart\.js\b/m);
  assert.match(fs.readFileSync('Dockerfile', 'utf8'), /COPY facturen-kaart\.js \/app\/release-bootstrap\/facturen-kaart\.js/);
});
