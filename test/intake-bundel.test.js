'use strict';
// Toetsen voor OVIS Intake stap 6 (wv2710): bundels. Alleen wachtende stukken van een afzender met een sterk, actief kenmerk (mailadres uit het
// register + uitgelijnde DKIM, of KvK + tweede kenmerk) en hetzelfde voorstel; nooit bij privé, geld, mogelijk medisch, Jev, zwakke afzender of
// alleen een naam. De bundelkeuze toetst alles vooraf (409 = niets gedaan), is herhaalveilig en schrijft per stuk de gewone keuze.
// Alle toetsdata is verzonnen (de repo is openbaar). Aanroep: bash test/intake-router.sh. Kruisproef: IR_PAD=<oude intake-router.js>.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const R = require(process.env.IR_PAD || '../intake-router.js');
const K = R.K;
const poort = require('../intake/patientpoort.js');
const VV = require(process.env.VV_PAD || '../vault-veilig.js');

const TG = { o: 'o-tg', k: 'TG', naam: 'Huisartsenpraktijk Testgaarde', eigen: true, soort: 'entiteit', status: 'actief', concept: false, voor: [] };
const GH = { o: 'o-gh', k: 'GH', naam: 'Praktijk Proefhout', eigen: true, soort: 'entiteit', status: 'actief', concept: false, voor: [] };
const PRIVE = { o: 'o-pr', k: 'PRIVE', naam: 'Privé', eigen: true, soort: 'entiteit', status: 'actief', concept: false, voor: [] };
const ORG = { o: 'o-lev', k: 'org:proef-leverancier', naam: 'Proef Leverancier', eigen: false, soort: 'organisatie', status: 'actief', concept: false, voor: [] };
const ORG2 = { o: 'o-lev2', k: 'org:tweede-proef', naam: 'Tweede Proefbedrijf', eigen: false, soort: 'organisatie', status: 'actief', concept: false, voor: [] };
const HANDVATTEN = { compilatienummer: 9, entiteiten: [TG, GH, PRIVE, ORG, ORG2], niet_dezelfde: [], ids: [{ o: 'o-tg', ns: 'alias', v: 'testgaarde', st: 'actief' },
  { o: 'o-lev', ns: 'email', v: 'post@proef-leverancier.example', st: 'actief' }, { o: 'o-lev', ns: 'domein', v: 'proef-leverancier.example', st: 'actief' },
  { o: 'o-lev2', ns: 'email', v: 'info@tweede-proef.example', st: 'actief' }, { o: 'o-lev2', ns: 'domein', v: 'tweede-proef.example', st: 'actief' }] };
const GEWOON = 'Beste David, hierbij de uitnodiging voor het overleg over de nieuwe roosters volgende week dinsdag om 20.00 uur. Groet, Anne (verzonnen).';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function omgeving(extra) {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2710-'));
  const dir = path.join(basis, 'intake'), vault = path.join(basis, 'vault');
  fs.mkdirSync(dir, { recursive: true });
  for (const m of Object.values(K.KENNIS_MAP)) { fs.mkdirSync(path.join(vault, m), { recursive: true }); fs.mkdirSync(path.join(vault, path.dirname(m), 'Bronnen'), { recursive: true }); }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'intake.sqlite'));
  db.exec(`CREATE TABLE stuk (stuk_id TEXT PRIMARY KEY, bron TEXT NOT NULL, bron_id TEXT NOT NULL, profiel TEXT NOT NULL, versie INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
    aangemaakt TEXT NOT NULL, compleet_op TEXT, meta TEXT NOT NULL, marker_patient TEXT, marker_soorten TEXT, marker_versie TEXT, marker_op TEXT);
    CREATE TABLE onderdeel (stuk_id TEXT NOT NULL, deel TEXT NOT NULL, rol TEXT NOT NULL, naam TEXT NOT NULL, mime TEXT NOT NULL, grootte INTEGER NOT NULL, sha256 TEXT NOT NULL, meta TEXT, PRIMARY KEY (stuk_id, deel));
    CREATE TABLE vrij_veld (stuk_id TEXT NOT NULL, nr INTEGER NOT NULL, omschrijving TEXT NOT NULL, waarde TEXT, deel TEXT, PRIMARY KEY (stuk_id, nr));`);
  let n = 0;
  const klok = { t: Date.parse('2026-11-06T20:00:00Z') };
  const zet = function (x) {
    const id = 'stk_20261106_' + String(++n).padStart(8, '0');
    const op = x.op || new Date(klok.t - 60000).toISOString();
    db.prepare('INSERT INTO stuk (stuk_id, bron, bron_id, profiel, status, aangemaakt, compleet_op, meta, marker_patient, marker_soorten, marker_versie, marker_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, x.bron || 'gmail:david', 'b' + n, 'mail@1', 'router', op, op, JSON.stringify(x.meta || {}), x.marker || 'geen', JSON.stringify(x.soorten || []), 'patientpoort-2.0', op);
    (x.delen || []).forEach(function (d, i) {
      const b = Buffer.from(d.bytes);
      const h = sha(b);
      fs.mkdirSync(path.join(dir, 'blob', h.slice(0, 2)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'blob', h.slice(0, 2), h), b);
      db.prepare('INSERT INTO onderdeel (stuk_id, deel, rol, naam, mime, grootte, sha256, meta) VALUES (?,?,?,?,?,?,?,?)').run(id, d.deel || ('d' + i), d.rol, d.naam || 'x', d.mime, b.length, h, null);
    });
    return id;
  };
  const tel = { bewaar: [], fout: [] };
  const stand = { pauze: false };
  const o = Object.assign({ dir, vault, vv: VV, nu: () => klok.t, marker: poort,
    pdfBbox: async function () { return '<page>' + 'Rooster week 45 dinsdag avond overleg huisartsen verzonnen'.split(' ').map(function (w, j) { return '<word xMin="' + (10 + j * 60) + '" yMin="10" xMax="' + (60 + j * 60) + '" yMax="20">' + w + '</word>'; }).join('') + '</page>'; }, ocr: async function () { return null; }, docx: async function () { return null; }, paginas: async function () { return 1; },
    handvatten: async function () { return HANDVATTEN; }, eigenAdressen: function () { return ['david@voorbeeld.example']; },
    live: function () { return { 'gmail:david': true }; },
    lenzenLive: function () { return ['kennis', 'geen', 'facturen', 'systeem']; },
    jev: async function (x) { return { ref: x.ref, gemeten: true, injectie_kans: 0.02, aanspreking: false }; },
    indeling: async function () { return { ok: true, categorie: 'Huisartsenpraktijk Tolgaarde' }; },
    naamOk: function (nm) { return !/[\\/:*?"<>|]/.test(nm); },
    vaultPauze: function () { return stand.pauze; },
    bewaarNa: function (id, ms) { tel.bewaar.push([id, ms]); return 1; },
    datum: function () { return '2026-11-06'; },
    kaartZet: async function (p) { return { sleutel: p.sleutel }; }, kaartStatus: async function () { return { ok: true }; }, kaartOpen: async function () { return []; },
    melding: function () {}, fout: function (w, e) { tel.fout.push([w, e && e.code]); },
  }, extra || {});
  const r = R.maak(o);
  const bestanden = function () { const uit = []; (function loop(d) { for (const nm of fs.readdirSync(d)) { const f = path.join(d, nm); if (fs.statSync(f).isDirectory()) loop(f); else uit.push(path.relative(vault, f)); } })(vault); return uit.filter((f) => !/\/_register\.md$/.test(f)).sort(); };
  return { basis, dir, vault, db, zet, r, tel, klok, bestanden, stand };
}
function mail(van, onderwerp, tekst) { return 'From: ' + van + '\r\nSubject: ' + onderwerp + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + tekst; }
function stukMetBijlage(E, onderwerp) {
  return E.zet({ meta: { van: 'anne@voorbeeld.example', van_naam: 'Anne Proef', onderwerp, aan: ['david@voorbeeld.example'], verzonden: '2026-11-06T18:30:00Z' },
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail('anne@voorbeeld.example', onderwerp, GEWOON) },
      { deel: 'b1', rol: 'bijlage', naam: 'Rooster.pdf', mime: 'application/pdf', bytes: '%PDF-1.4 rooster ' + onderwerp }] });
}
const versie = (E, id) => E.db.prepare('SELECT versie FROM live_stuk WHERE stuk_id = ?').get(id).versie;

const AUTH = 'Authentication-Results: mx.google.com; dkim=pass header.d=proef-leverancier.example; dmarc=pass\r\n';
function bundelOmgeving() { return omgeving({ indeling: async function () { return { ok: true, categorie: 'Onbekend' }; } }); }
// een mail van de leverancier: sterk herkend (mailadres in het register + uitgelijnde DKIM), maar voor welke eigen entiteit weet Intake niet
function levMail(E, onderwerp, x) {
  x = x || {};
  const van = x.van || 'post@proef-leverancier.example';
  const tekst = x.tekst || ('Beste David, hierbij het verslag van ' + onderwerp + ' (verzonnen). Met vriendelijke groet, het team.');
  const kop = (x.auth === false ? '' : (x.auth || AUTH));
  return E.zet({ bron: x.bron, meta: { van, van_naam: x.van_naam || 'Proef Leverancier', onderwerp, aan: ['david@voorbeeld.example'], verzonden: '2026-11-06T18:30:00Z' },
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: kop + mail(van, onderwerp, tekst) }] });
}
const lijstVan = (E, ids) => ids.map((id) => ({ stuk_id: id, versie: versie(E, id) }));
const staat = (E, id) => E.db.prepare('SELECT staat, keuze, keuze_door FROM live_stuk WHERE stuk_id = ?').get(id);

test('drie stukken van een sterk herkende afzender = één bundel in het overzicht; twee = geen bundel; Werkstroom en Geschiedenis zonder sleutel', async () => {
  const E = bundelOmgeving();
  const a = levMail(E, 'Nieuwsbrief oktober'), b = levMail(E, 'Nieuwsbrief november'), c = levMail(E, 'Uitnodiging webinar');
  await E.r.ronde();
  for (const id of [a, b, c]) assert.equal(staat(E, id).staat, 'twijfel', id);
  const ov = await E.r.appOverzicht(80);
  const st = ov.stukken.filter((s) => [a, b, c].includes(s.stuk_id));
  assert.equal(st.length, 3);
  assert.match(st[0].bundel, /^b[0-9a-f]{16}$/);
  assert.ok(st.every((s) => s.bundel === st[0].bundel));
  assert.ok(ov.stukken.every((s) => !('_b' in s)));
  assert.equal(ov.live.bundel_min, 3);
  const ws = await E.r.appWerkstroom('wacht', 50);
  assert.ok(ws.stukken.every((s) => !('_b' in s) && !('bundel' in s)));
  // na een losse keuze voor één ervan blijven er twee over: geen bundel meer (en het voorstel voor deze afzender is nu TG)
  assert.equal((await E.r.appKeuze({ stuk_id: c, keuze: 'bestemming', lens: 'kennis', entiteit: 'TG', versie: versie(E, c) }, 'app:x')).status, 200);
  const ov2 = await E.r.appOverzicht(80);
  assert.ok(ov2.stukken.filter((s) => [a, b].includes(s.stuk_id)).every((s) => !s.bundel));
  E.r.sluit();
});

test('nooit bundelen: zwakke afzender (geen DKIM), alleen een naam, geld in de tekst (bedrag/IBAN)', async () => {
  const E = bundelOmgeving();
  const zonder = [1, 2, 3].map((i) => levMail(E, 'Zonder dkim ' + i, { auth: false }));
  const naam = [1, 2, 3].map((i) => levMail(E, 'Naam ' + i, { van: 'iemand' + i + '@ander.example', van_naam: 'Proef Leverancier', auth: false }));
  const geld = [1, 2, 3].map((i) => levMail(E, 'Betaling ' + i, { tekst: 'Beste David, graag betaling van EUR 120,00 op NL91ABNA0417164300 (verzonnen). Groet.' }));
  await E.r.ronde();
  const ov = await E.r.appOverzicht(80);
  for (const id of zonder.concat(naam, geld)) {
    const s = ov.stukken.find((x) => x.stuk_id === id);
    if (s) assert.ok(!s.bundel, 'geen bundel verwacht voor ' + id + ' ' + JSON.stringify({ af: s.afzender, k: s.afzender_kracht, st: s.live && s.live.staat }));
  }
  E.r.sluit();
});

test('bundelSleutel weigert privé, mogelijk medisch, Jev, facturen, kandidaat Privé en aangeleverd door David (eenheid op de samenvatting)', async () => {
  const E = bundelOmgeving();
  const ids = [1, 2, 3].map((i) => levMail(E, 'Overleg ' + i));
  await E.r.ronde();
  const basis = (await E.r.appOverzicht(80)).stukken.find((s) => s.stuk_id === ids[0]).bundel;
  assert.ok(basis);
  const pas = async (fn) => {
    const rij = E.db.prepare('SELECT r.rowid, r.samenvatting FROM router_stuk r JOIN live_stuk l ON l.stuk_id = r.stuk_id AND l.versie = r.versie WHERE r.stuk_id = ?').get(ids[0]);
    const sam = JSON.parse(rij.samenvatting); fn(sam);
    E.db.prepare('UPDATE router_stuk SET samenvatting = ? WHERE rowid = ?').run(JSON.stringify(sam), rij.rowid);
    const s = (await E.r.appOverzicht(80)).stukken.find((x) => x.stuk_id === ids[0]);
    E.db.prepare('UPDATE router_stuk SET samenvatting = ? WHERE rowid = ?').run(rij.samenvatting, rij.rowid);
    return s;
  };
  for (const [naam, fn] of [
    ['privégrens', (s) => { s.prive_schaduw = 'zakelijk'; }], ['mogelijk medisch', (s) => { s.mogelijk_medisch = true; }], ['na keuze', (s) => { s.na_keuze = true; }],
    ['jev', (s) => { s.jev = 'boven'; }], ['jev zonder uitslag', (s) => { s.jev = 'geen_uitslag'; }], ['factuur', (s) => { s.soort = 'bewijsstuk'; }], ['aanmaning', (s) => { s.soort = 'keten'; }],
    ['bedrag', (s) => { s.velden = ['bedrag']; }], ['facturenlens', (s) => { s.bestemmingen = s.bestemmingen.concat([{ lens: 'facturen', doel: null, zou_auto: false, reden: 'x' }]); }],
    ['entiteit privé', (s) => { s.entiteit = 'PRIVE'; }], ['label privé', (s) => { s.label_route = ['PRIVE']; }], ['aangeleverd', (s) => { s.aangeleverd_door = 'david'; }],
    ['zwak', (s) => { s.afzender_kracht = 'redelijk'; }], ['alleen domein', (s) => { s.afzender_kenmerken = ['domein_van+dkim', 'naam']; }], ['dkim niet uitgelijnd', (s) => { s.dkim = 'pass'; }],
    ['geld in de tekst', (s) => { s.geld = true; }], ['stuk van vóór wv2710 (geen geld-veld)', (s) => { delete s.geld; }], ['persoon als afzender', (s) => { s.afzender = 'persoon:x'; }],
    ['altijd vragen', (s) => { s.bestemmingen = [{ lens: 'kennis', doel: null, zou_auto: false, reden: 'regel_altijd_vragen' }]; }],
  ]) {
    const s = await pas(fn);
    assert.ok(s.bundel !== basis, naam + ': mag niet in de bundel');
  }
  // KvK met tweede kenmerk is wel sterk
  const s = await pas((x) => { x.afzender_kenmerken = ['kvk+domein_in_stuk']; x.dkim = 'geen_pass'; });
  assert.equal(s.bundel, basis);
  E.r.sluit();
});

test('bundelkeuze: alles of niets vooraf, herhaalveilig, per stuk de gewone keuze met de bundel in de correctie', async () => {
  const E = bundelOmgeving();
  const ids = [1, 2, 3, 4].map((i) => levMail(E, 'Verslag ' + i));
  await E.r.ronde();
  const ov = await E.r.appOverzicht(80);
  const sl = ov.stukken.find((s) => s.stuk_id === ids[0]).bundel;
  assert.ok(sl);
  // fout: onbekende sleutel, te weinig stukken, facturen, Privé zonder map? (PRIVE heeft een map: mag als David het zelf kiest), dubbel id
  assert.equal((await E.r.appBundel({ bundel: 'bxyz', stukken: lijstVan(E, ids), lens: 'geen' }, 'app:x')).status, 400);
  assert.equal((await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids.slice(0, 2)), lens: 'geen' }, 'app:x')).status, 400);
  assert.equal((await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids), lens: 'facturen', entiteit: 'TG' }, 'app:x')).status, 400);
  assert.equal((await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, [ids[0], ids[0], ids[1]]), lens: 'geen' }, 'app:x')).status, 400);
  // een oude versie in de lijst: 409 en NIETS gekozen
  const oud = lijstVan(E, ids); oud[2].versie += 1;
  assert.equal((await E.r.appBundel({ bundel: sl, stukken: oud, lens: 'kennis', entiteit: 'GH' }, 'app:x')).status, 409);
  assert.ok(ids.every((id) => staat(E, id).staat === 'twijfel'));
  // een vreemd stuk erbij (andere afzender): 409, niets gekozen
  const vreemd = levMail(E, 'Ander', { van: 'info@tweede-proef.example', auth: 'Authentication-Results: mx.google.com; dkim=pass header.d=tweede-proef.example\r\n' });
  await E.r.ronde();
  const r0 = await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids.slice(0, 3).concat([vreemd])), lens: 'kennis', entiteit: 'GH' }, 'app:x');
  assert.equal(r0.status, 409); assert.equal(r0.j.code, 'bundel_veranderd');
  assert.ok(ids.every((id) => staat(E, id).staat === 'twijfel'));
  // goed: alle vier naar GH
  const r1 = await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids), lens: 'kennis', entiteit: 'GH' }, 'app:Pixel');
  assert.equal(r1.status, 200, JSON.stringify(r1.j)); assert.equal(r1.j.n, 4); assert.equal(r1.j.mislukt, 0); assert.equal(r1.j.uitkomst, 'uitgevoerd');
  for (const id of ids) { const x = staat(E, id); assert.equal(x.keuze, 'kennis:GH'); assert.equal(x.keuze_door, 'app:Pixel'); assert.notEqual(x.staat, 'twijfel'); }
  const c = E.db.prepare("SELECT wat, leren_mag FROM correctie WHERE json_extract(wat, '$.keuze') = 'bestemming'").all();
  assert.equal(c.length, 4); assert.ok(c.every((x) => JSON.parse(x.wat).bundel === sl && x.leren_mag === 1));
  assert.equal(E.bestanden().filter((f) => f.startsWith('10_Zakelijk/Groenhouten/raw_input/') && /\.md$/.test(f)).length, 4);
  // herhaling (dubbele tik, tweede venster): al_zo, niets nieuw
  const r2 = await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids), lens: 'kennis', entiteit: 'GH' }, 'app:Pixel');
  assert.equal(r2.status, 200); assert.equal(r2.j.uitkomst, 'al_zo');
  assert.equal(E.db.prepare("SELECT count(*) n FROM correctie WHERE json_extract(wat, '$.keuze') = 'bestemming'").get().n, 4);
  // dezelfde bundel naar een andere plek: geweigerd (het zijn geen wachtende stukken meer; verplaatsen gaat per stuk in de Geschiedenis)
  assert.equal((await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids), lens: 'geen' }, 'app:Pixel')).status, 409);
  E.r.sluit();
});

test('bundelkeuze Niet in de Brain; een stuk dat intussen privé blijkt (privégrens) maakt de hele bundel ongeldig', async () => {
  const E = bundelOmgeving();
  const ids = [1, 2, 3].map((i) => levMail(E, 'Folder ' + i));
  await E.r.ronde();
  const sl = (await E.r.appOverzicht(80)).stukken.find((s) => s.stuk_id === ids[0]).bundel;
  const rij = E.db.prepare('SELECT r.rowid, r.samenvatting FROM router_stuk r JOIN live_stuk l ON l.stuk_id = r.stuk_id AND l.versie = r.versie WHERE r.stuk_id = ?').get(ids[1]);
  const sam = JSON.parse(rij.samenvatting); sam.prive_schaduw = 'onbekend';
  E.db.prepare('UPDATE router_stuk SET samenvatting = ? WHERE rowid = ?').run(JSON.stringify(sam), rij.rowid);
  const r = await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids), lens: 'kennis', entiteit: 'TG' }, 'app:x');
  assert.equal(r.status, 409); assert.equal(r.j.code, 'bundel_veranderd');
  assert.ok(ids.every((id) => staat(E, id).staat === 'twijfel'));
  E.db.prepare('UPDATE router_stuk SET samenvatting = ? WHERE rowid = ?').run(rij.samenvatting, rij.rowid);
  const r2 = await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids), lens: 'geen' }, 'app:x');
  assert.equal(r2.status, 200, JSON.stringify(r2.j)); assert.equal(r2.j.n, 3);
  assert.ok(ids.every((id) => staat(E, id).keuze === 'geen:'));
  assert.equal(E.bestanden().filter((f) => /raw_input\/.*\.md$/.test(f)).length, 0);
  E.r.sluit();
});

test('vastgehouden stukken (patiëntpoort) komen nooit in een bundel en de bundelroute weigert ze', async () => {
  const E = bundelOmgeving();
  const ids = [1, 2, 3].map((i) => levMail(E, 'Bericht ' + i));
  await E.r.ronde();
  const sl = (await E.r.appOverzicht(80)).stukken.find((s) => s.stuk_id === ids[0]).bundel;
  E.db.prepare("UPDATE live_stuk SET staat = 'vastgehouden' WHERE stuk_id = ?").run(ids[2]);
  const ov = await E.r.appOverzicht(80);
  assert.ok(!ov.stukken.find((s) => s.stuk_id === ids[2]).bundel);
  assert.ok(ov.stukken.filter((s) => ids.slice(0, 2).includes(s.stuk_id)).every((s) => !s.bundel));   // nog maar twee: geen bundel
  const r = await E.r.appBundel({ bundel: sl, stukken: lijstVan(E, ids), lens: 'geen' }, 'app:x');
  assert.equal(r.status, 409);
  assert.equal(staat(E, ids[0]).staat, 'twijfel'); assert.equal(staat(E, ids[1]).staat, 'twijfel');
  E.r.sluit();
});

test('met een voorstel: na een eerdere keuze voor deze afzender krijgt de bundel het voorstel, en "Klopt voor alle" zet ze daar', async () => {
  const E = bundelOmgeving();
  const eerst = levMail(E, 'Eerste');
  await E.r.ronde();
  assert.equal((await E.r.appKeuze({ stuk_id: eerst, keuze: 'bestemming', lens: 'kennis', entiteit: 'TG', versie: versie(E, eerst) }, 'app:x')).status, 200);
  E.klok.t += 3600000;
  const ids = [1, 2, 3].map((i) => levMail(E, 'Daarna ' + i));
  await E.r.ronde();
  const st = (await E.r.appOverzicht(80)).stukken.filter((s) => ids.includes(s.stuk_id));
  assert.equal(st.length, 3); assert.ok(st[0].bundel); assert.ok(st.every((s) => s.bundel === st[0].bundel));
  assert.deepEqual(st[0].voorstel, { lens: 'kennis', entiteit: 'TG' });
  const r = await E.r.appBundel({ bundel: st[0].bundel, stukken: lijstVan(E, ids), lens: 'kennis', entiteit: 'TG' }, 'app:x');
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.n, 3);
  assert.equal(E.bestanden().filter((f) => f.startsWith('10_Zakelijk/Tolgaarde/raw_input/') && /\.md$/.test(f)).length, 4);
  E.r.sluit();
});
