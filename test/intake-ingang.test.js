'use strict';
// Toetsen van de aanleverweg OVIS Intake (wv1282). Echte http-server, wegwerpmappen, verzonnen gegevens. Aanroep: bash test/intake-ingang.sh
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const I = require(path.join(ROOT, 'intake-ingang.js'));
const VV = require(path.join(ROOT, 'vault-veilig.js'));
const P = require(path.join(ROOT, 'intake', 'patientpoort.js'));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleutelHex = () => crypto.randomBytes(32).toString('hex');
const K = { mail: sleutelHex(), wa: sleutelHex(), gambia: sleutelHex(), lezer: sleutelHex(), signal: sleutelHex(), sigLees: sleutelHex(),
  teams: sleutelHex(), contacten: sleutelHex(), outlook: sleutelHex(), oud: sleutelHex() };
const MAPPEN = ['10_Zakelijk/Tolgaarde/raw_input', '10_Zakelijk/Groenhouten/raw_input', '10_Zakelijk/HAGRO/raw_input', '10_Zakelijk/POT_POH_GGZ/raw_input',
  '10_Zakelijk/Holding/raw_input', '10_Zakelijk/Praktijkhouders_BV/raw_input', '10_Zakelijk/SEL/raw_input', '10_Zakelijk/DBH/raw_input',
  '10_Zakelijk/GHAWA-ECG/raw_input', '20_Prive/raw_input', '_INBOX', '30_Conversaties/WhatsApp', '30_Conversaties/WhatsApp/Media/Documenten',
  '30_Conversaties/WhatsApp/Media/_te_duiden', '30_Conversaties/WhatsApp-Gambia', '30_Conversaties/WhatsApp-Gambia/Media/Documenten',
  '30_Conversaties/WhatsApp-Gambia/Media/_te_duiden', '30_Conversaties/Signal', '30_Conversaties/Teams', '20_Prive/Contacten', '00_Systeem'];

function omgeving(extra) {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-toets-'));
  const dir = path.join(basis, 'intake'), vault = path.join(basis, 'vault');
  fs.mkdirSync(dir, { recursive: true });
  for (const m of MAPPEN) fs.mkdirSync(path.join(vault, m), { recursive: true });
  fs.writeFileSync(path.join(vault, '00_Systeem/Signal-gesprekken.md'), '# Signal-gesprekken\n- proef\n');
  fs.writeFileSync(path.join(vault, '00_Systeem/WhatsApp-groepen.md'), '# WhatsApp-groepen\n| proef |\n');
  const s = (id, h, profielen, bronnen, lezen, status) => ({ id, sha256: sha(h), route: id, profielen, bronnen, lezen: lezen || [], status: status || 'actief', aangemaakt: '2026-10-25T18:00:00Z', door: 'toets' });
  const reg = { versie: 1, sleutels: [
    s('mail', K.mail, ['mail@1'], ['gmail:david', 'gmail:groenhouten']),
    s('outlook', K.outlook, ['outlook-mail@1'], ['outlook:tolgaarde']),
    s('whatsapp-nacht', K.wa, ['whatsapp-dump@1', 'whatsapp-media@1'], ['whatsapp:nl'], ['whatsapp-volglijst']),
    s('whatsapp-lezer', K.lezer, ['whatsapp-media@1'], ['whatsapp:nl', 'whatsapp:gambia']),
    s('gambia', K.gambia, ['whatsapp-gambia-week@1', 'whatsapp-media@1'], ['whatsapp:gambia']),
    s('signal-nacht', K.signal, ['signal-dump@1'], ['signal']),
    s('signal-lezer', K.sigLees, [], [], ['signal-volglijst']),
    s('teams', K.teams, ['teams-dump@1'], ['teams']),
    s('contacten', K.contacten, ['contacten-export@1'], ['contacten:google']),
    s('oud', K.oud, ['mail@1'], ['gmail:david'], [], 'ingetrokken'),
  ] };
  fs.writeFileSync(path.join(dir, 'sleutels.json'), JSON.stringify(reg), { mode: 0o600 });
  const klok = { t: Date.parse('2026-10-25T18:00:00Z') };
  const cfg = Object.assign({ dir, vault, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'),
    primair: () => true, vv: VV, nu: () => klok.t, fout: () => {}, marker: P, nachtgrendel: () => false, vrijeBytes: () => 50 * 1024 ** 3,
    pdftekst: async (p) => { const b = fs.readFileSync(p).toString('latin1'); const m = /TEKST:([\s\S]*)$/.exec(b); return m ? m[1] : ''; },
    stuur: (res, status, obj, kop) => {
      const h = Object.assign({}, kop || {});
      let body;
      if (Buffer.isBuffer(obj) || typeof obj === 'string') body = obj; else { body = JSON.stringify(obj); h['Content-Type'] = 'application/json'; }
      res.writeHead(status, h); res.end(body);
    } }, extra || {});
  const ing = I.maak(cfg);
  const server = http.createServer((req, res) => { if (ing.isPad(req)) return ing.verwerk(req, res); res.writeHead(404); res.end(); });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ basis, dir, vault, ing, server, klok, cfg, poort: server.address().port,
    sluit: () => new Promise((k) => { server.close(() => { ing.sluit(); fs.rmSync(basis, { recursive: true, force: true }); k(); }); }) })));
}

function vraag(o, methode, pad, sleutel, body, kop) {
  return new Promise((ok, nee) => {
    const h = Object.assign({}, kop || {});
    if (sleutel) h.Authorization = 'Bearer ' + sleutel;
    let data = null;
    if (body !== undefined && body !== null) {
      data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
      if (h['Content-Length'] === undefined) h['Content-Length'] = data.length;
    }
    const req = http.request({ host: '127.0.0.1', port: o.poort, method: methode, path: pad, headers: h }, (res) => {
      const d = []; res.on('data', (c) => d.push(c));
      res.on('end', () => { const b = Buffer.concat(d); let j = null; try { j = JSON.parse(b.toString('utf8')); } catch (e) {} ok({ status: res.statusCode, j, b, h: res.headers }); });
    });
    req.on('error', nee);
    if (data) req.write(data);
    req.end();
  });
}
const post = (o, sleutel, env) => vraag(o, 'POST', '/intake/stuk', sleutel, env);
const put = (o, sleutel, id, deel, bytes, mime, kop) => vraag(o, 'PUT', '/intake/stuk/' + id + '/' + deel, sleutel, bytes, Object.assign({ 'Content-Type': mime }, kop || {}));

// inline tekstdeel
function tdeel(code, rol, naam, tekst, mime, meta) { const b = Buffer.from(tekst, 'utf8'); const d = { deel: code, rol, naam, mime: mime || 'text/markdown', grootte: b.length, sha256: sha(b), tekst }; if (meta) d.meta = meta; return d; }
// bytesdeel (komt via PUT)
function bdeel(code, rol, naam, bytes, mime, meta) { const d = { deel: code, rol, naam, mime, grootte: bytes.length, sha256: sha(bytes) }; if (meta) d.meta = meta; return d; }
const nuOff = '2026-10-25T04:31:02+01:00';
const PER = { van: '2026-10-24T08:00:00+02:00', tot: '2026-10-24T21:12:00+02:00' };

// ── De naamvorming van de huidige workflows, letterlijk overgenomen (meting /tmp/wv1281/code, 25-10-2026) ──
const veiligWa = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
const veiligSignal = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const veiligTeams = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
function fnv32(str, seed) { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h = Math.imul(h ^ (c & 0xff), 16777619) >>> 0; if (c > 0xff) h = Math.imul(h ^ (c >>> 8), 16777619) >>> 0; } return (h >>> 0).toString(16).padStart(8, '0'); }
const fnv1a64 = (s) => fnv32(String(s), 0x811c9dc5) + fnv32(String(s), 0x01000193);
const slugMail = (s) => String(s || 'onbekend').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'onbekend';
const slugOutlook = (s) => String(s || 'onbekend').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'onbekend';
const naam = {
  mail: (datum, categorie, bijlage, messageId, bron) => { let basis = datum + '_' + slugMail(categorie); if (bijlage) basis += '_' + slugMail(bijlage); if (basis.length > 180) basis = basis.slice(0, 180).replace(/-+$/, ''); return basis + '__' + fnv1a64([messageId, bijlage || '', bron].join('|')).slice(0, 10) + '.md'; },
  outlook: (datum, tijd, onderwerp) => datum + '_' + tijd.replace(':', '') + '_outlook_' + slugOutlook(onderwerp) + '.md',
  waDump: (groep, dag) => 'WhatsApp - ' + groep.replace(/[\\/:*?"<>|]/g, '') + ' - ' + dag + '.md',
  gambia: (contact, dag) => 'WhatsApp-Gambia - ' + contact.replace(/[\\/:*?"<>|]/g, '') + ' - ' + dag + '.md',
  media: (stamp, chat, bestand, id, ext) => (stamp + ' - ' + veiligWa(chat) + ' - ' + veiligWa(bestand.replace(/\.[^.]+$/, '')) + ' (' + String(id.split('_')[2] || id).replace(/[^A-Za-z0-9]/g, '').slice(-8) + ')').slice(0, 120) + '.' + ext,
  signal: (gesprek, dag) => 'Signal - ' + veiligSignal(gesprek) + ' - ' + dag + '.md',
  teams: (gesprek, stamp) => 'Teams - ' + veiligTeams(gesprek) + ' - ' + stamp + '.md',
};

const DUMP_MD = (bron, extra) => '---\ntype: bron\nbron: ' + bron + '\n' + (extra || '') + 'status: onverwerkt\nupdated: 2026-10-25\n---\n\n# proef\n\n**[08:01] Voorbeeld:** hallo\n';
const PDF = (tekst) => Buffer.from('%PDF-1.4\n% verzonnen proefbestand\nTEKST:' + tekst, 'latin1');
const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), crypto.randomBytes(200)]);
const OGG = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(300)]);

// Per profiel: voorbeeld (geldig, met de route-naam), weiger (één fout) en het verwachte vaultpad (rondreis = huidige Drive-plek).
function gevallen() {
  const mid = '<CAProef123@mail.gmail.com>';
  const mailNaamMail = naam.mail('2026-10-24', 'Overleg', '', mid, 'mail');
  const mailNaamPdf = naam.mail('2026-10-24', 'Facturen', 'Factuur 2026-0412.pdf', mid, 'pdf');
  const pdf = PDF('Factuur printpapier, totaal EUR 51,43');
  const waId = 'false_31600000000@c.us_3EB0ABCDEF123456';
  const mediaNaam = naam.media('2026-10-24_2112', 'Voorbeeld: groep', 'notulen.pdf', waId, 'pdf');
  return [
    { profiel: 'mail@1', sleutel: K.mail,
      env: () => ({ protocol: 'ovis-intake/1', profiel: 'mail@1', bron: 'gmail:david', bron_id: '19a2b3c4d5e6f708', ontvangen: nuOff,
        meta: { gmail_id: '19a2b3c4d5e6f708', message_id: mid, thread_id: '19a2b3c4d5e6f700', van: 'iemand@voorbeeld.nl', aan: ['d.schaap@voorbeeld.nl'],
          onderwerp: 'Proefmail', labels: ['INBOX', 'AI/Tolgaarde'] },
        onderdelen: [bdeel('b1', 'bijlage', 'Factuur 2026-0412.pdf', pdf, 'application/pdf'),
          tdeel('r1', 'representatie', mailNaamMail, '---\ndatum: 2026-10-24\nentiteit: tolgaarde\n---\n\nmailtekst\n', 'text/markdown', { entiteit: 'tolgaarde', categorie: 'Overleg', documentbron: 'mail' }),
          tdeel('r2', 'representatie', mailNaamPdf, '---\ndatum: 2026-10-24\nentiteit: holding\n---\n\nfactuurtekst\n', 'text/markdown', { entiteit: 'holding', categorie: 'Facturen', documentbron: 'pdf' })],
        overgang: { stand: 'om' } }),
      put: [['b1', pdf, 'application/pdf']],
      verwacht: ['10_Zakelijk/Tolgaarde/raw_input/' + mailNaamMail, '10_Zakelijk/Holding/raw_input/' + mailNaamPdf],
      weiger: (e) => { e.meta.van = 'geen adres'; return 'vorm:meta.van'; } },
    { profiel: 'outlook-mail@1', sleutel: K.outlook,
      env: () => ({ protocol: 'ovis-intake/1', profiel: 'outlook-mail@1', bron: 'outlook:tolgaarde', bron_id: 'AAMkAGProef0001=', ontvangen: nuOff,
        meta: { onderwerp: 'Rooster november', classificatie: 'zakelijk', filterversie: 'qwen-2026-10', entiteit: 'tolgaarde', van: 'collega@voorbeeld.nl' },
        onderdelen: [tdeel('r1', 'representatie', naam.outlook('2026-10-24', '09:15', 'Rooster november'), '---\ndatum: 2026-10-24\n---\n\nrooster\n')],
        overgang: { stand: 'om' } }),
      verwacht: ['10_Zakelijk/Tolgaarde/raw_input/' + naam.outlook('2026-10-24', '09:15', 'Rooster november')],
      weiger: (e) => { e.meta.classificatie = 'patientgebonden'; return 'keuze:meta.classificatie'; } },
    { profiel: 'whatsapp-dump@1', sleutel: K.wa,
      env: () => ({ protocol: 'ovis-intake/1', profiel: 'whatsapp-dump@1', bron: 'whatsapp:nl', bron_id: '120363000000000000@g.us/1761285600-1761333120', ontvangen: nuOff,
        meta: { chat_id: '120363000000000000@g.us', chat_naam: 'Voorbeeld: groep', soort_chat: 'groep', entiteit: 'hagro', modus: 'info', periode: PER, berichten: 14 },
        onderdelen: [tdeel('r1', 'representatie', naam.waDump('Voorbeeld: groep', '2026-10-25'), DUMP_MD('whatsapp', 'groep: "Voorbeeld: groep"\n'))],
        overgang: { stand: 'om' } }),
      verwacht: ['30_Conversaties/WhatsApp/' + naam.waDump('Voorbeeld: groep', '2026-10-25')],
      weiger: (e) => { e.meta.berichten = 0; return 'bereik:meta.berichten'; } },
    { profiel: 'whatsapp-gambia-week@1', sleutel: K.gambia,
      env: () => ({ protocol: 'ovis-intake/1', profiel: 'whatsapp-gambia-week@1', bron: 'whatsapp:gambia', bron_id: '2207000000@c.us/1760800000-1761333120', ontvangen: nuOff,
        meta: { chat_id: '2207000000@c.us', contact: 'Proefcontact', periode: PER, berichten: 3, voice: 1 },
        onderdelen: [tdeel('r1', 'representatie', naam.gambia('Proefcontact', '2026-10-25'), DUMP_MD('whatsapp-gambia'))], overgang: { stand: 'om' } }),
      verwacht: ['30_Conversaties/WhatsApp-Gambia/' + naam.gambia('Proefcontact', '2026-10-25')],
      weiger: (e) => { e.meta.periode = { van: '2026-10-24', tot: '2026-10-25' }; return 'vorm:meta.periode'; } },
    { profiel: 'whatsapp-media@1', sleutel: K.wa,
      env: () => ({ protocol: 'ovis-intake/1', profiel: 'whatsapp-media@1', bron: 'whatsapp:nl', bron_id: waId, ontvangen: nuOff,
        meta: { chat_id: '31600000000@c.us', chat_naam: 'Voorbeeld: groep', soort_chat: '1-op-1', bericht_tijd: '2026-10-24T21:12:40+02:00', berichttype: 'document', originele_naam: 'notulen.pdf' },
        onderdelen: [bdeel('b1', 'bijlage', 'notulen.pdf', PDF('notulen van het overleg'), 'application/pdf')], overgang: { stand: 'om', bestandsnaam: mediaNaam } }),
      put: [['b1', PDF('notulen van het overleg'), 'application/pdf']],
      verwacht: ['30_Conversaties/WhatsApp/Media/Documenten/' + mediaNaam],
      weiger: (e) => { e.meta.bericht_tijd = '2026-10-24 21:12'; return 'vorm:meta.bericht_tijd'; } },
    { profiel: 'signal-dump@1', sleutel: K.signal,
      env: () => ({ protocol: 'ovis-intake/1', profiel: 'signal-dump@1', bron: 'signal', bron_id: 'groupProefId123=/1761285600000-1761333120000', ontvangen: nuOff,
        meta: { gesprek_id: 'groupProefId123=', gesprek: 'Proefgroep / Signal', soort: 'groep', periode: PER, berichten: 5 },
        onderdelen: [tdeel('r1', 'representatie', naam.signal('Proefgroep / Signal', '2026-10-25'), DUMP_MD('signal'))], overgang: { stand: 'om' } }),
      verwacht: ['30_Conversaties/Signal/' + naam.signal('Proefgroep / Signal', '2026-10-25')],
      weiger: (e) => { e.meta.soort = 'kanaal'; return 'keuze:meta.soort'; } },
    { profiel: 'teams-dump@1', sleutel: K.teams,
      env: () => ({ protocol: 'ovis-intake/1', profiel: 'teams-dump@1', bron: 'teams', bron_id: '19:proef@thread.v2/1761333120000', ontvangen: nuOff,
        meta: { conversation_id: '19:proef@thread.v2', gesprek: 'Proefkanaal', soort: 'kanaal', periode: '2026-10-25 08:00 – 11:30', berichten: 4, twijfel: 0 },
        onderdelen: [tdeel('r1', 'representatie', naam.teams('Proefkanaal', '2026-10-25 1130'), DUMP_MD('teams'))], overgang: { stand: 'om' } }),
      verwacht: ['30_Conversaties/Teams/' + naam.teams('Proefkanaal', '2026-10-25 1130')],
      weiger: (e) => { e.meta.twijfel = '0'; return 'type:meta.twijfel'; } },
    { profiel: 'contacten-export@1', sleutel: K.contacten,
      env: () => ({ protocol: 'ovis-intake/1', profiel: 'contacten-export@1', bron: 'contacten:google', bron_id: 'contacten', ontvangen: nuOff,
        meta: { aantal: 2, gemeten_op: '2026-10-25T02:45:00+01:00', bron: 'google-people' },
        onderdelen: [tdeel('r1', 'representatie', 'Contacten.md', '# Contacten (compacte zoeklijst)\n\n- **Proef Een**\n- **Proef Twee**\n')], overgang: { stand: 'om' } }),
      verwacht: ['20_Prive/Contacten/Contacten.md'],
      weiger: (e) => { e.meta.gemeten_op = '2026-10-25T02:45:00'; return 'vorm:meta.gemeten_op'; } },
  ];
}

test('profielen: 8 stuks, elk met voorbeeld, weigering en rondreis naar de huidige Drive-plek', async () => {
  const o = await omgeving();
  try {
    const g = gevallen();
    assert.deepStrictEqual(g.map((x) => x.profiel).sort(), Array.from(o.ing._profielen.keys()).sort());
    for (const x of g) {
      const w = x.env(); const reden = x.weiger(w);
      const rw = await post(o, x.sleutel, w);
      assert.strictEqual(rw.status, 400, x.profiel + ' weigering'); assert.strictEqual(rw.j.reden, reden, x.profiel);
      const r = await post(o, x.sleutel, x.env());
      assert.ok(r.status === 201, x.profiel + ' voorbeeld: ' + r.status + ' ' + JSON.stringify(r.j));
      let laatste = r;
      for (const [d, b, m] of (x.put || [])) { laatste = await put(o, x.sleutel, r.j.stuk_id, d, b, m); assert.strictEqual(laatste.status, 200, x.profiel + ' put ' + JSON.stringify(laatste.j)); }
      assert.strictEqual(laatste.j.compleet, true, x.profiel + ' compleet');
      assert.strictEqual(laatste.j.vault, 'geschreven', x.profiel);
      const paden = [].concat(laatste.j.pad).sort();
      assert.deepStrictEqual(paden, x.verwacht.slice().sort(), x.profiel + ' rondreis');
      for (const p of x.verwacht) assert.ok(fs.existsSync(path.join(o.vault, p)), p);
    }
    // ovis_-regels als laatste regels van de frontmatter; de rest byte-gelijk
    const wa = gevallen()[2];
    const t = fs.readFileSync(path.join(o.vault, wa.verwacht[0]), 'utf8');
    const orig = wa.env().onderdelen[0].tekst;
    assert.match(t, /\novis_stuk: stk_\d{8}_[0-9a-f]{8}\novis_profiel: whatsapp-dump@1\n---\n/);
    assert.strictEqual(t.replace(/^ovis_[a-z]+: .*\n/gm, ''), orig);
    // media: bytes ongewijzigd; Contacten.md (geen frontmatter) ongewijzigd
    assert.strictEqual(sha(fs.readFileSync(path.join(o.vault, gevallen()[4].verwacht[0]))), sha(PDF('notulen van het overleg')));
    assert.strictEqual(fs.readFileSync(path.join(o.vault, '20_Prive/Contacten/Contacten.md'), 'utf8'), gevallen()[7].env().onderdelen[0].tekst);
  } finally { await o.sluit(); }
});

test('sleutels: geen, fout, ingetrokken, pod-credential, ander profiel/bron, register kapot', async () => {
  const o = await omgeving();
  try {
    const env = gevallen()[5].env();
    assert.strictEqual((await post(o, null, env)).status, 401);
    assert.strictEqual((await post(o, sleutelHex(), env)).status, 401);
    assert.strictEqual((await post(o, K.oud, gevallen()[0].env())).status, 401, 'ingetrokken');
    // de bestaande pod-credential (geheim in de body of als x-api-key) werkt hier niet
    const r1 = await vraag(o, 'POST', '/intake/stuk', null, Object.assign({ secret: 'pod-geheim' }, env), { 'x-api-key': 'pod-geheim' });
    assert.strictEqual(r1.status, 401); assert.strictEqual(r1.j.reden, 'sleutel');
    assert.strictEqual((await vraag(o, 'POST', '/intake/stuk', null, env, { Authorization: 'Bearer ' + K.signal.toUpperCase() })).status, 401, 'hoofdletters');
    const r2 = await post(o, K.teams, env);
    assert.strictEqual(r2.status, 403); assert.strictEqual(r2.j.reden, 'profiel_niet_voor_deze_sleutel');
    const m = gevallen()[4].env(); m.bron = 'whatsapp:gambia';
    const r3 = await post(o, K.wa, m);
    assert.strictEqual(r3.status, 403); assert.strictEqual(r3.j.reden, 'bron_niet_voor_deze_sleutel');
    const r4 = await post(o, K.sigLees, env);
    assert.strictEqual(r4.status, 403, 'alleen-lezen sleutel kan niet aanleveren');
    // een PUT met een sleutel van een andere route op een bestaand stuk
    const g0 = gevallen()[0]; const s = await post(o, K.mail, g0.env());
    const r5 = await put(o, K.wa, s.j.stuk_id, 'b1', g0.put[0][1], 'application/pdf');
    assert.strictEqual(r5.status, 403);
    // register niet 0600 → 503; afwezig → 503
    fs.chmodSync(path.join(o.dir, 'sleutels.json'), 0o644); o.klok.t += 20000;
    assert.strictEqual((await post(o, K.signal, env)).j.reden, 'sleutelregister_kapot');
    fs.renameSync(path.join(o.dir, 'sleutels.json'), path.join(o.dir, 'weg.json')); o.klok.t += 20000;
    assert.strictEqual((await post(o, K.signal, env)).status, 503);
    // geen logboekregels vóór een geldige sleutel
    const n = o.ing._db.prepare('SELECT count(*) n FROM aanlevering WHERE sleutel_id IS NULL').get().n;
    assert.strictEqual(n, 0);
  } finally { await o.sluit(); }
});

test('envelop: fouten per veldtype en kernveld, elk één reden', async () => {
  const o = await omgeving();
  try {
    const g = gevallen();
    const proef = async (i, f, verwacht, status) => { const e = g[i].env(); f(e); const r = await post(o, g[i].sleutel, e); assert.strictEqual(r.status, status || 400, verwacht + ' ' + JSON.stringify(r.j)); assert.strictEqual(r.j.reden, verwacht); };
    await proef(5, (e) => { e.protocol = 'ovis-intake/2'; }, 'protocol');
    await proef(5, (e) => { e.extra = 1; }, 'veld_onbekend:extra');
    await proef(5, (e) => { e.profiel = 'signal-dump@9'; }, 'profiel_onbekend');
    await proef(5, (e) => { e.bron_id = 'zonder-slash'; }, 'vorm:bron_id');
    await proef(5, (e) => { e.ontvangen = '2026-10-25T04:31:02'; }, 'vorm:ontvangen');
    await proef(5, (e) => { delete e.meta.gesprek; }, 'veld_ontbreekt:meta.gesprek');
    await proef(5, (e) => { e.meta.onbekend = 'x'; }, 'veld_onbekend:meta.onbekend');
    await proef(5, (e) => { e.meta.gesprek = 'x'.repeat(201); }, 'lengte:meta.gesprek');                  // tekst
    await proef(5, (e) => { e.meta.gesprek = 5; }, 'type:meta.gesprek');
    await proef(5, (e) => { e.meta.berichten = 1.5; }, 'type:meta.berichten');                             // geheel
    await proef(5, (e) => { e.meta.periode = { van: PER.tot, tot: PER.van }; }, 'bereik:meta.periode');    // periode
    await proef(5, (e) => { e.meta.periode = { van: PER.van, tot: PER.tot, x: 1 }; }, 'type:meta.periode');
    await proef(0, (e) => { e.meta.aan = ['goed@voorbeeld.nl', 'fout']; }, 'vorm:meta.aan');               // adressen
    await proef(0, (e) => { e.meta.labels = 'INBOX'; }, 'type:meta.labels');                               // lijst
    await proef(0, (e) => { e.meta.labels = Array(101).fill('x'); }, 'lengte:meta.labels');
    await proef(0, (e) => { e.meta.authentication_results = 'x'.repeat(16 * 1024 + 1); }, 'lengte:meta.authentication_results');   // ruwe_kop
    await proef(0, (e) => { e.meta.verzonden = 'gisteren'; }, 'vorm:meta.verzonden');                      // tijd
    await proef(0, (e) => { e.onderdelen[1].meta.entiteit = 'onbekend'; }, 'keuze:onderdelen[1].meta.entiteit');
    await proef(0, (e) => { e.onderdelen[1].meta.onderwerp = 'x'; }, 'veld_onbekend:onderdelen[1].meta.onderwerp');
    await proef(0, (e) => { e.onderdelen[0].rol = 'hoofdtekst'; }, 'mime:onderdelen[0]');
    await proef(0, (e) => { e.onderdelen[0].sha256 = 'abc'; }, 'vorm:onderdelen[0].sha256');
    await proef(0, (e) => { e.onderdelen[1].sha256 = sha('anders'); }, 'sha256_klopt_niet:onderdelen[1]');
    await proef(0, (e) => { e.onderdelen[1].grootte += 1; }, 'grootte_klopt_niet:onderdelen[1]');
    await proef(0, (e) => { e.onderdelen[2].deel = 'r1'; }, 'dubbel:onderdelen[2].deel');
    await proef(0, (e) => { delete e.overgang; }, 'alleen_overgang:onderdelen[1]');
    await proef(0, (e) => { e.overgang.stand = 'klaar'; }, 'keuze:overgang.stand');
    await proef(0, (e) => { e.overgang.pad = '10_Zakelijk'; }, 'veld_onbekend:overgang.pad');
    await proef(0, (e) => { e.onderdelen[1].naam = 'vrije-naam.md'; }, 'naamvorm:r1');
    await proef(5, (e) => { e.onderdelen = []; }, 'te_weinig:representatie');
    await proef(0, (e) => { e.aanlevering = { workflow: 'x'.repeat(65) }; }, 'type:aanlevering.workflow');
    // eenheden die geen profiel gebruikt
    assert.strictEqual(I.toetsEnvelop({}, o.ing._profielen, { profielen: [], bronnen: [] }, o.ing._soorten).reden, 'protocol');
    const r = await vraag(o, 'POST', '/intake/stuk', K.signal, '{"kapot', { 'Content-Type': 'application/json' });
    assert.strictEqual(r.j.reden, 'geen_json');
    assert.strictEqual((await vraag(o, 'POST', '/intake/stuk', K.signal, 'x=1', { 'Content-Type': 'text/plain' })).status, 415);
  } finally { await o.sluit(); }
});

test('naampoort: docm, xlsm, js, dubbele punt, punt/spatie aan het eind, alle WINCODE-soorten, NTFS', async () => {
  const o = await omgeving();
  try {
    const S = o.ing._soorten;
    for (const n of ['a.docm', 'b.XLSM', 'c.js', 'd.ps1', 'e.exe', 'f.lnk', 'g.msı']) assert.strictEqual(I.naampoort(n, S), 'soort_niet_toegestaan', n);
    assert.strictEqual(I.naampoort('a:b.pdf', S), 'naam_teken');
    assert.strictEqual(I.naampoort('a.pdf.', S), 'naam_rand');
    assert.strictEqual(I.naampoort('a.pdf ', S), 'naam_rand');
    assert.strictEqual(I.naampoort('../x.md', S), 'naam_teken');
    assert.strictEqual(I.naampoort('.verborgen.md', S), 'naam_verborgen');
    assert.strictEqual(I.naampoort('CON.txt', S), 'naam_gereserveerd');
    assert.strictEqual(I.naampoort('desktop.ini', S), 'soort_niet_toegestaan');
    assert.strictEqual(I.naampoort('fdp.exe‮txt.pdf', S), 'naam_teken');
    assert.strictEqual(I.naampoort('x'.repeat(201) + '.pdf', S), 'naam_te_lang');
    assert.strictEqual(I.naampoort('2026-10-24_2112 - Groep - notulen (3EB0AB).pdf', S), null);
    // elke soort uit WINCODE van socev-rechten.sh en de scripts van CODEPLEK weigert (dezelfde lijst als bisync-filter-toets.sh)
    const rechten = fs.readFileSync(path.join(ROOT, 'socev-rechten.sh'), 'utf8');
    const soorten = new Set((rechten.match(/-iname '\*\.([a-z0-9-]+)'/g) || []).map((x) => x.replace(/^-iname '\*\./, '').replace(/'$/, '')));
    assert.ok(soorten.size > 40, 'WINCODE gelezen');
    for (const s of soorten) if (s !== 'zip' && s !== 'whl' && s !== 'egg') assert.strictEqual(I.naampoort('x.' + s, S), 'soort_niet_toegestaan', s);
    // via de ingang: 415 voor de bijlage en voor de bestandsnaam
    const g = gevallen()[4];
    const e1 = g.env(); e1.onderdelen[0].naam = 'notulen.docm'; e1.onderdelen[0].mime = 'application/pdf';
    const r1 = await post(o, g.sleutel, e1); assert.strictEqual(r1.status, 415); assert.match(r1.j.reden, /^soort_niet_toegestaan/);
    const e2 = g.env(); e2.overgang.bestandsnaam = '2026-10-24_2112 - x - y.xlsm';
    assert.strictEqual((await post(o, g.sleutel, e2)).status, 415);
    const e3 = g.env(); e3.overgang.bestandsnaam = '2026-10-24_2112 - a:b - y.pdf';
    assert.strictEqual((await post(o, g.sleutel, e3)).j.reden, 'naam_teken:overgang.bestandsnaam');
    // extensie past niet bij de mime
    const e4 = g.env(); e4.onderdelen[0].naam = 'notulen.jpg';
    assert.strictEqual((await post(o, g.sleutel, e4)).status, 415);
  } finally { await o.sluit(); }
});

test('bytes: sha of grootte verkeerd, Content-Length/mime, eerste bytes, te groot, hervatten, blob één keer', async () => {
  const o = await omgeving();
  try {
    const g = gevallen()[4];
    const r = await post(o, g.sleutel, g.env());
    assert.strictEqual(r.status, 201); assert.deepStrictEqual(r.j.nodig, ['b1']);
    const goed = g.put[0][1];
    const fout = Buffer.from(goed); fout[fout.length - 1] ^= 1;
    assert.strictEqual((await put(o, g.sleutel, r.j.stuk_id, 'b1', fout, 'application/pdf')).j.reden, 'sha256_klopt_niet');
    assert.strictEqual((await put(o, g.sleutel, r.j.stuk_id, 'b1', goed.subarray(1), 'application/pdf')).j.reden, 'grootte_klopt_niet');
    assert.strictEqual((await put(o, g.sleutel, r.j.stuk_id, 'b1', goed, 'image/jpeg')).j.reden, 'mime_klopt_niet');
    assert.strictEqual((await put(o, g.sleutel, r.j.stuk_id, 'b9', goed, 'application/pdf')).status, 404);
    assert.strictEqual((await put(o, g.sleutel, 'stk_20261025_00000000', 'b1', goed, 'application/pdf')).status, 404);
    // eerste bytes: een jpeg die zich als pdf aandient (eigen stuk, sha klopt)
    const e = g.env(); e.bron_id = 'false_31600000000@c.us_3EB0ANDERS00001'; e.onderdelen[0] = bdeel('b1', 'bijlage', 'notulen.pdf', JPG, 'application/pdf');
    const r2 = await post(o, g.sleutel, e);
    assert.strictEqual((await put(o, g.sleutel, r2.j.stuk_id, 'b1', JPG, 'application/pdf')).j.reden, 'soort_klopt_niet');
    // geen tijdelijke resten
    assert.deepStrictEqual(fs.readdirSync(path.join(o.dir, 'tmp')), []);
    // te groot: aangekondigd deel boven max_mb, stuk boven 60 MB, envelop te groot
    const e5 = g.env(); e5.onderdelen[0].grootte = 26 * 1024 * 1024;
    assert.strictEqual((await post(o, g.sleutel, e5)).status, 413);
    const m = gevallen()[0].env(); m.onderdelen = m.onderdelen.concat([2, 3, 4].map((i) => ({ deel: 'g' + i, rol: 'bijlage', naam: 'groot' + i + '.pdf', mime: 'application/pdf', grootte: 24 * 1024 * 1024, sha256: sha('g' + i) })));
    assert.strictEqual((await post(o, K.mail, m)).j.reden, 'te_groot:stuk');
    const m2 = gevallen()[0].env(); m2.meta.onderwerp = 'x'.repeat(998); m2.meta.labels = Array(100).fill('y'.repeat(200)); m2.meta.cc = Array(450).fill('a@voorbeeld.nl');
    m2.meta.authentication_results = 'z'.repeat(16000);
    for (let i = 0; i < 20; i++) m2.meta.labels[i] = 'q'.repeat(200);
    const mm = JSON.stringify(m2).length;
    if (mm > 256 * 1024) assert.strictEqual((await post(o, K.mail, m2)).j.reden, 'te_groot:envelop');
    // hervatten: envelop opnieuw → dubbel met ontbreekt; PUT goed → compleet
    const d = await post(o, g.sleutel, g.env());
    assert.strictEqual(d.status, 200); assert.strictEqual(d.j.uitkomst, 'dubbel'); assert.deepStrictEqual(d.j.ontbreekt, ['b1']);
    const k = await put(o, g.sleutel, r.j.stuk_id, 'b1', goed, 'application/pdf');
    assert.strictEqual(k.j.uitkomst, 'compleet'); assert.strictEqual(k.j.onderdelen[0].blob, 'nieuw');
    // nog een keer dezelfde PUT: idempotent
    assert.strictEqual((await put(o, g.sleutel, r.j.stuk_id, 'b1', goed, 'application/pdf')).j.onderdelen[0].blob, 'bekend');
    // zelfde bytes in een ander stuk (Chat Reader-sleutel, andere chatnaam, ander bericht-id): blob bekend, geen tweede kopie
    const e6 = g.env(); e6.bron_id = 'false_31600000000@c.us_3EB0TWEEDE00001'; e6.meta.chat_naam = 'Andere naam'; delete e6.overgang;
    const r6 = await post(o, K.lezer, e6);
    const k6 = await put(o, K.lezer, r6.j.stuk_id, 'b1', goed, 'application/pdf');
    assert.strictEqual(k6.j.onderdelen[0].blob, 'bekend');
    const n = fs.readdirSync(path.join(o.dir, 'blob', sha(goed).slice(0, 2))).filter((x) => x === sha(goed)).length;
    assert.strictEqual(n, 1);
    assert.strictEqual(fs.statSync(path.join(o.dir, 'blob', sha(goed).slice(0, 2), sha(goed))).mode & 0o777, 0o600);
  } finally { await o.sluit(); }
});

test('dubbel en afwijkend (gedeeld media-id), herzienbaar (contacten), naamcollisie en schaduw', async () => {
  const o = await omgeving();
  try {
    const g = gevallen()[4];
    const r = await post(o, g.sleutel, g.env());
    await put(o, g.sleutel, r.j.stuk_id, 'b1', g.put[0][1], 'application/pdf');
    // Chat Reader levert hetzelfde bericht onder een andere chatnaam: dubbel (meta telt niet)
    const e = g.env(); e.meta.chat_naam = 'Andere naam'; delete e.overgang;
    const d = await post(o, K.lezer, e);
    assert.strictEqual(d.status, 200); assert.strictEqual(d.j.uitkomst, 'dubbel'); assert.strictEqual(d.j.stuk_id, r.j.stuk_id); assert.ok(d.j.sinds);
    assert.strictEqual(d.j.afwijkend, undefined);
    // andere bytes onder hetzelfde id: dubbel + afwijkend, telling, nooit een weigering
    const e2 = g.env(); e2.onderdelen[0] = bdeel('b1', 'bijlage', 'notulen.pdf', PDF('andere versie'), 'application/pdf');
    const d2 = await post(o, g.sleutel, e2);
    assert.strictEqual(d2.status, 200); assert.strictEqual(d2.j.afwijkend, true);
    assert.strictEqual(o.ing._db.prepare("SELECT count(*) n FROM aanlevering WHERE reden = 'afwijkend'").get().n, 1);
    // herzienbaar: contacten v2 vervangt het bestand; zelfde inhoud = dubbel
    const c = gevallen()[7];
    const c1 = await post(o, c.sleutel, c.env()); assert.strictEqual(c1.status, 201);
    assert.strictEqual((await post(o, c.sleutel, c.env())).j.uitkomst, 'dubbel');
    const ce = c.env(); ce.onderdelen = [tdeel('r1', 'representatie', 'Contacten.md', '# Contacten\n\n- **Proef Drie**\n')]; ce.meta.aantal = 1;
    const c2 = await post(o, c.sleutel, ce);
    assert.strictEqual(c2.status, 201); assert.strictEqual(c2.j.uitkomst, 'herzien'); assert.strictEqual(c2.j.versie, 2); assert.notStrictEqual(c2.j.stuk_id, c1.j.stuk_id);
    assert.strictEqual(fs.readFileSync(path.join(o.vault, '20_Prive/Contacten/Contacten.md'), 'utf8'), '# Contacten\n\n- **Proef Drie**\n');
    // naamcollisie: een tweede Signal-dump op dezelfde dag (ander bron-id, zelfde naam) → ' (2)'
    const s = gevallen()[5];
    await post(o, s.sleutel, s.env());
    const se = s.env(); se.bron_id = 'groupProefId123=/1761333120001-1761340000000'; se.onderdelen = [tdeel('r1', 'representatie', s.env().onderdelen[0].naam, DUMP_MD('signal', 'tweede: ja\n'))];
    const s2 = await post(o, s.sleutel, se);
    assert.strictEqual(s2.j.pad, '30_Conversaties/Signal/Signal - Proefgroep Signal - 2026-10-25 (2).md');
    assert.strictEqual(o.ing._db.prepare("SELECT count(*) n FROM overgang WHERE uitkomst = 'naam_bezet'").get().n, 1);
    // stand dubbel: in de schaduwmap, niet in de vault
    const t = gevallen()[6]; const te = t.env(); te.overgang.stand = 'dubbel';
    const t1 = await post(o, t.sleutel, te);
    assert.strictEqual(t1.j.vault, 'schaduw');
    assert.ok(fs.existsSync(path.join(o.dir, 'schaduw', t.verwacht[0])));
    assert.ok(!fs.existsSync(path.join(o.vault, t.verwacht[0])));
  } finally { await o.sluit(); }
});

test('padpoging: symlink in de profielmap en een vrij pad leiden nooit buiten de profielmap', async () => {
  const o = await omgeving();
  try {
    const buiten = path.join(o.basis, 'buiten'); fs.mkdirSync(buiten);
    fs.rmSync(path.join(o.vault, '30_Conversaties/Signal'), { recursive: true });
    fs.symlinkSync(buiten, path.join(o.vault, '30_Conversaties/Signal'));
    const s = gevallen()[5];
    const r = await post(o, s.sleutel, s.env());
    assert.strictEqual(r.status, 202); assert.strictEqual(r.j.vault, 'wacht');
    assert.deepStrictEqual(fs.readdirSync(buiten), []);
    // naam met een pad erin haalt de naampoort niet
    const e = s.env(); e.bron_id = 'groupProefId123=/1761285600000-1761333120009'; e.onderdelen[0].naam = '../../Signal - x - 2026-10-25.md';
    assert.strictEqual((await post(o, s.sleutel, e)).j.reden, 'naam_teken:onderdelen[0].naam');
    // leesluik: alleen de vaste namen; een vrij pad is 404
    assert.strictEqual((await vraag(o, 'GET', '/intake/lees/..%2F..%2Fetc', K.sigLees)).status, 404);
    assert.strictEqual((await vraag(o, 'GET', '/intake/lees/00_Systeem', K.sigLees)).status, 404);
  } finally { await o.sluit(); }
});

test('onvolledig na een uur, hervatten daarna; onderhoudsstand 202 en herhaalronde; noodschakelaar; vol; te vaak', async () => {
  const o = await omgeving({ grenzen: { perUur: 25 } });
  try {
    const g = gevallen()[0];
    const r = await post(o, g.sleutel, g.env());
    assert.deepStrictEqual(r.j.nodig, ['b1']);
    o.klok.t += 61 * 60000;
    const ro = await o.ing.ronde();
    assert.strictEqual(ro.onvolledig, 1);
    assert.strictEqual(o.ing._db.prepare('SELECT status FROM stuk WHERE stuk_id = ?').get(r.j.stuk_id).status, 'onvolledig');
    const d = await post(o, g.sleutel, g.env());
    assert.deepStrictEqual(d.j.ontbreekt, ['b1']);
    const k = await put(o, g.sleutel, r.j.stuk_id, 'b1', g.put[0][1], 'application/pdf');
    assert.strictEqual(k.j.compleet, true); assert.strictEqual(k.j.vault, 'geschreven');
    // onderhoudsstand: 202 + vault wacht; na het weghalen schrijft de ronde het alsnog
    fs.writeFileSync(path.join(o.dir, 'onderhoud'), '');
    const s = gevallen()[5];
    const w = await post(o, s.sleutel, s.env());
    assert.strictEqual(w.status, 202); assert.strictEqual(w.j.vault, 'wacht'); assert.strictEqual(w.j.compleet, true);
    assert.ok(!fs.existsSync(path.join(o.vault, s.verwacht[0])));
    assert.strictEqual((await o.ing.ronde()).wacht, 1);
    fs.unlinkSync(path.join(o.dir, 'onderhoud'));
    assert.strictEqual((await o.ing.ronde()).herschreven, 1);
    assert.ok(fs.existsSync(path.join(o.vault, s.verwacht[0])));
    // nachtgrendel (01:00–01:59) = ook onderhoud
    o.cfg.nachtgrendel = () => true;
    const t = gevallen()[6]; assert.strictEqual((await post(o, t.sleutel, t.env())).status, 202);
    o.cfg.nachtgrendel = () => false;
    // noodschakelaar
    fs.writeFileSync(path.join(o.dir, 'uit'), '');
    const u = await post(o, s.sleutel, s.env()); assert.strictEqual(u.status, 503); assert.strictEqual(u.j.reden, 'uit'); assert.ok(u.h['retry-after']);
    fs.unlinkSync(path.join(o.dir, 'uit'));
    // niet primair
    o.cfg.primair = () => false; assert.strictEqual((await post(o, s.sleutel, s.env())).status, 503); o.cfg.primair = () => true;
    // vol
    o.cfg.vrijeBytes = () => 1024; const v = await post(o, s.sleutel, s.env()); assert.strictEqual(v.status, 507); assert.strictEqual(v.j.reden, 'vol'); o.cfg.vrijeBytes = () => 50 * 1024 ** 3;
    // te vaak (perUur 25 in deze toets)
    let laatst = null;
    for (let i = 0; i < 30; i++) { laatst = await post(o, s.sleutel, s.env()); if (laatst.status === 429) break; }
    assert.strictEqual(laatst.status, 429); assert.strictEqual(laatst.j.reden, 'te_vaak');
  } finally { await o.sluit(); }
});

test('vrije velden: grenzen, verwijzing naar een deel, in de frontmatter als ovis_vrij en in het logboek', async () => {
  const o = await omgeving();
  try {
    const g = gevallen()[2];
    const proef = async (vrij, reden) => { const e = g.env(); e.vrij = vrij; const r = await post(o, g.sleutel, e); assert.strictEqual(r.status, 400, reden); assert.strictEqual(r.j.reden, reden); };
    await proef(Array(21).fill({ omschrijving: 'a', waarde: 'b' }), 'lengte:vrij');
    await proef([{ omschrijving: 'x'.repeat(81), waarde: 'b' }], 'lengte:vrij[0].omschrijving');
    await proef([{ omschrijving: 'a', waarde: 'x'.repeat(4097) }], 'lengte:vrij[0].waarde');
    await proef([{ omschrijving: 'a' }], 'waarde_of_deel:vrij[0]');
    await proef([{ omschrijving: 'a', waarde: 'b', deel: 'r1' }], 'waarde_of_deel:vrij[0]');
    await proef([{ omschrijving: 'a', deel: 'zz' }], 'deel_onbekend:vrij[0]');
    await proef([{ omschrijving: '', waarde: 'b' }], 'veld_ontbreekt:vrij[0].omschrijving');
    await proef([{ omschrijving: 'a', waarde: 3 }], 'type:vrij[0].waarde');
    await proef([{ omschrijving: 'a', waarde: 'b', extra: 1 }], 'veld_onbekend:vrij[0].extra');
    const e = g.env();
    e.vrij = Array.from({ length: 19 }, (_, i) => ({ omschrijving: 'Veld ' + i, waarde: 'w"' + i })).concat([{ omschrijving: 'Dump zelf', deel: 'r1' }]);
    e.vrij[0].waarde = 'x'.repeat(4096);
    const r = await post(o, g.sleutel, e);
    assert.strictEqual(r.status, 201, JSON.stringify(r.j));
    const t = fs.readFileSync(path.join(o.vault, g.verwacht[0]), 'utf8');
    assert.match(t, /\novis_vrij:\n  - \{omschrijving: "Veld 0", waarde: "x{4096}"\}\n/);
    assert.match(t, /  - \{omschrijving: "Veld 1", waarde: "w\\"1"\}\n/);
    assert.match(t, /  - \{omschrijving: "Dump zelf", deel: "r1"\}\n---\n/);
    assert.strictEqual(o.ing._db.prepare('SELECT count(*) n FROM vrij_veld WHERE stuk_id = ?').get(r.j.stuk_id).n, 20);
  } finally { await o.sluit(); }
});

test('leesluik: alleen eigen namen, alleen lezen', async () => {
  const o = await omgeving();
  try {
    const r = await vraag(o, 'GET', '/intake/lees/signal-volglijst', K.sigLees);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.b.toString(), '# Signal-gesprekken\n- proef\n'); assert.match(r.h['content-type'], /text\/markdown/);
    assert.strictEqual((await vraag(o, 'GET', '/intake/lees/whatsapp-volglijst', K.sigLees)).status, 403);
    assert.strictEqual((await vraag(o, 'GET', '/intake/lees/whatsapp-volglijst', K.wa)).status, 200);
    assert.strictEqual((await vraag(o, 'GET', '/intake/lees/signal-volglijst', null)).status, 401);
    assert.strictEqual((await vraag(o, 'GET', '/intake/lees/onbekend', K.sigLees)).status, 404);
    assert.strictEqual((await vraag(o, 'PUT', '/intake/lees/signal-volglijst', K.sigLees, 'x', { 'Content-Type': 'text/plain' })).status, 404);
    assert.strictEqual((await vraag(o, 'DELETE', '/intake/stuk', K.mail)).status, 404);
    assert.strictEqual((await vraag(o, 'GET', '/intake/stuk', K.mail)).status, 404);
  } finally { await o.sluit(); }
});

// De 23 toetsgevallen van patientpoort-2.0 (mk-scripts/wv1008/toets-kern.js), met de tekst van de nagemaakte pdf's als tekst: de intake
// doet geen OCR, dus de scanvarianten gaan als (scan: true) en de lege scan als leesbaar: false (verzonnen gegevens).
const BRIEF = 'Ziekenhuis Proefstad - Polikliniek Interne Geneeskunde\nAan: dhr. D. Schaap, huisarts, Huisartsenpraktijk Tolgaarde\n\nBetreft: mw. P. Proefpersoon, geb. 03-04-1961, BSN 111222333\n\nGeachte collega,\n\nOp 12-10-2026 zagen wij uw patiente op de polikliniek in verband met\nklachten van vermoeidheid. Voorgeschiedenis: hypertensie.\nDiagnose: ijzergebreksanemie. Medicatie: ferrofumaraat 200 mg 1dd1.\nLabuitslag: Hb 6,4 mmol/l.\n\nMet collegiale groet,\nDr. A. Verzonnen, internist';
const FACTUUR = 'Kantoorhandel Proef B.V.\nFactuur 2026-0412\nFactuurdatum: 14-10-2026\nHuisartsenpraktijk Tolgaarde\nOmschrijving: 5 dozen printpapier A4\nBedrag excl. btw: EUR 42,50\nBTW 21%: EUR 8,93\nTotaal: EUR 51,43\nIBAN NL91 ABNA 0417 1643 00 - KvK 12345678\nGraag betalen binnen 30 dagen.';
test('marker: patientpoort-2.0 op de 23 toetsgevallen', () => {
  const SL = 'proefsleutel-'.padEnd(40, 'x');
  const hm = (x) => crypto.createHmac('sha256', SL).update(x).digest('hex');
  const geen = P.maakEigen(null, {});
  const eigen = P.maakEigen(SL, { bsn: [hm('111222333')], geboortedatum: [hm('1961-04-03')], zorgverleners: ['eigenzkh.nl'] });
  const G = [
    ['patientbrief digitaal', { teksten: [BRIEF], bijlagenamen: ['scan-digitaal.pdf'] }, geen, true],
    ['patientbrief scan', { teksten: [BRIEF], bijlagenamen: ['scan-scan.pdf'], scan: true }, geen, true],
    ['patientbrief scan met eigen lijst', { teksten: [BRIEF], scan: true }, eigen, false],
    ['patientbrief scan eigen + vreemd BSN', { teksten: [BRIEF + '\nBSN partner: 123456782'], scan: true }, eigen, true],
    ['factuur scan', { teksten: [FACTUUR], bijlagenamen: ['factuur-scan.pdf'], scan: true }, geen, false],
    ['lege scan', { teksten: [''], bijlagenamen: ['leeg-scan.pdf'], leesbaar: false, scan: true }, geen, true],
    ['mail: uw patiënt(en) standaardtekst', { teksten: ['Een huisarts heeft het dossier van uw patiënt(en) op het LSP gezet. Neem contact op met de huisarts die uw patiënt(en) heeft.'] }, geen, false],
    ['mail: HAGRO ZorgDomein-beleid', { teksten: ['Vanaf 1 november lopen alle verwijzingen naar de GGZ via ZorgDomein. Edifact MEDVRI wordt uitgefaseerd.'] }, geen, false],
    ['mail: RSIN in contract', { teksten: ['Praktijkhouders B.V.\nRSIN: 111222333\nKvK 12345678'] }, geen, false],
    ['mail: verwijzing met geboortedatum', { teksten: ['Graag uw advies over mevrouw X, geboren 01-01-1950, verwijzing naar de cardioloog volgt.'] }, geen, true],
    ['mail: bovengenoemde patiënt', { teksten: ['Geachte collega, bovengenoemde patiënt bezocht ons spreekuur.'] }, geen, true],
    ['mail: privé, school', { teksten: ['Beste ouders, de schoolfoto wordt op 3 november gemaakt. Geboortedatum van uw kind graag doorgeven.'] }, geen, false],
    ['mail: kort (zie bijlage)', { teksten: ['Zie bijlage.'] }, geen, false],
    ['lab: geb.dat. + los BSN', { teksten: ['Laboratorium Proefstad\nNaam: J. Proef  Geb.dat.: 12-03-1958  123456782\nHb 8,1 mmol/l  Kreatinine 80'] }, geen, true],
    ['specialistenbrief zonder woord patiënt', { teksten: ['Geachte collega,\nWij zagen bovengenoemde op onze polikliniek. Beleid: 1 dd 1 tablet.\nMet collegiale hoogachting'] }, geen, true],
    ['dhr + kale datum + spreekuur + recept', { teksten: ['Dhr. J. Jansen (12-03-1958) kwam op het spreekuur; recept verlengd.'] }, geen, true],
    ['kind na 2010 + uitslag', { teksten: ['Betreft: mw. L. Proef (04-05-2016), uitslag van het bloedonderzoek volgt.'] }, geen, true],
    ['personeelsbrief betreft: mevrouw', { teksten: ['Betreft: mevrouw K. de Vries\nHierbij bevestigen wij uw verlof van 1 tot 5 november.'] }, geen, false],
    ['GGZ-brief cliënt', { teksten: ['Betreft: cliënt, geboren 01-02-1990. De behandelaar (psycholoog) stelt een DSM-5-classificatie.'] }, geen, true],
    ['eigen BSN + partner met kale datum', { teksten: ['Patiënt: Schaap, D. BSN 111222333 geboortedatum 03-04-1961\nPartner: dhr. J. Jansen (01-02-1950)\nDiagnose: x'] }, eigen, true],
    ['eigen geboortedatum zonder BSN, onbekende afzender', { teksten: ['Patiënt: D. Schaap, geb. 03-04-1961\nUitslag van het bloedonderzoek'], afzender: 'lab@ergens.nl' }, eigen, true],
    ['eigen geboortedatum, eigen zorgverlener', { teksten: ['Patiënt: D. Schaap, geb. 03-04-1961\nUitslag van het bloedonderzoek'], afzender: 'poli@eigenzkh.nl' }, eigen, false],
    ['BSN na 250.000 tekens', { teksten: ['x '.repeat(125000) + '\nBSN: 123456782'] }, geen, true],
  ];
  assert.strictEqual(G.length, 23);
  assert.strictEqual(P.VERSIE, 'patientpoort-2.0');
  const fout = G.filter(([n, stuk, e, v]) => P.beoordeel(stuk, { eigen: e, nu: Date.parse('2026-10-25T12:00:00Z') }).tegenhouden !== v).map((x) => x[0]);
  assert.deepStrictEqual(fout, []);
});

test('marker in de ingang: telstand schrijft zoals nu, legt alleen soorten vast, bewaarregel; vasthouden houdt op de pod', async () => {
  const o = await omgeving();
  try {
    const g = gevallen()[4];
    // patiëntbrief als WhatsApp-document (verzonnen): in telstand gewoon in de vault, marker gemarkeerd, blob 90 dagen, niet offsite
    const e = g.env(); const brief = PDF(BRIEF); e.onderdelen[0] = bdeel('b1', 'bijlage', 'notulen.pdf', brief, 'application/pdf');
    const r = await post(o, g.sleutel, e);
    const k = await put(o, g.sleutel, r.j.stuk_id, 'b1', brief, 'application/pdf');
    assert.strictEqual(k.j.vault, 'geschreven');
    assert.strictEqual(await o.ing.markeer(r.j.stuk_id), null);    // draaide al ná het antwoord (of nu): niet opnieuw
    await new Promise((x) => setTimeout(x, 50));
    const s = o.ing._db.prepare('SELECT * FROM stuk WHERE stuk_id = ?').get(r.j.stuk_id);
    assert.strictEqual(s.marker_patient, 'gemarkeerd'); assert.strictEqual(s.marker_versie, 'patientpoort-2.0');
    const soorten = JSON.parse(s.marker_soorten);
    assert.ok(soorten.includes('bsn') || soorten.includes('brieftaal'), soorten.join(','));
    assert.ok(!/Proefpersoon|111222333|ferrofumaraat/.test(s.marker_soorten), 'geen tekst of waarden in het logboek');
    const b = o.ing._db.prepare('SELECT * FROM blob WHERE sha256 = ?').get(sha(brief));
    assert.strictEqual(b.offsite, 0); assert.ok(b.bewaar_tot && Date.parse(b.bewaar_tot) - o.klok.t > 89 * 86400000);
    // ongemarkeerd: offsite = 1, geen bewaartermijn
    const f = gevallen()[0]; const rf = await post(o, f.sleutel, f.env()); await put(o, f.sleutel, rf.j.stuk_id, 'b1', f.put[0][1], 'application/pdf');
    await new Promise((x) => setTimeout(x, 50));
    assert.strictEqual(o.ing._db.prepare('SELECT marker_patient FROM stuk WHERE stuk_id = ?').get(rf.j.stuk_id).marker_patient, 'geen');
    assert.strictEqual(o.ing._db.prepare('SELECT offsite FROM blob WHERE sha256 = ?').get(sha(f.put[0][1])).offsite, 1);
    // spraak: origineel alleen op de pod, niet te lezen, niet in de vault
    const sp = g.env(); sp.bron_id = 'false_31600000000@c.us_3EB0SPRAAK00001'; sp.meta.berichttype = 'spraak'; delete sp.meta.originele_naam; delete sp.overgang;
    sp.onderdelen = [bdeel('o1', 'origineel', 'spraak.ogg', OGG, 'audio/ogg')];
    const rs = await post(o, g.sleutel, sp); const ks = await put(o, g.sleutel, rs.j.stuk_id, 'o1', OGG, 'audio/ogg');
    assert.strictEqual(ks.j.compleet, true); assert.strictEqual(ks.j.vault, undefined);
    await new Promise((x) => setTimeout(x, 50));
    assert.strictEqual(o.ing._db.prepare('SELECT marker_patient FROM stuk WHERE stuk_id = ?').get(rs.j.stuk_id).marker_patient, 'niet_te_lezen');
    // bewaartermijn: na 91 dagen weg met een spoorregel
    o.klok.t += 91 * 86400000;
    const ro = await o.ing.ronde();
    assert.ok(ro.weg >= 2, JSON.stringify(ro));
    assert.ok(!fs.existsSync(path.join(o.dir, 'blob', sha(OGG).slice(0, 2), sha(OGG))));
    assert.ok(fs.existsSync(path.join(o.dir, 'blob', sha(f.put[0][1]).slice(0, 2), sha(f.put[0][1]))), 'ongemarkeerd blijft');
    assert.ok(o.ing._db.prepare("SELECT count(*) n FROM spoor WHERE soort = 'bewaartermijn'").get().n >= 2);
    // offsite-lijst (intake-blob-offsite.sh): alleen ongemarkeerd
    const lijst = require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'intake-ingang.js'), 'offsite-lijst', path.join(o.dir, 'intake.sqlite')]).toString().trim().split('\n');
    assert.ok(lijst.includes(sha(f.put[0][1]).slice(0, 2) + '/' + sha(f.put[0][1])));
    assert.ok(!lijst.some((x) => x.endsWith(sha(brief)) || x.endsWith(sha(OGG))));
    // schakelaar vasthouden (alleen whatsapp:nl): gemarkeerd stuk blijft op de pod, ongemarkeerd wordt na de marker geschreven
    fs.writeFileSync(path.join(o.dir, 'marker.json'), JSON.stringify({ stand: 'vasthouden', bronnen: ['whatsapp:nl'] }));
    const v = g.env(); v.bron_id = 'false_31600000000@c.us_3EB0VAST000001'; const brief2 = PDF(BRIEF + '\n2');
    v.onderdelen[0] = bdeel('b1', 'bijlage', 'notulen.pdf', brief2, 'application/pdf'); v.overgang.bestandsnaam = '2026-10-24_2113 - Voorbeeld groep - brief (VAST01).pdf';
    const rv = await post(o, g.sleutel, v); const kv = await put(o, g.sleutel, rv.j.stuk_id, 'b1', brief2, 'application/pdf');
    assert.strictEqual(kv.status, 202); assert.strictEqual(kv.j.vault, 'wacht');
    await o.ing.markeer(rv.j.stuk_id);
    assert.strictEqual(o.ing._db.prepare('SELECT status FROM stuk WHERE stuk_id = ?').get(rv.j.stuk_id).status, 'vastgehouden');
    assert.ok(!fs.existsSync(path.join(o.vault, '30_Conversaties/WhatsApp/Media/Documenten', v.overgang.bestandsnaam)));
    const n = g.env(); n.bron_id = 'false_31600000000@c.us_3EB0VAST000002'; const gewoon = PDF('Agenda van het overleg: opening, notulen vorige keer, rooster, rondvraag en sluiting.');
    n.onderdelen[0] = bdeel('b1', 'bijlage', 'notulen.pdf', gewoon, 'application/pdf'); n.overgang.bestandsnaam = '2026-10-24_2114 - Voorbeeld groep - agenda (VAST02).pdf';
    const rn = await post(o, g.sleutel, n); await put(o, g.sleutel, rn.j.stuk_id, 'b1', gewoon, 'application/pdf');
    await o.ing.markeer(rn.j.stuk_id);
    assert.strictEqual(o.ing._db.prepare('SELECT status FROM stuk WHERE stuk_id = ?').get(rn.j.stuk_id).status, 'geschreven');
    assert.ok(fs.existsSync(path.join(o.vault, '30_Conversaties/WhatsApp/Media/Documenten', n.overgang.bestandsnaam)));
    // een andere bron valt niet onder de schakelaar
    const sg = gevallen()[5]; const rsg = await post(o, sg.sleutel, sg.env()); assert.strictEqual(rsg.j.vault, 'geschreven');
  } finally { await o.sluit(); }
});

test('telling en info: alleen aantallen, nooit inhoud of sleutels', async () => {
  const o = await omgeving();
  try {
    const s = gevallen()[5]; await post(o, s.sleutel, s.env()); await post(o, s.sleutel, s.env()); await post(o, sleutelHex(), s.env());
    const t = o.ing.telling('2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z');
    assert.strictEqual(t.per_bron.signal.aanleveringen, 2); assert.strictEqual(t.per_bron.signal.dubbel, 1);
    const i = o.ing.info();
    assert.strictEqual(i.sleutels, 9); assert.strictEqual(i.profielen.length, 8); assert.strictEqual(i.marker, 'tellen');
    const alles = JSON.stringify(t) + JSON.stringify(i);
    for (const k of Object.values(K)) assert.ok(!alles.includes(k) && !alles.includes(sha(k)));
    assert.ok(!alles.includes('Proefgroep'));
  } finally { await o.sluit(); }
});
