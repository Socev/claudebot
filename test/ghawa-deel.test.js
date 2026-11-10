'use strict';
// wv2889: OVIS GHAWA fase 5 (Delen met ECG) op een VERZONNEN databank en vault (namen, nummers en teksten bestaan niet). Toetslijst uit het
// ontwerp § 6: (a) witte lijst per onderdeel (kruisproef: kolom geheim erbij), (b) bytes van de batch naar D1 (kruisproef: naamdeel van een
// donateur in een goedgekeurde omschrijving → poort rood: nul inhoud-INSERTs, wél blok + DELETE), (c) uit = DELETE in dezelfde ronde,
// (d) GHAWA-blok (< 10 giften, 0 of ≥ 3 gewijzigd per getal, nageboekt, gecorrigeerd, verdwenen, grote bedragen als getal), zelfgeschreven
// tekst pas na Share, (d2) begunstigde → Payee-label (kruisproef: zonder vervangen → poort rood), (d3) iemand eraf → bevestigd vóór de ronde,
// houdbaarheid 72 u, (d4) late batch na intrekken heropent niets (kruisproef zonder blok-voorwaarde), (d5) tekst niet goedgekeurd of één teken
// anders → pending, (d6) teruglezen met een nieuwe naam → dicht, (e) mijlpaal zonder Engels niet mee, (f) overleg niet gedeeld → acties niet mee.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const D = require('../ghawa-deel.js');
const FX = require('./ghawa-fixture.js');

const NU = Date.parse('2026-11-10T12:00:00Z');   // stand van het blok = 2026-10-31
function nepD1() {
  const db = new DatabaseSync(':memory:');
  const log = [];
  const f = async (batch) => {
    if (f.traag) await new Promise((r) => setTimeout(r, f.traag));
    if (f.stuk) throw new Error('D1 weg');
    db.exec('BEGIN');
    try {
      const uit = batch.map((q) => {
        log.push(q);
        const st = db.prepare(q.sql);
        if (/^\s*SELECT/i.test(q.sql)) return { results: st.all(...q.params).map((r) => ({ ...r })), meta: { changes: 0 } };
        const r = st.run(...q.params); return { results: [], meta: { changes: Number(r.changes) } };
      });
      db.exec('COMMIT');
      if (f.naFout) throw new Error('antwoord kwijt');   // toegepast, maar de pod hoort het nooit
      return uit;
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
  };
  f.db = db; f.log = log; return f;
}
function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2889-v-'));
  const zet = (rel, t) => { fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), t); };
  zet('10_Zakelijk/GHAWA-ECG/GHAWA.md', '# Stichting GHAWA\n\n## Basisgegevens\n\n- Voorzitter: David Proef\n- Penningmeester: Proef Penningmeester\n');
  zet('10_Zakelijk/GHAWA-ECG/ECG Foundation.md', '# ECG\n\n## Samenstelling\n\n- **Board of Directors:** Mr. Proef Kasbewaarder (penningmeester).\n- **Executive members:** Momodou Proef (CEO).\n');
  zet('10_Zakelijk/GHAWA-ECG/Project Sukuta Health Center.md', '# Project\n\n## Mijlpalen tot de eerste patiënt\n\n| Wanneer | Mijlpaal | English | Stand | Bron |\n|---|---|---|---|---|\n' +
    '| 2020 | Proefstart | Test start | gehaald | x |\n| 2030 | Eerste proefpatiënt |  | gepland | y |\n\n## Bouwtijdlijn\n\n' +
    '### Overleg GHAWA-ECG 5-5-2022 — notulen\n\nOnline.\n\n- **Besluit: proefapotheek pas na de proefkliniek.** Reden: proefvergunning.\n\n| Actie | Wie | Termijn |\n|---|---|---|\n| Make the test plan | David en Momodou | 2022-06-01 |\n');
  return v;
}
function omgeving(opties) {
  const fx = FX.vers();
  const db = new DatabaseSync(fx.db);
  // GHAWA-giften: 12 per jaar 2024, 2025, 2026 (verzonnen bedragen), plus een paar in 2023 (< 10: gaat samen met 2024)
  const ins = db.prepare('INSERT INTO bankregel_ghawa (id, rekening, datum, jaar, bedrag_cent, richting, tegenpartij, tegenrekening, soort, donateur, volg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let v = 100;
  for (const j of [2023, 2024, 2025, 2026]) for (let i = 0; i < (j === 2023 ? 3 : 12); i++) ins.run('T' + j + '-' + i, 'Current NL00', j + '-0' + (1 + (i % 9)) + '-1' + (i % 9), j, 1000 + i * 7, 'in', 'Proef Gever ' + i, 'NL00PROE' + String(1000000000 + i), 'Donation (bank transfer)', null, v++);
  db.close();
  const v1 = vault();
  const d1 = nepD1();
  let nu = NU;
  const m = D.maak({ dbPad: fx.db, vault: v1, d1, nu: () => nu, fout: (opties && opties.fout) || (() => {}) });
  return { fx, d1, m, vault: v1, sql: () => new DatabaseSync(fx.db), zetNu: (t) => { nu = t; } };
}
async function alleAan(o, ids) {
  for (const id of ids || D.IDS) { const r = await o.m.schakel(id, true); assert.ok(r.status === 200 || r.body.leeg, id + ' ' + JSON.stringify(r.body)); }
}
async function keurAlles(o) {
  const st = o.m.staat();
  for (const t of st.teksten) if (t.poort_ok) o.m.tekstBesluit(t.hash, 'share', 'toets');
  return st.teksten.length;
}
const deelVan = (o, id) => { const r = o.d1.db.prepare('SELECT json FROM deel WHERE onderdeel = ? ORDER BY stuk').all(id); return r.length ? JSON.parse(r.map((x) => x.json).join('')) : null; };

test('(a) witte lijst: sleutels per onderdeel = DEEL_KOLOMMEN; kruisproef: kolom geheim in de databank gaat niet mee', async () => {
  const o = omgeving();
  const db = o.sql(); db.exec("ALTER TABLE uitgave ADD COLUMN geheim TEXT; UPDATE uitgave SET geheim = 'GEHEIM-ZILVERREIGER'"); db.close();
  await keurAlles(o); await alleAan(o); await o.m.ronde();
  const bytes = JSON.stringify(o.d1.log);
  assert.ok(!bytes.includes('ZILVERREIGER'), 'kolom geheim ging mee');
  for (const id of D.IDS) {
    const doc = deelVan(o, id); if (!doc) continue;
    const K = D.DEEL_KOLOMMEN[id];
    assert.deepStrictEqual(Object.keys(doc), K.top, id + ' top');
    for (const [soort, sl] of Object.entries(K)) {
      if (soort === 'top') continue;
      const [a, b] = soort.split('.');
      const v = doc[a]; if (v == null) continue;
      const rijen = b ? [].concat(...(Array.isArray(v) ? v : [v]).map((x) => x[b] || [])) : Array.isArray(v) ? v : [v];
      for (const r of rijen) assert.deepStrictEqual(Object.keys(r), sl, id + '.' + soort);
    }
  }
  assert.ok(deelVan(o, 'construction').expenditures.length > 0, 'construction heeft uitgaven');
});

test('(b) bytes naar D1: geen donateur, tegenrekening, IBAN of ≥ 9 cijfers; kruisproef naamdeel in een goedgekeurde tekst → dicht, blok + DELETE, nul inhoud-INSERTs', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o); await o.m.ronde();
  const tekst = o.d1.log.flatMap((q) => q.params.filter((x) => typeof x === 'string')).join('\n');
  assert.ok(!tekst.includes('Pietersen') && !tekst.includes(FX.DONOR), 'donateursnaam');
  assert.ok(!/NL00PROE|NL00TEST/.test(tekst), 'rekeningnummer');
  for (const q of o.d1.log) for (const x of q.params) if (typeof x === 'string' && !/^[0-9a-f]{64}$/.test(x)) assert.ok(!/\d{9,}/.test(x), 'cijfers ≥ 9');
  assert.ok(deelVan(o, 'construction'), 'construction staat buiten');
  // kruisproef: het naamdeel van een privé-donateur in een omschrijving die David deelde → poort rood
  const db = o.sql(); db.prepare("UPDATE uitgave SET omschrijving = 'Blocks paid by Pietersen' WHERE id = 'T0001'").run(); db.close();
  const st = o.m.staat(), t = st.teksten.find((x) => /Pietersen/.test(x.tekst));
  assert.ok(t && t.poort_ok === false, 'tekst met naamdeel is poort-rood in de lijst');
  assert.strictEqual(o.m.tekstBesluit(t.hash, 'share', 'toets').status, 409, 'delen geweigerd');
  assert.strictEqual(o.m.tekstBesluit(t.hash, 'share', 'toets', { poortBijDelen: false }).status, 200);   // stel dat het toch op de lijst komt
  const voor = o.d1.log.length;
  await o.m.ronde();
  const na = o.d1.log.slice(voor);
  assert.strictEqual(na.filter((q) => /^INSERT INTO deel /.test(q.sql) && q.params[0] === 'construction').length, 0, 'geen inhoud-INSERT');
  assert.ok(na.some((q) => /^INSERT INTO blok/.test(q.sql) && q.params[1] === 'construction'), 'blok-rij');
  assert.ok(na.some((q) => /^DELETE FROM deel WHERE onderdeel = \?$/.test(q.sql) && q.params[0] === 'construction'), 'DELETE');
  assert.strictEqual(deelVan(o, 'construction'), null, 'niets meer buiten');
  assert.ok(o.d1.db.prepare("SELECT 1 FROM blok WHERE soort = 'onderdeel' AND sleutel = 'construction'").get(), 'blok staat');
  assert.strictEqual(o.m.staat().onderdelen.find((x) => x.id === 'construction').aan, false, 'schakelaar uit');
  const s = o.sql(); const sg = s.prepare("SELECT tekst FROM signaal WHERE id = 'delen:construction'").get(); s.close();
  assert.ok(sg && !/Pietersen/.test(sg.tekst), 'signaal zonder de treffer');
  assert.ok(deelVan(o, 'pharmacy'), 'andere onderdelen blijven');
});

test('(c) schakelaar uit → blok + DELETE in dezelfde handeling, bevestigd; weer aan haalt het blok weg', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['funds']); await o.m.ronde();
  assert.ok(deelVan(o, 'funds'));
  const r = await o.m.schakel('funds', false);
  assert.strictEqual(r.body.dicht, true);
  assert.strictEqual(deelVan(o, 'funds'), null);
  assert.strictEqual(o.d1.db.prepare("SELECT count(*) n FROM publicatie WHERE onderdeel = 'funds'").get().n, 0);
  await o.m.schakel('funds', true);
  assert.ok(deelVan(o, 'funds'), 'weer aan');
  assert.ok(!o.d1.db.prepare("SELECT 1 FROM blok WHERE sleutel = 'funds'").get());
});

test('(d) GHAWA-blok: samenvoegen < 10, 0 of ≥ 3 gewijzigd per getal, nageboekt, gecorrigeerd, verdwenen, lopend jaar < 10', () => {
  const rij = (id, jaar, b, soort) => ({ id, datum: jaar + '-05-01', jaar, bedrag_cent: b, soort: soort || 'Donation (bank transfer)' });
  const basis = [];
  for (const j of [2023, 2024, 2025, 2026]) for (let i = 0; i < (j === 2023 ? 4 : 11); i++) basis.push(rij(j + '-' + i, j, 1000 + i));
  basis.push(rij('k1', 2025, -500, 'Bank costs'), rij('e1', 2025, -2000, 'Transfer to ECG'));
  const leeg = new Map();
  const b0 = D.ghawaBlok(basis, leeg, '2026-10-31');
  assert.ok(b0.mag, b0.redenen.join());
  assert.deepStrictEqual(b0.blok.years.map((y) => y.year), ['2023–2024', '2025', '2026'], '2023 (< 10) samen met 2024');
  const vorig = b0.giften;
  const plus = (l, ...r) => l.concat(r);
  assert.ok(!D.ghawaBlok(plus(basis, rij('n1', 2026, 777)), vorig, '2026-10-31').mag, '1 nieuwe gift: blok blijft');
  assert.ok(!D.ghawaBlok(plus(basis, rij('n1', 2026, 777), rij('n2', 2026, 778)), vorig, '2026-10-31').mag, '2 nieuwe: blijft');
  assert.ok(D.ghawaBlok(plus(basis, rij('n1', 2026, 777), rij('n2', 2026, 778), rij('n3', 2026, 779)), vorig, '2026-10-31').mag, '3 nieuwe: nieuw blok');
  assert.ok(!D.ghawaBlok(plus(basis, rij('n0', 2025, 5), rij('n1', 2026, 777), rij('n2', 2026, 778)), vorig, '2026-10-31').mag, 'nageboekt in 2025 + 2 in 2026: blijft');
  const gecorr = basis.map((r) => (r.id === '2025-3' ? Object.assign({}, r, { bedrag_cent: r.bedrag_cent + 1 }) : r));
  assert.ok(!D.ghawaBlok(gecorr, vorig, '2026-10-31').mag, 'één bedrag gecorrigeerd: blijft');
  assert.ok(!D.ghawaBlok(basis.filter((r) => r.id !== '2024-2'), vorig, '2026-10-31').mag, 'één verdwenen: blijft');
  assert.ok(D.ghawaBlok(plus(basis, rij('k2', 2026, -100, 'Bank costs')), vorig, '2026-10-31').mag, 'alleen kosten: mag');
  const weinig = basis.filter((r) => !(r.jaar === 2026 && Number(r.id.split('-')[1]) > 7));
  assert.ok(!D.ghawaBlok(weinig, leeg, '2026-10-31').mag, 'lopend jaar < 10: geen blok');
  // grote bedragen blijven getallen; als tekst sluit hetzelfde getal het onderdeel
  const p = D.poortLijsten({ prive: [], personen: new Map(), variant: new Map(), delen: [], rekeningen: [] });
  assert.deepStrictEqual(D.poort({ years: [{ gifts: 10000000 }], b: 141795950, c: 1417959503 }, p), [], '9 en 10 cijfers als getal');
  assert.strictEqual(D.poort({ x: '1417959503' }, p).length, 1, 'zelfde getal als tekst = rood');
  assert.strictEqual(D.poort({ x: 1.5 }, p).length, 1, 'geen geheel getal = rood');
  assert.deepStrictEqual(D.poort({ rate: 80.25 }, p), [], 'rate mag een breuk zijn');
  assert.ok(D.technischOk({ hash: '123456789' + 'a'.repeat(55), versie: 1, op: NU, stuk: 0 }), 'hash met 9 cijfers is vorm-ok');
});

test('(d) zelfgeschreven tekst gaat pas mee na de aparte tik Share (kruisproef: alleen opslaan → niet mee)', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['questions']); await o.m.ronde();
  const db = o.sql(); db.prepare("UPDATE open_vraag SET antwoord = 'We will send the receipts next week' WHERE id = 'Q01'").run(); db.close();
  o.m.markeerVuil(); await o.m.ronde();
  const q = deelVan(o, 'questions').questions.find((x) => x.id === 'Q01');
  assert.strictEqual(q.answer, D.PENDING, 'alleen opgeslagen: niet mee');
  const t = o.m.staat().teksten.find((x) => /receipts next week/.test(x.tekst));
  o.m.tekstBesluit(t.hash, 'share', 'toets'); await o.m.ronde();
  assert.strictEqual(deelVan(o, 'questions').questions.find((x) => x.id === 'Q01').answer, 'We will send the receipts next week');
});

test('(d2) begunstigde → Payee-label, gelijk in alle onderdelen; kruisproef: zonder vervangen vangt de poort de naam', async () => {
  const o = omgeving();
  const db = o.sql(); db.prepare("UPDATE uitgave SET omschrijving = 'Labour paid to Builder' WHERE id = 'T0003'").run(); db.close();
  await keurAlles(o); await alleAan(o, ['accounts', 'construction']); await o.m.ronde();
  const payee = deelVan(o, 'accounts').bank.find((b) => b.cheque === '2').payee;
  assert.match(payee, /^Payee [A-Z]{3,}$/);
  const u = deelVan(o, 'construction').expenditures.find((x) => x.id === 'T0003');
  assert.strictEqual(u.description, 'Labour paid to ' + payee, 'zelfde label in vrije tekst');
  assert.ok(!JSON.stringify(o.d1.log).includes('Builder'), 'naam nergens buiten');
  // kruisproef: pakket zonder vervangen (identiteit) → poort vindt de naam
  const x = o.m._lees(), b = o.m._bouw(x);
  const zonder = D.bouwPakketten({ k: x.k, d: x.d, rijen: x.rijen, stichting: x.stichting, lab: { tekst: (s) => s, payee: (n) => n }, goed: new Map([...x.goed].concat([])), mijlpalen: [], gedeeldeOverleggen: new Set(), blok: null, personenSoort: x.personenSoort });
  for (const t of zonder.nieuw) x.goed.set(t.hash, 'share');
  const z2 = D.bouwPakketten({ k: x.k, d: x.d, rijen: x.rijen, stichting: x.stichting, lab: { tekst: (s) => s, payee: (n) => n }, goed: x.goed, mijlpalen: [], gedeeldeOverleggen: new Set(), blok: null, personenSoort: x.personenSoort });
  assert.ok(D.poort(z2.pakket.accounts, b.poortL).some((t) => t.reden === 'naam'), 'poort rood zonder vervangen');
});

test('(d3) iemand eraf → bevestigde DELETE + blok vóór de gewone ronde; houdbaarheid 72 u', async () => {
  const o = omgeving();
  const r = await o.m.kijkerErbij({ naam: 'Proef Kijker', adres: 'kijker@voorbeeld.invalid' }, 'toets');
  assert.strictEqual(r.status, 200);
  assert.ok(o.d1.db.prepare('SELECT 1 FROM bezoeker WHERE hash = ?').get(r.body.hash), 'erbij in D1');
  o.d1.traag = 30;
  await keurAlles(o); await alleAan(o, ['funds']);
  const rondeP = o.m.ronde();
  const weg = await o.m.kijkerEraf(r.body.hash);
  assert.strictEqual(weg.body.dicht, true);
  await rondeP; o.d1.traag = 0;
  assert.ok(!o.d1.db.prepare('SELECT 1 FROM bezoeker WHERE hash = ?').get(r.body.hash), 'weg uit D1');
  assert.ok(o.d1.db.prepare("SELECT 1 FROM blok WHERE soort = 'bezoeker' AND sleutel = ?").get(r.body.hash), 'blok voor de bezoeker');
  await o.m.ronde();
  assert.ok(!o.d1.db.prepare('SELECT 1 FROM bezoeker WHERE hash = ?').get(r.body.hash), 'een latere ronde zet hem niet terug');
  const p = o.d1.db.prepare("SELECT geldig_tot FROM publicatie WHERE onderdeel = 'funds'").get();
  assert.strictEqual(p.geldig_tot, NU + 72 * 3600000);
  // D1 weg bij eraf: nog niet dicht, en de pod probeert het opnieuw
  const r2 = await o.m.kijkerErbij({ naam: 'Proef Twee', adres: 'twee@voorbeeld.invalid' }, 'toets');
  o.d1.stuk = true;
  const w2 = await o.m.kijkerEraf(r2.body.hash);
  assert.strictEqual(w2.body.dicht, false);
  o.d1.stuk = false; await o.m.ronde();
  assert.ok(!o.d1.db.prepare('SELECT 1 FROM bezoeker WHERE hash = ?').get(r2.body.hash), 'ronde ruimt hem alsnog op');
});

test('(d4) wachtrij: een late batch met de oude schakelaarstand heropent een gesloten onderdeel niet (kruisproef zonder blok-voorwaarde)', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['funds']); await o.m.ronde();
  await o.m.schakel('funds', false);
  assert.strictEqual(deelVan(o, 'funds'), null);
  const doc = { as_of: {}, funds: [] };
  const geplaatst = await o.m._rij(() => o.m._zet('funds', doc));   // de late batch
  assert.strictEqual(geplaatst, false);
  assert.strictEqual(deelVan(o, 'funds'), null, 'blijft dicht');
  // kruisproef: dezelfde INSERT zonder de blok-voorwaarde zou wél schrijven
  o.d1.db.prepare('INSERT INTO deel (onderdeel, stuk, json, hash, op) SELECT ?, 0, ?, ?, ?').run('funds', JSON.stringify(doc), 'a'.repeat(64), NU);
  assert.ok(deelVan(o, 'funds'), 'zonder voorwaarde = heropend (rood)');
});

test('(d5) tekst niet op de lijst of één teken anders → pending; kruisproef: naam in een goedgekeurde vraag geplakt gaat niet mee', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['questions']); await o.m.ronde();
  const q0 = deelVan(o, 'questions').questions.find((x) => x.id === 'Q01');
  assert.strictEqual(q0.question, 'What was cheque 4 for?');
  const db = o.sql(); db.prepare("UPDATE open_vraag SET vraag = 'What was cheque 4 for? Ask Zilverbaard Quist' WHERE id = 'Q01'").run(); db.close();
  o.m.markeerVuil(); await o.m.ronde();
  assert.strictEqual(deelVan(o, 'questions').questions.find((x) => x.id === 'Q01').question, D.PENDING);
  assert.ok(!JSON.stringify(o.d1.log).includes('Zilverbaard'));
  const db2 = o.sql(); db2.prepare("UPDATE open_vraag SET vraag = 'What was cheque 4 for?!' WHERE id = 'Q01'").run(); db2.close();
  await o.m.ronde();
  assert.strictEqual(deelVan(o, 'questions').questions.find((x) => x.id === 'Q01').question, D.PENDING, 'één teken anders');
});

test('(d6) dagelijkse terugleescontrole met een nieuw toegevoegde naam → onderdeel dicht', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['funds', 'questions']); await o.m.ronde();
  assert.ok(JSON.stringify(deelVan(o, 'funds')).includes('Sponsor Zon'));
  const t1 = await o.m.terugLees();
  assert.deepStrictEqual(t1.dicht, []);
  const db = o.sql(); db.prepare("INSERT INTO deel_naam (naam, soort) VALUES ('Sponsor Zon', 'persoon')").run(); db.close();
  const t2 = await o.m.terugLees();
  assert.deepStrictEqual(t2.dicht, ['funds']);
  assert.strictEqual(deelVan(o, 'funds'), null);
  assert.ok(deelVan(o, 'questions'), 'het andere onderdeel blijft');
});

test('(e) mijlpaal zonder Engelse tekst gaat niet mee; (f) overleg niet gedeeld → zijn acties niet mee', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['milestones', 'meetings']); await o.m.ronde();
  const ms = deelVan(o, 'milestones').milestones;
  assert.deepStrictEqual(ms.map((x) => x.text), ['Test start']);
  assert.strictEqual(o.m.staat().mijlpalen_zonder_engels, 1);
  assert.deepStrictEqual(deelVan(o, 'meetings').meetings, [], 'niet gedeeld');
  assert.ok(!JSON.stringify(o.d1.log).includes('test plan'));
  const ov = o.m.staat().overleggen; assert.ok(ov.length >= 1);
  o.m.overlegDeel(ov[0].sleutel, true, 'toets');
  await keurAlles(o); await o.m.ronde();
  const mt = deelVan(o, 'meetings').meetings;
  assert.strictEqual(mt.length, 1);
  assert.deepStrictEqual(mt[0].actions.map((a) => [a.text, a.owner]), [['Make the test plan', 'David, Momodou']]);
});

test('noodstop: D1 stand meteen 1; uit weer 0; health zonder inhoud', async () => {
  const o = omgeving();
  await o.m.noodstop(true);
  assert.strictEqual(o.d1.db.prepare("SELECT waarde FROM stand WHERE sleutel = 'noodstop'").get().waarde, '1');
  await o.m.noodstop(false);
  assert.strictEqual(o.d1.db.prepare("SELECT waarde FROM stand WHERE sleutel = 'noodstop'").get().waarde, '0');
  const h = JSON.stringify(o.m.health());
  assert.ok(!/Pietersen|Proef|@/.test(h));
});

// ── review wv2889 ronde 1 ──
test('MOET 1 (ronde 2): ook een naam van korte woorden in een referentieveld gaat niet zonder Share mee', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['construction']); await o.m.ronde();
  const db = o.sql(); db.prepare("UPDATE uitgave SET referentie = 'Jan Vos' WHERE id = 'T0002'").run(); db.close();
  o.m.markeerVuil(); await o.m.ronde();
  assert.strictEqual(deelVan(o, 'construction').expenditures.find((x) => x.id === 'T0002').reference, D.PENDING);
});

test('MOET 1: een naam in een referentieveld gaat niet zonder Share mee (vaste vorm of tekstgoedkeuring)', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['construction']); await o.m.ronde();
  const db = o.sql(); db.prepare("UPDATE uitgave SET referentie = 'Paid Zilverbaard' WHERE id = 'T0002'").run(); db.close();
  o.m.markeerVuil(); await o.m.ronde();
  const u = deelVan(o, 'construction').expenditures.find((x) => x.id === 'T0002');
  assert.strictEqual(u.reference, D.PENDING);
  assert.strictEqual(deelVan(o, 'construction').expenditures.find((x) => x.id === 'T0001').reference, 'INV1', 'code blijft gewoon');
  assert.ok(!JSON.stringify(o.d1.log).includes('Zilverbaard'));
});

test('MOET 2: noodstop en iemand eraf die D1 niet bevestigde, worden elke tik opnieuw gestuurd', async () => {
  const o = omgeving();
  const r = await o.m.kijkerErbij({ naam: 'Proef Kijker', adres: 'kijker@voorbeeld.invalid' }, 'toets');
  o.d1.stuk = true;
  assert.strictEqual((await o.m.noodstop(true)).body.bevestigd, false);
  assert.strictEqual((await o.m.kijkerEraf(r.body.hash)).body.dicht, false);
  o.d1.stuk = false;
  await o.m.tik();
  assert.strictEqual(o.d1.db.prepare("SELECT waarde FROM stand WHERE sleutel = 'noodstop'").get().waarde, '1', 'noodstop alsnog buiten');
  assert.ok(!o.d1.db.prepare('SELECT 1 FROM bezoeker WHERE hash = ?').get(r.body.hash), 'eraf alsnog buiten');
  assert.ok(o.d1.db.prepare("SELECT 1 FROM blok WHERE soort = 'bezoeker' AND sleutel = ?").get(r.body.hash));
});

test('MOET 3: een gepubliceerde jaargroep wordt later niet gesplitst', () => {
  const rij = (id, jaar, b) => ({ id, datum: jaar + '-05-01', jaar, bedrag_cent: b, soort: 'Donation (bank transfer)' });
  const r0 = [rij('a', 2023, 500)]; for (let i = 0; i < 12; i++) r0.push(rij('b' + i, 2024, 100 + i), rij('c' + i, 2025, 100 + i));
  const b0 = D.ghawaBlok(r0, new Map(), '2025-10-31');
  assert.deepStrictEqual(b0.blok.years.map((y) => y.year), ['2023–2024', '2025']);
  const r1 = r0.slice(); for (let i = 0; i < 9; i++) r1.push(rij('n' + i, 2023, 50 + i));   // 2023 heeft nu 10 giften
  const b1 = D.ghawaBlok(r1, b0.giften, '2025-10-31', b0.groepen);
  assert.deepStrictEqual(b1.blok.years.map((y) => y.year), ['2023–2024', '2025'], 'blijft samen');
  const zonder = D.ghawaBlok(r1, b0.giften, '2025-10-31');
  assert.deepStrictEqual(zonder.blok.years.map((y) => y.year), ['2023', '2024', '2025'], 'kruisproef: zonder vaste groepen zou hij splitsen');
});

test('MOET 4 (ronde 1 en 2): elk blok dat buiten kán staan telt mee — push mislukt, push toegepast maar bevestiging kwijt, en een keten van blokken', async () => {
  const o = omgeving();
  await keurAlles(o); await alleAan(o, ['totals', 'overview']); await o.m.ronde();
  const s0 = deelVan(o, 'totals').balance.eur_cent;
  let volg = 900;
  const voeg = (id, b) => { const db = o.sql(); db.prepare("INSERT INTO bankregel_ghawa (id, rekening, datum, jaar, bedrag_cent, soort, volg) VALUES (?, 'Current NL00', '2026-10-05', 2026, ?, 'Donation (bank transfer)', ?)").run(id, b, volg++); db.close(); };
  const weg = (id) => { const db = o.sql(); db.prepare('DELETE FROM bankregel_ghawa WHERE id = ?').run(id); db.close(); };
  const hist = () => { const d = o.sql(); const r = d.prepare("SELECT waarde FROM deel_stand WHERE sleutel = 'ghawa_historie'").get(); d.close(); return r ? JSON.parse(r.waarde).length : 0; };
  assert.strictEqual(hist(), 1);
  // push toegepast in D1, maar het antwoord komt nooit aan
  voeg('x1', 300); voeg('x2', 301); voeg('x3', 302);
  o.d1.naFout = true; o.m.markeerVuil();
  await assert.rejects(o.m.ronde());
  o.d1.naFout = false;
  assert.strictEqual(hist(), 2, 'het blok staat al in de historie vóór de push');
  const s1 = s0 + 903;
  assert.strictEqual(deelVan(o, 'totals').balance.eur_cent, s1, 'buiten staat het nieuwe blok (toegepast)');
  // één gift erbij: t.o.v. het toegepaste blok maar 1 → blijft dat blok
  voeg('x4', 303); o.m.markeerVuil(); await o.m.ronde();
  assert.strictEqual(deelVan(o, 'totals').balance.eur_cent, s1);
  // keten: twee van de drie weer weg + x4 → t.o.v. het oudste blok maar 2 gewijzigd (x3, x4) → mag niet, ook al is het t.o.v. het laatste blok 3
  weg('x1'); weg('x2'); o.m.markeerVuil(); await o.m.ronde();
  assert.strictEqual(deelVan(o, 'totals').balance.eur_cent, s1, 'vergelijking met álle eerdere blokken');
  const ov = deelVan(o, 'overview'); assert.strictEqual(ov.to_raise_as_of, '2026-10-31');
  // push mislukt helemaal: het blok blijft in de historie en gaat de volgende keer precies zo opnieuw
  voeg('x5', 304); voeg('x6', 305); voeg('x7', 306); voeg('x8', 307);
  o.d1.stuk = true; o.m.markeerVuil(); await assert.rejects(o.m.ronde()); o.d1.stuk = false;
  const h3 = hist(); assert.strictEqual(h3, 3);
  o.m.markeerVuil(); await o.m.ronde();
  assert.strictEqual(hist(), h3, 'zelfde blok, geen nieuwe historie');
  assert.strictEqual(deelVan(o, 'totals').balance.eur_cent, s0 + 302 + 303 + 304 + 305 + 306 + 307);
});
