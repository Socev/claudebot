'use strict';
// Toetsen voor wv2056: PayPal zakelijk als bron in de Facturen-app (paypal-zakelijk-lezer.js, facturen-paypal.js, migratie 14, leesroute
// opdracht paypal, tools/facturen-paypal.js). De kern van Davids Ja (30-10-2026): de lezer roept aantoonbaar niets anders aan dan
// POST /v1/oauth2/token en GET /v1/reporting/transactions. Alles verzonnen (de repo is openbaar): rekening PROEFACC01, id's PROEF…,
// bankreferenties 99900000000xx, "Wolkdienst", "Proefbureau Ireland Limited". Raakt PayPal, de kluis, /opt/data/facturen en de vault niet
// (fetch is een stub, alles in TMPDIR). Draaien: bash test/facturen-paypal.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const P = require(path.join(ROOT, 'facturen-paypal.js'));
const L = require(path.join(ROOT, 'paypal-zakelijk-lezer.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const { ibanFromAbnAccount } = require(path.join(ROOT, 'mt940-lezer.js'));

const NU = Date.parse('2026-10-30T12:00:00Z');
const ACC = 'PROEFACC01';
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

// ───────────────────────────── de lezer: witte lijst ─────────────────────────────

test('padToets: alleen POST op het token en GET op de transactielijst', () => {
  assert.equal(L.padToets('POST', '/v1/oauth2/token'), 'https://api-m.paypal.com/v1/oauth2/token');
  const q = '/v1/reporting/transactions?start_date=2026-10-01T00:00:00Z&end_date=2026-10-30T00:00:00Z&fields=all&page_size=500&page=1';
  assert.equal(L.padToets('GET', q), 'https://api-m.paypal.com' + q);
  const nee = [
    ['POST', '/v1/payments/payment'], ['POST', '/v1/payments/sale/X1/refund'], ['POST', '/v2/payments/captures/X1/refund'], ['POST', '/v1/payments/payouts'],
    ['POST', '/v1/oauth2/token?x=1'], ['GET', '/v1/reporting/balances'], ['GET', '/v1/payments/payment'], ['GET', '/v2/checkout/orders/X'],
    ['GET', '/v1/reporting/transactions'], ['GET', '/v1/reporting/transactions?start_date=2026-10-01T00:00:00Z'],
    ['GET', '/v1/reporting/transactions?start_date=2026-10-01T00:00:00Z&end_date=2026-10-30T00:00:00Z&transaction_id=X'],
    ['GET', '/v1/reporting/transactions?start_date=2026-10-01T00:00:00Z&end_date=2026-10-30T00:00:00Z&fields=all&fields=all'],
    ['GET', '/v1/reporting/transactions?start_date=x&end_date=2026-10-30T00:00:00Z'],
    ['GET', '/v1/reporting/transactions/../../v1/payments/payment?start_date=2026-10-01T00:00:00Z&end_date=2026-10-30T00:00:00Z'],
    ['GET', '//boos.example/v1/reporting/transactions?start_date=2026-10-01T00:00:00Z&end_date=2026-10-30T00:00:00Z'],
    ['GET', 'https://boos.example/v1/reporting/transactions'], ['PUT', '/v1/oauth2/token'], ['DELETE', '/v1/oauth2/token'], ['PATCH', '/v1/reporting/transactions'],
    ['GET', '/v1/reporting/transactions#x'], ['POST', '/v1/oauth2/token/'], ['GET', null],
  ];
  for (const [m, p] of nee) assert.throws(() => L.padToets(m, p), (e) => e instanceof L.PaypalLezerFout && e.code === 'pad', m + ' ' + p);
});

test('broncode van de lezer: één fetch, achter padToets; geen andere PayPal-route, geen module', () => {
  const C = fs.readFileSync(path.join(ROOT, 'paypal-zakelijk-lezer.js'), 'utf8').split('\n').filter((r) => !/^\s*(\*|\/\/|\/\*)/.test(r)).join('\n');
  assert.equal((C.match(/\bfetch\s*\(/g) || []).length, 1, 'precies één fetch');
  assert.match(C, /const url = padToets\(methode, padQuery\);[^]{0,700}?const r = await fetch\(url, /, 'fetch na padToets in roep()');
  assert.equal((C.match(/\burl\s*=/g) || []).length, 1, 'url wordt maar op één plek gezet');
  assert.deepEqual([...new Set(C.match(/['"`]\/v\d\/[^'"`]*['"`]/g))].sort(), ["'/v1/oauth2/token'", "'/v1/reporting/transactions'"], 'alleen de twee paden');
  // uri.paypal.com komt alleen voor als naam van het leesrecht (scope), nooit als adres
  assert.deepEqual([...new Set(C.replace(/'https:\/\/uri\.paypal\.com\/services\/reporting\/search\/read'/g, '').match(/[a-z0-9.-]*paypal\.com/gi))], ['api-m.paypal.com'], 'alleen api-m.paypal.com');
  assert.equal((C.match(/\brequire\s*\(/g) || []).length, 0, 'laadt geen modules');
  assert.doesNotMatch(C, /process\.env|child_process|import\(|eval\(|console\./);
  assert.match(C, /redirect: 'error'/);
});

// fetch-stub: legt elke aanroep vast en antwoordt als PayPal
function stub(opties) {
  const o = opties || {};
  const log = [];
  const oud = global.fetch;
  global.fetch = async (url, init) => {
    log.push({ url: String(url), methode: init.method, auth: String(init.headers.Authorization || '').split(' ')[0] });
    const u = new URL(url);
    const json = (status, j) => ({ status, json: async () => j });
    if (u.pathname === '/v1/oauth2/token') return json(200, { access_token: 'proeftoken', app_id: 'APP-PROEF', scope: (o.scopes || ['https://uri.paypal.com/services/reporting/search/read', 'https://uri.paypal.com/services/payments/refund']).join(' ') });
    if (o.status) return json(o.status, { name: 'NOT_AUTHORIZED', message: 'geheim-ish' });
    const van = u.searchParams.get('start_date'), p = Number(u.searchParams.get('page'));
    const d = (o.details || []).filter((x) => x.transaction_info.transaction_initiation_date >= van && x.transaction_info.transaction_initiation_date <= u.searchParams.get('end_date'));
    const per = 2, pagina = d.slice((p - 1) * per, p * per);
    return json(200, { transaction_details: pagina, account_number: ACC, last_refreshed_datetime: '2026-10-30T09:00:00Z', page: p, total_items: d.length, total_pages: Math.max(1, Math.ceil(d.length / per)) });
  };
  return { log, terug: () => { global.fetch = oud; } };
}
const SL = { id: 'proef-id', geheim: 'proef-geheim' };

// ───────────────────────────── verzonnen PayPal-rekening ─────────────────────────────

const tx = (id, ev, tijd, bedrag, valuta, x) => ({
  transaction_info: Object.assign({ transaction_id: id, transaction_event_code: ev, transaction_status: 'S', transaction_initiation_date: tijd, transaction_updated_date: tijd,
    transaction_amount: { currency_code: valuta, value: bedrag }, ending_balance: { currency_code: valuta, value: '0.00' } }, x || {}),
  payer_info: (x && x._payer) || { payer_name: { alternate_full_name: 'PayPal-houder' }, email_address: 'houder@voorbeeld.nl' },
  cart_info: (x && x._cart) || {},
});
const naar = (id) => ({ paypal_reference_id: id, paypal_reference_id_type: 'TXN' });
// 1) EUR-abonnement Wolkdienst 15,12 via de bank; 2) USD-bestelling Proefbureau 38,50 = 34,80 euro via de bank; 3) bestelling 257,14 met
// terugbetaling en terugstorting; 4) kaartopwaardering (oud); 5) opwaardering van vandaag (nog niet op de bank); 6) betaling deels uit saldo
const DETAILS = [
  tx('PROEF0000000001A', 'T0003', '2026-09-29T14:50:51Z', '-15.12', 'EUR', { paypal_reference_id: 'B-PROEF1', paypal_reference_id_type: 'PAP', transaction_subject: 'WOLKDIENST *abonnement mail: klant@voorbeeld.nl', invoice_id: 'WD-2026-0929',
    _payer: { payer_name: { alternate_full_name: 'Wolkdienst' }, email_address: 'facturen@wolkdienst.example', country_code: 'IE', phone_number: { national_number: '0612345678' }, address: { line1: 'Straat 1' } } }),
  tx('PROEF0000000002B', 'T0300', '2026-09-29T14:50:51Z', '15.12', 'EUR', Object.assign(naar('PROEF0000000001A'), { bank_reference_id: '9990000000001' })),
  tx('PROEF0000000003C', 'T0006', '2026-09-16T16:21:53Z', '-38.50', 'USD', { paypal_reference_id: 'PROEFEXTERN01', paypal_reference_id_type: 'TXN', _payer: { payer_name: { alternate_full_name: 'Proefbureau Ireland Limited' }, country_code: 'US' },
    _cart: { item_details: [{ item_name: 'Proefonderdeel A' }, { item_name: 'Proefonderdeel B' }] } }),
  tx('PROEF0000000004D', 'T0200', '2026-09-16T16:21:53Z', '38.50', 'USD', naar('PROEF0000000003C')),
  tx('PROEF0000000005E', 'T0200', '2026-09-16T16:21:53Z', '-34.80', 'EUR', naar('PROEF0000000003C')),
  tx('PROEF0000000006F', 'T0300', '2026-09-16T16:21:53Z', '34.80', 'EUR', Object.assign(naar('PROEF0000000003C'), { bank_reference_id: '9990000000002' })),
  tx('PROEF0000000007G', 'T0006', '2025-05-01T10:00:00Z', '-257.14', 'EUR', { _payer: { payer_name: { alternate_full_name: 'Winkel Groothandel B.V.' } } }),
  tx('PROEF0000000008H', 'T0300', '2025-05-01T10:00:00Z', '257.14', 'EUR', Object.assign(naar('PROEF0000000007G'), { bank_reference_id: '9990000000003' })),
  tx('PROEF0000000009J', 'T1107', '2025-05-09T10:00:00Z', '257.14', 'EUR', naar('PROEF0000000007G')),
  tx('PROEF0000000010K', 'T0403', '2025-05-09T10:00:01Z', '-257.14', 'EUR', Object.assign(naar('PROEF0000000007G'), { bank_reference_id: 'YYW9990000000004' })),
  tx('PROEF0000000011L', 'T0003', '2024-01-18T10:00:00Z', '-29.99', 'EUR', { _payer: { payer_name: { alternate_full_name: 'Wolkdienst' } } }),
  tx('PROEF0000000012M', 'T0700', '2024-01-18T10:00:00Z', '29.99', 'EUR', naar('PROEF0000000011L')),
  tx('PROEF0000000013N', 'T0003', '2026-10-30T08:00:00Z', '-15.12', 'EUR', { _payer: { payer_name: { alternate_full_name: 'Wolkdienst' } } }),
  tx('PROEF0000000014P', 'T0300', '2026-10-30T08:00:00Z', '15.12', 'EUR', Object.assign(naar('PROEF0000000013N'), { bank_reference_id: '9990000000005' })),
  tx('PROEF0000000015Q', 'T0006', '2026-08-01T10:00:00Z', '-50.00', 'EUR', { _payer: { payer_name: { alternate_full_name: 'Proefwinkel' } } }),
  tx('PROEF0000000016R', 'T0300', '2026-08-01T10:00:00Z', '30.00', 'EUR', Object.assign(naar('PROEF0000000015Q'), { bank_reference_id: '9990000000006' })),
];

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-paypal-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  const ids = {};
  D.transactie(fdb, () => {
    for (const [s, n] of [['tolgaarde', 'Huisartsenpraktijk Proef B.V.'], ['groenhouten', 'Proefpraktijk Twee'], ['prive', 'Privé']]) D.voegToe(fdb, 'entiteit', { sleutel: s, naam: n });
    ids.rek = D.nieuwId(); ids.ander = D.nieuwId(); ids.prive = D.nieuwId();
    D.voegToe(fdb, 'rekening', { id: ids.rek, entiteit: 'tolgaarde', iban: ibanFromAbnAccount('0000000041'), bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 });
    D.voegToe(fdb, 'rekening', { id: ids.ander, entiteit: 'groenhouten', iban: ibanFromAbnAccount('0000000042'), bank: 'ABN', bank_formaat: 'abn_tab', controle: 1, alleen_eigenaar: 0 });
    for (const [k, naam] of [['wolk', 'Wolkdienst'], ['pb', 'Proefbureau Ireland Limited']]) {
      ids[k] = D.nieuwId();
      D.voegToe(fdb, 'leverancier', { id: ids[k], naam, genormaliseerd: K.normNaam(naam), aangemaakt_op: '2026-01-01T00:00:00Z' });
    }
    ids.bestand = D.nieuwId();
    D.voegToe(fdb, 'bank_bestand', { id: ids.bestand, sha256: 'b'.repeat(64), formaat: 'abn_tab', naam: 'proef.TAB', geupload_door: 'toets', geupload_op: '2026-10-01T00:00:00Z' });
    ids.arch = D.nieuwId();
    D.voegToe(fdb, 'factuur_archief', { id: ids.arch, herkomst: 'fv2', extern_id: 'pp1', entiteit: 'tolgaarde', leverancier_naam: 'Wolkdienst', factuurdatum: '2026-09-28', incl: 1512, valuta: 'EUR', aangemaakt_op: '2026-10-01T00:00:00Z' });
  });
  let n = 0;
  const bank = (rek, datum, centen, oms, naam) => {
    const id = 'e' + String(++n).padStart(15, '0');
    fdb.db.prepare('INSERT INTO bank_transactie (id, bestand, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, tegenpartij_naam, omschrijving, is_incasso, entry_ref, formaat, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, \'abn_tab\', ?)')
      .run(id, ids.bestand, rek, rek === ids.rek ? 'tolgaarde' : 'groenhouten', rek === ids.rek ? ibanFromAbnAccount('0000000041') : ibanFromAbnAccount('0000000042'), datum, centen, naam || 'PayPal Europe S.a.r.l. et Cie S.C.A', oms, 'ref' + n, '2026-10-01T00:00:00Z');
    return id;
  };
  ids.b1 = bank(ids.rek, '2026-10-01', -1512, '9990000000001/PAYPAL');
  ids.b2 = bank(ids.rek, '2026-09-18', -3480, '9990000000002/PAYP AL');   // afgebroken zoals in MT940
  ids.b3 = bank(ids.rek, '2025-05-02', -25714, '9990000000003/PAYPAL');
  ids.b4 = bank(ids.rek, '2025-05-12', 25714, 'YYW9990000000004/PAYPAL');
  ids.b6 = bank(ids.rek, '2026-08-03', -3001, '9990000000006/PAYPAL');   // één cent anders dan PayPal: niet koppelen
  ids.bAnder = bank(ids.ander, '2026-08-25', -2232, '9990000000099/PAYPAL');   // een andere PayPal-rekening
  ids.bIdeal = bank(ids.rek, '2026-01-19', -2248, 'iDEAL 7140595104510330 Toolstation', 'Toolstation via PayPal .Europe.');
  return { dir, fdb, ids };
}

// ───────────────────────────── regels uitlezen ─────────────────────────────

test('regelUit: vaste velden, teken, valuta, datum in Amsterdam; geen mailadres, telefoon of adres', () => {
  const r = P.regelUit(DETAILS[0], ACC);
  assert.equal(r.id, 'PROEF0000000001A'); assert.equal(r.event_code, 'T0003'); assert.equal(r.bedrag_centen, -1512); assert.equal(r.valuta, 'EUR');
  assert.equal(r.datum, '2026-09-29'); assert.equal(r.tijdstip, '2026-09-29T14:50:51Z'); assert.equal(r.tegenpartij, 'Wolkdienst'); assert.equal(r.land, 'IE');
  assert.equal(r.ref_soort, 'PAP'); assert.equal(r.factuurnummer, 'WD-2026-0929');
  assert.doesNotMatch(JSON.stringify(r), /@|0612345678|Straat 1/, 'geen mail, telefoon of adres');
  assert.match(r.onderwerp, /^WOLKDIENST \*abonnement mail: …$/);
  const t = P.regelUit(DETAILS[1], ACC);
  assert.equal(t.bank_ref, '9990000000001'); assert.equal(t.tegenpartij, null, 'naam alleen bij de betaling'); assert.equal(t.ref, 'PROEF0000000001A');
  assert.equal(P.regelUit(DETAILS[2], ACC).onderwerp, 'Proefonderdeel A; Proefonderdeel B');
  assert.equal(P.regelUit(tx('PROEF0000000099Z', 'T0006', '2026-10-29T23:30:00Z', '-1.00', 'EUR'), ACC).datum, '2026-10-30', 'na middernacht in Amsterdam');
  assert.equal(P.regelUit(tx('kort', 'T0006', '2026-10-29T10:00:00Z', '-1.00', 'EUR'), ACC), null);
  assert.equal(P.regelUit(tx('PROEF0000000099Z', 'T0006', '2026-10-29T10:00:00Z', '-1,00', 'EUR'), ACC), null);
  assert.equal(P.regelUit(tx('PROEF0000000099Z', 'X0006', '2026-10-29T10:00:00Z', '-1.00', 'EUR'), ACC), null);
  assert.equal(P.regelUit(DETAILS[0], 'x'), null, 'geen rekeningnummer');
  assert.equal(P.centen('-1145.47'), -114547); assert.equal(P.centen('0.5'), 50); assert.equal(P.centen('1.234'), null);
  assert.equal(P.tijdIso('2026-09-16T16:21:53+0000'), '2026-09-16T16:21:53Z');
  assert.equal(P.bankRefUit('1045870519507/PAYP AL'), '1045870519507'); assert.equal(P.bankRefUit('PP.9848.PP/YYR1036419394432'), null);
  assert.equal(P.schoonTekst('kaart 4111 1111 1111 1111 x', 100), 'kaart … x');
  // review ZOU 3 / KAN 4/8: telefoon en IBAN weg, knippen op tekens, bankreferentie ook midden in een omschrijving
  assert.equal(P.schoonTekst('bel 06-12345678 of +31 6 1234 5678, rek NL91ABNA0417164300', 100), 'bel … of …, rek …');
  assert.equal(P.schoonTekst('ab😀cd', 3), 'ab😀');
  assert.equal(P.bankRefUit('/TRTP/iDEAL/REMI/1053106847233/PAYPAL'), '1053106847233');
  assert.equal(P.bankRefUit('Overboeking 1053106847233/PAYPAL'), '1053106847233');
});

// ───────────────────────────── lezer met stub ─────────────────────────────

test('lezer: vensters ≤ 31 dagen, paginering, 3-jaargrens, en alleen de twee verzoeken', async () => {
  const s = stub({ details: DETAILS });
  try {
    const l = await L.transacties(SL, 0, NU, { nu: NU });
    assert.equal(l.account, ACC); assert.equal(l.app_id, 'APP-PROEF'); assert.equal(l.uitbetalen, false);
    assert.equal(l.details.length, DETAILS.length);
    assert.ok(l.vensters >= 36 && l.vensters <= 37, 'drie jaar in vensters van 31 dagen');
    const eerste = new URL(s.log[1].url).searchParams.get('start_date');
    assert.ok(eerste >= '2023-10-30' && eerste <= '2023-11-01', 'niet vóór de grens van PayPal: ' + eerste);
    for (const x of s.log) {
      const u = new URL(x.url);
      assert.equal(u.origin, 'https://api-m.paypal.com');
      assert.ok((x.methode === 'POST' && u.pathname === '/v1/oauth2/token') || (x.methode === 'GET' && u.pathname === '/v1/reporting/transactions'), x.methode + ' ' + u.pathname);
      if (x.methode === 'GET') {
        const b = Date.parse(u.searchParams.get('start_date')), e = Date.parse(u.searchParams.get('end_date'));
        assert.ok(e - b <= 31 * 86400000 && e > b);
      }
    }
    assert.equal(s.log.filter((x) => x.methode === 'POST').length, 1, 'één token per ronde');
    assert.equal(s.log[0].auth, 'Basic'); assert.ok(s.log.slice(1).every((x) => x.auth === 'Bearer'));
    assert.deepEqual(L.vensters(Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-03-01T00:00:00Z')).length, 2);
  } finally { s.terug(); }
});

test('lezer: een sleutel met uitbetaalrecht of zonder leesrecht leest niets; een fout noemt alleen status en naam', async () => {
  let s = stub({ details: DETAILS, scopes: ['https://uri.paypal.com/services/reporting/search/read', 'https://uri.paypal.com/services/payments/payouts'] });
  try {
    await assert.rejects(L.transacties(SL, 0, NU, { nu: NU }), (e) => e.code === 'scope_uitbetalen');
    assert.equal(s.log.length, 1, 'alleen het token, geen transactielijst');
  } finally { s.terug(); }
  s = stub({ details: DETAILS, scopes: ['https://uri.paypal.com/services/payments/refund'] });
  try { await assert.rejects(L.transacties(SL, 0, NU, { nu: NU }), (e) => e.code === 'scope'); assert.equal(s.log.length, 1); } finally { s.terug(); }
  s = stub({ status: 403 });
  try {
    await assert.rejects(L.transacties(SL, NU - 86400000, NU, { nu: NU }), (e) => e.code === 'http' && e.status === 403 && /NOT_AUTHORIZED/.test(e.uitleg) && !/geheim/.test(e.uitleg) && !/proef-/.test(e.uitleg));
  } finally { s.terug(); }
  await assert.rejects(L.transacties({ id: '', geheim: 'x' }, 0, NU, { nu: NU }), (e) => e.code === 'sleutel');
});

// ───────────────────────────── opslaan, koppelen, aansluiten ─────────────────────────────

test('opslaan is idempotent op transaction_id; een statuswijziging werkt bij; ander account weigert', () => {
  const t = opzet();
  const l = { account: ACC, details: DETAILS, ververst: 'x' };
  const a = P.opslaan(t.fdb, l, { wie: 'toets', nu: NU });
  assert.deepEqual([a.gelezen, a.nieuw, a.gewijzigd], [DETAILS.length, DETAILS.length, 0]);
  const b = P.opslaan(t.fdb, l, { wie: 'toets', nu: NU });
  assert.deepEqual([b.nieuw, b.gewijzigd, b.gelijk], [0, 0, DETAILS.length], 'herinlezen = 0 nieuw');
  assert.equal(t.fdb.db.prepare('SELECT count(*) AS n FROM (SELECT id FROM paypal_regel GROUP BY id HAVING count(*) > 1)').get().n, 0);
  const p = JSON.parse(JSON.stringify(DETAILS[0])); p.transaction_info.transaction_status = 'P';
  assert.equal(P.opslaan(t.fdb, { account: ACC, details: [p] }, { wie: 'toets', nu: NU }).gewijzigd, 1);
  assert.equal(t.fdb.db.prepare("SELECT status FROM paypal_regel WHERE id = 'PROEF0000000001A'").get().status, 'P');
  assert.equal(P.opslaan(t.fdb, l, { wie: 'toets', nu: NU }).gewijzigd, 1, 'terug naar S');
  assert.throws(() => P.opslaan(t.fdb, { account: 'ANDERACC02', details: [DETAILS[0]] }, { wie: 'toets', nu: NU }), (e) => e.code === 'account');
  assert.throws(() => P.opslaan(t.fdb, { account: null, details: [DETAILS[0]] }, { wie: 'toets', nu: NU }), (e) => e.code === 'account');
  const d = P.opslaan(t.fdb, { account: ACC, details: [tx('PROEF0000000077X', 'T0006', '2026-10-29T10:00:00Z', '-1.00', 'EUR')] }, { droog: true, wie: 'toets', nu: NU });
  assert.equal(d.nieuw, 1); assert.equal(t.fdb.db.prepare("SELECT count(*) AS n FROM paypal_regel WHERE id = 'PROEF0000000077X'").get().n, 0, 'droog schrijft niets');
  assert.ok(t.fdb.db.prepare("SELECT count(*) AS n FROM audit WHERE wat = 'paypal_regel_bijwerken'").get().n >= 2);
  assert.equal(P.rondeVan(t.fdb, NU), Date.parse('2026-10-30T08:00:00Z') - 10 * 86400000);
});

test('koppelen en aansluiting: bankpost = PayPal-regel op de cent; USD via omwisseling; terugbetaling; saldo; andere rekening', () => {
  const t = opzet();
  const v = P.verwerk(t.fdb, { account: ACC, details: DETAILS, ververst: 'x', vensters: 1 }, { wie: 'toets', nu: NU });
  assert.equal(v.koppeling.bank_nieuw, 4, 'b1, b2 (afgebroken), b3, b4 (terugstorting)');
  assert.equal(v.koppeling.bank_bedrag_anders, 1, 'b6: één cent anders');
  assert.equal(v.koppeling.bank_open, 1, 'opwaardering van vandaag staat nog niet op de bank');
  const r = (id) => t.fdb.db.prepare('SELECT * FROM paypal_regel WHERE id = ?').get(id);
  assert.equal(r('PROEF0000000002B').bank_transactie, t.ids.b1);
  assert.equal(r('PROEF0000000006F').bank_transactie, t.ids.b2);
  assert.equal(r('PROEF0000000010K').bank_transactie, t.ids.b4);
  assert.equal(r('PROEF0000000016R').bank_transactie, null);
  const a = P.aansluiting(t.fdb);
  const per = (id) => a.posten.find((x) => x.bank === id);
  assert.equal(per(t.ids.b1).status, 'sluit'); assert.equal(per(t.ids.b1).betaling.tegenpartij, 'Wolkdienst');
  assert.equal(per(t.ids.b2).status, 'sluit'); assert.equal(per(t.ids.b2).betaling.valuta, 'USD'); assert.equal(per(t.ids.b2).betaling.eur_centen, -3480);
  assert.equal(per(t.ids.b3).status, 'sluit'); assert.equal(per(t.ids.b4).status, 'sluit', 'terugbetaling + terugstorting: groep op 0');
  assert.equal(per(t.ids.b6).status, 'open');
  assert.equal(per(t.ids.bAnder).status, 'niet_in_paypal');
  assert.equal(per(t.ids.bIdeal), undefined, 'iDEAL via PayPal is geen PayPal-post');
  for (const p of a.posten.filter((x) => x.paypal)) assert.equal(p.bank_centen, -p.paypal.bedrag_centen, 'som per bankpost = PayPal-regel op de cent');
  // een betaling die deels uit het saldo kwam: koppelen mag niet (bedrag), en de groep is niet neutraal
  const g = P.groepen(t.fdb.db.prepare('SELECT * FROM paypal_regel').all());
  assert.equal(g.get('PROEF0000000015Q').neutraal, false); assert.equal(g.get('PROEF0000000003C').neutraal, true); assert.equal(g.get('PROEF0000000007G').neutraal, true);
  // herhalen = niets nieuws; de database weigert een koppeling met een ander bedrag of op een privérekening
  assert.equal(P.koppel(t.fdb, { wie: 'toets', nu: NU }).bank_nieuw, 0);
  assert.throws(() => t.fdb.db.prepare("UPDATE paypal_regel SET bank_transactie = ? WHERE id = 'PROEF0000000016R'").run(t.ids.b6), /paypal_regel_bank/);
  assert.throws(() => t.fdb.db.prepare("UPDATE paypal_regel SET bank_transactie = ? WHERE id = 'PROEF0000000014P'").run(t.ids.b1), /UNIQUE|paypal_regel_bank/);
  assert.throws(() => t.fdb.db.prepare("UPDATE paypal_regel SET id = 'PROEF9999999999' WHERE id = 'PROEF0000000014P'").run(), /paypal_regel_vast/);
  // leverancier en factuur
  assert.equal(r('PROEF0000000001A').leverancier, t.ids.wolk); assert.equal(r('PROEF0000000001A').factuur_archief, t.ids.arch);
  assert.equal(r('PROEF0000000003C').leverancier, t.ids.pb);
  assert.equal(r('PROEF0000000011L').factuur_archief, null, 'de factuur is al bezet');
  assert.equal(r('PROEF0000000002B').leverancier, null, 'leverancier alleen op de betaling');
  // review ZOU 1: de bankluis vervangt een gekoppelde post (verwijderd_op + opvolger met hetzelfde nummer en bedrag) → koppeling verhuist
  t.fdb.db.prepare("UPDATE bank_transactie SET verwijderd_op = '2026-10-30T10:00:00Z', verwijderd_door = 'toets' WHERE id = ?").run(t.ids.b1);
  const opv = 'e' + '9'.repeat(15);
  t.fdb.db.prepare("INSERT INTO bank_transactie (id, bestand, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, tegenpartij_naam, omschrijving, is_incasso, entry_ref, formaat, aangemaakt_op) SELECT ?, bestand, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, tegenpartij_naam, omschrijving, is_incasso, 'refopv', formaat, aangemaakt_op FROM bank_transactie WHERE id = ?").run(opv, t.ids.b1);
  const k2 = P.koppel(t.fdb, { wie: 'toets', nu: NU });
  assert.equal(k2.bank_los, 1); assert.equal(k2.bank_nieuw, 1); assert.equal(r('PROEF0000000002B').bank_transactie, opv);
  assert.equal(P.aansluiting(t.fdb).posten.find((x) => x.bank === opv).status, 'sluit');
  const s = P.stand(t.fdb);
  assert.equal(s.regels, DETAILS.length); assert.equal(s.aansluiting['tolgaarde:sluit'].posten, 4); assert.equal(s.laatste_ronde.nieuw, DETAILS.length);
});

test('creditcard-koppeling ziet facturen die al aan PayPal hangen als bezet (review KAN 7)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'facturen-creditcard.js'), 'utf8');
  assert.match(src, /UNION SELECT factuur FROM paypal_regel WHERE factuur IS NOT NULL UNION SELECT factuur_archief FROM paypal_regel/);
});

test('leesroute opdracht paypal (facturen.js) en betalingen', () => {
  const t = opzet();
  assert.equal(F.lees(t.fdb, { opdracht: 'paypal' }, { wie: 'socev', nu: NU }).j.regels, 0);
  P.verwerk(t.fdb, { account: ACC, details: DETAILS }, { wie: 'toets', nu: NU });
  const b = F.lees(t.fdb, { opdracht: 'paypal' }, { wie: 'socev', nu: NU }).j;
  assert.equal(b.weergave, 'betalingen'); assert.equal(b.aantal, 6);
  assert.equal(b.betalingen[0].datum, '2026-10-30');
  const usd = b.betalingen.find((x) => x.valuta === 'USD');
  assert.equal(usd.eur_centen, -3480); assert.equal(usd.financiering, 'bank'); assert.equal(usd.bankposten.length, 1);
  assert.equal(b.betalingen.find((x) => x.id === 'PROEF0000000011L').financiering, 'kaart');
  assert.equal(b.betalingen.find((x) => x.id === 'PROEF0000000007G').terugbetaald_centen, 25714);
  assert.equal(F.lees(t.fdb, { opdracht: 'paypal', tekst: 'proefbureau' }, { wie: 'socev', nu: NU }).j.aantal, 1);
  const a = F.lees(t.fdb, { opdracht: 'paypal', weergave: 'aansluiting', entiteit: 'tolgaarde' }, { wie: 'socev', nu: NU }).j;
  assert.ok(a.posten.every((x) => x.entiteit === 'tolgaarde')); assert.ok(a.let_op_bron);
  assert.doesNotMatch(JSON.stringify(F.lees(t.fdb, { opdracht: 'paypal', weergave: 'stand' }, { wie: 'socev', nu: NU }).j), new RegExp(ACC), 'geen PayPal-rekeningnummer in de leesroute');
});

test('CLI weigert te schrijven op een ouder schema; leest de stand', async () => {
  const t = opzet();
  P.verwerk(t.fdb, { account: ACC, details: DETAILS }, { wie: 'toets', nu: NU });
  D.sluit(t.fdb);
  const oud = process.env.FACTUREN_DIR;
  process.env.FACTUREN_DIR = path.join(t.dir, 'db');   // vóór require: de CLI leest de map bij het laden
  const T = require(path.join(ROOT, 'tools', 'facturen-paypal.js'));
  try {
    const s = await T.hoofd(['stand']);
    assert.equal(s.regels, DETAILS.length);
    const k = await T.hoofd(['koppel', '--droog']);
    assert.equal(k.droog, true);
    await assert.rejects(T.hoofd(['onzin']), /gebruik/);
  } finally { if (oud === undefined) delete process.env.FACTUREN_DIR; else process.env.FACTUREN_DIR = oud; }
});
