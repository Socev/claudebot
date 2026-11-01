'use strict';
// Toetsen van MemoryLane delen (wv2114): register, vault-pagina's, publiceren naar (nep-)D1, versleutelde inbox, wachtwoordhash, poorten.
// Nep-D1 = node:sqlite met dezelfde tabellen als socev-app deel/schema.sql. ALLEEN VERZONNEN TEKST en verzonnen namen.
// Aanroep: bash test/memorylane-delen.sh
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const I = require(path.join(ROOT, 'intake-ingang.js'));
const H = require(path.join(ROOT, 'herinneringen.js'));
const M = require(path.join(ROOT, 'memorylane-delen.js'));
const VV = require(path.join(ROOT, 'vault-veilig.js'));
const P = require(path.join(ROOT, 'intake', 'patientpoort.js'));

// zelfde tabellen als socev-app deel/schema.sql (alleen het MemoryLane-deel)
const D1_SCHEMA = `
CREATE TABLE ml_link (kring TEXT PRIMARY KEY CHECK (kring IN ('familie', 'vrienden')), slug TEXT NOT NULL UNIQUE CHECK (length(slug) = 22), versie INTEGER NOT NULL,
  aan INTEGER NOT NULL DEFAULT 0, ww_zout TEXT, ww_hash TEXT, ww_iter INTEGER);
CREATE TABLE ml_item (kring TEXT NOT NULL, versie INTEGER NOT NULL, pub TEXT NOT NULL CHECK (length(pub) = 16), volgorde INTEGER NOT NULL, titel TEXT NOT NULL,
  wanneer TEXT NOT NULL, stukken TEXT NOT NULL, PRIMARY KEY (kring, pub));
CREATE TABLE ml_sleutel (id TEXT PRIMARY KEY, spki TEXT NOT NULL);
CREATE TABLE ml_sessie (token TEXT PRIMARY KEY, kring TEXT NOT NULL, versie INTEGER NOT NULL, csrf TEXT NOT NULL, tot INTEGER NOT NULL);
CREATE TABLE ml_poging (sleutel TEXT PRIMARY KEY, venster INTEGER NOT NULL, n INTEGER NOT NULL);
CREATE TABLE ml_bijdrage (id TEXT PRIMARY KEY CHECK (length(id) = 22), kring TEXT NOT NULL, versie INTEGER NOT NULL, sleutel_id TEXT NOT NULL, sleutel TEXT NOT NULL,
  iv TEXT NOT NULL, inhoud TEXT NOT NULL, op TEXT NOT NULL);`;

const VERHAAL = '[00:00] Op de camping in Proefdorp regende het drie dagen.\n\n[01:00] (stilte)\n\n[02:00] Toen de zon terugkwam, fietsten we naar het meer.\n';
const WERK = 'Betreft: mw. P. Proefpersoon, geb. 03-04-1961. Bovengenoemde patiënt is bekend met hypertensie; diagnose ijzergebreksanemie, medicatie ferrofumaraat 200 mg, labuitslag Hb 6,4 mmol/l.';
const NEP_GEHEIM = 'nepgeheim-0123456789abcdef';

function omgeving() {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-delen-toets-'));
  const idir = path.join(basis, 'intake'), vault = path.join(basis, 'vault'), hdir = path.join(basis, 'herinneringen');
  for (const m of [idir, vault, path.join(vault, '20_Prive/Reizen'), path.join(vault, H.NOTITIE_MAP)]) fs.mkdirSync(m, { recursive: true });
  const klok = { t: Date.parse('2026-10-31T19:00:00Z') };
  const ing = I.maak({ dir: idir, vault, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'),
    primair: () => true, vv: VV, nu: () => klok.t, fout: () => {}, marker: P, nachtgrendel: () => false, vrijeBytes: () => 50 * 1024 ** 3, stuur: () => {} });
  H.maak({ dir: hdir, intake: ing, vault, vv: VV, nu: () => klok.t, fout: () => {}, whisper: async () => '', kanUitschrijven: () => false,
    onderhoudAan: () => false, nachtgrendel: () => false, primair: () => true, kaartZet: async () => ({}), kaartLijst: async () => ({}), box: () => {}, offsiteAan: () => false });
  const d1db = new DatabaseSync(':memory:');
  d1db.exec(D1_SCHEMA);
  const staat = { d1Uit: false, onderhoud: false, kluis: { memorylane_link_familie: 'Kaasschaaf Zeven', memorylane_link_vrienden: null }, d1Log: [] };
  const d1 = async (sql, params) => {
    if (staat.d1Uit) return { ok: false, rijen: null };
    staat.d1Log.push(sql);
    const st = d1db.prepare(sql);
    return { ok: true, rijen: /^\s*SELECT/i.test(sql) ? st.all(...params) : (st.run(...params), []) };
  };
  const fouten = [];
  const ml = M.maak({ db: ing._db, vault, vv: VV, dir: hdir, d1, kluis: async (n) => staat.kluis[n] || null, marker: P, geheimen: () => [NEP_GEHEIM],
    categorieen: H.CATEGORIEEN, onderhoudAan: () => staat.onderhoud, nachtgrendel: () => false, nu: () => klok.t, fout: (l, e) => fouten.push(l + ': ' + (e && e.message)),
    reisVandaag: () => '2026-10-31' });
  // een opname met notitie zoals herinneringen.js hem achterlaat (verzonnen)
  function opname(id, cat, gevoelig) {
    const rel = path.join(H.NOTITIE_MAP, '2026-10-31_' + id.slice(-6) + '.md');
    fs.writeFileSync(path.join(vault, rel), '---\ntype: bron\nbron_soort: ramble\ngevoelig: prive\n---\n> **Privé — persoonlijke herinnering.** Ingesproken.\n\n# Opname 31-10-2026 10:37\n\n' + VERHAAL);
    ing._db.prepare("INSERT INTO ramble (ramble_id, dag, aangemaakt, laatst, status, opgenomen_op, notitie, categorie, herinnering_gevoelig, proef) VALUES (?, '2026-10-31', ?, ?, 'notitie', ?, ?, ?, ?, 0)")
      .run(id, '2026-10-31T09:37:00Z', '2026-10-31T09:37:00Z', '2026-10-31T09:37:00Z', rel, cat, gevoelig ? 1 : 0);
  }
  function reis(naam, type, periode) {
    fs.writeFileSync(path.join(vault, '20_Prive/Reizen', naam), '---\ntype: ' + type + '\nonderwerp: "' + naam.replace(/\.md$/, '') + '"\nperiode: "' + periode + '"\n---\n\n# Reis\n\nGeboekt bij Reisbureau Verzonnen voor 1234 euro, hotel Nergenshuis.\n');
  }
  return { basis, vault, hdir, ing, ml, d1db, staat, klok, fouten, opname, reis,
    hid: (soort, ref) => ing._db.prepare('SELECT hid FROM ml_herinnering WHERE soort = ? AND ref = ?').get(soort, ref).hid,
    items: (k) => d1db.prepare('SELECT * FROM ml_item WHERE kring = ? ORDER BY volgorde').all(k),
    sluit: () => { ing.sluit(); fs.rmSync(basis, { recursive: true, force: true }); } };
}
// Versleutel zoals de worker (WebCrypto): AES-256-GCM, sleutel ingepakt met RSA-OAEP SHA-256, AAD id|kring|versie
async function alsWorker(d1db, kring, versie, obj) {
  const r = d1db.prepare('SELECT id, spki FROM ml_sleutel').get();
  const pub = await crypto.webcrypto.subtle.importKey('spki', Buffer.from(r.spki, 'base64'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await crypto.webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const id = crypto.randomBytes(16).toString('base64url').slice(0, 22), iv = crypto.randomBytes(12);
  const ct = Buffer.from(await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(id + '|' + kring + '|' + versie) }, aes, Buffer.from(JSON.stringify(obj))));
  const raw = Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', aes));
  const ing = Buffer.from(await crypto.webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw));
  d1db.prepare('INSERT INTO ml_bijdrage (id, kring, versie, sleutel_id, sleutel, iv, inhoud, op) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kring, versie, r.id, ing.toString('base64'), iv.toString('base64'), ct.toString('base64'), '2026-10-31T19:05:00Z');
  return id;
}
const RA = 'r20261031-0123456789abcdef', RB = 'r20261031-fedcba9876543210', RC = 'r20261031-00000000000000aa';

test('herinneringen: opnames met notitie en voorbije reizen; geplande reis en themapagina niet', async () => {
  const o = omgeving();
  try {
    o.opname(RA, 'shizzle', false);
    o.reis('2023 - Proefreis Engeland.md', 'reis', '2023-06-29 – 2023-07-02');
    o.reis('2027 - Geplande Proefreis.md', 'reis', '2027-02-22 – 2027-02-26');
    o.reis('Proefthema.md', 'themapagina', '');
    const l = o.ml.lijst().body;
    assert.deepStrictEqual(l.herinneringen.map((h) => h.soort).sort(), ['opname', 'reis']);
    const r = l.herinneringen.find((h) => h.soort === 'reis');
    assert.strictEqual(r.categorie, 'reizen'); assert.strictEqual(r.gevoelig, false); assert.strictEqual(r.titel, '2023 - Proefreis Engeland');
    assert.strictEqual(r.zicht.familie, false); assert.strictEqual(r.zicht.vrienden, false, 'standaard nergens zichtbaar');
    assert.ok(l.categorieen.some((c) => c.id === 'reizen'), 'categorie Reizen in de vaste lijst');
  } finally { o.sluit(); }
});

test('wv2136 (Tripper): reisKoppeling geeft hid en aantal opgenomen stukken; geplande reis en onbekend pad = null; maakt zelf niets', async () => {
  const o = omgeving();
  try {
    o.reis('2023 - Proefreis Engeland.md', 'reis', '2023-06-29 – 2023-07-02');
    o.reis('2027 - Geplande Proefreis.md', 'reis', '2027-02-22 – 2027-02-26');
    const rel = '20_Prive/Reizen/2023 - Proefreis Engeland.md';
    assert.strictEqual(o.ml.reisKoppeling(rel), null, 'vóór bijwerken bestaat de herinnering nog niet; de koppeling maakt hem niet aan');
    o.ml.lijst();
    const hid = o.hid('reis', rel);
    assert.deepStrictEqual(o.ml.reisKoppeling(rel), { hid, stukken: 0, album: null });
    assert.strictEqual(o.ml.tekst(hid, { tekst: 'Het regende de hele week.' }).status, 200);
    assert.strictEqual(o.ml.reisKoppeling(rel).stukken, 1);
    assert.strictEqual(o.ml.reisKoppeling('20_Prive/Reizen/2027 - Geplande Proefreis.md'), null);
    assert.strictEqual(o.ml.reisKoppeling('../buiten.md'), null);
  } finally { o.sluit(); }
});

test('zichtbaar maken: zonder categorie, Privé of het vinkje gevoelig = 409; Shizzle en reis = 200', async () => {
  const o = omgeving();
  try {
    o.opname(RA, null, false); o.opname(RB, 'prive', true); o.opname(RC, 'gezin', true);
    o.reis('2022 - Proefstad.md', 'reis', '2022-05-01 – 2022-05-04');
    o.ml.lijst();
    for (const id of [RA, RB, RC]) {
      const u = o.ml.zicht(o.hid('opname', id), { kring: 'familie', aan: true });
      assert.strictEqual(u.status, 409, id);
    }
    o.ing._db.prepare("UPDATE ramble SET categorie = 'shizzle', herinnering_gevoelig = 0 WHERE ramble_id = ?").run(RA);
    assert.strictEqual(o.ml.zicht(o.hid('opname', RA), { kring: 'vrienden', aan: true }).status, 200);
    assert.strictEqual(o.ml.zicht(o.hid('reis', '20_Prive/Reizen/2022 - Proefstad.md'), { kring: 'familie', aan: true }).status, 200);
    assert.strictEqual(o.ml.zicht(o.hid('opname', RA), { kring: 'buren', aan: true }).status, 400);
  } finally { o.sluit(); }
});

test('publiceren: link uit = niets buiten; aan + wachtwoord = alleen wat zichtbaar is; reis zonder pagina-inhoud; opname zonder tijdcodes', async () => {
  const o = omgeving();
  try {
    o.opname(RA, 'familie', false); o.opname(RB, 'gezin', false);
    o.reis('2022 - Proefstad.md', 'reis', '2022-05-01 – 2022-05-04');
    o.ml.lijst();
    const ha = o.hid('opname', RA), hr = o.hid('reis', '20_Prive/Reizen/2022 - Proefstad.md');
    o.ml.zicht(ha, { kring: 'familie', aan: true }); o.ml.zicht(hr, { kring: 'familie', aan: true });
    await o.ml.tik();
    assert.strictEqual(o.items('familie').length, 0, 'link nog uit: niets in D1');
    const st = o.ml.delenStand().body;
    assert.match(st.links[0].url, /^https:\/\/deel\.socev\.dev\/h\/[A-Za-z0-9_-]{22}$/);
    assert.strictEqual(st.links[0].aan, false);
    const u = await o.ml.link('familie', 'aan');
    assert.strictEqual(u.status, 200);
    const L = o.d1db.prepare("SELECT * FROM ml_link WHERE kring = 'familie'").get();
    assert.strictEqual(L.aan, 1); assert.strictEqual(L.ww_iter, 100000);
    const verwacht = crypto.pbkdf2Sync(Buffer.from('kaasschaaf zeven'), Buffer.from(L.ww_zout, 'base64'), 100000, 32, 'sha256').toString('base64');
    assert.strictEqual(L.ww_hash, verwacht, 'PBKDF2 over het genormaliseerde wachtwoord (kleine letters, trim)');
    assert.ok(!JSON.stringify(o.d1db.prepare('SELECT * FROM ml_link').all()).includes('Kaasschaaf'), 'nooit het wachtwoord zelf');
    const it = o.items('familie');
    assert.strictEqual(it.length, 2, 'alleen de twee zichtbare');
    const reis = it.find((x) => x.titel === '2022 - Proefstad');
    assert.strictEqual(reis.wanneer, '2022-05-01 – 2022-05-04'); assert.deepStrictEqual(JSON.parse(reis.stukken), []);
    assert.ok(!JSON.stringify(it).includes('Reisbureau') && !JSON.stringify(it).includes('1234'), 'nooit de reispagina zelf');
    const op = it.find((x) => x.titel.startsWith('Opname'));
    const s = JSON.parse(op.stukken);
    assert.strictEqual(s[0].soort, 'opname');
    assert.strictEqual(s[0].tekst, 'Op de camping in Proefdorp regende het drie dagen.\n\nToen de zon terugkwam, fietsten we naar het meer.');
    assert.strictEqual(o.items('vrienden').length, 0, 'andere kring: niets');
    assert.ok(!JSON.stringify(o.d1db.prepare('SELECT * FROM ml_item').all()).includes(RB.slice(-6)), 'RB niet zichtbaar gezet');
    // later gevoelig → bij de volgende tik weg
    o.ing._db.prepare('UPDATE ramble SET herinnering_gevoelig = 1 WHERE ramble_id = ?').run(RA);
    await o.ml.tik();
    assert.deepStrictEqual(o.items('familie').map((x) => x.titel), ['2022 - Proefstad']);
    // toon_opname uit → opname zonder letterlijke tekst
    o.ing._db.prepare('UPDATE ramble SET herinnering_gevoelig = 0 WHERE ramble_id = ?').run(RA);
    o.ml.toonOpname(ha, { aan: false });
    await o.ml.tik();
    assert.ok(!JSON.stringify(o.items('familie')).includes('camping'));
    // link uit → alles weg
    await o.ml.link('familie', 'uit');
    assert.strictEqual(o.items('familie').length, 0);
    assert.strictEqual(o.d1db.prepare("SELECT aan FROM ml_link WHERE kring = 'familie'").get().aan, 0);
  } finally { o.sluit(); }
});

test('bijdrage: versleuteld in D1, ook opgehaald als de link uit staat; eerst binnen, pas na opnemen zichtbaar, alleen voor de eigen kring', async () => {
  const o = omgeving();
  try {
    o.staat.kluis.memorylane_link_vrienden = 'Proefwachtwoord Twee';
    o.opname(RA, 'shizzle', false);
    o.ml.lijst();
    const ha = o.hid('opname', RA);
    o.ml.zicht(ha, { kring: 'familie', aan: true }); o.ml.zicht(ha, { kring: 'vrienden', aan: true });
    await o.ml.link('familie', 'aan'); await o.ml.link('vrienden', 'aan');
    const pubV = o.items('vrienden')[0].pub;
    const vv = o.d1db.prepare("SELECT versie FROM ml_link WHERE kring = 'vrienden'").get().versie;
    await alsWorker(o.d1db, 'vrienden', vv, { pub: pubV, naam: 'Bram Proefsen', titel: null, tekst: 'Ik weet nog dat de tent bijna wegwaaide.', vorm: 'spraak' });
    assert.ok(!JSON.stringify(o.d1db.prepare('SELECT * FROM ml_bijdrage').all()).includes('tent'), 'geen leesbare tekst in D1');
    await o.ml.link('vrienden', 'uit');   // MOET 2: eerst ophalen, dan pas dicht
    assert.strictEqual(o.d1db.prepare('SELECT count(*) n FROM ml_bijdrage').get().n, 0);
    const d = o.ml.detail(ha).body.herinnering;
    const st = d.stukken_lijst.find((s) => s.wie === 'bezoeker');
    assert.strictEqual(st.status, 'binnen'); assert.strictEqual(st.naam, 'Bram Proefsen'); assert.strictEqual(st.vorm, 'spraak'); assert.strictEqual(st.kring, 'vrienden');
    assert.strictEqual(st.tekst, 'Ik weet nog dat de tent bijna wegwaaide.');
    const pagina = fs.readFileSync(path.join(o.vault, M.MAP, ha + '.md'), 'utf8');
    assert.match(pagina, /gevoelig: prive/); assert.match(pagina, /· Bram Proefsen \(vrienden\) · aanvulling · ingesproken/); assert.match(pagina, /^> Ik weet nog/m);
    await o.ml.link('vrienden', 'aan');
    assert.ok(!JSON.stringify(o.items('vrienden')).includes('tent'), 'binnen = nog niet zichtbaar');
    assert.strictEqual(o.ml.stukBesluit(st.sid, 'opnemen').status, 200);
    await o.ml.tik();
    assert.ok(JSON.stringify(o.items('vrienden')).includes('tent'), 'opgenomen = zichtbaar voor vrienden');
    assert.ok(!JSON.stringify(o.items('familie')).includes('tent'), 'niet voor familie');
    // Davids eigen tekst: meteen opgenomen, voor beide kringen
    assert.strictEqual(o.ml.tekst(ha, { tekst: 'Het was in 1999, niet in 1998.', soort: 'correctie' }).status, 200);
    await o.ml.tik();
    for (const k of ['familie', 'vrienden']) assert.ok(JSON.stringify(o.items(k)).includes('niet in 1998'), k);
    // geen tekst, titels of namen in intake.sqlite
    const dump = JSON.stringify(['ml_herinnering', 'ml_stuk', 'ml_link', 'ml_pub', 'ml_d1', 'ml_blok'].map((t) => o.ing._db.prepare('SELECT * FROM ' + t).all()));
    for (const w of ['tent', 'Bram', '1998', 'camping', 'Proefwachtwoord']) assert.ok(!dump.includes(w), w);
  } finally { o.sluit(); }
});

test('losse bijdrage → voorstel, nergens zichtbaar; marker raak → vastgehouden buiten de vault; geheim → alleen weggooien', async () => {
  const o = omgeving();
  try {
    await o.ml.link('familie', 'aan');
    const v = o.d1db.prepare("SELECT versie FROM ml_link WHERE kring = 'familie'").get().versie;
    await alsWorker(o.d1db, 'familie', v, { pub: null, naam: 'Kees Verzonnen', titel: 'De verhuizing', tekst: 'We droegen de piano met zes man de trap op.', vorm: 'tekst' });
    await alsWorker(o.d1db, 'familie', v, { pub: null, naam: 'Kees Verzonnen', titel: 'Werk', tekst: WERK, vorm: 'tekst' });
    await alsWorker(o.d1db, 'familie', v, { pub: null, naam: 'Kees Verzonnen', titel: 'Sleutel', tekst: 'mijn code is ' + NEP_GEHEIM, vorm: 'tekst' });
    await o.ml.tik();
    const l = o.ml.lijst().body.herinneringen.filter((h) => h.soort === 'los');
    assert.strictEqual(l.length, 3);
    for (const h of l) { assert.strictEqual(h.status, 'voorstel'); assert.strictEqual(h.niet_deelbaar, 'eerst opnemen'); }
    const alle = l.map((h) => o.ml.detail(h.hid).body.herinnering);
    const piano = alle.find((h) => h.titel === 'De verhuizing'), werk = alle.find((h) => h.stukken_lijst[0].marker === 'raak'), geheim = alle.find((h) => h.stukken_lijst[0].marker === 'geheim');
    assert.ok(piano && werk && geheim);
    assert.strictEqual(werk.stukken_lijst[0].status, 'vastgehouden'); assert.strictEqual(geheim.stukken_lijst[0].status, 'vastgehouden');
    assert.ok(!fs.existsSync(path.join(o.vault, M.MAP, werk.hid + '.md')), 'markertreffer niet in de vault');
    const wf = path.join(o.hdir, 'ml-wacht', werk.stukken_lijst[0].sid + '.json');
    assert.strictEqual(fs.statSync(wf).mode & 0o777, 0o600);
    assert.strictEqual(werk.stukken_lijst[0].tekst, WERK, 'David ziet de tekst wel');
    assert.strictEqual(o.ml.stukBesluit(geheim.stukken_lijst[0].sid, 'bewaren').status, 409, 'geheim: nooit naar de vault');
    assert.strictEqual(o.ml.stukBesluit(geheim.stukken_lijst[0].sid, 'weggooien').status, 200);
    assert.strictEqual(o.ml.stukBesluit(werk.stukken_lijst[0].sid, 'bewaren').status, 200);
    assert.ok(fs.existsSync(path.join(o.vault, M.MAP, werk.hid + '.md')) && !fs.existsSync(wf), 'na bewaren in de vault, wachtrij leeg');
    // piano opnemen → actief, maar zonder categorie nog niet deelbaar
    assert.strictEqual(o.ml.stukBesluit(piano.stukken_lijst[0].sid, 'opnemen').status, 200);
    let h = o.ml.detail(piano.hid).body.herinnering;
    assert.strictEqual(h.status, 'actief'); assert.strictEqual(o.ml.zicht(piano.hid, { kring: 'familie', aan: true }).status, 409);
    assert.strictEqual(o.ml.categorie(piano.hid, { categorie: 'familie' }).status, 200);
    assert.strictEqual(o.ml.zicht(piano.hid, { kring: 'familie', aan: true }).status, 200);
    await o.ml.tik();
    assert.ok(JSON.stringify(o.items('familie')).includes('piano'));
    // categorie Privé → meteen niet meer zichtbaar
    o.ml.categorie(piano.hid, { categorie: 'prive' });
    await o.ml.tik();
    assert.strictEqual(o.items('familie').length, 0);
  } finally { o.sluit(); }
});

test('poorten bij delen: geheim in Davids tekst = nooit; marker = pas na "toch delen" voor precies die inhoud', async () => {
  const o = omgeving();
  try {
    o.opname(RA, 'overig', false); o.opname(RB, 'overig', false);
    o.ml.lijst();
    const ha = o.hid('opname', RA), hb = o.hid('opname', RB);
    o.ml.zicht(ha, { kring: 'familie', aan: true }); o.ml.zicht(hb, { kring: 'familie', aan: true });
    await o.ml.link('familie', 'aan');
    assert.strictEqual(o.items('familie').length, 2);
    o.ml.tekst(ha, { tekst: 'notitie: ' + NEP_GEHEIM }); o.ml.tekst(hb, { tekst: WERK });
    await o.ml.tik();
    assert.strictEqual(o.items('familie').length, 0, 'beide tegengehouden');
    const l = o.ml.lijst().body.herinneringen;
    assert.strictEqual(l.find((h) => h.hid === ha).blok, 'geheim'); assert.strictEqual(l.find((h) => h.hid === hb).blok, 'marker');
    assert.strictEqual(o.ml.tochDelen(ha).status, 409);
    assert.strictEqual(o.ml.tochDelen(hb).status, 200);
    await o.ml.tik();
    assert.strictEqual(o.items('familie').length, 1);
    o.ml.tekst(hb, { tekst: 'Nog een zin erbij.' });
    await o.ml.tik();
    assert.strictEqual(o.items('familie').length, 0, 'andere inhoud = opnieuw tegengehouden');
  } finally { o.sluit(); }
});

test('wachtwoord: wissel = nieuwe hash en sessies weg; kluis leeg = link dicht; vernieuwen = nieuwe slug, versie en pubs', async () => {
  const o = omgeving();
  try {
    o.opname(RA, 'gezin', false);
    o.ml.lijst();
    const ha = o.hid('opname', RA);
    o.ml.zicht(ha, { kring: 'familie', aan: true });
    await o.ml.link('familie', 'aan');
    const L1 = o.d1db.prepare("SELECT * FROM ml_link WHERE kring = 'familie'").get();
    const pub1 = o.items('familie')[0].pub;
    o.d1db.prepare("INSERT INTO ml_sessie VALUES ('t1', 'familie', ?, 'c', 9e15)").run(L1.versie);
    o.staat.kluis.memorylane_link_familie = 'Een Ander Wachtwoord';
    o.klok.t += 11 * 60000;
    await o.ml.tik();
    const L2 = o.d1db.prepare("SELECT * FROM ml_link WHERE kring = 'familie'").get();
    assert.notStrictEqual(L2.ww_hash, L1.ww_hash); assert.notStrictEqual(L2.ww_zout, L1.ww_zout);
    assert.strictEqual(o.d1db.prepare('SELECT count(*) n FROM ml_sessie').get().n, 0, 'sessies weg');
    o.staat.kluis.memorylane_link_familie = null;
    o.klok.t += 11 * 60000;
    await o.ml.tik();
    const L3 = o.d1db.prepare("SELECT * FROM ml_link WHERE kring = 'familie'").get();
    assert.strictEqual(L3.ww_hash, null); assert.strictEqual(L3.aan, 0);
    assert.strictEqual(o.items('familie').length, 0, 'zonder wachtwoord niets buiten');
    assert.strictEqual(o.ml.delenStand().body.links[0].wachtwoord, 'ontbreekt');
    o.staat.kluis.memorylane_link_familie = 'Kaasschaaf Zeven';
    const r = await o.ml.link('familie', 'vernieuw');
    assert.strictEqual(r.status, 200);
    const L4 = o.d1db.prepare("SELECT * FROM ml_link WHERE kring = 'familie'").get();
    assert.notStrictEqual(L4.slug, L1.slug); assert.strictEqual(L4.versie, L1.versie + 1); assert.ok(L4.ww_hash);
    const it = o.items('familie');
    assert.strictEqual(it.length, 1); assert.notStrictEqual(it[0].pub, pub1); assert.strictEqual(it[0].versie, L4.versie);
  } finally { o.sluit(); }
});

test('controle elke 10 min wist vreemde rijen; D1 onbereikbaar = geen fout naar buiten; onderhoud = wachtrij, daarna de vault', async () => {
  const o = omgeving();
  try {
    o.opname(RA, 'gezin', false);
    o.ml.lijst();
    await o.ml.link('familie', 'aan');
    o.d1db.prepare("INSERT INTO ml_item VALUES ('familie', 1, 'vreemdvreemd0000', 0, 'x', '', '[]')").run();
    o.klok.t += 11 * 60000;
    await o.ml.tik();
    assert.strictEqual(o.items('familie').length, 0, 'niet zichtbaar gezet en vreemd = weg');
    o.staat.d1Uit = true;
    const u = await o.ml.tik();
    assert.strictEqual(u.fout, 'd1');
    o.staat.d1Uit = false;
    o.staat.onderhoud = true;
    const ha = o.hid('opname', RA);
    const t = o.ml.tekst(ha, { tekst: 'Een zin tijdens onderhoud.' });
    assert.strictEqual(t.body.vault, false);
    assert.strictEqual(o.ml.detail(ha).body.herinnering.stukken_lijst[0].tekst, 'Een zin tijdens onderhoud.', 'uit de wachtrij');
    o.staat.onderhoud = false;
    await o.ml.tik();
    assert.match(fs.readFileSync(path.join(o.vault, M.MAP, ha + '.md'), 'utf8'), /Een zin tijdens onderhoud\./);
    assert.strictEqual(fs.readdirSync(path.join(o.hdir, 'ml-wacht')).length, 0);
    assert.strictEqual(o.ml.titel(ha, { titel: 'De regenvakantie' }).status, 200);
    assert.strictEqual(o.ml.detail(ha).body.herinnering.titel, 'De regenvakantie');
    assert.strictEqual(o.ml.detail(ha).body.herinnering.stukken_lijst[0].tekst, 'Een zin tijdens onderhoud.', 'blok blijft na titelwijziging');
    assert.deepStrictEqual(o.fouten, []);
  } finally { o.sluit(); }
});

test('schoon: geen blokmerkteken, stuurtekens of te lange tekst', () => {
  assert.strictEqual(M._schoon('a<!-- ml:stuk s0 -->b', 100, true).includes('<!--'), false);
  assert.strictEqual(M._schoon('x'.repeat(5001), 5000, true), null);
  assert.strictEqual(M._schoon('regel\u0007een\ntwee', 100, true), 'regel een\ntwee');
  assert.strictEqual(M._wwNorm('  KaasSchaaf  '), 'kaasschaaf');
});

test('review MOET 4: D1 weg bij "uit" = 502 en buiten nog oud; de volgende tik zet het recht', async () => {
  const o = omgeving();
  try {
    o.opname(RA, 'gezin', false);
    o.ml.lijst();
    o.ml.zicht(o.hid('opname', RA), { kring: 'familie', aan: true });
    await o.ml.link('familie', 'aan');
    assert.strictEqual(o.items('familie').length, 1);
    o.staat.d1Uit = true;
    const u = await o.ml.link('familie', 'uit');
    assert.strictEqual(u.status, 502);
    assert.strictEqual(u.body.stand.links[0].buiten_bijgewerkt, false);
    assert.strictEqual(o.d1db.prepare("SELECT aan FROM ml_link WHERE kring = 'familie'").get().aan, 1, 'buiten nog de oude stand');
    o.staat.d1Uit = false;
    await o.ml.tik();
    assert.strictEqual(o.d1db.prepare("SELECT aan FROM ml_link WHERE kring = 'familie'").get().aan, 0);
    assert.strictEqual(o.items('familie').length, 0);
    assert.strictEqual(o.ml.delenStand().body.links[0].buiten_bijgewerkt, true);
  } finally { o.sluit(); }
});
