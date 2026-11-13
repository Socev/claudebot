'use strict';
// wv2991: OVIS Personeelsscherm fase 0 — personeelsscherm.js met een nep-D1 (node:sqlite, zelfde schema) en een nep-Cloudflare-API.
// Verzonnen gegevens; geen netwerk. PS_MODULE=<pad> toetst een andere kopie (kruisproef).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PS = require(process.env.PS_MODULE || path.join(__dirname, '..', 'personeelsscherm.js'));

function nepD1() {
  const sq = new DatabaseSync(':memory:');
  const log = [];
  const d1 = async (batch) => {
    log.push(batch.map((b) => b.sql));
    sq.exec('BEGIN');
    try {
      const uit = batch.map(({ sql, params }) => {
        const r = sq.prepare(sql), p = params || [];
        if (/^\s*select|returning/is.test(sql)) return { results: r.all(...p).map((x) => ({ ...x })), meta: {} };
        return { results: [], meta: { changes: Number(r.run(...p).changes) } };
      });
      sq.exec('COMMIT'); return uit;
    } catch (e) { sq.exec('ROLLBACK'); throw e; }
  };
  return { sq, d1, log };
}
function nepCf(opts = {}) {
  const calls = [];
  const cf = async (methode, pad, body) => {
    calls.push({ methode, pad, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
    if (opts.faal && opts.faal(methode, pad)) return { status: 500, j: { success: false, errors: [{ code: 1 }] } };
    if (methode === 'POST' && /\/access\/service_tokens$/.test(pad)) return { status: 200, j: { success: true, result: { id: 'tok-1', client_id: 'a'.repeat(32) + '.access', client_secret: 'b'.repeat(64), expires_at: '2027-11-13T10:00:00Z' } } };
    return { status: 200, j: { success: true, result: {} } };
  };
  return { cf, calls };
}
function opzet(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  fs.mkdirSync(path.join(dir, 'geheim'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'geheim', 'teken-ed25519.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ account: 'acc', access_app_id: 'app-1', eigenaar: 'eigenaar@voorbeeld.nl',
    access_app: { name: 'Personeelsscherm', domain: 'personeel.socev.dev', type: 'self_hosted', session_duration: '720h' } }));
  const D = nepD1(), C = nepCf(o), meld = [];
  for (const q of PS.D1_SCHEMA) D.sq.exec(q);   // zoals de Worker het al zette
  let klok = o.nu || Date.parse('2026-11-16T09:00:00Z');   // maandag 10:00 in Amsterdam
  const m = PS.maak({ dir, d1: D.d1, cf: C.cf, nu: () => klok, melding: async (k, t) => { meld.push({ k, t }); }, fout: () => {} });
  return { m, D, C, meld, dir, publicKey, zet: (t) => { klok = t; }, nu: () => klok };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function koppelRij(D, code, t, opts = {}) {
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: opts.bits || 3072 });
  D.sq.prepare('INSERT INTO koppel (code_hash, poll_hash, pub, pub_fp, gemaakt, verloopt, land, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha('code:' + code), sha('poll:x'), k.publicKey.export({ type: 'spki', format: 'pem' }), 'fp', t, opts.verloopt || t + 600000, 'NL', opts.ip || '198.51.100.7');
  return k.privateKey;
}

test('scherm: één bestand, niets van buiten, verversen en houdbaarheid erin; leeg = zwart', () => {
  const h = PS.bouwHtml({ gemaakt: 1, houdbaar_tot: 2, leeg: false, logoSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
  assert.match(h, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'none'/);
  assert.match(h, /<meta http-equiv="refresh" content="60">/);
  assert.match(h, /data-houdbaar="2"/);
  assert.doesNotMatch(h.replace(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g, ''), /https?:\/\//);
  assert.doesNotMatch(h, /fetch\(|XMLHttpRequest|WebSocket|import\(/);
  const l = PS.bouwHtml({ gemaakt: 1, houdbaar_tot: 2, leeg: true });
  assert.match(l, /data-soort="leeg"/); assert.match(l, /background:#000/); assert.doesNotMatch(l, /Personeelsscherm<\/h1>/);
});

test('publiceren: getekend, volgnr stijgt, D1 houdt alleen een hoger volgnr; leeg tekent meteen', async () => {
  const { m, D, publicKey, zet, nu } = opzet();
  const d1 = await m.publiceer();
  const r = D.sq.prepare('SELECT volgnr, bytes, sig FROM envelop WHERE id = 1').get();
  const bytes = Buffer.from(r.bytes, 'base64');
  assert.ok(crypto.verify(null, bytes, publicKey, Buffer.from(r.sig, 'base64')), 'handtekening klopt');
  const doc = JSON.parse(bytes);
  assert.strictEqual(doc.v, 1); assert.strictEqual(doc.volgnr, r.volgnr); assert.strictEqual(doc.houdbaar_tot - doc.gemaakt, PS.HOUDBAAR_MS); assert.strictEqual(doc.leeg, false); assert.strictEqual(doc.code, null);
  // een ander mag niets onderschuiven: verkeerde sleutel klopt niet
  const ander = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.ok(!crypto.verify(null, bytes, ander, Buffer.from(r.sig, 'base64')));
  zet(nu() - 1000);   // klok terug: volgnr moet toch stijgen
  const d2 = await m.leeg(true);
  assert.strictEqual(d2.status, 200); assert.strictEqual(d2.body.leeg, true);
  const r2 = D.sq.prepare('SELECT volgnr, bytes FROM envelop WHERE id = 1').get();
  assert.ok(r2.volgnr > d1.volgnr, 'hoger volgnr ook als de klok terugloopt');
  assert.strictEqual(JSON.parse(Buffer.from(r2.bytes, 'base64')).leeg, true);
  // D1 weigert een lager volgnr (bv. een oude pod-kopie)
  D.sq.prepare('INSERT INTO envelop (id, volgnr, bytes, sig, op) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET volgnr = excluded.volgnr, bytes = excluded.bytes, sig = excluded.sig, op = excluded.op WHERE excluded.volgnr > envelop.volgnr').run(1, 'x', 'y', 0);
  assert.strictEqual(D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr, r2.volgnr);
});

test('koppelen: verkeerde code telt, vijf keer fout = dicht; goede code = token met IP-eis, versleuteld voor het kastje, één keer', async () => {
  const { m, D, C, nu, zet, meld, dir } = opzet();
  await m.open();
  assert.ok(Number(D.sq.prepare("SELECT waarde FROM stand WHERE sleutel = 'koppel_open_tot'").get().waarde) > nu());
  const priv = koppelRij(D, '12345678', nu());
  assert.strictEqual((await m.koppel('1234567')).status, 400);
  assert.strictEqual((await m.koppel('87654321')).status, 404);
  const ok = await m.koppel('1234 5678');
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const post = C.calls.find((c) => c.methode === 'POST'), put = C.calls.find((c) => c.methode === 'PUT');
  assert.ok(post && /\/accounts\/acc\/access\/service_tokens$/.test(post.pad)); assert.strictEqual(post.body.name, 'personeelsscherm-pi'); assert.strictEqual(post.body.duration, '8760h');
  assert.strictEqual(put.pad, '/accounts/acc/access/apps/app-1');
  assert.strictEqual(put.body.policies.length, 2);
  assert.deepStrictEqual(put.body.policies[0].include, [{ email: { email: 'eigenaar@voorbeeld.nl' } }]);
  assert.deepStrictEqual(put.body.policies[1].include, [{ service_token: { token_id: 'tok-1' } }]);
  assert.deepStrictEqual(put.body.policies[1].require, [{ ip: { ip: '198.51.100.7/32' } }], 'review MOET 1: IP-eis');
  assert.strictEqual(put.body.policies[1].decision, 'non_identity');
  const rij = D.sq.prepare('SELECT cipher, gebruikt FROM koppel').get();
  const klaar = JSON.parse(crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(rij.cipher, 'base64')));
  assert.strictEqual(klaar.client_id, 'a'.repeat(32) + '.access'); assert.strictEqual(klaar.client_secret, 'b'.repeat(64));
  const st = Object.fromEntries(D.sq.prepare('SELECT sleutel, waarde FROM stand').all().map((x) => [x.sleutel, x.waarde]));
  assert.strictEqual(st.kastje_id, 'a'.repeat(32) + '.access'); assert.strictEqual(st.kastje_ip, '198.51.100.7'); assert.strictEqual(st.koppel_open_tot, undefined);
  // tweede keer dezelfde code = onbekend
  assert.strictEqual((await m.koppel('12345678')).status, 404);
  // nooit het geheim in de stand, een melding of info
  const alles = JSON.stringify([m.info(), meld, await m.appStand(), fs.readFileSync(path.join(dir, 'stand.json'), 'utf8')]);
  assert.ok(!alles.includes('b'.repeat(64)), 'geen geheim'); assert.ok(!alles.includes('198.51.100.7'), 'geen IP');
  assert.strictEqual((await m.appStand()).stand.token.ip_eis, true);
  // vijf foute codes binnen 30 min = dicht, ook voor een goede
  for (let i = 0; i < 3; i++) await m.koppel('1111111' + i);
  koppelRij(D, '22223333', nu());
  assert.strictEqual((await m.koppel('99999999')).status, 404);
  assert.strictEqual((await m.koppel('22223333')).status, 429, 'na vijf foute codes dicht');
  zet(nu() + 31 * 60000);
  assert.strictEqual((await m.koppel('22223333')).status, 404, 'na het venster weer open (code zelf intussen verlopen)');
});

test('koppelen: verlopen code geweigerd; sleutel van 2048 bits geweigerd; mislukt Access-beleid = token meteen weer weg', async () => {
  const a = opzet();
  koppelRij(a.D, '10000001', a.nu() - 700000, { verloopt: a.nu() - 100000 });
  assert.strictEqual((await a.m.koppel('10000001')).status, 404);
  koppelRij(a.D, '10000002', a.nu(), { bits: 2048 });
  assert.strictEqual((await a.m.koppel('10000002')).status, 409);
  const b = opzet({ faal: (meth) => meth === 'PUT' });
  koppelRij(b.D, '10000003', b.nu());
  const r = await b.m.koppel('10000003');
  assert.strictEqual(r.status, 503);
  assert.ok(b.C.calls.some((c) => c.methode === 'DELETE' && /service_tokens\/tok-1$/.test(c.pad)), 'token weer weg');
  assert.strictEqual(b.D.sq.prepare("SELECT COUNT(*) AS n FROM stand WHERE sleutel = 'kastje_id'").get().n, 0);
  assert.strictEqual((await b.m.appStand()).stand.gekoppeld, false);
});

test('wv3012: nieuw token nog niet bekend (400/12130) = beleid opnieuw; mislukt koppelen geeft de code vrij met de stap in de melding', async () => {
  // Cloudflare kent een vers service token niet meteen: twee keer 12130, daarna goed → gekoppeld
  let n = 0;
  const a = opzet();
  const cfEcht = a.C.cf;
  a.C.calls.length = 0;
  const m = PS.maak({ dir: a.dir, d1: a.D.d1, nu: a.nu, melding: async () => {}, fout: () => {},
    cf: async (meth, pad, body) => { if (meth === 'PUT' && body && body.policies && body.policies.length === 2 && n++ < 2) return { status: 400, j: { success: false, errors: [{ code: 12130 }] } }; return cfEcht(meth, pad, body); } });
  koppelRij(a.D, '20000001', a.nu());
  const ok = await m.koppel('20000001');
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(n, 3, 'twee keer 12130, derde keer goed');
  // token maken faalt: code weer vrij (gebruikt 0), melding met stap, en dezelfde code werkt daarna
  const b = opzet({ faal: (meth, pad) => meth === 'POST' && /service_tokens$/.test(pad) });
  koppelRij(b.D, '20000002', b.nu());
  const r = await b.m.koppel('20000002');
  assert.strictEqual(r.status, 503);
  assert.match(r.body.fout, /stap token maken: Cloudflare gaf HTTP 500/);
  assert.strictEqual(b.D.sq.prepare('SELECT gebruikt FROM koppel').get().gebruikt, 0, 'code vrijgegeven');
  assert.doesNotMatch(r.body.fout, /b{20}/, 'geen geheim in de melding');
  // ander beleidfout (geen 12130) = niet herhalen, code vrij
  const c = opzet({ faal: (meth) => meth === 'PUT' });
  koppelRij(c.D, '20000003', c.nu());
  const r2 = await c.m.koppel('20000003');
  assert.strictEqual(r2.status, 503); assert.match(r2.body.fout, /stap beleid/);
  assert.strictEqual(c.C.calls.filter((x) => x.methode === 'PUT').length, 2, 'één poging met token + één keer terugzetten');
  assert.strictEqual(c.D.sq.prepare('SELECT gebruikt FROM koppel').get().gebruikt, 0);
  assert.strictEqual((await c.m.koppel('20000003')).status, 503, 'zelfde code opnieuw te proberen (niet 404)');
});

test('intrekken: eerst D1 dicht, dan beleid alleen eigenaar, dan token weg; faalt Cloudflare, dan maakt de tik het af', async () => {
  const { m, D, C, nu } = opzet();
  koppelRij(D, '12345678', nu());
  assert.strictEqual((await m.koppel('12345678')).status, 200);
  const n0 = C.calls.length;
  const r = await m.intrek();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(D.sq.prepare("SELECT COUNT(*) AS n FROM stand WHERE sleutel IN ('kastje_id','kastje_ip')").get().n, 0);
  const na = C.calls.slice(n0);
  assert.strictEqual(na[0].methode, 'PUT'); assert.strictEqual(na[0].body.policies.length, 1);
  assert.ok(na.some((c) => c.methode === 'DELETE' && /tok-1$/.test(c.pad)));
  assert.strictEqual((await m.appStand()).stand.gekoppeld, false);
  // Cloudflare stuk tijdens intrekken
  const o = { faal: (meth) => meth === 'DELETE' };
  const b = opzet(o);
  koppelRij(b.D, '12345678', b.nu());
  // koppelen lukt (DELETE wordt pas bij intrekken gebruikt)
  assert.strictEqual((await b.m.koppel('12345678')).status, 200);
  const r2 = await b.m.intrek();
  assert.strictEqual(r2.status, 503);
  assert.strictEqual(b.D.sq.prepare("SELECT COUNT(*) AS n FROM stand WHERE sleutel = 'kastje_id'").get().n, 0, 'D1 al dicht');
  assert.strictEqual(b.m.info().intrek_open, true);
  b.C.calls.length = 0;
  o.faal = null;   // Cloudflare weer goed: de tik maakt het af
  await b.m.tik();
  assert.ok(b.C.calls.some((c) => c.methode === 'DELETE' && /tok-1$/.test(c.pad)), 'tik trekt het token alsnog in');
  assert.strictEqual(b.m.info().intrek_open, false);
});

test('tik: tekent opnieuw na 6 uur; meldt een vreemd adres één keer en stilte in werktijd één keer per dag', async () => {
  const { m, D, nu, zet, meld } = opzet();
  koppelRij(D, '12345678', nu());
  await m.koppel('12345678');
  await m.tik();
  const v1 = D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr;
  zet(nu() + 60000); await m.tik();
  assert.strictEqual(D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr, v1, 'niet elke tik');
  zet(nu() + 6 * 3600000 + 1); await m.tik();
  assert.ok(D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr > v1, 'na 6 uur opnieuw');
  const t = nu();
  D.sq.prepare("INSERT INTO stand (sleutel, waarde) VALUES ('vreemd', ?)").run(JSON.stringify({ op: t, land: 'XX' }));
  await m.tik(); await m.tik();
  assert.strictEqual(meld.filter((x) => /vreemd/.test(x.k)).length, 1, 'vreemd één keer');
  // stil: maandag 16-11 is gekoppeld om 09:00Z; nu 15:00Z (16:00 Amsterdam) zonder hartslag
  const stil = meld.filter((x) => /stil/.test(x.k)).length;
  assert.ok(stil <= 1);
  zet(Date.parse('2026-11-17T09:00:00Z')); await m.tik(); await m.tik();
  assert.strictEqual(meld.filter((x) => /stil/.test(x.k)).length, stil + 1, 'volgende werkdag één keer');
  zet(Date.parse('2026-11-21T10:00:00Z')); await m.tik();   // zaterdag
  assert.strictEqual(meld.filter((x) => /stil/.test(x.k)).length, stil + 1, 'niet in het weekend');
  // met hartslag geen melding
  zet(Date.parse('2026-11-23T09:00:00Z'));
  D.sq.prepare("INSERT INTO hartslag (id, op, json, ip, land, kastje_id) VALUES (1, ?, '{\"temp_c\":51}', '198.51.100.7', 'NL', 'x') ON CONFLICT (id) DO UPDATE SET op = excluded.op").run(nu() - 60000);
  await m.tik();
  assert.strictEqual(meld.filter((x) => /stil/.test(x.k)).length, stil + 1);
  const st = (await m.appStand()).stand;
  assert.strictEqual(st.kastje.temp_c, 51); assert.ok(!JSON.stringify(st).includes('198.51.100.7'), 'geen IP naar de app');
});

test('werktijd: ma–vr 07:30–18:00 Amsterdam', () => {
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-16T06:31:00Z')), true);   // ma 07:31 CET
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-16T06:29:00Z')), false);
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-16T16:59:00Z')), true);   // 17:59
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-16T17:00:00Z')), false);
  assert.strictEqual(PS.inWerktijd(Date.parse('2026-11-14T10:00:00Z')), false);  // zaterdag
});

// ── wv3005 fase 1: inhoud, registerrij als poort (verzonnen namen en data) ──
function fase1(o = {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-vault-'));
  const map = path.join(vault, '10_Zakelijk/Tolgaarde/Medewerkers');
  fs.mkdirSync(map, { recursive: true });
  const pag = (f, fm) => fs.writeFileSync(path.join(map, f + '.md'), '---\n' + Object.entries(fm).map(([k, v]) => k + ': ' + v).join('\n') + '\n---\n\ntekst\n');
  pag('Fenna Testerink', { type: 'medewerker', naam: 'Fenna Testerink', status: 'in dienst (onbepaald)', geboortedatum: '1990-11-16' });
  pag('Tygo Proefman', { type: 'medewerker', naam: 'Tygo Proefman', status: 'in dienst (onbepaald)', geboortedatum: '1985-11-19' });
  pag('Oud Collega', { type: 'medewerker', naam: 'Oud Collega', status: 'uit dienst per 2025-01-31', geboortedatum: '1970-11-17' });
  pag('Ver Weg', { type: 'medewerker', naam: 'Ver Weg', status: 'in dienst (onbepaald)', geboortedatum: '1970-12-25' });
  pag('Overzicht', { type: 'overzicht', naam: 'Personeelsoverzicht' });
  const reg = path.join(vault, 'register.json');
  const zetReg = (aan, tekst) => fs.writeFileSync(reg, JSON.stringify({ rijen: [{ id: 'ander', status: 'aan', tekst: [PS.VOLLE_NAAM_ZIN + ' ' + PS.INFO_ZIN] }].concat(aan ? [{ id: 'personeelsscherm-vast', status: aan === true ? 'aan' : aan, tekst: tekst || ['i. artsen van vandaag (voornaam en dagdeel)'] }] : []) }));
  zetReg(o.aan, o.tekst);
  const vragenPad = path.join(vault, 'vragen.json');
  fs.writeFileSync(vragenPad, JSON.stringify(o.vragen || {}));
  const ent = (naam) => [{ rol: 'betreft', naam, object_id: 'o-' + naam }, { rol: 'context', naam: 'Huisartsenpraktijk Tolgaarde B.V.' }];
  const rijen = [
    { feed: 'rooster-tg-artsen', soort: 'dienst', titel: 'WK', status: 'actief', event_id: 1, hele_dag: true, begin_datum: '2026-11-16', eind_datum: '2026-11-16', entiteiten: ent('Wietske Kwakkel') },
    { feed: 'rooster-tg-artsen', soort: 'dienst', titel: 'JB 8-12 uur', status: 'actief', event_id: 2, hele_dag: true, begin_datum: '2026-11-16', eind_datum: '2026-11-16', entiteiten: ent('Jorrit Bakkerus') },
    { feed: 'rooster-tg-artsen', soort: 'dienst', titel: 'Hidde Invaller', status: 'actief', event_id: 3, hele_dag: true, begin_datum: '2026-11-16', eind_datum: '2026-11-16', entiteiten: ent('Hidde Invaller') },
    { feed: 'rooster-tg-artsen', soort: 'dienst', titel: 'Hugo Kortnaam', status: 'actief', event_id: 6, hele_dag: true, begin_datum: '2026-11-16', eind_datum: '2026-11-16', entiteiten: ent('Hugo Kortnaam') },
    { feed: 'rooster-tg-artsen', soort: 'dienst', titel: 'Ed', status: 'actief', event_id: 7, hele_dag: true, begin_datum: '2026-11-16', eind_datum: '2026-11-16', entiteiten: ent('Ed Kort') },
    { feed: 'rooster-tg-artsen', soort: 'dienst', titel: 'SvH 13-17', status: 'actief', event_id: 8, hele_dag: true, begin_datum: '2026-11-16', eind_datum: '2026-11-16', entiteiten: ent('Sanne van Hoorn') },
    { feed: 'rooster-tg-artsen', soort: 'dienst', titel: 'SvH 8-12', status: 'actief', event_id: 9, hele_dag: true, begin_datum: '2026-11-16', eind_datum: '2026-11-16', entiteiten: ent('Sanne van Hoorn') },
    { feed: 'rooster-tg-artsen', soort: 'dienst', titel: 'MD', status: 'actief', event_id: 4, hele_dag: true, begin_datum: '2026-11-17', eind_datum: '2026-11-17', entiteiten: ent('Morgen Dokter') },
    { feed: 'rooster-gh-artsen', soort: 'dienst', titel: 'GH', status: 'actief', event_id: 5, hele_dag: true, begin_datum: '2026-11-16', eind_datum: '2026-11-16', entiteiten: ent('Andere Praktijk') },
    { feed: 'google-hagro', sync_agenda: 'hagro', soort: 'afspraak', titel: 'HAGRO-vergadering', status: 'actief', event_id: 10, hele_dag: false, begin_datum: '2026-11-19', begin_tijd: '2026-11-19T15:00:00+00:00', eind_tijd: '2026-11-19T17:00:00+00:00', entiteiten: [] },
    { feed: 'google-hagro', sync_agenda: 'hagro', soort: 'afspraak', titel: 'Privé: gesprek', status: 'actief', event_id: 11, hele_dag: false, begin_datum: '2026-11-20', begin_tijd: '2026-11-20T10:00:00+00:00', entiteiten: [] },
    { feed: 'google-hagro', sync_agenda: 'hagro', soort: 'afspraak', titel: 'Overleg', status: 'actief', event_id: 12, hele_dag: false, begin_datum: '2026-11-21', begin_tijd: '2026-11-21T10:00:00+00:00', entiteiten: ent('Iemand Anders') },
    { feed: 'google-hagro', sync_agenda: 'hagro', soort: 'afspraak', titel: 'Bel 0612345678', status: 'actief', event_id: 13, hele_dag: true, begin_datum: '2026-11-22', entiteiten: [] },
    { feed: 'google-hagro', sync_agenda: 'hagro', soort: 'afspraak', titel: 'Geannuleerd overleg', status: 'geannuleerd', event_id: 14, hele_dag: true, begin_datum: '2026-11-23', entiteiten: [] },
    { feed: 'google-werk', soort: 'afspraak', titel: 'Werkafspraak geheim', status: 'actief', event_id: 15, hele_dag: true, begin_datum: '2026-11-18', entiteiten: [] },
    { feed: 'google-hagro', sync_agenda: 'hagro', soort: 'afspraak', titel: 'Nieuwjaarsborrel', status: 'actief', event_id: 16, hele_dag: true, begin_datum: '2026-12-18', entiteiten: [] },
  ];
  const weer = { current: { temp: 6.4, weather: [{ id: 801, description: 'licht bewolkt' }] }, daily: [{ dt: 1763290800, temp: { max: 8.5, min: 3.4 } }, { dt: 1763377200, temp: { max: 7 }, weather: [{ id: 800 }] }] };
  const z = opzet(o);
  const tel = { tijdlijn: 0, weer: 0 };
  const m = PS.maak({ dir: z.dir, vault, registerPad: reg, vragenPad, d1: z.D.d1, cf: z.C.cf, nu: z.nu, melding: async () => {}, fout: () => {},
    tijdlijn: async () => { tel.tijdlijn++; if (o.tijdlijnFaalt) throw new Error('weg'); return rijen; }, weer: async () => { tel.weer++; return weer; } });
  return Object.assign(z, { m, zetReg, tel, vault, vragenPad });
}
const html = (D) => { const r = D.sq.prepare('SELECT bytes FROM envelop WHERE id = 1').get(); return JSON.parse(Buffer.from(r.bytes, 'base64')).html; };

test('fase 1 kruisproef: zonder registerrij geen artsen of jarigen (ook niet als de rij uit staat), wel dag, weer en agenda', async () => {
  for (const aan of [false, 'uit']) {
    const { m, D } = fase1({ aan });
    const i = await m.verzamel(Date.parse('2026-11-16T09:00:00Z'));
    assert.strictEqual(i.artsen, null); assert.strictEqual(i.jarig, null); assert.strictEqual(i.persoonsvakken, false);
    await m.publiceer();
    const h = html(D);
    assert.doesNotMatch(h, /Artsen vandaag|Jarig deze week|Wietske|Jorrit|Fenna|Tygo|Waarnemer/);
    assert.match(h, /HAGRO-vergadering/); assert.match(h, /Licht bewolkt/); assert.match(h, /Komende weken/);
    assert.doesNotMatch(h, /Proefscherm|wordt ingericht/);
  }
});

test('fase 1 met registerrij: voornaam + dagdeel, waarnemer zonder naam, jarigen met dag en maand; nooit achternaam, jaar of roostertitel', async () => {
  const { m, D } = fase1({ aan: true });
  const i = await m.verzamel(Date.parse('2026-11-16T09:00:00Z'));
  assert.deepStrictEqual(i.artsen, [{ naam: 'Jorrit', wanneer: 'ochtend' }, { naam: 'Sanne', wanneer: 'hele dag' }, { naam: 'Wietske', wanneer: 'hele dag' }, { naam: 'Waarnemer', wanneer: 'hele dag' }, { naam: 'Waarnemer', wanneer: 'hele dag' }, { naam: 'Waarnemer', wanneer: 'hele dag' }]);
  assert.deepStrictEqual(i.jarig, [{ naam: 'Fenna', wanneer: 'vandaag', nu: true }, { naam: 'Tygo', wanneer: 'do 19 nov', nu: false }]);   // uit dienst en buiten de week weg
  await m.publiceer();
  const h = html(D);
  assert.match(h, /Wietske/); assert.match(h, /Fenna/);
  assert.doesNotMatch(h, /Kwakkel|Bakkerus|Invaller|Testerink|Proefman|Oud|Ver Weg|1990|1985|JB 8-12|Andere|Morgen|Hugo|Kortnaam|Ed Kort|van Hoorn|SvH/);
});

test('fase 1 agenda: alleen HAGRO, actief, zonder privé/persoon/nummer, gesorteerd; tijd in Amsterdam', async () => {
  const { m } = fase1({ aan: true });
  const i = await m.verzamel(Date.parse('2026-11-16T09:00:00Z'));
  assert.deepStrictEqual(i.agenda.map((a) => a.titel), ['HAGRO-vergadering', 'Nieuwjaarsborrel']);
  assert.strictEqual(i.agenda[0].tijd, '16:00–18:00'); assert.strictEqual(i.agenda[0].wd, 'do'); assert.strictEqual(i.agenda[1].tijd, 'hele dag');
});

test('fase 1 tik: inhoud elke 30 min, publiceert bij verandering; registerrij weg = volgende tik zonder namen; weer hooguit elke 2 uur', async () => {
  const f = fase1({ aan: true });
  let t = Date.parse('2026-11-16T09:00:00Z'); f.zet(t);
  await f.m.tik();
  assert.match(html(f.D), /Wietske/);
  const v1 = f.D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr;
  t += 5 * 60000; f.zet(t); await f.m.tik();
  assert.strictEqual(f.D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr, v1, 'niets veranderd = niet opnieuw');
  f.zetReg(false);
  t += 5 * 60000; f.zet(t); await f.m.tik();
  assert.doesNotMatch(html(f.D), /Wietske|Fenna|Artsen vandaag/, 'zonder rij meteen weg, niet pas na 30 min');
  assert.strictEqual(f.m.info().persoonsvakken, false);
  assert.ok(f.tel.weer <= 1, 'weer niet elke tik');
  t += 3 * 3600000; f.zet(t); await f.m.tik();
  assert.strictEqual(f.tel.weer, 2);
});

test('fase 1: oude stand met namen en registerrij weg → publiceer laat ze weg; agenda faalt → vak blijft zoals het was', async () => {
  const f = fase1({ aan: true });
  await f.m.verzamel(f.nu());
  f.zetReg(false);
  await f.m.publiceer();
  assert.doesNotMatch(html(f.D), /Wietske|Fenna/);
  const g = fase1({ aan: false, tijdlijnFaalt: true });
  const s = path.join(g.dir, 'stand.json');
  fs.writeFileSync(s, JSON.stringify({ inhoud: { datum: '2026-11-16', agenda: [{ wd: 'do', dg: '19', mn: 'nov', titel: 'Eerder gelezen', tijd: '16:00', label: 'HAGRO' }] } }));
  const i = await g.m.verzamel(g.nu());
  assert.deepStrictEqual(i.agenda.map((a) => a.titel), ['Eerder gelezen']); assert.strictEqual(i.bronnen.agenda, false);
});

test('fase 1 info: alleen tellingen, geen namen', async () => {
  const f = fase1({ aan: true });
  await f.m.verzamel(f.nu());
  const j = JSON.stringify(f.m.info());
  assert.doesNotMatch(j, /Wietske|Fenna|Jorrit|HAGRO-vergadering/);
  assert.match(j, /"vakken":\{"agenda":2,"artsen":6,"jarig":2,"weer":true,"info":0,"volle_naam":false\}/);
});

// ── wv3015 fase 2: volle naam achter de nieuwe registertekst, infoschermen alleen met Davids Ja op precies die kaart ──
const NIEUW = ['i. ... artsen van vandaag (voor- en achternaam, ook waarnemers, en dagdeel) ... Vrije tekst (weekbericht, mededeling, infoschermen) alleen na Davids knop per bericht of per set ...'];
const SET = { set: '2026-11-13', sleutel: 'wv9001', kaart: { titel: 'Personeelsscherm — deze infoschermen tonen?', waarom: 'Proef.', waar: 'overal', deadline: '2026-11-20', na: ['Ja = op het scherm.'] },
  schermen: [
    { kop: 'Proefinfo een', intro: 'Inleiding.', punten: [{ titel: 'Punt A', tekst: 'Tekst A.' }, { titel: 'Punt B', tekst: 'Tekst B.' }], bron: 'Verzonnen bron 1', tot: '2026-12-11' },
    { kop: 'Proefinfo twee', intro: '', punten: [{ titel: 'Punt C', tekst: 'Tekst C.' }], bron: 'Verzonnen bron 2', tot: '2026-11-17' },
  ] };
SET.vraag_id = PS._t.fnv('voorjou:' + SET.sleutel + ':kaart');
// Ja op de kaart zoals de module hem opbouwt; voor een ongeldige set de kaart met de hand (David zag die tekst), zodat alleen de vormtoets weigert
const kaartVan = (set) => (PS._t.setKaart(set) || { kaart: { titel: set.kaart.titel, waarom: set.kaart.waarom, waar: set.kaart.waar, deadline: set.kaart.deadline,
  stappen: set.schermen.map((x) => PS._t.stapTekst(x, set.set)).concat(set.kaart.na) } }).kaart;
const jaVoor = (set, extra) => ({ ['job1:' + set.vraag_id]: { antwoord: Object.assign({ keuze: 'ja', t: '2026-11-13T12:00:00Z', kaart_hash: PS._t.kaartHash(kaartVan(set)) }, extra || {}) } });
function fase2(o = {}) {
  const f = fase1(Object.assign({ aan: true, tekst: NIEUW }, o));
  if (o.set !== null) fs.writeFileSync(path.join(f.dir, 'infoschermen.json'), JSON.stringify({ sets: [o.set || SET] }));
  return f;
}

test('fase 2 volle naam: alleen met de zin in de registertekst; vaste artsen en waarnemers; andere praktijk en roostertitel nooit', async () => {
  const { m, D } = fase2({ set: null });
  const i = await m.verzamel(Date.parse('2026-11-16T09:00:00Z'));
  assert.strictEqual(i.volle_naam, true);
  assert.deepStrictEqual(i.artsen.map((a) => a.naam), ['Ed Kort', 'Hidde Invaller', 'Hugo Kortnaam', 'Jorrit Bakkerus', 'Sanne van Hoorn', 'Wietske Kwakkel']);
  await m.publiceer();
  const h = html(D);
  assert.match(h, /Ed Kort/); assert.match(h, /Hidde Invaller/); assert.match(h, /Sanne van Hoorn/); assert.doesNotMatch(h, /Waarnemer|Andere Praktijk|Morgen Dokter|JB 8-12|Testerink|1990/);
  // kruisproef: oude tekst (de zin staat alleen in een ándere rij) = voornaam en Waarnemer
  const g = fase2({ set: null, tekst: ['i. artsen van vandaag (voornaam en dagdeel)'] });
  const j = await g.m.verzamel(Date.parse('2026-11-16T09:00:00Z'));
  assert.strictEqual(j.volle_naam, false); assert.ok(j.artsen.some((a) => a.naam === 'Waarnemer')); assert.ok(!j.artsen.some((a) => / /.test(a.naam)));
  // kruisproef: rij uit met de nieuwe tekst = geen artsen
  const u = fase2({ set: null, aan: 'uit' });
  assert.strictEqual((await u.m.verzamel(Date.parse('2026-11-16T09:00:00Z'))).artsen, null);
});

test('fase 2 volle naam: rij terug naar de oude tekst → publiceer zonder achternamen, ook vóór het volgende verzamelen; tik verzamelt meteen', async () => {
  const f = fase2({ set: null });
  f.zet(Date.parse('2026-11-16T09:00:00Z'));
  await f.m.tik();
  assert.match(html(f.D), /Hidde Invaller/);
  f.zetReg(true, ['i. artsen van vandaag (voornaam en dagdeel)']);
  await f.m.publiceer();
  assert.doesNotMatch(html(f.D), /Kwakkel|Invaller/);
  f.zet(f.nu() + 5 * 60000); await f.m.tik();
  const h = html(f.D);
  assert.match(h, /Wietske/); assert.match(h, /Waarnemer/); assert.doesNotMatch(h, /Kwakkel|Invaller/);
});

test('fase 2 infoschermen: zonder Ja niets; met Ja op precies deze kaart wel; einddatum telt; kruisproeven', async () => {
  const t = Date.parse('2026-11-16T09:00:00Z');
  // geen Ja
  let f = fase2();
  assert.deepStrictEqual((await f.m.verzamel(t)).info, []);
  await f.m.publiceer(); assert.doesNotMatch(html(f.D), /Proefinfo/);
  // Ja op de goede kaart
  f = fase2({ vragen: jaVoor(SET) });
  let i = await f.m.verzamel(t);
  assert.deepStrictEqual(i.info.map((x) => x.kop), ['Proefinfo een', 'Proefinfo twee']);
  await f.m.publiceer();
  let h = html(f.D);
  assert.match(h, /<section class="paneel aan" data-s="30">/); assert.strictEqual((h.match(/class="paneel info"/g) || []).length, 2);
  assert.match(h, /Proefinfo een/); assert.match(h, /Bron: Verzonnen bron 1/); assert.match(h, /Info 1\/2/);
  // kruisproeven: Nee, andere hash, tekst na de Ja gewijzigd, vraag-id van een andere kaart, rij zonder het woord infoschermen
  const kruis = [
    ['Nee', fase2({ vragen: jaVoor(SET, { keuze: 'nee' }) })],
    ['andere hash', fase2({ vragen: jaVoor(SET, { kaart_hash: 'f'.repeat(64) }) })],
    ['tekst gewijzigd', fase2({ vragen: jaVoor(SET), set: Object.assign({}, SET, { schermen: [Object.assign({}, SET.schermen[0], { intro: 'Andere inleiding.' }), SET.schermen[1]] }) })],
    ['andere sleutel', fase2({ vragen: jaVoor(SET), set: Object.assign({}, SET, { sleutel: 'wv9002' }) })],
    ['rij zonder infoschermen', fase2({ vragen: jaVoor(SET), tekst: ['i. artsen van vandaag (voor- en achternaam, ook waarnemers)'] })],
    ['rij noemt infoschermen in een ontkenning', fase2({ vragen: jaVoor(SET), tekst: ['i. artsen van vandaag (voor- en achternaam). Nooit infoschermen.'] })],
    ['einddatum > 28 dagen', fase2({ vragen: jaVoor(Object.assign({}, SET, { schermen: [Object.assign({}, SET.schermen[0], { tot: '2026-12-12' })] })), set: Object.assign({}, SET, { schermen: [Object.assign({}, SET.schermen[0], { tot: '2026-12-12' })] }) })],
    ['onbestaande datum', fase2({ vragen: jaVoor(Object.assign({}, SET, { schermen: [Object.assign({}, SET.schermen[0], { tot: '2026-11-31' })] })), set: Object.assign({}, SET, { schermen: [Object.assign({}, SET.schermen[0], { tot: '2026-11-31' })] }) })],
    ['rij uit', fase2({ vragen: jaVoor(SET), aan: 'uit' })],
  ];
  for (const [w, g] of kruis) { assert.deepStrictEqual((await g.m.verzamel(t)).info, [], w); await g.m.publiceer(); assert.doesNotMatch(html(g.D), /Proefinfo/, w); }
  // einddatum: op 18-11 is scherm twee (tot 17-11) weg
  f = fase2({ vragen: jaVoor(SET) });
  i = await f.m.verzamel(Date.parse('2026-11-18T09:00:00Z'));
  assert.deepStrictEqual(i.info.map((x) => x.kop), ['Proefinfo een']);
  // ongeldig scherm in de set (adres) = hele set weg
  const slecht = Object.assign({}, SET, { schermen: [Object.assign({}, SET.schermen[0], { punten: [{ titel: 'Mail', tekst: 'iemand@voorbeeld.nl' }] })] });
  const s2 = fase2({ vragen: jaVoor(Object.assign({}, slecht, { schermen: [SET.schermen[0]] })), set: slecht });
  assert.deepStrictEqual((await s2.m.verzamel(t)).info, []);
  assert.strictEqual(PS._t.infoNorm(slecht.schermen[0]), null);
});

test('fase 2 tik: vrijgave of Ja verschijnt bij de volgende tik (niet pas na 30 min); verlopen scherm verdwijnt bij de dagwissel', async () => {
  const f = fase2({ set: null });
  let t = Date.parse('2026-11-17T09:00:00Z'); f.zet(t);
  await f.m.tik();
  assert.doesNotMatch(html(f.D), /Proefinfo/);
  fs.writeFileSync(path.join(f.dir, 'infoschermen.json'), JSON.stringify({ sets: [SET] }));   // echte volgorde: set vóór de kaart
  t += 5 * 60000; f.zet(t); await f.m.tik();
  assert.doesNotMatch(html(f.D), /Proefinfo/, 'set zonder Ja');
  fs.writeFileSync(f.vragenPad, JSON.stringify(jaVoor(SET)));                                // Davids Ja: alleen vragen.json verandert
  t += 5 * 60000; f.zet(t); await f.m.tik();
  assert.match(html(f.D), /Proefinfo twee/, 'Ja werkt bij de volgende tik');
  fs.writeFileSync(f.vragenPad, '{}');                                                        // Ja weg (bv. na 30 dagen opgeruimd)
  await f.m.publiceer();
  assert.doesNotMatch(html(f.D), /Proefinfo/, 'publiceer controleert de Ja opnieuw');
  t += 5 * 60000; f.zet(t); await f.m.tik();
  assert.doesNotMatch(html(f.D), /Proefinfo/);
  fs.writeFileSync(f.vragenPad, JSON.stringify(jaVoor(SET)));
  t += 5 * 60000; f.zet(t); await f.m.tik();
  assert.match(html(f.D), /Proefinfo twee/);
  t = Date.parse('2026-11-17T23:30:00Z'); f.zet(t); await f.m.tik();   // 18-11 00:30 in Amsterdam
  const h = html(f.D);
  assert.match(h, /Proefinfo een/); assert.doesNotMatch(h, /Proefinfo twee/);
  assert.strictEqual(f.m.info().vakken.info, 1);
});

test('fase 2 rotatie: het script wisselt op de wandklok (30 s hoofdscherm, 20 s per infoscherm) en slaat verlopen panelen over', () => {
  const vm = require('vm');
  const tot = (d) => Date.parse(d + 'T00:00:00+01:00');
  const doc = PS.bouwHtml({ gemaakt: 0, houdbaar_tot: Date.parse('2027-01-01T00:00:00Z'), leeg: false, inhoud: { agenda: [], artsen: null, jarig: null,
    info: [Object.assign({ set: '2026-11-13' }, SET.schermen[0]), Object.assign({ set: '2026-11-13' }, SET.schermen[1])] } });
  const scr = /<script>([\s\S]*?)<\/script>/.exec(doc)[1];
  const panelen = [...doc.matchAll(/<section class="paneel( info)?( aan)?" data-s="(\d+)"(?: data-tot="(\d+)")?/g)].map((m) => {
    const cls = new Set(['paneel'].concat(m[2] ? ['aan'] : []));
    return { s: m[3], tot: m[4] || null, cls, getAttribute: (k) => (k === 'data-s' ? m[3] : k === 'data-tot' ? m[4] || null : null),
      classList: { remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } };
  });
  assert.deepStrictEqual(panelen.map((p) => p.s), ['30', '20', '20']);
  assert.strictEqual(Number(panelen[2].tot), tot('2026-11-18'));
  const zichtbaar = (ms) => {
    const ctx = { document: { getElementById: () => null, querySelectorAll: () => panelen, body: {} }, innerWidth: 1920, innerHeight: 1080, addEventListener() {}, setInterval() {},
      Date: class extends Date { constructor(...a) { super(...(a.length ? a : [ms])); } } };
    vm.runInNewContext(scr, ctx);
    return panelen.map((p) => p.cls.has('aan'));
  };
  const b = Math.floor(Date.parse('2026-11-16T09:00:00Z') / 70000) * 70000;   // begin van een ronde van 70 s
  assert.deepStrictEqual(zichtbaar(b + 5000), [true, false, false]);
  assert.deepStrictEqual(zichtbaar(b + 35000), [false, true, false]);
  assert.deepStrictEqual(zichtbaar(b + 55000), [false, false, true]);
  // na 18-11 00:00 is paneel 3 verlopen: ronde 50 s, paneel 3 nooit meer
  const c = Math.ceil(tot('2026-11-18') / 50000) * 50000;
  for (let k = 0; k < 50; k += 5) assert.strictEqual(zichtbaar(c + k * 1000)[2], false);
  assert.deepStrictEqual(zichtbaar(c + 35000), [false, true, false]);
});

// ── wv3020: in de app bladeren, infoschermen aan/uit, extra pagina aanvragen ──
test('wv3020 uit: meteen een nieuwe envelop zonder dat scherm (hoger volgnr), blijft weg bij de tik; aan = weer erop', async () => {
  const f = fase2({ vragen: jaVoor(SET) });
  let t = Date.parse('2026-11-16T09:00:00Z'); f.zet(t);
  await f.m.tik();
  assert.match(html(f.D), /Proefinfo een/);
  const st = await f.m.appStand();
  const [een, twee] = st.schermen.filter((x) => x.soort === 'info');
  assert.strictEqual(een.titel, 'Proefinfo een'); assert.strictEqual(een.aan, true); assert.strictEqual(twee.aan, true);
  const v0 = f.D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr;
  t += 1000; f.zet(t);
  const r = await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: een.id, aan: false } });
  assert.strictEqual(r.status, 200);
  assert.ok(f.D.sq.prepare('SELECT volgnr FROM envelop').get().volgnr > v0, 'nieuwe envelop');
  let h = html(f.D);
  assert.doesNotMatch(h, /Proefinfo een/); assert.match(h, /Proefinfo twee/); assert.match(h, /Info 1\/1/);
  t += 5 * 60000; f.zet(t); await f.m.tik();
  assert.doesNotMatch(html(f.D), /Proefinfo een/, 'blijft uit na de tik');
  t += 31 * 60000; f.zet(t); await f.m.tik();
  assert.doesNotMatch(html(f.D), /Proefinfo een/, 'blijft uit na opnieuw verzamelen');
  const st2 = await f.m.appStand();
  const e2 = st2.schermen.find((x) => x.id === een.id);
  assert.strictEqual(e2.aan, false); assert.strictEqual(e2.uit, true); assert.match(e2.html, /Staat uit/); assert.match(e2.html, /Proefinfo een/);
  assert.strictEqual(f.m.info().info_uit, 1);
  // weer aan
  const r2 = await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: een.id, aan: true } });
  assert.strictEqual(r2.status, 200);
  h = html(f.D); assert.match(h, /Proefinfo een/); assert.match(h, /Info 2\/2/);
  // alles uit = alleen Komende weken (geen wissel meer)
  await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: een.id, aan: false } });
  await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: twee.id, aan: false } });
  assert.strictEqual((html(f.D).match(/class="paneel info/g) || []).length, 0);
  assert.strictEqual((await f.m.appStand()).schermen[0].looptijd_s, null);
});

test('wv3020 aan alleen met Ja en binnen de looptijd: andere/onbekende id, Ja weg, tekst gewijzigd of verlopen = geweigerd (kruisproeven)', async () => {
  const t = Date.parse('2026-11-16T09:00:00Z');
  const mk = async () => { const f = fase2({ vragen: jaVoor(SET) }); f.zet(t); await f.m.tik(); const st = await f.m.appStand(); return { f, ids: st.schermen.filter((x) => x.soort === 'info').map((x) => x.id) }; };
  let { f, ids } = await mk();
  const aan = (id) => f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id, aan: true } });
  assert.strictEqual((await aan('nietgoed')).status, 400);
  assert.strictEqual((await aan('0123456789abcdef')).status, 409, 'onbekend scherm');
  // Ja weg na het uitzetten
  await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: ids[0], aan: false } });
  fs.writeFileSync(f.vragenPad, '{}');
  assert.strictEqual((await aan(ids[0])).status, 409, 'Ja weg');
  assert.doesNotMatch(html(f.D), /Proefinfo een/);
  f.zet(t + 5 * 60000); await f.m.tik(); assert.doesNotMatch(html(f.D), /Proefinfo/, 'tik haalt de rest weg');
  // tekst na de Ja gewijzigd: oude id bestaat niet meer, nieuwe set heeft geen Ja
  ({ f, ids } = await mk());
  await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: ids[0], aan: false } });
  fs.writeFileSync(path.join(f.dir, 'infoschermen.json'), JSON.stringify({ sets: [Object.assign({}, SET, { schermen: [Object.assign({}, SET.schermen[0], { intro: 'Nieuwe tekst.' }), SET.schermen[1]] })] }));
  assert.strictEqual((await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: ids[0], aan: true } })).status, 409, 'tekst gewijzigd');
  // verlopen: scherm twee loopt tot 17-11; op 18-11 niet meer aan te zetten
  ({ f, ids } = await mk());
  await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: ids[1], aan: false } });
  f.zet(Date.parse('2026-11-18T09:00:00Z'));
  assert.strictEqual((await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: ids[1], aan: true } })).status, 409, 'verlopen');
  assert.doesNotMatch(html(f.D), /Proefinfo twee/);
  // registerrij zonder infoschermen: niets aan te zetten
  ({ f, ids } = await mk());
  await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: ids[0], aan: false } });
  f.zetReg(true, ['i. artsen van vandaag (voor- en achternaam)']);
  assert.strictEqual((await f.m.app({ pad: '/app/personeelsscherm/info', methode: 'POST', body: { id: ids[0], aan: true } })).status, 409, 'rij zonder infoschermen');
});

test('wv3020 voorbeeld per scherm: eigen doek met dat paneel zichtbaar, titel, looptijd, van/tot; hoofdscherm = de envelop', async () => {
  const f = fase2({ vragen: jaVoor(SET) });
  f.zet(Date.parse('2026-11-16T09:00:00Z')); await f.m.tik();
  const st = await f.m.appStand();
  assert.strictEqual(st.schermen.length, 3);
  assert.deepStrictEqual(st.schermen.map((x) => [x.soort, x.titel, x.looptijd_s]), [['hoofd', 'Komende weken', 30], ['info', 'Proefinfo een', 20], ['info', 'Proefinfo twee', 20]]);
  assert.strictEqual(st.schermen[0].html, undefined); assert.strictEqual(st.voorbeeld_html, html(f.D));
  const h = st.schermen[2].html;
  assert.match(h, /<section class="paneel info aan" data-s="20"/); assert.match(h, /<section class="paneel" data-s="30">/); assert.match(h, /Info 2\/2/);
  assert.doesNotMatch(h, /Proefinfo een/); assert.doesNotMatch(h, /data:image\/svg/, 'zonder logo (klein)');
  assert.strictEqual(st.schermen[1].van, '2026-11-13'); assert.strictEqual(st.schermen[1].tot, '2026-12-11');
  // bouwHtml zonder toon = hoofdscherm zichtbaar (zoals de tv zonder script)
  const d = PS.bouwHtml({ gemaakt: 0, houdbaar_tot: 1, leeg: false, inhoud: { agenda: [], info: [Object.assign({}, SET.schermen[0], { set: SET.set })] } });
  assert.match(d, /<section class="paneel aan" data-s="30">/); assert.match(d, /<section class="paneel info" data-s="20"/);
});

test('wv3020 aanvraag: precies één rij met Davids woorden letterlijk; zelfde tekst dezelfde dag = geen tweede; grenzen; mislukt = niets bewaard', async () => {
  const f = fase2({ set: null });
  f.zet(Date.parse('2026-11-16T09:00:00Z'));
  const rijen = []; let faal = false;
  const m = PS.maak({ dir: f.dir, vault: f.vault, registerPad: path.join(f.vault, 'register.json'), vragenPad: f.vragenPad, d1: f.D.d1, cf: f.C.cf, nu: f.nu, melding: async () => {}, fout: () => {},
    werkvoorraad: async (o) => { if (faal) throw new Error('weg'); rijen.push(o); return { id: 4000 + rijen.length }; } });
  const vraag = (tekst) => m.app({ pad: '/app/personeelsscherm/aanvraag', methode: 'POST', body: { tekst } });
  const tekst = 'De griepvaccinatie-campagne: data en wie wat doet';
  let r = await vraag(tekst);
  assert.strictEqual(r.status, 200); assert.strictEqual(rijen.length, 1);
  assert.ok(rijen[0].prompt.includes('«' + tekst + '»'), 'letterlijk');
  assert.match(rijen[0].label, /^machinekamer:personeelsscherm-aanvraag-20261116-[0-9a-f]{8}$/);
  assert.match(rijen[0].prompt, /Personeelsscherm — dit infoscherm tonen\?/); assert.match(rijen[0].prompt, /"aanvraag"/);
  r = await vraag('  de GRIEPVACCINATIE-campagne:   data en wie wat doet ');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.al, true); assert.strictEqual(rijen.length, 1, 'geen tweede rij');
  assert.strictEqual((await vraag('')).status, 400); assert.strictEqual((await vraag('x'.repeat(501))).status, 400); assert.strictEqual(rijen.length, 1);
  // regeleinden en stuurtekens worden spaties (één regel in de opdracht)
  await vraag('Regel een\nregel twee drie'); assert.ok(rijen[1].prompt.includes('«Regel een regel twee drie»'));
  faal = true; r = await vraag('Iets dat mislukt'); assert.strictEqual(r.status, 503); faal = false;
  assert.strictEqual((await m.appStand()).aanvragen.length, 2, 'mislukte aanvraag niet bewaard');
  await vraag('Drie'); await vraag('Vier vier'); await vraag('Vijf vijf');
  r = await vraag('Zes zes'); assert.strictEqual(r.status, 429); assert.strictEqual(rijen.length, 5);
  f.zet(Date.parse('2026-11-17T09:00:00Z')); assert.strictEqual((await vraag('Zes zes')).status, 200, 'volgende dag weer');
  // zonder werkvoorraad-koppeling: nette weigering
  assert.strictEqual((await f.m.app({ pad: '/app/personeelsscherm/aanvraag', methode: 'POST', body: { tekst } })).status, 503);
});

test('wv3020 aanvraag-stand: wacht → kaart (set met aanvraag, nog geen Ja) → aan (Ja); nooit het wv-nummer', async () => {
  const f = fase2({ set: null });
  f.zet(Date.parse('2026-11-16T09:00:00Z'));
  const m = PS.maak({ dir: f.dir, vault: f.vault, registerPad: path.join(f.vault, 'register.json'), vragenPad: f.vragenPad, d1: f.D.d1, cf: f.C.cf, nu: f.nu, fout: () => {},
    werkvoorraad: async () => ({ id: 4321 }) });
  await m.app({ pad: '/app/personeelsscherm/aanvraag', methode: 'POST', body: { tekst: 'Proefonderwerp' } });
  let a = (await m.appStand()).aanvragen;
  assert.deepStrictEqual(a.map((x) => [x.tekst, x.stand]), [['Proefonderwerp', 'wacht']]); assert.strictEqual(JSON.stringify(a).includes('4321'), false);
  const set = Object.assign({}, SET, { aanvraag: 'wv4321' });
  fs.writeFileSync(path.join(f.dir, 'infoschermen.json'), JSON.stringify({ sets: [set] }));
  assert.strictEqual((await m.appStand()).aanvragen[0].stand, 'kaart');
  fs.writeFileSync(f.vragenPad, JSON.stringify(jaVoor(SET)));
  assert.strictEqual((await m.appStand()).aanvragen[0].stand, 'aan');
});
