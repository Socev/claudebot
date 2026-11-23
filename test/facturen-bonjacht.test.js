'use strict';
// Toetsen voor facturen-bonjacht.js (wv3916). Alle data verzonnen: geen echte lijst, geen echte mail.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const B = require('../facturen-bonjacht.js');

// ── een minimale xlsx bouwen (zip met deflate) ──
function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function zip(bestanden, o) {
  const lokaal = [], centraal = []; let off = 0;
  for (const [naam, inhoud] of bestanden) {
    const ruw = Buffer.from(inhoud), comp = zlib.deflateRawSync(ruw), nb = Buffer.from(naam);
    const opgegeven = o && o.liegGrootte ? 10 : ruw.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(ruw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(opgegeven, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(ruw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(opgegeven, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    lokaal.push(lh, nb, comp); centraal.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centraal), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(bestanden.length, 8); e.writeUInt16LE(bestanden.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...lokaal, cd, e]);
}
function xlsx(rijen) {
  const ss = []; const idx = (s) => { let i = ss.indexOf(s); if (i < 0) { ss.push(s); i = ss.length - 1; } return i; };
  const xmlRows = rijen.map((r, i) => '<row r="' + (i + 1) + '">' + Object.entries(r).map(([k, v]) =>
    typeof v === 'number' ? `<c r="${k}${i + 1}"><v>${v}</v></c>` : `<c r="${k}${i + 1}" t="s"><v>${idx(v)}</v></c>`).join('') + '</row>').join('');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return zip([
    ['xl/sharedStrings.xml', '<sst>' + ss.map((s) => '<si><t xml:space="preserve">' + esc(s) + '</t></si>').join('') + '</sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData>' + xmlRows + '</sheetData></worksheet>'],
  ]);
}
// verzonnen lijst in Exact-vorm (serieel 46321 = 2026-10-26)
const LIJST = xlsx([
  { A: 'Administratie: 99 - Proefpraktijk Zonnebloem' }, { A: 'Datum: 1 november 2026 door Proef' }, { A: 'Afschriften|Af te handelen' },
  { A: 'Afschriftregel', H: 'Boekingsregel' },
  { A: 'Datum', B: 'Bankrekening', C: 'Val.', D: 'Bedrag in', E: 'Bedrag uit', F: 'Omschrijving', H: 'Grootboekrekening', I: 'Relatie' },
  { A: 'NL00 TEST 0123 4567 89 - Testbank' },
  { A: '46321', B: 'NL00 TEST 9999 9999 99', C: 'EUR', E: 144, F: 'Webwinkel Blauwbes bestelling 123', H: '2650 - Betalingen onderweg' },
  { A: '46325', C: 'EUR', E: 39.29, F: 'Telecom Kwak B.V.Factuur 28-10-2026', H: '2650', I: '2 - Telecom Kwak B.V.' },
  { A: '46337', C: 'EUR', E: 8.99, F: 'BEA, Betaalpas Drogist Pluim 2941,PAS075 NR:12ZJ03, 11.11.26/14:08 AMERSFOORT', I: '9678 - Drogist Pluim' },
  { A: '46338', C: 'EUR', D: 12.5, F: 'Terugbetaling', H: '2650' },
]);
function tnef(naam, bytes) {
  const attr = (id, data) => { const h = Buffer.alloc(9); h.writeUInt8(2, 0); h.writeUInt32LE(id, 1); h.writeUInt32LE(data.length, 5); return Buffer.concat([h, data, Buffer.alloc(2)]); };
  const kop = Buffer.alloc(6); kop.writeUInt32LE(0x223E9F78, 0);
  return Buffer.concat([kop, attr(0x00018010, Buffer.from(naam + '\0', 'latin1')), attr(0x0006800F, bytes)]);
}

test('leesLijst: Exact-kop, rekening, datum, bedragen', () => {
  const l = B.leesLijst(LIJST);
  assert.equal(l.ok, true);
  assert.equal(l.administratie, '99 - Proefpraktijk Zonnebloem');
  assert.equal(l.regels.length, 4);
  assert.deepEqual(l.regels.map((r) => [r.datum, r.bedrag_centen, r.iban]), [
    ['2026-10-26', -14400, 'NL00TEST0123456789'], ['2026-10-30', -3929, 'NL00TEST0123456789'], ['2026-11-11', -899, 'NL00TEST0123456789'], ['2026-11-12', 1250, 'NL00TEST0123456789']]);
  assert.equal(l.regels[1].relatie, 'Telecom Kwak B.V.');
});
test('leesLijst: geen Exact-kop of geen zip = geen lijst', () => {
  assert.deepEqual(B.leesLijst(xlsx([{ A: 'Iets anders' }, { A: '46321', E: 1 }])), { ok: false, reden: 'geen_exact_kop' });
  assert.equal(B.leesLijst(Buffer.from('geen zip')).reden, 'onleesbaar');
  assert.equal(B.leesLijst(Buffer.alloc(B.GRENS.bestandBytes + 1)).reden, 'te_groot');
});
test('zip-bom: uitpakken stopt op de werkelijke grens, ook als het zip een kleine grootte opgeeft (review MOET 1)', () => {
  const groot = 'A'.repeat(B.GRENS.itemUitgepakt + 1024);
  const bom = zip([['xl/sharedStrings.xml', groot], ['xl/worksheets/sheet1.xml', '<worksheet/>']], { liegGrootte: true });
  assert.ok(bom.length < 100000, 'bom is klein');
  assert.equal(B.leesLijst(bom).reden, 'onleesbaar');
});
test('lijstenUitBijlagen: direct en in winmail.dat, alleen CflStatements-xlsx', () => {
  const r = B.lijstenUitBijlagen([
    { naam: 'CflStatementsToBeCompleted (19).xlsx', bytes: LIJST },
    { naam: 'winmail.dat', bytes: Buffer.concat([tnef('CflStatementsToBeCompleted (10).xlsx', LIJST)]) },
    { naam: 'FinTransactions (3).xlsx', bytes: LIJST },
    { naam: 'foto.png', bytes: Buffer.from('x') },
  ]);
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => x.ok && x.regels.length === 4 && /^[0-9a-f]{64}$/.test(x.sha256)));
});
test('euroTekst en bedragInTekst: op de cent, niet als deel van een groter getal', () => {
  assert.deepEqual(B.euroTekst(-238338).sort(), ['2,383.38', '2.383,38', '2383,38', '2383.38'].sort());
  assert.ok(B.euroTekst(-14400).includes('144,-'));
  assert.ok(B.bedragInTekst('Totaal € 144,00 incl. btw', -14400));
  assert.ok(B.bedragInTekst('Total: EUR 39.29', -3929));
  assert.ok(!B.bedragInTekst('Totaal € 1.144,00', -14400));
  assert.ok(!B.bedragInTekst('Totaal € 144,001', -14400));
  assert.ok(!B.bedragInTekst('Totaal € 39,30', -3929));
});
test('partijTokens en partijUitOmschrijving', () => {
  assert.deepEqual(B.partijTokens('Telecom Kwak B.V.'), ['telecom', 'kwak']);
  assert.deepEqual(B.partijTokens('Google Payment Ireland Limited'), ['google']);
  assert.equal(B.partijUitOmschrijving('BEA, Betaalpas Drogist Pluim 2941,PAS075 NR:12ZJ03'), 'Drogist Pluim');
  assert.equal(B.partijUitOmschrijving('BEA, BetaalpasBNG*Afvalpunt Proef,PAS054 NR:CT921806'), 'Afvalpunt Proef');
});
const Q = {
  rekening: (iban) => iban === 'NL00TEST0123456789' ? { entiteit: 'proef' } : null,
  transacties: (ent, iban, c, van, tot) => ({ '-14400': [{ id: 't1', boekdatum: '2026-10-24', tegenpartij_naam: 'Blauwbes' }],
    '-3929': [{ id: 't2', boekdatum: '2026-10-30', tegenpartij_naam: 'Telecom Kwak B.V.' }],
    '-899': [{ id: 't3', boekdatum: '2026-11-11', tegenpartij_naam: null }, { id: 't4', boekdatum: '2026-11-12', tegenpartij_naam: null }] })[String(c)] || [],
  achter: (id) => id === 't1' ? { partij: 'Webwinkel Blauwbes', factuur: null } : null,
  factuur: (id) => id === 't2' ? 'f'.repeat(16) : null,
};
test('koppelBank: één bankregel = gekoppeld, partij erachter, bestaande factuur, meerdere', () => {
  const k = B.koppelBank(B.leesLijst(LIJST), Q);
  assert.equal(k[0].bank_status, 'gekoppeld'); assert.equal(k[0].partij, 'Webwinkel Blauwbes'); assert.ok(k[0].tokens.includes('blauwbes'));
  assert.equal(k[1].al_factuur, 'f'.repeat(16));
  assert.equal(k[2].bank_status, 'meerdere'); assert.equal(k[2].partij, 'Drogist Pluim');
  assert.equal(k[3].bank_status, 'geen');
});
test('zoekvraag: bedrag in de notaties en het venster rond de bankdatum', () => {
  const k = B.koppelBank(B.leesLijst(LIJST), Q);
  assert.equal(B.zoekvraag(k[0]), '("144,00" OR "144.00") after:2026/09/24 before:2026/11/03');
});
const AFZ = ['boekhouder@proef.invalid'];
function regel0() { return B.koppelBank(B.leesLijst(LIJST), Q)[0]; }
test('beoordeel: bedrag én partij = gevonden; alleen bedrag telt niet; boekhoudermail telt nooit', () => {
  const r = regel0();
  const mails = [
    { id: 'm1', account: 'prive', dag: '2026-10-24', van: 'Blauwbes <noreply@blauwbes.invalid>', onderwerp: 'Je bestelling', tekst: 'Totaal € 144,00', bijlagen: ['factuur.pdf'] },
    { id: 'm2', account: 'prive', dag: '2026-10-20', van: 'Ander <x@y.invalid>', onderwerp: 'Iets', tekst: 'Bedrag 144,00', bijlagen: [] },
    { id: 'm3', account: 'prive', dag: '2026-10-25', van: 'Pa <boekhouder@proef.invalid>', onderwerp: 'missende bonnen Blauwbes', tekst: '144,00', bijlagen: [] },
  ];
  const u = B.beoordeel(r, mails, { afzenders: AFZ });
  assert.equal(u.status, 'gevonden'); assert.equal(u.zekerheid, 'hoog'); assert.equal(u.treffers[0].id, 'm1'); assert.equal(u.treffers[0].pdf, true);
  assert.equal(B.beoordeel(r, [mails[1]], { afzenders: AFZ }).status, 'niet_gevonden');
  assert.equal(B.beoordeel(r, [mails[2]], { afzenders: AFZ }).status, 'niet_gevonden');
});
test('beoordeel: doorgestuurde kopie telt niet dubbel; twee echte = kandidaten; ver weg = middel', () => {
  const r = regel0();
  const a = { id: 'a', account: 'prive', dag: '2026-10-24', van: 'Blauwbes <n@blauwbes.invalid>', onderwerp: 'Bestelling 1', tekst: '€ 144,00', bijlagen: [] };
  const fwd = Object.assign({}, a, { id: 'b', van: 'David <d@proef.invalid>', onderwerp: 'Fwd: Bestelling 1', tekst: 'Blauwbes € 144,00' });
  assert.equal(B.beoordeel(r, [a, fwd], {}).status, 'gevonden');
  const c = Object.assign({}, a, { id: 'c', onderwerp: 'Bestelling 2', dag: '2026-10-22' });   // twee dagen ernaast: echte twijfel
  assert.equal(B.beoordeel(r, [a, c], {}).status, 'kandidaten');
  const vorigeMaand = Object.assign({}, a, { id: 'v', onderwerp: 'Bestelling 0', dag: '2026-09-24' });   // zelfde abonnement vorige maand
  const u = B.beoordeel(r, [a, vorigeMaand], {});
  assert.equal(u.status, 'gevonden'); assert.equal(u.treffers[0].id, 'a'); assert.equal(u.ook[0].id, 'v');
  assert.equal(B.beoordeel(r, [vorigeMaand], {}).zekerheid, 'middel');
});
function nepIo(mails, o) {
  const log = [];
  return { log, luik: async (b) => {
    log.push(b.actie);
    if (b.actie === 'mail_zoeken') { if (o && o.fout) return { aantal: 0, mails: [], melding: 'fout bij zoeken' }; return { aantal: mails.length, mails: b.account === '' ? mails.map((m) => ({ id: m.id, van: m.van, onderwerp: m.onderwerp, dag_lokaal: m.dag })) : [] }; }
    const m = mails.find((x) => x.id === b.id);
    if (b.actie === 'mail_lezen') return m ? { van: m.van, onderwerp: m.onderwerp, datum_lokaal: m.dag + 'T10:00:00+01:00', tekst: m.tekst } : { fout: 'weg' };
    if (b.actie === 'mail_bijlage') return { bijlagen: (m.bijlagen || []).map((n) => ({ naam: n })) };
  } };
}
test('zoekRegel: zoekt op beide accounts, leest na, en een zoekfout is nooit "niet gevonden"', async () => {
  const r = regel0();
  const m = { id: 'm1', dag: '2026-10-24', van: 'Blauwbes <n@blauwbes.invalid>', onderwerp: 'Je bestelling', tekst: 'Totaal € 144,00', bijlagen: [] };
  const io = nepIo([m]);
  const u = await B.zoekRegel(r, io, { afzenders: AFZ });
  assert.equal(u.status, 'gevonden'); assert.equal(u.volledig, true);
  assert.equal(io.log.filter((x) => x === 'mail_zoeken').length, 2);
  assert.equal((await B.zoekRegel(r, nepIo([m], { fout: true }), {})).status, 'fout');
});
test('zoekRegel: afgekapt (25) of niet alles nagelezen → één treffer is kandidaten, niet gevonden (review ZOU 1)', async () => {
  const r = regel0();
  const veel = [{ id: 'm1', dag: '2026-10-24', van: 'Blauwbes <n@blauwbes.invalid>', onderwerp: 'Je bestelling', tekst: 'Totaal € 144,00', bijlagen: [] }];
  for (let i = 0; i < 24; i++) veel.push({ id: 'x' + i, dag: '2026-10-20', van: 'Ander <a@b.invalid>', onderwerp: 'ruis ' + i, tekst: '144,00', bijlagen: [] });
  const u = await B.zoekRegel(r, nepIo(veel), {});
  assert.equal(u.volledig, false); assert.equal(u.status, 'kandidaten');
});
test('redenNiet in gewone taal', () => {
  assert.match(B.redenNiet({ omschrijving: 'BEA, Betaalpas X' }), /pinbetaling/);
  assert.match(B.redenNiet({ omschrijving: 'SEPA Incasso algemeen doorlopend' }), /portaal/);
});
test('betaaldienst met partij erachter: alleen die naam telt; twee mails op de ankerdag = één aankoop', () => {
  const l = B.leesLijst(LIJST);
  const q2 = Object.assign({}, Q, { achter: (id) => id === 't1' ? { partij: 'Zoekreus Payment Ireland Limited', datum: '2026-10-22', factuur: null } : null });
  const r = B.koppelBank(l, q2)[0];
  assert.deepEqual(r.tokens, ['zoekreus']); assert.equal(r.anker, '2026-10-22');
  const kwit = { id: 'k', account: 'prive', dag: '2026-10-22', van: 'service@betaaldienst.invalid', onderwerp: 'Receipt for Your Payment to Zoekreus Payment', tekst: '€ 144,00 EUR' };
  const order = { id: 'o', account: 'prive', dag: '2026-10-22', van: 'Zoekreus Store <n@zoekreus.invalid>', onderwerp: 'Je bestelling', tekst: 'Totaal € 144,00' };
  const ander = { id: 's', account: 'prive', dag: '2026-10-05', van: 'service@betaaldienst.invalid', onderwerp: 'Ontvangstbewijs voor uw betaling aan Speelgoed Int', tekst: '€ 144,00 betaaldienst' };
  const u = B.beoordeel(r, [kwit, order, ander], {});
  assert.equal(u.status, 'gevonden'); assert.equal(u.zekerheid, 'hoog'); assert.equal(u.treffers.length, 2);
  assert.ok(!u.treffers.concat(u.ook || []).some((t) => t.id === 's'), 'andere partij via de betaaldienst telt niet');
  const vroeg = Object.assign({}, order, { id: 'v', dag: '2026-10-20', onderwerp: 'Bestelling 2' });
  assert.equal(B.beoordeel(r, [kwit, order, vroeg], {}).status, 'kandidaten');
});
