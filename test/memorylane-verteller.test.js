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
const C = require(path.join(__dirname, '..', 'elevenlabs-credits.js'));

const HID = 'h0123456789abcdef', HID2 = 'hfedcba9876543210';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(400, 7)]);
function nepFetch(plan) {
  const uit = { aanroepen: [] };
  uit.f = async (u, x) => {
    const body = JSON.parse(x.body);
    uit.aanroepen.push({ u, body, auth: x.headers.Authorization });
    const st = plan.length ? plan.shift() : 200;
    if (st === 'gooi') throw new Error('netwerk weg');
    return { ok: st >= 200 && st < 300, status: st, headers: { get: (k) => (k === 'character-cost' ? String(Math.ceil(body.text.length * 0.44)) : null) },
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
  // wv2751: verzonnen bundel van 20.000 credits zonder meting (rem 5 % → ruimte 19.000), resetdag 18
  const bestand = path.join(dir, 'bundel.json');
  fs.writeFileSync(bestand, JSON.stringify({ maand_bundel: 20000, reset_dag: 18, rem_procent: 5, meting: null }));
  const credits = C.maak({ bestand, nu: () => t });
  const v = V.maak(Object.assign({ db, dir, nu: () => t, credits, sleutel: async () => 'nep-sleutel', routerUrl: 'https://router.proef', fetch: nf.f,
    geheimRaak: (s) => /nepgeheim-/.test(s), markerRaak: (l) => l.some((s) => /BSN 999/.test(s)), klaar: (h) => klaar.push(h) }, extra || {}));
  return { dir, db, nf, v, klaar, credits, schuif: (ms) => { t += ms; } };
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
test('credit-rem (wv2751): reservering telt, 4xx op het eerste deel niet, 5xx wel; echte credits uit de kop; stop vóór de bundel op is', async () => {
  const x = opzet([400, 502]);
  const t = ('Een lange zin over vroeger op de camping. ').repeat(140).trim();   // ± 5.900 tekens, 3 delen
  assert.strictEqual(x.v.maken(HID, t).status, 202); await wacht(x, HID);
  assert.strictEqual(x.v.info().credits_periode, 0, '4xx op deel 1 = niets gerekend');
  assert.match(x.v.stand(HID, null).fout, /HTTP 400/);
  x.schuif(11000);
  assert.strictEqual(x.v.maken(HID, t).status, 202); await wacht(x, HID);
  const na5xx = x.v.info().credits_periode;
  assert.ok(na5xx > 0, '5xx telt mee (schatting van dat deel)');
  assert.strictEqual(x.v.stand(HID, null).stand, null);
  assert.deepStrictEqual(fs.readdirSync(path.join(x.dir, 'verteller')), [], 'geen halve vertelling');
  // geslaagd: de aanvraag telt de echte credits (kop character-cost), niet de schatting
  x.schuif(11000);
  const u = x.v.maken(HID2, t);
  assert.strictEqual(u.status, 202); assert.strictEqual(u.body.credits, V.prijs(V.delenVan(t)), 'reservering = schatting'); assert.ok(!('eur' in u.body));
  await wacht(x, HID2);
  const echt = V.delenVan(t).reduce((s2, d) => s2 + Math.ceil(d.length * 0.44), 0);
  assert.strictEqual(x.db.prepare('SELECT credits FROM ml_verteller_aanvraag ORDER BY id DESC LIMIT 1').get().credits, echt);
  assert.strictEqual(x.v.info().credits_periode, na5xx + echt);
  const info = x.v.info();
  assert.ok(!('maand_eur' in info) && !('plafond_eur' in info), 'geen euro\'s meer');
  assert.strictEqual(info.bundel.limiet, 20000); assert.strictEqual(info.bundel.gebruikt, na5xx + echt);
  assert.match(info.bundel_tekst, /^[\d.]+ van 20\.000 credits deze periode, [\d.]+ over$/);
  let n = 0, w;
  for (;;) { x.schuif(11000); w = x.v.maken(HID2, t); if (w.status !== 202) break; await wacht(x, HID2); n++; assert.ok(n < 30); }
  assert.strictEqual(w.status, 409); assert.ok(w.body.plafond);
  assert.match(w.body.fout, /ElevenLabs-bundel is bijna op .*credits.*5 % over/); assert.ok(!/€/.test(w.body.fout), 'geen geldbedrag');
  assert.ok(x.credits.stand().gebruikt <= x.credits.stand().rem_vanaf, 'nooit voorbij de rem (schatting ≥ echt)');
  // nieuwe periode (na de 18e): weer ruimte
  x.schuif(30 * 86400000);
  assert.strictEqual(x.v.maken(HID2, t).status, 202); await wacht(x, HID2);
});
test('credit-rem is gezamenlijk: verbruik van Studio telt mee', () => {
  const x = opzet();
  const t = 'Kort verhaal over de zee. '.repeat(60).trim();   // ± 1.550 tekens → ± 780 credits geschat
  assert.strictEqual(x.v.vooraf(t).past, true);
  x.credits.bron('studio', () => 18500);   // ruimte 19.000 − 18.500 = 500
  const vo = x.v.vooraf(t);
  assert.strictEqual(vo.past, false); assert.strictEqual(vo.bundel.gebruikt, 18500); assert.strictEqual(vo.credits, V.prijs(V.delenVan(t)));
  const u = x.v.maken(HID, t);
  assert.strictEqual(u.status, 409); assert.ok(u.body.plafond); assert.strictEqual(x.nf.aanroepen.length, 0);
});
test('netwerkfout midden in: telt, niets bewaard; geen sleutel: niets aangeroepen', async () => {
  const x = opzet([200, 'gooi']);
  const t = ['Deel een. '.repeat(200).trim(), 'Deel twee. '.repeat(200).trim()].join('\n\n');
  x.v.maken(HID, t); await wacht(x, HID);
  assert.strictEqual(x.v.stand(HID, V.hashVan(t)).stand, null);
  assert.ok(x.v.info().credits_periode > 0);
  const y = opzet([], { sleutel: async () => null });
  y.v.maken(HID, 'Kort.'); await wacht(y, HID);
  assert.strictEqual(y.nf.aanroepen.length, 0); assert.match(y.v.stand(HID, null).fout, /sleutel/);
  assert.strictEqual(y.v.info().credits_periode, 0);
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

// ── wv2484: vorm 'verhaal' (eerst het vertelscript, dan ElevenLabs; eigen map en tabel, gedeeld plafond) ──
const wachtV = async (x, hid) => { for (let i = 0; i < 200 && x.v.stand(hid, null, 'verhaal').stand === 'bezig'; i++) await new Promise((r) => setTimeout(r, 5)); };
test('verhaal: script eerst, dan de stem; eigen map en tabel; alleen de stem kost credits; voorlezen blijft los', async () => {
  const x = opzet();
  const script = '[softly] Proefkamp bij het meer.\n\n[laughs] De tent lekte drie dagen.';
  let gevraagd = 0;
  x.v.maken(HID, 'Voorleesversie.'); await wacht(x, HID); x.schuif(11000);
  const u = x.v.maken(HID, '', 'verhaal', { tekens: 120, script: async () => { gevraagd++; return { tekst: script }; } });
  assert.strictEqual(u.status, 202);
  assert.strictEqual(x.v.stand(HID, null, 'verhaal').stand, 'bezig');
  assert.strictEqual(x.v.stand(HID, V.hashVan('Voorleesversie.')).stand, 'klaar', 'voorlezen blijft speelbaar');
  await wachtV(x, HID);
  assert.strictEqual(gevraagd, 1);
  const a = x.nf.aanroepen[1];
  assert.strictEqual(a.body.text, script, 'het script met tags gaat naar ElevenLabs'); assert.strictEqual(a.body.model_id, 'eleven_v4');
  const h = V.hashVan(script);
  assert.strictEqual(x.v.stand(HID, h, 'verhaal').stand, 'klaar');
  assert.ok(fs.existsSync(path.join(x.dir, 'verteller-verhaal', HID, '1.mp3')));
  assert.strictEqual(fs.statSync(path.join(x.dir, 'verteller-verhaal')).mode & 0o777, 0o700);
  assert.strictEqual(x.v.deel(HID, 1, h, 'verhaal').status, 200);
  assert.strictEqual(x.v.deel(HID, 1, h).status, 409, 'de voorleesversie heeft een andere hash');
  const r = x.db.prepare('SELECT * FROM ml_verteller_aanvraag ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(r.status, 'klaar'); assert.strictEqual(r.credits, Math.ceil(script.length * 0.44), 'de echte credits van de stem (Claude telt niet)');
  assert.ok(!/Proefkamp|tent/.test(JSON.stringify(x.db.prepare('SELECT * FROM ml_verteller_verhaal').all())), 'geen tekst in de databank');
  assert.strictEqual(x.v.info().als_verhaal, 1); assert.strictEqual(x.v.info().aantal, 1);
  // weghalen van de ene vorm laat de andere staan
  assert.strictEqual(x.v.weg(HID, 'verhaal').status, 200);
  assert.strictEqual(x.v.stand(HID, h, 'verhaal').stand, null);
  assert.strictEqual(x.v.stand(HID, V.hashVan('Voorleesversie.')).stand, 'klaar');
});
test('verhaal: vooraf geschat; credit-rem vooraf op de schatting en na het script op de echte lengte; scriptfout = niets ingesproken', async () => {
  const x = opzet();
  const vo = x.v.vooraf(3000);
  assert.strictEqual(vo.geschat, true); assert.strictEqual(vo.delen, 2); assert.strictEqual(vo.credits, 1500, '3.000 tekens × 0,5'); assert.ok(!('eur' in vo));
  assert.strictEqual(vo.bundel.ruimte, 19000);
  assert.strictEqual(x.v.maken(HID, '', 'verhaal', { tekens: 60000, script: async () => ({ tekst: 'x' }) }).status, 409, 'schatting boven de rem');
  // script komt veel langer terug dan geschat (± 55.000 tekens = 27.500 credits > 19.000): geen stem
  const lang = ('Een lange zin over het meer. ').repeat(1900).trim();
  assert.strictEqual(x.v.maken(HID, '', 'verhaal', { tekens: 100, script: async () => ({ tekst: lang }) }).status, 202);
  await wachtV(x, HID);
  assert.strictEqual(x.nf.aanroepen.length, 0, 'niets naar ElevenLabs');
  assert.match(x.v.stand(HID, null, 'verhaal').fout, /bundel is bijna op.*Het script is bewaard/);
  assert.strictEqual(x.v.info().credits_periode, 0, 'niets ingesproken = 0 credits');
  x.schuif(11000);
  x.v.maken(HID, '', 'verhaal', { tekens: 100, script: async () => ({ fout: 'Claude gaf geen antwoord' }) });
  await wachtV(x, HID);
  assert.strictEqual(x.v.stand(HID, null, 'verhaal').fout, 'Claude gaf geen antwoord');
  assert.strictEqual(x.nf.aanroepen.length, 0);
  x.schuif(11000);
  x.v.maken(HID, '', 'verhaal', { tekens: 100, script: async () => ({ tekst: 'Er staat nepgeheim-0123 in.' }) });
  await wachtV(x, HID);
  assert.match(x.v.stand(HID, null, 'verhaal').fout, /niet naar buiten/); assert.strictEqual(x.nf.aanroepen.length, 0);
  // één aanvraag tegelijk, over beide vormen
  x.schuif(11000);
  let los;
  x.v.maken(HID, '', 'verhaal', { tekens: 100, script: () => new Promise((r) => { los = r; }) });
  assert.strictEqual(x.v.maken(HID2, 'Iets anders.').status, 409);
  await new Promise((r) => setTimeout(r, 5)); los({ tekst: 'Kort script.' }); await wachtV(x, HID);
  assert.strictEqual(x.v.stand(HID, V.hashVan('Kort script.'), 'verhaal').stand, 'klaar');
  // opruimen wist beide vormen
  assert.strictEqual(x.v.opruim(() => false), 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(x.dir, 'verteller-verhaal')), []);
});
// ── wv2751: de credit-teller zelf (verzonnen getallen) ──
test('elevenlabs-credits: periode op de 18e, meting + eigen verbruik, na reset alleen de maandbundel, rem 5 %', () => {
  let t = Date.parse('2026-11-08T15:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elc-'));
  const bestand = path.join(dir, 'b.json');
  fs.writeFileSync(bestand, JSON.stringify({ maand_bundel: 1000, reset_dag: 18, rem_procent: 5, meting: { op: '2026-11-08T12:00:00Z', gebruikt: 600, limiet: 2000 } }));
  const c = C.maak({ bestand, nu: () => t });
  let eigen = [];   // [iso, credits]
  c.bron('nep', (iso) => eigen.filter(([w]) => w >= iso).reduce((s2, [, n]) => s2 + n, 0));
  eigen.push(['2026-11-01T10:00:00.000Z', 300]);   // vóór de meting: zit al in de 600
  eigen.push(['2026-11-08T14:00:00.000Z', 50]);    // na de meting: erbij
  let st = c.stand();
  assert.strictEqual(st.bron, 'meting'); assert.strictEqual(st.gebruikt, 650); assert.strictEqual(st.limiet, 2000); assert.strictEqual(st.over, 1350);
  assert.strictEqual(st.rem_vanaf, 1900); assert.strictEqual(st.ruimte, 1250); assert.strictEqual(st.periode_tot, '2026-11-18T00:00:00.000Z');
  assert.strictEqual(st.periode_van, '2026-10-18T00:00:00.000Z'); assert.strictEqual(st.socev, 350);
  assert.strictEqual(c.past(1250), true); assert.strictEqual(c.past(1251), false);
  assert.strictEqual(c.tekst(st), '650 van 2.000 credits deze periode, 1.350 over');
  // na de reset zonder nieuwe meting: alleen de maandbundel (geen doorgeschoven credits die niet gemeten zijn)
  t = Date.parse('2026-11-20T09:00:00Z'); eigen.push(['2026-11-19T09:00:00.000Z', 100]);
  st = c.stand();
  assert.strictEqual(st.bron, 'zonder meting'); assert.strictEqual(st.limiet, 1000); assert.strictEqual(st.gebruikt, 100); assert.strictEqual(st.ruimte, 850);
  // jaargrens en januari
  assert.deepStrictEqual(C.periode(Date.parse('2027-01-05T00:00:00Z'), 18), { begin: Date.parse('2026-12-18T00:00:00Z'), eind: Date.parse('2027-01-18T00:00:00Z') });
  // kapotte instelling = standaard
  fs.writeFileSync(bestand, '{ kapot');
  st = c.stand(); assert.strictEqual(st.limiet, C.STANDAARD.maand_bundel); assert.strictEqual(st.gebruikt, 100); assert.ok(st.ruimte > 0);
  // review MOET 5: een bron die gooit of onzin geeft = onleesbaar → geen ruimte (niets nieuws), eigen weigertekst
  c.bron('gooit', () => { throw new Error('x'); });
  st = c.stand(); assert.strictEqual(st.onleesbaar, true); assert.strictEqual(st.ruimte, 0); assert.strictEqual(c.past(1), false);
  assert.match(c.weigering(10, 'dit'), /niet volledig te lezen/);
  c.bron('gooit', () => NaN); assert.strictEqual(c.stand().ruimte, 0);
  c.bron('gooit', () => 0); assert.ok(c.stand().ruimte > 0, 'weer leesbaar = weer ruimte');
  // schatting: v4 0,5 per teken (naar boven), onbekend model 1
  assert.strictEqual(C.schat(7, 'eleven_v4'), 4); assert.strictEqual(C.schat(7, 'iets'), 7); assert.strictEqual(C.schat(0, 'eleven_v4'), 0);
});
