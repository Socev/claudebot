'use strict';
// wv2886: OVIS GHAWA fase 4 (Stichting) op een VERZONNEN vault en site (namen, nummers en teksten bestaan niet). Toetst: artikel 2 uit de
// stichtingspagina, mijlpalen uit de tabel (ook wikilinks met \| in een cel), overleggen uit Notulen en uit de projectpagina (zelfde datum telt
// één keer), besluiten (overdracht § 13 + "Besluit:" in notulen), actiepunten per persoon (tabel + "Actie X:"), koppeling met de Actie-Bewaker
// (privé nooit, los = alleen daar), ANBI-stukken (ontbreekt, verouderd, jaarformulier byte-gelijk aan vorig jaar), donatiedoelen van de site,
// de afgeleide tabellen (opnieuw opbouwen, hash gelijk = niets), en dat er nooit een rekeningnummer of tekst van een persoonspagina in een
// antwoord staat. Plus de cheque-begunstigde van fase 2 (staart van de omschrijving eraf).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../ghawa-stichting.js');
const B = require('../ghawa-bij.js');
const G = require('../ghawa.js');

const GEHEIM = 'Proefkanttekening Zilverberk';   // staat alleen op een persoonspagina; mag nooit in een antwoord
const IBAN = 'NL99 TEST 0123 4567 89';
function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2886-'));
  const zet = (rel, t) => { fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), t); };
  zet('10_Zakelijk/GHAWA-ECG/GHAWA.md', `---\ntype: organisatie\n---\n# Stichting GHAWA\n\n## Basisgegevens\n\n- Naam: **Stichting GHAWA**\n- Opgericht: **1 januari 2020**\n- Status: ANBI\n- Bankrekening: ${IBAN}\n` +
    `- Voorzitter: [[20_Prive/Gambia/Personen/Proef Voorzitter|Proef Voorzitter]]\n- Penningmeester: [[20_Prive/Gambia/Personen/Proef Penning|Proef Penning]] (proefberoep)\n- Secretaris: Proef Schrijver\n` +
    `- Boekhouding en jaarverslag: Proef Boekhouder (kantoor)\n\n## Doel\n\nIets.\n\n### Doelstelling volgens de statuten (artikel 2)\n\nIntro.\n\n- **2.1** Het doel is proefzorg in\n  Proefdorp.\n- **2.2** Ook al het verdere.\n\nNa.\n`);
  zet('10_Zakelijk/GHAWA-ECG/ECG Foundation.md', `# ECG\n\n## Samenstelling\n\n- **Board of Directors:** Dr. Proef (Proefje) Leider (voorzitter), Mr. Proef Kas (penningmeester).\n- **Executive members:** Dr. Proef Uitvoer (CEO).\n\nDaarna.\n`);
  zet('10_Zakelijk/GHAWA-ECG/Project Sukuta Health Center.md', `# Project\n\n## Mijlpalen tot de eerste patiënt\n\n| Wanneer | Mijlpaal | Stand | Bron |\n|---|---|---|---|\n` +
    `| 2020 | Proefstart | gehaald | [[x/y\\|proefbron]] |\n| 2030 | Eerste proefpatiënt | gepland | [[a/b|c]] |\n\n## Bouwtijdlijn\n\n**Overleg GHAWA-ECG 3-3-2021** (aanwezig A, B; verslag)\n\n` +
    `### Overleg GHAWA-ECG 5-5-2022 — notulen\n\nOnline. ([[q/Notulen proef|notulen NL]])\n\n- **Besluit: proefapotheek pas na de proefkliniek.** Reden: proefvergunning.\n\n| Actie | Wie | Termijn |\n|---|---|---|\n| Proefplanning maken | Proefa en Proefb | z.s.m. |\n\n` +
    `## Overleg GHAWA-ECG 7 juli 2023\n\nDubbel met de notulen.\n`);
  zet('10_Zakelijk/GHAWA-ECG/Notulen/2023-07-07 - Overleg.md', `---\ntype: notulen\ndatum: 2023-07-07\nbronnen: ["[[x/Proefbron|Proef-pdf]]"]\n---\n\n# Overleg proef — 7 juli 2023\n\n**Aanwezig:** Proefa, Proefb;\nProefc.\n\n## Actiepunten\n| Actie | Eigenaar |\n|---|---|\n| **Proefoverzicht delen met beide besturen** | **Proefa en David** |\n| Iets uitzoeken | niet benoemd |\n| Geld naar ${IBAN} overmaken | Proefb |\n\n## Na\n- Actie David: proefbudget bewaken.\n`);
  zet('10_Zakelijk/GHAWA-ECG/Bronnen/Overdracht financien ECG 2026-10-06/ECG finance handover.md', `# H\n\n## 13. Decisions log\n\n| Date | Decision | Why |\n|---|---|---|\n| 4-10-2022 | Proof decision one | Because |\n| 5-10-2022 | Proof decision two | Why not |\n\n## 14. Next\n`);
  zet('20_Prive/Gambia/Personen/Proef Voorzitter.md', `# Proef Voorzitter\n\n> [!note] Indruk\n> ${GEHEIM}\n`);
  zet('20_Prive/Gambia/Personen/Proefje Leider.md', `# PL\n${GEHEIM}\n`);
  zet('10_Zakelijk/GHAWA-ECG/Bronnen/Stichting GHAWA - ANBI-stukken van ghawa.org/statuten.pdf', '%PDF proef');
  zet('10_Zakelijk/GHAWA-ECG/Bronnen/Stichting GHAWA - ANBI-stukken van ghawa.org/statuten.md', '# tekst');
  return v;
}
const SITE = {
  donatiedoelen: '<section class="doelen-intro">\n<p>Proefintro.</p>\n<div class="doel-kaarten"><div class="doel-kaart"><div>🏥</div>\n<h2>Proefcentrum</h2>\n<p>Tekst &amp; meer.</p>\n</div></div></section>' +
    '<table class="totaal-tabel"><tbody><tr><td><strong>Fase 1</strong></td><td>Proefbouw</td><td class="bedrag">GMD 1.000</td><td class="bedrag">€ 10</td></tr>' +
    '<tr class="totaal-rij"><td colspan="2"><strong>Totaal bouw</strong></td><td class="bedrag"><strong>GMD 1.000</strong></td><td class="bedrag"><strong>€ 10</strong></td></tr></tbody></table>' +
    '<section class="jaarlijks-sectie"><table><tr class="totaal-rij"><td>Totaal</td><td>500</td><td>€ 5</td></tr></table><p>Wisselkoers circa GMD 70 = €1</p></section>',
  anbi: { statuten: '<p class="document-meta">Proef &mdash; Vastgesteld 2020</p><p>Koophandel onder nummer <strong>12345678</strong> en RSIN <strong>123456789</strong>.</p>',
    beleidsplan: '<p class="document-meta">Proef &mdash; Vastgesteld 2023</p>' },
  anbiBestanden: [['public/anbi/statuten.pdf', 'aaa'], ['public/anbi/beleidsplan.pdf', 'bbb'], ['public/anbi/pubplicht-2023.pdf', 'ccc'], ['public/anbi/pubplicht-2024.pdf', 'ccc']],
};

test('doelen: artikel 2, mijlpalen (ook \\| in een cel), donatiedoelen van de site', () => {
  const v = vault(); const d = S.leesVault(v);
  assert.deepStrictEqual(d.statuten.map((x) => x.nr), ['2.1', '2.2']);
  assert.match(d.statuten[0].tekst, /proefzorg in Proefdorp/);
  assert.strictEqual(d.mijlpalen.length, 2);
  assert.deepStrictEqual([d.mijlpalen[0].stand, d.mijlpalen[0].bron, d.mijlpalen[1].bron], ['gehaald', 'proefbron', 'c']);
  const r = S.route('doelen', { data: d, site: SITE, vault: v, totalen: { bouw_gmd: 2000, koers: 85 } });
  assert.strictEqual(r.donatiedoelen.doelen[0].titel, 'Proefcentrum');
  assert.strictEqual(r.donatiedoelen.doelen[0].tekst, 'Tekst & meer.');
  assert.deepStrictEqual(r.donatiedoelen.fases, [{ fase: 'Fase 1', wat: 'Proefbouw', gmd: 1000, eur: 10 }]);
  assert.deepStrictEqual([r.donatiedoelen.totaal.gmd, r.donatiedoelen.jaarlijks.gmd, r.donatiedoelen.koers], [1000, 500, 70]);
  assert.strictEqual(S.route('doelen', { data: d, site: null, vault: v }).donatiedoelen, null);
});

test('overleg: notulen + projectpagina (zelfde datum één keer), besluiten, actiepunten per persoon', () => {
  const v = vault(); const d = S.leesVault(v);
  assert.deepStrictEqual(d.overleggen.map((o) => o.datum), ['2023-07-07', '2022-05-05', '2021-03-03']);
  assert.strictEqual(d.overleggen[0].wie, 'Proefa, Proefb; Proefc.');
  assert.deepStrictEqual(d.overleggen[1].stukken, ['notulen NL']);
  const b = d.besluiten.map((x) => [x.datum, x.tekst]);
  assert.deepStrictEqual(b.find((x) => x[0] === '2022-05-05'), ['2022-05-05', 'proefapotheek pas na de proefkliniek.']);
  assert.strictEqual(d.besluiten.find((x) => x.datum === '2022-05-05').waarom, 'proefvergunning.');
  assert.strictEqual(d.besluiten.filter((x) => /Proof decision/.test(x.tekst)).length, 2);
  const a = d.actiepunten.map((x) => [x.eigenaar, x.tekst]);
  assert.ok(a.some((x) => x[0] === 'Proefa, David' && x[1] === 'Proefoverzicht delen met beide besturen'));
  assert.ok(a.some((x) => x[0] === 'David' && x[1] === 'proefbudget bewaken.'));
  assert.ok(a.some((x) => x[0] === 'niet benoemd'));
  assert.ok(a.some((x) => x[0] === 'Proefa, Proefb' && d.actiepunten.find((y) => y.tekst === 'Proefplanning maken').termijn === 'z.s.m.'));
  const r = S.route('overleg', { data: d, bewaker: null, vault: v });
  assert.strictEqual(r.per_persoon[0].naam, 'David');
  assert.strictEqual(r.per_persoon[r.per_persoon.length - 1].naam, 'niet benoemd');
  assert.strictEqual(r.overleggen.find((o) => o.datum === '2022-05-05').besluiten, 1);
});

test('Actie-Bewaker: alleen GHAWA, nooit privé; gekoppeld op bron en tekst, de rest los', () => {
  const v = vault(); const d = S.leesVault(v);
  const rijen = [
    { actie_id: 'g1', entiteit: 'GHAWA-ECG', actie: 'Proefoverzicht delen met beide besturen', eigenaar: 'Proefa en David', status: 'gemeld', bron: '10_Zakelijk/GHAWA-ECG/Notulen/2023-07-07 - Overleg.md (7-7)' },
    { actie_id: 'g2', entiteit: 'GHAWA-ECG', actie: 'Iets dat alleen de bewaker kent', eigenaar: 'David', status: 'open', deadline: '2030-01-01', bron: 'WhatsApp' },
    { actie_id: 'p1', entiteit: 'Prive/Gambia (GHAWA-reis)', actie: 'Privézaak die hier nooit mag staan', eigenaar: 'David', status: 'open', bron: 'x' },
  ];
  const r = S.route('overleg', { data: d, bewaker: { op: 'nu', rijen }, vault: v });
  const t = JSON.stringify(r);
  assert.ok(!t.includes('Privézaak'));
  assert.strictEqual(r.actiepunten.find((a) => a.tekst === 'Proefoverzicht delen met beide besturen').bewaker.stand, 'gemeld aan jou');
  const los = r.actiepunten.filter((a) => a.herkomst === 'actie-bewaker');
  assert.deepStrictEqual(los.map((a) => [a.tekst, a.termijn, a.bewaker.stand]), [['Iets dat alleen de bewaker kent', '2030-01-01', 'open']]);
  assert.deepStrictEqual([r.bewaker.gekoppeld, r.bewaker.los], [1, 1]);
  assert.strictEqual(S.route('overleg', { data: d, bewaker: { op: 'nu', rijen: null, fout: 'niet te lezen' }, vault: v }).bewaker.fout, 'niet te lezen');
});

test('statuten en ANBI: stukken (er, verouderd, byte-gelijk jaarformulier, ontbreekt), KvK, bestuur; geen rekeningnummer', () => {
  const v = vault(); const d = S.leesVault(v);
  const r = S.route('stichting', { data: d, site: SITE, vault: v });
  const st = Object.fromEntries(r.stukken.map((x) => [x.titel, x.status]));
  assert.deepStrictEqual(st, { Statuten: 'er', Beleidsplan: 'verouderd', 'Publicatieplicht 2023': 'er', 'Publicatieplicht 2024': 'twijfel', 'Jaarverslag 2025': 'ontbreekt' });
  const s0 = r.stukken[0];
  assert.match(s0.vault, /ANBI-stukken van ghawa\.org\/statuten\.pdf$/);
  assert.match(s0.tekst, /statuten$/);
  assert.strictEqual(s0.url, 'https://www.ghawa.org/anbi/statuten.pdf');
  assert.deepStrictEqual([r.basis.kvk, r.basis.rsin], ['12345678', '123456789']);
  assert.deepStrictEqual(r.bestuur.ghawa.map((p) => [p.naam, p.rol]), [['Proef Voorzitter', 'voorzitter'], ['Proef Penning', 'penningmeester'], ['Proef Schrijver', 'secretaris']]);
  assert.deepStrictEqual(r.bestuur.ecg.map((p) => [p.naam, p.rol, !!p.pagina]), [['Dr. Proef (Proefje) Leider', 'voorzitter', true], ['Mr. Proef Kas', 'penningmeester', false]]);
  assert.deepStrictEqual(r.bestuur.ecg_uitvoerend.map((p) => p.rol), ['ceo']);
  const t = JSON.stringify(r);
  assert.ok(!t.includes('TEST') && !/NL\d\d/.test(t), 'geen rekeningnummer');
  // zonder site: alles wat van de site komt ontbreekt, de rest blijft
  const z = S.route('stichting', { data: d, site: null, vault: v });
  assert.strictEqual(z.site_gelezen, false);
  assert.ok(z.stukken.every((x) => x.status === 'ontbreekt'));
});

test('mensen: naam + rol + pagina, nooit tekst van een persoonspagina; fondsen alleen echte gevers', () => {
  const v = vault(); const d = S.leesVault(v);
  const r = S.route('mensen', { data: d, vault: v, fondsen: [{ gever: 'Proeffonds - 1st part', soort: 'Sponsor' }, { gever: 'Proeffonds - rest', soort: 'Sponsor' }, { gever: 'GHAWA online donations', soort: 'Donations (yearly)' }] });
  assert.deepStrictEqual(r.organisaties.map((o) => o.naam), ['Stichting GHAWA', 'ECG Foundation', 'Proeffonds']);
  assert.ok(r.mensen.some((p) => p.naam === 'Proef Voorzitter' && p.pagina === '20_Prive/Gambia/Personen/Proef Voorzitter'));
  assert.ok(r.mensen.some((p) => p.naam === 'Proef Boekhouder' && p.rol === 'boekhouding en jaarverslag'));
  for (const s of ['doelen', 'stichting', 'overleg', 'mensen']) {
    const t = JSON.stringify(S.route(s, { data: d, site: SITE, vault: v, bewaker: null, fondsen: [] }));
    assert.ok(!t.includes(GEHEIM), 'kanttekening uit een persoonspagina in ' + s);
    assert.ok(!/NL\d\d\s?[A-Z]{4}/.test(t), 'rekeningnummer in ' + s);
    if (s === 'overleg') assert.ok(t.includes('Geld naar (rekeningnummer) overmaken'), 'masker in overleg');
  }
});

test('databank: tabellen overleg/besluit/actiepunt/mijlpaal opnieuw opgebouwd; zelfde bronnen = niets; via ghawa.js app()', () => {
  const v = vault(); const d = S.leesVault(v);
  const { DatabaseSync } = require('node:sqlite');
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wv2886-db-')), 'g.sqlite');
  const db = new DatabaseSync(p);
  db.exec('CREATE TABLE meta (sleutel TEXT PRIMARY KEY, waarde TEXT)');
  assert.deepStrictEqual(S.bewaar(db, d, '2030-01-01T00:00:00Z'), { gewijzigd: true });
  assert.deepStrictEqual(S.bewaar(db, d, '2030-01-01T00:00:00Z'), { gewijzigd: false });
  const n = (t) => db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
  assert.deepStrictEqual([n('overleg'), n('besluit'), n('actiepunt'), n('mijlpaal')], [3, d.besluiten.length, d.actiepunten.length, 2]);
  const d2 = Object.assign({}, d, { mijlpalen: d.mijlpalen.slice(0, 1) });
  assert.deepStrictEqual(S.bewaar(db, d2, '2030-01-02T00:00:00Z'), { gewijzigd: true });
  assert.strictEqual(n('mijlpaal'), 1);
  const uit = S.leesDb(db);
  assert.strictEqual(uit.overleggen[0].datum, '2023-07-07');
  assert.deepStrictEqual(uit.overleggen[1].stukken, ['notulen NL']);
  db.close();
  // via de app: zonder databank rechtstreeks uit de vault (200)
  const app = G.maak({ dbPad: path.join(path.dirname(p), 'bestaat-niet.sqlite'), vaultMap: v }).app;
  for (const s of ['doelen', 'stichting', 'overleg', 'mensen']) assert.strictEqual(app({ pad: '/app/ghawa/' + s, site: SITE }).status, 200);
  assert.strictEqual(app({ pad: '/app/ghawa/overleg/x' }).status, 503);   // geen sub-pad voor de stichtingsschermen
});

test('fase 2: cheque-begunstigde zonder de staart van de omschrijving', () => {
  assert.strictEqual(B.chequeNaam('EGM CHQ NO - 42 PAID TO PROEF O NAAM 00000042 2030-11-03 PAID TO  SELF @ EGM ECOBANK GAMBIA - SENE'), 'Proef O Naam');
  assert.strictEqual(B.chequeNaam('EGM CHQ NO 13 PAID TO PAID TO PROEF M. NAAM'), 'Proef M. Naam');
  assert.strictEqual(B.chequeNaam('CHQ 7 PAID TO PROEF SOLAR (PROEF F. NAAM)'), 'Proef Solar (Proef F. Naam)');
  assert.strictEqual(B.chequeNaam('CHQ NO 5 PAID TO PROEF NAAM PAID TO SELF @ X'), 'Proef Naam');
  assert.strictEqual(B.chequeNaam('CHQ NO 6 PAID TO PROEF ANDER@EGM'), 'Proef Ander');
  assert.strictEqual(B.chequeNaam('CASH WDL'), null);
  const r = B.deelInEcg([{ datum: '2030-01-01', omschrijving: 'EGM CHQ NO - 9 PAID TO PROEF NAAM 00000009 2030-01-01 PAID TO SELF @ X', referentie: 'R1', bedrag: -100 }], 'GMD');
  assert.deepStrictEqual([r[0].soort, r[0].cheque, r[0].begunstigde], ['Cheque withdrawal', '9', 'Proef Naam']);
});
