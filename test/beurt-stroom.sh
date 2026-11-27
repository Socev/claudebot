#!/usr/bin/env bash
# Toets wv3824 (21-11-2026, besluitenpagina nr 452 = 3C152 stap 2): het antwoord van Socev stroomt binnen in de wachtbel.
#   A  beurt-stroom.js: lezer (result-regel, niet-JSON-tekst, deel = laatste tekstblok van de hoofdagent, subagent/thinking/tool
#      genegeerd, ping telt niet als leven, regel zonder newline, te lange regel, herlees) en deelVoorApp (VRAAG AAN DAVID, [-regel,
#      half getypte vraagregel, staart 8 kB, kop bewaard boven 256 kB).
#   B  echte server.js (proefkopie, runClaude via global): dezelfde nep-uitvoer als json en als stream-json geeft hetzelfde r
#      (ok, output, session_id, verbruik, error) — ook bij is_error (limiet) en bij exit 1 zonder result; deel groeit tijdens de run;
#      na het einde en na een stop is deel leeg; zonder opts.stroom blijft de CLI op json.
#   C  app-beurt end-to-end (/app/beurt + /app/uitslag): deel groeit en zonder vraagregel, eindantwoord = het gestroomde + vraag;
#      een beurt die halverwege stopt (exit 1, geen result) geeft een fout en geen deel.
# Kruisproef: op main (zonder beurt-stroom.js / stroom-koppeling) is B en C rood.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
'use strict';
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'beurt-stroom-'));
let goed = 0, fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500) + ']' : '')); if (ok) goed++; else fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => crypto.randomBytes(n).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const SE = (event, parent) => JSON.stringify({ type: 'stream_event', event: event, session_id: 's', parent_tool_use_id: parent || null, uuid: hex(4) });
const blokStart = (i, type) => SE({ type: 'content_block_start', index: i, content_block: type === 'text' ? { type: 'text', text: '' } : { type: type, id: 'x', name: 'Bash', input: {} } });
const delta = (i, t) => SE({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } });

// ── A: module ──────────────────────────────────────────────────────────────────────────────────────────────────────────
let S = null; try { S = require(path.resolve('beurt-stroom.js')); } catch (e) {}
toets('A0 beurt-stroom.js laadt', !!S);
if (S) {
  let leven = 0, deelGezien = [];
  const l = S.maakLezer({ opDeel: (d) => deelGezien.push(d), opLeven: () => leven++ });
  const res = { type: 'result', subtype: 'success', is_error: false, result: 'Hallo David.', session_id: 'sid1', usage: { input_tokens: 3, output_tokens: 4 } };
  const regels = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid1' }),
    SE({ type: 'message_start', message: { id: 'm1' } }),
    blokStart(0, 'text'), delta(0, 'Ik kijk '), delta(0, 'even.'),
    SE({ type: 'content_block_stop', index: 0 }),
    blokStart(1, 'tool_use'), SE({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"geheim-commando"}' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'MAILINHOUD-GEHEIM ' + 'x'.repeat(200000) + ' "result" ' }] } }),
    blokStart(0, 'thinking'), SE({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'DENKWERK' } }),
    blokStart(0, 'text', 'sub'), delta(0, 'SUBAGENT-TEKST'),
  ];
  // subagent: parent_tool_use_id gezet
  regels[regels.length - 2] = SE({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'toolu_1');
  regels[regels.length - 1] = SE({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUBAGENT-TEKST' } }, 'toolu_1');
  const alles = regels.join('\n') + '\n';
  // in rare brokken (midden in regels en in een multibyte-teken: Buffer per 7 bytes)
  const buf = Buffer.from(alles + SE({ type: 'ping' }) + '\n' + blokStart(0, 'text') + '\n' + delta(0, 'Hallo ') + '\n' + delta(0, 'Davïd.') + '\n' + JSON.stringify(res));
  const sd = new (require('string_decoder').StringDecoder)('utf8');
  for (let i = 0; i < buf.length; i += 7) l.voeg(sd.write(buf.subarray(i, i + 7)));
  toets('A1 deel = alleen het laatste tekstblok van de hoofdagent', l.deel() === 'Hallo Davïd.', l.deel());
  toets('A2 geen subagent-, denk-, tool- of mailtekst in deel', !deelGezien.some((d) => /SUBAGENT|DENKWERK|geheim|MAILINHOUD/.test(d)), deelGezien);
  toets('A3 vóór het tool-blok was deel "Ik kijk even."', deelGezien.includes('Ik kijk even.'), deelGezien);
  toets('A4 result-regel zonder newline pas na sluit()', !l.heeftResult());
  l.sluit();
  toets('A5 slot() = de result-regel (JSON)', l.heeftResult() && JSON.parse(l.slot()).result === 'Hallo David.');
  // ping telt niet als leven
  let lv = 0; const l2 = S.maakLezer({ opLeven: () => lv++ });
  l2.voeg(SE({ type: 'ping' }) + '\n' + SE({ type: 'ping' }) + '\n');
  toets('A6 ping = geen teken van leven', lv === 0, lv);
  l2.voeg(JSON.stringify({ type: 'system', subtype: 'status' }) + '\n');
  toets('A7 andere regel = leven', lv === 1, lv);
  // niet-JSON-tekst voor de foutroute
  const l3 = S.maakLezer({}); l3.voeg('Error: No conversation found\n'); l3.voeg('tweede regel'); l3.sluit();
  toets('A8 zonder result: slot() = niet-JSON-tekst', !l3.heeftResult() && l3.slot() === 'Error: No conversation found\ntweede regel', l3.slot());
  // herlees: afgekapte buffer zonder result houdt de oude result-regel
  const l4 = S.maakLezer({}); l4.voeg(JSON.stringify(res) + '\n');
  const l5 = S.herlees(l4, Buffer.from(blokStart(0, 'text') + '\n' + delta(0, 'abc') + '\n'), {});
  toets('A9 herlees zonder result houdt de oude result-regel', l5.heeftResult() && JSON.parse(l5.slot()).session_id === 'sid1' && l5.deel() === 'abc');
  const l6 = S.herlees(l4, Buffer.from(JSON.stringify(Object.assign({}, res, { result: 'nieuw' })) + '\n'), {});
  toets('A10 herlees met result neemt de nieuwe', JSON.parse(l6.slot()).result === 'nieuw');
  // wv4180: fasen (alleen tijden en aantallen)
  const fa = l.fasen();
  toets('A11 fasen: init, model, werk, denk, tekst, antwoord, result gezet; stappen 1, tools 1, sub', ['init', 'model', 'werk', 'denk', 'tekst', 'antwoord', 'result'].every((k) => typeof fa[k] === 'number')
    && fa.stappen === 1 && fa.tools === 1 && fa.sub === true && fa.init <= fa.model && fa.model <= fa.tekst && fa.tekst <= fa.werk && fa.antwoord >= fa.tekst, fa);
  toets('A12 fasen bevatten geen inhoud', !/Hallo|geheim|MAILINHOUD|DENKWERK|SUBAGENT/.test(JSON.stringify(fa)) && Object.values(fa).every((x) => typeof x === 'number' || typeof x === 'boolean'), fa);
  const l8 = S.maakLezer({}); l8.voeg(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\n' + SE({ type: 'message_start', message: {} }) + '\n');
  const oudF = l8.fasen();
  const l9 = S.herlees(l8, Buffer.from(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' + SE({ type: 'message_start', message: {} }) + '\n' + SE({ type: 'message_start', message: {} }) + '\n' + blokStart(0, 'tool_use') + '\n'), {});
  const nf = l9.fasen();
  toets('A13 herlees: oude tijden winnen, aantallen van de hele buffer, merk herlezen', nf.init === oudF.init && nf.model === oudF.model && nf.stappen === 2 && nf.tools === 1 && typeof nf.werk === 'number' && nf.herlezen === true, [oudF, nf]);
  const l10 = S.maakLezer({}); l10.voeg('{"type":"assistant","message":{"content":[{"type":"text","text":"\\"subtype\\":\\"init\\""}]}}\n');
  toets('A14 tekst met "subtype":"init" in een assistant-regel telt niet als init', l10.fasen().init == null, l10.fasen());
  // knip
  const K = S.deelVoorApp;
  toets('K1 gewone tekst blijft', K('Goedemorgen.\nTwee regels.') === 'Goedemorgen.\nTwee regels.');
  toets('K2 VRAAG AAN DAVID-regel en alles erna weg', K('Antwoord.\n\nVRAAG AAN DAVID: Zal ik het doen?\nnog iets') === 'Antwoord.');
  toets('K3 vetgedrukte vraagregel weg', K('Antwoord.\n**VRAAG AAN DAVID:** Zal ik?') === 'Antwoord.');
  toets('K4 half getypte vraagregel weg', K('Antwoord.\nVRAAG AA') === 'Antwoord.' && K('Antwoord.\nV') === 'Antwoord.');
  toets('K5 [OPEN …]-regel weg', K('Antwoord.\n[OPEN mail 123]') === 'Antwoord.' && K('Antwoord.\n[') === 'Antwoord.');
  toets('K6 alleen een vraag = leeg', K('VRAAG AAN DAVID: x') === '' && K('') === '' && K(null) === '');
  toets('K7 link midden in een regel blijft', K('Zie [de pagina](/x) hier.') === 'Zie [de pagina](/x) hier.');
  const lang = Array.from({ length: 2000 }, (_, i) => 'regel ' + i).join('\n');
  const k8 = K(lang);
  toets('K8 staart hooguit 8 kB vanaf een regelgrens', k8.length <= S.APP_DEEL_MAX && /^regel \d+$/.test(k8.split('\n')[0]) && k8.endsWith('regel 1999'), k8.slice(0, 40));
  // kop bewaard boven MAX_DEEL (Codex ZOU 1): vraagregel vroeg, daarna 300 kB → nog steeds verborgen
  const l7 = S.maakLezer({});
  l7.voeg(blokStart(0, 'text') + '\n' + delta(0, 'Kort.\nVRAAG AAN DAVID: geheimpje?\n') + '\n');
  for (let i = 0; i < 40; i++) l7.voeg(delta(0, 'y'.repeat(8000) + '\n') + '\n');
  toets('K9 vraagregel blijft verborgen boven 256 kB (kop bewaard)', l7.deel().length <= S.MAX_DEEL && K(l7.deel()) === 'Kort.', K(l7.deel()).slice(0, 40));
}

// ── B en C: echte server.js ────────────────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(W, 'bin'));
const ARGLOG = path.join(W, 'args.jsonl');
// nep-claude: SLEUTEL bepaalt het scenario; stroomt bij stream-json in stukjes met pauzes, anders één json-object
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), prompt = a[a.length - 1];
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const fmt = a[a.indexOf('--output-format') + 1];
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : a[a.indexOf('--resume') + 1];
fs.appendFileSync(${JSON.stringify(ARGLOG)}, JSON.stringify({ sleutel, fmt, partial: a.includes('--include-partial-messages'), verbose: a.includes('--verbose') }) + '\\n');
const proj = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
const tp = path.join(proj, sid + '.jsonl');
fs.appendFileSync(tp, JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, timestamp: new Date().toISOString() }) + '\\n');
const stukken = ['Goed', 'emorgen ', 'David.\\n\\n', 'Het ', 'weer is ', 'mooi.', '\\n\\nVRAAG AAN ', 'DAVID: Zal ik de ', 'fiets pakken?'];
const tekst = stukken.join('');
const isFout = sleutel === 'limiet';
const res = { type: 'result', subtype: 'success', is_error: isFout, result: isFout ? "You've hit your limit · resets 7pm" : tekst, session_id: sid,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }, total_cost_usd: 0.01, num_turns: 1,
  modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.01 } } };
const pauze = /traag/.test(prompt) ? 600 : 30;
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const se = (ev) => JSON.stringify({ type: 'stream_event', event: ev, session_id: sid, parent_tool_use_id: null, uuid: 'u' });
(async () => {
  if (fmt !== 'stream-json') { await slaap(pauze); process.stdout.write(JSON.stringify(res)); return process.exit(0); }
  const w = (s) => process.stdout.write(s + '\\n');
  w(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
  w(se({ type: 'message_start', message: { id: 'm' } }));
  w(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  for (let i = 0; i < stukken.length; i++) {
    if (sleutel === 'breek' && i === 4) { await slaap(pauze); process.stderr.write('kapot\\n'); return process.exit(1); }
    w(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: stukken[i] } }));
    w(se({ type: 'ping' }));
    await slaap(pauze);
  }
  w(se({ type: 'content_block_stop', index: 0 }));
  w(se({ type: 'message_stop' }));
  if (sleutel === 'geenresult') { process.stdout.write('Error: iets ging mis\\n'); return process.exit(1); }
  fs.appendFileSync(tp, JSON.stringify({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: tekst }], stop_reason: 'end_turn' }, timestamp: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify(res));   // zonder newline, zoals de CLI aan het eind
  process.exit(0);
})();
`, { mode: 0o755 });

const sb = http.createServer((q, r) => { let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
  if (q.url.indexOf('/cdn-cgi/access/certs') === 0) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ keys: [jwk] })); }
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify([{ actieve_kant: 'olares', sinds: '2026-10-01T00:00:00Z' }])); }
  r.writeHead(201, { 'content-type': 'application/json' }); r.end('[]'); }); });
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256' });

sb.listen(0, '127.0.0.1', async () => {
  const d = path.join(W, 'srv');
  ['home', 'vault', 'repo', 'io', 'jobout', 'app-data', 'app-log'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true, mode: 0o700 }));
  const DATA = path.join(d, 'app-data'), TEAM = 'http://127.0.0.1:' + sb.address().port, AUD = 'a'.repeat(64), CLIENT = 'proefclient.access', POORTGEHEIM = 'p'.repeat(64);
  const APPARAAT = 'abcdef0123456789', APP_GEHEIM = hex(32), SESSIE = hex(32);
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ access_team: TEAM, access_aud: AUD, servicetoken_client_id: CLIENT, herkomst: 'https://app.socev.dev', rp_id: 'app.socev.dev' }));
  fs.writeFileSync(path.join(DATA, 'apparaten.json'), JSON.stringify({ versie: 1, ooit_gekoppeld: true, apparaten: [{ id: APPARAAT, naam: 'Proef', actief: true, soort: 'reist', cookie_hash: sha(APP_GEHEIM), credential: { id: 'cred1' }, gekoppeld: new Date().toISOString() }] }), { mode: 0o600 });
  fs.writeFileSync(path.join(DATA, 'sessies.json'), JSON.stringify({ versie: 1, sessies: { [sha(SESSIE)]: { apparaat: APPARAAT, credential: 'cred1', start: Date.now() - 1000, tot: Date.now() + 3 * 3600000 } } }), { mode: 0o600 });
  const poort = vrijePoort();
  Object.assign(process.env, {
    PATH: path.join(W, 'bin') + ':' + process.env.PATH, LANG: 'C.UTF-8', TZ: 'Europe/Amsterdam',
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'),
    APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: DATA, APP_UIT_BESTAND: path.join(d, 'app-uit'), APP_UPLOAD_DIR: path.join(d, 'upload'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', N8N_API_KEY: '',
    SUPABASE_URL: TEAM, SUPABASE_SERVICE_ROLE: 'nep', SOCEV_KANT: 'olares', ROL_BESTAND: path.join(d, 'uitwijk-rol'),
    APP_POORT_SECRET: POORTGEHEIM, PORT: String(poort), MAX_AGENTS: '20' });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.SOCEV_AGENT_RUN; delete process.env.ANTHROPIC_MODEL;
  fs.writeFileSync(path.join(d, 'runtime.json'), JSON.stringify({ default: 'claude', fallback: '', models: { claude: 'claude-opus-5-5' } }));
  const SRV = path.join(d, 'server.js');
  fs.writeFileSync(SRV, fs.readFileSync('server.js', 'utf8') + '\n;global.__proefRunClaude = runClaude;\n');
  for (const m of ['beurt-stroom.js', 'beurt-stappen.js']) if (fs.existsSync(m)) fs.copyFileSync(m, path.join(d, m));
  for (const m of fs.readdirSync('.')) if (/\.js$/.test(m) && !fs.existsSync(path.join(d, m))) { try { fs.symlinkSync(path.resolve(m), path.join(d, m)); } catch (e) {} }
  try { fs.symlinkSync(path.resolve('node_modules'), path.join(d, 'node_modules')); } catch (e) {}
  require(SRV);
  const req = (methode, pad, body, koppen) => new Promise((ok) => {
    const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: Object.assign({ 'content-type': 'application/json' }, koppen || {}) }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); }); });
    r.on('error', (e) => ok({ _status: 0, fout: e.message })); if (body) r.write(JSON.stringify(body)); r.end(); });
  for (let i = 0; i < 100; i++) { const h = await req('GET', '/health'); if (h._status === 200) break; await slaap(200); }
  const argsVan = (sl) => { try { return fs.readFileSync(ARGLOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((x) => x.sleutel === sl); } catch (e) { return []; } };
  try {
    const RC = global.__proefRunClaude;
    const cwd = path.join(d, 'vault'), outdir = fs.mkdtempSync(path.join(W, 'out-'));
    const vergelijk = async (sl, naam) => {
      const pj = {}, ps = {};
      const rj = await RC('SLEUTEL:' + sl + ' vraag', '', outdir, cwd, 'claude-opus-5-5', { progress: pj });
      const rs = await RC('SLEUTEL:' + sl + ' vraag', '', outdir, cwd, 'claude-opus-5-5', { progress: ps, stroom: true });
      const kies = (r) => ({ ok: r.ok, output: r.output, error: r.error, verbruik: r.verbruik, exit_code: r.exit_code, account: r.account, opmerking: r.opmerking });
      const fmt = argsVan(sl).map((x) => x.fmt + (x.partial ? '+partial' : '') + (x.verbose ? '+verbose' : ''));
      toets('B ' + naam + ': json-route zonder stroom, stroomroute met stream-json + verbose + partial', fmt[0] === 'json' && fmt[1] === 'stream-json+partial+verbose', fmt);
      toets('B ' + naam + ': r gelijk (ok/output/error/verbruik/exit)', JSON.stringify(kies(rj)) === JSON.stringify(kies(rs)), [kies(rj), kies(rs)]);
      toets('B ' + naam + ': session_id gezet en van de eigen run', !!rs.session_id && rs.session_id !== rj.session_id && rs.session_id === rs.eigen_sessie, [rs.session_id, rs.eigen_sessie]);
      toets('B ' + naam + ': deel leeg na het einde', ps.deel === '', ps.deel);
      return [rj, rs];
    };
    const [gj] = await vergelijk('gewoon', 'gewoon antwoord');
    toets('B gewoon: output = hele tekst met vraag', gj.ok === true && /fiets pakken\?$/.test(gj.output), gj.output);
    const [lj, ls] = await vergelijk('limiet', 'is_error (limiet)');
    toets('B limiet: ok false, error cli-fout, tekst met limit (merk() maakt er limiet van)', ls.ok === false && ls.error === 'cli-fout' && /hit your limit/.test(ls.output));
    // geen result (exit 1): json-route geeft out.trim() = '' ; stroomroute de niet-JSON-tekst. Beide ok false.
    const pg = {}; const rg = await RC('SLEUTEL:geenresult x', '', outdir, cwd, '', { progress: pg, stroom: true });
    toets('B geen result-regel: ok false, output = niet-JSON-tekst, deel leeg', rg.ok === false && rg.output === 'Error: iets ging mis' && pg.deel === '', [rg, pg.deel]);
    // deel groeit tijdens de run; stop → meteen leeg
    const pt = {}; const pr = RC('SLEUTEL:gewoon traag', '', outdir, cwd, '', { progress: pt, stroom: true });
    const gezien = [];
    for (let i = 0; i < 40 && gezien.length < 3; i++) { await slaap(150); if (pt.deel && gezien[gezien.length - 1] !== pt.deel) gezien.push(pt.deel); }
    toets('B deel groeit tijdens de run', gezien.length >= 2 && gezien.every((x, i) => i === 0 || x.startsWith(gezien[i - 1]) && x.length > gezien[i - 1].length), gezien);
    pt.stoppen();
    toets('B na stop meteen geen deel meer', pt.deel === '', pt.deel);
    const prr = await pr;
    toets('B gestopte beurt: geen ok, deel blijft leeg', prr.ok === false && pt.deel === '', [prr.ok, prr.error, pt.deel]);

    // ── C: app-beurt end-to-end ──
    const jwt = () => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const kop = b({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), inh = b({ iss: TEAM, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, common_name: CLIENT });
      return kop + '.' + inh + '.' + crypto.sign('RSA-SHA256', Buffer.from(kop + '.' + inh), privateKey).toString('base64url'); };
    const K = () => ({ 'x-app-poort': POORTGEHEIM, 'cf-access-jwt-assertion': jwt(), 'x-app-apparaat': APPARAAT + '.' + APP_GEHEIM, 'x-app-sessie': SESSIE, 'x-app-ua': 'Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/141.0' });
    const beurt = async (sl, id) => {
      const r = await req('POST', '/app/beurt', { kanaal: 'hoofd', beurt_id: id, tekst: 'SLEUTEL:' + sl + ' traag proefvraag' }, K());
      const delen = []; let u = {};
      for (let i = 0; i < 120; i++) {
        u = await req('POST', '/app/uitslag', { job_id: r.job_id }, K());
        if (u.klaar) break;
        if (typeof u.deel === 'string' && delen[delen.length - 1] !== u.deel) delen.push(u.deel);
        await slaap(200);
      }
      return { r, u, delen };
    };
    const c1 = await beurt('gewoon', 'proef-stroom-001');
    toets('C1 beurt gestart', !!c1.r.job_id, c1.r);
    toets('C1 deel groeit in /app/uitslag', c1.delen.length >= 3 && c1.delen.every((x, i) => i === 0 || x.length >= c1.delen[i - 1].length), c1.delen);
    toets('C1 nooit een (half getoonde) vraagregel in deel', c1.delen.length > 0 && !c1.delen.some((x) => /VRAAG|DAVID:|fiets/.test(x)), c1.delen);
    toets('C1 klaar: antwoord = gestroomde tekst + vraag, geen deel meer', c1.u.klaar === true && c1.u.gelukt !== false && String(c1.u.antwoord || '').startsWith(c1.delen[c1.delen.length - 1]) && c1.u.deel === undefined,
      { u: Object.assign({}, c1.u, { antwoord: String(c1.u.antwoord).slice(0, 120) }), laatste: c1.delen[c1.delen.length - 1] });
    // wv4180: de regel in het app-log krijgt fasen (alleen tijden, oplopend), de app krijgt ze niet
    let regelC1 = null;
    for (let i = 0; i < 30 && !regelC1; i++) {
      try { regelC1 = fs.readFileSync(path.join(d, 'app-log', 'hoofd.' + 'jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((x) => x.job_id === c1.r.job_id) || null; } catch (e) {}
      if (!regelC1) await slaap(100);
    }
    const fz = regelC1 && regelC1.fasen;
    const volg = fz ? ['rij', 'voor', 'gestart', 'init', 'model', 'tekst', 'antwoord', 'result', 'eind'].map((k) => fz[k]) : [];
    toets('C3 app-log: fasen per beurt, oplopend van rij tot eind', !!fz && volg.every((x) => typeof x === 'number') && volg.every((x, i) => i === 0 || x >= volg[i - 1]) && fz.werk === null && fz.stappen === 1 && fz.tools === 0 && fz.hervat === false, fz);
    toets('C3 fasen zonder inhoud', !!fz && !/Goed|David|fiets|proefvraag|SLEUTEL/.test(JSON.stringify(fz)), fz);
    toets('C3 eind ≈ duur van de beurt (traag: ≥ 9 × 600 ms)', !!fz && fz.eind >= 5000 && fz.eind - fz.model >= 4800, fz);
    const gesch = await req('GET', '/app/geschiedenis/hoofd', null, K());
    const gs = JSON.stringify(gesch);
    toets('C3 geschiedenis voor de app zonder fasen (en de beurt staat erin)', gesch._status === 200 && gs.includes(c1.r.job_id) && !gs.includes('"fasen"') && !gs.includes('"stappen"'), gs.slice(0, 300));
    const c2 = await beurt('breek', 'proef-stroom-002');
    toets('C2 afgebroken beurt: fout, geen deel na afloop', c2.u.klaar === true && c2.u.gelukt === false && c2.u.deel === undefined && !String(c2.u.antwoord || '').includes('Het weer'),
      Object.assign({}, c2.u, { delen: c2.delen }));
  } catch (e) { toets('geen uitzondering', false, e && e.stack); }
  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  process.exit(fout ? 1 : 0);
});
JS
