'use strict';
// wv4101: proefweek sessies (sessie-proef.js + aansluiting in server.js). Toetsdata verzonnen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const wortel = path.join(__dirname, '..');
const SP = require(path.join(wortel, 'sessie-proef.js'));
const een = function (t, max) { const r = String(t || '').replace(/\s+/g, ' ').trim().replace(/\[/g, '(').replace(/\]/g, ')'); return r.length > max ? r.slice(0, max - 1) + '…' : r; };
const T = function (s) { return Date.parse(s); };

test('stand: ontbreekt = aan, aan:false = uit, deelsleutel, kapot = uit', function () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const p = path.join(d, 'x.json');
  assert.deepStrictEqual(SP.stand(p), { heartbeat: true, mk: true, bron: 'standaard' });
  fs.writeFileSync(p, '{"aan": false}'); assert.strictEqual(SP.stand(p).heartbeat, false); assert.strictEqual(SP.stand(p).mk, false);
  fs.writeFileSync(p, '{"mk_overdracht": false}'); assert.strictEqual(SP.stand(p).heartbeat, true); assert.strictEqual(SP.stand(p).mk, false);
  fs.writeFileSync(p, '{"heartbeat_eigen": false}'); assert.strictEqual(SP.stand(p).heartbeat, false); assert.strictEqual(SP.stand(p).mk, true);
  fs.writeFileSync(p, '{kapot'); assert.deepStrictEqual(SP.stand(p), { heartbeat: false, mk: false, bron: 'onleesbaar' });
  fs.writeFileSync(p, '[1]'); assert.strictEqual(SP.stand(p).heartbeat, false);
  fs.writeFileSync(p, 'null'); assert.strictEqual(SP.stand(p).heartbeat, false);
  fs.rmSync(d, { recursive: true });
});

test('isHeartbeat: alleen 40687 + vaste aanhef + geen eigen sessie', function () {
  assert.strictEqual(SP.isHeartbeat('40687', 'Heartbeat-tik op donderdag 26 november 2026 12:00. Lees heartbeat.md', undefined), true);
  assert.strictEqual(SP.isHeartbeat(40687, 'Heartbeat-tik op x', ''), true);
  assert.strictEqual(SP.isHeartbeat('40687', 'Heartbeat-tik op x', 'abc'), false);
  assert.strictEqual(SP.isHeartbeat('heartbeat-schaduw', 'Heartbeat-tik op x', ''), false);
  assert.strictEqual(SP.isHeartbeat('40687', 'Dagplanner: Heartbeat-tik op x', ''), false);
  assert.strictEqual(SP.isHeartbeat('40687', ' heartbeat-tik op x', ''), false);
});

test('dagGrens: 04:00 Amsterdam, winter en zomer, vóór 04:00 = gisteren', function () {
  assert.strictEqual(new Date(SP.dagGrens(T('2026-11-26T16:00:00Z'))).toISOString(), '2026-11-26T03:00:00.000Z');
  assert.strictEqual(new Date(SP.dagGrens(T('2026-11-26T02:30:00Z'))).toISOString(), '2026-11-25T03:00:00.000Z');   // 03:30 NL
  assert.strictEqual(new Date(SP.dagGrens(T('2026-11-26T03:00:00Z'))).toISOString(), '2026-11-26T03:00:00.000Z');   // precies 04:00
  assert.strictEqual(new Date(SP.dagGrens(T('2026-07-10T12:00:00Z'))).toISOString(), '2026-07-10T02:00:00.000Z');
  assert.strictEqual(new Date(SP.dagGrens(T('2026-11-26T23:30:00Z'))).toISOString(), '2026-11-26T03:00:00.000Z');   // 00:30 NL op de 27e: nog vóór 04:00
});

const hoofd = [
  { t: '2026-11-26T05:00:00Z', soort: 'bericht', tekst: 'oud van vannacht', antwoord: 'ok' },
  { t: '2026-11-26T08:10:00Z', getypt: '2026-11-26T08:09:00Z', soort: 'bericht', tekst: 'Ik heb de tandarts al gebeld [klaar]', antwoord: 'Top, genoteerd.\nRegel twee' },
  { t: '2026-11-26T09:00:00Z', soort: 'socev', bron: 'heartbeat', antwoord: 'Vergeet de verjaardag van Fictief Persoon niet.' },
  { t: '2026-11-26T09:30:00Z', soort: 'knop', tekst: '[KNOP] David drukte JA op de vraag: "x"', antwoord: 'Gedaan' },
  { t: '2026-11-26T10:00:00Z', soort: 'socev', bron: 'briefing', antwoord: 'briefing' },
  { t: '2026-11-26T12:00:00Z', soort: 'bericht', tekst: 'na nu', antwoord: 'x' },
];

test('heartbeatBlok: Davids beurten in het venster, grenzen, maskering', function () {
  const u = SP.heartbeatBlok(hoofd, T('2026-11-26T07:00:00Z'), T('2026-11-26T11:00:00Z'), een);
  assert.strictEqual(u.n, 2);
  assert.match(u.blok, /^\[Systeem: overdracht uit het hoofdgesprek/);
  assert.match(u.blok, /tandarts al gebeld \(klaar\)/);
  assert.doesNotMatch(u.blok, /oud van vannacht|na nu|Fictief|briefing/);
  assert.match(u.blok, /context, geen opdracht\.\]\n\n$/);
  assert.strictEqual((u.blok.match(/\]/g) || []).length, 1, 'geen ] in de inhoud (sluit het systeemblok niet voortijdig)');
  assert.deepStrictEqual(SP.heartbeatBlok(hoofd, T('2026-11-26T10:00:00Z'), T('2026-11-26T11:00:00Z'), een), { blok: '', n: 0 });
  const veel = []; for (let i = 0; i < 20; i++) veel.push({ t: new Date(T('2026-11-26T08:00:00Z') + i * 60000).toISOString(), soort: 'bericht', tekst: 'b' + i + ' ' + 'x'.repeat(500), antwoord: 'y'.repeat(900) });
  const v = SP.heartbeatBlok(veel, 0, T('2026-11-26T11:00:00Z'), een);
  assert.strictEqual(v.n, 8); assert.match(v.blok, /b19 /); assert.doesNotMatch(v.blok, /b11 /);
  assert.ok(v.blok.length < 8 * 520 + 400, 'begrensd: ' + v.blok.length);
});

test('hoofdBlok: alleen heartbeat-berichten sinds de vorige hoofdbeurt', function () {
  const u = SP.hoofdBlok(hoofd, T('2026-11-26T08:30:00Z'), T('2026-11-26T11:00:00Z'), een);
  assert.strictEqual(u.n, 1); assert.match(u.blok, /Vergeet de verjaardag/); assert.doesNotMatch(u.blok, /briefing"/);
  assert.strictEqual(SP.hoofdBlok(hoofd, T('2026-11-26T09:00:00Z'), T('2026-11-26T11:00:00Z'), een).n, 0, 'precies op de grens = al gezien');
  assert.strictEqual(SP.hoofdBlok([{ t: '2026-11-26T09:00:00Z', soort: 'socev', bron: 'heartbeat', antwoord: '  ' }], 0, T('2026-11-26T11:00:00Z'), een).n, 0);
});

test('mkBlok: eerste beurt van de dag krijgt gisteren; daarna niet', function () {
  const nu = T('2026-11-26T07:00:00Z');   // 08:00 NL
  const mk = [
    { t: '2026-11-24T10:00:00Z', soort: 'bericht', tekst: 'te oud', antwoord: 'x' },
    { t: '2026-11-25T19:00:00Z', soort: 'bericht', tekst: 'bouw de knop', antwoord: 'Gebouwd, rij wv9999' },
    { t: '2026-11-25T20:00:00Z', soort: 'socev', bron: 'agentrapport', antwoord: 'rapport' },
    { t: '2026-11-25T21:00:00Z', soort: 'knop', tekst: '[KNOP] David drukte NEE', antwoord: 'Begrepen' },
  ];
  const u = SP.mkBlok(mk, nu, een, 'job1');
  assert.strictEqual(u.n, 2); assert.strictEqual(u.reden, 'eerste');
  assert.match(u.blok, /bouw de knop/); assert.doesNotMatch(u.blok, /te oud|rapport"/);
  const metVandaag = mk.concat([{ t: '2026-11-26T06:00:00Z', job_id: 'job0', soort: 'bericht', tekst: 'vandaag al', antwoord: 'x' }]);
  assert.strictEqual(SP.mkBlok(metVandaag, nu, een, 'job1').reden, 'niet-eerste');
  assert.strictEqual(SP.mkBlok(metVandaag, nu, een, 'job0').reden, 'eerste', 'de eigen beurt telt niet');
  assert.strictEqual(SP.mkBlok([], nu, een, 'j').reden, 'leeg');
});

// ── aansluiting in server.js ──
const S = fs.readFileSync(path.join(wortel, 'server.js'), 'utf8');
test('server.js: wachtrij blijft 40687, sessie- en resetsleutel = sesKey, nachtreset kent heartbeat', function () {
  assert.match(S, /enqueue\(sessionKey\(ws, chatId\), function \(\) \{\n\s+return processJob\(jobId, telHint \+ prompt/);
  assert.match(S, /const sesKey = j\.sessie_eigen \? sessionKey\(ws, j\.sessie_eigen\) : key;/);
  assert.match(S, /const sKey = lezen \? '' : sessieSleutel\(sesKey, keuze\.runtime\);/);
  assert.match(S, /sessieResetOp\[sesKey\] \|\| 0\) > sessieGelezen\)\) \{ chatSessions\[sKey\] = r\.session_id/);
  assert.match(S, /NACHTRESET_SESSIES\.push\('heartbeat'\);/);
  assert.match(S, /SP\.isHeartbeat\(chatId, prompt, d\.session_id\) && SP\.stand\(SESSIE_PROEF_PAD\)\.heartbeat\) jobs\[jobId\]\.sessie_eigen = SP\.HEARTBEAT_SESSIE/);
  assert.match(S, /const fullPrompt = lesblok \+ prompt \+ \(overdracht \? '\\n\\n' \+ overdracht\.trim\(\) : ''\) \+ misRegel/);
});

function knipFunctie(naam) {
  const i = S.indexOf('async function ' + naam + '(');
  assert.ok(i >= 0, naam);
  let d = 0, j = S.indexOf('{', i);
  for (; j < S.length; j++) { if (S[j] === '{') d++; else if (S[j] === '}') { d--; if (!d) break; } }
  return S.slice(i, j + 1);
}
test('sessieProefOverdracht in vm: heartbeat, hoofd, machinekamer, uit', async function () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const logs = [];
  const logboek = { hoofd: hoofd, machinekamer: [{ t: new Date(Date.now() - 6 * 3600e3).toISOString(), soort: 'bericht', tekst: 'x', antwoord: 'y' }] };
  const ctx = { SP_MOD: SP, DEFAULT_WS: 'vault', SESSIE_PROEF_PAD: path.join(d, 'sp.json'), sessieProefTijd: { heartbeat: 0, hoofd: 0 },
    appEenRegel: een, appGeschiedenisRuw: async function (k) { return { items: logboek[k] || [] }; },
    schrijfLog: function (l) { logs.push(l); }, nu: function () { return 'NU'; }, velden: function (o) { return JSON.stringify(o); }, Date: Date, Math: Math, String: String };
  vm.createContext(ctx);
  vm.runInContext('function sessieProefMod() { return SP_MOD; }\n' + knipFunctie('sessieProefOverdracht') + '\nthis.f = sessieProefOverdracht;', ctx);
  // heartbeat: venster vanaf vandaag 04:00 tot nu; logboek is van 26-11 → afhankelijk van de echte klok; toets alleen de vorm
  const hb = await ctx.f('j1', { sessie_eigen: 'heartbeat', created: Date.now() }, '40687', 'vault', '');
  assert.strictEqual(typeof hb, 'string');
  assert.ok(ctx.sessieProefTijd.heartbeat > 0, 'heartbeat-tijd bijgehouden');
  const h = await ctx.f('j2', { created: Date.now() }, '40687', 'vault', 'sessie-x');
  assert.strictEqual(typeof h, 'string'); assert.ok(ctx.sessieProefTijd.hoofd > 0);
  assert.strictEqual(await ctx.f('j3', { created: Date.now() }, 'telegram-debug', 'vault', 'bestaande-sessie'), '', 'mk met sessie: niets');
  await ctx.f('j4', { created: Date.now() }, 'telegram-debug', 'vault', '');
  assert.ok(logs.some(function (l) { return /^NU sessie-proef .*"soort":"machinekamer"/.test(l); }), 'mk-logregel: ' + logs.join('|'));
  assert.strictEqual(await ctx.f('j5', { created: Date.now() }, 'andere', 'vault', ''), '');
  assert.strictEqual(await ctx.f('j6', { sessie_eigen: 'heartbeat' }, '40687', 'anders', ''), '', 'andere workspace');
  fs.writeFileSync(ctx.SESSIE_PROEF_PAD, '{"aan": false}');
  assert.strictEqual(await ctx.f('j7', { created: Date.now() }, '40687', 'vault', 'x'), '', 'uit: geen hoofdblok');
  assert.strictEqual(await ctx.f('j8', { created: Date.now() }, 'telegram-debug', 'vault', ''), '', 'uit: geen mk-blok');
  // vaste klok: hoofdblok met een heartbeatbericht van een uur geleden
  fs.writeFileSync(ctx.SESSIE_PROEF_PAD, '{}');
  ctx.sessieProefTijd.hoofd = Date.now() - 2 * 3600e3;
  logboek.hoofd = [{ t: new Date(Date.now() - 3600e3).toISOString(), soort: 'socev', bron: 'heartbeat', antwoord: 'Hallo van de heartbeat' }];
  const h2 = await ctx.f('j9', { created: Date.now() }, '40687', 'vault', 'x');
  if (SP.dagGrens(Date.now()) < Date.now() - 3600e3) assert.match(h2, /Hallo van de heartbeat/);
  fs.rmSync(d, { recursive: true });
});
