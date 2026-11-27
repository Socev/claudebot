// wv4131 (2C90): het Weekboek van MemoryLane. Droge zondagen op een tijdelijke map met verzonnen herinneringen, afspraken en een nep-model.
// node --test test/memorylane-weekboek.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../memorylane-weekboek.js');

const ZONDAG = '2026-11-29';   // week 48: ma 23-11 t/m zo 29-11
function h(hid, o) { return Object.assign({ hid, soort: 'los', status: 'actief', titel: 'Verzonnen ' + hid, wanneer: '', datum: '0|x', precisie: null, album: null, personen: [], plaatsen: [] }, o); }
const LIJST = [
  h('h0000000000000001', { soort: 'opname', titel: 'Proefverhaal strand', datum: '1|2015-11-25|2015-11-25', precisie: 'dag', wanneer: '25 november 2015' }),
  h('h0000000000000002', { titel: 'Proefalbum herfst', datum: '1|2019-11-01|2019-11-30', precisie: 'maand', fotodagen: { van: '2019-11-27', tot: '2019-11-28' }, album: { aantal: 40 } }),
  h('h0000000000000003', { titel: 'Te ver weg', datum: '1|2018-07-01|2018-07-01', precisie: 'dag' }),
  h('h0000000000000004', { titel: 'Fotodagen ander jaar', datum: '1|2017-01-01|2017-12-31', precisie: 'jaar', fotodagen: { van: '2016-11-24', tot: '2016-11-24' } }),
  h('h0000000000000005', { titel: 'Dit jaar', datum: '1|2026-11-24|2026-11-24', precisie: 'dag' }),
  h('h0000000000000006', { titel: 'Jaargrens', datum: '1|2012-12-28|2013-01-03', precisie: 'dag' }),
];
const AGENDA = [
  { soort: 'afspraak', sync_agenda: 'gezin', status: 'bevestigd', begin_datum: '2026-11-24', titel: 'Proef: zwemles' },
  { soort: 'afspraak', sync_agenda: 'david', status: 'bevestigd', begin_datum: '2026-11-26', titel: 'Proef: etentje' },
  { soort: 'afspraak', sync_agenda: 'werk', status: 'bevestigd', begin_datum: '2026-11-25', titel: 'Proef: werkoverleg' },
  { soort: 'afspraak', sync_agenda: 'gezin', status: 'geannuleerd', begin_datum: '2026-11-27', titel: 'Proef: afgezegd' },
  { soort: 'dienst', begin_datum: '2026-11-25', titel: 'X' },
];
function goedeTekst(vraag) {
  return 'Goedemorgen. Deze week, elf jaar geleden op 25 november 2015, vertelde je over het strand. ' + 'Het is een week vol kleine dingen. '.repeat(20) + vraag;
}
function maak(over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4131-'));
  const st = { loket: [], box: [], wanneer: [], naam: [], claude: 0, prompt: null };
  const o = Object.assign({ dir, nu: () => Date.parse(ZONDAG + 'T05:10:00Z'),
    lijst: async () => LIJST, verhaal: async () => 'Verzonnen verhaaltekst over een dag aan zee.',
    agenda: async () => AGENDA, reizen: async () => [{ titel: 'Proefreis', van: '2026-11-20', tot: '2026-11-23' }, { titel: 'Oud', van: '2026-01-01', tot: '2026-01-05' }],
    fotos: async () => ({ '2026-11-24': 12, '2026-11-25': 2 }),
    claude: async (sys, prompt) => { st.claude++; st.prompt = prompt; return { ok: true, data: { titel: 'Zwemles en een etentje', tekst: goedeTekst('Wat zei je dochter na de zwemles?'), vraag: 'Wat zei je dochter na de zwemles?' }, verbruik: { in: 10, uit: 20, kosten: 0.01, account: 2 } }; },
    opnameHid: (rid) => (rid === 'r20261129-00000000000000aa' ? 'h00000000000000aa' : null),
    wanneer: (hid, d) => { st.wanneer.push([hid, d]); return { status: 200 }; },
    naamgeving: (hid, t) => { st.naam.push([hid, t]); return { ok: true }; },
    loket: async (m) => { st.loket.push(m); }, box: (t) => st.box.push(t) }, over || {});
  return { m: W.maak(o), st, dir };
}

test('weekVan: ISO-week ma–zo', () => {
  assert.deepStrictEqual(W.weekVan('2026-11-29'), { id: '2026-W48', nr: 48, jaar: 2026, van: '2026-11-23', tot: '2026-11-29' });
  assert.strictEqual(W.weekVan('2027-01-03').id, '2026-W53');
  assert.strictEqual(W.weekVan('2027-01-10').id, '2027-W01');
});

test('kies: alleen eerdere jaren in deze week; verhaal eerst; fotodagen alleen als ze bij het jaar passen; jaargrens', () => {
  const k = W.kies(LIJST, W.weekVan(ZONDAG)).map((x) => x.h.hid);
  assert.deepStrictEqual(k, ['h0000000000000001', 'h0000000000000002']);
  const kerst = W.kies(LIJST, W.weekVan('2027-01-03')).map((x) => x.h.hid);
  assert.ok(kerst.includes('h0000000000000006'), 'reis over de jaargrens telt');
});

test('weekStof: david+gezin, niet geannuleerd, werk niet; reis die de week raakt; fotodag ≥ 5 telt', () => {
  const s = W.weekStof(W.weekVan(ZONDAG), AGENDA, [{ titel: 'R', van: '2026-11-20', tot: '2026-11-23' }], { '2026-11-24': 12, '2026-11-25': 2 });
  assert.deepStrictEqual(s.afspraken.map((a) => a.titel), ['Proef: zwemles', 'Proef: etentje']);
  assert.strictEqual(s.reizen.length, 1);
  assert.strictEqual(s.telt, 4);
});

test('droge zondag: één aflevering met vraag, één loketregel, bestand 600', async () => {
  const { m, st, dir } = maak();
  const u = await m.stap({ datum: ZONDAG });
  assert.strictEqual(u.ok, true); assert.strictEqual(u.detail.status, 'klaar');
  assert.strictEqual(st.claude, 1);
  assert.ok(st.prompt.includes('(11 jaar geleden)') && st.prompt.includes('Proef: zwemles') && !st.prompt.includes('werkoverleg'));
  assert.strictEqual(st.loket.length, 1);
  assert.strictEqual(st.loket[0].app, 'memorylane'); assert.strictEqual(st.loket[0].editie, 'ochtend'); assert.strictEqual(st.loket[0].datum, ZONDAG);
  assert.match(st.loket[0].link, /^https:\/\/app\.socev\.dev\/\?app=memorylane&mlplek=weekboek$/);
  assert.ok(st.loket[0].tekst.includes('Wat zei je dochter'));
  assert.strictEqual(fs.statSync(path.join(dir, '2026-W48.json')).mode & 0o777, 0o600);
  const l = m.laatste().body.weekboek;
  assert.strictEqual(l.week, '2026-W48'); assert.match(l.vraag, /\?$/); assert.strictEqual(l.hids.length, 2);
  // tweede keer = al gedaan, geen tweede aanroep of regel
  const u2 = await m.stap({ datum: ZONDAG });
  assert.strictEqual(u2.al_gedaan, true); assert.strictEqual(st.claude, 1); assert.strictEqual(st.loket.length, 1);
});

test('geen zondag = niets', async () => {
  const { m, st } = maak();
  const u = await m.stap({ datum: '2026-11-28' });
  assert.strictEqual(u.al_gedaan, true); assert.strictEqual(st.claude, 0);
});

test('week zonder stof: geen aflevering, geen model, geen loket', async () => {
  const { m, st } = maak({ agenda: async () => [], reizen: async () => [], fotos: async () => ({ '2026-11-24': 3 }) });
  const u = await m.stap({ datum: ZONDAG });
  assert.strictEqual(u.detail.status, 'overgeslagen');
  assert.strictEqual(st.claude, 0); assert.strictEqual(st.loket.length, 0);
  assert.strictEqual(m.laatste().body.weekboek, null);
});

test('bron die faalt telt als leeg; lijst die faalt = stap mislukt (opnieuw)', async () => {
  const a = maak({ agenda: async () => { throw new Error('x'); }, reizen: async () => [], fotos: async () => ({}) });
  const u = await a.m.stap({ datum: ZONDAG });
  assert.strictEqual(u.detail.status, 'overgeslagen');
  const b = maak({ lijst: async () => { throw new Error('x'); } });
  const v = await b.m.stap({ datum: ZONDAG });
  assert.strictEqual(v.ok, false); assert.strictEqual(b.st.claude, 0);
});

test('review MOET 2: verzonnen datum of jaartal = ongeldig; na twee pogingen box-rij, geen aflevering', async () => {
  const { m, st } = maak({ claude: async () => { st0.n++; return { ok: true, data: { titel: 'T', tekst: goedeTekst('Wat deed je op 3 december 2021?'), vraag: 'Wat deed je op 3 december 2021?' } }; } });
  const st0 = { n: 0 };
  const u = await m.stap({ datum: ZONDAG });
  assert.strictEqual(st0.n, 2);
  assert.strictEqual(u.detail.status, 'mislukt');
  assert.strictEqual(st.box.length, 1); assert.strictEqual(st.loket.length, 0);
  assert.strictEqual(m.laatste().body.weekboek, null);
  assert.ok(!/3 december/.test(st.box[0]), 'box-rij zonder inhoud');
  assert.strictEqual(W.geldig({ titel: 'T', tekst: goedeTekst('Hoe was het etentje?'), vraag: 'Hoe was het etentje?' }, 'x 25 november 2015 (11 jaar geleden)').vraag, 'Hoe was het etentje?');
  assert.strictEqual(W.geldig({ titel: 'T', tekst: goedeTekst('Hoe was het etentje?') + ' Twaalf. 12 jaar geleden.', vraag: 'Hoe was het etentje?' }, 'x 25 november 2015 (11 jaar geleden)'), null);
});

test('antwoord: koppelen, daarna wanneer = de week en titel via naamgeving; nagespeelde opname', async () => {
  const { m, st } = maak();
  await m.stap({ datum: ZONDAG });
  assert.strictEqual(m.antwoord({ week: '2026-W48', ramble_id: 'onzin' }).status, 400);
  assert.strictEqual(m.antwoord({ week: '2026-W47', ramble_id: 'r20261129-00000000000000aa' }).status, 404);
  assert.strictEqual(m.antwoord({ week: '2026-W48', ramble_id: 'r20261129-00000000000000bb' }).status, 200);
  assert.strictEqual(m.koppel(), 0, 'opname nog geen herinnering');
  // David sprak opnieuw in: de nieuwe opname vervangt de eerste zolang die nog geen herinnering werd
  assert.strictEqual(m.antwoord({ week: '2026-W48', ramble_id: 'r20261129-00000000000000aa' }).status, 200);
  assert.strictEqual(m.koppel(), 1);
  assert.deepStrictEqual(st.wanneer, [['h00000000000000aa', { van: '2026-11-23', tot: '2026-11-29' }]]);
  assert.deepStrictEqual(st.naam, [['h00000000000000aa', 'Weekboek week 48, 2026']]);
  assert.strictEqual(m.laatste().body.weekboek.antwoord.hid, 'h00000000000000aa');
  assert.strictEqual(m.koppel(), 0);
  assert.strictEqual(m.antwoord({ week: '2026-W48', ramble_id: 'r20261129-00000000000000cc' }).status, 409);
  assert.strictEqual(m.info().beantwoord, 1);
});

test('onderhoud: wanneer 503 → later opnieuw', async () => {
  let open = false;
  const { m } = maak({ wanneer: () => (open ? { status: 200 } : { status: 503 }) });
  await m.stap({ datum: ZONDAG });
  m.antwoord({ week: '2026-W48', ramble_id: 'r20261129-00000000000000aa' });
  assert.strictEqual(m.koppel(), 0);
  open = true;
  assert.strictEqual(m.koppel(), 1);
});

test('oude aflevering wordt niet meer getoond (14 dagen)', async () => {
  let t = Date.parse(ZONDAG + 'T05:10:00Z');
  const { m } = maak({ nu: () => t });
  await m.stap({ datum: ZONDAG });
  t += 15 * 86400000;
  assert.strictEqual(m.laatste().body.weekboek, null);
});

test('minder dan drie in de week: aanvullen uit de komende week, gemarkeerd', () => {
  const l = [h('h00000000000000c1', { titel: 'Komend', datum: '1|2014-12-02|2014-12-02', precisie: 'dag' }), h('h00000000000000c2', { titel: 'Ver', datum: '1|2014-12-20|2014-12-20', precisie: 'dag' })];
  const k = W.kies(LIJST.concat(l), W.weekVan(ZONDAG));
  assert.deepStrictEqual(k.map((x) => [x.h.hid, x.komend]), [['h0000000000000001', false], ['h0000000000000002', false], ['h00000000000000c1', true]]);
  assert.ok(W.prompt(W.weekVan(ZONDAG), k, W.weekStof(W.weekVan(ZONDAG), [], [], {})).includes('[komende week] Komend'));
});
