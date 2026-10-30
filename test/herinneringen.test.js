'use strict';
// Toetsen van MemoryLane R1 (wv1969): opvang in stukken, manifest, archief, uitschrijven, Intake ramble@1, marker, opnamenotitie, offsite.
// Wegwerpmappen, nep-Whisper, nep-rclone; ALLEEN VERZONNEN TEKST (nooit een echte herinnering). Aanroep: bash test/herinneringen.sh
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const I = require(path.join(ROOT, 'intake-ingang.js'));
const H = require(path.join(ROOT, 'herinneringen.js'));
const VV = require(path.join(ROOT, 'vault-veilig.js'));
const P = require(path.join(ROOT, 'intake', 'patientpoort.js'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Verzonnen vertelling en verzonnen werktekst (marker): geen echte personen.
const VERHAAL = ['Op de camping in Proefdorp regende het drie dagen achter elkaar.', 'We speelden kaartspelletjes in de voortent tot iedereen won.', 'Toen de zon terugkwam, fietsten we naar het meer.'];
const WERK = 'Betreft: mw. P. Proefpersoon, geb. 03-04-1961. Bovengenoemde patiënt is bekend met hypertensie; diagnose ijzergebreksanemie, medicatie ferrofumaraat 200 mg, labuitslag Hb 6,4 mmol/l.';

function wav(sec, zaad) {
  const n = Math.round(sec * 16000) * 2;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'ascii'); b.writeUInt32LE(n, 40);
  crypto.createHash('sha256').update(String(zaad)).digest().copy(b, 44);
  return b;
}

function omgeving(opt) {
  opt = opt || {};
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'herinneringen-toets-'));
  const idir = path.join(basis, 'intake'), vault = path.join(basis, 'vault'), hdir = path.join(basis, 'herinneringen'), remote = path.join(basis, 'remote');
  for (const m of [idir, vault, remote]) fs.mkdirSync(m, { recursive: true });
  const klok = { t: Date.parse('2026-10-30T09:00:00Z') };
  const ing = I.maak({ dir: idir, vault, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'),
    primair: () => true, vv: VV, nu: () => klok.t, fout: () => {}, marker: P, nachtgrendel: () => false, vrijeBytes: () => 50 * 1024 ** 3,
    stuur: () => {} });
  const tekstVoor = new Map(), whisperLog = [], kaarten = [], box = [], lijst = {};
  const staat = { onderhoud: false, nacht: false, whisperFout: new Set() };
  const h = H.maak({ dir: hdir, intake: ing, vault, vv: VV, nu: () => klok.t, fout: opt.fout || (() => {}),
    whisper: async (b) => { const s = sha(b); whisperLog.push(s); if (staat.dienstStoring) throw new Error('Whisper 503'); if (staat.whisperFout.has(s)) throw new Error('Whisper 400'); return tekstVoor.get(s) || ''; },
    kanUitschrijven: () => true, onderhoudAan: () => staat.onderhoud, nachtgrendel: () => staat.nacht, primair: () => true,
    kaartZet: async (p) => { kaarten.push(p); lijst[p.sleutel] = 'open'; return { sleutel: p.sleutel }; }, kaartLijst: async () => lijst,
    box: (t) => box.push(t), rclone: path.join(ROOT, 'test', 'nep-rclone-kopie.js'), remote: remote, offsiteAan: () => true });
  const stuk = (id, n, tekst, zaad, sec) => { const b = wav(sec || 2, zaad || (id + n + tekst)); tekstVoor.set(sha(b), tekst); return b; };
  return { basis, idir, vault, hdir, remote, ing, h, klok, tekstVoor, whisperLog, kaarten, box, lijst, staat, stuk,
    notities: () => { const m = path.join(vault, H.NOTITIE_MAP); return fs.existsSync(m) ? fs.readdirSync(m).sort() : []; },
    sluit: () => { ing.sluit(); fs.rmSync(basis, { recursive: true, force: true }); } };
}
const ID1 = 'r20261030-0123456789abcdef', ID2 = 'r20261030-fedcba9876543210', ID3 = 'r20261030-00000000000000aa';
const manifest = (bufs) => ({ aantal: bufs.length, sha256: bufs.map(sha), opgenomen_op: '2026-10-30T08:55:00Z' });

test('3 stukken door elkaar + dubbel + conflict (409) + klaar te vroeg → 1 notitie met privé-markering, 0 dubbel', async () => {
  const o = omgeving();
  try {
    const b = VERHAAL.map((t, i) => o.stuk(ID1, i + 1, t));
    let u = o.h.ontvangStuk(ID1, 2, b[1]); assert.strictEqual(u.status, 200); assert.strictEqual(u.body.sha256, sha(b[1]));   // verkeerde volgorde
    u = o.h.ontvangStuk(ID1, 1, b[0]); assert.strictEqual(u.status, 200);
    u = o.h.ontvangStuk(ID1, 1, b[0]); assert.strictEqual(u.status, 200); assert.strictEqual(u.body.dubbel, true);   // dubbel = niets nieuws
    u = o.h.ontvangStuk(ID1, 2, wav(2, 'iets anders')); assert.strictEqual(u.status, 409);   // conflict: nooit overschrijven
    assert.strictEqual(fs.readFileSync(path.join(o.hdir, 'staging', ID1, '2.wav')).equals(b[1]), true);
    assert.strictEqual(o.ing._db.prepare("SELECT count(*) n FROM ramble_spoor WHERE soort = 'conflict' AND ramble_id = ? AND n = 2").get(ID1).n, 1);
    u = o.h.ontvangKlaar(ID1, manifest(b)); assert.strictEqual(u.status, 202); assert.deepStrictEqual(u.body.ontbreekt, [3]);   // klaar te vroeg
    assert.strictEqual(o.h.ontvangKlaar(ID1, Object.assign(manifest(b), { aantal: 2, sha256: [sha(b[0]), sha(b[1])] })).status, 409, 'ander manifest');
    u = o.h.ontvangStuk(ID1, 3, wav(2, 'niet volgens manifest')); assert.strictEqual(u.status, 409, 'wijkt af van het manifest');
    u = o.h.ontvangStuk(ID1, 3, b[2]); assert.strictEqual(u.status, 200); assert.strictEqual(u.body.compleet, true);
    assert.ok(!fs.existsSync(path.join(o.hdir, 'staging', ID1)) && fs.existsSync(path.join(o.hdir, 'audio', ID1, 'manifest.txt')), 'naar het archief');
    assert.strictEqual((fs.statSync(path.join(o.hdir, 'audio')).mode & 0o777), 0o700);
    assert.strictEqual(o.h.ontvangKlaar(ID1, manifest(b)).status, 200, 'klaar herhalen = 200');
    assert.strictEqual(o.h.ontvangStuk(ID1, 4, wav(2, 'na afsluiten')).status, 409, 'na afsluiten geen nieuw stuk');
    let t = await o.h.tik();
    assert.strictEqual(t.uitgeschreven, 3); assert.strictEqual(t.intake, 1); assert.strictEqual(t.notities, 1);
    const r = o.ing._db.prepare('SELECT * FROM ramble WHERE ramble_id = ?').get(ID1);
    assert.strictEqual(r.status, 'notitie'); assert.strictEqual(r.marker, 'geen'); assert.strictEqual(r.offsite_ok, 1);
    const s = o.ing._db.prepare('SELECT * FROM stuk WHERE stuk_id = ?').get(r.stuk_id);
    assert.strictEqual(s.profiel, 'ramble@1'); assert.strictEqual(s.access_context, 'strikt_prive'); assert.strictEqual(s.bron, 'app:ramble');
    const delen = o.ing._db.prepare('SELECT o.rol, o.mime, o.sha256, b.offsite FROM onderdeel o JOIN blob b ON b.sha256 = o.sha256 WHERE o.stuk_id = ? ORDER BY o.rol').all(r.stuk_id);
    assert.deepStrictEqual(delen.map((d) => d.rol), ['hoofdtekst', 'origineel']);
    assert.ok(delen.every((d) => !/audio/.test(d.mime)), 'geen audio in Intake');
    assert.strictEqual(delen.find((d) => d.rol === 'origineel').sha256, r.vingerafdruk, 'vingerafdruk = manifest-blob');
    assert.ok(delen.every((d) => d.offsite === 1), 'na marker geen: transcript-blob mag offsite');
    const n = o.notities(); assert.strictEqual(n.length, 1); assert.match(n[0], /^2026-10-30_stk_\d{8}_[0-9a-f]{8}\.md$/);
    const tekst = fs.readFileSync(path.join(o.vault, H.NOTITIE_MAP, n[0]), 'utf8');
    assert.match(tekst, /\ngevoelig: prive\n/); assert.match(tekst, /\naccess_context: strikt_prive\n/); assert.match(tekst, /\nbron_soort: ramble\n/);
    assert.match(tekst, /> \*\*Privé — persoonlijke herinnering\.\*\*/);
    assert.match(tekst, /\[00:00\] Op de camping in Proefdorp/); assert.match(tekst, /\[00:02\] We speelden/); assert.match(tekst, /\[00:04\] Toen de zon/);
    assert.match(tekst, new RegExp('vingerafdruk: ' + r.vingerafdruk));
    t = await o.h.tik();
    assert.ok(!t.notities && !t.intake && !t.uitgeschreven, 'tweede tik doet niets');
    assert.strictEqual(o.notities().length, 1, '0 dubbel');
    assert.strictEqual(o.ing._db.prepare("SELECT count(*) n FROM stuk WHERE profiel = 'ramble@1'").get().n, 1);
    assert.strictEqual(o.whisperLog.length, 3);
    assert.ok(!o.box.some((x) => /Proefdorp|camping/.test(x)), 'geen inhoud in de box');
    // MOET 1 (review): geen transcripttekst in intake.sqlite (gaat elke nacht in de podstaat-bundel); wel in audio/<id>/<n>.txt (0600)
    o.ing._db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dbBytes = Buffer.concat(fs.readdirSync(o.idir).filter((f) => /^intake\.sqlite/.test(f)).map((f) => fs.readFileSync(path.join(o.idir, f))));
    assert.ok(!dbBytes.includes('Proefdorp') && !dbBytes.includes('kaartspelletjes'), 'tekst niet in de databank');
    assert.strictEqual(fs.readFileSync(path.join(o.hdir, 'audio', ID1, '1.txt'), 'utf8'), VERHAAL[0]);
    assert.strictEqual(fs.statSync(path.join(o.hdir, 'audio', ID1, '1.txt')).mode & 0o777, 0o600);
  } finally { o.sluit(); }
});

test('afgebroken upload laat niets achter; volledige stroom geeft buffer + hash', async () => {
  const req = new EventEmitter(); req.resume = () => {};
  const p = H.leesStuk(req, 100);
  req.emit('data', Buffer.alloc(40)); req.emit('aborted');
  assert.deepStrictEqual(await p, { status: 400, fout: 'upload afgebroken' });
  const req2 = new EventEmitter(); req2.resume = () => {};
  const p2 = H.leesStuk(req2, 10);
  req2.emit('data', Buffer.alloc(4)); req2.emit('end');
  assert.strictEqual((await p2).fout, 'upload onvolledig');
  const req3 = new EventEmitter(); req3.resume = () => {};
  const b = wav(1, 'x'); const p3 = H.leesStuk(req3, b.length);
  req3.emit('data', b.subarray(0, 100)); req3.emit('data', b.subarray(100)); req3.emit('end');
  const x = await p3; assert.ok(x.buf.equals(b)); assert.strictEqual(x.hash.digest('hex'), sha(b));
});

test('gat: met manifest na 7 dagen onvolledig, gaten zichtbaar; zonder klaar na 7 dagen ook onvolledig bewaard (niet gewist; box zonder inhoud)', async () => {
  const o = omgeving();
  try {
    const b = ['Eerste stuk van een verzonnen verhaal.', 'Tweede stuk komt nooit aan.', 'Derde stuk over de verzonnen boomhut.'].map((t, i) => o.stuk(ID1, i + 1, t));
    o.h.ontvangStuk(ID1, 1, b[0]); o.h.ontvangStuk(ID1, 3, b[2]);
    assert.strictEqual(o.h.ontvangKlaar(ID1, manifest(b)).status, 202);
    o.h.ontvangStuk(ID2, 1, o.stuk(ID2, 1, 'Losse verzonnen zin zonder afronding.'));
    o.klok.t += 6 * 86400000;
    let t = await o.h.tik(); assert.ok(!t.onvolledig && !t.opgeruimd, 'na 6 dagen nog niets');
    o.klok.t += 2 * 86400000;
    t = await o.h.tik();
    assert.strictEqual(t.onvolledig, 2); assert.ok(!t.opgeruimd); assert.strictEqual(t.notities, 2);
    assert.ok(!fs.existsSync(path.join(o.hdir, 'staging', ID2)) && fs.existsSync(path.join(o.hdir, 'audio', ID2, '1.wav')), 'zonder klaar: bewaard, niet gewist');
    const r1 = o.ing._db.prepare('SELECT stuk_id FROM ramble WHERE ramble_id = ?').get(ID1);
    const tekst = fs.readFileSync(path.join(o.vault, H.NOTITIE_MAP, o.notities().find((n) => n.includes(r1.stuk_id))), 'utf8');
    assert.match(tekst, /\nonvolledig: true\n/); assert.match(tekst, /\[00:02–01:02 ontbreekt\]/); assert.match(tekst, /\[01:02\] Derde stuk/);
    assert.strictEqual(o.box.length, 1); assert.match(o.box[0], /onvolledig bewaard/); assert.ok(!/verzonnen|Losse/.test(o.box[0]), 'geen inhoud in de box-rij');
    const mt = fs.readFileSync(path.join(o.hdir, 'audio', ID1, 'manifest.txt'), 'utf8');
    assert.match(mt, /\n2 ontbreekt\n/);
  } finally { o.sluit(); }
});

test('markertreffer (verzonnen werktekst) → geen notitie, kaart zonder inhoud, niet offsite; Ja = doorlaten → notitie + offsite-lijst', async () => {
  const o = omgeving();
  try {
    const a = [o.stuk(ID1, 1, 'Verzonnen herinnering aan een zeilwedstrijd op het Proefmeer.')];
    const w = [o.stuk(ID2, 1, WERK)];
    o.h.ontvangStuk(ID1, 1, a[0]); o.h.ontvangKlaar(ID1, manifest(a));
    o.h.ontvangStuk(ID2, 1, w[0]); o.h.ontvangKlaar(ID2, manifest(w));
    const t = await o.h.tik();
    assert.strictEqual(t.notities, 1); assert.strictEqual(t.kaarten, 1);
    const r2 = o.ing._db.prepare('SELECT * FROM ramble WHERE ramble_id = ?').get(ID2);
    assert.strictEqual(r2.status, 'vastgehouden'); assert.strictEqual(r2.marker, 'gemarkeerd'); assert.strictEqual(r2.offsite_ok, 0);
    assert.strictEqual(o.notities().length, 1);
    const k = o.kaarten[0];
    assert.match(k.titel, /\?$/); assert.ok(k.titel.length <= 90 && k.waarom.length <= 400 && k.meting.length <= 300);
    assert.ok(!JSON.stringify(k).match(/Proefpersoon|hypertensie|Proefmeer/), 'kaart zonder inhoud');
    const delen = o.ing._db.prepare('SELECT b.offsite FROM onderdeel o JOIN blob b ON b.sha256 = o.sha256 WHERE o.stuk_id = ?').all(r2.stuk_id);
    assert.ok(delen.every((d) => d.offsite === 0), 'gemarkeerd transcript alleen op de pod');
    // offsite-lijst op een KOPIE van het logboek: alleen de ongemarkeerde opname
    const kopie = path.join(o.basis, 'kopie.sqlite');
    o.ing._db.exec("VACUUM INTO '" + kopie.replace(/'/g, "''") + "'");
    const lijst = execFileSync(process.execPath, [path.join(ROOT, 'herinneringen.js'), 'offsite-lijst', kopie, path.join(o.hdir, 'audio')], { encoding: 'utf8' }).trim().split('\n');
    assert.deepStrictEqual(lijst, [ID1 + '/1.wav', ID1 + '/manifest.txt']);
    // knop: alleen eigen sleutels; Nee = vasthouden, verval = terug; Ja = doorlaten
    assert.strictEqual(o.h.knop('herinnering-0000000000', 'ja'), null);
    assert.strictEqual(o.h.knop('scansnap-0123456789', 'ja'), null);
    const nee = o.h.knop(k.sleutel, 'nee'); assert.ok(!/Proefpersoon/.test(nee.context));
    nee.bijStart(); assert.strictEqual(o.ing._db.prepare('SELECT keuze FROM ramble WHERE ramble_id = ?').get(ID2).keuze, 'vasthouden');
    nee.bijVerval(); assert.strictEqual(o.ing._db.prepare('SELECT keuze FROM ramble WHERE ramble_id = ?').get(ID2).keuze, null);
    await o.h.tik(); assert.strictEqual(o.notities().length, 1, 'zonder keuze geen notitie');
    const ja = o.h.knop(k.sleutel, 'ja'); ja.bijStart();
    const t2 = await o.h.tik();
    assert.strictEqual(t2.notities, 1); assert.strictEqual(o.notities().length, 2);
    assert.strictEqual(o.ing._db.prepare('SELECT offsite_ok FROM ramble WHERE ramble_id = ?').get(ID2).offsite_ok, 1);
  } finally { o.sluit(); }
});

test('offsite: alleen toevoegen naar de (nep-)remote, cryptcheck, daarna niet opnieuw; proefopname nooit', async () => {
  const o = omgeving();
  try {
    const a = [o.stuk(ID1, 1, 'Verzonnen zin over een vlieger.'), o.stuk(ID1, 2, 'Verzonnen zin over de wind.')];
    o.h.ontvangStuk(ID1, 1, a[0]); o.h.ontvangStuk(ID1, 2, a[1]); o.h.ontvangKlaar(ID1, manifest(a));
    const p = [o.stuk(ID3, 1, 'Verzonnen proefzin.')];
    o.h.ontvangStuk(ID3, 1, p[0], { proef: true }); o.h.ontvangKlaar(ID3, manifest(p));
    const t = await o.h.tik({ offsite: true });
    assert.strictEqual(t.notities, 2); assert.strictEqual(t.offsite, 1);
    assert.deepStrictEqual(fs.readdirSync(path.join(o.remote, ID1)).sort(), ['1.wav', '2.wav', 'manifest.txt']);
    assert.ok(!fs.existsSync(path.join(o.remote, ID3)), 'proefaudio nooit offsite');
    const log1 = fs.readFileSync(path.join(o.remote, '.log'), 'utf8');
    assert.match(log1, /copy .*--ignore-existing/); assert.match(log1, /cryptcheck .*--one-way/);
    const t2 = await o.h.tik({ offsite: true });
    assert.ok(!t2.offsite, 'al offsite: niet opnieuw');
    assert.strictEqual(o.h.info().offsite.open, 0);
    // de proefopname kreeg wel een notitie (maar de spiegel ziet hem als proefstuk)
    const s = o.ing._db.prepare("SELECT meta FROM stuk WHERE bron_id = ?").get(ID3);
    assert.ok(I.isProefstuk({ bron_id: ID3, meta: s.meta }));
  } finally { o.sluit(); }
});

test('uitschrijven: dienststoring telt niet als poging; 3 pogingen bij een fout van het stuk, daarna gat zichtbaar; plafond 120 min per dag', async () => {
  const o = omgeving();
  try {
    const a = [o.stuk(ID1, 1, 'Verzonnen zin een.'), o.stuk(ID1, 2, 'Verzonnen zin twee.')];
    o.staat.whisperFout.add(sha(a[1]));
    o.h.ontvangStuk(ID1, 1, a[0]); o.h.ontvangStuk(ID1, 2, a[1]); o.h.ontvangKlaar(ID1, manifest(a));
    o.staat.dienstStoring = true;
    let t = await o.h.tik(); assert.strictEqual(t.whisper_fout, 1);
    for (let i = 0; i < 5; i++) { o.klok.t += 11 * 60000; await o.h.tik(); }
    assert.ok(o.ing._db.prepare('SELECT max(pogingen) m FROM ramble_stuk WHERE ramble_id = ?').get(ID1).m === 0, 'storing van de dienst telt niet als poging');
    o.staat.dienstStoring = false; o.klok.t += 11 * 60000;
    t = await o.h.tik(); assert.strictEqual(t.whisper_fout, 1); assert.ok(!t.intake);
    t = await o.h.tik(); assert.ok(!t.whisper_fout, 'pauze tussen pogingen');
    o.klok.t += 11 * 60000; t = await o.h.tik(); assert.strictEqual(t.whisper_fout, 1);
    o.klok.t += 11 * 60000; t = await o.h.tik(); assert.strictEqual(t.whisper_fout, 1); assert.strictEqual(t.intake, 1);
    const tekst = fs.readFileSync(path.join(o.vault, H.NOTITIE_MAP, o.notities()[0]), 'utf8');
    assert.match(tekst, /\[00:02–00:04 niet uitgeschreven\]/);
    // plafond
    o.ing._db.prepare('INSERT INTO ramble_dag (dag, seconden) VALUES (?, ?) ON CONFLICT (dag) DO UPDATE SET seconden = excluded.seconden').run('2026-10-30', H.PLAFOND_S - 1);
    const b = [o.stuk(ID2, 1, 'Verzonnen zin na het plafond.')];
    o.h.ontvangStuk(ID2, 1, b[0]); o.h.ontvangKlaar(ID2, manifest(b));
    t = await o.h.tik(); assert.strictEqual(t.plafond, true); assert.ok(!t.uitgeschreven);
    assert.strictEqual(o.h.info().wacht_plafond, true);
    assert.strictEqual(o.ing._db.prepare('SELECT status FROM ramble WHERE ramble_id = ?').get(ID2).status, 'archief', 'wacht, niets verloren');
    o.klok.t = Date.parse('2026-10-31T06:00:00Z');
    t = await o.h.tik(); assert.strictEqual(t.uitgeschreven, 1); assert.strictEqual(t.notities, 1);
  } finally { o.sluit(); }
});

test('onderhoud en nachtgrendel: notitie wacht; grenzen (6 per dag, 2,5 MB, stuk 91, geen WAV, uit-schakelaar)', async () => {
  const o = omgeving();
  try {
    const a = [o.stuk(ID1, 1, 'Verzonnen zin tijdens onderhoud.')];
    o.h.ontvangStuk(ID1, 1, a[0]); o.h.ontvangKlaar(ID1, manifest(a));
    o.staat.onderhoud = true; let t = await o.h.tik(); assert.strictEqual(t.wacht, 'onderhoud'); assert.strictEqual(o.notities().length, 0);
    o.staat.onderhoud = false; o.staat.nacht = true; t = await o.h.tik(); assert.strictEqual(t.wacht, 'nachtgrendel');
    o.staat.nacht = false; t = await o.h.tik(); assert.strictEqual(t.notities, 1);
    for (let i = 2; i <= 6; i++) assert.strictEqual(o.h.ontvangStuk('r20261030-' + String(i).repeat(16), 1, wav(1, i)).status, 200);
    assert.strictEqual(o.h.ontvangStuk('r20261030-7777777777777777', 1, wav(1, 7)).status, 429, 'zevende opname vandaag');
    assert.strictEqual(o.h.ontvangStuk('r20261030-2222222222222222', 2, wav(1, 'nog een')).status, 200, 'bestaande opname mag door');
    assert.strictEqual(o.h.ontvangStuk(ID2, 1, Buffer.alloc(H.STUK_MAX_BYTES + 1)).status, 413);
    assert.strictEqual(o.h.ontvangStuk('r20261030-2222222222222222', 91, wav(1, 'x')).status, 400);
    assert.strictEqual(o.h.ontvangStuk('r20261030-2222222222222222', 3, Buffer.from('geen wav, wel lang genoeg om voorbij de kop te komen.')).status, 400);
    assert.strictEqual(o.h.ontvangStuk('../etc', 1, wav(1, 'x')).status, 400);
    assert.strictEqual(o.h.ontvangKlaar('r20261030-2222222222222222', { aantal: 1, sha256: ['x'], opgenomen_op: '2026-10-30T08:00:00Z' }).status, 400);
    assert.strictEqual(o.h.ontvangKlaar('r20261030-2222222222222222', { aantal: 2, sha256: [sha(wav(1, 2)), sha(wav(1, 'nog een'))], opgenomen_op: '2026-10-30T08:00:00Z', verteller: 'Robert"); DROP' }).status, 400);
    fs.writeFileSync(path.join(o.hdir, 'uit'), '');
    assert.strictEqual(o.h.ontvangStuk(ID2, 1, wav(1, 'x')).status, 503);
    assert.deepStrictEqual(await o.h.tik(), { uit: true });
  } finally { o.sluit(); }
});

test('null in het manifest = stuk op de telefoon verloren: opname onvolledig met gat; weggooien vóór afsluiten', async () => {
  const o = omgeving();
  try {
    const a = [o.stuk(ID1, 1, 'Verzonnen zin een.'), o.stuk(ID1, 2, 'Verloren stuk.'), o.stuk(ID1, 3, 'Verzonnen zin drie.')];
    o.h.ontvangStuk(ID1, 1, a[0]); o.h.ontvangStuk(ID1, 3, a[2]);
    const m = manifest(a); m.sha256[1] = null;
    const u = o.h.ontvangKlaar(ID1, m); assert.strictEqual(u.status, 200); assert.strictEqual(u.body.compleet, true);
    assert.strictEqual(o.h.ontvangKlaar(ID2, { aantal: 1, sha256: [null], opgenomen_op: '2026-10-30T08:00:00Z' }).status, 400, 'alleen null = ongeldig');
    const t = await o.h.tik(); assert.strictEqual(t.notities, 1);
    const tekst = fs.readFileSync(path.join(o.vault, H.NOTITIE_MAP, o.notities()[0]), 'utf8');
    assert.match(tekst, /\nonvolledig: true\n/); assert.match(tekst, /\[00:02–01:02 ontbreekt\]/);
    // weggooien
    o.h.ontvangStuk(ID2, 1, o.stuk(ID2, 1, 'Weg ermee.'));
    assert.strictEqual(o.h.weg(ID2).status, 200);
    assert.ok(!fs.existsSync(path.join(o.hdir, 'staging', ID2)));
    assert.strictEqual(o.h.ontvangStuk(ID2, 1, wav(1, 'nog eens')).status, 409, 'na weggooien geen nieuw begin');
    assert.strictEqual(o.h.ontvangKlaar(ID2, { aantal: 1, sha256: ['a'.repeat(64)], opgenomen_op: '2026-10-30T08:00:00Z' }).status, 409);
    assert.strictEqual(o.h.stand(ID2).body.compleet, false);
    assert.strictEqual(o.h.weg(ID1).status, 409, 'afgesloten opname niet via de app weg');
    o.klok.t += 8 * 86400000; await o.h.tik();
    assert.strictEqual(o.ing._db.prepare('SELECT status FROM ramble WHERE ramble_id = ?').get(ID2).status, 'weggegooid');
  } finally { o.sluit(); }
});

test('spiegel: ramble = één bron op de opname (origin ramble, versie = vingerafdruk, strikt_prive, route app.ramble), geen tekst', async () => {
  const o = omgeving();
  try {
    const a = [o.stuk(ID1, 1, 'Verzonnen zin voor de spiegel.')];
    o.h.ontvangStuk(ID1, 1, a[0]); o.h.ontvangKlaar(ID1, manifest(a));
    await o.h.tik();
    const r = o.ing._db.prepare('SELECT * FROM ramble WHERE ramble_id = ?').get(ID1);
    let gezien = null;
    const ing2 = I.maak({ dir: o.idir, vault: o.vault, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'),
      primair: () => true, vv: VV, nu: () => o.klok.t, fout: () => {}, marker: P, nachtgrendel: () => false, stuur: () => {},
      sbRpc: async (fn, body) => { gezien = body; return { stukken: body.p.stukken.map((s) => ({ ref: s.ref, ok: true, bronnen: s.bronnen.map(() => ({ record: 1, revisie: 2, ontvangst: 3 })) })) }; } });
    try {
      const u = await ing2.spiegel({ forceer: true });
      assert.strictEqual(u.gespiegeld, 1, JSON.stringify(u));
      const st = gezien.p.stukken.find((x) => x.ref === r.stuk_id);
      assert.strictEqual(st.bronnen.length, 1);
      const b = st.bronnen[0];
      assert.strictEqual(b.origin_system, 'ramble'); assert.strictEqual(b.external_id, ID1); assert.strictEqual(b.sha256, r.vingerafdruk);
      assert.strictEqual(b.intake_route, 'app.ramble'); assert.strictEqual(b.access_context, 'strikt_prive');
      assert.ok(!JSON.stringify(gezien).includes('Verzonnen'), 'geen tekst naar Supabase');
    } finally { ing2.sluit(); }
  } finally { o.sluit(); }
});

test('publicatieservice en router laten ramble@1 liggen; oude raw_input-skill raakt de map niet', () => {
  const pub = fs.readFileSync(path.join(ROOT, 'intake-publicatie.js'), 'utf8');
  assert.match(pub, /ramble@/, 'expliciete uitsluiting in de publicatieservice');
  const R = fs.readFileSync(path.join(ROOT, 'intake-router.js'), 'utf8');
  assert.match(R, /const PROFIELEN = new Set\(\['mail@1', 'outlook-mail@1', 'scansnap@1'\]\)/);
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(srv, /const s = a \? appSessie\(req, a, false\) : null;[\s\S]*route\.indexOf\('POST \/app\/ramble\/'\) === 0 \|\| route\.indexOf\('GET \/app\/ramble\/'\) === 0\) return appRamble/, 'ramble-route pas na de sessiecontrole');
  assert.match(srv, /const ruw = upload \|\| rambleStuk \|\|/, 'stuk is een ruwe route (getekende inhoudshash)');
});

test('crash tussen hernoemen en databankregel: de volgende ronde zet alleen de regel (KAN 6)', async () => {
  const o = omgeving();
  try {
    const a = [o.stuk(ID1, 1, 'Verzonnen zin na een crash.'), o.stuk(ID1, 2, 'Tweede verzonnen zin.')];
    o.h.ontvangStuk(ID1, 1, a[0]); o.h.ontvangKlaar(ID1, manifest(a));
    // nabootsen: stuk 2 is binnen, manifest geschreven en de map verhuisd, maar de pod stierf vóór de databankregel
    const st = path.join(o.hdir, 'staging', ID1);
    fs.writeFileSync(path.join(st, '2.wav'), a[1]);
    o.ing._db.prepare('INSERT INTO ramble_stuk (ramble_id, n, sha256, grootte, seconden, binnen) VALUES (?, 2, ?, ?, 2, ?)').run(ID1, sha(a[1]), a[1].length, new Date(o.klok.t).toISOString());
    fs.writeFileSync(path.join(st, 'manifest.txt'), 'ovis-ramble-manifest/1\nramble_id: ' + ID1 + '\nstukken: 2\n1 ' + sha(a[0]) + ' ' + a[0].length + '\n2 ' + sha(a[1]) + ' ' + a[1].length + '\n');
    fs.renameSync(st, path.join(o.hdir, 'audio', ID1));
    assert.strictEqual(o.ing._db.prepare('SELECT status FROM ramble WHERE ramble_id = ?').get(ID1).status, 'wacht');
    const u = o.h.ontvangKlaar(ID1, manifest(a));
    assert.strictEqual(u.status, 200, JSON.stringify(u));
    const t = await o.h.tik();
    assert.strictEqual(t.notities, 1);
    assert.strictEqual(o.ing._db.prepare("SELECT count(*) n FROM ramble_spoor WHERE soort = 'archief_hersteld'").get().n, 1);
  } finally { o.sluit(); }
});
