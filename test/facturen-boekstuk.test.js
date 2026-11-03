'use strict';
// Toetsen voor wv2316: boekstuk Google Home Premium Advanced naar de boekhouder (facturen-boekstuk.js; staat in facturen-db.js migratie 19).
// Alles verzonnen (de repo is openbaar): transactie PROEF00000000001X, invoice 900000000000000001, account iemand@voorbeeld.nl, boekhouder
// boekhouder@voorbeeld.nl, reeks SOP.0000-1111-2222-33333.. (de toets zet zijn sha256 in ABO), Tolgaarde-rekening …0042.
// Raakt Gmail, de verzender, /opt/data/facturen en de vault niet. Draaien: bash test/facturen-boekstuk.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const B = require(path.join(ROOT, 'facturen-boekstuk.js'));
const D = require(path.join(ROOT, 'facturen-db.js'));
const AAN = 'boekhouder@voorbeeld.nl';
const VAN = '"David Schaap" <dokterschaap@gmail.com>';
const REEKS = 'SOP.0000-1111-2222-33333..', REK = ['0042'];
B.ABO.reeks_sha256 = require('crypto').createHash('sha256').update(REEKS).digest('hex');   // de echte reeks staat alleen als hash in de module

// ── verzonnen mails in de gemeten vorm (3-11-2026) ──
function playMail(o) {
  o = Object.assign({ n: 7, dag: '2 dec 2026', tijd: '20:05:42', zone: 'CET', product: B.ABO.product, door: 'Google LLC', prijs: '7,99', totaal: '7,99', btw: '1,39', betaal: 'PayPal: iemand@voorbeeld.nl', id: 'play-' + (o && o.n || 7), datum: '2026-12-02T19:05:45.000Z', extraItem: false }, o);
  return { id: o.id, datum: o.datum, van: '"Google Play" <googleplay-noreply@google.com>', onderwerp: 'De bevestiging van je Google Play-bestelling van ' + o.dag,
    tekst: ['Google Play', 'Hartelijk dank', 'Je abonnement van Google Commerce Limited op Google Play is verlengd en de kosten zijn bij je in rekening gebracht.',
      'Bestelnummer: ' + (o.reeks || REEKS) + o.n, 'Besteldatum: ' + o.dag + ' ' + o.tijd + ' ' + o.zone, 'Je account: iemand@voorbeeld.nl', 'Item Prijs',
      o.product + ' (door ' + o.door + ') € ' + o.prijs + ' per maand'].concat(o.extraItem ? ['Iets anders (door Iemand) € 1,00'] : [])
      .concat(['Abonnement automatisch verlengen', 'Totaal: € ' + o.totaal + ' per maand', '(Inclusief € ' + o.btw + ' Btw)', 'Betaalmethode:', o.betaal, 'Google Commerce Limited']).join('\n') };
}
function paypalMail(o) {
  o = Object.assign({ bedrag: '7,99', aan: 'Google Payment Irela...', tx: 'PROEF00000000001X', dag: '2 Dec 2026', inv: '900000000000000001', rek: '0042', id: 'pp-1', datum: '2026-12-02T19:05:51.000Z', nl: false }, o);
  const t = o.nl ? ['DAVID SCHAAP, U HEBT EEN BETALING OVERGEMAAKT.', 'PayPal', '[https://www.paypalobjects.com/x.png]', 'Beste David Schaap,', 'U hebt € ' + o.bedrag + ' EUR betaald aan ' + o.aan,
    'Transactiereferentie', o.tx + ' Transactiedatum', o.dag.replace('Dec', 'dec') + ' Webwinkel', o.aan + ' Factuurreferentie', o.inv, 'Betaalgegevens weergeven', '[https://www.paypal.com/x]',
    'Subtotaal € ' + o.bedrag + ' Totaal € ' + o.bedrag + ' EUR', 'ABN AMRO Bank NV', 'Betaalrekening ••' + o.rek, '€ ' + o.bedrag + ' EUR']
    : ['DAVID SCHAAP, YOU SUCCESSFULLY SENT A PAYMENT.', 'PayPal', '[https://www.paypalobjects.com/x.png]', 'Hello, David Schaap', 'You paid € ' + o.bedrag + ' EUR to ' + o.aan,
      'Transaction ID', o.tx + ' Transaction date', o.dag + ' Merchant', o.aan, 'noreply+support@goog... Invoice ID', o.inv, 'View Payment Details', '[https://www.paypal.com/x]',
      'Google AI Pro (5 TB)...', 'Qty: 1 € ' + o.bedrag, 'Subtotal € ' + o.bedrag + ' Total € ' + o.bedrag + ' EUR', 'Paid ' + o.aan + ' with', 'ABN AMRO Bank NV', 'Checking ••' + o.rek, '€ ' + o.bedrag + ' EUR',
      'Transaction ID: ' + o.tx];
  return { id: o.id, datum: o.datum, van: '"PayPal" <service@paypal.nl>', onderwerp: 'Receipt for Your Payment to Google Payment Irela...', tekst: t.join('\n') };
}

// ── nep-I/O ──
function nepIo(o) {
  o = o || {};
  const mails = new Map(), rijen = new Map(), log = { verstuur: [], concept: [], bericht: [], zoek: [] };
  for (const m of o.mails || [playMail(), paypalMail()]) mails.set(m.id, m);
  const vrijgave = o.vrijgave === undefined ? { id: 1, vraag_id: 'abcd1234', bevestiging: B.BEVESTIGING, bevestigd_op: '2026-11-04T09:00:00Z', ingetrokken_op: null, abo_hash: B.aboHash(AAN) } : o.vrijgave;
  const io = {
    log, rijen,
    zoek: async (q) => {
      log.zoek.push(q);
      if (o.luikFout) return { mails: null, melding: 'fout bij zoeken' };
      if (/^in:sent/.test(q)) return { mails: o.verzonden || [] };
      const alle = [...mails.values()];
      if (/googleplay/.test(q)) return { mails: alle.filter((m) => /googleplay/.test(m.van)) };
      if (/paypal/.test(q)) return { mails: alle.filter((m) => /paypal/.test(m.van)) };
      return { mails: [] };
    },
    lees: async (id) => mails.get(id) || { fout: 'niet gevonden' },
    staat: {
      lees: (t) => rijen.get(t) || null,
      eerderN: () => [...rijen.values()].filter((r) => r.n != null && ['verzenden', 'verstuurd', 'onzeker', 'onzeker_gemeld'].includes(r.status)).map((r) => r.n).concat(o.eerderN || []),
      reserveer: (r) => { if (rijen.has(r.termijn)) return false; rijen.set(r.termijn, Object.assign({}, r)); return true; },
      zet: (t, van, v) => { const r = rijen.get(t); if (!r || r.status !== van) return false; Object.assign(r, v, { bijgewerkt_op: o.zetTijd || r.bijgewerkt_op }); return true; },
      vrijgave: () => vrijgave,
    },
    aan: () => (o.aan === undefined ? AAN : o.aan),
    rekeningen: () => o.rekeningen || REK,
    verzenderOk: async () => (o.verzenderOk === undefined ? true : o.verzenderOk),
    verstuur: async (v) => {
      log.verstuur.push(v);
      if (o.verstuur) return o.verstuur(v);
      await new Promise((k) => setTimeout(k, 5));
      return { status: 200, j: { ok: true, modus: 'versturen', message_id: 'msg-' + log.verstuur.length, ref: v.ref } };
    },
    concept: async (c) => { log.concept.push(c); if (o.concept) return o.concept(c); return { ok: true, concept_id: 'r-1', bijlagen: 1 }; },
    bericht: async (t) => { log.bericht.push(t); },
  };
  return io;
}
const op = (iso) => Date.parse(iso);
const ronde = (io, iso, x) => B.ronde(io, Object.assign({ nu: op(iso), modus: 'auto', vanaf: '2026-12', van: VAN }, x || {}));
const DO = '2026-12-03T09:10:00Z';   // donderdag 3 december 10:10 Amsterdam

test('leesPlay: gemeten vorm', () => {
  const p = B.leesPlay(playMail());
  assert.equal(p.fout, undefined);
  assert.equal(p.n, 7); assert.equal(p.reeks, REEKS); assert.equal(p.dag, '2026-12-02'); assert.equal(p.tijd, '20:05:42');
  assert.equal(p.product, B.ABO.product); assert.equal(p.door, 'Google LLC'); assert.equal(p.totaal_centen, 799); assert.equal(p.btw_centen, 139); assert.equal(p.betaal, 'paypal'); assert.equal(p.per_maand, true);
});
test('leesPlay: andere afzender, twee items, onleesbare datum → fout', () => {
  assert.ok(B.leesPlay(Object.assign(playMail(), { van: 'Google Play <nep@voorbeeld.nl>' })).fout);
  assert.ok(B.leesPlay(playMail({ extraItem: true })).fout);
  assert.ok(B.leesPlay(playMail({ dag: '2 xyz 2026' })).fout);
  assert.equal(B.leesPlay(playMail({ betaal: 'Creditcard ••0000' })).betaal, 'anders');
});
test('leesPaypal: Engels en Nederlands', () => {
  for (const nl of [false, true]) {
    const q = B.leesPaypal(paypalMail({ nl }));
    assert.equal(q.fout, undefined, JSON.stringify(q));
    assert.equal(q.bedrag_centen, 799); assert.equal(q.transactie_id, 'PROEF00000000001X'); assert.equal(q.invoice_id, '900000000000000001'); assert.equal(q.dag, '2026-12-02');
    assert.equal(q.rekening_eind, '0042'); assert.ok(q.aan.indexOf('Google Payment Irel') === 0);
  }
  assert.ok(B.leesPaypal(Object.assign(paypalMail(), { van: 'PayPal <service@nep.example>' })).fout);
});
test('controle: alles klopt; en elke afwijking rood', () => {
  const p = B.leesPlay(playMail()), q = B.leesPaypal(paypalMail());
  assert.deepEqual(B.controle({ termijn: '2026-12', play: p, paypal: q, rekeningen: REK }).redenen, []);
  assert.ok(B.controle({ termijn: '2026-12', play: p, paypal: q }).redenen.some((r) => /andere rekening/.test(r)));   // zonder Tolgaarde-rekening in Facturen: niet automatisch
  assert.equal(B.verwachtN('2026-11'), 6); assert.equal(B.verwachtN('2027-01'), 8);
  const rood = (x, re) => { const c = B.controle(Object.assign({ termijn: '2026-12', play: p, paypal: q, rekeningen: REK }, x)); assert.equal(c.ok, false); assert.ok(c.redenen.some((r) => re.test(r)), JSON.stringify(c.redenen)); };
  rood({ play: B.leesPlay(playMail({ prijs: '8,99', totaal: '8,99', btw: '1,56' })) }, /andere prijs/);
  rood({ play: B.leesPlay(playMail({ product: 'Google One Premium' })) }, /ander product/);
  rood({ play: B.leesPlay(playMail({ n: 9 })) }, /verwacht \.\.7/);
  rood({ play: B.leesPlay(playMail({ reeks: 'SOP.0000-0000-0000-00000..' })) }, /hoort niet bij/);
  rood({ eerder_n: [7] }, /al eerder/);
  rood({ termijn: '2027-01' }, /niet van januari/);
  rood({ paypal: B.leesPaypal(paypalMail({ rek: '0000' })) }, /andere rekening/);
  rood({ paypal: B.leesPaypal(paypalMail({ bedrag: '9,99' })) }, /PayPal-bedrag/);
  rood({ paypal: B.leesPaypal(paypalMail({ dag: '9 Dec 2026' })) }, /meer dan een dag/);
  rood({ paypal: null }, /PayPal-bewijs ontbreekt/);
  rood({ play: B.leesPlay(playMail({ betaal: 'Creditcard ••0000' })) }, /niet met PayPal/);
});
test('PDF en mail: vaste tekst, één pagina, bedragen kloppen', () => {
  const g = B.gegevens('2026-12', B.leesPlay(playMail()), B.leesPaypal(paypalMail()));
  const s = B.maak(g, { gemaakt: '2026-12-03T09:10:00Z', gemaakt_dag: '2026-12-03', wijze: 'auto', vrijgegeven_dag: '2026-11-04' });
  assert.equal(s.pdf.slice(0, 5).toString('latin1'), '%PDF-');
  assert.ok(s.pdf.length < 250 * 1024);
  assert.equal(s.naam, 'Boekstuk-Google-Home-2026-12.pdf');
  assert.equal(s.mail.onderwerp, 'Boekstuk Google Home Premium Advanced december 2026 — Tolgaarde');
  assert.ok(s.mail.onderwerp.indexOf('Boekstuk Google Home Premium Advanced') === 0);
  assert.match(s.mail.bericht, /^Beste pa,\n\nHierbij het boekstuk voor Google Home Premium Advanced van december 2026 \(€ 7,99, Tolgaarde\)\. Google levert hiervoor geen factuur\.\n\nDit bericht is automatisch verstuurd namens David\.$/);
  assert.match(B.mail(g, { wijze: 'concept' }).bericht, /Groet,\nDavid$/);
  let tekst = null;
  try { tekst = execFileSync('/usr/bin/pdftotext', ['-q', '-enc', 'UTF-8', '-', '-'], { input: s.pdf }).toString(); } catch (e) { tekst = null; }
  if (tekst !== null) {
    for (const w of ['Aankoopverantwoording', 'Huisartsenpraktijk Tolgaarde B.V.', '6,60', '1,39', '7,99', REEKS + '7', 'PROEF00000000001X', 'vrijgegeven 4 november 2026', 'december 2026']) assert.ok(tekst.includes(w), w);
    assert.equal((tekst.match(/\f/g) || []).length, 1);
  }
});
test('ronde: buiten het venster niets (vóór de 3e, weekend, vóór 09:00, vóór de eerste maand)', async () => {
  for (const t of ['2026-12-02T10:00:00Z', '2026-12-05T10:00:00Z', '2026-12-03T07:30:00Z', '2026-11-03T10:00:00Z']) {
    const io = nepIo();
    const u = await ronde(io, t);
    assert.equal(u.stap, 'niets', t); assert.equal(io.log.zoek.length, 0);
  }
});
test('ronde: alles klopt en vrijgegeven → één keer versturen, één regel, daarna niets meer', async () => {
  const io = nepIo();
  const u = await ronde(io, DO);
  assert.equal(u.stap, 'verstuurd', JSON.stringify(u));
  assert.equal(io.log.verstuur.length, 1);
  const v = io.log.verstuur[0];
  assert.equal(v.bron, 'boekstuk'); assert.equal(v.modus, 'versturen'); assert.equal(v.aan, AAN); assert.equal(v.ref, 'BS202612'); assert.equal(v.van, VAN);
  assert.equal(v.bijlage.naam, 'Boekstuk-Google-Home-2026-12.pdf'); assert.equal(v.bijlage.bytes.slice(0, 4).toString(), '%PDF');
  assert.equal(io.rijen.get('2026-12').status, 'verstuurd'); assert.equal(io.rijen.get('2026-12').message_id, 'msg-1');
  assert.deepEqual(io.log.bericht, ['Boekstuk Google Home december 2026 aan je vader gestuurd.']);
  const u2 = await ronde(io, '2026-12-03T09:20:00Z');
  assert.equal(u2.stap, 'al'); assert.equal(io.log.verstuur.length, 1); assert.equal(io.log.concept.length, 0);
});
test('ronde: twee rondes tegelijk → één verzending (de reservering is de grens)', async () => {
  const io = nepIo();
  const [a, b] = await Promise.all([ronde(io, DO), ronde(io, DO)]);
  assert.equal(io.log.verstuur.length, 1, JSON.stringify([a, b]));
  assert.deepEqual([a.stap, b.stap].sort(), ['al', 'verstuurd']);
});
test('ronde: niet vrijgegeven, modus concept of andere vrijgave → concept aan de boekhouder met reden', async () => {
  for (const [x, re] of [[{ vrijgave: null }, /nog niet door jou vrijgegeven/], [{ modus: 'concept' }, /staat uit op de pod/],
    [{ vrijgave: { id: 1, vraag_id: 'x', bevestiging: B.BEVESTIGING, bevestigd_op: '2026-11-04', abo_hash: B.aboHash('ander@voorbeeld.nl') } }, /geldt niet meer/],
    [{ vrijgave: { id: 1, vraag_id: 'x', bevestiging: 'knop-ja-kaart', bevestigd_op: '2026-11-04', abo_hash: B.aboHash(AAN) } }, /geldt niet meer/]]) {
    const io = nepIo(x);
    const u = await ronde(io, DO, x.modus ? { modus: x.modus } : undefined);
    assert.equal(u.stap, 'concept', JSON.stringify(u)); assert.equal(io.log.verstuur.length, 0);
    assert.equal(io.log.concept.length, 1); assert.equal(io.log.concept[0].aan, AAN); assert.match(io.log.concept[0].bericht, /Groet,\nDavid$/);
    assert.equal(io.log.concept[0].bijlage.naam, 'Boekstuk-Google-Home-2026-12.pdf');
    assert.match(io.log.bericht[0], re); assert.match(io.log.bericht[0], /staat als concept/);
    assert.equal(io.rijen.get('2026-12').status, 'concept');
  }
});
test('ronde: andere prijs of verkeerd bestelnummer → concept, nooit versturen', async () => {
  for (const play of [playMail({ prijs: '8,99', totaal: '8,99', btw: '1,56' }), playMail({ n: 8 })]) {
    const io = nepIo({ mails: [play, paypalMail()] });
    const u = await ronde(io, DO);
    assert.equal(u.stap, 'concept'); assert.equal(io.log.verstuur.length, 0); assert.equal(io.log.concept.length, 1);
  }
});
test('ronde: na 12:00 → concept; verzender niet in orde → wachten, om 12:00 concept', async () => {
  let io = nepIo();
  let u = await ronde(io, '2026-12-03T11:05:00Z');
  assert.equal(u.stap, 'concept'); assert.match(io.log.bericht[0], /vóór 12:00/);
  io = nepIo({ verzenderOk: false });
  u = await ronde(io, DO);
  assert.equal(u.stap, 'wacht'); assert.ok(u.fouten.includes('toetsen')); assert.equal(io.rijen.size, 0);
  u = await ronde(io, '2026-12-03T11:00:00Z');
  assert.equal(u.stap, 'concept'); assert.equal(io.log.verstuur.length, 0);
});
test('ronde: verzender weigert (4xx, ok false) → concept; geen antwoord → onzeker, nooit opnieuw', async () => {
  let io = nepIo({ verstuur: () => ({ status: 403, j: { ok: false, code: 'witte_lijst' } }) });
  let u = await ronde(io, DO);
  assert.equal(u.stap, 'concept'); assert.equal(io.log.concept.length, 1); assert.match(io.log.bericht[0], /weigerde \(witte_lijst\)/);
  io = nepIo({ verstuur: () => { const e = new Error('verzendgeheim ontbreekt'); e.zekerNietVerstuurd = true; throw e; } });
  u = await ronde(io, DO);
  assert.equal(u.stap, 'concept');
  io = nepIo({ verstuur: () => ({ status: 0, j: null }) });
  u = await ronde(io, DO);
  assert.equal(u.stap, 'onzeker'); assert.equal(io.log.concept.length, 0); assert.equal(io.log.bericht.length, 0);
  const r = io.rijen.get('2026-12'); r.bijgewerkt_op = '2026-12-03T09:10:00Z';
  u = await ronde(io, '2026-12-03T15:00:00Z');
  assert.equal(u.stap, 'al'); assert.equal(io.log.verstuur.length, 1);
  u = await ronde(io, '2026-12-04T10:00:00Z');   // > 24 uur, niet in Verzonden → één regel
  assert.equal(u.stap, 'onzeker_gemeld'); assert.equal(io.log.bericht.length, 1); assert.match(io.log.bericht[0], /geen bevestiging/);
  u = await ronde(io, '2026-12-05T10:00:00Z');
  assert.equal(u.stap, 'al'); assert.equal(io.log.bericht.length, 1); assert.equal(io.log.verstuur.length, 1);
});
test('ronde: onzeker en na 24 uur wel in Verzonden → verstuurd, geen regel', async () => {
  const io = nepIo({ verstuur: () => ({ status: 502, j: { ok: false, code: 'gmail_verzend' } }), verzonden: [] });
  let u = await ronde(io, DO);
  assert.equal(u.stap, 'onzeker');
  io.rijen.get('2026-12').bijgewerkt_op = '2026-12-03T09:10:00Z';
  const io2 = Object.assign({}, io, { zoek: async (q) => (/^in:sent/.test(q) ? { mails: [{ id: 's1', onderwerp: 'Boekstuk Google Home Premium Advanced december 2026 — Tolgaarde' }] } : io.zoek(q)) });
  u = await ronde(io2, '2026-12-04T10:00:00Z');
  assert.equal(u.stap, 'onzeker_gevonden'); assert.equal(io.rijen.get('2026-12').status, 'verstuurd'); assert.equal(io.log.bericht.length, 0);
});
test('ronde: blijven hangen in verzenden (herstart) → onzeker, niet opnieuw', async () => {
  const io = nepIo();
  io.rijen.set('2026-12', { termijn: '2026-12', status: 'verzenden', n: 7, aan: AAN, aangemaakt_op: '2026-12-03T08:40:00Z', bijgewerkt_op: '2026-12-03T08:40:00Z' });
  const u = await ronde(io, DO);
  assert.equal(io.rijen.get('2026-12').status, 'onzeker'); assert.equal(io.log.verstuur.length, 0); assert.equal(u.stap, 'al');
});
test('ronde: blijven hangen in concept_bezig (herstart) → concept_onzeker met één regel (review MOET 2)', async () => {
  const io = nepIo();
  io.rijen.set('2026-12', { termijn: '2026-12', status: 'concept_bezig', n: 7, aan: AAN, aangemaakt_op: '2026-12-03T08:40:00Z', bijgewerkt_op: '2026-12-03T08:40:00Z' });
  let u = await ronde(io, DO);
  assert.equal(u.stap, 'concept_onzeker'); assert.equal(io.rijen.get('2026-12').status, 'concept_onzeker'); assert.equal(io.log.bericht.length, 1); assert.match(io.log.bericht[0], /Concepten/);
  u = await ronde(io, '2026-12-03T09:30:00Z');
  assert.equal(u.stap, 'al'); assert.equal(io.log.bericht.length, 1); assert.equal(io.log.concept.length + io.log.verstuur.length, 0);
});
test('PDF: sha256 is die van de bytes van de bijlage (review ZOU 1)', () => {
  const g = B.gegevens('2026-12', B.leesPlay(playMail()), B.leesPaypal(paypalMail()));
  const s = B.maak(g, { gemaakt: '2026-12-03T09:10:00Z', gemaakt_dag: '2026-12-03' });
  assert.equal(s.sha256, require('crypto').createHash('sha256').update(s.pdf).digest('hex'));
});
test('ronde: mail ontbreekt vóór de 6e → wachten; op de 6e één regel, geen concept', async () => {
  const io = nepIo({ mails: [paypalMail()] });
  let u = await ronde(io, DO);
  assert.equal(u.stap, 'wacht'); assert.equal(io.log.bericht.length, 0);
  u = await ronde(io, '2026-12-07T09:30:00Z');   // maandag 7 december (de 6e is zondag)
  assert.equal(u.stap, 'niet_gemaakt'); assert.equal(io.log.bericht.length, 1); assert.equal(io.log.concept.length, 0);
  u = await ronde(io, '2026-12-08T09:30:00Z');
  assert.equal(u.stap, 'al'); assert.equal(io.log.bericht.length, 1);
  const io2 = nepIo({ mails: [playMail()] });
  u = await ronde(io2, DO);
  assert.equal(u.stap, 'wacht'); assert.match(u.reden, /PayPal/);
});
test('ronde: al door David in Verzonden → niets versturen; twijfel → concept', async () => {
  let io = nepIo({ verzonden: [{ id: 's1', onderwerp: 'Boekstuk Google Home december' }] });
  let u = await ronde(io, DO);
  assert.equal(u.stap, 'door_david'); assert.equal(io.log.verstuur.length, 0); assert.equal(io.log.concept.length, 0);
  assert.ok(io.log.zoek.some((q) => q.indexOf('in:sent to:' + AAN + ' ') === 0 && q.indexOf('filename:"Boekstuk-Google-Home-2026-12.pdf"') > 0));
  io = nepIo({ verzonden: [{ id: 's2', onderwerp: 'Bonnetjes' }] });
  u = await ronde(io, DO);
  assert.equal(u.stap, 'concept'); assert.equal(io.log.verstuur.length, 0); assert.match(io.log.bericht[0], /Verzonden/);
});
test('ronde: lees-luik faalt → geen meting, niets gedaan', async () => {
  const io = nepIo({ luikFout: true });
  const u = await ronde(io, DO);
  assert.ok(u.fouten.includes('luik')); assert.equal(io.rijen.size, 0); assert.equal(io.log.verstuur.length, 0);
});
test('ronde: geen adres van de boekhouder → niet gemaakt, één regel', async () => {
  const io = nepIo({ aan: null });
  const u = await ronde(io, DO);
  assert.equal(u.stap, 'niet_gemaakt'); assert.equal(io.log.verstuur.length + io.log.concept.length, 0); assert.match(io.log.bericht[0], /boekhouder/);
});
test('ronde: concept mislukt zeker → concept_mislukt met regel', async () => {
  const io = nepIo({ vrijgave: null, concept: () => { const e = new Error('mailconcept http 400'); e.zeker = true; e.reden = 'het mailluik weigerde het concept'; throw e; } });
  const u = await ronde(io, DO);
  assert.equal(u.stap, 'concept_mislukt'); assert.equal(io.rijen.get('2026-12').status, 'concept_mislukt'); assert.match(io.log.bericht[0], /kon ik niet klaarzetten/);
});
test('vrijgavekaart: gevoelig besluit, grenzen, toets op de kaart en het adres', () => {
  const k = B.kaartVrijgave({ id: 3, aan: AAN, voorbeeld: 'proef' });
  assert.equal(k.sleutel, 'boekstuk-vrijgave-3'); assert.equal(k.soort, 'besluit'); assert.ok(k.titel.endsWith('?')); assert.ok(k.titel.length <= 90);
  assert.ok(k.waarom.length <= 400); assert.ok(k.stappen.length <= 12); assert.match(k.titel, /versturen/);
  assert.ok(!JSON.stringify(k).match(/wv\d|\/opt\/|_Systeem|01_Ontwikkeling/));
  const p = Object.assign({}, k);
  const v = { id: 3, kaart_tekst_hash: B.kaartHash(p), abo_hash: B.aboHash(AAN), vraag_id: null, ingetrokken_op: null };
  assert.equal(B.vrijgaveToets(p, v, AAN), null);
  assert.match(B.vrijgaveToets(Object.assign({}, p, { titel: p.titel + ' ' }), v, AAN), /niet meer de kaart/);
  assert.match(B.vrijgaveToets(p, Object.assign({}, v, { vraag_id: 'x' }), AAN), /al vrijgegeven/);
  assert.match(B.vrijgaveToets(p, Object.assign({}, v, { ingetrokken_op: 'x' }), AAN), /ingetrokken/);
  assert.match(B.vrijgaveToets(p, v, 'ander@voorbeeld.nl'), /veranderde/);
  assert.match(B.vrijgaveToets(Object.assign({}, p, { sleutel: 'boekstuk-vrijgave-4' }), v, AAN), /hoort niet/);
  assert.equal(B.vrijgaveGeldig(Object.assign({}, v, { vraag_id: 'x', bevestiging: B.BEVESTIGING }), AAN), true);
  assert.equal(B.vrijgaveGeldig(Object.assign({}, v, { vraag_id: 'x', bevestiging: 'knop-ja-vers-vast-kaart' }), AAN), false);
});
test('migratie 19: tabellen, unieke n, alleen vooruit, rijen blijven', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boekstuk-'));
  try {
    const f = D.open(dir);
    assert.equal(f.schema, D.SCHEMA_VERSIE); assert.ok(D.SCHEMA_VERSIE >= 19);
    const ins = f.db.prepare("INSERT INTO boekstuk_verzending (abonnement, termijn, status, n, aangemaakt_op, bijgewerkt_op) VALUES ('google-home', ?, ?, ?, 'x', 'x')");
    assert.equal(Number(ins.run('2026-12', 'verzenden', 7).changes), 1);
    // zelfde termijn: de reservering is de grens (server.js herkent precies deze melding als "bestond al")
    assert.throws(() => ins.run('2026-12', 'concept_bezig', 7), /UNIQUE constraint failed: boekstuk_verzending\.abonnement, boekstuk_verzending\.termijn$/);
    assert.throws(() => ins.run('2027-01', 'verzenden', 7), /UNIQUE constraint failed: boekstuk_verzending\.abonnement, boekstuk_verzending\.n$/);   // bestelnummer geen tweede keer
    assert.equal(Number(ins.run('2027-02', 'concept_bezig', 7).changes), 1);   // een concept mag (David beslist)
    const zet = (t, st) => f.db.prepare('UPDATE boekstuk_verzending SET status = ? WHERE termijn = ?').run(st, t);
    zet('2026-12', 'verstuurd');
    assert.throws(() => zet('2026-12', 'verzenden'), /alleen vooruit/);
    assert.throws(() => zet('2027-02', 'verstuurd'), /alleen vooruit/);
    assert.throws(() => f.db.prepare("UPDATE boekstuk_verzending SET n = 8 WHERE termijn = '2026-12'").run(), /alleen vooruit/);
    assert.throws(() => f.db.prepare('DELETE FROM boekstuk_verzending').run(), /blijven/);
    assert.throws(() => ins.run('2027-03', 'ergens', 9), /CHECK/);
    f.db.prepare("INSERT INTO boekstuk_vrijgave (abonnement, aan, abo_hash, aangemaakt_op) VALUES ('google-home', ?, ?, 'x')").run(AAN, B.aboHash(AAN));
    assert.throws(() => f.db.prepare("UPDATE boekstuk_vrijgave SET vraag_id = 'x'").run(), /CHECK/);   // vraag_id alleen met bevestiging en tijd
    assert.throws(() => f.db.prepare('DELETE FROM boekstuk_vrijgave').run(), /blijven/);
    D.sluit(f);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
