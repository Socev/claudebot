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

// ── wv4353 (L43 stap 2): bouwfoto's op datum (Immich-album, verzonnen) en de opleverlijst na afloop (verzonnen afgeronde pagina) ──
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ALBUMS = [
  { id: U(1), naam: '2014 Bouw huis (ML)', omschrijving: 'memorylane:0123456789abcdef', aantal: 22 },
  { id: U(2), naam: 'Kelder bouw', omschrijving: '', aantal: 9 },
  { id: U(3), naam: 'Kelderbar Proefstad', omschrijving: '', aantal: 4 },
  { id: U(4), naam: 'Vakantie', omschrijving: '', aantal: 30 },
];
const FOTOS = [
  { id: U(101), dag: '2027-03-01', beeld: true }, { id: U(102), dag: '2027-03-01', beeld: true }, { id: U(103), dag: '2027-03-01', beeld: false },
  ...Array.from({ length: 8 }, (_, i) => ({ id: U(110 + i), dag: '2027-04-15', beeld: true })), { id: U(130), dag: null, beeld: true },
];
FOTOS.totaal = 40;
test('pkAlbum: vast op de pagina, anders het enige eigen album met het projectwoord (nooit MemoryLane, nooit bij twee treffers)', () => {
  assert.strictEqual(V.pkAlbum(ALBUMS, '---\nstatus: lopend\n---\n', 'Kelder').album.id, U(2), 'los woord kelder; kelderbar en ML niet');
  assert.strictEqual(V.pkAlbum(ALBUMS, '---\nfotoalbum: "vakantie"\n---\n', 'Kelder').album.id, U(4), 'vast gaat voor, hoofdletterongevoelig');
  const weg = V.pkAlbum(ALBUMS, '---\nfotoalbum: Bestaat niet\n---\n', 'Kelder');
  assert.strictEqual(weg.album, null); assert.strictEqual(weg.zoek, 'Bestaat niet');
  assert.strictEqual(V.pkAlbum(ALBUMS, '---\nfotoalbum: 2014 Bouw huis (ML)\n---\n', 'Kelder').album, null, 'ook vast nooit een MemoryLane-album');
  const twee = V.pkAlbum(ALBUMS.concat([{ id: U(5), naam: 'kelder fase 2', omschrijving: '', aantal: 1 }]), '', 'Kelder');
  assert.strictEqual(twee.album, null); assert.deepStrictEqual(twee.meer, ['Kelder bouw', 'kelder fase 2']);
  const geen = V.pkAlbum([ALBUMS[0]], '', 'Kelder');
  assert.strictEqual(geen.album, null); assert.strictEqual(geen.voorstel, 'Bouw kelder');
});
test('pkFotoDagen: per dag, nieuwste eerst, hooguit zes miniaturen per dag, video telt mee zonder miniatuur, totaal uit Immich', () => {
  const d = V.pkFotoDagen(FOTOS, FOTOS.totaal);
  assert.deepStrictEqual(d.dagen.map((x) => [x.dag, x.aantal, x.video, x.ids.length]), [['2027-04-15', 8, 0, 6], ['2027-03-01', 3, 1, 2]]);
  assert.strictEqual(d.totaal, 40); assert.strictEqual(d.gelezen, 12); assert.strictEqual(d.beperkt, true, 'meer in het album dan gelezen');
  assert.strictEqual(d.zonder_dag, 1); assert.strictEqual(d.eerste, '2027-03-01'); assert.strictEqual(d.laatste, '2027-04-15');
  assert.ok(!d.dagen[1].ids.includes(U(103)), 'video geen miniatuur');
  const veel = V.pkFotoDagen(Array.from({ length: 20 }, (_, i) => ({ id: U(200 + i), dag: `2027-05-${String(i + 1).padStart(2, '0')}`, beeld: true })), 20);
  assert.strictEqual(veel.dagen.length, 12); assert.strictEqual(veel.aantal_dagen, 20); assert.strictEqual(veel.beperkt, false);
});
const WONING_O = {
  feiten: [{ groep: 'bag', veld: 'Gebruiksoppervlakte (BAG)', waarde: '150 m²', opgehaald: '2027-05-01T08:00:00Z' },
    { groep: 'ep', veld: 'Registratiedatum', waarde: '2019-05-02' }, { groep: 'ep', veld: 'Energieklasse', waarde: 'A' }],
  reeksen: [{ reeks: 'woz', peildatum: '2026-01-01', waarde: 700000 }, { reeks: 'taxatie-na', peildatum: '2019-03-01', waarde: 650000 }],
  stukken: [{ soort: 'taxatie', datum: '2019-03-01', naam: 'oud' }] };
const POLIS = { bedrag: 500000, stukken: [{ datum: '2026' }] };
test('opleverLijst: alleen een expliciete opleverdatum vergelijkt; polis nooit "staat erin"; oude taxatie-na telt niet', () => {
  const md = '---\nstatus: afgerond\nopgeleverd: 10-4-2027\noppervlakte_na: 180 m²\n---\n# Kelder\n';
  const l = V.opleverLijst({ md, woning: WONING_O, polis: POLIS });
  assert.strictEqual(l.datum, '2027-04-10');
  const st = Object.fromEntries(l.punten.map((p) => [p.punt, p.staat]));
  assert.deepStrictEqual(st, { 'Nieuwe oppervlakte': 'wacht', WOZ: 'wacht', Energielabel: 'te doen', 'Herbouwwaarde opstalverzekering': 'te doen', 'Taxatie na verbouwing': 'te doen' });
  assert.match(l.punten[1].tekst, /WOZ 2028/); assert.match(l.punten[3].tekst, /€ 500\.000/);
  const na = { feiten: [{ groep: 'bag', veld: 'Gebruiksoppervlakte (BAG)', waarde: '180 m²' }, { groep: 'ep', veld: 'Registratiedatum', waarde: '2027-06-01' }],
    reeksen: [{ reeks: 'woz', peildatum: '2027-01-01', waarde: 800000 }, { reeks: 'taxatie-na', peildatum: '2027-05-01', waarde: 900000 }], stukken: [] };
  const l2 = V.opleverLijst({ md, woning: na, polis: { bedrag: 500000, stukken: [{ datum: '2028' }] } });
  assert.deepStrictEqual(l2.punten.map((p) => p.staat), ['staat erin', 'controleren', 'staat erin', 'controleren', 'staat erin'], 'WOZ en polis alleen controleren');
  const zonder = V.opleverLijst({ md: '---\nstatus: afgerond\n---\n# Kelder\n', woning: na, polis: null, gezien_af: '2027-04-12' });
  assert.strictEqual(zonder.datum, null, 'de waargenomen dag is geen opleverdatum');
  assert.ok(zonder.punten.filter((p) => p.punt !== 'Herbouwwaarde opstalverzekering').every((p) => p.staat !== 'staat erin'), 'zonder datum niets afgevinkt');
  assert.strictEqual(zonder.gezien_af, '2027-04-12');
});
test('projectKaarten: afgerond bouwproject alleen kort na de oplevering (datum op de pagina of eerder als lopend gezien)', () => {
  const af = '---\nstatus: afgerond\nopgeleverd: 10-4-2027\n---\n# Kelder — verbouwplan\n';
  const oud = '---\ntags: [verbouwing]\nstatus: afgerond\nupdated: 2027-04-01\n---\n# Verbouwing 2018-2019\n';
  const basis = { kostte: null, kern: null, cw: [], bekendmakingen: [], adres: null, stukken: [], woning: WONING_O, polis: POLIS };
  let r = V.projectKaarten(Object.assign({ vandaag: '2027-05-01', paginas: [{ pad: PAD, md: af }, { pad: '20_Prive/Huis/Oud.md', md: oud }] }, basis));
  assert.strictEqual(r.length, 1, 'oud project zonder datum: geen kaart'); assert.strictEqual(r[0].af, true); assert.strictEqual(r[0].oplevering.punten.length, 5);
  r = V.projectKaarten(Object.assign({ vandaag: '2028-07-01', paginas: [{ pad: PAD, md: af }] }, basis));
  assert.strictEqual(r.length, 0, 'na 425 dagen weg');
  r = V.projectKaarten(Object.assign({ vandaag: '2027-05-01', paginas: [{ pad: '20_Prive/Huis/Oud.md', md: oud }], af: { '20_Prive/Huis/Oud.md': '2027-04-20' } }, basis));
  assert.strictEqual(r.length, 1, 'eerder als lopend gezien → kaart'); assert.strictEqual(r[0].oplevering.datum, null);
  r = V.projectKaarten(Object.assign({ vandaag: '2027-05-01', paginas: [{ pad: PAD, md: KELDER }] }, basis));
  assert.strictEqual(r[0].af, false); assert.strictEqual(r[0].oplevering, null, 'lopend: geen opleverlijst');
});
test('GET: bouwfoto\'s op de kaart, fotoroute alleen voor ids op de kaart, Immich weg = kaart blijft; lopend → afgerond gezien; Socev-kern', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fotos-'));
  try {
    const v = M.maakVault(path.join(t, 'vault'));
    fs.writeFileSync(path.join(v, PAD), KELDER);
    let dag = new Date('2027-04-01T10:00:00Z'), weg = false, lijstKeer = 0;
    const gevraagd = [];
    const fotos = { albums: async () => { if (weg) throw new Error('weg'); return ALBUMS; },
      albumFotos: async (id, max) => { lijstKeer++; gevraagd.push([id, max]); return FOTOS; },
      beeld: async (id, maat) => ({ mime: 'image/jpeg', data: Buffer.from('jpeg-' + id + '-' + maat) }) };
    const m = V.maak({ map: path.join(t, 'map'), vault: v, bronnen: M.nepBronnen(), nu: () => dag, fotos });
    let u = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    const f = u.projecten[0].fotos;
    assert.strictEqual(f.ok, true); assert.strictEqual(f.album.naam, 'Kelder bouw'); assert.strictEqual(f.hoe, 'naam'); assert.strictEqual(f.totaal, 40);
    assert.deepStrictEqual(gevraagd, [[U(2), 1000]]);
    const ok = await m.app({ pad: '/app/vastgoed/foto/' + U(110), methode: 'GET' });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.mime, 'image/jpeg');
    assert.strictEqual(Buffer.from(ok.body.data, 'base64').toString(), 'jpeg-' + U(110) + '-klein', 'altijd de miniatuur');
    assert.strictEqual((await m.app({ pad: '/app/vastgoed/foto/' + U(116), methode: 'GET' })).status, 404, 'zevende van de dag staat niet op de kaart');
    assert.strictEqual((await m.app({ pad: '/app/vastgoed/foto/' + U(103), methode: 'GET' })).status, 404, 'video niet');
    assert.strictEqual((await m.app({ pad: '/app/vastgoed/foto/' + U(999), methode: 'GET' })).status, 404, 'ander id niet');
    assert.strictEqual((await m.app({ pad: '/app/vastgoed/foto/..%2f', methode: 'GET' })).status, 404);
    await m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.strictEqual(lijstKeer, 1, 'fotolijst 15 min uit het geheugen');
    // Socev-kern: kort, zonder mailadressen of foto-ids
    const g = await m.gesprek({ opdracht: 'kern' });
    const pk = g.body.projecten[0];
    assert.strictEqual(pk.naam, 'Kelder'); assert.strictEqual(pk.wacht.wat, 'Eerste schatting van de kosten'); assert.ok(pk.wacht.dagen > 100);
    assert.deepStrictEqual(pk.fotos, { album: 'Kelder bouw', aantal: 40, laatste: '2027-04-15' });
    assert.ok(!/@|0000-4000/.test(JSON.stringify(g.body.projecten)), 'geen mailadres of foto-id');
    // Immich weg: kaart blijft, foto's niet te lezen
    weg = true; dag = new Date('2027-04-01T11:00:00Z');
    u = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.strictEqual(u.projecten.length, 1); assert.strictEqual(u.projecten[0].fotos.ok, false); assert.strictEqual(u.projecten[0].wachtpunten.length, 2);
    assert.strictEqual((await m.app({ pad: '/app/vastgoed/foto/' + U(110), methode: 'GET' })).status, 404, 'kaart zonder foto\'s → route dicht');
    // de pagina gaat van lopend naar afgerond (zonder datum): de kaart blijft met de opleverlijst, gezien_af = vandaag
    weg = false; dag = new Date('2027-04-12T10:00:00Z');
    fs.writeFileSync(path.join(v, PAD), KELDER.replace('status: lopend', 'status: afgerond'));
    u = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.strictEqual(u.projecten.length, 1); assert.strictEqual(u.projecten[0].af, true);
    assert.strictEqual(u.projecten[0].oplevering.gezien_af, '2027-04-12'); assert.strictEqual(u.projecten[0].oplevering.datum, null);
    const g2 = await m.gesprek({ opdracht: 'kern' });
    assert.strictEqual(g2.body.projecten[0].af, true); assert.strictEqual(g2.body.projecten[0].oplevering.open.length, 5);
    // een andere pod/map die hem nooit lopend zag: geen kaart
    const m2 = V.maak({ map: path.join(t, 'map2'), vault: v, bronnen: M.nepBronnen(), nu: () => dag, fotos });
    assert.strictEqual((await m2.app({ pad: '/app/vastgoed', methode: 'GET' })).body.projecten.length, 0);
    // zonder Immich-koppeling: fotos.ok false, route 404
    const m3 = V.maak({ map: path.join(t, 'map3'), vault: v, bronnen: M.nepBronnen(), nu: () => dag });
    fs.writeFileSync(path.join(v, PAD), KELDER);
    const u3 = (await m3.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.strictEqual(u3.projecten[0].fotos.ok, false);
    assert.strictEqual((await m3.app({ pad: '/app/vastgoed/foto/' + U(110), methode: 'GET' })).status, 404);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
