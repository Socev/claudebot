'use strict';
// Toetst docplan-bezetting.js (wv2475, DocPlan › Bezetting) op verzonnen roosters (praktijken TG/GH, namen "Proef A".."Proef D"): norm en normbestand,
// feestdagen (Pasen berekend), halve dag, gedekt/ongedekt, weekregel met voorstel, nooit twee keer melden, terugkerend gat opnieuw, kaart sluit pas
// als alle punten af zijn, Davids "Is goed zo", oude feed = niets, alleen de ochtend, route (rol, primair, vinkje, goed zo).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const B = require('../docplan-bezetting.js');

const EIG = { soort: 'eigenaar', ingang: 'app', wie: 'david (toets)' };
const NU = Date.parse('2026-11-05T06:10:00Z');   // do 5-11-2026 07:10 NL
const VANDAAG = '2026-11-05';
const FEEDS = (uurOud, fout, nu) => ['TG', 'GH'].flatMap((pr) => ['rooster', 'rooster_open'].map((lr) => ({ pr, feed: 'rooster-' + pr.toLowerCase() + '-' + (lr === 'rooster' ? 'artsen' : 'gezocht'),
  leesregel: lr, actief: true, laatste_gelukt: new Date((nu || NU) - (uurOud || 2) * 3600e3).toISOString(), laatste_fout: fout && pr === 'GH' && lr === 'rooster' ? 'http 500' : null,
  agenda: lr === 'rooster_open' ? 'proef' + pr + '%40group.calendar.google.com' : null })));
const NORM_TG = { ma: 3, di: 3, wo: 3, do: 3, vr: 2 };   // "standaardweek": TG ma–do 3, vr 2; GH ma 3, di–vr 2

// rooster(wijzig) → bez-object voor 12 weken vanaf ma 2-11 met een standaardweek; wijzig[pr][datum] = { artsen, gezocht }
function rooster(wijzig, feeds) {
  const dagen = [];
  for (let i = 0; i < 7 * 13; i++) {
    const d = B.maandagVan('2026-11-02'), datum = new Date(Date.parse(d + 'T00:00:00Z') + i * 864e5).toISOString().slice(0, 10);
    const wd = new Date(datum + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const k = ['ma', 'di', 'wo', 'do', 'vr'][wd - 1];
    for (const pr of ['TG', 'GH']) {
      const std = pr === 'TG' ? NORM_TG[k] : (k === 'ma' ? 3 : 2);
      const w = (wijzig && wijzig[pr] && wijzig[pr][datum]) || {};
      const artsen = w.artsen !== undefined ? w.artsen : std;
      dagen.push({ pr, datum, artsen, gezocht: w.gezocht || 0, namen: Array.from({ length: Math.ceil(artsen) }, (_, j) => ({ naam: 'Proef ' + 'ABCD'[j], half: false })), niet_geteld: 0 });
    }
  }
  return { van: '2026-11-02', tot: '2027-02-01', feeds: feeds || FEEDS(), dagen, _std: !feeds };
}
function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bezetting-'));
  return { pad: path.join(dir, 'docplan.sqlite'), weg: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
// nep-Voor jou
function vj() {
  const kaarten = new Map(), log = [];
  return { kaarten, log, io: {
    zet: async (k) => { assert.ok(k.titel.length <= 90 && k.waarom.length <= 400, 'kaartgrenzen'); assert.ok(!/Proef [A-D]/.test(JSON.stringify(k)), 'geen namen op de kaart');
      kaarten.set(k.sleutel, { kaart: k, status: 'open' }); log.push('zet ' + k.sleutel); return { sleutel: k.sleutel }; },
    status: async (s, van, naar) => { const k = kaarten.get(s); if (!k || k.status !== van) return { ok: false }; k.status = naar; log.push(naar + ' ' + s); return { ok: true }; },
    lijst: async () => [...kaarten.entries()].map(([sleutel, k]) => ({ sleutel, status: k.status })),
  } };
}
async function ronde(db, bez, v, nu, extra) {
  // standaardfeeds verversen mee met de toetsklok (anders is een feed na een paar toetsdagen 'oud'); uurOud geldt dan t.o.v. de rondetijd
  const metFeeds = (b) => (b && b._std ? Object.assign({}, b, { feeds: FEEDS(2, false, nu || NU) }) : b && b.feeds && b._uur ? Object.assign({}, b, { feeds: FEEDS(b._uur, b._fout, nu || NU) }) : b);
  return B.ronde(Object.assign({ rpc: async (fn, body) => { assert.strictEqual(fn, 'sb_dienst_bezetting'); assert.ok(body.p_van <= body.p_tot); return metFeeds(typeof bez === 'function' ? bez() : bez); },
    db, io: v.io, nu: nu || NU, normTekst: null, nuKort: 'do 5-11 07:10', forceer: true }, extra || {}));
}

test('feestdagen: Pasen berekend, Koningsdag op zondag → zaterdag, Bevrijdingsdag alleen in lustrumjaren', () => {
  assert.strictEqual(B.pasen(2026), '2026-04-05');
  assert.strictEqual(B.pasen(2027), '2027-03-28');
  assert.strictEqual(B.pasen(2025), '2025-04-20');
  assert.strictEqual(B.feestdag('2027-03-29'), 'Tweede paasdag');
  assert.strictEqual(B.feestdag('2027-05-06'), 'Hemelvaartsdag');
  assert.strictEqual(B.feestdag('2027-05-17'), 'Tweede pinksterdag');
  assert.strictEqual(B.feestdag('2025-04-26'), 'Koningsdag');   // 27-4-2025 is zondag
  assert.strictEqual(B.feestdag('2030-05-05'), 'Bevrijdingsdag');
  assert.strictEqual(B.feestdag('2026-05-05'), null);
  assert.strictEqual(B.feestdag('2026-12-25'), 'Eerste kerstdag');
});

test('norm: standaard TG (ma altijd 3, minstens 3 van 5 dagen 3, liefst 4) en een kapot normbestand valt terug met de fout', () => {
  const t = B.normTekst(B.NORM_STANDAARD.praktijken.TG).map((r) => r.tekst);
  assert.deepStrictEqual(t, ['Maandag altijd 3 artsen', 'Di, wo, do, vr minstens 2 artsen', 'Minstens 3 van de 5 dagen 3 artsen', 'Liefst 4 van de 5 dagen 3 artsen']);
  const k = B.normLees('{kapot');
  assert.strictEqual(k.norm, B.NORM_STANDAARD); assert.match(k.fout, /geen geldige JSON/);
  const z = B.normLees(JSON.stringify({ praktijken: { TG: { dag_min: { ma: 3, di: 3, wo: 3, do: 3, vr: 2 }, week: [] }, GH: { dag_min: { ma: 3, di: 2, wo: 2, do: 2, vr: 2 }, week: [{ artsen: 3, dagen: 9, soort: 'hard' }] } } }));
  assert.match(z.fout, /GH weekregel/);
  const g = B.normLees(JSON.stringify({ vooruit_weken: 8, praktijken: { TG: { dag_min: { ma: 3, di: 3, wo: 3, do: 3, vr: 2 }, week: [] }, GH: { dag_min: { ma: 3, di: 2, wo: 2, do: 2, vr: 2 }, week: [], voorstel: true } } }));
  assert.strictEqual(g.fout, null); assert.strictEqual(g.norm.vooruit_weken, 8); assert.strictEqual(g.norm.praktijken.TG.dag_min.di, 3);
});

test('dagregel: maandag met 2 = rood met voorstel 1; gedekt door GEZOCHT = oranje; feestdag = grijs en telt niet', () => {
  const np = B.NORM_STANDAARD.praktijken.TG;
  const map = (o) => new Map(Object.entries(o).map(([d, x]) => [d, Object.assign({ namen: [] }, x)]));
  const std = { '2027-01-12': { artsen: 3 }, '2027-01-13': { artsen: 3 }, '2027-01-14': { artsen: 3 }, '2027-01-15': { artsen: 2 } };
  let w = B.week('TG', '2027-01-11', map(Object.assign({ '2027-01-11': { artsen: 2 } }, std)), np, { vandaag: VANDAAG, tot: '2027-02-01' });
  assert.strictEqual(w.dagen[0].kleur, 'rood'); assert.deepStrictEqual(w.dagen[0].voorstel, { aantal: 1, soort: 'hard' });
  assert.deepStrictEqual(w.meldbaar.map((p) => p.sleutel), ['dag:2027-01-11']);
  w = B.week('TG', '2027-01-11', map(Object.assign({ '2027-01-11': { artsen: 2, gezocht: 1 } }, std)), np, { vandaag: VANDAAG, tot: '2027-02-01' });
  assert.strictEqual(w.dagen[0].kleur, 'oranje'); assert.strictEqual(w.dagen[0].voorstel, null); assert.strictEqual(w.meldbaar.length, 0);
  // 2e paasdag 2027 (ma 29-3) op 0 artsen: grijs, geen punt; weekregel over 4 werkdagen (di–do 3 = 3 van 4, wens 4 → min(4,4) niet gehaald = geel)
  w = B.week('TG', '2027-03-29', map({ '2027-03-30': { artsen: 3 }, '2027-03-31': { artsen: 3 }, '2027-04-01': { artsen: 3 }, '2027-04-02': { artsen: 2 } }), np, { vandaag: VANDAAG, tot: '2027-12-31' });
  assert.strictEqual(w.dagen[0].kleur, 'grijs'); assert.strictEqual(w.dagen[0].feestdag, 'Tweede paasdag');
  assert.strictEqual(w.meldbaar.length, 0); assert.strictEqual(w.regels[0].ok, true);
  assert.strictEqual(w.kleur, 'geel'); assert.strictEqual(w.dagen[4].voorstel.soort, 'wens');
});

test('weekregel: 2 van 5 dagen met 3 = één weekpunt met voorstel op de dag met het kleinste tekort (ma–do vóór vr); halve dag telt 0,5', () => {
  const np = B.NORM_STANDAARD.praktijken.TG;
  const map = new Map(Object.entries({ '2027-01-11': { artsen: 3 }, '2027-01-12': { artsen: 3 }, '2027-01-13': { artsen: 2.5 }, '2027-01-14': { artsen: 2 }, '2027-01-15': { artsen: 2 } }).map(([d, x]) => [d, Object.assign({ namen: [] }, x)]));
  const w = B.week('TG', '2027-01-11', map, np, { vandaag: VANDAAG, tot: '2027-02-01' });
  assert.deepStrictEqual(w.meldbaar.map((p) => [p.sleutel, p.dagen]), [['week:2027-01-11', ['2027-01-13']]]);
  assert.deepStrictEqual(w.dagen[2].voorstel, { aantal: 0.5, soort: 'hard' });
  assert.strictEqual(w.dagen[2].kleur, 'rood');
  assert.strictEqual(w.dagen[3].voorstel.soort, 'wens');   // de wens (4 van 5) vraagt er nog één bij: do vóór vr
  assert.strictEqual(w.dagen[4].voorstel, null);
  assert.match(w.regels[0].tekst, /2 van 5 dagen 3 artsen \(minstens 3\)/);
});

test('ronde: meldt een ongedekt gat één keer, nooit twee keer; GEZOCHT dekt = opgelost en kaart dicht; terugkerend gat = nieuwe kaart', async () => {
  const t = tmpDb(); const db = new DatabaseSync(t.pad); const v = vj();
  try {
    const gat = { TG: { '2027-01-11': { artsen: 2 } } };
    let x = await ronde(db, rooster(gat), v);
    assert.strictEqual(x.ok, true); assert.strictEqual(x.nieuw, 1);
    assert.deepStrictEqual([...v.kaarten.keys()], ['docplan-bezetting:TG:2027-01-11:1']);
    const k = v.kaarten.get('docplan-bezetting:TG:2027-01-11:1').kaart;
    assert.match(k.titel, /^Tolgaarde week 2 — 1 dag onderbezet/);
    assert.match(k.waarom, /ma 11 jan: 2 van 3 artsen/);
    assert.deepStrictEqual(k.herkomst.doel, { scherm: 'docplan', focus: 'bezetting:TG-2027-01-11' });
    x = await ronde(db, rooster(gat), v, NU + 864e5);
    assert.strictEqual(x.nieuw, 0, 'nooit twee keer');
    x = await ronde(db, rooster({ TG: { '2027-01-11': { artsen: 2, gezocht: 1 } } }), v, NU + 2 * 864e5);
    assert.strictEqual(x.opgelost, 1); assert.strictEqual(x.gesloten, 1);
    assert.strictEqual(v.kaarten.get('docplan-bezetting:TG:2027-01-11:1').status, 'gedaan');
    x = await ronde(db, rooster(gat), v, NU + 3 * 864e5);   // het verzoek is weer weg
    assert.strictEqual(x.nieuw, 1);
    assert.ok(v.kaarten.has('docplan-bezetting:TG:2027-01-11:2'), 'terugkerend gat op een eigen kaart (volgnummer 2)');
  } finally { db.close(); t.weg(); }
});

test('ronde: kaart met twee punten sluit pas als beide af zijn; een nieuw gat later in dezelfde week = eigen kaart, oude niet uitgebreid', async () => {
  const t = tmpDb(); const db = new DatabaseSync(t.pad); const v = vj();
  try {
    // ma 2 (dagregel) én di/wo/do 2 → weekregel: 1 van 5 dagen 3 → punten dag:ma + week
    const w2 = { TG: { '2027-01-11': { artsen: 2 }, '2027-01-12': { artsen: 2 }, '2027-01-13': { artsen: 2 }, '2027-01-14': { artsen: 2 } } };
    let x = await ronde(db, rooster(w2), v);
    assert.strictEqual(x.nieuw, 1);
    const punten = JSON.parse(db.prepare("SELECT punten FROM bezetting_kaart WHERE sleutel = 'docplan-bezetting:TG:2027-01-11:1'").get().punten);
    assert.deepStrictEqual(punten.sort(), ['dag:2027-01-11', 'week:2027-01-11']);
    // maandag aangevuld, week nog niet: kaart blijft open
    x = await ronde(db, rooster({ TG: { '2027-01-12': { artsen: 2 }, '2027-01-13': { artsen: 2 }, '2027-01-14': { artsen: 2 } } }), v, NU + 864e5);
    assert.strictEqual(x.opgelost, 1); assert.strictEqual(x.gesloten, 0);
    assert.strictEqual(v.kaarten.get('docplan-bezetting:TG:2027-01-11:1').status, 'open');
    // nu valt ook vrijdag uit (1 < 2): nieuw dagpunt, eigen kaart :2
    x = await ronde(db, rooster({ TG: { '2027-01-12': { artsen: 2 }, '2027-01-13': { artsen: 2 }, '2027-01-14': { artsen: 2 }, '2027-01-15': { artsen: 1 } } }), v, NU + 2 * 864e5);
    assert.strictEqual(x.nieuw, 1); assert.ok(v.kaarten.has('docplan-bezetting:TG:2027-01-11:2'));
    assert.deepStrictEqual(JSON.parse(db.prepare("SELECT punten FROM bezetting_kaart WHERE sleutel = 'docplan-bezetting:TG:2027-01-11:1'").get().punten).sort(), ['dag:2027-01-11', 'week:2027-01-11']);
    // alles weer op norm: beide kaarten dicht
    x = await ronde(db, rooster({}), v, NU + 3 * 864e5);
    assert.strictEqual(x.gesloten, 2);
  } finally { db.close(); t.weg(); }
});

test('ronde: oude feed, feedfout of geen antwoord = niets melden en niets sluiten; tweede mislukte ochtend = één keer box', async () => {
  const t = tmpDb(); const db = new DatabaseSync(t.pad); const v = vj();
  try {
    const gat = { TG: { '2027-01-11': { artsen: 2 } } };
    await ronde(db, rooster(gat), v);
    assert.strictEqual(v.kaarten.size, 1);
    let x = await ronde(db, Object.assign(rooster({}, FEEDS(40)), { _uur: 40 }), v, NU + 864e5);   // 40 uur oud
    assert.strictEqual(x.ok, false); assert.match(x.reden, /ouder dan 36 uur/); assert.strictEqual(x.box, false);
    assert.strictEqual(v.kaarten.get('docplan-bezetting:TG:2027-01-11:1').status, 'open', 'niets gesloten');
    x = await ronde(db, Object.assign(rooster({}, FEEDS(2, true)), { _uur: 2, _fout: true }), v, NU + 2 * 864e5);
    assert.strictEqual(x.ok, false); assert.match(x.reden, /gaf een fout/); assert.strictEqual(x.box, true);
    x = await ronde(db, () => { throw new Error('weg'); }, v, NU + 3 * 864e5);
    assert.strictEqual(x.ok, false); assert.strictEqual(x.box, false, 'box maar één keer');
    assert.strictEqual(v.kaarten.size, 1);
  } finally { db.close(); t.weg(); }
});

test('ronde: alleen in de ochtend en één keer per dag', async () => {
  const t = tmpDb(); const db = new DatabaseSync(t.pad); const v = vj();
  try {
    let x = await ronde(db, rooster({ TG: { '2027-01-11': { artsen: 2 } } }), v, Date.parse('2026-11-05T17:00:00Z'), { forceer: false });
    assert.deepStrictEqual([x.gedaan, x.reden], [false, 'alleen in de ochtendronde']);
    x = await ronde(db, rooster({ TG: { '2027-01-11': { artsen: 2 } } }), v, NU, { forceer: false });
    assert.strictEqual(x.gedaan, true); assert.strictEqual(x.nieuw, 1);
    x = await ronde(db, rooster({ TG: { '2027-01-18': { artsen: 2 } } }), v, NU + 3600e3, { forceer: false });
    assert.deepStrictEqual([x.gedaan, x.reden], [false, 'vandaag al gedaan']);
  } finally { db.close(); t.weg(); }
});

test('ronde: alleen binnen 10 weken vooruit; standaardrooster geeft niets', async () => {
  const t = tmpDb(); const db = new DatabaseSync(t.pad); const v = vj();
  try {
    let x = await ronde(db, rooster({}), v);
    assert.strictEqual(x.nieuw, 0);
    x = await ronde(db, rooster({ TG: { '2027-01-25': { artsen: 2 } } }), v, NU + 864e5);   // > 10 weken na 5-11 (14-1)
    assert.strictEqual(x.nieuw, 0);
  } finally { db.close(); t.weg(); }
});

function route(dbPad, bez) {
  const v = vj();
  const r = B.maak({ rpc: async () => bez, openDb: () => (dbPad ? new DatabaseSync(dbPad) : null), normTekst: () => null, io: v.io, nuKort: () => 'x' });
  return { r, v };
}
const req = (o) => Object.assign({ methode: 'GET', pad: '/app/facturen/bezetting', rol: EIG, primair: true, nu: NU }, o);

test('route: alleen de eigenaar via de app op de primaire kant; onbekende paden 404', async () => {
  const { r } = route(null, rooster({}));
  assert.strictEqual((await r.app(req({ rol: { soort: 'praktijkmanager', ingang: 'fac' } }))).status, 403);
  assert.strictEqual((await r.app(req({ rol: { soort: 'eigenaar', ingang: 'fac' } }))).status, 403);
  assert.strictEqual((await r.app(req({ primair: false }))).status, 409);
  assert.strictEqual((await r.app(req({ pad: '/app/facturen/bezetting/x' }))).status, 404);
  assert.strictEqual((await r.app(req({ methode: 'POST', pad: '/app/facturen/bezetting/2027-01' }))).status, 404);
  assert.strictEqual((await r.app(req({ pad: '/app/facturen/bezetting/2031-01' }))).status, 400);
});

test('route GET: tegel 12 weken met kleuren, link per toekomstige dag (src = GEZOCHT-agenda), maand = alle weken van de maand', async () => {
  const t = tmpDb();
  try {
    const { r } = route(t.pad, rooster({ TG: { '2027-01-11': { artsen: 2 } } }));
    let x = await r.app(req());
    assert.strictEqual(x.status, 200); assert.strictEqual(x.j.weken, 12); assert.strictEqual(x.j.van, '2026-11-02');
    const tg = x.j.praktijken[0];
    assert.strictEqual(tg.code, 'TG'); assert.strictEqual(tg.zonder_verzoek, 1); assert.strictEqual(tg.agenda, undefined);
    const ma = tg.weken.find((w) => w.maandag === '2027-01-11').dagen[0];
    assert.strictEqual(ma.kleur, 'rood');
    assert.strictEqual(ma.link, 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=GEZOCHT&dates=20270111/20270112&ctz=Europe%2FAmsterdam&src=proefTG%40group.calendar.google.com');
    assert.strictEqual(tg.weken[0].dagen[0].link, null, 'verleden: geen link');
    assert.strictEqual(x.j.feeds.ok, true);
    x = await r.app(req({ pad: '/app/facturen/bezetting/2027-02' }));
    assert.strictEqual(x.j.maand, '2027-02'); assert.strictEqual(x.j.van, '2027-02-01'); assert.strictEqual(x.j.weken, 4);
    x = await r.app(req({ pad: '/app/facturen/bezetting/2026-12' }));
    assert.strictEqual(x.j.van, '2026-11-30'); assert.strictEqual(x.j.weken, 5);
  } finally { t.weg(); }
});

test('route POST: vinkje alleen op een werkdag vanaf morgen; "Is goed zo" sluit de kaart en meldt het punt nooit meer', async () => {
  const t = tmpDb();
  try {
    const bez = rooster({ TG: { '2027-01-11': { artsen: 2 } } });
    const { r, v } = route(t.pad, bez);
    const db = new DatabaseSync(t.pad);
    try { await ronde(db, bez, v); } finally { db.close(); }
    assert.strictEqual(v.kaarten.size, 1);
    const post = (d) => r.app(req({ methode: 'POST', d }));
    assert.strictEqual((await post({ handeling: 'vink', pr: 'TG', datum: VANDAAG })).status, 400);
    assert.strictEqual((await post({ handeling: 'vink', pr: 'TG', datum: '2027-01-16' })).status, 400);   // zaterdag
    assert.strictEqual((await post({ handeling: 'vink', pr: 'TG', datum: '2026-12-25' })).status, 400);   // kerst
    assert.strictEqual((await post({ handeling: 'vink', pr: 'XX', datum: '2027-01-11' })).status, 400);
    assert.strictEqual((await post({ handeling: 'vink', pr: 'TG', datum: '2027-01-11' })).status, 200);
    let x = await r.app(req());
    assert.strictEqual(x.j.praktijken[0].weken.find((w) => w.maandag === '2027-01-11').dagen[0].gekozen, true);
    assert.strictEqual(x.j.praktijken[0].weken.find((w) => w.maandag === '2027-01-11').dagen[0].gemeld, true);
    assert.strictEqual((await post({ handeling: 'ontvink', pr: 'TG', datum: '2027-01-11' })).status, 200);
    assert.strictEqual((await post({ handeling: 'goed_zo', pr: 'TG', sleutel: 'week:2027-01-12' })).status, 400);   // geen maandag
    assert.strictEqual((await post({ handeling: 'goed_zo', pr: 'TG', sleutel: 'dag:2027-01-11' })).status, 200);
    assert.deepStrictEqual(await r.naGoedZo(), ['docplan-bezetting:TG:2027-01-11:1']);
    assert.strictEqual(v.kaarten.get('docplan-bezetting:TG:2027-01-11:1').status, 'gedaan');
    x = await r.app(req());
    const ma = x.j.praktijken[0].weken.find((w) => w.maandag === '2027-01-11').dagen[0];
    assert.strictEqual(ma.goed_zo, true); assert.strictEqual(x.j.praktijken[0].zonder_verzoek, 0);
    const db2 = new DatabaseSync(t.pad);
    try { const y = await ronde(db2, bez, v, NU + 864e5); assert.strictEqual(y.nieuw, 0, 'goed zo = nooit meer'); } finally { db2.close(); }
    assert.strictEqual((await post({ handeling: 'goed_zo_weg', pr: 'TG', sleutel: 'dag:2027-01-11' })).status, 200);
    const db3 = new DatabaseSync(t.pad);
    try { const y = await ronde(db3, bez, v, NU + 2 * 864e5); assert.strictEqual(y.nieuw, 1, 'goed zo teruggedraaid = weer melden'); } finally { db3.close(); }
  } finally { t.weg(); }
});

test('review: geen Google-link zonder geldige GEZOCHT-agenda; inactieve oude feed blokkeert niets; norm alleen hele getallen; GH bewust zonder weekregel', () => {
  assert.strictEqual(B.googleLink(null, '2027-01-11'), null);
  assert.strictEqual(B.googleLink('kapot%E0', '2027-01-11'), null);
  assert.strictEqual(B.googleLink('a b', '2027-01-11'), null);
  const oud = FEEDS().concat([{ pr: 'TG', feed: 'rooster-tg-oud', leesregel: 'rooster', actief: false, laatste_gelukt: '2025-01-01T00:00:00Z', laatste_fout: 'weg', agenda: null }]);
  assert.strictEqual(B.feedsOk(oud, NU, 36).ok, true);
  const zonder = FEEDS().filter((f) => !(f.pr === 'GH' && f.leesregel === 'rooster_open'));
  assert.match(B.feedsOk(zonder, NU, 36).reden, /geen actieve roosterfeed GH rooster_open/);
  assert.match(B.normLees(JSON.stringify({ praktijken: { TG: { dag_min: { ma: 2.5, di: 3, wo: 3, do: 3, vr: 2 }, week: [] }, GH: { dag_min: { ma: 3, di: 2, wo: 2, do: 2, vr: 2 }, week: [] } } })).fout, /TG dag_min\.ma/);
  assert.deepStrictEqual(B.NORM_STANDAARD.praktijken.GH.week, []);
  assert.strictEqual(B.NORM_STANDAARD.praktijken.GH.voorstel, true);
  // GH-week met maar 1 dag 3 artsen: op norm (alleen dagregels), groen
  const np = B.NORM_STANDAARD.praktijken.GH;
  const map = new Map(['2027-01-11', '2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15'].map((d, i) => [d, { artsen: i === 0 ? 3 : 2, namen: [] }]));
  assert.strictEqual(B.week('GH', '2027-01-11', map, np, { vandaag: VANDAAG, tot: '2027-02-01' }).kleur, 'groen');
});

// ── wv2486: vinkje zet zelf een GEZOCHT-item (via o.gezocht = nep-n8n); alleen eigen items weg ──
function routeG(dbPad, bez, antwoord) {
  const v = vj(), roep = [];
  const r = B.maak({ rpc: async () => bez, openDb: () => (dbPad ? new DatabaseSync(dbPad) : null), normTekst: () => null, io: v.io, nuKort: () => 'x',
    gezocht: async (body) => { roep.push(body); return antwoord(body, roep.length); } });
  return { r, v, roep };
}
const postG = (r, d) => r.app(req({ methode: 'POST', d }));
const dagVan = (x, maandag, i) => x.j.praktijken[0].weken.find((w) => w.maandag === maandag).dagen[i || 0];

test('wv2486 vink: precies één schrijfaanroep met praktijk en datum; tweede vink geen tweede; GET = op de waarneemsite, geen link', async () => {
  const t = tmpDb();
  try {
    const { r, roep } = routeG(t.pad, rooster({}), () => ({ ok: true, event_id: 'abc123proef' }));
    const x = await postG(r, { handeling: 'vink', pr: 'TG', datum: '2027-01-11' });
    assert.strictEqual(x.status, 200); assert.strictEqual(x.j.op_site, true);
    assert.deepStrictEqual(roep, [{ actie: 'plaatsen', pr: 'TG', datum: '2027-01-11' }], 'alleen actie, pr en datum; geen titel of agenda');
    assert.strictEqual((await postG(r, { handeling: 'vink', pr: 'TG', datum: '2027-01-11' })).status, 200);
    assert.strictEqual(roep.length, 1, 'al gezet = geen tweede aanroep');
    const g = await r.app(req());
    const d = dagVan(g, '2027-01-11');
    assert.strictEqual(d.gekozen, true); assert.strictEqual(d.op_site, true); assert.strictEqual(d.link, null); assert.strictEqual(g.j.schrijven, 'zelf');
  } finally { t.weg(); }
});

test('wv2486 ontvink: alleen het eigen item weg (opgeslagen event-id); vinkje zonder item = geen aanroep; mislukt weghalen = vinkje blijft', async () => {
  const t = tmpDb();
  try {
    let weg = { ok: true };
    const { r, roep } = routeG(t.pad, rooster({}), (b) => (b.actie === 'plaatsen' ? { ok: true, event_id: 'eigen' + b.datum.replace(/-/g, '') } : weg));
    await postG(r, { handeling: 'vink', pr: 'TG', datum: '2027-01-11' });
    weg = { ok: false, fout: 'weghalen mislukt (status 500)' };
    let x = await postG(r, { handeling: 'ontvink', pr: 'TG', datum: '2027-01-11' });
    assert.strictEqual(x.status, 502);
    assert.deepStrictEqual(roep[1], { actie: 'weghalen', pr: 'TG', datum: '2027-01-11', event_id: 'eigen20270111' });
    assert.strictEqual(dagVan(await r.app(req()), '2027-01-11').gekozen, true, 'mislukt = vinkje blijft staan');
    weg = { ok: true };
    x = await postG(r, { handeling: 'ontvink', pr: 'TG', datum: '2027-01-11' });
    assert.strictEqual(x.status, 200); assert.strictEqual(roep.length, 3);
    assert.strictEqual(dagVan(await r.app(req()), '2027-01-11').gekozen, false);
    // ontvink van een dag zonder eigen item (nooit aangevinkt): geen aanroep naar de agenda
    assert.strictEqual((await postG(r, { handeling: 'ontvink', pr: 'TG', datum: '2027-01-12' })).status, 200);
    assert.strictEqual(roep.length, 3, 'zonder eigen event-id nooit weghalen');
  } finally { t.weg(); }
});

test('wv2486 item van een ander: n8n weigert (niet_eigen) → de pod raakt het niet nog eens en vergeet alleen het vinkje', async () => {
  const t = tmpDb();
  try {
    const { r, roep } = routeG(t.pad, rooster({}), (b) => (b.actie === 'plaatsen' ? { ok: true, event_id: 'xyz987proef' } : { ok: false, fout: 'niet_eigen' }));
    await postG(r, { handeling: 'vink', pr: 'TG', datum: '2027-01-13' });
    const x = await postG(r, { handeling: 'ontvink', pr: 'TG', datum: '2027-01-13' });
    assert.strictEqual(x.status, 200); assert.ok(/zelf weg/.test(x.j.let_op));
    assert.strictEqual(roep.filter((b) => b.actie === 'weghalen').length, 1);
    assert.strictEqual(dagVan(await r.app(req()), '2027-01-11', 2).gekozen, false);
  } finally { t.weg(); }
});

test('wv2486 feestdag, weekend, vandaag en verleden: geweigerd zonder één schrijfaanroep; Groenhouten zonder schrijfrecht = link blijft', async () => {
  const t = tmpDb();
  try {
    const { r, roep } = routeG(t.pad, rooster({}), (b) => (b.pr === 'GH' ? { ok: false, fout: 'geen_schrijfrecht', status: 403 } : { ok: true, event_id: 'abc123proef' }));
    for (const datum of ['2026-12-25', '2027-01-16', '2027-01-17', VANDAAG, '2026-11-02', '2027-12-30'])
      assert.strictEqual((await postG(r, { handeling: 'vink', pr: 'TG', datum })).status, 400, datum);
    for (const datum of ['2026-12-25', VANDAAG]) assert.strictEqual((await postG(r, { handeling: 'ontvink', pr: 'TG', datum })).status, 400, 'ontvink ' + datum);
    assert.strictEqual(roep.length, 0, 'geweigerd = geen aanroep');
    const x = await postG(r, { handeling: 'vink', pr: 'GH', datum: '2027-01-11' });
    assert.strictEqual(x.status, 200); assert.strictEqual(x.j.op_site, false); assert.ok(/Groenhouten/.test(x.j.schrijf_fout));
    const g = await r.app(req());
    const gh = g.j.praktijken[1].weken.find((w) => w.maandag === '2027-01-11').dagen[0];
    assert.strictEqual(gh.gekozen, true); assert.strictEqual(gh.op_site, false); assert.ok(gh.link && gh.link.includes('proefGH')); assert.ok(gh.schrijf_fout);
    // n8n onbereikbaar → stand fout, link blijft, opnieuw vinken probeert opnieuw
    const { r: r2, roep: roep2 } = routeG(t.pad, rooster({}), () => { throw new Error('n8n weg'); });
    const y = await postG(r2, { handeling: 'vink', pr: 'TG', datum: '2027-01-14' });
    assert.strictEqual(y.status, 200); assert.strictEqual(y.j.op_site, false); assert.ok(/lukte niet/.test(y.j.schrijf_fout));
    await postG(r2, { handeling: 'vink', pr: 'TG', datum: '2027-01-14' });
    assert.strictEqual(roep2.length, 2);
  } finally { t.weg(); }
});

test('wv2486 twee tikken tegelijk op dezelfde dag: de tweede krijgt 409, één schrijfaanroep; zonder o.gezocht blijft het de link', async () => {
  const t = tmpDb();
  try {
    let los; const wacht = new Promise((res) => { los = res; });
    const { r, roep } = routeG(t.pad, rooster({}), async () => { await wacht; return { ok: true, event_id: 'abc123proef' }; });
    const p1 = postG(r, { handeling: 'vink', pr: 'TG', datum: '2027-01-11' });
    await new Promise((res) => setTimeout(res, 0));
    const x2 = await postG(r, { handeling: 'vink', pr: 'TG', datum: '2027-01-11' });
    assert.strictEqual(x2.status, 409);
    los(); assert.strictEqual((await p1).status, 200); assert.strictEqual(roep.length, 1);
    const { r: r0 } = route(t.pad, rooster({}));
    const g = await r0.app(req());
    assert.strictEqual(g.j.schrijven, 'link');
    const x = await r0.app(req({ methode: 'POST', d: { handeling: 'vink', pr: 'TG', datum: '2027-01-15' } }));
    assert.strictEqual(x.j.op_site, false); assert.strictEqual(x.j.schrijf_fout, null);
  } finally { t.weg(); }
});

test('wv2486 schema: oude bezetting_keuze (zonder kolommen) krijgt event_id/stand/fout/bijgewerkt, herhaalbaar', () => {
  const t = tmpDb();
  try {
    const db = new DatabaseSync(t.pad);
    db.exec("CREATE TABLE bezetting_keuze (pr TEXT NOT NULL CHECK (pr IN ('TG','GH')), datum TEXT NOT NULL, op TEXT NOT NULL, door TEXT NOT NULL, PRIMARY KEY (pr, datum))");
    db.prepare("INSERT INTO bezetting_keuze VALUES ('TG','2027-01-11','x','david')").run();
    B.schema(db); B.schema(db);
    const kol = db.prepare("SELECT name FROM pragma_table_info('bezetting_keuze')").all().map((r) => r.name);
    for (const k of ['event_id', 'stand', 'fout', 'bijgewerkt']) assert.ok(kol.includes(k), k);
    assert.strictEqual(B.staat(db).keuzeRij.TG.get('2027-01-11').event_id, null);
    db.close();
  } finally { t.weg(); }
});

test('wv2486 review MOET 2: antwoord van plaatsen verloren (stand fout) → ontvinken haalt op datum weg (zonder id); geen_recht → geen aanroep', async () => {
  const t = tmpDb();
  try {
    let n = 0;
    const { r, roep } = routeG(t.pad, rooster({}), (b) => { n++; if (b.actie === 'plaatsen' && b.pr === 'TG') throw new Error('time-out'); return b.pr === 'GH' ? { ok: false, fout: 'geen_schrijfrecht' } : { ok: true, weg: 1 }; });
    await postG(r, { handeling: 'vink', pr: 'TG', datum: '2027-01-11' });
    const x = await postG(r, { handeling: 'ontvink', pr: 'TG', datum: '2027-01-11' });
    assert.strictEqual(x.status, 200);
    assert.deepStrictEqual(roep[1], { actie: 'weghalen', pr: 'TG', datum: '2027-01-11' }, 'op datum, zonder id');
    await postG(r, { handeling: 'vink', pr: 'GH', datum: '2027-01-11' });
    await postG(r, { handeling: 'ontvink', pr: 'GH', datum: '2027-01-11' });
    assert.strictEqual(roep.filter((b) => b.pr === 'GH').length, 1, 'GH zonder schrijfrecht: alleen de ene plaatspoging, geen weghalen');
  } finally { t.weg(); }
});
