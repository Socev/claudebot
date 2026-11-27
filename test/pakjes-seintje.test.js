'use strict';
// wv4154 (2C58): seintjes per pakje (tijdvak bekend, aangekomen), hooguit twee per pakje, 07–22 u, nooit dubbel; ochtendregel met tijdvak.
// Alle pakjes, winkels en tijden zijn verzonnen. Draai: node test/pakjes-seintje.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const PS = require('../pakjes-seintje.js');
const AN = require('../app-nieuws.js');

const T = (s) => Date.parse(s);            // vaste tijden in UTC; november = CET (UTC+1)
const OCHTEND = T('2026-11-27T09:00:00Z'); // 10:00 NL
const BEGONNEN = { versie: 1, begonnen: '2026-11-20T08:00:00.000Z', pakjes: {} };
const pk = (o) => Object.assign({ id: 'a1a1a1a1a1a1', winkel: 'Verzonnen Winkel', vervoerder: 'DHL', stand: 'onderweg', verwacht_dag: null, verwacht_van: null, verwacht_tot: null,
  bezorgd_op: null, verborgen: false, handmatig: false, stand_detail: null }, o);
const vandaag1315 = pk({ stand: 'vandaag', verwacht_dag: '2026-11-27', verwacht_van: '13:00', verwacht_tot: '15:00' });

test('verzonnen pakje "vandaag 13–15": één regel, tweede ronde niets', function () {
  const a = PS.plan({ body: { lopend: [vandaag1315] }, staat: BEGONNEN, nu: OCHTEND });
  assert.strictEqual(a.regels.length, 1);
  assert.strictEqual(a.regels[0].soort, 'tijdvak');
  assert.strictEqual(PS.tekst(a.regels), '📦 Pakje van Verzonnen Winkel komt vandaag tussen 13:00 en 15:00.');
  const b = PS.plan({ body: { lopend: [vandaag1315] }, staat: a.staat, nu: OCHTEND + 15 * 60000 });
  assert.strictEqual(b.regels.length, 0, 'geen herhaling');
});
test('dag zonder pakje: geen seintje en geen ochtendregel', function () {
  const a = PS.plan({ body: { lopend: [pk({ stand: 'onderweg', verwacht_dag: '2026-11-29' })] }, staat: BEGONNEN, nu: OCHTEND });
  assert.strictEqual(a.regels.length, 0);
  assert.deepStrictEqual(AN.pakjesAanmeldingen({}, { lopend: [] }, 'ochtend', '2026-11-27', OCHTEND), []);
});
test('ochtendregel noemt het tijdvak; zonder tijdvak zoals vroeger', function () {
  const m = AN.pakjesAanmeldingen({}, { lopend: [vandaag1315, pk({ id: 'b2b2b2b2b2b2', winkel: 'Nepshop', stand: 'vandaag', verwacht_dag: '2026-11-27' })] }, 'ochtend', '2026-11-27', OCHTEND);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].tekst, 'Vandaag verwacht: Verzonnen Winkel (13:00–15:00), Nepshop.');
  const m2 = AN.pakjesAanmeldingen({}, { lopend: [pk({ stand: 'vandaag', verwacht_dag: '2026-11-27', verwacht_van: '15:00', verwacht_tot: '13:00' })] }, 'ochtend', '2026-11-27', OCHTEND);
  assert.strictEqual(m2[0].tekst, 'Vandaag verwacht: Verzonnen Winkel.', 'onmogelijk tijdvak weggelaten');
});
test('buiten 07–22 wacht het: 23:30 bezorgd → niets, 07:05 → één aankomst', function () {
  const bez = pk({ stand: 'bezorgd', bezorgd_op: '2026-11-27T22:20:00.000Z', stand_detail: 'Bij de buren' });   // 23:20 NL
  const a = PS.plan({ body: { lopend: [bez] }, staat: BEGONNEN, nu: T('2026-11-27T22:30:00Z') });
  assert.strictEqual(a.regels.length, 0);
  assert.strictEqual(a.buiten_uren, 1);
  const b = PS.plan({ body: { lopend: [bez] }, staat: a.staat, nu: T('2026-11-28T06:05:00Z') });   // 07:05 NL
  assert.strictEqual(PS.tekst(b.regels), '📦 Pakje van Verzonnen Winkel is bezorgd. Bij de buren.');
  const c = PS.plan({ body: { lopend: [bez] }, staat: b.staat, nu: T('2026-11-28T06:20:00Z') });
  assert.strictEqual(c.regels.length, 0);
});
test('21:59 wel, 22:00 niet; 06:59 niet', function () {
  const p = pk({ stand: 'afhaalpunt' });
  assert.strictEqual(PS.plan({ body: { lopend: [p] }, staat: BEGONNEN, nu: T('2026-11-27T20:59:00Z') }).regels.length, 1);
  assert.strictEqual(PS.plan({ body: { lopend: [p] }, staat: BEGONNEN, nu: T('2026-11-27T21:00:00Z') }).regels.length, 0);
  assert.strictEqual(PS.plan({ body: { lopend: [p] }, staat: BEGONNEN, nu: T('2026-11-27T05:59:00Z') }).regels.length, 0);
});
test('hooguit twee per pakje: tijdvak, dan afhaalpunt, dan bezorgd = geen derde', function () {
  const a = PS.plan({ body: { lopend: [vandaag1315] }, staat: BEGONNEN, nu: OCHTEND });
  const b = PS.plan({ body: { lopend: [pk({ stand: 'afhaalpunt' })] }, staat: a.staat, nu: OCHTEND + 3600000 });
  assert.strictEqual(b.regels.length, 1); assert.strictEqual(b.regels[0].soort, 'aankomst');
  const c = PS.plan({ body: { lopend: [pk({ stand: 'bezorgd', bezorgd_op: new Date(OCHTEND + 7200000).toISOString() })] }, staat: b.staat, nu: OCHTEND + 7300000 });
  assert.strictEqual(c.regels.length, 0);
});
test('tijdvak en aankomst in dezelfde ronde: alleen aankomst, en daarna geen tijdvak meer', function () {
  const p = pk({ stand: 'bezorgd', bezorgd_op: new Date(OCHTEND - 60000).toISOString() });
  const a = PS.plan({ body: { lopend: [p, Object.assign({}, vandaag1315, { id: 'c3c3c3c3c3c3', samen_id: 'a1a1a1a1a1a1' })] }, staat: BEGONNEN, nu: OCHTEND });
  assert.deepStrictEqual(a.regels.map((r) => r.soort), ['aankomst']);
  const b = PS.plan({ body: { lopend: [vandaag1315] }, staat: a.staat, nu: OCHTEND + 60000 });
  assert.strictEqual(b.regels.length, 0);
});
test('handmatig geleverd, verborgen, oude bezorging: geen seintje', function () {
  const l = [pk({ stand: 'bezorgd', handmatig: true, bezorgd_op: new Date(OCHTEND - 60000).toISOString() }),
    pk({ id: 'd4d4d4d4d4d4', stand: 'afhaalpunt', verborgen: true }),
    pk({ id: 'e5e5e5e5e5e5', stand: 'bezorgd', bezorgd_op: new Date(OCHTEND - 13 * 3600000).toISOString() }),
    pk({ id: 'f6f6f6f6f6f6', stand: 'vandaag', verwacht_dag: '2026-11-27', verwacht_van: '08:00', verwacht_tot: '09:30' })];   // al voorbij
  assert.strictEqual(PS.plan({ body: { lopend: l }, staat: BEGONNEN, nu: OCHTEND }).regels.length, 0);
});
test('alias: id wisselt via samen_id → geen tweede; daarna ook niet onder het nieuwe id alleen', function () {
  const a = PS.plan({ body: { lopend: [vandaag1315] }, staat: BEGONNEN, nu: OCHTEND });
  const samen = Object.assign({}, vandaag1315, { id: '0b0b0b0b0b0b', samen_id: 'a1a1a1a1a1a1' });
  const b = PS.plan({ body: { lopend: [samen] }, staat: a.staat, nu: OCHTEND + 60000 });
  assert.strictEqual(b.regels.length, 0);
  assert.ok(b.staat.pakjes['0b0b0b0b0b0b'] && b.staat.pakjes['0b0b0b0b0b0b'].tijdvak, 'nieuwe alias onthouden (Codex MOET 2)');
  const c = PS.plan({ body: { lopend: [Object.assign({}, vandaag1315, { id: '0b0b0b0b0b0b' })] }, staat: b.staat, nu: OCHTEND + 120000 });
  assert.strictEqual(c.regels.length, 0);
});
test('twee kaarten met hetzelfde pakje in één ronde: één regel', function () {
  const a = PS.plan({ body: { lopend: [vandaag1315, Object.assign({}, vandaag1315, { id: '1c1c1c1c1c1c', samen_id: 'a1a1a1a1a1a1' })] }, staat: BEGONNEN, nu: OCHTEND });
  assert.strictEqual(a.regels.length, 1);
});
test('nulpunt: eerste ronde ooit markeert zonder seintje', function () {
  const a = PS.plan({ body: { lopend: [vandaag1315] }, staat: null, nu: OCHTEND });
  assert.strictEqual(a.regels.length, 0); assert.strictEqual(a.nulpunt, 1); assert.ok(a.staat.begonnen);
  assert.strictEqual(PS.plan({ body: { lopend: [vandaag1315] }, staat: a.staat, nu: OCHTEND + 60000 }).regels.length, 0);
});
test('staat ouder dan 30 dagen gaat eruit; sleutel hangt alleen af van (id, soort)', function () {
  const oud = { versie: 1, begonnen: BEGONNEN.begonnen, pakjes: { '999999999999': { tijdvak: '2026-10-01T10:00:00.000Z' } } };
  assert.deepStrictEqual(PS.plan({ body: { lopend: [] }, staat: oud, nu: OCHTEND }).staat.pakjes, {});
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const r = PS.plan({ body: { lopend: [vandaag1315] }, staat: BEGONNEN, nu: OCHTEND }).regels;
  assert.strictEqual(PS.sleutel(r, h), PS.sleutel(r.map((x) => Object.assign({}, x, { tekst: 'anders' })), h));
});

// ── serverblok: volgorde staat → bericht → bij mislukken terug ──
const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function knip(begin, eind) { const i = SRV.indexOf(begin); assert.ok(i >= 0, begin); const j = SRV.indexOf(eind, i); return SRV.slice(i, j + eind.length); }
function blok(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pakjes-seintje-'));
  const staat = path.join(dir, 'seintjes.json');
  const ctx = { PAKJES_SEINTJE: PS, PAKJES_SEINTJE_STAAT: staat, pakjes: { lijst: () => ({ status: 200, body: { lopend: o.lopend } }) }, pakjesGekocht: () => [],
    appLeesStreng: function (f, leeg) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return leeg; throw e; } },
    appSchrijfJson: function (f, d) { if (o.schrijfFaalt && o.schrijfFaalt()) throw new Error('nep schijf vol'); fs.writeFileSync(f, JSON.stringify(d)); },
    berichtIntern: async function (d) { o.berichten.push(d); return { status: o.status ? o.status() : 200, j: {} }; },
    berichtFout: function (r) { return new Error('bericht gaf ' + (r && r.status)); },
    appSha: (s) => crypto.createHash('sha256').update(String(s)).digest('hex'), logError: function () {}, schrijfLog: function () {}, velden: () => '', nu: () => '',
    Date: Date, JSON: JSON, String: String, Object: Object, Error: Error };
  vm.createContext(ctx);
  vm.runInContext(knip('const pakjesSeintjeStand = ', '\n') + knip('let pakjesSeintjeBezig', '\n') + knip('async function pakjesSeintjeRonde(', '\n}\n') + '\nthis.__f = pakjesSeintjeRonde; this.__s = pakjesSeintjeStand;', ctx);
  fs.writeFileSync(staat, JSON.stringify(BEGONNEN));
  return { f: ctx.__f, stand: ctx.__s, staat: () => JSON.parse(fs.readFileSync(staat, 'utf8')) };
}
test('serverblok: één bericht (bron pakjes, soort dag, hoofd), tweede ronde niets', async function () {
  const berichten = [];
  const b = blok({ lopend: [vandaag1315], berichten });
  await b.f({ nu: OCHTEND });
  await b.f({ nu: OCHTEND + 900000 });
  assert.strictEqual(berichten.length, 1);
  assert.strictEqual(berichten[0].bron, 'pakjes'); assert.strictEqual(berichten[0].soort, 'dag'); assert.strictEqual(berichten[0].kanaal, 'hoofd');
  assert.ok(/^pakjes-seintje:[0-9a-f]{24}$/.test(berichten[0].sleutel));
  assert.strictEqual(b.stand.verstuurd, 1);
});
test('serverblok: bericht mislukt → staat terug, volgende ronde opnieuw (één keer)', async function () {
  const berichten = []; let n = 0;
  const b = blok({ lopend: [vandaag1315], berichten, status: () => (n++ === 0 ? 500 : 200) });
  await assert.rejects(b.f({ nu: OCHTEND }));
  assert.deepStrictEqual(b.staat().pakjes, {}, 'oude staat terug');
  await b.f({ nu: OCHTEND + 900000 });
  await b.f({ nu: OCHTEND + 1800000 });
  assert.strictEqual(berichten.length, 2, 'één mislukt, één geslaagd, daarna niets');
  assert.ok(b.stand.laatste_fout === null);
});
test('serverblok: staat niet weg te schrijven → geen bericht (nooit dubbel)', async function () {
  const berichten = [];
  const b = blok({ lopend: [vandaag1315], berichten, schrijfFaalt: () => true });
  await assert.rejects(b.f({ nu: OCHTEND }));
  assert.strictEqual(berichten.length, 0);
  assert.ok(b.stand.laatste_fout && /schijf/.test(b.stand.laatste_fout.reden));
});
test('server.js: bron pakjes staat in de bronnenlijst en is soort dag; tik roept de ronde aan', function () {
  assert.ok(/\n  'pakjes'\]\);/.test(SRV));
  assert.ok(/'herinnering-david': 'dag', pakjes: 'dag', 'pot-loonrun': 'dag' \}/.test(SRV));
  assert.ok(SRV.indexOf('return pakjesSeintjeRonde(); }).catch(function (e) { logError(\'pakjes-seintje\'') > 0);
});
test('uitrol.sh: pakjes-seintje.js in RELEASE_OPTIONEEL', function () {
  const u = fs.readFileSync(path.join(__dirname, '..', 'uitrol.sh'), 'utf8');
  assert.ok(/RELEASE_OPTIONEEL="[^"]* pakjes-seintje\.js[ "]/.test(u));
});
