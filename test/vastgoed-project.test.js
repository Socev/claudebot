'use strict';
// wv4231 (besluitenpagina nr 943 = L43, David Ja 25-11-2026 22:28): een projectkaart per lopend project die zichzelf bijhoudt. Verzonnen dossier
// (test/vastgoed-maak.js, openbaar voorbeeldadres) + verzonnen projectpagina, mailwachter-rijen en bekendmakingen. Toetst: wachtpunten uit de tabel
// (klaar telt niet, dagen kloppen) en uit de mailwachter alleen op een domein dat op de pagina staat (gmail telt niet); geld (laatste schatting +
// meerwerk, offerte gaat voor, betaald eraf, effect op restschuld en overwaarde); vergunning alleen op eigen straat + huisnummer (110a en 1100 niet),
// termijnen als indicatie; stukken op het projectwoord; GET /app/vastgoed geeft projecten; een nieuw proefstuk verschijnt en verdwijnt weer;
// mailwachter onbereikbaar = kaart blijft met wachter.ok false; mailconcept: vaste tekst uit de sleutel, geen adres = 422, tweede keer 409.
// VASTGOED_JS=<pad> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VJS = process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js');
const V = require(VJS);
const M = require('./vastgoed-maak.js');

const PAD = '20_Prive/Huis/Kelder - verbouwplan (Proefbureau).md';
const KELDER = `---
status: lopend
updated: 2026-11-07
---
# Kelder — verbouwplan met Proefbureau

Adviseur: proefbureau, mail adviseur@proefbureau.nl; David schrijft vanaf iemand@gmail.com.

**Besluit (David, 7-11-2026):** de kelder komt onder de uitbouw. De aannemer maakt nu een eerste schatting van de kosten.

## Wachtpunten

| Wat | Wie | Sinds | Mail | Klaar |
|---|---|---|---|---|
| Eerste schatting van de kosten | Aannemer Proef | 7-11-2026 | aannemer@proefbouw.nl | |
| Kavelpaspoort | Gemeente | 1-10-2026 | | 20-10-2026 |
| Sondering plannen | Proefbureau | 20-11-2026 | geen-adres | |
`;
const CW = [
  { thread_id: 'a', type: 'wacht_op_antwoord', tegenpartij: 'Adviseur Proef <adviseur@proefbureau.nl>', onderwerp: 'Tekeningen fundering', verzonden_op: '2026-11-01', status: 'wacht' },
  { thread_id: 'b', type: 'wacht_op_antwoord', tegenpartij: 'Iemand <iemand@gmail.com>', onderwerp: 'Iets anders', verzonden_op: '2026-11-02', status: 'wacht' },
  { thread_id: 'c', type: 'wacht_op_antwoord', tegenpartij: 'Adviseur Proef <adviseur@proefbureau.nl>', onderwerp: 'Oud', verzonden_op: '2026-09-01', status: 'afgerond' },
];
const BM = [
  { id: 'gmb-2026-1', datum: '2026-11-20', titel: 'Omgevingsvergunning aangevraagd: Hofstraat 110, bouwen van een kelder', url: 'https://zoek.officielebekendmakingen.nl/gmb-2026-1' },
  { id: 'gmb-2026-2', datum: '2026-11-21', titel: 'Aanvraag omgevingsvergunning Hofstraat 110a, dakkapel', url: null },
  { id: 'gmb-2026-3', datum: '2026-11-22', titel: 'Aanvraag Hofstraat 1100, schuur', url: null },
  { id: 'gmb-2026-4', datum: '2026-08-01', titel: 'Omgevingsvergunning verleend Hofstraat 110, zonnepanelen', url: null },
];

test('projectKaarten: wachtpunten, geld, vergunning, stukken', () => {
  const kostte = { verbouwingen: [{ titel: 'Kelder', pagina: PAD, offertes: [
    { waarde: 50000, kop: 'Eerste schatting 10-11-2026', soort: 'prijs' }, { waarde: 60000, kop: 'Schatting herzien 20-11-2026', soort: 'prijs' }, { waarde: 5000, kop: 'Meerwerk 21-11-2026', soort: 'prijs' }],
    betaald: 10000, betalingen: [{}], buiten: [] }] };
  const stukken = [{ naam: '2026-11-06 - Bouwplan kelder onder de uitbouw.pdf', pad: 'x/a.pdf', datum: '2026-11-06', soort: 'tekening' }, { naam: '2014 - Palenplan.pdf', pad: 'x/b.pdf', datum: '2014', soort: 'constructie' }];
  const r = V.projectKaarten({ vandaag: '2026-11-27', paginas: [{ pad: PAD, md: KELDER }, { pad: '20_Prive/Huis/Kachel.md', md: '---\nstatus: afgerond\n---\n# Kachel\n' },
    { pad: '20_Prive/Huis/Kachel storing.md', md: '---\ntags: [privé, huis, aankoop, garantie]\nstatus: lopend\n---\n# Kachel — storing\n\n**Open:** wacht op de leverancier.\n' }],
    kostte, kern: { restschuld: 300000, overwaarde: 200000 }, cw: CW, bekendmakingen: BM, adres: 'Hofstraat 110, 7311 KZ Apeldoorn', stukken });
  assert.strictEqual(r.length, 1, 'alleen het lopende bouwproject (kachelklacht niet)');
  const p = r[0];
  assert.strictEqual(p.naam, 'Kelder'); assert.strictEqual(p.kelder, true); assert.strictEqual(p.stand_op, '2026-11-07');
  assert.deepStrictEqual(p.wachtpunten.map((w) => [w.wat, w.dagen, w.bron]), [['Tekeningen fundering', 26, 'mailwachter'], ['Eerste schatting van de kosten', 20, 'pagina'], ['Sondering plannen', 7, 'pagina']],
    'klaar telt niet; gmail-domein en afgerond niet; gesorteerd op dagen');
  assert.strictEqual(p.wachtpunten[1].mail, 'aannemer@proefbouw.nl'); assert.strictEqual(p.wachtpunten[2].mail, null, 'geen geldig adres');
  assert.strictEqual(p.wachtpunten[0].mail, 'adviseur@proefbureau.nl');
  assert.ok(/^[0-9a-f]{16}$/.test(p.wachtpunten[0].sleutel));
  const g = p.geld;
  assert.strictEqual(g.schatting, 60000, 'laatste schatting telt'); assert.strictEqual(g.meerwerk, 5000); assert.strictEqual(g.offerte, null);
  assert.strictEqual(g.verwacht, 65000, 'schatting + meerwerk (Codex MOET 1)'); assert.strictEqual(g.nog, 55000);
  assert.deepStrictEqual(g.effect, { nog: 55000, op: 'schatting', restschuld_na: 355000, overwaarde_na: 145000 });
  assert.deepStrictEqual(p.vergunning.eigen.map((b) => [b.soort, b.datum]), [['aanvraag', '2026-11-20'], ['besluit', '2026-08-01']], '110a en 1100 niet');
  assert.deepStrictEqual(p.vergunning.eigen[0].termijnen.map((t) => [t.datum, t.indicatie, t.voorbij]), [['2027-01-15', true, false], ['2027-02-26', true, false]]);
  assert.strictEqual(p.vergunning.eigen[1].termijnen[0].voorbij, true);
  assert.deepStrictEqual(p.stukken.map((s) => s.naam), ['2026-11-06 - Bouwplan kelder onder de uitbouw']);
  // offerte gaat voor de schatting
  const g2 = V.pkGeld({ offertes: [{ waarde: 60000, kop: 'Schatting 1-11-2026' }, { waarde: 70000, kop: 'Offerte aannemer 20-11-2026' }], betaald: null }, { restschuld: null, overwaarde: 1 });
  assert.strictEqual(g2.verwacht, 70000); assert.strictEqual(g2.effect.op, 'offerte'); assert.strictEqual(g2.effect.restschuld_na, null, 'onbekende restschuld blijft onbekend');
  // geen bedrag: nog null, geen effect
  assert.strictEqual(V.pkGeld(null, {}).effect, null);
  // mailwachter niet te lezen
  const r2 = V.projectKaarten({ vandaag: '2026-11-27', paginas: [{ pad: PAD, md: KELDER }], cw: null, cw_reden: 'weg' });
  assert.strictEqual(r2[0].wachter.ok, false); assert.strictEqual(r2[0].wachtpunten.length, 2, 'tabel blijft');
  const t = V.projectConceptTekst(p, p.wachtpunten[1]);
  assert.strictEqual(t.aan, 'aannemer@proefbouw.nl'); assert.strictEqual(t.onderwerp, 'Kelder: Eerste schatting van de kosten');
  assert.match(t.bericht, /^Hoi Aannemer,\n\nHoe staat het met eerste schatting van de kosten\?/);
});

test('GET /app/vastgoed geeft projecten; nieuw stuk verschijnt en verdwijnt; mailconcept uit de sleutel', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-project-'));
  try {
    const v = M.maakVault(path.join(t, 'vault'));
    fs.writeFileSync(path.join(v, PAD), KELDER);
    let cwKeer = 0, cwFout = false;
    const m = V.maak({ map: path.join(t, 'map'), vault: v, bronnen: M.nepBronnen(), nu: () => new Date('2026-11-27T10:00:00Z'),
      wachter: async () => { cwKeer++; if (cwFout) throw new Error('weg'); return { rijen: CW, volledig: true }; } });
    let u = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.ok(Array.isArray(u.projecten) && u.projecten.length === 1, 'één projectkaart');
    const p = u.projecten[0];
    assert.strictEqual(p.wachter.ok, true);
    assert.deepStrictEqual(p.wachtpunten.map((w) => w.dagen), [26, 20, 7]);
    assert.strictEqual(p.stukken.length, 0);
    const stuk = path.join(v, '20_Prive', 'Bronnen', 'Huis', 'Prive - 2026-11-26 - Proeftekening kelder doorsnede.pdf');
    fs.writeFileSync(stuk, 'proef');
    await m.app({ pad: '/app/vastgoed/dossier', methode: 'POST', body: {} });
    u = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.deepStrictEqual(u.projecten[0].stukken.map((s) => s.naam), ['2026-11-26 - Proeftekening kelder doorsnede'], 'nieuw proefstuk op de kaart');
    fs.unlinkSync(stuk);
    await m.app({ pad: '/app/vastgoed/dossier', methode: 'POST', body: {} });
    u = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.strictEqual(u.projecten[0].stukken.length, 0, 'en weer weg');
    assert.strictEqual(cwKeer, 1, 'mailwachter 15 min uit het geheugen');
    // mailconcept
    const sl = u.projecten[0].wachtpunten.find((w) => w.mail === 'aannemer@proefbouw.nl').sleutel;
    const c = await m.projectConcept({ sleutel: sl });
    assert.deepStrictEqual(Object.keys(c).sort(), ['aan', 'bericht', 'onderwerp']); assert.strictEqual(c.aan, 'aannemer@proefbouw.nl');
    m.projectConceptGezet(sl);
    await assert.rejects(m.projectConcept({ sleutel: sl }), (e) => e.status === 409);
    assert.ok(await m.projectConcept({ sleutel: sl, opnieuw: true }));
    const zonder = u.projecten[0].wachtpunten.find((w) => !w.mail).sleutel;
    await assert.rejects(m.projectConcept({ sleutel: zonder }), (e) => e.status === 422);
    await assert.rejects(m.projectConcept({ sleutel: 'ffffffffffffffff' }), (e) => e.status === 404);
    await assert.rejects(m.projectConcept({ sleutel: 'x; drop' }), (e) => e.status === 400);
    u = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.ok(u.projecten[0].wachtpunten.find((w) => w.sleutel === sl).concept_op, 'concept_op op de kaart');
    // zonder wachter-koppeling: kaart blijft, wachter.ok false
    const m2 = V.maak({ map: path.join(t, 'map2'), vault: v, bronnen: M.nepBronnen(), nu: () => new Date('2026-11-27T10:00:00Z') });
    const u2 = (await m2.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.strictEqual(u2.projecten[0].wachter.ok, false); assert.strictEqual(u2.projecten[0].wachtpunten.length, 2);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
