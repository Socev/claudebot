'use strict';
// Toetsen voor wv4103 (besluit nr 411 / 3C111): de vaste mails van Facturen en POT aan André halen aanhef en slot uit één bron, de sectie
// "Aanhef en slot per vaste ontvanger" van het mailstem-correctiebestand. Alles verzonnen; raakt de vault niet (de lezer is een functie
// met een vaste tekst). Draaien: bash test/facturen-aanhef.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FA = require(path.join(ROOT, 'facturen-aanhef.js'));
const SP = require(path.join(ROOT, 'facturen-specificatie.js'));
const MS = require(path.join(ROOT, 'facturen-maandspec.js'));
const BS = require(path.join(ROOT, 'facturen-boekstuk.js'));
const PA = require(path.join(ROOT, 'pot-afschrift.js'));

const BRON = (regel) => [
  '# Mailstem — correcties van David', '', '## Correcties', '', '- André: aanhef "Fout," · slot "Fout"   (buiten de sectie: telt niet)', '',
  '## Aanhef en slot per vaste ontvanger', '', 'Uitleg die niet meetelt.', regel, '', '## Daarna', '- André: aanhef "Ook fout,"'].join('\n');

// verzonnen invoer per mail (vorm zoals de makers die verwachten)
const sepa = { entiteit: 'tolgaarde', entiteit_naam: 'Proefpraktijk', entiteit_kort: 'Proef', rekening_eind: '0041', aantal: 1, totaal_centen: 12345, msg_id: 'PROEF-MSG-1',
  blokken: [{ datum: '2026-12-01', totaal_centen: 12345, aantal: 1, regels: [{ leverancier: 'Leverancier A B.V.', nummer: 'F-1', centen: 12345 }] }] };
const maand = { maand_naam: 'november 2026', entiteiten: ['tolgaarde'], paypal: null, kaarten: [] };
const boek = { maand_naam: 'november 2026', play: { totaal_centen: 799 } };
const mails = () => ({
  sepa: SP.mail(sepa).bericht,
  maandspec: MS.mail(maand).bericht,
  boekstuk_concept: BS.mail(boek, { wijze: 'concept' }).bericht,
  boekstuk_auto: BS.mail(boek, { wijze: 'auto' }).bericht,
  pot: PA.mailConcept('2026-11', { stuk_open: 0 }, {}).bericht,
  pot_correctie: PA.mailConcept('2026-11', { stuk_open: 0 }, { correctie: true }).bericht,
});
const kop = (t) => t.split('\n')[0];
const staart = (t) => t.split('\n').slice(-2).join('\n');

test('zonder lezer: exact de oude tekst (terugval)', () => {
  FA.zetLezer(null);
  const m = mails();
  assert.equal(kop(m.sepa), 'Ha pa,'); assert.equal(staart(m.sepa), 'Groet,\nDavid');
  assert.equal(kop(m.maandspec), 'Ha pa,'); assert.equal(staart(m.maandspec), 'Groet,\nDavid');
  assert.equal(kop(m.boekstuk_concept), 'Beste pa,'); assert.equal(staart(m.boekstuk_concept), 'Groet,\nDavid');
  assert.match(m.boekstuk_auto, /^Beste pa,\n\nHierbij het boekstuk voor Google Home Premium Advanced van november 2026 \(€ 7,99, Tolgaarde\)\. Google levert hiervoor geen factuur\.\n\nDit bericht is automatisch verstuurd namens David\.$/);
  assert.equal(kop(m.pot), 'Hoi André,'); assert.equal(staart(m.pot), 'Groet,\nDavid');
  assert.equal(kop(m.pot_correctie), 'Hoi André,');
});

test('één regel op één plek: alle vaste mails aan André volgen (aanhef en slot)', () => {
  FA.zetLezer(() => BRON('- André (zijn vader): aanhef "Hallo papa," · slot "Liefs, / Davidje"'));
  const m = mails();
  for (const k of ['sepa', 'maandspec', 'boekstuk_concept', 'boekstuk_auto', 'pot', 'pot_correctie']) assert.equal(kop(m[k]), 'Hallo papa,', k);
  for (const k of ['sepa', 'maandspec', 'boekstuk_concept', 'pot', 'pot_correctie']) assert.equal(staart(m[k]), 'Liefs,\nDavidje', k);
  assert.match(m.boekstuk_auto, /Dit bericht is automatisch verstuurd namens David\.$/, 'automatisch boekstuk houdt zijn vaste slotzin');
  // alleen de aanhef: slot blijft de vaste tekst
  FA.zetLezer(() => BRON('- Andre: aanhef "Ha pa,"'));
  const n = mails();
  assert.equal(kop(n.pot), 'Ha pa,'); assert.equal(kop(n.boekstuk_concept), 'Ha pa,'); assert.equal(staart(n.pot), 'Groet,\nDavid');
  FA.zetLezer(null);
});

test('grens: wat niet past telt niet (cijfers, link, @, dubbele punt, te lang, te veel slotregels)', () => {
  const r = (x) => FA.leesRegels(BRON(x)).andre || {};
  assert.deepEqual(r('- André: aanhef "Ha pa, bel 0612345678"'), {});
  assert.deepEqual(r('- André: aanhef "Ha pa https://x.invalid,"'), {});
  assert.deepEqual(r('- André: aanhef "Ha pa@x,"'), {});
  assert.deepEqual(r('- André: aanhef "Let op: betaal,"'), {});
  assert.deepEqual(r('- André: aanhef "' + 'a'.repeat(31) + ',"'), {});
  assert.deepEqual(r('- André: aanhef "Ha pa"'), {}, 'aanhef eindigt op komma of uitroepteken');
  assert.deepEqual(r('- André: slot "Groet, / David / PS bel me"'), {});
  assert.deepEqual(r('- André: slot "Groet, / IBAN NL00"'), {});
  assert.deepEqual(r('- André: aanhef "Ha pa," · slot "Groet, / David"'), { aanhef: 'Ha pa,', slot: ['Groet,', 'David'] });
  // regels buiten de sectie tellen niet; een kapotte lezer = terugval
  assert.deepEqual(FA.leesRegels('## Correcties\n- André: aanhef "Ha pa,"'), {});
  FA.zetLezer(() => { throw new Error('weg'); });
  assert.equal(kop(PA.mailConcept('2026-11', { stuk_open: 0 }, {}).bericht), 'Hoi André,');
  FA.zetLezer(() => 'x'.repeat(262145));
  assert.equal(kop(SP.mail(sepa).bericht), 'Ha pa,');
  FA.zetLezer(null);
});

test('de echte sectie in het correctiebestand heeft de vorm die de pod leest (alleen vorm, geen vault nodig in CI)', () => {
  const fs = require('fs');
  const pad = process.env.WV4103_BRON;
  if (!pad || !fs.existsSync(pad)) return;   // alleen op de pod met WV4103_BRON gezet
  const r = FA.leesRegels(fs.readFileSync(pad, 'utf8'));
  assert.ok(r.andre && r.andre.aanhef && r.andre.slot, 'regel voor André gelezen: ' + JSON.stringify(r));
});
