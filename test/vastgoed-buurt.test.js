'use strict';
// wv4226 (besluitenpagina nr 938 = L38, David Ja 25-11-2026 22:27): de buurtwachter van Vastgoed. Droog met een opgeslagen week van de bron
// (verzonnen bekendmakingen in de vorm van het SRU-antwoord, gemeten 27-11-2026). Toetst: eerste vraag = nulpunt (stil), een nieuwe bekendmaking
// = één regel met link, een week zonder nieuws = niets, dezelfde bekendmaking twee keer (ook na wegvallen) = één regel, een storing = niets en
// volgende dag opnieuw, binnen de week = geen aanroep, het plan van de gemeente apart. VASTGOED_JS=<pad> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VJS = process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js');
const V = require(VJS);
const M = require('./vastgoed-maak.js');

const bm = (id, titel, datum, rubriek) => ({ id, titel, datum, rubriek: rubriek || 'omgevingsvergunning', url: `https://zoek.officielebekendmakingen.nl/${id}.html`, blad: 'Gemeenteblad' });
const A = bm('gmb-2026-100001', 'Aanvraag omgevingsvergunning Proeflaan 3, 9999 ZZ Proefdorp, het bouwen van een dakkapel', '2026-11-20');
const B = bm('gmb-2026-100002', 'Verleende omgevingsvergunning Proeflaan 5, 9999 ZZ Proefdorp, het plaatsen van een uitbouw', '2026-12-03');
const P = bm('gmb-2026-100003', 'Omgevingsplan Proefdorp, wijziging parkeernormen', '2026-12-04', 'ruimtelijk plan of omgevingsdocument');

function opzet() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-buurt-'));
  const v = M.maakVault(path.join(t, 'vault'));
  let klok = new Date('2026-12-01T08:00:00Z');
  const st = { straal: [A], gemeente: [], faal: false, vragen: [] };
  const basis = M.nepBronnen();
  const bronnen = async function (invoer) {
    if (invoer.buurt) {
      st.vragen.push(JSON.parse(JSON.stringify(invoer.buurt)));
      if (st.faal) return { ok: false };
      const b = {};
      if (invoer.buurt.rd) b.straal = { ok: true, n: st.straal.length, items: st.straal };
      if (invoer.buurt.gemeente) b.gemeente = { ok: true, n: st.gemeente.length, items: st.gemeente };
      return { ok: true, buurt: b, aanroepen: [{ bron: 'Officiële bekendmakingen (SRU)', host: 'repository.overheid.nl', naar_buiten: 'punt afgerond op 100 m, straal 250 m', status: '200', ms: 5 }] };
    }
    const r = await basis(invoer);
    r.objecten[0].feiten.push({ groep: 'ls', rubriek: 'regels', veld: 'Gemeente', waarde: 'Proefgemeente', bron: 'PDOK Locatieserver' });
    return r;
  };
  const m = V.maak({ map: path.join(t, 'map'), vault: v, bronnen, nu: () => klok });
  const db = () => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(path.join(t, 'map', 'vastgoed.sqlite'), { readOnly: true }); };
  const dag = async (d) => { klok = new Date(klok.getTime() + d * 86400000); return m.ronde({ dag: klok.toISOString().slice(0, 10) }); };
  return { t, m, st, db, dag, ronde: () => m.ronde({ dag: klok.toISOString().slice(0, 10) }), weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}
const melding = (x) => x.m.meldingOpen();

test('buurtwachter: nulpunt stil, nieuw = één regel met link, geen nieuws = niets, dubbel = één keer, storing stil, week-ritme', async () => {
  const x = opzet();
  try {
    const r1 = await x.ronde();
    assert.ok(r1.buurt.gevraagd, 'eerste ronde vraagt de buurt');
    assert.strictEqual(r1.buurt.gemeld, 0, 'nulpunt: niets gemeld');
    assert.strictEqual(melding(x), null, 'nulpunt: geen melding');
    assert.ok(x.st.vragen[0].rd && x.st.vragen[0].km === 0.25 && x.st.vragen[0].gemeente === 'Proefgemeente', 'punt, straal en gemeente');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(x.st.vragen[0].sinds) && x.st.vragen[0].sinds === '2026-09-02', 'eerste keer 90 dagen terug');
    assert.ok(!('adres' in x.st.vragen[0]) && !JSON.stringify(x.st.vragen[0]).includes('Proefstraat'), 'geen adres naar de bron');
    // binnen de week: geen aanroep
    const n0 = x.st.vragen.length;
    const r2 = await x.dag(3);
    assert.strictEqual(r2.buurt.gevraagd, false, 'binnen de week niet gevraagd');
    assert.strictEqual(x.st.vragen.length, n0, 'geen aanroep binnen de week');
    // na een week: één nieuwe (B), A staat er nog: precies één regel met link
    x.st.straal = [B, A];
    const r3 = await x.dag(4);
    assert.ok(r3.buurt.gevraagd && r3.buurt.gemeld === 1, 'één nieuwe bekendmaking gemeld');
    assert.strictEqual(x.st.vragen.at(-1).sinds, '2026-11-10', 'drie weken terug vanaf de vorige gelukte vraag');
    const m3 = melding(x);
    assert.ok(m3 && /Proeflaan 5/.test(m3.tekst) && m3.tekst.includes('https://zoek.officielebekendmakingen.nl/gmb-2026-100002.html'), 'regel met titel en link');
    assert.ok(!/Proeflaan 3/.test(m3.tekst), 'de al bekende niet');
    assert.strictEqual(m3.tekst.split('\n').length, 1, 'één regel');
    x.m.meldingVerstuurd(m3.sleutel);
    // week zonder nieuws: niets
    const r4 = await x.dag(7);
    assert.ok(r4.buurt.gevraagd && r4.buurt.gemeld === 0 && r4.wijzigingen === 0, 'geen nieuws = geen wijziging');
    assert.strictEqual(melding(x), null, 'geen nieuws = geen melding');
    // A valt weg en komt terug, plus een plan van de gemeente: alleen het plan
    x.st.straal = [];
    await x.dag(7);
    x.st.straal = [A, B]; x.st.gemeente = [P];
    const r6 = await x.dag(7);
    assert.strictEqual(r6.buurt.gemeld, 1, 'dezelfde bekendmaking twee keer = één regel (alleen het plan is nieuw)');
    const m6 = melding(x);
    assert.ok(m6 && /^Vastgoed: Plan van de gemeente: Omgevingsplan Proefdorp/.test(m6.tekst), 'plan van de gemeente apart benoemd');
    x.m.meldingVerstuurd(m6.sleutel);
    // storing: niets, en de volgende dag opnieuw (geen week wachten)
    x.st.faal = true; x.st.straal = [bm('gmb-2026-100004', 'Aanvraag omgevingsvergunning Proeflaan 7, sloop schuur', '2027-01-10')];
    const r7 = await x.dag(7);
    assert.ok(r7.buurt.gevraagd && r7.buurt.gemeld === 0 && melding(x) === null, 'storing = stil');
    x.st.faal = false;
    const n7 = x.st.vragen.length;
    const r8 = await x.dag(1);
    assert.strictEqual(x.st.vragen.length, n7 + 1, 'na een storing de volgende dag opnieuw');
    assert.strictEqual(r8.buurt.gemeld, 1, 'na de storing de nieuwe alsnog');
    const d = x.db();
    try {
      assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM bekendmaking').get().n, 4, 'elke bekendmaking één rij');
      const w = d.prepare("SELECT tekst, url FROM wijziging WHERE soort = 'buurt'").all();
      assert.strictEqual(w.length, 3, 'drie buurtregels in totaal (B, plan, sloop)');
      assert.ok(w.every((z) => /^https:\/\/zoek\.officielebekendmakingen\.nl\//.test(z.url)), 'link bij elke regel');
      assert.ok(d.prepare("SELECT COUNT(*) AS n FROM aanroep WHERE bron LIKE 'Officiële bekendmakingen%'").get().n >= 5, 'aanroepen gelogd');
    } finally { d.close(); }
    const g = (await x.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    const nb = (g.nieuw || []).filter((z) => z.soort === 'buurt');
    assert.ok(nb.length === 3 && nb.every((z) => /^https:\/\/zoek\.officielebekendmakingen\.nl\//.test(z.url)), 'GET: buurtregels bij Nieuw, met link');
    const i = x.m.info();
    assert.ok(i.buurt && i.buurt.bekendmakingen === 4 && i.buurt.straal_op && i.buurt.gemeente_op, 'health: aantallen en tijdstippen');
  } finally { x.weg(); }
});

test('buurtNieuw: rommel weg, link alleen van officielebekendmakingen, mislukte bron telt niet', () => {
  const g = new Set(['gmb-2026-1']);
  const u = V.buurtNieuw({ straal: { ok: true, items: [bm('gmb-2026-1', 'oud', '2026-01-01'), { id: 'x; drop', titel: 'kwaad' }, { id: 'gmb-2026-2', titel: 'nieuw', datum: '2026-13-01', url: 'javascript:alert(1)' }, { id: 'gmb-2026-2', titel: 'dubbel' }] },
    gemeente: { ok: false, items: [bm('gmb-2026-3', 'plan', '2026-01-01')] } }, g);
  assert.deepStrictEqual(u.map((z) => z.id), ['gmb-2026-2']);
  assert.strictEqual(u[0].url, null);
  assert.strictEqual(u[0].datum, null);
});

test('wijzigingBericht: buurt alleen, meerdere, en samen met een andere wijziging', () => {
  const b1 = { soort: 'buurt', object: 'woning', tekst: 'Bekendmaking bij je huis: Proef (1-12-2026)', url: 'https://zoek.officielebekendmakingen.nl/gmb-2026-1.html' };
  assert.strictEqual(V.wijzigingBericht([b1]), 'Vastgoed: Bekendmaking bij je huis: Proef (1-12-2026) https://zoek.officielebekendmakingen.nl/gmb-2026-1.html');
  assert.match(V.wijzigingBericht([b1, b1]), /^Vastgoed: 2 nieuwe bekendmakingen bij je huis, o\.a\. Proef .*gmb-2026-1\.html\. Zie Vastgoed › Overzicht\.$/);
  const s = V.wijzigingBericht([{ soort: 'stuk', object: 'box-1', tekst: 'Nieuw stuk: x' }, b1]);
  assert.match(s, /^Vastgoed: één ding veranderd .*Zie Vastgoed › Overzicht\. En: Bekendmaking bij je huis/);
});

test('kenmerken: de postcodelijst (groep sru) telt niet meer mee; de buurtwachter meldt bekendmakingen op id', () => {
  const k = V.kenmerken({ objecten: [{ sleutel: 'woning', bron_stand: { sru: { ok: true }, plannen: { ok: true } }, feiten: [
    { herkomst: 'extern', groep: 'sru', veld: 'Aanvraag omgevingsvergunning Proeflaan 3', waarde: '20-11-2026 · Gemeenteblad' },
    { herkomst: 'extern', groep: 'plannen', veld: 'Proefplan', waarde: 'bestemmingsplan · vastgesteld' }] }] }, null);
  assert.deepStrictEqual(Object.keys(k), ['f:woning:plannen:Proefplan']);
});
