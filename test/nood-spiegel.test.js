'use strict';
// Toets van nood-spiegel.js (wv3909, fase 1f/1g "app blijft werken"; contract mk-scripts/wv3909/contract.md) met een nep-socev-nood
// (lokale http-server), en van de tweede age-ontvanger in warme-staat.js (A3). Met /opt/data/uitwijk-warm/age{,-keygen} (of
// AGE_BIN/AGE_KEYGEN_BIN) echt versleuteld en met elk van beide identiteiten ontsleuteld; anders een nep-age die de ontvangers noteert.
// Alle toetsdata verzonnen.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const N = require('../nood-spiegel.js');
const W = require('../warme-staat.js');

process.umask(0o077);
const open = [];   // nep-servers die na een rode toets nog openstaan
test.after(() => Promise.all(open.map((s) => s.dicht())));
const SLEUTEL = 'NEPSLEUTEL_' + 'k'.repeat(40);
const ECHTE_AGE = process.env.AGE_BIN || '/opt/data/uitwijk-warm/age';
const ECHTE_KEYGEN = process.env.AGE_KEYGEN_BIN || '/opt/data/uitwijk-warm/age-keygen';
const echt = fs.existsSync(ECHTE_AGE) && fs.existsSync(ECHTE_KEYGEN);
const hex = (c, n) => c.repeat(n);

// ── nep-socev-nood ──
function nepNood() {
  const s = { verzoeken: [], antwoord: null, bevestig: null, hang: false };
  const srv = http.createServer((q, r) => {
    let b = ''; q.on('data', (d) => { b += d; });
    q.on('end', () => {
      let j = null; try { j = JSON.parse(b); } catch (e) { j = null; }
      s.verzoeken.push({ pad: q.url, auth: q.headers.authorization, body: j });
      if (s.hang) return;   // nooit antwoorden (tijdslimiet)
      const stuur = (st, o) => { r.writeHead(st, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
      if (q.headers.authorization !== 'Bearer ' + SLEUTEL) return stuur(401, { ok: false, fout: 'sleutel onjuist' });
      if (q.url === '/pod/spiegel') {
        const lijsten = j.passkeys !== undefined || j.push !== undefined || j.bundel_sha256 !== undefined;
        if (j.passkeys && !j.passkeys.length) return stuur(400, { ok: false, fout: 'lege passkeylijst' });
        if (s.antwoord) return stuur(s.antwoord.status, s.antwoord.body);
        return stuur(200, { ok: true, geschreven: lijsten, opdracht: s.opdracht || null });
      }
      if (q.url === '/pod/bevestig') {
        if (s.bevestig) return stuur(s.bevestig.status, s.bevestig.body);
        return stuur(200, { ok: true });
      }
      stuur(404, { ok: false });
    });
  });
  return new Promise((k) => srv.listen(0, '127.0.0.1', () => { s.url = 'http://127.0.0.1:' + srv.address().port; open.push(s); s.dicht = () => new Promise((x) => { if (s.dichtGedaan) return x(); s.dichtGedaan = true; srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => x()); }); k(s); }));
}

function apparaat(id, meer) {
  return Object.assign({ id: id, naam: 'Proeftoestel ' + id.slice(0, 4), actief: true, cookie_hash: hex('c', 64), laatst_gezien: '2026-11-25T10:00:00Z',
    credential: { id: 'Q3JlZElk' + id.slice(0, 6), publicKey: 'pQECAyYgASFYIP' + id.slice(0, 8), counter: 3, transports: ['internal'] } }, meer || {});
}

function opzet(meer) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nood-'));
  const d = { T: T, reg: { versie: 1, apparaten: [apparaat('a1a1a1a1a1a1a1a1'), apparaat('b2b2b2b2b2b2b2b2', { actief: false, cookie_hash: null }), apparaat('c3c3c3c3c3c3c3c3', { credential: null })] },
    push: { versie: 1, apparaten: { a1a1a1a1a1a1a1a1: { endpoint: 'https://fcm.googleapis.com/fcm/send/nep-a1', laatst: 'x' }, b2b2b2b2b2b2b2b2: { endpoint: 'https://fcm.googleapis.com/fcm/send/nep-b2' },
      c3c3c3c3c3c3c3c3: { endpoint: 'https://evil.example/push' } } },
    kant: 'olares', primair: true, klok: Date.parse('2026-11-25T12:00:00Z'), logs: [], warm: [], lsn: '9/8E0051D0' };
  const sleutelPad = path.join(T, 'nood-pod.key'), bundelPad = path.join(T, 'geheimen.sha256');
  fs.writeFileSync(bundelPad, hex('e', 64) + '  geheimen.age\n');
  d.sleutel = function (aan) { if (aan) fs.writeFileSync(sleutelPad, SLEUTEL + '\n'); else fs.rmSync(sleutelPad, { force: true }); };
  d.opties = function (extra) {
    return Object.assign({ url: d.url, sleutelPad: sleutelPad, bundelPad: bundelPad, staatPad: path.join(T, 'staat.json'), nu: () => d.klok,
      kant: () => d.kant, primair: () => d.primair, versie: () => 'abcdef1234567890abcdef1234567890abcdef12',
      register: () => { if (d.reg === 'kapot') throw new Error('kapot'); return JSON.parse(JSON.stringify(d.reg)); },
      push: () => JSON.parse(JSON.stringify(d.push)), pushOk: (ep) => /^https:\/\/fcm\.googleapis\.com\//.test(ep),
      warmVers: async (ms) => { d.warm.push(ms); return { uitkomst: 'ok', staat_sha256: hex('5', 64) }; }, lsn: async () => d.lsn,
      log: (t) => d.logs.push(String(t)) }, meer || {}, extra || {});
  };
  return d;
}
const spiegels = (s) => s.verzoeken.filter((v) => v.pad === '/pod/spiegel');
const bevestigd = (s) => s.verzoeken.filter((v) => v.pad === '/pod/bevestig');

test('geen sleutel = geen enkele aanroep; stand ingericht false', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url;
  const m = N.maak(d.opties());
  assert.strictEqual(await m.tik(), 'geen sleutel');
  assert.strictEqual(m.peil(), 'stil');
  d.primair = false; assert.strictEqual(await m.tik(), 'geen sleutel');
  assert.strictEqual(s.verzoeken.length, 0);
  const st = m.stand();
  assert.strictEqual(st.ingericht, false); assert.ok(!st.aanroepen);
  fs.writeFileSync(path.join(d.T, 'nood-pod.key'), 'te kort\n');
  assert.strictEqual(await m.tik(), 'geen sleutel'); assert.strictEqual(s.verzoeken.length, 0);
  assert.match(m.stand().sleutel_fout, /vorm/);
  await s.dicht();
});

test('stand-in (SOCEV_ALTIJD_PASSIEF): niets, ook met sleutel', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url; d.sleutel(true); d.kant = 'vps';
  const m = N.maak(d.opties({ standIn: true }));
  assert.strictEqual(await m.tik(), 'stand-in'); assert.strictEqual(m.peil(), 'stil');
  d.primair = true; assert.strictEqual(await m.tik(), 'stand-in');
  assert.strictEqual(s.verzoeken.length, 0);
  assert.deepStrictEqual(m.stand(), { ingericht: false, stand_in: true });
  await s.dicht();
});

test('passief = alleen hartslag (kant, rol, versie), Bearer uit het bestand, geen sleutel in log of stand', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url; d.sleutel(true); d.primair = false;
  const m = N.maak(d.opties());
  assert.strictEqual(await m.tik(), 'hartslag');
  const v = spiegels(s)[0];
  assert.strictEqual(v.auth, 'Bearer ' + SLEUTEL);
  assert.deepStrictEqual(Object.keys(v.body).sort(), ['kant', 'rol', 'versie']);
  assert.deepStrictEqual(v.body, { kant: 'olares', rol: 'passief', versie: 'abcdef1234567890abcdef1234567890abcdef12' });
  assert.strictEqual(m.peil(), 'stil');   // passief peilt niet
  const st = m.stand();
  assert.strictEqual(st.ingericht, true); assert.ok(st.laatst_ok); assert.strictEqual(st.laatste_fout, null); assert.strictEqual(st.lijsten_geschreven_op, null);
  assert.ok(!JSON.stringify(st).includes(SLEUTEL) && !d.logs.join('\n').includes(SLEUTEL));
  await s.dicht();
});

test('primair: lijsten één keer, daarna alleen hartslag; bij wijziging via peil (± 10 s) en na 6 u opnieuw', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url; d.sleutel(true);
  const m = N.maak(d.opties());
  assert.strictEqual(await m.tik(), 'lijsten');
  const b = spiegels(s)[0].body;
  assert.strictEqual(b.rol, 'primair');
  assert.deepStrictEqual(b.passkeys, [{ cred_id: 'Q3JlZElka1a1a1', public_key: 'pQECAyYgASFYIPa1a1a1a1', apparaat_id: 'a1a1a1a1a1a1a1a1', cookie_hash: hex('c', 64), naam: 'Proeftoestel a1a1' }],
    'alleen actieve apparaten met credential');
  assert.deepStrictEqual(b.push, [{ apparaat_id: 'a1a1a1a1a1a1a1a1', endpoint: 'https://fcm.googleapis.com/fcm/send/nep-a1' }], 'alleen actief en een toegestane pushdienst');
  assert.strictEqual(b.bundel_sha256, hex('e', 64));
  assert.ok(m.stand().lijsten_geschreven_op);
  assert.strictEqual(await m.tik(), 'hartslag');
  assert.deepStrictEqual(Object.keys(spiegels(s)[1].body).sort(), ['kant', 'rol', 'versie']);
  assert.strictEqual(m.peil(), 'gelijk');
  // laatst_gezien/laatst wijzigen = geen wijziging van de projectie
  d.reg.apparaten[0].laatst_gezien = '2026-11-25T11:00:00Z'; d.push.apparaten.a1a1a1a1a1a1a1a1.laatst = 'y';
  assert.strictEqual(m.peil(), 'gelijk');
  // intrekken = wijziging → peil duwt meteen
  d.reg.apparaten.push(apparaat('d4d4d4d4d4d4d4d4'));
  d.klok += 11000;
  assert.strictEqual(await m.peil(), 'lijsten');
  assert.strictEqual(spiegels(s)[2].body.passkeys.length, 2);
  assert.strictEqual(m.peil(), 'gelijk');
  d.klok += 5 * 3600e3; assert.strictEqual(await m.tik(), 'hartslag');
  d.klok += 3600e3 + 1; assert.strictEqual(await m.tik(), 'lijsten', 'elke 6 u opnieuw');
  // een nieuwe pod (herstart) kent de hash nog: geen dubbele lijsten
  const m2 = N.maak(d.opties());
  assert.strictEqual(await m2.tik(), 'hartslag');
  await s.dicht();
});

test('nooit een lege passkeylijst; register kapot = geen passkeys en geen push, wel zichtbaar', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url; d.sleutel(true);
  d.reg.apparaten.forEach((a) => { a.actief = false; });
  const m = N.maak(d.opties());
  assert.strictEqual(await m.tik(), 'lijsten');
  let b = spiegels(s)[0].body;
  assert.ok(!('passkeys' in b), 'geen passkeys-veld'); assert.deepStrictEqual(b.push, []);
  d.reg = 'kapot';
  assert.strictEqual(await m.tik(), 'lijsten');
  b = spiegels(s)[1].body;
  assert.ok(!('passkeys' in b) && !('push' in b) && b.bundel_sha256 === hex('e', 64));
  assert.match(m.stand().laatste_fout, /register onleesbaar/);
  for (const v of spiegels(s)) assert.ok(!v.body.passkeys || v.body.passkeys.length > 0);
  await s.dicht();
});

test('fouten: 401, 409 en tijdslimiet zichtbaar zonder sleutel; lijsten na 409 opnieuw', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url; d.sleutel(true);
  const m = N.maak(d.opties({ tijdMs: 300 }));
  s.antwoord = { status: 409, body: { ok: false, fout: 'niet de actieve kant' } };
  assert.strictEqual(await m.tik(), 'fout');
  assert.match(m.stand().laatste_fout, /409/);
  s.antwoord = null; d.klok += 61000;
  assert.strictEqual(await m.tik(), 'lijsten', 'na een 409 niet als geschreven gemarkeerd');
  fs.writeFileSync(path.join(d.T, 'nood-pod.key'), 'ANDERESLEUTEL_' + 'z'.repeat(40));
  assert.strictEqual(await m.tik(), 'fout'); assert.match(m.stand().laatste_fout, /401.*geweigerd/);
  d.sleutel(true); s.hang = true;
  const t0 = Date.now();
  assert.strictEqual(await m.tik(), 'fout');
  assert.ok(Date.now() - t0 < 3000); assert.match(m.stand().laatste_fout, /tijdslimiet/);
  const alles = JSON.stringify(m.stand()) + d.logs.join('\n');
  assert.ok(!alles.includes(SLEUTEL) && !alles.includes('ANDERESLEUTEL') && !alles.includes('fcm.googleapis') && !alles.includes(hex('c', 64)));
  s.hang = false;
  await s.dicht();
});

test('geplande wissel proef: verse warme staat, één bevestiging met eindstand; ook na herstart niet nog eens', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url; d.sleutel(true);
  const id = hex('1', 32);
  s.opdracht = { id: id, doel: 'vps', naam: 'proef', standversie: 7, gemaakt: '2026-11-25T11:59:00Z' };
  const m = N.maak(d.opties());
  await m.tik(); await m._wacht();
  assert.deepStrictEqual(d.warm, [90000]);
  const bv = bevestigd(s);
  assert.strictEqual(bv.length, 1);
  assert.deepStrictEqual(bv[0].body, { opdracht_id: id, kant: 'olares', eindstand: { droog: true, staat_sha256: hex('5', 64), lsn: '9/8E0051D0', ronde: 'ok' } });
  assert.ok(JSON.stringify(bv[0].body.eindstand).length <= 1000);
  await m.tik(); await m._wacht(); d.klok += 60000; await m.tik(); await m._wacht();
  assert.strictEqual(bevestigd(s).length, 1, 'één keer per opdracht-id');
  const m2 = N.maak(d.opties()); await m2.tik(); await m2._wacht();
  assert.strictEqual(bevestigd(s).length, 1, 'ook na een herstart');
  assert.strictEqual(m2.stand().opdracht.uitkomst, 'bevestigd');
  assert.strictEqual(d.warm.length, 1);
  await s.dicht();
});

test('geplande wissel: echt nooit bevestigd (één logregel); passief en kant vps niets; netwerkfout = hooguit 3 pogingen, zelfde eindstand', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url; d.sleutel(true);
  s.opdracht = { id: hex('2', 32), doel: 'vps', naam: 'echt', standversie: 7 };
  const m = N.maak(d.opties());
  for (let i = 0; i < 3; i++) { await m.tik(); await m._wacht(); }
  assert.strictEqual(bevestigd(s).length, 0); assert.strictEqual(d.warm.length, 0);
  assert.strictEqual(d.logs.filter((l) => /echte geplande wissel nog niet gebouwd \(vervolg\)/.test(l)).length, 1);
  // passief / kant vps: een proefopdracht doet niets
  s.opdracht = { id: hex('3', 32), doel: 'vps', naam: 'proef', standversie: 7 };
  d.primair = false; await m.tik(); await m._wacht();
  d.primair = true; d.kant = 'vps'; await m.tik(); await m._wacht();
  assert.strictEqual(bevestigd(s).length, 0); assert.strictEqual(d.warm.length, 0);
  // olares primair, bevestig geeft 503 → opnieuw (zelfde eindstand, geen tweede verse ronde), hooguit 3 keer
  d.kant = 'olares'; s.bevestig = { status: 503, body: { ok: false, fout: 'databank' } };
  for (let i = 0; i < 5; i++) { await m.tik(); await m._wacht(); }
  const bv = bevestigd(s);
  assert.strictEqual(bv.length, 3); assert.strictEqual(d.warm.length, 1);
  assert.deepStrictEqual(bv[0].body.eindstand, bv[2].body.eindstand);
  // 409 (al bevestigd of vervallen) = klaar, niet opnieuw
  s.bevestig = { status: 409, body: { ok: false } }; s.opdracht = { id: hex('4', 32), doel: 'vps', naam: 'proef', standversie: 7 };
  for (let i = 0; i < 3; i++) { await m.tik(); await m._wacht(); }
  assert.strictEqual(bevestigd(s).length, 4);
  assert.match(m.stand().opdracht.uitkomst, /geweigerd/);
  await s.dicht();
});

test('geplande wissel: verse ronde te laat = toch één bevestiging (ronde te laat), lsn onbekend = null', async () => {
  const s = await nepNood(); const d = opzet(); d.url = s.url; d.sleutel(true); d.lsn = null;
  s.opdracht = { id: hex('6', 32), doel: 'vps', naam: 'proef', standversie: 7 };
  const m = N.maak(d.opties({ versMs: 100, warmVers: () => new Promise(() => {}), staatSha: () => hex('7', 64) }));
  await m.tik(); await m._wacht();
  const bv = bevestigd(s);
  assert.strictEqual(bv.length, 1);
  assert.deepStrictEqual(bv[0].body.eindstand, { droog: true, staat_sha256: hex('7', 64), lsn: null, ronde: 'te laat' });
  await s.dicht();
});

// ── A3: tweede age-ontvanger in warme-staat.js ──
function keygen(T, naam) {
  const id = path.join(T, naam);
  cp.execFileSync(ECHTE_KEYGEN, ['-o', id], { stdio: 'ignore' });
  return { id: id, pub: cp.execFileSync(ECHTE_KEYGEN, ['-y', id]).toString().trim() };
}
// verzonnen, geldige bech32-ontvangers voor de nep-age (geen echte sleutel): bech32('age', 32 bytes)
function bech32Age(bytes) {
  const C = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const pm = (v) => { let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i]; } return c >>> 0; };
  const d = []; let acc = 0, bits = 0;
  for (const x of bytes) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >>> bits) & 31); } acc &= (1 << bits) - 1; }
  if (bits) d.push((acc << (5 - bits)) & 31);
  const m = pm([3, 3, 3, 0, 1, 7, 5].concat(d, [0, 0, 0, 0, 0, 0])) ^ 1, ch = [];
  for (let i = 0; i < 6; i++) ch.push((m >>> (5 * (5 - i))) & 31);
  return 'age1' + d.concat(ch).map((x) => C[x]).join('');
}
const NEP1 = W.ONTVANGER, NEP2 = bech32Age(Buffer.alloc(32, 7));
function warmOpzet() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nood-warm-'));
  const thuis = path.join(T, 'thuis'), nep = path.join(T, 'r230');
  const mk = (p, t) => { fs.mkdirSync(path.dirname(path.join(thuis, p)), { recursive: true }); fs.writeFileSync(path.join(thuis, p), t); };
  mk('socev-app-data/apparaten.json', '{"apparaten":[]}'); mk('.claude.json', '{}'); mk('.socev-geheim/nood-pod.key', SLEUTEL); mk('.socev-geheim/knop-app.key', 'a'.repeat(64));
  fs.mkdirSync(nep, { recursive: true });
  const tsv = path.join(T, 'sleutels.tsv');
  fs.writeFileSync(tsv, 'naam\tdoel\tbron\tvorm\tnodig\nKNOP_APP_KEY_B64\tbestand\tpod-bestand:' + path.join(thuis, '.socev-geheim/knop-app.key') + '\tb64\tja\n');
  const ssh = path.join(T, 'ssh');
  fs.writeFileSync(ssh, '#!/usr/bin/env bash\nNEP=' + JSON.stringify(nep) + '\nop="${@: -1}"\nset -- $op\nshift 2\ncase "$2" in\n' +
    '  ontvang) cat > "$NEP/$3.age"; [ "$(sha256sum < "$NEP/$3.age" | cut -c1-64)" = "$4" ] || exit 5; echo "{\\"ok\\":true}" ;;\n  *) exit 2 ;;\nesac\n', { mode: 0o755 });
  let age = ECHTE_AGE, id1 = null, id2 = null, ontv = NEP1, ontv2 = NEP2;
  if (echt) { const a = keygen(T, 'id1.txt'), b = keygen(T, 'id2.txt'); id1 = a.id; id2 = b.id; ontv = a.pub; ontv2 = b.pub; }
  else {
    age = path.join(T, 'age');
    // nep-age: noteert elke -r als stanza-regel, dan de platte inhoud
    fs.writeFileSync(age, '#!/usr/bin/env bash\nr=()\nwhile [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift ;; -r) r+=("$2"); shift ;; esac; shift; done\n' +
      '{ printf "age-encryption.org/v1\\n"; for x in "${r[@]}"; do printf -- "-> X25519 %s\\n" "$x"; done; printf -- "--- nep\\n"; cat; } > "$o"\n', { mode: 0o755 });
  }
  const o2 = path.join(T, 'ontgrendel-ontvanger.txt');
  const s = { primair: true, klok: Date.parse('2026-11-25T12:00:00Z') };
  const opties = () => ({ nu: () => s.klok, thuis: thuis, werk: path.join(thuis, 'uitwijk-warm'), tmp: T, age: age, ontvanger: ontv, ontvanger2Pad: o2, ssh: ssh, sshArgs: ['r230'], tsv: tsv,
    chart: path.join(T, 'geen-chart'), env: { PATH: process.env.PATH, HOME: thuis }, dbs: {}, standin: false,
    kant: () => 'olares', primair: () => s.primair, standVps: () => false });
  return { T, thuis, nep, o2, opties, id1, id2, ontv, ontv2, s };
}
function opent(w, f, n) {   // true = dit bestand gaat open met identiteit n (echt) / noemt ontvanger n (nep)
  if (echt) { try { cp.execFileSync(ECHTE_AGE, ['-d', '-i', n === 1 ? w.id1 : w.id2, f], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch (e) { return false; } }
  return fs.readFileSync(f, 'utf8').split('\n').includes('-> X25519 ' + (n === 1 ? w.ontv : w.ontv2));
}
function ontvangers(w, f) { return [opent(w, f, 1), opent(w, f, 2)]; }

test('tweede ontvanger: zonder bestand alleen de vastgepinde; geldig bestand = beide (elke soort, opnieuw ingepakt); nood-pod.key nooit in de bundel', async () => {
  const w = warmOpzet();
  const m = W.maak(w.opties());
  let r = await m.ronde(); await m.appTik();
  assert.strictEqual(r.uitkomst, 'ok', JSON.stringify(r));
  for (const sx of ['kern', 'geheimen', 'app-data']) assert.deepStrictEqual(ontvangers(w, path.join(w.nep, sx + '.age')), [true, false], sx + ' zonder bestand');
  assert.ok(!m.stand().ontvanger2);
  fs.writeFileSync(w.o2, w.ontv2 + '\n');
  w.s.klok += 20000;
  r = await m.ronde(); await m.appTik();
  assert.strictEqual(r.uitkomst, 'ok', JSON.stringify(r));
  for (const sx of ['kern', 'geheimen', 'app-data']) assert.deepStrictEqual(ontvangers(w, path.join(w.nep, sx + '.age')), [true, true], sx + ' met bestand');
  assert.deepStrictEqual(m.stand().ontvanger2, { aan: true, fout: undefined });
  if (echt) {   // inhoud van de geheimenbundel: wel de knopsleutel, nooit de nood-podsleutel
    const g = cp.execFileSync(ECHTE_AGE, ['-d', '-i', w.id2, path.join(w.nep, 'geheimen.age')]).toString();
    assert.match(g, /^KNOP_APP_KEY_B64=/m); assert.ok(!g.includes(SLEUTEL) && !g.includes(Buffer.from(SLEUTEL).toString('base64')));
  }
  const kern = m._kernLijst(false);
  assert.ok(!kern.some((f) => /socev-geheim/.test(f)), 'kern bevat .socev-geheim niet');
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'warme-staat.js'), 'utf8').includes('nood-pod.key'));
  // weer weg = weer alleen de vastgepinde
  fs.rmSync(w.o2);
  await m.ronde();
  assert.deepStrictEqual(ontvangers(w, path.join(w.nep, 'kern.age')), [true, false]);
});

test('tweede ontvanger ongeldig: alleen de vastgepinde, zichtbare fout (ronde deels); nooit alleen de tweede', async () => {
  const w = warmOpzet();
  const m = W.maak(w.opties());
  for (const slecht of [w.ontv2.slice(0, -1) + (w.ontv2.endsWith('q') ? 'p' : 'q'), w.ontv2 + '\n' + w.ontv2, 'age1kort', w.ontv, '']) {
    fs.writeFileSync(w.o2, slecht + '\n');
    const r = await m.ronde();
    assert.strictEqual(r.uitkomst, 'deels', 'fout zichtbaar: ' + slecht.slice(0, 12));
    assert.ok(/ontvanger2/.test(r.fout), r.fout);
    assert.ok(m.stand().ontvanger2 && m.stand().ontvanger2.aan === false && m.stand().ontvanger2.fout);
    for (const sx of ['kern', 'geheimen']) assert.deepStrictEqual(ontvangers(w, path.join(w.nep, sx + '.age')), [true, false], sx);
  }
  fs.rmSync(w.o2);
  const r = await m.ronde();
  assert.strictEqual(r.uitkomst, 'ok'); assert.ok(!m.stand().ontvanger2);
});

test('verseRonde (A2): app-data zonder 15 s-rem, geen stand-in, geeft de sha van de gedeelde app-data', async () => {
  const w = warmOpzet();
  const m = W.maak(Object.assign(w.opties(), { standin: undefined, releaseSha: () => 'abcdef123456', releaseDir: () => w.T }));
  await m.appTik();
  const sha1 = m.appDataDuw();
  assert.match(sha1, /^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(w.thuis, 'socev-app-data/apparaten.json'), '{"apparaten":[1]}');
  w.s.klok += 1000;
  assert.strictEqual(await m.appTik(), 'wacht', 'gewone peiling: 15 s-rem');
  const v = await m.verseRonde(5000);
  assert.strictEqual(v.app, 'ok'); assert.ok(v.staat_sha256 && v.staat_sha256 !== sha1, JSON.stringify(v));
  assert.strictEqual(v.staat_sha256, m.appDataDuw());
  assert.ok(!m.stand().standin, 'geen stand-in-ronde');
  w.s.primair = false;
  assert.strictEqual((await m.verseRonde(1000)).uitkomst, 'rol');
});
