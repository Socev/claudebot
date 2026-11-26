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
  const ps = db(map, 'SELECT DISTINCT patient FROM regel UNION SELECT DISTINCT patient FROM inschrijf').map((r) => r.patient).filter((p) => p !== '');   // wv3045: '' = zonder nummer
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
  assert.deepStrictEqual(s.dagen, { nieuw: 60, gelijk: 6, wijzigt: 6, ouder: 0, andere_vorm: 0 });   // 1 feb t/m 1 apr = 28 + 31 + 1
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

// ── wv3045: export ZONDER kolom patientnummer (Davids normale vorm sinds 14-11-2026), ook gemengd met de oude vorm ──
const zonder = (e) => Object.assign(e, { zonderPnr: true });
const NIET = 'niet in deze export';
test('wv3045 zonder patiëntnummer: inlezen, basisregels als patiëntaantal, unieke tellingen "niet in deze export", geen sleutel nodig', () => {
  const { m, map } = nieuw();
  const A = zonder(M.exportA()), B = zonder(M.exportB());
  const { c } = inlees(m, A);
  const s = c.body.samenvatting;
  assert.strictEqual(s.met_patientnummer, false);
  assert.strictEqual(s.kwartalen[0].patienten, 40); assert.strictEqual(s.kwartalen[0].zonder_patientnummer, true);
  assert.strictEqual(tel(map, 'regel'), A.regels.filter((r) => r.type !== 'I').length);
  assert.strictEqual(tel(map, 'inschrijf'), 363);
  assert.strictEqual(tel(map, 'regel', "patient <> ''") + tel(map, 'inschrijf', "patient <> ''"), 0);
  assert.strictEqual(fs.existsSync(path.join(map, 'sleutel')), false, 'zonder nummer wordt de pseudoniemsleutel niet eens aangemaakt');
  const { c: cB } = inlees(m, B);
  assert.deepStrictEqual(cB.body.samenvatting.dagen, { nieuw: 60, gelijk: 6, wijzigt: 6, ouder: 0, andere_vorm: 0 });
  assert.strictEqual(cB.body.samenvatting.regelverschil.eraf, 0);
  const o = m.app({ methode: 'GET', pad: '/app/pma' }).body;
  const tg = o.praktijken.find((p) => p.code === 'TG');
  const [k1, k2] = tg.kwartalen;
  assert.strictEqual(k1.patienten, 40); assert.strictEqual(k2.patienten, 41);
  assert.strictEqual(k1.dubbel, NIET); assert.strictEqual(k2.instroom, NIET); assert.strictEqual(k2.uitstroom, NIET); assert.strictEqual(k2.doorschuif, NIET);
  assert.strictEqual(k1.zonder_patientnummer, true);
  assert.deepStrictEqual(k1.klassen, [24, 8, '< 5', '< 5']);   // 40 verzonnen patiënten: 6/2/1/1 van elke 10
  assert.ok(k1.modules.find((x) => x.code === '31080').dekking_pct === 100);
  assert.strictEqual(o.exports.every((e) => e.met_patient === false), true);
  assert.strictEqual(m.info().zonder_patientnummer, 2);
  // zelfde inhoud als met nummer: maanden, registreerders, modules en inschrijfgeld gelijk
  const { m: m2 } = nieuw(); inlees(m2, M.exportA()); inlees(m2, M.exportB());
  const t2 = m2.app({ methode: 'GET', pad: '/app/pma' }).body.praktijken.find((p) => p.code === 'TG');
  assert.deepStrictEqual(tg.maanden, t2.maanden); assert.deepStrictEqual(tg.registreerders, t2.registreerders);
  assert.deepStrictEqual(tg.kwartalen.map((k) => [k.patienten, k.inschrijfgeld, k.modules]), t2.kwartalen.map((k) => [k.patienten, k.inschrijfgeld, k.modules]));
  assert.notStrictEqual(t2.kwartalen[1].instroom, NIET);
});

test('wv3045 gemengd: nieuwere export zonder nummer over dagen mét nummer, daarna weer mét nummer = dagen vervangen, tellingen op inhoud', () => {
  const { m, map } = nieuw();
  const A = M.exportA(), B = zonder(M.exportB());
  inlees(m, A);
  const { c } = inlees(m, B);
  const s = c.body.samenvatting;
  // 20–31 jan (12 dagen) stonden er mét nummer: andere vorm; op inhoud 6 gelijk en 6 gewijzigd, net als in dezelfde vorm
  assert.deepStrictEqual(s.dagen, { nieuw: 60, gelijk: 6, wijzigt: 6, ouder: 0, andere_vorm: 12 });
  const { m: mv } = nieuw(); inlees(mv, M.exportA());   // zelfde stap in dezelfde vorm als maatstaf
  assert.deepStrictEqual(s.regelverschil, lees(mv, M.exportB()).body.samenvatting.regelverschil);
  assert.strictEqual(s.regelverschil.eraf, 0); assert.ok(s.regelverschil.factuur >= 20);
  assert.strictEqual(tel(map, 'regel', "dag >= '2026-01-20' AND patient <> ''"), 0);
  assert.ok(tel(map, 'regel', "dag < '2026-01-20' AND patient <> ''") > 0);
  let tg = m.app({ methode: 'GET', pad: '/app/pma' }).body.praktijken.find((p) => p.code === 'TG');
  assert.strictEqual(tg.kwartalen[0].zonder_patientnummer, undefined); assert.strictEqual(typeof tg.kwartalen[0].dubbel, 'number');
  assert.strictEqual(tg.kwartalen[1].instroom, NIET);
  // een latere export mét nummer over dezelfde dagen vervangt ze gewoon (inhoud gelijk: alle dagen 'gelijk', andere vorm)
  const B2 = Object.assign(M.exportB(), { exportdatum: '2026-04-09' });
  const { c: c2 } = inlees(m, B2);
  assert.deepStrictEqual(c2.body.samenvatting.dagen, { nieuw: 0, gelijk: 72, wijzigt: 0, ouder: 0, andere_vorm: 72 });
  assert.strictEqual(c2.body.samenvatting.kwartalen[0].stand, 'vervangen');
  assert.strictEqual(tel(map, 'regel', "patient = ''") + tel(map, 'inschrijf', "patient = ''"), 0);
  tg = m.app({ methode: 'GET', pad: '/app/pma' }).body.praktijken.find((p) => p.code === 'TG');
  assert.strictEqual(tg.kwartalen[1].instroom, '< 5');
  // intrekken van de laatste: terug naar A + B zonder nummer
  assert.strictEqual(post(m, 'intrek', { id: 3 }).status, 200);
  assert.strictEqual(tel(map, 'regel', "dag >= '2026-01-20' AND patient <> ''"), 0);
  // een OUDERE export zonder nummer verandert niets aan nieuwere dagen mét nummer
  const { m: m3, map: map3 } = nieuw(); inlees(m3, M.exportB());
  const voor = db(map3, 'SELECT sleutel FROM regel ORDER BY sleutel');
  const { c: c3 } = inlees(m3, zonder(Object.assign(M.exportA(), { exportdatum: '2026-02-01' })));
  assert.strictEqual(c3.body.samenvatting.dagen.ouder, 12);
  assert.deepStrictEqual(db(map3, "SELECT sleutel FROM regel WHERE dag >= '2026-01-20' ORDER BY sleutel"), voor);
  const g = geheimen(map, A, B);
  assert.strictEqual(lekt(c.body, g) || lekt(c2.body, g) || lekt(tg, g), false);
});

test('wv3045 zonder nummer blijft strikt: andere kolommen of een veld te veel = weigeren', () => {
  const { m } = nieuw();
  const weiger = (e, re) => { const c = post(m, 'controleer', { zip: zip64(e) }); assert.strictEqual(c.status, 400, JSON.stringify(c.body)); assert.match(c.body.fout, re); };
  weiger(Object.assign(zonder(M.exportA()), { kop: M.KOP_ZONDER.replace('Tarief', 'Bedrag') }), /bekende kolommen/);
  weiger(Object.assign(zonder(M.exportA()), { kop: M.KOP_ZONDER.replace('id;', '') }), /bekende kolommen/);
  weiger(Object.assign(M.exportA(), { kop: M.KOP_ZONDER }), /11 velden in plaats van 10/);   // kop zonder, regels met nummer
});

test('wv3045 databank van schema 1 (zonder kolom met_patient) wordt bijgewerkt, ook als eerst alleen gelezen wordt', () => {
  const { m, map } = nieuw();
  inlees(m, M.exportA());
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(map, 'pma.sqlite'));
  d.exec("ALTER TABLE export DROP COLUMN met_patient; ALTER TABLE registreerder DROP COLUMN bevestigd; DROP TABLE persoon; UPDATE meta SET waarde = '1' WHERE sleutel = 'schema'"); d.close();
  const m2 = P.maak({ map, finPatienten: () => FIN });
  const o = m2.app({ methode: 'GET', pad: '/app/pma' });
  assert.strictEqual(o.status, 200, JSON.stringify(o.body));
  assert.strictEqual(o.body.exports[0].met_patient, true);
  assert.strictEqual(m2.info().schema, 4);   // wv3111: schema 4 (registreerder.negeer)
  assert.strictEqual(m2.app({ methode: 'GET', pad: '/app/pma/personeel' }).status, 200);   // wv3047: ook na bijwerken
  const { c } = inlees(m2, zonder(M.exportB()));
  assert.strictEqual(c.body.samenvatting.dagen.andere_vorm, 12);
});

test('wv3045 zelfde inhoud in een andere volgorde (zonder nummer) = kwartaal en dagen "gelijk"; ook mét nummer', () => {
  const { m } = nieuw();
  const anders = (e) => { for (const r of e.regels) if (r.type === 'I' && r.pnr === '900001') r.reg = 'Y. Proefanders'; return e; };   // regels binnen één code verschillen
  // review Codex MOET 1: twee verder gelijke verrichtingen, de een gefactureerd en de ander nog niet; omgekeerde volgorde = geen wijziging
  const tweeling = (e) => { const r = { pnr: '900009', code: M.C.kort[0], oms: M.C.kort[1], type: 'V', reg: 'A. Proefsen', tarief: M.C.kort[2], dag: '2026-01-22' };
    e.regels.push(Object.assign({}, r, { factuur: '2026-01-31' }), Object.assign({}, r, { factuur: null })); return e; };
  inlees(m, tweeling(anders(zonder(M.exportA()))));
  const A2 = tweeling(anders(zonder(Object.assign(M.exportA(), { exportdatum: '2026-02-04' })))); A2.regels.reverse();
  const s = lees(m, A2).body.samenvatting;
  assert.strictEqual(s.kwartalen[0].stand, 'gelijk');
  assert.deepStrictEqual(s.dagen, { nieuw: 0, gelijk: 31, wijzigt: 0, ouder: 0, andere_vorm: 0 });
  assert.deepStrictEqual(s.regelverschil, { erbij: 0, eraf: 0, factuur: 0 });
  const { m: mm } = nieuw();
  inlees(mm, tweeling(M.exportA()));
  const A3 = tweeling(Object.assign(M.exportA(), { exportdatum: '2026-02-04' })); A3.regels.reverse();
  assert.deepStrictEqual(lees(mm, A3).body.samenvatting.dagen, { nieuw: 0, gelijk: 31, wijzigt: 0, ouder: 0, andere_vorm: 0 });
});

// wv4148 (2C50, David 25-11-2026): datastand, bedrag per M&I-soort en "Valt op" — met de hand geteld op verzonnen regels
test('wv4148 Valt op: na twee maanden niet gefactureerd (tegen de eigen export), tarief € 0, meer tarieven, te koppelen; datastand en subc', () => {
  const { m } = nieuw();
  const V = (code, oms, tarief, dag, factuur, reg) => ({ code, oms, type: 'V', reg: reg || 'A. Proefsen', tarief, dag, factuur });
  const regels = [
    V('12010', 'Consult kort', '7.00', '2026-03-02', null), V('12010', 'Consult kort', '7.00', '2026-03-02', null), V('12010', 'Consult kort', '7.00', '2026-03-09', null),   // 3 oud
    V('12011', 'Consult middel', '14.00', '2026-05-20', null), V('12011', 'Consult middel', '14.00', '2026-05-21', null),   // jong voorlopig: niet oud
    V('12100', 'Kardia', '0', '2026-04-02', '2026-04-30', 'B. Verzonnen'), V('12100', 'Kardia', '0', '2026-04-03', '2026-04-30'),   // tarief 0, gefactureerd
    V('12905', 'Stikstof', '0', '2026-03-03', null),   // tarief 0 én oud
    V('12011', 'Consult middel', '15.00', '2026-04-06', '2026-04-30'),   // tweede tarief van 12011 in 2026
    V('13005', 'ECG', '50.00', '2026-04-07', '2026-04-30'), V('13005', 'ECG', '50.00', '2026-04-08', '2026-04-30'),
    { oms: 'Niet declareren', type: 'O', reg: 'A. Proefsen', tarief: '0', dag: '2026-03-04', factuur: null },   // type O telt nergens
  ];
  inlees(m, { agb: '009870', exportdatum: '2026-06-10', begin: '2026-03-01', eind: '2026-05-31', regels, zonderPnr: true });
  let o = m.app({ methode: 'GET', pad: '/app/pma' }).body;
  let p = o.praktijken.find((x) => x.code === 'TG');
  assert.deepStrictEqual([p.data_van, p.data_tot, p.laatste_export], ['2026-03-01', '2026-05-31', '2026-06-10']);
  assert.deepStrictEqual(o.bekend.map((x) => x.code).sort(), ['GH', 'TG']);
  const v = p.valt_op;
  assert.strictEqual(v.voorlopig_oud.n, 4);
  assert.deepStrictEqual(v.voorlopig_oud.per.map((x) => [x.maand, x.code, x.n]), [['2026-03', '12010', 3], ['2026-03', '12905', 1]]);
  assert.strictEqual(v.nultarief.n, 3);
  assert.deepStrictEqual(v.nultarief.per.map((x) => [x.code, x.n, x.voorlopig]), [['12100', 2, 0], ['12905', 1, 1]]);
  assert.deepStrictEqual(v.meer_tarieven.map((x) => [x.jaar, x.code, x.tarieven]), [['2026', '12011', [1400, 1500]]]);
  const pp = m.app({ methode: 'GET', pad: '/app/pma/personeel' }).body;
  const koppelApp = pp.registreerders.filter((r) => r.praktijk === 'TG' && !r.bevestigd && !r.negeer && r.n > 0).length;
  assert.strictEqual(v.te_koppelen, 2); assert.strictEqual(v.te_koppelen, koppelApp);   // zelfde regel als het scherm Koppelen
  assert.strictEqual(p.maanden.find((x) => x.maand === '2026-04').subc['mi:ECG'], 10000);
  // een nieuwere export factureert de dagen van maart: niet meer oud; de jonge regel van mei blijft niet oud tegen zijn eigen export
  inlees(m, { agb: '009870', exportdatum: '2026-08-20', begin: '2026-03-01', eind: '2026-03-31', zonderPnr: true,
    regels: regels.filter((r) => r.dag < '2026-04-01').map((r) => (r.type === 'V' ? Object.assign({}, r, { factuur: '2026-03-31' }) : r)) });
  p = m.app({ methode: 'GET', pad: '/app/pma' }).body.praktijken.find((x) => x.code === 'TG');
  assert.strictEqual(p.valt_op.voorlopig_oud.n, 0);
  assert.deepStrictEqual(p.valt_op.nultarief.per.map((x) => [x.code, x.n, x.voorlopig]), [['12100', 2, 0], ['12905', 1, 0]]);
  assert.strictEqual(p.laatste_export, '2026-08-20');
  assert.doesNotMatch(JSON.stringify(p.valt_op), /9\d{5}/);   // geen (verzonnen) patiëntnummer
});
