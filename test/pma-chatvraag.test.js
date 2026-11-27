'use strict';
// wv4354 (besluitenpagina nr 932 = L32 stap 2): Socev beantwoordt PMA-vragen in de chat (pma.js chatVraag + server.js POST /smal/pma).
// VERZONNEN exports met handgetelde aantallen (geen echte nummers of namen).
// Handtelling Tolgaarde oktober 2026 (export 1-10 t/m 31-10, helemaal gedekt): 50 patiënten op 1-10; visites 6 kort (A. Proefsen) + 4 lang
// (B. Verzonnen) = 10 → 200 per 1000; consulten 30 kort + 10 lang = 40 (lang 25 %); ECG 5 → 100 per 1000; verrichtingen 55 → 1.100 per 1000.
// Oktober 2025 (export 1-10 t/m 31-10-2025): 40 patiënten op 1-10-2025; 3 visites kort → 75 per 1000; verschil aantal +233,3 %, per 1000 +166,7 %.
// Groenhouten alleen oktober 2026: 20 patiënten, 2 visites kort (100 per 1000); oktober 2025 niet ingelezen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../pma.js');
const M = require('./pma-maak.js');

const post = (m, wat, body) => m.app({ methode: 'POST', pad: '/app/pma/' + wat, body });
function inlees(m, e) {
  const c = post(m, 'controleer', { naam: 'x.zip', zip: M.maakExport(e).toString('base64') });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  assert.strictEqual(post(m, 'inlees', { sha: c.body.sha }).status, 200);
}
const K = M.C;
const R = (c, n, dag, reg) => { const u = []; for (let i = 0; i < n; i++) u.push({ pnr: String(800001 + i), code: c[0], oms: c[1], type: 'V', reg: reg || 'A. Proefsen', tarief: c[2], dag, factuur: '2026-12-31' }); return u; };
function opzet() {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-chatvraag-'));
  const m = P.maak({ map: path.join(map, 'pma'), finPatienten: () => ({}) });
  inlees(m, { agb: '009870', exportdatum: '2025-11-05', begin: '2025-10-01', eind: '2025-10-31',
    regels: M.inschrijving('2025-10-01', M.patienten(40, 800001), false).concat(R(K.vk, 3, '2025-10-14')) });
  inlees(m, { agb: '009870', exportdatum: '2026-11-05', begin: '2026-10-01', eind: '2026-10-31',
    regels: M.inschrijving('2026-10-01', M.patienten(50, 800001), false).concat(R(K.vk, 6, '2026-10-14'), R(K.vl, 4, '2026-10-14', 'B. Verzonnen'),
      R(K.kort, 30, '2026-10-15'), R(K.lang, 10, '2026-10-15'), R(K.ecg, 5, '2026-10-16')) });
  inlees(m, { agb: '010710', exportdatum: '2026-11-06', begin: '2026-10-01', eind: '2026-10-31',
    regels: M.inschrijving('2026-10-01', M.patienten(20, 810001), false).concat(R(K.vk, 2, '2026-10-20')) });
  return { m, map, ov: m.app({ methode: 'GET', pad: '/app/pma' }).body };
}
const w = (x, id) => x.waarden.find((v) => v.id === id);

test('vraag 1: visites in oktober, en vorig jaar (TG) = handtelling, vergeleken, link naar Overzicht oktober', () => {
  const { ov } = opzet();
  const r = P.chatVraag(ov, { praktijk: 'TG', periode: 'oktober', wat: 'visites', vorig_jaar: 'ja' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const x = r.body.praktijken[0];
  assert.strictEqual(x.periode, '2026-10'); assert.strictEqual(x.dekking, 'heel'); assert.strictEqual(x.link, '/pma#overzicht/tg/2026-10');
  assert.deepStrictEqual(w(x, 'visites'), { id: 'visites', naam: 'Visites', aantal: 10, bedrag_eur: 260, per_1000: 200, verschil_pct: 233.3, verschil_per_1000_pct: 166.7 });
  assert.strictEqual(x.vorig_jaar.periode, '2025-10'); assert.strictEqual(x.vorig_jaar.vergeleken, true);
  assert.strictEqual(x.vorig_jaar.waarden[0].aantal, 3); assert.strictEqual(x.vorig_jaar.waarden[0].per_1000, 75);
  assert.strictEqual(x.zin, 'Tolgaarde, oktober 2026: visites 10 (200 per 1000). Een jaar eerder (oktober 2025): visites 3 (75 per 1000).');
});

test('vraag 2: beide praktijken; GH zonder vorig jaar zegt dat eerlijk', () => {
  const { ov } = opzet();
  const r = P.chatVraag(ov, { praktijk: 'beide', periode: 'okt', wat: ['visites', 'patienten'], vorig_jaar: true });
  assert.strictEqual(r.status, 200);
  const [tg, gh] = ['TG', 'GH'].map((c) => r.body.praktijken.find((x) => x.praktijk === c));
  assert.strictEqual(w(tg, 'visites').aantal, 10); assert.strictEqual(w(tg, 'patienten').aantal, 50);
  assert.strictEqual(w(gh, 'visites').aantal, 2); assert.strictEqual(w(gh, 'visites').per_1000, 100);
  assert.strictEqual(gh.vorig_jaar.dekking, 'niets');
  assert.ok(/^geen data van oktober 2025 in PMA \(PMA heeft data vanaf 1-10-2026\)$/.test(gh.vorig_jaar.tekst), gh.vorig_jaar.tekst);
  assert.ok(gh.zin.endsWith('Een jaar eerder: geen data van oktober 2025 in PMA (PMA heeft data vanaf 1-10-2026).'), gh.zin);
  assert.strictEqual(gh.link, '/pma#overzicht/gh/2026-10');
});

test('vraag 3: K4 deels gedekt, consulten 20 min+, aandeel, ECG, verrichtingen, inschrijfgeld; week 42; jaar', () => {
  const { ov } = opzet();
  const r = P.chatVraag(ov, { praktijk: 'TG', periode: 'K4', wat: 'verrichtingen, consult-lang, aandeel-lang, ECG, inschrijfgeld' });
  const x = r.body.praktijken[0];
  assert.strictEqual(x.periode, '2026-K4'); assert.strictEqual(x.dekking, 'deels'); assert.strictEqual(x.link, '/pma#overzicht/tg/2026-k4');
  assert.ok(x.dekking_tekst.startsWith('deels ingelezen (31 van 92 dagen'), x.dekking_tekst);
  assert.strictEqual(w(x, 'verrichtingen').aantal, 55); assert.strictEqual(w(x, 'verrichtingen').per_1000, 1100);
  assert.strictEqual(w(x, 'consult-lang').aantal, 10);
  assert.strictEqual(w(x, 'aandeel-lang').procent, 25); assert.strictEqual(w(x, 'aandeel-lang').van_consulten, 40);
  assert.strictEqual(w(x, 'mi:ECG').aantal, 5); assert.strictEqual(w(x, 'mi:ECG').per_1000, 100);
  assert.ok(w(x, 'inschrijfgeld').bedrag_eur > 0); assert.deepStrictEqual(w(x, 'inschrijfgeld').kwartalen, ['K4 2026']);
  assert.ok(x.zin.includes('— deels ingelezen'), x.zin);
  const wk = P.chatVraag(ov, { praktijk: 'TG', periode: 'week 42', wat: 'visites' }).body.praktijken[0];
  assert.strictEqual(wk.periode, '2026-W42'); assert.strictEqual(w(wk, 'visites').aantal, 10); assert.strictEqual(wk.link, '/pma#overzicht/tg/2026-w42');
  const jr = P.chatVraag(ov, { praktijk: 'TG', periode: '2025', wat: 'visites' }).body.praktijken[0];
  assert.strictEqual(w(jr, 'visites').aantal, 3); assert.strictEqual(jr.dekking, 'deels');
  // "laatste" = startperiode van het scherm (geen hele kwartalen: de nieuwste met data)
  assert.strictEqual(P.chatVraag(ov, { praktijk: 'TG', periode: 'laatste', wat: 'visites' }).body.periode, '2026-K4');
});

test('onbekend en onzin: 400 met wat wel kan; geen data: 404', () => {
  const { ov } = opzet();
  const r = P.chatVraag(ov, { praktijk: 'TG', periode: 'oktober', wat: 'vaccinaties' });
  assert.strictEqual(r.status, 400); assert.ok(r.body.kan.includes('visites') && r.body.kan.includes('mi:ECG'));
  assert.strictEqual(P.chatVraag(ov, { praktijk: 'XX', periode: 'oktober' }).status, 400);
  assert.strictEqual(P.chatVraag(ov, { praktijk: 'TG', periode: 'gisteren' }).status, 400);
  assert.strictEqual(P.chatVraag(ov, { praktijk: 'TG', periode: 'juni' }).status, 404);
  assert.strictEqual(P.chatVraag({ praktijken: [] }, { praktijk: 'TG' }).status, 404);
});

test('rolgroep altijd; per medewerker geweigerd zonder schakelaar, toegestaan erna; nooit patiëntnummers', () => {
  const { ov } = opzet();
  const rg = P.chatVraag(ov, { praktijk: 'TG', periode: 'oktober', per: 'rolgroep' });
  assert.strictEqual(rg.status, 200);
  assert.deepStrictEqual(rg.body.praktijken[0].rolgroepen, [{ rolgroep: 'los', naam: 'Niet gekoppeld', verrichtingen_ma_vr: 55 }]);
  for (const q of [{ per: 'medewerker' }, { wie: 'Proefsen' }]) {
    const n = P.chatVraag(ov, Object.assign({ praktijk: 'TG', periode: 'oktober' }, q));
    assert.strictEqual(n.status, 403); assert.strictEqual(n.body.geweigerd, 'per_medewerker');
    assert.strictEqual(n.body.links[0].link, '/pma#medewerkers/tg');
    assert.ok(!JSON.stringify(n.body).includes('Proefsen') && !JSON.stringify(n.body).includes('Verzonnen'));
  }
  const ja = P.chatVraag(ov, { praktijk: 'TG', periode: 'oktober', per: 'medewerker' }, { perMedewerker: true });
  assert.strictEqual(ja.status, 200);
  const a = ja.body.praktijken[0].medewerkers.find((x) => x.naam === 'A. Proefsen');
  assert.strictEqual(a.visite_kort, 6); assert.strictEqual(a.kort, 30); assert.strictEqual(a.lang, 10);
  const b = P.chatVraag(ov, { praktijk: 'TG', periode: 'oktober', per: 'medewerker', wie: 'verzonnen' }, { perMedewerker: true }).body.praktijken[0].medewerkers;
  assert.deepStrictEqual(b.map((x) => [x.naam, x.visite_lang]), [['B. Verzonnen', 4]]);
  // nergens een patiëntnummer (verzonnen 8000xx/8100xx)
  for (const q of [{ wat: 'visites,patienten,inschrijfgeld', vorig_jaar: 'ja' }, { per: 'rolgroep' }]) assert.ok(!/80000\d|8100\d\d/.test(JSON.stringify(P.chatVraag(ov, Object.assign({ praktijk: 'beide', periode: 'oktober' }, q)).body)));
});

// server.js pmaSmal + pmaChatSchakelaar (uit de bron geknipt): zelfde module, schakelaar = PMA_DIR/chat.json, links volledig, onbekend veld eruit
test('server: /smal/pma leest het overzicht, schakelaar uit het bestand, volle links', () => {
  const bron = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/[{ ]pma: 60, /.test(bron.split('\n').find((l) => l.startsWith('const SMAL_GRENS = '))), 'SMAL_GRENS kent pma niet');
  assert.ok(bron.includes("if (actie === 'pma') return pmaSmal(d);"));
  const stuk = bron.slice(bron.indexOf('function pmaChatSchakelaar('), bron.indexOf('function pmaInfo()'));
  const { m, map } = opzet();
  const dir = path.join(map, 'pma');
  const smal = new Function('pmaApp', 'PMA_DIR', 'fs', 'path', '__dirname', 'logError', 'require', stuk + '\nreturn pmaSmal;')(m, dir, fs, path, path.join(__dirname, '..'), () => {}, require);
  const r = smal({ secret: 'geheim', praktijk: 'TG', periode: '2026-10', wat: 'visites', onzin: 'x' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.j.praktijken[0].link, 'https://app.socev.dev/pma#overzicht/tg/2026-10');
  assert.ok(!JSON.stringify(r.j).includes('geheim'));
  const n = smal({ praktijk: 'TG', periode: '2026-10', per: 'medewerker' });
  assert.strictEqual(n.status, 403); assert.strictEqual(n.j.links[0].link, 'https://app.socev.dev/pma#medewerkers/tg');
  fs.writeFileSync(path.join(dir, 'chat.json'), '{"per_medewerker": "ja"}');   // alleen echte true telt
  assert.strictEqual(smal({ praktijk: 'TG', periode: '2026-10', per: 'medewerker' }).status, 403);
  fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ per_medewerker: true, gezet: '2026-11-28', bron: 'proef' }));
  const j = smal({ praktijk: 'TG', periode: '2026-10', per: 'medewerker' });
  assert.strictEqual(j.status, 200); assert.strictEqual(j.j.praktijken[0].link_medewerkers, 'https://app.socev.dev/pma#medewerkers/tg');
  fs.writeFileSync(path.join(dir, 'chat.json'), '{kapot');
  assert.strictEqual(smal({ praktijk: 'TG', periode: '2026-10', per: 'medewerker' }).status, 403);
});

test('beide met één praktijk zonder data: die staat in zonder_data; rolgroepzin met POH-S in hoofdletters', () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-chatvraag-'));
  const m = P.maak({ map: path.join(map, 'pma'), finPatienten: () => ({}) });
  inlees(m, { agb: '009870', exportdatum: '2026-11-05', begin: '2026-10-01', eind: '2026-10-31',
    regels: M.inschrijving('2026-10-01', M.patienten(10, 800001), false).concat(R(K.vk, 6, '2026-10-14')) });
  const r = P.chatVraag(m.app({ methode: 'GET', pad: '/app/pma' }).body, { praktijk: 'beide', periode: 'oktober', wat: 'visites' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.zonder_data, [{ praktijk: 'GH', naam: 'Groenhouten', zin: 'Groenhouten: nog geen export ingelezen in PMA.' }]);
  const ov = { praktijken: [{ code: 'TG', naam: 'Tolgaarde', kwartalen: [], registreerders: [], maanden: [{ maand: '2026-10', dagen: 31, dagen_gedekt: 31, groepen: {}, sub: {}, voorlopig: 0, wd: { 'poh-s': [1, 1, 0, 0, 0], arts: [2, 0, 0, 0, 0] }, weekend: 0 }] }], bekend: [{ code: 'TG', naam: 'Tolgaarde' }] };
  assert.strictEqual(P.chatVraag(ov, { praktijk: 'TG', periode: 'oktober', per: 'rolgroep' }).body.praktijken[0].zin, 'Tolgaarde, oktober 2026 (ma–vr): artsen (samen) 2; POH-S 2.');
});
