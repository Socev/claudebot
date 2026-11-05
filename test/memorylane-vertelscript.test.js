'use strict';
// Toetsen van het vertelscript voor "Als verhaal vertellen" (wv2484). Nep-Claude (SDK-klasse), tijdelijke map.
// ALLEEN VERZONNEN TEKST. Aanroep: bash test/memorylane-vertelscript.sh
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require(path.join(__dirname, '..', 'memorylane-vertelscript.js'));

const HID = 'h0123456789abcdef';
const TITEL = 'Proefkamp bij het meer';
const VERHAAL = 'In de zomer van 1987 gingen we met Proefoom Gerrit naar het meer bij Verzinwijk. Het regende drie dagen. ' +
  'We sliepen in een oude tent die lekte.\n\nOp de laatste avond scheen de zon en zwommen we tot het donker was. Ik weet nog hoe koud het water was.';
const BRON = TITEL + '\n\n' + VERHAAL;

function nepSdk(plan, log) {
  class Nep {
    constructor(x) { log.opties = x; this.beta = { messages: { stream: (p) => ({ finalMessage: async () => { log.vragen.push(p); const f = plan.shift(); return f(p); } }) } }; }
  }
  return () => ({ klasse: Nep, bron: 'nep' });
}
const antwoord = (script) => () => ({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 900 },
  content: [{ type: 'text', text: JSON.stringify({ script }) }] });
function opzet(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mls-'));
  const log = { vragen: [], fouten: [] };
  const s = S.maak({ dir, nu: () => Date.parse('2026-11-05T15:00:00Z'), fout: (l, e) => log.fouten.push(l + ': ' + e.message), sleutel: async () => 'nep-sleutel', sdk: nepSdk(plan, log) });
  return { dir, log, s };
}

test('tags: alleen uit de lijst, genormaliseerd, hooguit twee per haakje; de rest gaat eruit', () => {
  assert.strictEqual(S.tagVan('Laughs'), '[laughs]');
  assert.strictEqual(S.tagVan(' softly ,  thoughtful '), '[softly, thoughtful]');
  for (const x of ['gunshot', 'lacht zacht', 'warm', 'softly, thoughtful, sighs', 'British accent', 'pirate voice', '']) assert.strictEqual(S.tagVan(x), null, x);
  const r = S.schoonScript('# Kop\n**[softly]** Het was ==Proefdorp== stil. [gunshot] Toen [lacht zacht] kwam de zon. <b>vet</b> [pause] Klaar.');
  assert.strictEqual(r.tekst, 'Kop\n[softly] Het was Proefdorp stil. Toen kwam de zon. vet [pause] Klaar.');
  assert.strictEqual(r.tags, 2); assert.strictEqual(r.weg, 2);
  assert.ok(S.TAGS.every((t) => /^[a-z ]+$/.test(t)), 'tags zijn Engelse namen');
  assert.ok(!S.TAGS.some((t) => /accent|voice|gunshot|explosion|applause|fart|sings/.test(t)), 'geen geluidseffecten of personages');
});

test('feitentoets: een naam, getal of maand die niet in het verhaal staat valt op; tags tellen niet mee', () => {
  const goed = '[thoughtful] Proefkamp bij het meer. [softly] In de zomer van 1987 gingen we met Proefoom Gerrit naar het meer. Het regende drie dagen… [laughs] De tent lekte.';
  assert.strictEqual(S.toetsScript(goed, BRON).goed, true);
  for (const [fout, woord] of [['We gingen met Truus naar het meer.', 'Truus'], ['Het regende vier dagen.', 'vier'], ['In juli was het koud.', 'juli'], ['Dat was in 1988.', '1988']]) {
    const t = S.toetsScript(goed + ' ' + fout, BRON);
    assert.strictEqual(t.goed, false, fout); assert.ok(t.treffers.includes(woord), woord + ' gevonden'); assert.strictEqual(t.fout_zinnen.size, 1);
  }
  assert.strictEqual(S.toetsScript((VERHAAL + ' ').repeat(2), BRON).te_lang, true, 'twee keer zo lang = te lang');
  // review MOET 2: een gevoel of handeling die niet in het verhaal staat valt ook op; vertelwoorden mogen
  for (const [fout, woord] of [['Ik was bang.', 'bang'], ['We huilden samen.', 'huilden'], ['Mijn vader zong een lied.', 'vader']]) {
    const t = S.toetsScript(goed + ' ' + fout, BRON);
    assert.strictEqual(t.goed, false, fout); assert.ok(t.treffers.includes(woord), woord + ' gevonden ' + t.treffers);
  }
  assert.strictEqual(S.toetsScript(goed + ' Ik weet het nog goed… het water was koud.', BRON).goed, true, 'vertelwoorden en woorden uit het verhaal');
  for (const x of ['nervous', 'vulnerable', 'tired', 'startled', 'crying']) assert.strictEqual(S.tagVan(x), null, 'geen gevoelstag ' + x);
});

test('besluit: één verzonnen zin gaat eruit; te veel verzonnen = het verhaal zelf zonder tags', () => {
  const s = '[softly] Proefkamp bij het meer. In de zomer van 1987 gingen we naar het meer. Truus was er ook. Het regende drie dagen. We sliepen in een tent. Ik weet nog hoe koud het water was.';
  const b = S.besluit(s, BRON);
  assert.strictEqual(b.terugval, false); assert.strictEqual(b.weggelaten, 1);
  assert.ok(!/Truus/.test(b.script) && b.script.startsWith('[softly] Proefkamp'));
  const veel = 'Truus kwam. Kees kwam. Het was 1990. Het regende drie dagen.';
  const t = S.besluit(veel, BRON);
  assert.strictEqual(t.terugval, true); assert.strictEqual(t.script, BRON); assert.strictEqual(t.tags, 0);
  assert.strictEqual(S.besluit('', BRON).terugval, true, 'leeg = terugval, nooit geen verhaal');
});

test('schrijf: eerste versie verzint, tweede krijgt de woorden mee en is goed; bewaard 0600 met de verhaalhash, geen tekst in info', async () => {
  const x = opzet([antwoord('[softly] Proefkamp bij het meer. We gingen met Truus naar het meer.'),
    antwoord('[thoughtful] Proefkamp bij het meer.\n\n[softly] In de zomer van 1987 gingen we met Proefoom Gerrit naar het meer bij Verzinwijk. Het regende drie dagen… [laughs] De tent lekte.')]);
  const u = await x.s.schrijf(HID, TITEL, VERHAAL, 'hash-proef');
  assert.strictEqual(u.ok, true); assert.strictEqual(u.terugval, false); assert.strictEqual(u.weggelaten, 0);
  assert.ok(u.script.includes('[laughs]') && !/Truus/.test(u.script));
  assert.strictEqual(x.log.vragen.length, 2);
  const p1 = x.log.vragen[0], p2 = x.log.vragen[1];
  assert.strictEqual(p1.tools, undefined, 'zonder tools');
  assert.ok(p1.messages[0].content[0].text.includes('<verhaal>\n' + VERHAAL + '\n</verhaal>'), 'verhaal als gegeven tekst');
  assert.ok(p1.system[0].text.includes('Verzin NIETS') && p1.system[0].text.includes('[softly]'));
  assert.ok(p2.messages[0].content[0].text.includes('Truus'), 'tweede vraag noemt het verzonnen woord');
  assert.strictEqual(x.log.opties.logLevel, 'off'); assert.strictEqual(x.log.opties.apiKey, 'nep-sleutel');
  assert.ok(u.eur > 0 && u.eur < 0.1, 'kosten van twee aanroepen');
  const f = path.join(x.dir, 'vertelscript', HID + '.json');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(x.dir, 'vertelscript')).mode & 0o777, 0o700);
  const l = x.s.lees(HID);
  assert.strictEqual(l.bron_hash, 'hash-proef'); assert.strictEqual(l.script, u.script); assert.strictEqual(l.pogingen, 2);
  assert.ok(!/Proef|meer|tent/.test(JSON.stringify(x.s.info())), 'geen tekst in info');
  assert.strictEqual(x.s.info().scripts, 1);
  assert.deepStrictEqual(x.log.fouten, []);
});

test('schrijf: twee keer een verzonnen zin = die zin weg; dienstfout = niets bewaard; opruim en wis', async () => {
  const s = '[softly] Proefkamp bij het meer. In de zomer van 1987 gingen we naar het meer. Truus was er ook. Het regende drie dagen. We sliepen in een tent. Ik weet nog hoe koud het water was.';
  const x = opzet([antwoord(s), antwoord(s)]);
  const u = await x.s.schrijf(HID, TITEL, VERHAAL, 'h1');
  assert.strictEqual(u.ok, true); assert.strictEqual(u.weggelaten, 1); assert.ok(!/Truus/.test(u.script));
  const y = opzet([() => { const e = new Error('weg'); e.status = 529; throw e; }]);
  const v = await y.s.schrijf(HID, TITEL, VERHAAL, 'h1');
  assert.strictEqual(v.ok, false); assert.match(v.fout, /Claude gaf geen antwoord/);
  assert.strictEqual(y.s.lees(HID), null);
  assert.ok(y.log.fouten.every((f) => !/Proef|meer/.test(f)), 'fout zonder tekst');
  const z = opzet([]);
  assert.strictEqual((await z.s.schrijf(HID, TITEL, '', 'h')).ok, false, 'zonder verhaal geen aanroep');
  assert.strictEqual(z.log.vragen.length, 0);
  assert.strictEqual(x.s.opruim(() => true), 0);
  assert.strictEqual(x.s.opruim(() => false), 1);
  assert.strictEqual(x.s.lees(HID), null);
  assert.strictEqual(x.s.wis(HID), true);
});
