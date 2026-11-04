'use strict';
// Toetsen van de verteller in Davids eigen stem (wv2366). Nep-ElevenLabs (fetch), node:sqlite in het geheugen, tijdelijke map.
// ALLEEN VERZONNEN TEKST. Aanroep: bash test/memorylane-verteller.sh
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const V = require(path.join(__dirname, '..', 'memorylane-verteller.js'));

const HID = 'h0123456789abcdef', HID2 = 'hfedcba9876543210';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(400, 7)]);
function nepFetch(plan) {
  const uit = { aanroepen: [] };
  uit.f = async (u, x) => {
    const body = JSON.parse(x.body);
    uit.aanroepen.push({ u, body, auth: x.headers.Authorization });
    const st = plan.length ? plan.shift() : 200;
    if (st === 'gooi') throw new Error('netwerk weg');
    return { ok: st >= 200 && st < 300, status: st, headers: { get: (k) => (k === 'character-cost' ? String(body.text.length) : null) },
      text: async () => 'fout', arrayBuffer: async () => MP3.buffer.slice(MP3.byteOffset, MP3.byteOffset + MP3.length) };
  };
  return uit;
}
function opzet(plan, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlv-'));
  const db = new DatabaseSync(':memory:');
  const nf = nepFetch(plan || []);
  let t = Date.parse('2026-11-04T09:00:00Z');
  const klaar = [];
  const v = V.maak(Object.assign({ db, dir, nu: () => t, sleutel: async () => 'nep-sleutel', routerUrl: 'https://router.proef', fetch: nf.f,
    geheimRaak: (s) => /nepgeheim-/.test(s), markerRaak: (l) => l.some((s) => /BSN 999/.test(s)), klaar: (h) => klaar.push(h) }, extra || {}));
  return { dir, db, nf, v, klaar, schuif: (ms) => { t += ms; } };
}
const wacht = async (x, hid) => { for (let i = 0; i < 100 && x.v.stand(hid, null).stand === 'bezig'; i++) await new Promise((r) => setTimeout(r, 5)); };

test('tekstVan: Socev wordt Zo Kef, markering weg, afgekapt op zinsgrens', () => {
  const r = V.tekstVan('Zomer', 'Socev en ==Proefdorp== aan het meer.\n\n\n\nSOCEV zei het.');
  assert.strictEqual(r.tekst, 'Zomer\n\nZo Kef en Proefdorp aan het meer.\n\nZo Kef zei het.');
  assert.strictEqual(V.tekstVan('Titel', '').tekst, '');
  const lang = V.tekstVan('T', ('Een zin over de camping. ').repeat(400));
  assert.ok(lang.afgekapt && lang.tekst.length <= V.MAX_TEKENS && lang.tekst.endsWith('.'));
});
test('delenVan: alinea\'s samen tot ≤ 2400, lange alinea op zinnen, niets kwijt', () => {
  const t = ['A'.repeat(1000), 'B'.repeat(1000), 'C'.repeat(1000)].join('\n\n');
  const d = V.delenVan(t);
  assert.deepStrictEqual(d.map((x) => x.length), [2002, 1000]);
  const z = ('Zin nummer een is hier. ').repeat(200).trim();
  const d2 = V.delenVan(z);
  assert.ok(d2.every((x) => x.length <= V.DEEL_MAX) && d2.length === 2);
  assert.strictEqual(d2.join(' ').replace(/\s+/g, ' '), z);
  assert.ok(V.delenVan('X'.repeat(5000)).every((x) => x.length <= 2400));
});
test('maken: 202, op de achtergrond, eigen stem en v4, bestanden 0600, geen tekst in het register', async () => {
  const x = opzet();
  const tekst = V.tekstVan('Camping', 'Op de camping in Proefdorp regende het.').tekst;
  const u = x.v.maken(HID, tekst);
  assert.strictEqual(u.status, 202);
  assert.strictEqual(x.v.stand(HID, null).stand, 'bezig');
  assert.strictEqual(x.v.maken(HID, tekst).status, 409);   // één tegelijk
  await wacht(x, HID);
  assert.deepStrictEqual(x.klaar, [HID]);
  const a = x.nf.aanroepen[0];
  assert.strictEqual(a.u, 'https://router.proef/v1/text-to-speech/' + V.STEM + '/stream?output_format=mp3_44100_64');
  assert.strictEqual(a.body.model_id, 'eleven_v4'); assert.strictEqual(a.body.language_code, 'nl'); assert.strictEqual(a.auth, 'Bearer nep-sleutel');
  const h = V.hashVan(tekst);
  assert.strictEqual(x.v.stand(HID, h).stand, 'klaar');
  const f = path.join(x.dir, 'verteller', HID, '1.mp3');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(x.dir, 'verteller', HID)).mode & 0o777, 0o700);
  const d = x.v.deel(HID, 1, h);
  assert.strictEqual(d.status, 200); assert.strictEqual(d.body.mime, 'audio/mpeg'); assert.strictEqual(Buffer.from(d.body.data, 'base64').length, MP3.length);
  assert.strictEqual(d.body.volgende, null);
  const dump = JSON.stringify(x.db.prepare('SELECT * FROM ml_verteller').all()) + JSON.stringify(x.db.prepare('SELECT * FROM ml_verteller_aanvraag').all());
  assert.ok(!/Proefdorp|camping/i.test(dump), 'geen tekst in de databank');
  assert.strictEqual(x.v.info().aantal, 1);
  assert.ok(!/Proefdorp/.test(JSON.stringify(x.v.info())));
});
test('verouderd: andere tekst = niet afspelen; opnieuw maken vervangt', async () => {
  const x = opzet();
  x.v.maken(HID, 'Eerste versie van het verhaal.'); await wacht(x, HID);
  const h2 = V.hashVan('Tweede versie.');
  assert.strictEqual(x.v.stand(HID, h2).stand, 'verouderd');
  const d = x.v.deel(HID, 1, h2); assert.strictEqual(d.status, 409); assert.ok(d.body.verouderd);
  x.schuif(11000);
  assert.strictEqual(x.v.maken(HID, 'Tweede versie.').status, 202); await wacht(x, HID);
  assert.strictEqual(x.v.stand(HID, h2).stand, 'klaar');
  assert.deepStrictEqual(fs.readdirSync(path.join(x.dir, 'verteller')), [HID]);
});
test('lange tekst: meer delen, achter elkaar af te spelen', async () => {
  const x = opzet();
  const t = ['Alinea een. '.repeat(150).trim(), 'Alinea twee. '.repeat(150).trim(), 'Alinea drie. '.repeat(150).trim()].join('\n\n');
  x.v.maken(HID, t); await wacht(x, HID);
  assert.strictEqual(x.nf.aanroepen.length, 3);   // drie alinea's van ± 1.800 tekens passen niet twee aan twee in 2.400
  const h = V.hashVan(t);
  assert.strictEqual(x.v.deel(HID, 1, h).body.volgende, 2);
  assert.strictEqual(x.v.deel(HID, 3, h).body.volgende, null);
  assert.strictEqual(x.v.deel(HID, 4, h).status, 404);
});
test('weigeringen: geheim, marker, leeg, 10 s, daggrens', async () => {
  const x = opzet();
  assert.strictEqual(x.v.maken(HID, 'Er staat nepgeheim-0123 in.').status, 409);
  assert.strictEqual(x.v.maken(HID, 'Met BSN 999 erin.').status, 409);
  assert.strictEqual(x.v.maken(HID, '').status, 409);
  assert.strictEqual(x.nf.aanroepen.length, 0);
  x.v.maken(HID, 'Kort verhaal.'); await wacht(x, HID);
  assert.strictEqual(x.v.maken(HID2, 'Nog een.').status, 429);   // < 10 s
  for (let i = 0; i < 19; i++) { x.schuif(11000); assert.strictEqual(x.v.maken(HID2, 'Nog een ' + i + '.').status, 202); await wacht(x, HID2); }
  x.schuif(11000);
  assert.strictEqual(x.v.maken(HID2, 'Te veel.').status, 429);
});
test('plafond € 5 per maand: reservering telt, 4xx op het eerste deel niet, 5xx wel', async () => {
  const x = opzet([400, 502]);
  const t = ('Een lange zin over vroeger op de camping. ').repeat(140).trim();   // ± 5.900 tekens, 3 delen, ± € 0,60
  assert.strictEqual(x.v.maken(HID, t).status, 202); await wacht(x, HID);
  assert.strictEqual(x.v.info().maand_eur, 0, '4xx op deel 1 = niets gerekend');
  assert.match(x.v.stand(HID, null).fout, /HTTP 400/);
  x.schuif(11000);
  assert.strictEqual(x.v.maken(HID, t).status, 202); await wacht(x, HID);
  assert.ok(x.v.info().maand_eur > 0, '5xx telt mee');
  assert.strictEqual(x.v.stand(HID, null).stand, null);
  assert.deepStrictEqual(fs.readdirSync(path.join(x.dir, 'verteller')), [], 'geen halve vertelling');
  let n = 0;
  for (;;) { x.schuif(11000); const u = x.v.maken(HID2, t); if (u.status !== 202) { assert.strictEqual(u.status, 409); assert.ok(u.body.plafond); break; } await wacht(x, HID2); n++; assert.ok(n < 20); }
  assert.ok(x.v.info().maand_eur <= V.PLAFOND_EUR);
  // nieuwe maand: weer ruimte
  x.schuif(30 * 86400000);
  assert.strictEqual(x.v.maken(HID2, t).status, 202); await wacht(x, HID2);
});
test('netwerkfout midden in: telt, niets bewaard; geen sleutel: niets aangeroepen', async () => {
  const x = opzet([200, 'gooi']);
  const t = ['Deel een. '.repeat(200).trim(), 'Deel twee. '.repeat(200).trim()].join('\n\n');
  x.v.maken(HID, t); await wacht(x, HID);
  assert.strictEqual(x.v.stand(HID, V.hashVan(t)).stand, null);
  assert.ok(x.v.info().maand_eur > 0);
  const y = opzet([], { sleutel: async () => null });
  y.v.maken(HID, 'Kort.'); await wacht(y, HID);
  assert.strictEqual(y.nf.aanroepen.length, 0); assert.match(y.v.stand(HID, null).fout, /sleutel/);
  assert.strictEqual(y.v.info().maand_eur, 0);
});
test('weghalen en opruimen (herinnering weg of gevoelig geworden)', async () => {
  const x = opzet();
  x.v.maken(HID, 'Een.'); await wacht(x, HID); x.schuif(11000);
  x.v.maken(HID2, 'Twee.'); await wacht(x, HID2);
  assert.strictEqual(x.v.weg(HID).status, 200);
  assert.strictEqual(x.v.stand(HID, V.hashVan('Een.')).stand, null);
  assert.ok(!fs.existsSync(path.join(x.dir, 'verteller', HID)));
  fs.mkdirSync(path.join(x.dir, 'verteller', '.' + HID + '-deadbeef'));
  assert.strictEqual(x.v.opruim((h) => h !== HID2), 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(x.dir, 'verteller')), []);
  assert.strictEqual(x.v.info().aantal, 0);
});
