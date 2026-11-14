'use strict';
// wv3037: OVIS PMA fase 1 — lezer, overlap per dag, pseudoniem en routes op VERZONNEN exports (test/pma-maak.js; geen echte nummers of namen).
// Toetst: zelfde ZIP twee keer = niets; overlappende ZIP vervangt alleen gewijzigde dagen; gelijke regels blijven; voorlopige regels worden
// ververst; oudere export verandert niets; weigeringen; nooit een (pseudo)patiëntnummer in een antwoord; "< 5"; intrekken/terugzetten;
// code indelen; herbouwen; bestandsrechten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../pma.js');
const M = require('./pma-maak.js');

const FIN = { TG: { 2026: 40.2 } };
function nieuw() {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-toets-'));
  const m = P.maak({ map: path.join(map, 'pma'), finPatienten: () => FIN });
  return { m, map: path.join(map, 'pma') };
}
const post = (m, wat, body) => m.app({ methode: 'POST', pad: '/app/pma/' + wat, body });
const zip64 = (e) => M.maakExport(e).toString('base64');
function lees(m, e, naam) {
  const c = post(m, 'controleer', { naam: naam || 'x.zip', zip: zip64(e) });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  return c;
}
function inlees(m, e) {
  const c = lees(m, e);
  if (c.body.al) return { c, i: post(m, 'inlees', { sha: c.body.sha }) };
  const i = post(m, 'inlees', { sha: c.body.sha });
  assert.strictEqual(i.status, 200, JSON.stringify(i.body));
  return { c, i };
}
function db(map, sql, ...p) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(map, 'pma.sqlite'), { readOnly: true });
  try { return d.prepare(sql).all(...p); } finally { d.close(); }
}
const tel = (map, t, w, ...p) => db(map, 'SELECT COUNT(*) AS n FROM ' + t + (w ? ' WHERE ' + w : ''), ...p)[0].n;
// Alle patiëntnummers (ruw) uit de verzonnen exports en alle pseudoniemen uit de databank: geen enkele mag in een antwoord staan.
function geheimen(map, ...exports) {
  const ruw = new Set(); for (const e of exports) for (const r of e.regels) ruw.add(r.pnr);
  const ps = db(map, 'SELECT DISTINCT patient FROM regel UNION SELECT DISTINCT patient FROM inschrijf').map((r) => r.patient);
  return { ruw: [...ruw], ps };
}
function lekt(obj, g) {
  const t = JSON.stringify(obj);
  return g.ps.some((p) => t.includes(p)) || g.ruw.some((r) => new RegExp('(^|[^0-9])' + r + '([^0-9]|$)').test(t));
}

test('verzonnen export A: tellingen, controle tegen fin-datahub, geen nummer in het antwoord', () => {
  const { m, map } = nieuw();
  const A = M.exportA();
  const { c } = inlees(m, A);
  const s = c.body.samenvatting;
  assert.strictEqual(s.praktijk, 'TG');
  assert.strictEqual(s.regels.inschrijf, 40 * 9 + 3);   // 1 basis + 7 modules + jaar-module, 3 × opslagwijk
  assert.strictEqual(s.regels.overig, 2);
  assert.strictEqual(s.regels.gelijke_regels >= 1, true);
  assert.strictEqual(s.dagen.nieuw, 31);
  assert.deepStrictEqual(s.nog_in_te_delen, [{ code: '19999', n: 1 }]);
  assert.strictEqual(s.kwartalen[0].patienten, 40);
  assert.strictEqual(s.kwartalen[0].fin_melding, false);
  assert.strictEqual(tel(map, 'regel'), A.regels.filter((r) => r.type !== 'I').length);
  assert.strictEqual(tel(map, 'inschrijf'), 363);
  const g = geheimen(map, A);
  assert.ok(g.ps.length >= 40 && g.ps.every((p) => /^[0-9a-f]{16}$/.test(p)));
  assert.strictEqual(lekt(c.body, g), false);
  // het pseudoniem is niet het nummer en hangt van de praktijk af
  assert.notStrictEqual(m._pseudo('TG', '900001'), m._pseudo('GH', '900001'));
  assert.strictEqual(g.ps.includes(m._pseudo('TG', '900001')), true);
});

test('zelfde ZIP twee keer = niets', () => {
  const { m, map } = nieuw();
  const A = M.exportA();
  inlees(m, A);
  const voor = [tel(map, 'regel'), tel(map, 'inschrijf'), tel(map, 'export')];
  const c = lees(m, A);
  assert.ok(c.body.al && c.body.al.op, 'Controleer zegt wanneer hij al is ingelezen');
  const i = post(m, 'inlees', { sha: c.body.sha });
  assert.strictEqual(i.status, 409);   // geen tweede wacht-bestand: niets te doen
  assert.deepStrictEqual([tel(map, 'regel'), tel(map, 'inschrijf'), tel(map, 'export')], voor);
});

test('overlap: alleen gewijzigde dagen vervangen, gelijke regels blijven, voorlopige regels ververst, nieuwe dagen en kwartaal erbij', () => {
  const { m, map } = nieuw();
  const A = M.exportA(), B = M.exportB();
  inlees(m, A);
  const dag14 = tel(map, 'regel', 'dag = ?', '2026-01-14');
  assert.strictEqual(tel(map, 'regel', "dag = '2026-01-14' AND volgnr = 2"), 1, 'gelijke regel met volgnummer 2');
  const voorlopigVoor = tel(map, 'regel', 'voorlopig = 1');
  assert.ok(voorlopigVoor > 0);
  const eersteA = db(map, "SELECT sleutel, export_id FROM regel WHERE dag = '2026-01-21' ORDER BY sleutel");
  const { c } = inlees(m, B);
  const s = c.body.samenvatting;
  // 20–31 jan: 20-1 één regel erbij, 26–30 jan factuurdatum ingevuld (5 werkdagen) → 6 dagen wijzigen; de andere 6 gelijk; 60 nieuwe dagen
  assert.deepStrictEqual(s.dagen, { nieuw: 60, gelijk: 6, wijzigt: 6, ouder: 0 });   // 1 feb t/m 1 apr = 28 + 31 + 1
  assert.strictEqual(s.regelverschil.erbij > 1, true);
  assert.strictEqual(s.regelverschil.eraf, 0);
  assert.ok(s.regelverschil.factuur >= 20);
  assert.strictEqual(s.kwartalen[0].stand, 'nieuw');
  assert.strictEqual(s.kwartalen[0].fin_melding, true, '41 patiënten tegen 40,2 = meer dan 1 %');
  // dagen vóór 20-1 hoort bij A, onaangeroerd; 14-1 (twee gelijke regels) staat er nog helemaal
  assert.strictEqual(tel(map, 'regel', 'dag = ?', '2026-01-14'), dag14);
  assert.strictEqual(tel(map, 'regel', "dag = '2026-01-14' AND volgnr = 2"), 1);
  assert.strictEqual(tel(map, 'regel', "dag < '2026-01-20' AND export_id = 1"), tel(map, 'regel', "dag < '2026-01-20'"));
  // 21-1 was gelijk: dezelfde sleutels, nu van B (nieuwste export is de bron van die dag)
  const tweede = db(map, "SELECT sleutel, export_id FROM regel WHERE dag = '2026-01-21' ORDER BY sleutel");
  assert.deepStrictEqual(tweede.map((r) => r.sleutel), eersteA.map((r) => r.sleutel));
  assert.strictEqual(db(map, "SELECT export_id FROM dagbron WHERE praktijk = 'TG' AND dag = '2026-01-21'")[0].export_id, 2);
  // voorlopig: 26–30 jan nu gefactureerd; alleen type O-regels zonder factuurdatum tellen niet als voorlopig
  assert.strictEqual(tel(map, 'regel', "voorlopig = 1 AND dag BETWEEN '2026-01-26' AND '2026-01-30'"), 0);
  assert.strictEqual(tel(map, 'regel', "type = 'O' AND voorlopig = 1"), 0);
  // overzicht: in- en uitstroom op 1-4 (2 weg, 3 erbij, 1 doorgeschoven) = "< 5"; jaar-module alleen in K1
  const o = m.app({ methode: 'GET', pad: '/app/pma' }).body;
  const tg = o.praktijken.find((p) => p.code === 'TG');
  const k2 = tg.kwartalen.find((k) => k.peildatum === '2026-04-01');
  assert.strictEqual(k2.patienten, 41);
  assert.strictEqual(k2.instroom, '< 5'); assert.strictEqual(k2.uitstroom, '< 5'); assert.strictEqual(k2.doorschuif, '< 5');
  assert.strictEqual(k2.inschrijfgeld.jaarmodule, 0);
  assert.ok(tg.kwartalen[0].inschrijfgeld.jaarmodule > 0);
  assert.ok(tg.kwartalen[0].modules.some((x) => x.code === '31315' && x.ritme === 'jaar'));
  assert.deepStrictEqual(tg.maanden.map((x) => x.maand), ['2026-01', '2026-02', '2026-03', '2026-04']);
  assert.strictEqual(tg.maanden[0].dagen_gedekt, 31);
  assert.strictEqual(tg.maanden[3].dagen_gedekt, 1);
  assert.ok(tg.maanden[0].sub['consult:kort'] > 0 && tg.maanden[0].groepen.mi.n > 0);
  assert.ok(tg.registreerders.some((r) => r.soort === 'verzamel'));
  const g = geheimen(map, A, B);
  assert.strictEqual(lekt(o, g), false);
  assert.strictEqual(lekt(m.info(), g), false);
  // klein: een uitsplitsing onder de vijf nooit als getal
  for (const k of tg.kwartalen) for (const x of k.klassen.concat([k.dubbel, k.instroom, k.uitstroom, k.doorschuif])) if (typeof x === 'number') assert.ok(x === 0 || x >= 5);
});

test('oudere export over nieuwere dagen verandert niets', () => {
  const { m, map } = nieuw();
  const B = M.exportB();
  inlees(m, B);
  const voor = db(map, 'SELECT sleutel, factuurdatum FROM regel ORDER BY sleutel');
  const A = M.exportA();
  const { c } = inlees(m, A);
  assert.strictEqual(c.body.samenvatting.dagen.ouder, 12, '20–31 jan staan al in een nieuwere export');
  assert.strictEqual(c.body.samenvatting.dagen.nieuw, 19);
  const na = db(map, "SELECT sleutel, factuurdatum FROM regel WHERE dag >= '2026-01-20' ORDER BY sleutel");
  assert.deepStrictEqual(na, voor.filter((r) => na.some((x) => x.sleutel === r.sleutel)));
  assert.strictEqual(tel(map, 'regel', "dag >= '2026-01-20' AND export_id = 1"), tel(map, 'regel', "dag >= '2026-01-20'"));
});

test('weigeringen (strikt, met de reden; niets geschreven)', () => {
  const { m, map } = nieuw();
  const weiger = (e, re, wat) => {
    const c = post(m, 'controleer', { naam: 'x.zip', zip: typeof e === 'string' ? e : zip64(e) });
    assert.strictEqual(c.status, 400, wat + ': ' + JSON.stringify(c.body));
    assert.match(c.body.fout, re, wat);
    assert.doesNotMatch(c.body.fout, /9000\d\d/, wat + ': geen patiëntnummer in de fout');
  };
  const A = () => M.exportA();
  const met = (f) => { const e = A(); f(e); return e; };
  weiger(met((e) => { e.kop = M.KOP.replace('Tarief', 'Bedrag'); }), /bekende kolommen/, 'kolommen');
  weiger(met((e) => { e.regels[400].soort = 'CORRECTIE'; }), /onbekende soort/, 'soort');
  weiger(met((e) => { e.regels[400].type = 'X'; }), /onbekend type/, 'type');
  weiger(met((e) => { e.regels[400].dag = '2026-02-03'; }), /buiten de periode/, 'datum buiten periode');
  weiger(met((e) => { e.regels[0].dag = '2026-01-02'; }), /eerste dag van een kwartaal/, 'inschrijfgeld');
  weiger(met((e) => { e.agb = '012345'; }), /onbekende praktijk .*AGB 012345/, 'AGB');
  weiger(met((e) => { e.set = 'ANDERS'; }), /gegevensset/, 'gegevensset');
  weiger(met((e) => { e.regels[400].tarief = '7,00'; }), /tarief/, 'tarief met komma');
  weiger(met((e) => { e.regels[400].pnr = 'AB12'; }), /patiëntnummer niet in de bekende vorm/, 'pnr');
  weiger(met((e) => { e.regels[400].code = ''; }), /prestatiecode/, 'V zonder code');
  weiger(met((e) => { e.exportdatum = '2026-01-15'; }), /na de exportdatum/, 'periode na exportdatum');
  weiger(met((e) => { e.extra = [{ naam: 'leesmij.txt', data: Buffer.from('x') }]; }), /precies export_info\.csv/, 'extra bestand');
  // geen UTF-8
  const z = M.zip([{ naam: 'export_info.csv', data: Buffer.from('AGB;Export datum;Begin periode;Eind periode;Naam populatie;Naam gegevensset;Type\r\n009870;03-02-2026;01-01-2026;31-01-2026;X;PMA;Praktijk') },
    { naam: 'x_PMA_VERRICHTING.csv', data: Buffer.from([0x69, 0x64, 0xe9, 0x0d, 0x0a]) }]);
  weiger(z.toString('base64'), /geen UTF-8/, 'utf-8');
  // beschadigd (controlegetal)
  const goed = M.maakExport(A()); const kapot = Buffer.from(goed); kapot[kapot.length >> 1] ^= 0xff;   // midden in de ingepakte gegevens
  weiger(kapot.toString('base64'), /beschadigd/, 'crc');
  weiger(Buffer.from('geen zip').toString('base64'), /geen ZIP/, 'geen zip');
  assert.strictEqual(post(m, 'controleer', { zip: 'niet base64!' }).status, 400);
  assert.strictEqual(post(m, 'inlees', { sha: 'a'.repeat(64) }).status, 409);
  assert.strictEqual(fs.existsSync(path.join(map, 'pma.sqlite')) ? tel(map, 'export') : 0, 0);
});

test('Inlezen weigert als de stand sinds Controleer veranderde', () => {
  const { m } = nieuw();
  const cA = lees(m, M.exportA()), cB = lees(m, M.exportB());
  assert.strictEqual(post(m, 'inlees', { sha: cA.body.sha }).status, 200);
  const i = post(m, 'inlees', { sha: cB.body.sha });
  assert.strictEqual(i.status, 409);
  assert.match(i.body.fout, /controleer opnieuw/);
  assert.strictEqual(post(m, 'inlees', { sha: lees(m, M.exportB()).body.sha }).status, 200);
});

test('intrekken bouwt de praktijk opnieuw op; opnieuw inlezen zet hem terug; herbouw = zelfde stand', () => {
  const { m, map } = nieuw();
  inlees(m, M.exportA());
  const alleenA = db(map, 'SELECT sleutel, factuurdatum, export_id FROM regel ORDER BY sleutel');
  const nIA = tel(map, 'inschrijf');
  inlees(m, M.exportB());
  const metB = db(map, 'SELECT sleutel, factuurdatum, export_id FROM regel ORDER BY sleutel');
  assert.strictEqual(post(m, 'intrek', { id: 2 }).status, 200);
  assert.deepStrictEqual(db(map, 'SELECT sleutel, factuurdatum, export_id FROM regel ORDER BY sleutel'), alleenA);
  assert.strictEqual(tel(map, 'inschrijf'), nIA);
  assert.strictEqual(tel(map, 'kwartaalbron'), 1);
  const c = lees(m, M.exportB());
  assert.strictEqual(c.body.eerder_ingetrokken, true);
  const i = post(m, 'inlees', { sha: c.body.sha });
  assert.strictEqual(i.body.terug, true);
  assert.deepStrictEqual(db(map, 'SELECT sleutel, factuurdatum, export_id FROM regel ORDER BY sleutel'), metB);
  assert.strictEqual(m.herbouw('TG'), 2);
  assert.deepStrictEqual(db(map, 'SELECT sleutel, factuurdatum, export_id FROM regel ORDER BY sleutel'), metB);
  assert.strictEqual(post(m, 'intrek', { id: 99 }).status, 404);
});

test('code indelen: "nog in te delen" wordt M&I', () => {
  const { m } = nieuw();
  inlees(m, M.exportA());
  let o = m.app({ methode: 'GET', pad: '/app/pma' }).body;
  assert.deepStrictEqual(o.nog_in_te_delen.map((x) => [x.code, x.n]), [['19999', 1]]);
  assert.strictEqual(o.praktijken[0].maanden[0].groepen['nog-in-te-delen'].n, 1);
  assert.strictEqual(post(m, 'code', { code: '19999', groep: 'onzin' }).status, 400);
  assert.strictEqual(post(m, 'code', { code: '19999', groep: 'mi', subgroep: 'Proef' }).status, 200);
  o = m.app({ methode: 'GET', pad: '/app/pma' }).body;
  assert.deepStrictEqual(o.nog_in_te_delen, []);
  assert.strictEqual(o.praktijken[0].maanden[0].groepen['nog-in-te-delen'], undefined);
  assert.strictEqual(o.praktijken[0].maanden[0].sub['mi:Proef'], 1);
});

test('rechten: map 700, databank, sleutel en bron-ZIP 600; wacht leeg na inlezen', () => {
  const { m, map } = nieuw();
  inlees(m, M.exportA());
  const modus = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  assert.strictEqual(modus(map), '700');
  assert.strictEqual(modus(path.join(map, 'bron')), '700');
  assert.strictEqual(modus(path.join(map, 'pma.sqlite')), '600');
  assert.strictEqual(modus(path.join(map, 'sleutel')), '600');
  const zips = fs.readdirSync(path.join(map, 'bron'));
  assert.strictEqual(zips.length, 1);
  assert.strictEqual(modus(path.join(map, 'bron', zips[0])), '600');
  assert.deepStrictEqual(fs.readdirSync(path.join(map, 'wacht')), []);
  const i = m.info();
  assert.deepStrictEqual([i.exports, i.bron_zips, i.kwartalen], [1, 1, 1]);
});

test('lekdetector werkt (kruisproef op de toets zelf)', () => {
  const { m, map } = nieuw();
  inlees(m, M.exportA());
  const g = geheimen(map, M.exportA());
  assert.strictEqual(lekt({ x: g.ps[0] }, g), true);
  assert.strictEqual(lekt({ x: 'nummer ' + g.ruw[0] + '.' }, g), true);
  assert.strictEqual(lekt({ x: 'niets' }, g), false);
});

// ── review Codex (NO-GO, 4 MOET + 1 ZOU), elk punt een toets ──
test('review MOET 1: nieuwere export die dag 1 van het kwartaal dekt zonder inschrijfgeld → oude inschrijfregels vervallen; oudere vult niet terug', () => {
  const { m, map } = nieuw();
  inlees(m, M.exportA());
  assert.strictEqual(tel(map, 'inschrijf'), 363);
  const C = { agb: '009870', exportdatum: '2026-02-20', begin: '2026-01-01', eind: '2026-01-10', regels: M.verrichtingen('2026-01-02', '2026-01-09', 5, null) };
  const { c } = inlees(m, C);
  assert.strictEqual(c.body.samenvatting.kwartalen[0].stand, 'vervalt');
  assert.strictEqual(tel(map, 'inschrijf'), 0);
  assert.deepStrictEqual(m.app({ methode: 'GET', pad: '/app/pma' }).body.praktijken[0].kwartalen, []);
  const ouder = Object.assign(M.exportA(), { exportdatum: '2026-02-01' }); ouder.regels = ouder.regels.filter((r) => r.type === 'I');
  const { c: c2 } = inlees(m, ouder);
  assert.strictEqual(c2.body.samenvatting.kwartalen[0].stand, 'ouder dan wat er staat');
  assert.strictEqual(tel(map, 'inschrijf'), 0);
  assert.strictEqual(m.herbouw('TG'), 3);   // herbouw geeft dezelfde uitkomst
  assert.strictEqual(tel(map, 'inschrijf'), 0);
});
test('review MOET 2: de bron-ZIP staat er vóór de databank; mislukt het schrijven, dan geen export en geen wees-ZIP', () => {
  const { m, map } = nieuw();
  const A = M.exportA();
  const c = lees(m, A);
  fs.chmodSync(path.join(map, 'bron'), 0o500);
  try { assert.throws(() => post(m, 'inlees', { sha: c.body.sha })); } finally { fs.chmodSync(path.join(map, 'bron'), 0o700); }
  assert.strictEqual(fs.existsSync(path.join(map, 'pma.sqlite')) ? tel(map, 'export') : 0, 0);
  // 409 binnen de transactie (stand veranderd) → nieuwe bron-ZIP weer weg
  const cB = lees(m, M.exportB());
  assert.strictEqual(post(m, 'inlees', { sha: c.body.sha }).status, 200);
  assert.strictEqual(post(m, 'inlees', { sha: cB.body.sha }).status, 409);
  assert.deepStrictEqual(fs.readdirSync(path.join(map, 'bron')).filter((f) => !f.endsWith('.tmp')), [c.body.sha + '.zip']);
});
test('review MOET 3: ook het patiënttotaal onder de vijf is "< 5"', () => {
  const { m } = nieuw();
  inlees(m, { agb: '009870', exportdatum: '2026-04-05', begin: '2026-04-01', eind: '2026-04-01', regels: M.inschrijving('2026-04-01', M.patienten(3, 900001), false) });
  const k = m.app({ methode: 'GET', pad: '/app/pma' }).body.praktijken[0].kwartalen[0];
  assert.strictEqual(k.patienten, '< 5');
  assert.ok(k.klassen.every((x) => x === 0 || x === '< 5'));
});
test('review MOET 4: terugzetten van een ingetrokken export gaat ook langs de vergelijking met Controleer', () => {
  const { m } = nieuw();
  inlees(m, M.exportA()); inlees(m, M.exportB());
  assert.strictEqual(post(m, 'intrek', { id: 2 }).status, 200);
  const cB = lees(m, M.exportB());
  assert.strictEqual(cB.body.eerder_ingetrokken, true);
  assert.strictEqual(post(m, 'intrek', { id: 1 }).status, 200);   // stand verandert tussen Controleer en Inlezen
  const i = post(m, 'inlees', { sha: cB.body.sha });
  assert.strictEqual(i.status, 409);
  assert.strictEqual(m.info().exports, 0);
});
