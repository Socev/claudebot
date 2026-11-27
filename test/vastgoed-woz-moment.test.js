'use strict';
// wv4229 (besluitenpagina nr 941 = L41, David Ja 25-11-2026 22:27; Fable-review "Een 9 - vastgoed" § F6): het WOZ-moment in februari.
// De WOZ-knop leest ook de dagtekening en de maten; het controlescherm zet de nieuwe WOZ naast vorig jaar, het buurtgemiddelde, de indicatie en
// de maten naast de BAG, met "bezwaar kan tot" (dagtekening + 42 dagen). Bewaren zet de termijn en het seintje voor volgend jaar in het
// deadline-register; het concept-bezwaar is een vaste tekst uit de bevestigde rij (geen vrije getallen).
// Alles verzonnen: dossier uit test/vastgoed-maak.js, een nepbeschikking als tekst. VASTGOED_JS=<pad> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VJS = process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js');
const V = require(VJS);
const M = require('./vastgoed-maak.js');

const BESCHIKKING = [
  'Gemeente Voorbeeld - Belastingen', 'Aanslagbiljet en WOZ-beschikking', 'Dagtekening: 26-02-2026', 'Aanslagnummer 1234.56.789',
  'Beschikking WOZ voor het jaar 2026', 'Waardepeildatum 1 januari 2025', 'Object: Hofstraat 110, 9999 ZZ Proefdorp',
  'Vastgestelde WOZ-waarde € 451.000', 'Gebruiksoppervlakte woning 131 m²', 'Perceeloppervlakte 240 m²',
  'Tegen deze beschikking kunt u binnen zes weken na de dagtekening bezwaar maken.',
].join('\n');

async function proef() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-woz-'));
  const v = M.maakVault(path.join(t, 'vault'));
  const w = path.join(v, '20_Prive', 'Huis', 'Woning Hofstraat 110.md');
  fs.writeFileSync(w, fs.readFileSync(w, 'utf8') + '\n\nWOZ-loket: Belastingen Voorbeeld (Woz@Belastingen-Voorbeeld.example, 000-0000000).\n');
  const m = V.maak({ map: path.join(t, 'map'), vault: v, bronnen: M.nepBronnen(), nu: () => new Date('2026-02-27T10:00:00Z') });
  m.leesDossier();
  const won = m.overzicht().objecten.find((o) => o.soort === 'woning');
  await m.ververs(won.id);
  return { t, v, m, id: won.id, weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}

test('tekst: jaar, waarde, peildatum, dagtekening en maten uit de nepbeschikking; bezwaar tot = dagtekening + 42 dagen', () => {
  const r = V.wozUitTekst(BESCHIKKING, new Date('2026-02-27T10:00:00Z'));
  assert.deepStrictEqual(r, { jaar: 2026, waarde: 451000, peildatum: '2025-01-01', dagtekening: '2026-02-26', maten: { wonen_m2: 131, grond_m2: 240 } });
  assert.strictEqual(V.bezwaarTot('2026-02-26'), '2026-04-09');
  assert.strictEqual(V.bezwaarTot('2027-01-31'), '2027-03-14');   // over het eind van februari heen
  assert.strictEqual(V.bezwaarTot('onzin'), null);
  assert.strictEqual(V.wozUitTekst('Dagtekening 26 februari 2026 WOZ-waarde voor 2026 € 30.000', new Date('2026-03-01')).dagtekening, '2026-02-26');
  assert.strictEqual(V.wozUitTekst('WOZ-waarde voor 2026 € 30.000', new Date('2026-03-01')).dagtekening, null);
});

test('vergelijking: nieuwe WOZ naast die van vorig jaar (peildatum een jaar eerder), buurt, indicatie, maten naast BAG, termijn', async () => {
  const x = await proef();
  try {
    const v = x.m.wozVergelijk({ id: x.id, jaar: 2026, waarde: 451000, peildatum: '2025-01-01', dagtekening: '2026-02-26', maten: { wonen_m2: 131 } });
    assert.deepStrictEqual(v.vorig, { jaar: 2025, waarde: 410000, peildatum: '2024-01-01' });
    assert.strictEqual(v.verschil, 41000);
    assert.strictEqual(v.pct, 10);
    assert.ok(v.buurt && /buurt/.test(v.buurt.veld) && v.buurt.waarde === '€ 263.000');
    assert.ok(v.indicatie && Number.isFinite(v.indicatie.waarde));
    assert.strictEqual(v.maten.wonen_m2, 131);
    assert.strictEqual(v.bezwaar_tot, '2026-04-09');
    const zonder = x.m.wozVergelijk({ id: x.id, jaar: 2030, waarde: 500000 });
    assert.strictEqual(zonder.vorig, null); assert.strictEqual(zonder.pct, null); assert.strictEqual(zonder.bezwaar_tot, null);
  } finally { x.weg(); }
});

test('controle: dagtekening mag leeg; ongeldig, te vroeg of in de toekomst = 400', async () => {
  const x = await proef();
  try {
    assert.strictEqual(x.m.wozControle({ id: x.id, jaar: 2026, waarde: 451000 }).dagtekening, null);
    assert.strictEqual(x.m.wozControle({ id: x.id, jaar: 2026, waarde: 451000, dagtekening: '2026-02-26' }).dagtekening, '2026-02-26');
    for (const d of ['2024-12-31', '2026-03-31', '26-02-2026']) assert.throws(() => x.m.wozControle({ id: x.id, jaar: 2026, waarde: 451000, dagtekening: d }), (e) => e.status === 400, d);
  } finally { x.weg(); }
});

test('bewaren: dagtekening en maten uit het stuk in woz_eigen; deadline-regels idempotent onder ## Actueel; geen bedragen in het register', async () => {
  const x = await proef();
  try {
    const r = x.m.wozVastleggen({ id: x.id, jaar: 2026, waarde: 451000, peildatum: '2025-01-01', dagtekening: '2026-02-26' },
      { pad: '20_Prive/Bronnen/Huis/Prive - 2026 - WOZ-beschikking 2026 Proef.pdf', sha: 'a'.repeat(64), maten: { wonen_m2: 131, grond_m2: 240, rommel: 'x' } });
    assert.strictEqual(r.vergelijk.bezwaar_tot, '2026-04-09');
    assert.strictEqual(r.vergelijk.maten.wonen_m2, 131);
    const reg = V.wozDeadlineRegels(r.vergelijk, '2026-02-27');
    assert.deepStrictEqual(reg.map((y) => y.sleutel), [`vastgoed-woz-bezwaar-2026-${x.id}`, 'vastgoed-woz-seintje-2027']);
    assert.ok(reg[0].regel.startsWith('| 2026-04-09 | Privé (David) | **WOZ 2026 ') && /\[jij\]/.test(reg[0].regel));
    assert.ok(reg[1].regel.startsWith('| 2027-03-31 |') && / \| 35 \| /.test(reg[1].regel));
    for (const y of reg) { assert.ok(!/451|410|€/.test(y.regel), 'geen bedrag in het register'); assert.strictEqual(y.regel.split(' | ').length, 6); }
    const reg2 = '---\n---\n\n# Deadlines\n\n## Actueel\n\n| Datum | Entiteit | Wat | Actie | Signaleer | Bron |\n|---|---|---|---|---|---|\n| 2026-03-01 | X | iets | [jij] doen | 3 | b |\n\n## Afgehandeld\n\n| Datum | Entiteit | Wat | Actie | Signaleer | Bron |\n|---|---|---|---|---|---|\n';
    const n1 = V.deadlineErbij(reg2, reg);
    const rg = n1.split('\n');
    assert.strictEqual(rg.indexOf(reg[0].regel), rg.indexOf('| 2026-03-01 | X | iets | [jij] doen | 3 | b |') + 1);
    assert.ok(rg.indexOf(reg[1].regel) < rg.indexOf('## Afgehandeld'));
    assert.strictEqual(V.deadlineErbij(n1, reg), null, 'tweede keer niets');
    // review Codex MOET 1: verbeterde dagtekening → dezelfde sleutel, andere datum: de regel in ## Actueel wordt vervangen (niet dubbel)
    const later = V.wozDeadlineRegels(Object.assign({}, r.vergelijk, { dagtekening: '2026-03-02', bezwaar_tot: V.bezwaarTot('2026-03-02') }), '2026-02-27');
    const n2 = V.deadlineErbij(n1, later);
    assert.ok(n2 && n2.includes('| 2026-04-13 |') && !n2.includes('| 2026-04-09 |'), 'termijn bijgewerkt');
    assert.strictEqual(n2.split(`(vastgoed-woz-bezwaar-2026-${x.id})`).length, 2, 'één regel');
    // al afgehandeld (onder ## Afgehandeld): niet opnieuw in Actueel
    const af = reg2.replace('|---|---|---|---|---|---|\n', '|---|---|---|---|---|---|\n').replace(/(## Afgehandeld\n\n\| Datum[^\n]*\n\|---[^\n]*\n)/, '$1' + reg[0].regel + '\n' + reg[1].regel + '\n');
    assert.strictEqual(V.deadlineErbij(af, later), null, 'afgehandeld blijft afgehandeld');
    assert.strictEqual(V.deadlineErbij('# zonder tabel\n', reg), null);
    assert.deepStrictEqual(V.wozDeadlineRegels(r.vergelijk, '2026-04-10').map((y) => y.sleutel), ['vastgoed-woz-seintje-2027'], 'termijn voorbij: alleen het seintje');
  } finally { x.weg(); }
});

test('concept-bezwaar: vaste tekst uit de bevestigde rij, adres uit het dossier, tweede keer 409, zonder bewaren 404', async () => {
  const x = await proef();
  try {
    assert.throws(() => x.m.wozBezwaar({ id: x.id, jaar: 2026 }), (e) => e.status === 404);
    x.m.wozVastleggen({ id: x.id, jaar: 2026, waarde: 451000, peildatum: '2025-01-01', dagtekening: '2026-02-26' }, { maten: { wonen_m2: 131 } });
    const c = x.m.wozBezwaar({ id: x.id, jaar: 2026 });
    assert.strictEqual(c.aan, 'woz@belastingen-voorbeeld.example');
    assert.strictEqual(c.onderwerp, 'Bezwaar WOZ-beschikking 2026 (WOZ-objectnummer 99990000123)');
    assert.match(c.bericht, /dagtekening 26-2-2026/);
    assert.match(c.bericht, /€ 451\.000/);
    assert.match(c.bericht, /€ 410\.000/);
    assert.match(c.bericht, /stijging van € 41\.000 \(10%\)/);
    assert.match(c.bericht, /Gemiddelde WOZ in de buurt \(2025\): € 263\.000/);
    assert.match(c.bericht, /\[vul aan:/);
    assert.match(c.bericht, /David Schaap$/);
    // elk getal in de tekst komt uit de rij, vorig jaar, het buurtfeit, de maten of het objectnummer (geen vrije getallen)
    const toegestaan = new Set(['451.000', '410.000', '41.000', '10', '263.000', '131', '2026', '2025', '26-2-2026', '1-1-2025', '99990000123', '110']);
    for (const g of c.bericht.match(/\d[\d.,-]*\d|\d/g)) assert.ok(toegestaan.has(g.replace(/[.,]$/, '')) || /^\d{4}$/.test(g) && Number(g) >= 2025, 'vrij getal: ' + g);
    x.m.wozConceptGezet(x.id, 2026);
    assert.throws(() => x.m.wozBezwaar({ id: x.id, jaar: 2026 }), (e) => e.status === 409);
    assert.ok(x.m.wozBezwaar({ id: x.id, jaar: 2026, opnieuw: true }).bericht);
  } finally { x.weg(); }
});
