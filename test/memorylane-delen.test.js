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
const V = require(path.join(ROOT, 'herinneringen-verhaal.js'));

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

// wv2180: nep-verhaalmodule (zelfde vorm als herinneringen-verhaal.js samengesteld); staat.verhalen[rid] = { titel, alineas, datum_* }
function nepVerhaal(staat) {
  return { samengesteld: (rid, cs) => {
    const v = staat.verhalen[rid];
    if (!v) return { stand: null, versie: null, delen: [], niet_gelukt: [] };
    return { stand: 'klaar', versie: 2, niet_gelukt: [], delen: [{ herinnering_id: 'hr_0000000000000001', titel: V.pasCorrectiesToe(v.titel || '', cs), status: 'concept', eigen: false, t_van: 0,
      datum: v.datum_van || '', datum_precisie: v.datum_precisie || 'onbekend', datum_van: v.datum_van || '', datum_tot: v.datum_tot || '',
      alineas: v.alineas.map((a, i) => ({ tekst: V.pasCorrectiesToe(a, cs), t_van: i * 60, t_tot: i * 60 + 60 })) }] };
  } };
}
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
  const staat = { d1Uit: false, onderhoud: false, kluis: { memorylane_link_familie: 'Kaasschaaf Zeven', memorylane_link_vrienden: null }, d1Log: [], verhalen: {} };
  const d1 = async (sql, params) => {
    if (staat.d1Uit) return { ok: false, rijen: null };
    staat.d1Log.push(sql);
    const st = d1db.prepare(sql);
    return { ok: true, rijen: /^\s*SELECT/i.test(sql) ? st.all(...params) : (st.run(...params), []) };
  };
  const fouten = [];
  const ml = M.maak({ db: ing._db, vault, vv: VV, dir: hdir, d1, kluis: async (n) => staat.kluis[n] || null, marker: P, geheimen: () => [NEP_GEHEIM],
    categorieen: H.CATEGORIEEN, onderhoudAan: () => staat.onderhoud, nachtgrendel: () => false, nu: () => klok.t, fout: (l, e) => fouten.push(l + ': ' + (e && e.message)),
    reisVandaag: () => '2026-10-31', verhaal: nepVerhaal(staat) });
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
    assert.strictEqual(r.categorie, 'reizen'); assert.strictEqual(r.gevoelig, false); assert.strictEqual(r.titel, 'Proefreis Engeland 2023', 'wv2180: vaste naamgeving');
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
    o.staat.verhalen[RA] = { titel: '', alineas: ['Het regende drie dagen op de camping in Proefdorp.', 'Toen de zon terugkwam, fietsten we naar het meer.'] };
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
    const reis = it.find((x) => x.titel === 'Proefstad 2022');
    assert.strictEqual(reis.wanneer, '1–4 mei 2022'); assert.deepStrictEqual(JSON.parse(reis.stukken), []);
    assert.ok(!JSON.stringify(it).includes('Reisbureau') && !JSON.stringify(it).includes('1234'), 'nooit de reispagina zelf');
    const op = it.find((x) => x.titel.startsWith('Opname'));
    const s = JSON.parse(op.stukken);
    // wv2180: het samengestelde verhaal, nooit het transcript (dat staat in de log)
    assert.strictEqual(s.length, 1); assert.strictEqual(s[0].soort, 'verhaal');
    assert.strictEqual(s[0].tekst, 'Het regende drie dagen op de camping in Proefdorp.\n\nToen de zon terugkwam, fietsten we naar het meer.');
    assert.ok(!JSON.stringify(it).includes('Op de camping in Proefdorp regende'), 'transcript nooit buiten');
    assert.strictEqual(o.items('vrienden').length, 0, 'andere kring: niets');
    assert.ok(!JSON.stringify(o.d1db.prepare('SELECT * FROM ml_item').all()).includes(RB.slice(-6)), 'RB niet zichtbaar gezet');
    // later gevoelig → bij de volgende tik weg
    o.ing._db.prepare('UPDATE ramble SET herinnering_gevoelig = 1 WHERE ramble_id = ?').run(RA);
    await o.ml.tik();
    assert.deepStrictEqual(o.items('familie').map((x) => x.titel), ['Proefstad 2022']);
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
    // wv2180: een bijdrage staat in de log (alleen David); een deellink toont alleen de samengestelde herinnering
    for (const k of ['familie', 'vrienden']) assert.ok(!JSON.stringify(o.items(k)).includes('tent'), 'opgenomen bijdrage niet via de link: ' + k);
    assert.strictEqual(o.ml.detail(ha).body.herinnering.log.stukken.find((x) => x.sid === st.sid).status, 'opgenomen', 'wel in de log');
    // Davids eigen correctie (geen "X is Y"): in de log, niet via de link
    assert.strictEqual(o.ml.tekst(ha, { tekst: 'Het was in 1999, niet in 1998.', soort: 'correctie' }).status, 200);
    await o.ml.tik();
    for (const k of ['familie', 'vrienden']) assert.ok(!JSON.stringify(o.items(k)).includes('niet in 1998'), k);
    assert.ok(o.ml.detail(ha).body.herinnering.log.stukken.some((x) => x.tekst === 'Het was in 1999, niet in 1998.'));
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
    // wv2180: bij een reis is Davids eigen aanvulling het verhaal (bij een opname het verhaal uit de opname)
    o.reis('2021 - Proefstad A.md', 'reis', '2021-05-01 – 2021-05-04'); o.reis('2022 - Proefstad B.md', 'reis', '2022-05-01 – 2022-05-04');
    o.ml.lijst();
    const ha = o.hid('reis', '20_Prive/Reizen/2021 - Proefstad A.md'), hb = o.hid('reis', '20_Prive/Reizen/2022 - Proefstad B.md');
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

// ─────────────────────────── wv2180: wanneer, volgorde, titels, log, correctie letterlijk ───────────────────────────

test('wv2180 wanneer: David zet jaar, reeks of dag; zijn invoer wint van reis en verhaal; leeg = terug; ongeldig of toekomst = 400; ook in de deellink', async () => {
  const o = omgeving();
  try {
    o.opname(RA, 'familie', false); o.opname(RB, 'gezin', false); o.opname(RC, 'gezin', false);
    o.staat.verhalen[RB] = { titel: 'Regen in Proefdorp', alineas: ['Het regende.'], datum_van: '1995-01-01', datum_tot: '1995-12-31', datum_precisie: 'jaar' };
    o.reis('2022 - Proefstad.md', 'reis', '2022-05-01 – 2022-05-04');
    o.ml.lijst();
    const ha = o.hid('opname', RA), hb = o.hid('opname', RB), hc = o.hid('opname', RC), hr = o.hid('reis', '20_Prive/Reizen/2022 - Proefstad.md');
    let l = o.ml.lijst().body.herinneringen;
    const k = (h) => l.find((x) => x.hid === h);
    assert.strictEqual(k(hb).wanneer, '1995'); assert.strictEqual(k(hb).wanneer_bron, 'verhaal');
    assert.strictEqual(k(hr).wanneer, '1–4 mei 2022'); assert.strictEqual(k(hr).wanneer_bron, 'reis');
    assert.strictEqual(k(ha).wanneer, 'verteld op 31-10-2026'); assert.strictEqual(k(ha).wanneer_bron, null);
    // volgorde: met datum eerst, nieuwste eerst; zonder datum achteraan
    assert.deepStrictEqual(l.map((x) => x.hid).slice(0, 2), [hr, hb]);
    // David zet een datum
    assert.strictEqual(o.ml.wanneer(ha, { van: '2025-06-11', tot: '2025-06-16' }).status, 200);
    assert.strictEqual(o.ml.wanneer(hr, { van: '2019' }).status, 200, 'ook bij een reis wint David');
    assert.strictEqual(o.ml.wanneer(hc, { van: '1988', tot: '1990' }).status, 200);
    assert.strictEqual(o.ml.wanneer(hb, { van: '1996-07' }).status, 200);
    l = o.ml.lijst().body.herinneringen;
    assert.strictEqual(k(ha).wanneer, '11–16 juni 2025'); assert.strictEqual(k(ha).wanneer_bron, 'david'); assert.deepStrictEqual(k(ha).wanneer_invoer, { van: '2025-06-11', tot: '2025-06-16' });
    assert.strictEqual(k(hr).wanneer, '2019'); assert.strictEqual(k(hc).wanneer, '1988–1990'); assert.strictEqual(k(hb).wanneer, 'juli 1996');
    assert.deepStrictEqual(l.map((x) => x.hid), [ha, hr, hb, hc], 'op tijd, nieuwste eerst');
    const pg = fs.readFileSync(path.join(o.vault, M.MAP, ha + '.md'), 'utf8');
    assert.ok(pg.split('\n').indexOf('wanneer: "2025-06-11/2025-06-16"') >= 0, 'in de frontmatter van de MemoryLane-pagina');
    // ongeldig
    for (const d of [{ van: '95' }, { van: '1995-13' }, { van: '1995-02-30' }, { van: '1995', tot: '1990' }, { van: '2031' }, { van: '1995/1996' }, { van: '2026-12-01' }])
      assert.strictEqual(o.ml.wanneer(hc, d).status, 400, JSON.stringify(d));
    // leeg = weer wat de code afleidt
    assert.strictEqual(o.ml.wanneer(hb, { van: '' }).status, 200);
    l = o.ml.lijst().body.herinneringen;
    assert.strictEqual(k(hb).wanneer, '1995'); assert.ok(fs.readFileSync(path.join(o.vault, M.MAP, hb + '.md'), 'utf8').indexOf('wanneer:') < 0);
    // deellink: alleen lezen, zelfde tekst
    o.ml.zicht(ha, { kring: 'familie', aan: true });
    await o.ml.link('familie', 'aan');
    assert.strictEqual(o.items('familie')[0].wanneer, '11–16 juni 2025');
    // onderhoud: niets schrijven
    o.staat.onderhoud = true;
    assert.strictEqual(o.ml.wanneer(ha, { van: '2001' }).status, 503);
  } finally { o.sluit(); }
});

test('wv2180 log alleen voor David: detail heeft verhaal + log (transcript, correcties, bijdragen); de deellink nooit; correctie "X is Y" letterlijk', async () => {
  const o = omgeving();
  try {
    o.staat.kluis.memorylane_link_vrienden = 'Proefwachtwoord Twee';
    o.opname(RA, 'shizzle', false);
    o.staat.verhalen[RA] = { titel: 'Het potlood uit de Sharky Edwi', alineas: ['Frits pakte een potlood uit zijn Sharky Edwi en prikte in mijn hand.'] };
    o.ml.lijst();
    const ha = o.hid('opname', RA);
    assert.strictEqual(o.ml.tekst(ha, { tekst: 'Edwi is etui', soort: 'correctie' }).status, 200);
    assert.strictEqual(o.ml.tekst(ha, { tekst: 'Het litteken zie je nog steeds.', soort: 'aanvulling' }).status, 200);
    const d = o.ml.detail(ha).body.herinnering;
    assert.strictEqual(d.verhaal.tekst, 'Frits pakte een potlood uit zijn Sharky etui en prikte in mijn hand.', 'correctie letterlijk in het samengestelde verhaal');
    assert.strictEqual(d.titel, 'Het potlood uit de Sharky etui', 'ook in de titel van het verhaal');
    assert.deepStrictEqual(d.log.correcties, [{ van: 'Edwi', naar: 'etui' }]);
    assert.match(d.log.opname, /Op de camping in Proefdorp regende het drie dagen/, 'transcript in de log');
    assert.deepStrictEqual(d.log.stukken.map((s) => s.soort).sort(), ['aanvulling', 'correctie'], 'niets uit de log verdwijnt');
    assert.strictEqual(d.verhaal.delen[0].alineas[0].t_van, 0, 'tijdcodes in de log');
    // voor de verhaalmodule: alleen Davids eigen stukken
    assert.deepStrictEqual(o.ml.davidStukken(RA).sort((a, b) => (a.soort < b.soort ? -1 : 1)), [{ soort: 'aanvulling', tekst: 'Het litteken zie je nog steeds.' }, { soort: 'correctie', tekst: 'Edwi is etui' }]);
    assert.deepStrictEqual(o.ml.davidStukken('r20261031-1111111111111111'), []);
    // een bijdrage van een vriend
    o.ml.zicht(ha, { kring: 'vrienden', aan: true });
    await o.ml.link('vrienden', 'aan');
    const pub = o.items('vrienden')[0].pub, vv = o.d1db.prepare("SELECT versie FROM ml_link WHERE kring = 'vrienden'").get().versie;
    await alsWorker(o.d1db, 'vrienden', vv, { pub, naam: 'Bram Proefsen', titel: null, tekst: 'Ik zat ernaast en zag het gebeuren.', vorm: 'tekst' });
    await o.ml.tik();
    const sid = o.ml.detail(ha).body.herinnering.log.stukken.find((s) => s.wie === 'bezoeker').sid;
    o.ml.stukBesluit(sid, 'opnemen');
    await o.ml.tik();
    const buiten = JSON.stringify(o.items('vrienden'));
    assert.match(buiten, /Sharky etui/);
    for (const w of ['Edwi', 'litteken', 'Ik zat ernaast', 'Bram', 'Op de camping', 'regende']) assert.ok(buiten.indexOf(w) < 0, 'deellink lekt de log: ' + w);
    // toon_opname uit = geen verhaal via de link
    o.ml.toonOpname(ha, { aan: false });
    await o.ml.tik();
    assert.ok(!JSON.stringify(o.items('vrienden')).includes('prikte'), 'alleen de titel blijft');
  } finally { o.sluit(); }
});

test('wv2180 titels: David wint altijd; daarna de vaste naamgeving; een opname daarna de titel van zijn verhaal; oude eigen titel blijft van David', async () => {
  const o = omgeving();
  try {
    o.opname(RA, 'familie', false); o.opname(RB, 'familie', false);
    o.staat.verhalen[RA] = { titel: 'De koeien op het landweggetje', alineas: ['Er werden koeien uit de wei gelaten.'] };
    o.reis('2023 - Proefstedentrip.md', 'reis', '2023-03-01 – 2023-03-03');
    o.ml.lijst();
    const ha = o.hid('opname', RA), hb = o.hid('opname', RB), hr = o.hid('reis', '20_Prive/Reizen/2023 - Proefstedentrip.md');
    const titel = (h) => o.ml.detail(h).body.herinnering.titel;
    assert.strictEqual(titel(ha), 'De koeien op het landweggetje', 'titel van het verhaal i.p.v. "Opname …"');
    assert.match(titel(hb), /^Opname 31-10-2026/, 'nog geen verhaal: standaard');
    assert.strictEqual(o.ml.naamgeving(hr, 'Citytrip Proefstad 2023').ok, true);
    assert.strictEqual(titel(hr), 'Citytrip Proefstad 2023');
    assert.strictEqual(o.ml.titel(hr, { titel: 'Mijn eigen titel' }).status, 200);
    assert.strictEqual(o.ml.naamgeving(hr, 'Citytrip Anders 2023').al, 'david', 'naamgeving overschrijft David niet');
    assert.strictEqual(titel(hr), 'Mijn eigen titel');
    // een oudere pagina zonder titel_bron met een eigen titel (zoals vóór wv2180) = van David
    fs.writeFileSync(path.join(o.vault, M.MAP, hb + '.md'), '---\ntype: herinnering-stukken\ngevoelig: prive\nherinnering_id: ' + hb + '\nsoort: opname\ntitel: "Potloodgate - Proef"\n---\n');
    assert.strictEqual(o.ml.naamgeving(hb, 'Iets anders').al, 'david');
    assert.strictEqual(titel(hb), 'Potloodgate - Proef');
    assert.strictEqual(M.naamVoorReis('20_Prive/Reizen/2025 - Gambia april.md', { van: '2025-04-16' }, ['gambia']), 'Gambia 2025');
    assert.strictEqual(M.naamVoorReis('20_Prive/Reizen/2026 - De Herfst van Shizzle (Keulen & Willingen).md', { van: '2026-10-16' }, ['shizzle']), 'Shizzle: De Herfst van Shizzle - Keulen en Willingen - 2026');
    assert.strictEqual(M.naamVoorReis('20_Prive/Reizen/2022 - Edinburgh.md', { van: '2022-03-11' }, ['stedentrip']), 'Citytrip Edinburgh 2022');
    assert.strictEqual(M.naamVoorReis('20_Prive/Reizen/2025 - Campertrip West-Amerika.md', { van: '2025-07-11' }, ['zomer']), 'Zomervakantie 2025 - Campertrip West-Amerika');
  } finally { o.sluit(); }
});
