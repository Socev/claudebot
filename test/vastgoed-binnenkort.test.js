'use strict';
// wv4228 (besluitenpagina nr 940 = L40, David Ja 25-11-2026 22:27): "Nu en binnenkort" bovenaan Vastgoed — Loopt nu, Binnenkort, Nieuw —
// en dezelfde data in het deadline-register. Verzonnen dossier (test/vastgoed-maak.js) + verzonnen pagina's. Toetst: Loopt nu uit status lopend
// met de laatste zin van het laatste besluit; Binnenkort uit "## Toekomstige data", een ALV-zin, rentevast en het WOZ-seintje, gesorteerd en
// binnen tien jaar; de registerregels zijn idempotent (tweede ronde verandert niets) en een handmatige regel (zelfde datum en woord) komt er niet
// nog eens bij; GET /app/vastgoed geeft nu_binnenkort en nieuw_aantal; nieuwAantal() is na "gezien" 0. VASTGOED_JS=<pad> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VJS = process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js');
const V = require(VJS);
const M = require('./vastgoed-maak.js');

const KELDER = `---
status: lopend
updated: 2026-11-07
---
# Kelder — verbouwplan met Proefbureau

**Open:** het kavelpaspoort opvragen.

**Besluit (David, 7-11-2026):** de kelder komt onder de uitbouw. De aannemer maakt nu een eerste schatting van de kosten.
*(bron: proef)*
`;
const KACHEL = `---
status: afgerond
updated: 2026-10-01
---
# Kachel — storing
`;
const TOEKOMST = `
## Toekomstige data

- **6-11-2028:** het energielabel A verloopt.
- **1-5-2041:** het warmtecontract loopt af.
  De huur is dertig jaar.
- **1-1-2020:** al voorbij.
`;
const ALV = `\n## VvE en ALV\n\nDe beheerder kondigde een **digitale ALV aan op 27-1-2027 om 16:00**; de uitnodiging volgt.\n`;
const REGISTER = `# Deadlines

## Actueel

| Datum | Entiteit | Wat | Actie | Signaleer | Bron |
|---|---|---|---|---|---|
| 2031-05-01 | Privé / Huis | **Rentevaste periode van de hypotheek loopt af** | [jij] renteaanbod | 60 | hand |

## Afgehandeld

| Datum | Entiteit | Wat | Actie | Signaleer | Bron |
|---|---|---|---|---|---|
`;

test('nuEnBinnenkort: Loopt nu, Binnenkort (gesorteerd, horizon), registerregels idempotent en zonder dubbel met de hand', () => {
  const paginas = [
    { pad: '20_Prive/Huis/Kelder - verbouwplan (Proefbureau).md', md: KELDER },
    { pad: '20_Prive/Huis/Kachel.md', md: KACHEL },
    { pad: '20_Prive/Huis/Woning Hofstraat 110.md', md: '# Woning\n' + TOEKOMST, object: 'woning' },
    { pad: '20_Prive/Huis/Garagebox Proefpark (box 7).md', md: '# Box\n' + ALV, object: 'box-7' },
    { pad: '20_Prive/Huis/Garageboxen.md', md: '# Boxen\n' + ALV },
  ];
  const r = V.nuEnBinnenkort({ vandaag: '2026-11-27', paginas, kern: { rentevast: { datum: '2031-05-01' } }, eigen: [], nieuw: [{ tekst: 'x' }], nieuw_aantal: 3 });
  assert.strictEqual(r.loopt.length, 1, 'alleen status lopend');
  assert.strictEqual(r.loopt[0].naam, 'Kelder'); assert.strictEqual(r.loopt[0].kelder, true); assert.strictEqual(r.loopt[0].sinds, '2026-11-07');
  assert.strictEqual(r.loopt[0].stand, 'De aannemer maakt nu een eerste schatting van de kosten.');
  assert.deepStrictEqual(r.binnenkort.map((b) => [b.soort, b.datum]), [['alv', '2027-01-27'], ['woz', '2027-02-28'], ['energielabel', '2028-11-06'], ['rentevast', '2031-05-01']], 'gesorteerd, één ALV, 2041 en 2020 vallen weg');
  assert.match(r.binnenkort[0].tekst, /16:00/);
  assert.strictEqual(r.binnenkort[1].wanneer, 'eind februari 2027');
  assert.strictEqual(r.nieuw_aantal, 3);
  const regels = V.binnenkortRegels(r.binnenkort);
  assert.deepStrictEqual(regels.map((x) => x.sleutel), ['vastgoed-alv-2027-01-27', 'vastgoed-woz-seintje-2027', 'vastgoed-energielabel-woning-2028-11-06', 'vastgoed-rentevast-2031-05-01']);
  for (const x of regels) assert.ok(!/€/.test(x.regel), 'geen bedragen in het register');
  const nodig = V.binnenkortNodig(REGISTER, regels);
  assert.ok(!nodig.some((x) => x.soort === 'rentevast'), 'rentevast staat er al met de hand');
  const een = V.binnenkortErbij(REGISTER, nodig);
  assert.ok(een, 'eerste ronde zet regels');
  const act = een.split('## Afgehandeld')[0];
  for (const s of ['vastgoed-alv-2027-01-27', 'vastgoed-woz-seintje-2027', 'vastgoed-energielabel-woning-2028-11-06']) assert.strictEqual(act.split('(' + s + ')').length - 1, 1, s + ' één keer onder Actueel');
  assert.strictEqual(V.binnenkortErbij(een, V.binnenkortNodig(een, regels)), null, 'tweede ronde verandert niets');
  // naar Afgehandeld verplaatst = niet opnieuw
  const regel = een.split('\n').find((l) => l.includes('(vastgoed-alv-2027-01-27)'));
  const verplaatst = een.replace(regel + '\n', '') + regel + '\n';
  assert.strictEqual(V.binnenkortErbij(verplaatst, V.binnenkortNodig(verplaatst, regels)), null, 'afgehandeld blijft afgehandeld');
});

test('WOZ in Binnenkort: na 31-3 volgend jaar; een bevestigde beschikking met lopende bezwaartermijn staat erbij', () => {
  assert.strictEqual(V.wozBinnenkort('2027-04-02', []).find((b) => b.soort === 'woz').jaar, 2028);
  assert.strictEqual(V.wozBinnenkort('2027-01-10', []).find((b) => b.soort === 'woz').jaar, 2027);
  const b = V.wozBinnenkort('2027-03-01', [{ object: 'woning', naam: 'de woning', soort: 'woning', jaar: 2027, dagtekening: '2027-02-27' }]);
  assert.deepStrictEqual(b.map((x) => [x.soort, x.datum]), [['woz-bezwaar', '2027-04-10'], ['woz', '2028-02-28']]);
  assert.strictEqual(V.binnenkortRegels(b.filter((x) => x.soort === 'woz-bezwaar')).length, 0, 'de bezwaartermijn zet woz-bewaar zelf');
});

test('GET /app/vastgoed: nu_binnenkort uit het verzonnen dossier; nieuwAantal na gezien 0', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-bk-'));
  try {
    const v = M.maakVault(path.join(t, 'vault'));
    fs.writeFileSync(path.join(v, '20_Prive', 'Huis', 'Kelder - verbouwplan (Proefbureau).md'), KELDER);
    const wp = fs.readdirSync(path.join(v, '20_Prive', 'Huis')).find((n) => /^Woning/.test(n));
    fs.appendFileSync(path.join(v, '20_Prive', 'Huis', wp), TOEKOMST);
    const m = V.maak({ map: path.join(t, 'map'), vault: v, bronnen: M.nepBronnen(), nu: () => new Date('2026-11-27T10:00:00Z') });
    const u = await m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.strictEqual(u.status, 200);
    const nb = u.body.nu_binnenkort;
    assert.ok(nb && nb.loopt.some((l) => l.kelder), 'kelder loopt');
    assert.ok(nb.binnenkort.some((b) => b.soort === 'energielabel' && b.datum === '2028-11-06'), 'energielabel uit Toekomstige data');
    assert.ok(nb.binnenkort.some((b) => b.soort === 'woz'), 'WOZ-seintje');
    assert.strictEqual(u.body.nieuw_aantal, 0);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(t, 'map', 'vastgoed.sqlite'));
    db.prepare("INSERT INTO wijziging (op, object, soort, sleutel, tekst) VALUES ('2026-11-27T09:00:00Z', 'woning', 'stuk', 'a', 'Nieuw stuk')").run();
    db.prepare("INSERT INTO wijziging (op, object, soort, sleutel, tekst) VALUES ('2026-11-27T09:01:00Z', 'woning', 'stuk', 'b', 'Nog een stuk')").run();
    db.close();
    assert.strictEqual(m.nieuwAantal(), 2, 'teller = aantal nieuw');
    assert.strictEqual((await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.nu_binnenkort.nieuw_aantal, 2);
    await m.app({ pad: '/app/vastgoed/gezien', methode: 'POST', body: {} });
    assert.strictEqual(m.nieuwAantal(), 0, 'na gezien 0');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('onmogelijke datums (maand 13, dag 40) gooien niet: overgeslagen', () => {
  const r = V.nuEnBinnenkort({ vandaag: '2026-11-27', paginas: [{ pad: '20_Prive/Huis/X.md', md: '---\nstatus: lopend\nupdated: 2026-13-01\n---\n# X\n\n## Toekomstige data\n\n- **40-11-2028:** kapot.\n- **6-11-2028:** het energielabel verloopt.\n' }], kern: { rentevast: { datum: '2031-02-30' } }, eigen: [], nieuw: [] });
  assert.strictEqual(r.loopt[0].sinds, null);
  assert.deepStrictEqual(r.binnenkort.filter((b) => b.soort !== 'woz').map((b) => b.datum), ['2028-11-06']);
});

test('review Codex MOET 1: twee zaken op dezelfde dag houden elk hun regel (scherm en register)', () => {
  const md = '# Woning\n\n## Toekomstige data\n\n- **1-6-2030:** het onderhoudscontract loopt af.\n- **1-6-2030:** de garantie op het dak loopt af.\n';
  const r = V.nuEnBinnenkort({ vandaag: '2026-11-27', paginas: [{ pad: '20_Prive/Huis/Woning.md', md, object: 'woning' }], eigen: [], nieuw: [] });
  const t = r.binnenkort.filter((b) => b.datum === '2030-06-01');
  assert.strictEqual(t.length, 2, 'beide in Binnenkort');
  const regels = V.binnenkortRegels(t);
  assert.strictEqual(new Set(regels.map((x) => x.sleutel)).size, 2, 'twee sleutels');
  const een = V.binnenkortErbij(REGISTER, V.binnenkortNodig(REGISTER, regels));
  assert.strictEqual(een.split('## Afgehandeld')[0].split('\n').filter((l) => l.startsWith('| 2030-06-01 |')).length, 2, 'twee regels in het register');
});

test('review Codex MOET 2: een verschoven datum vervangt de regel onder Actueel (geen oude en nieuwe naast elkaar); afgehandeld blokkeert een volgende niet', () => {
  const alv = (d) => V.binnenkortRegels([{ datum: d, tekst: 'Digitale ALV van de VvE van de garageboxen', soort: 'alv', object: null }]);
  const een = V.binnenkortErbij(REGISTER, V.binnenkortNodig(REGISTER, alv('2027-01-27')));
  const twee = V.binnenkortErbij(een, V.binnenkortNodig(een, alv('2027-02-03')));
  assert.ok(twee, 'verschoven = gewijzigd');
  const act = twee.split('## Afgehandeld')[0];
  assert.ok(!act.includes('(vastgoed-alv-2027-01-27)'), 'oude datum weg');
  assert.strictEqual(act.split('(vastgoed-alv-2027-02-03)').length - 1, 1, 'nieuwe datum één keer');
  assert.strictEqual(V.binnenkortErbij(twee, V.binnenkortNodig(twee, alv('2027-02-03'))), null, 'daarna stil');
  // oude regel naar Afgehandeld (David): een ALV van volgend jaar komt er gewoon bij
  const regel = twee.split('\n').find((l) => l.includes('(vastgoed-alv-2027-02-03)'));
  const af = twee.replace(regel + '\n', '') + regel + '\n';
  const drie = V.binnenkortErbij(af, V.binnenkortNodig(af, alv('2028-01-26')));
  assert.ok(drie && drie.split('## Afgehandeld')[0].includes('(vastgoed-alv-2028-01-26)'), 'volgende ALV erbij');
});
