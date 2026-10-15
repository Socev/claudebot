#!/usr/bin/env bash
# Toetst (wv479, 16-10-2026): POST /agent met een adviseur (claude --advisor) en de proefteller advisor-proef.json.
# (1) advisor 'opus' bij runtime claude gaat als --advisor naar de CLI, ook in een hervatting van de eindcontrole; model en
# adviseur staan in /agents en in de joblog; (2) een onbekende adviseur en een adviseur bij een andere runtime worden geweigerd;
# (3) de proefteller geeft alleen tikker-rijen (label machinekamer:wv<id> + "[Werkvoorraad, item wv<id>]" in de prompt) zonder
# eigen keuze het proefmodel + de adviseur, tot max; uitsluitwoorden in label of eigen opdracht (niet in het vaste grondwetblok)
# slaan over; aan:false doet niets. Laadt de ECHTE server.js met een nep-claude die zijn argumenten en ANTHROPIC_MODEL vastlegt.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(path.join(W, 'bin'));
const ARGLOG = path.join(W, 'args.jsonl');
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), prompt = a[a.length - 1];
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const hervat = a.includes('--resume');
const sid = hervat ? a[a.indexOf('--resume') + 1] : (a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : 'x');
fs.appendFileSync(${JSON.stringify(ARGLOG)}, JSON.stringify({ sleutel: sleutel, sid: sid, hervat: hervat, advisor: a.includes('--advisor') ? a[a.indexOf('--advisor') + 1] : null, model: process.env.ANTHROPIC_MODEL || null }) + '\\n');
const tekst = (sleutel === 'wacht' && !hervat) ? 'Ik wacht nu op de build.' : 'klaar ' + sleutel;
setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: tekst, session_id: sid })); process.exit(0); }, 200);
`, { mode: 0o755 });
const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  s.end('{}'); }); });
hook.listen(0, '127.0.0.1', async () => {
  const d = path.join(W, 'pod');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach(m => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.writeFileSync(path.join(d, 'server.js'), fs.readFileSync('server.js', 'utf8').split('const AGENT_START_SPREIDING_MS = 20 * 1000;').join('const AGENT_START_SPREIDING_MS = 100;')
    .split('const EIND_BEZINK_MS = 5 * 1000;').join('const EIND_BEZINK_MS = 100;'));
  const PROEF = path.join(d, 'advisor-proef.json');
  const poort = vrijePoort();
  Object.assign(process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), ADVISOR_PROEF_FILE: PROEF,
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '20',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.SOCEV_AGENT_RUN; delete process.env.ANTHROPIC_MODEL;
  fs.writeFileSync(path.join(d, 'runtime.json'), JSON.stringify({ default: 'claude', fallback: '', models: { claude: 'claude-opus-5-5' } }));
  require(path.join(d, 'server.js'));
  const vraag = (methode, pad, body) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); }); }); r.on('error', nok); r.end(body ? JSON.stringify(body) : undefined); });
  const agent = (o) => vraag('POST', '/agent', Object.assign({ secret: 'proef', chat_id: '40687', workspace: 'vault' }, o));
  const argsVan = sl => { try { return fs.readFileSync(ARGLOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x => x.sleutel === sl); } catch (e) { return []; } };
  const wachtOp = async (sl, n) => { const t0 = Date.now(); while (Date.now() - t0 < 15000 && argsVan(sl).length < (n || 1)) await slaap(100); return argsVan(sl); };
  // Tikker-vorm: grondwetblok vooraan (met de vaste woorden Fable-voorlegkaart en sleutels), dan --- , de opdracht, dan de tikkerregel.
  const BLOK = 'GRONDWET-KERN v1\n4. NIET BOUWEN ZONDER REVIEW ... langs de Fable-voorlegkaart. Kaart zonder patiënten of sleutels; SECRETS nooit.\n\n---\n';
  const tikPrompt = (wv, opdracht) => BLOK + opdracht + '\n\n[Werkvoorraad, item wv' + wv + '] SLOTREGEL: ... beveiliging ciso Fable-review (staat in de vaste staart en telt niet)';
  const proef = () => JSON.parse(fs.readFileSync(PROEF, 'utf8'));
  try {
    for (let i = 0; i < 50; i++) { try { await vraag('GET', '/agents'); break; } catch (e) { await slaap(200); } }

    // (1) expliciete adviseur
    const a1 = await agent({ label: 'machinekamer:los advisor', prompt: 'SLEUTEL:expl', runtime: 'claude', model: 'claude-sonnet-5-5', advisor: 'Opus' });
    toets('advisor opus aangenomen, antwoord noemt model en adviseur', a1.ok === true && a1.advisor === 'opus' && a1.model === 'claude-sonnet-5-5', JSON.stringify(a1));
    let r = await wachtOp('expl');
    toets('CLI kreeg --advisor opus en ANTHROPIC_MODEL=claude-sonnet-5-5', r.length === 1 && r[0].advisor === 'opus' && r[0].model === 'claude-sonnet-5-5', JSON.stringify(r));
    const a2 = await agent({ label: 'machinekamer:los zonder', prompt: 'SLEUTEL:zonder', runtime: 'claude' });
    r = await wachtOp('zonder');
    toets('zonder advisor: geen --advisor, standaardmodel', a2.ok === true && a2.advisor === undefined && r.length === 1 && r[0].advisor === null && r[0].model === 'claude-opus-5-5', JSON.stringify(r));
    const a3 = await agent({ label: 'machinekamer:los wacht', prompt: 'SLEUTEL:wacht', advisor: 'claude-opus-5-5', model: 'claude-sonnet-5-5' });
    r = await wachtOp('wacht');
    // De hervatprompt draagt de SLEUTEL niet; de hervatting is de aanroep met --resume op dezelfde sessie.
    const hv = async () => { const t0 = Date.now(); let h = []; while (Date.now() - t0 < 15000) { h = argsVan('x').filter(x => x.hervat && r[0] && x.sid === r[0].sid); if (h.length) break; await slaap(100); } return h; };
    const h = await hv();
    toets('hervatting door de eindcontrole houdt --advisor en het model', r.length === 1 && h.length === 1 && h[0].advisor === 'claude-opus-5-5' && h[0].model === 'claude-sonnet-5-5', JSON.stringify(r.concat(h)));

    // (2) weigeringen
    const f1 = await agent({ label: 'machinekamer:los fout', prompt: 'SLEUTEL:fout1', advisor: 'fable' });
    toets('onbekende adviseur: 400 onbekende-adviseur', f1._status === 400 && f1.error === 'onbekende-adviseur', JSON.stringify(f1));
    const f2 = await agent({ label: 'machinekamer:los fout', prompt: 'SLEUTEL:fout2', advisor: 'opus', runtime: 'codex' });
    toets('adviseur bij codex: 400 adviseur-alleen-claude', f2._status === 400 && f2.error === 'adviseur-alleen-claude', JSON.stringify(f2));
    const f3 = await agent({ label: 'machinekamer:los fout', prompt: 'SLEUTEL:fout3', advisor: 'opus', model: 'astra' });
    toets('adviseur bij een codex-alias: 400', f3._status === 400 && f3.error === 'adviseur-alleen-claude', JSON.stringify(f3));
    await slaap(500);
    toets('geweigerde starts riepen de CLI niet aan', !argsVan('fout1').length && !argsVan('fout2').length && !argsVan('fout3').length);

    // (3) proefteller
    fs.writeFileSync(PROEF, JSON.stringify({ aan: true, model: 'claude-sonnet-5-5', advisor: 'opus', max: 2, jobs: [] }));
    const p1 = await agent({ label: 'machinekamer:wv900 gewone klus', prompt: tikPrompt(900, 'SLEUTEL:proefa doe iets gewoons'), max_minuten: 30 });
    r = await wachtOp('proefa');
    toets('tikker-rij krijgt proefmodel + adviseur', p1.advisor_proef === true && r.length === 1 && r[0].advisor === 'opus' && r[0].model === 'claude-sonnet-5-5', JSON.stringify(p1) + JSON.stringify(r));
    toets('proefbestand: job vastgelegd met wv en job_id', proef().jobs.length === 1 && proef().jobs[0].wv === 900 && proef().jobs[0].job_id === p1.job_id);
    const s1 = await agent({ label: 'machinekamer:wv901 ciso-ronde', prompt: tikPrompt(901, 'SLEUTEL:ciso doe de ronde') });
    const s2 = await agent({ label: 'machinekamer:wv902 pod-wijziging', prompt: tikPrompt(902, 'SLEUTEL:fablerev bouw dit en laat een Fable-review doen') });
    const s3 = await agent({ label: 'machinekamer:los zonder wv', prompt: tikPrompt(903, 'SLEUTEL:geenwv') });
    const s4 = await agent({ label: 'machinekamer:wv904 andere regel', prompt: tikPrompt(905, 'SLEUTEL:anderwv') });
    const s5 = await agent({ label: 'machinekamer:wv906 eigen model', prompt: tikPrompt(906, 'SLEUTEL:eigen'), model: 'claude-opus-5-5' });
    const s6 = await agent({ label: 'socev:wv907 socev-rij', prompt: tikPrompt(907, 'SLEUTEL:socev') });
    for (const sl of ['ciso', 'fablerev', 'geenwv', 'anderwv', 'eigen', 'socev']) await wachtOp(sl);
    const geen = ['ciso', 'fablerev', 'geenwv', 'anderwv', 'eigen', 'socev'].map(sl => [sl, argsVan(sl)[0]]).filter(x => !x[1] || x[1].advisor !== null);
    toets('uitgesloten/niet-tikker/eigen keuze: geen adviseur', geen.length === 0 && [s1, s2, s3, s4, s5, s6].every(x => x.ok && !x.advisor_proef), JSON.stringify(geen));
    const pr = proef();
    toets('ciso en Fable-review overgeslagen met raakwoord; vaste blok/staart telt niet', pr.jobs.length === 1 && pr.overgeslagen.length === 2 &&
      /ciso/i.test(pr.overgeslagen[0].raak) && /fable-review/i.test(pr.overgeslagen[1].raak), JSON.stringify(pr.overgeslagen));
    const p2 = await agent({ label: 'machinekamer:wv908 tweede', prompt: tikPrompt(908, 'SLEUTEL:proefb') });
    const p3 = await agent({ label: 'machinekamer:wv909 derde', prompt: tikPrompt(909, 'SLEUTEL:proefc') });
    await wachtOp('proefb'); await wachtOp('proefc');
    toets('max 2: tweede in de proef, derde niet', p2.advisor_proef === true && !p3.advisor_proef && argsVan('proefc')[0].advisor === null && proef().jobs.length === 2);
    fs.writeFileSync(PROEF, JSON.stringify({ aan: false, model: 'claude-sonnet-5-5', advisor: 'opus', max: 10, jobs: [] }));
    const p4 = await agent({ label: 'machinekamer:wv910 uit', prompt: tikPrompt(910, 'SLEUTEL:proefuit') });
    await wachtOp('proefuit');
    toets('aan:false: geen proef', !p4.advisor_proef && argsVan('proefuit')[0].advisor === null && proef().jobs.length === 0);
    fs.writeFileSync(PROEF, JSON.stringify({ aan: true, model: 'gpt-6-astra', advisor: 'opus', max: 10, jobs: [] }));
    const p5 = await agent({ label: 'machinekamer:wv911 ongeldig', prompt: tikPrompt(911, 'SLEUTEL:proefong') });
    await wachtOp('proefong');
    toets('ongeldig proefmodel: geen proef, agent draait gewoon', p5.ok && !p5.advisor_proef && argsVan('proefong')[0].advisor === null && argsVan('proefong')[0].model === 'claude-opus-5-5');

    // register en joblog
    await slaap(800);
    const lijst = ((await vraag('GET', '/agents')).agents) || [];
    const l1 = lijst.find(x => x.job_id === a1.job_id), lp = lijst.find(x => x.job_id === p1.job_id), l2 = lijst.find(x => x.job_id === a2.job_id);
    toets('/agents toont model en adviseur', l1 && l1.model === 'claude-sonnet-5-5' && l1.advisor === 'opus' && lp && lp.advisor_proef === true && l2 && l2.advisor === undefined, JSON.stringify([l1, lp]));
    const log = fs.readFileSync(path.join(d, 'api.log'), 'utf8');
    toets('joblog: regel met advisor=opus model=claude-sonnet-5-5 voor de agent', new RegExp('job job_id=' + a1.job_id + '[^\\n]*model=claude-sonnet-5-5 advisor=opus').test(log));
    toets('logregel advisor-proef bij de claim', /"soort":"advisor-proef"[^\n]*"wv":900/.test(log));
  } catch (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); fout++; }
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt' : 'ALLES GROEN');
  process.exit(fout ? 1 : 0);
});
JS
