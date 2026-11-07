'use strict';
// Toetsen voor OVIS Intake stap 5 (wv2618): Geschiedenis per dag, Verplaats vóór en ná de nachtverwerking, 409 op een oude versie, herhaling,
// weigering bij een stuk in de Facturen-app, Toch bewaren, Verwijder alleen als verzoek (niets gewist), vault-veilig verplaatsen.
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
const HANDVATTEN = { compilatienummer: 9, entiteiten: [TG, GH, PRIVE], niet_dezelfde: [], ids: [{ o: 'o-tg', ns: 'alias', v: 'testgaarde', st: 'actief' }] };
const GEWOON = 'Beste David, hierbij de uitnodiging voor het overleg over de nieuwe roosters volgende week dinsdag om 20.00 uur. Groet, Anne (verzonnen).';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function omgeving(extra) {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2618-'));
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

test('Verplaats vóór de nacht: .md op de nieuwe plek met de nieuwe entiteit, bijlage verhuist (zelfde inode), oude map leeg; Geschiedenis en publicatie volgen', async () => {
  const E = omgeving();
  const id = stukMetBijlage(E, 'Overleg roosters');
  await E.r.ronde();
  const voor = E.bestanden();
  assert.equal(voor.length, 2); assert.ok(voor.every((f) => f.startsWith('10_Zakelijk/Tolgaarde/raw_input/')));
  const bij = voor.find((f) => /\.pdf$/.test(f));
  const ino = fs.statSync(path.join(E.vault, bij)).ino;
  const k = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: versie(E, id) }, 'app:Laptop');
  assert.equal(k.status, 200, JSON.stringify(k.j)); assert.equal(k.j.uitkomst, 'uitgevoerd'); assert.equal(k.j.verplaatst.na_nacht, false); assert.equal(k.j.verplaatst.rechtzetten, false);
  const na = E.bestanden();
  assert.equal(na.length, 2, na.join()); assert.ok(na.every((f) => f.startsWith('10_Zakelijk/Groenhouten/raw_input/')), na.join());
  const nieuwBij = na.find((f) => /\.pdf$/.test(f));
  assert.equal(fs.statSync(path.join(E.vault, nieuwBij)).ino, ino);   // echt verplaatst (link + unlink), niet opnieuw geschreven
  const md = fs.readFileSync(path.join(E.vault, na.find((f) => /\.md$/.test(f))), 'utf8');
  assert.match(md, /\nentiteit_id: GH\n/); assert.match(md, /entiteit_zekerheid: "david, bewijs keuze van David"/); assert.doesNotMatch(md, /ovis_verplaatst_van/);
  assert.match(md, /bijlagen:\n  - "[^"]+Rooster\.pdf"/);
  const uk = E.db.prepare('SELECT uitkomst, doel FROM uitvoering WHERE stuk_id = ? AND lens = ? ORDER BY id').all(id, 'kennis').map((x) => x.doel + ':' + x.uitkomst);
  assert.deepEqual(uk.filter((x) => x.startsWith('TG:')).sort(), ['TG:verplaatst', 'TG:weg_na_verplaatsen']);
  // publicatie (wv2618): de nieuwste kennis-uitvoering die er nog is
  assert.equal(E.db.prepare("SELECT doel FROM uitvoering WHERE stuk_id = ? AND lens = 'kennis' AND doel IS NOT NULL AND uitkomst IN ('nieuw','gelijk') ORDER BY id DESC LIMIT 1").get(id).doel, 'GH');
  const c = E.db.prepare("SELECT wat, door, leren_mag FROM correctie WHERE stuk_id = ? AND json_extract(wat, '$.keuze') = 'verplaats_vault'").get(id);
  assert.equal(c.door, 'app:Laptop'); assert.equal(c.leren_mag, 0);
  // Geschiedenis: één dag, wie besliste = jij, plek = GH, Verplaats mag
  const g = await E.r.appGeschiedenis({});
  assert.equal(g.dagen.length, 1); assert.equal(g.dagen[0].dag, '2026-11-06');
  const s = g.dagen[0].stukken[0];
  assert.equal(s.beslist, 'jij'); assert.deepEqual(s.plek, { lens: 'kennis', entiteit: 'GH', zeker: true }); assert.equal(s.kan.verplaats, true); assert.equal(s.kan.toch_bewaren, false);
  assert.match(s.live.uitgevoerd.pad, /^10_Zakelijk\/Groenhouten\/raw_input\//);
  E.r.sluit();
});

test('Verplaats ná de nacht (register kent het stuk): oude bestanden blijven, rechtzet-notitie in de oude raw_input, nieuw .md met ovis_verplaatst_van', async () => {
  const E = omgeving();
  const id = stukMetBijlage(E, 'Overleg na nacht');
  await E.r.ronde();
  const voor = E.bestanden();
  // de nachtverwerking: log in het register van Testgaarde (boven het gegenereerde blok); het bestand blijft (bronnotitie-regel)
  fs.writeFileSync(path.join(E.vault, '10_Zakelijk/Tolgaarde/Bronnen/_register.md'), '# Register\n\n| Bestand | Origineel |\n|---|---|\n| x | `raw_input/x.md` (ovis_stuk ' + id + ') |\n\n<!-- ovis:blok begin id="bronregister" -->\n<!-- ovis:blok eind -->\n');
  const k = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'PRIVE', versie: versie(E, id) }, 'app:Pixel');
  assert.equal(k.status, 200, JSON.stringify(k.j)); assert.equal(k.j.verplaatst.na_nacht, true); assert.equal(k.j.verplaatst.rechtzetten, true);
  const na = E.bestanden();
  for (const f of voor) assert.ok(na.includes(f), 'oud bestand blijft: ' + f);
  const notitie = na.find((f) => /^10_Zakelijk\/Tolgaarde\/raw_input\/.*_rechtzetten_/.test(f));
  assert.ok(notitie, na.join());
  const nt = fs.readFileSync(path.join(E.vault, notitie), 'utf8');
  assert.match(nt, new RegExp('^---\\novis_rechtzetten: ' + id + '\\n')); assert.doesNotMatch(nt, /^ovis_stuk:/m);   // geen ovis_stuk: de publicatie telt hem niet als origineel
  assert.doesNotMatch(nt, /uitnodiging|roosters|Anne/);   // geen inhoud van het stuk
  const nieuw = na.find((f) => /^20_Prive\/raw_input\/.*\.md$/.test(f));
  assert.ok(nieuw, na.join());
  assert.match(fs.readFileSync(path.join(E.vault, nieuw), 'utf8'), /\novis_verplaatst_van: "tolgaarde"\n/);
  assert.ok(na.some((f) => /^20_Prive\/raw_input\/.*\.pdf$/.test(f)));   // bijlage opnieuw uit de blob (de oude blijft bij de verwerkte bron)
  // de oude rijen tellen niet meer als huidige plek: een tweede verplaatsing (PRIVE → GH) ruimt alleen de PRIVE-kopie op, vóór de nacht van PRIVE
  const k2 = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: versie(E, id) }, 'app:Pixel');
  assert.equal(k2.status, 200); assert.equal(k2.j.verplaatst.na_nacht, false);
  const na2 = E.bestanden();
  assert.ok(!na2.some((f) => f.startsWith('20_Prive/')), na2.join());
  for (const f of voor) assert.ok(na2.includes(f));
  assert.equal(na2.filter((f) => /_rechtzetten_/.test(f)).length, 1);
  E.r.sluit();
});

test('Verplaats ná de nacht (bestand al verwerkt en weg): notitie; naar Niet in de Brain vóór de nacht: kopieën weg, stuk blijft in Intake', async () => {
  const E = omgeving();
  const a = stukMetBijlage(E, 'Stuk A');
  const b = stukMetBijlage(E, 'Stuk B');
  await E.r.ronde();
  const mdA = E.db.prepare("SELECT pad FROM uitvoering WHERE stuk_id = ? AND pad LIKE '%.md'").get(a).pad;
  fs.renameSync(path.join(E.vault, mdA), path.join(E.vault, '10_Zakelijk/Tolgaarde/Bronnen/Tolgaarde - 2026-11-06 - stuk A.md'));   // de skill archiveerde het
  const ka = await E.r.appKeuze({ stuk_id: a, keuze: 'bestemming', lens: 'geen', versie: versie(E, a) }, 'app:Laptop');
  assert.equal(ka.status, 200); assert.equal(ka.j.verplaatst.na_nacht, true); assert.equal(ka.j.verplaatst.rechtzetten, true);
  const nt = E.bestanden().find((f) => /_rechtzetten_/.test(f));
  assert.match(fs.readFileSync(path.join(E.vault, nt), 'utf8'), /nieuwe_plek: "niet in de Second Brain/);
  const kb = await E.r.appKeuze({ stuk_id: b, keuze: 'bestemming', lens: 'geen', versie: versie(E, b) }, 'app:Laptop');
  assert.equal(kb.status, 200); assert.equal(kb.j.verplaatst.na_nacht, false); assert.equal(kb.j.verplaatst.bestanden, 2);
  assert.ok(!E.bestanden().some((f) => /Stuk-B/.test(f)), E.bestanden().join());
  assert.ok(E.tel.bewaar.some((x) => x[0] === b));   // 90 dagen in Intake
  const g = await E.r.appGeschiedenis({});
  const sb = g.dagen[0].stukken.find((x) => x.stuk_id === b);
  assert.deepEqual(sb.plek, { lens: 'geen', entiteit: null, zeker: true }); assert.equal(sb.live.uitgevoerd, null);
  E.r.sluit();
});

test('Verplaats: 409 op een oude versie, herhaling verandert niets, facturen-weigering, nachtgrendel 503, gewijzigd bestand blijft staan', async () => {
  const E = omgeving();
  const id = stukMetBijlage(E, 'Herhaal');
  const f = stukMetBijlage(E, 'Factuurstuk');
  await E.r.ronde();
  const v = versie(E, id);
  assert.equal((await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: v + 1 }, 'app:x')).status, 409);
  E.stand.pauze = true;
  const p = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: v }, 'app:x');
  assert.equal(p.status, 503); assert.match(p.j.fout, /bijgewerkt/);
  assert.equal(E.db.prepare("SELECT count(*) n FROM correctie WHERE stuk_id = ?").get(id).n, 0);   // niets vastgelegd
  E.stand.pauze = false;
  // David bewerkte de bijlage in de raw_input: die blijft staan, het .md verhuist wel
  const bij = E.bestanden().find((x) => /Herhaal.*\.pdf$/.test(x));
  fs.appendFileSync(path.join(E.vault, bij), ' bewerkt');
  const k1 = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: v }, 'app:x');
  assert.equal(k1.status, 200);
  assert.ok(fs.existsSync(path.join(E.vault, bij)));
  const k2 = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: v }, 'app:x');
  assert.equal(k2.j.uitkomst, 'al_zo');
  assert.equal(E.db.prepare("SELECT count(*) n FROM correctie WHERE stuk_id = ? AND json_extract(wat, '$.keuze') = 'verplaats_vault'").get(id).n, 1);
  // een stuk dat al in de Facturen-app staat
  E.db.prepare("INSERT INTO uitvoering (stuk_id, versie, lens, doel, pad, sha256, uitkomst, tijd, door) VALUES (?,?,?,?,?,?,?,?,?)").run(f, versie(E, f), 'facturen', 'TG', null, null, 'facturen:1', '2026-11-06T20:00:00Z', 'koerier');
  const voorF = E.bestanden();
  const kf = await E.r.appKeuze({ stuk_id: f, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: versie(E, f) }, 'app:x');
  assert.equal(kf.status, 409); assert.equal(kf.j.code, 'in_facturen'); assert.match(kf.j.fout, /Facturen-app/);
  assert.deepEqual(E.bestanden(), voorF);
  const g = await E.r.appGeschiedenis({});
  const sf = g.dagen[0].stukken.find((x) => x.stuk_id === f);
  assert.equal(sf.kan.verplaats, false); assert.equal(sf.kan.in_facturen, true);
  E.r.sluit();
});

test('Toch bewaren: een stuk dat David liet bewaren gaat alsnog door; weggegooid niet; Verwijder is alleen een verzoek (niets gewist)', async () => {
  const E = omgeving();
  const gem = E.zet({ marker: 'gemarkeerd', soorten: ['brieftaal'], meta: { van: 'poli@voorbeeld.example', onderwerp: 'Verslag', aan: ['david@voorbeeld.example'] },
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail('poli@voorbeeld.example', 'Verslag', 'Geachte collega, een verzonnen brief over het rooster.') }] });
  const weg = E.zet({ marker: 'gemarkeerd', soorten: ['brieftaal'], meta: { van: 'poli@voorbeeld.example', onderwerp: 'Weg', aan: ['david@voorbeeld.example'] },
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail('poli@voorbeeld.example', 'Weg', 'Verzonnen.') }] });
  await E.r.ronde();
  assert.equal((await E.r.appKeuze({ stuk_id: gem, keuze: 'bewaren' }, 'app:x')).status, 200);
  assert.equal((await E.r.appKeuze({ stuk_id: weg, keuze: 'weggooien' }, 'app:x')).status, 200);
  let g = await E.r.appGeschiedenis({});
  const sg = g.dagen[0].stukken.find((x) => x.stuk_id === gem);
  assert.equal(sg.kan.toch_bewaren, true); assert.equal(sg.onderwerp, undefined);   // privacygrens zoals het overzicht
  assert.equal(g.dagen[0].stukken.find((x) => x.stuk_id === weg).kan.toch_bewaren, false);
  assert.equal((await E.r.appKeuze({ stuk_id: gem, keuze: 'bewaren' }, 'app:x')).j.uitkomst, 'al_zo');
  const t = await E.r.appKeuze({ stuk_id: gem, keuze: 'verwerken', versie: versie(E, gem) }, 'app:x');
  assert.equal(t.status, 200, JSON.stringify(t.j));
  assert.ok(E.bestanden().some((f) => /raw_input\/.*Verslag/.test(f)), E.bestanden().join());
  assert.equal((await E.r.appKeuze({ stuk_id: weg, keuze: 'verwerken' }, 'app:x')).status, 400);
  // Verwijder: toetsen + vastleggen; bestanden en databank blijven
  const voor = E.bestanden();
  const m = E.r.verwijderMag({ stuk_id: gem, versie: versie(E, gem) });
  assert.equal(m.status, 200); assert.equal(m.j.al, null); assert.equal(m.j.bron, 'gmail:david');
  assert.equal(E.r.verwijderMag({ stuk_id: gem, versie: versie(E, gem) + 1 }).status, 409);
  assert.equal(E.r.verwijderMag({ stuk_id: weg }).status, 409);
  assert.equal(E.r.verwijderMag({ stuk_id: 'x' }).status, 400);
  E.r.verwijderGevraagd(gem, 'app:x', 9999);
  assert.ok(E.r.verwijderMag({ stuk_id: gem }).j.al);
  assert.deepEqual(E.bestanden(), voor);
  assert.equal(E.db.prepare('SELECT staat FROM live_stuk WHERE stuk_id = ?').get(gem).staat === 'weg', false);
  g = await E.r.appGeschiedenis({});
  assert.ok(g.dagen[0].stukken.find((x) => x.stuk_id === gem).verwijder_gevraagd);
  E.r.sluit();
});

test('Geschiedenis: per Nederlandse dag, nieuwste eerst, wachtende stukken niet, cursor zonder gat of dubbel, vanzelf/jij', async () => {
  const E = omgeving();
  const ids = [];
  for (let i = 0; i < 7; i++) {
    E.klok.t = Date.parse('2026-11-04T22:30:00Z') + i * 6 * 3600000;   // 23:30 NL op 4-11, daarna elke 6 uur een ronde
    ids.push(E.zet({ meta: { van: 'anne@voorbeeld.example', onderwerp: 'Stuk ' + i, aan: ['david@voorbeeld.example'] }, delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail('anne@voorbeeld.example', 'Stuk ' + i, GEWOON + i) }] }));
    await E.r.ronde();
  }
  E.db.prepare("UPDATE live_stuk SET staat = 'twijfel' WHERE stuk_id = ?").run(ids[3]);
  const gezien = [];
  let c = null, pag = 0, eerste = null;
  do {
    const g = await E.r.appGeschiedenis({ n: 5, voor: c });
    if (!eerste) eerste = g;
    for (const d of g.dagen) for (const s of d.stukken) gezien.push([d.dag, s.stuk_id, s.beslist]);
    c = g.volgende; pag++;
  } while (c && pag < 5);
  assert.equal(pag, 2);
  assert.deepEqual(gezien.map((x) => x[1]), ids.filter((x) => x !== ids[3]).reverse());
  assert.ok(gezien.every((x) => x[2] === 'vanzelf'));
  assert.equal(gezien[gezien.length - 1][0], '2026-11-04');   // 22:30 UTC = 23:30 in Nederland
  assert.equal(eerste.dagen[0].dag, '2026-11-06');
  assert.ok(eerste.dagen.every((d, i, a) => i === 0 || d.dag < a[i - 1].dag));
  E.r.sluit();
});

test('vault-veilig: verplaats volgt geen symlink, weigert een bestaand doel en een andere inhoud; wegAlsGelijk alleen bij dezelfde sha', () => {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2618-vv-'));
  fs.mkdirSync(path.join(b, 'a')); fs.mkdirSync(path.join(b, 'z')); fs.mkdirSync(path.join(b, 'buiten'));
  fs.writeFileSync(path.join(b, 'a', 'x.pdf'), 'inhoud');
  const h = sha(Buffer.from('inhoud'));
  assert.equal(VV.verplaats(path.join(b, 'a', 'x.pdf'), path.join(b, 'z', 'x.pdf'), { sha256: '0'.repeat(64) }), false);
  assert.ok(fs.existsSync(path.join(b, 'a', 'x.pdf')));
  fs.writeFileSync(path.join(b, 'z', 'bezet.pdf'), 'ander');
  assert.throws(() => VV.verplaats(path.join(b, 'a', 'x.pdf'), path.join(b, 'z', 'bezet.pdf')), (e) => e.code === 'EEXIST');
  fs.symlinkSync(path.join(b, 'buiten'), path.join(b, 'link'));
  assert.throws(() => VV.verplaats(path.join(b, 'a', 'x.pdf'), path.join(b, 'link', 'x.pdf')), (e) => e.code === 'ESYMLINK');
  assert.deepEqual(fs.readdirSync(path.join(b, 'buiten')), []);
  assert.equal(VV.verplaats(path.join(b, 'a', 'x.pdf'), path.join(b, 'z', 'x.pdf'), { sha256: h }), true);
  assert.ok(!fs.existsSync(path.join(b, 'a', 'x.pdf'))); assert.equal(fs.readFileSync(path.join(b, 'z', 'x.pdf'), 'utf8'), 'inhoud');
  assert.equal(VV.wegAlsGelijk(path.join(b, 'z', 'bezet.pdf'), h), false); assert.ok(fs.existsSync(path.join(b, 'z', 'bezet.pdf')));
  assert.throws(() => VV.wegAlsGelijk(path.join(b, 'z', 'x.pdf'), null), (e) => e.code === 'EGEENSHA');
  fs.symlinkSync(path.join(b, 'z', 'x.pdf'), path.join(b, 'a', 'naar.pdf'));
  assert.equal(VV.wegAlsGelijk(path.join(b, 'a', 'naar.pdf'), h), false);   // een link wordt nooit gevolgd en blijft staan
  assert.ok(fs.lstatSync(path.join(b, 'a', 'naar.pdf')).isSymbolicLink());
  // claim: een andere inhoud wordt teruggezet onder dezelfde naam (zelfde inode), er blijft geen claimbestand achter
  const ino = fs.statSync(path.join(b, 'z', 'bezet.pdf')).ino;
  assert.equal(VV.wegAlsGelijk(path.join(b, 'z', 'bezet.pdf'), h), false);
  assert.equal(fs.statSync(path.join(b, 'z', 'bezet.pdf')).ino, ino);
  assert.deepEqual(fs.readdirSync(path.join(b, 'z')).filter((n) => /ovis-claim/.test(n)), []);
  assert.ok(fs.existsSync(path.join(b, 'z', 'x.pdf')));
  assert.equal(VV.wegAlsGelijk(path.join(b, 'z', 'x.pdf'), h), true); assert.ok(!fs.existsSync(path.join(b, 'z', 'x.pdf')));
});

test('server.js (wv2618): routes geschiedenis en verwijder; verwijder alleen primair en alleen via de werklijst (geen eigen wisser)', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const f = srv.slice(srv.indexOf('async function appIntakeRouter'), srv.indexOf('function intakeRouterInfo()'));
  assert.match(f, /route === 'POST \/app\/intake\/geschiedenis'/); assert.match(f, /route === 'POST \/app\/intake\/verwijder'\) \{[^\n]*\n\s+if \(!rolPrimair\(\)\)/);
  const v = srv.slice(srv.indexOf('async function intakeVerwijderVraag'), srv.indexOf('function intakeRouterInfo()'));
  assert.match(v, /mk_werkvoorraad_zet/); assert.match(v, /'machinekamer:intake-verwijder-' \+ id/);
  assert.doesNotMatch(v, /voer-uit'|voerUit\(|unlink|rmSync|DELETE FROM/);
  const op = srv.slice(srv.indexOf('function intakeVerwijderOpdracht'), srv.indexOf('async function intakeVerwijderVraag'));
  assert.match(op, /Ja met vingerafdruk/); assert.match(op, /wis zelf niets/);
});

test('review MOET 1: lukt het opruimen niet (fout of crash), dan staat het open en ruimt een volgende ronde het op; een herhaalde keuze slaat niets over', async () => {
  let stuk = 2;   // bij de keuze en bij de tweede poging na het schrijven
  const vv = Object.assign({}, VV, { verplaats: function () { if (stuk > 0) { stuk--; const e = new Error('nep'); e.code = 'EIO'; throw e; } return VV.verplaats.apply(null, arguments); } });
  const E = omgeving({ vv });
  const id = stukMetBijlage(E, 'Opnieuw');
  await E.r.ronde();
  const k = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: versie(E, id) }, 'app:x');
  assert.equal(k.status, 200); assert.equal(k.j.verplaatst.open, 1);
  assert.ok(E.tel.fout.some((x) => x[0] === 'intake-router-verplaats' && x[1] === 'EIO'));
  assert.ok(E.bestanden().some((f) => /^10_Zakelijk\/Tolgaarde\/raw_input\/.*\.pdf$/.test(f)));   // de oude bijlage staat er nog
  assert.equal((await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: versie(E, id) }, 'app:x')).j.uitkomst, 'al_zo');
  await E.r.uitvoerRonde();
  const na = E.bestanden();
  assert.ok(na.every((f) => f.startsWith('10_Zakelijk/Groenhouten/raw_input/')), na.join());
  assert.equal(E.db.prepare("SELECT count(*) n FROM uitvoering WHERE stuk_id = ? AND uitkomst IN ('verhuis_open','weg_open','wacht_op_nieuw')").get(id).n, 0);
  E.r.sluit();
});

test('review ronde 2: rechtzet-notitie die mislukte komt de volgende ronde alsnog; nieuwe Verplaats wacht tot de vorige klaar is; claim na een crash wordt hersteld', async () => {
  let weiger = 1;
  const E = omgeving({ naamOk: function (nm) { if (/_rechtzetten_/.test(nm) && weiger > 0) { weiger--; return false; } return !/[\\/:*?"<>|]/.test(nm); } });
  const id = stukMetBijlage(E, 'Rechtzet later');
  await E.r.ronde();
  fs.writeFileSync(path.join(E.vault, '10_Zakelijk/Tolgaarde/Bronnen/_register.md'), '| x | (ovis_stuk ' + id + ') |\n');
  const k = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'geen', versie: versie(E, id) }, 'app:x');
  assert.equal(k.status, 200); assert.equal(k.j.verplaatst.na_nacht, true); assert.equal(k.j.verplaatst.rechtzetten, false);
  assert.ok(!E.bestanden().some((f) => /_rechtzetten_/.test(f)));
  // zolang de notitie ontbreekt: geen nieuwe Verplaats (hij probeert het eerst zelf; de naam wordt hier nog één keer geweigerd)
  weiger = 1;
  const k2 = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: versie(E, id) }, 'app:x');
  assert.equal(k2.status, 409); assert.equal(k2.j.code, 'verplaats_bezig');
  await E.r.uitvoerRonde();
  assert.equal(E.bestanden().filter((f) => /^10_Zakelijk\/Tolgaarde\/raw_input\/.*_rechtzetten_/.test(f)).length, 1);
  await E.r.uitvoerRonde();
  assert.equal(E.bestanden().filter((f) => /_rechtzetten_/.test(f)).length, 1);   // één keer
  // crash na het schrijven, vóór de administratie: nog eens schrijven geeft dezelfde naam en inhoud ('gelijk'), geen tweede notitie
  E.db.prepare("DELETE FROM correctie WHERE stuk_id = ? AND json_extract(wat, '$.keuze') = 'rechtzet_geschreven'").run(id);
  await E.r.uitvoerRonde();
  assert.equal(E.bestanden().filter((f) => /_rechtzetten_/.test(f)).length, 1);
  // claim na een crash: het bestand staat verborgen; de volgende poging zet hem terug en maakt het af
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2618-claim-'));
  fs.writeFileSync(path.join(b, '.x.pdf.0123456789abcdef.ovis-claim'), 'inhoud');
  assert.equal(VV.wegAlsGelijk(path.join(b, 'x.pdf'), sha(Buffer.from('inhoud'))), true);
  assert.deepEqual(fs.readdirSync(b), []);
  fs.writeFileSync(path.join(b, '.y.pdf.0123456789abcdef.ovis-claim'), 'iets anders');
  assert.equal(VV.wegAlsGelijk(path.join(b, 'y.pdf'), sha(Buffer.from('inhoud'))), false);
  assert.deepEqual(fs.readdirSync(b), ['y.pdf']);   // teruggezet onder de eigen naam, niets gewist
  E.r.sluit();
});

test('review ronde 3: crash na het verhuizen (bestand al op de nieuwe plek, administratie nog open) → bij de volgende ronde "verplaatst" en de nieuwe plek geboekt; Toch bewaren heft de 90 dagen op', async () => {
  let stuk = 2;
  const vv = Object.assign({}, VV, { verplaats: function () { if (stuk > 0) { stuk--; const e = new Error('nep'); e.code = 'EIO'; throw e; } return VV.verplaats.apply(null, arguments); } });
  const E = omgeving({ vv, lenzenLive: function () { return ['kennis', 'geen', 'facturen', 'systeem']; } });
  const id = stukMetBijlage(E, 'Crash');
  await E.r.ronde();
  // blob weg (90 dagen voorbij): het nieuwe .md kan de bijlage niet uit Intake schrijven
  const bijOud = E.bestanden().find((f) => /\.pdf$/.test(f));
  const k = await E.r.appKeuze({ stuk_id: id, keuze: 'bestemming', lens: 'kennis', entiteit: 'GH', versie: versie(E, id) }, 'app:x');
  assert.equal(k.status, 200); assert.equal(k.j.verplaatst.open, 1);
  // "crash": het bestand staat al op de nieuwe plek, de rij nog op verhuis_open
  const doel = path.join('10_Zakelijk/Groenhouten/raw_input', path.basename(bijOud));
  if (fs.existsSync(path.join(E.vault, doel))) fs.unlinkSync(path.join(E.vault, bijOud)); else fs.renameSync(path.join(E.vault, bijOud), path.join(E.vault, doel));
  await E.r.uitvoerRonde();
  const r = E.db.prepare("SELECT uitkomst FROM uitvoering WHERE stuk_id = ? AND pad = ?").get(id, bijOud);
  assert.equal(r.uitkomst, 'verplaatst');
  assert.ok(E.db.prepare("SELECT 1 FROM uitvoering WHERE stuk_id = ? AND pad = ? AND uitkomst IN ('nieuw','gelijk')").get(id, doel));
  assert.equal(E.db.prepare("SELECT count(*) n FROM uitvoering WHERE stuk_id = ? AND pad = ? AND uitkomst IN ('nieuw','gelijk')").get(id, doel).n, 1);   // niet dubbel geboekt
  // Toch bewaren
  const gem = E.zet({ marker: 'gemarkeerd', soorten: ['brieftaal'], meta: { van: 'poli@voorbeeld.example', onderwerp: 'Bewaar', aan: ['david@voorbeeld.example'] },
    delen: [{ rol: 'origineel', mime: 'message/rfc822', bytes: mail('poli@voorbeeld.example', 'Bewaar', 'Verzonnen brief over het rooster.') }] });
  await E.r.ronde();
  await E.r.appKeuze({ stuk_id: gem, keuze: 'bewaren' }, 'app:x');
  await E.r.appKeuze({ stuk_id: gem, keuze: 'verwerken' }, 'app:x');
  assert.deepEqual(E.tel.bewaar.filter((x) => x[0] === gem).map((x) => x[1] === null ? null : 'ms'), ['ms', null]);
  E.r.sluit();
});
