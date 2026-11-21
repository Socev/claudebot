#!/usr/bin/env bash
# Toets wv3693 (21-11-2026, besluitenpagina nr 452 = 3C152): stappen van een app-beurt in de wachtbel (beurt-stappen.js + server.js).
#   vaste vertaaltabel per tool/skill/script/actie, onbekend = "zoekt iets op"; GEEN inhoud uit de invoer in een stap (elke uitvoer
#   zit in de vaste lijst, verzonnen geheime woorden komen nooit terug); volger leest alleen nieuwe regels (oude geschiedenis en
#   regels van vóór de start tellen niet), zelfde soort na elkaar = één stap, hooguit 3 in de uitslag, "werkt aan het antwoord"
#   pas 3 s na een tool-uitslag; enorme regel zonder einde wordt overgeslagen; server.js: app-beurten krijgen opts.stappen en
#   /app/uitslag geeft stappen mee; stopt bij het einde van de beurt.
# Kruisproef: BEURT_STAPPEN_MOD=<kopie die de zoekterm doorgeeft> bash test/beurt-stappen.sh moet rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/toets.js" <<'EINDE'
'use strict';
const path = require('path'), fs = require('fs');
const HIER = process.argv[2], T = process.argv[3], MOD = process.env.BEURT_STAPPEN_MOD || path.join(HIER, 'beurt-stappen.js');
const S = require(MOD);
let ok = 0, fout = 0;
function toets(naam, waar) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam); } }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Vertaaltabel
const tb = (name, input) => S.stapVoor({ type: 'tool_use', name, input });
toets('mail_zoeken via curl', tb('Bash', { command: 'curl -s -X POST "$N8N/webhook/agenda-wachter-api-x" -d "{\\"secret\\":\\"$X\\",\\"actie\\":\\"mail_zoeken\\",\\"q\\":\\"Jansen factuur\\"}"' }) === 'zoekt in je mail');
toets('mail_lezen', tb('Bash', { command: 'curl -d \'{"actie":"mail_lezen","id":"abc"}\'' }) === 'leest een mail');
toets('agenda-actie (webhooknaam met agenda, actie mail wint)', tb('Bash', { command: 'curl https://n8n/webhook/agenda-wachter-api -d \'{"actie":"mail_bijlage"}\'' }) === 'haalt een bijlage uit je mail');
toets('agenda_lezen', tb('Bash', { command: 'curl -d \'{"actie":"agenda_lezen"}\'' }) === 'kijkt in de agenda');
toets('outlook', tb('Bash', { command: 'curl -d \'{"actie":"outlook_zoeken"}\'' }) === 'zoekt in je Outlook-mail');
toets('bank.py', tb('Bash', { command: 'cd /x && python3 .claude/skills/bank-lezen/bank.py saldo --rekening gezamenlijk' }) === 'kijkt bij de bank');
toets('hp.py', tb('Bash', { command: 'python3 /opt/data/AI_SecondBrain/.claude/skills/health-pod/hp.py lab --naam ferritine' }) === 'kijkt in je gezondheidsdossier');
toets('grep in de vault', tb('Bash', { command: 'cd /opt/data/AI_SecondBrain && grep -ril "Pietersen" 10_Zakelijk | head -5' }) === 'zoekt in je Brain');
toets('grep -E met | tussen aanhalingstekens', tb('Bash', { command: 'cd /v && grep -rE "Jansen|Pietersen" . | cut -d: -f1 | head' }) === 'zoekt in je Brain');
toets('heredoc-inhoud telt niet als opdracht', tb('Bash', { command: "cat <<'EOF' > /tmp/x\nimport os\nrm -rf x\nEOF" }) === 'zoekt in je Brain');
toets('pdftotext = document', tb('Bash', { command: 'pdftotext /x/y.pdf - | head' }) === 'leest een document');
toets('alleen date/echo = geen stap', tb('Bash', { command: 'date; echo hallo' }) === null);
toets('onbekend commando', tb('Bash', { command: 'ffprobe x.mp3' }) === 'zoekt iets op');
toets('curl naar onbekende plek', tb('Bash', { command: 'curl -s https://voorbeeld.nl/api/zoek?q=geheim' }) === 'zoekt iets op');
toets('agent starten', tb('Bash', { command: 'curl -s -X POST http://127.0.0.1:8080/agent -d @x.json' }) === 'zet een klus klaar');
toets('Read pdf in invoer', tb('Read', { file_path: '/opt/data/io/abc/in/Factuur Jansen.pdf' }) === 'leest wat je meestuurde');
toets('Read pdf elders', tb('Read', { file_path: '/opt/data/AI_SecondBrain/raw/Brief Jansen.pdf' }) === 'leest een document');
toets('Read md', tb('Read', { file_path: '/opt/data/AI_SecondBrain/20_Prive/Gezin.md' }) === 'leest een pagina in je Brain');
toets('Write OUTDIR', tb('Write', { file_path: '/opt/data/io/abc/out/plan.docx', content: 'x' }) === 'maakt een bestand voor je');
toets('Edit vault', tb('Edit', { file_path: '/opt/data/AI_SecondBrain/x.md' }) === 'legt iets vast in je Brain');
toets('Skill mailconcept', tb('Skill', { skill: 'mailconcept-aanmaken', args: 'aan Jansen' }) === 'zet een mailconcept klaar');
toets('Skill onbekend', tb('Skill', { skill: 'iets-nieuws' }) === 'zoekt iets op');
toets('WebSearch', tb('WebSearch', { query: 'geheim' }) === 'zoekt op internet');
toets('todoist lezen/schrijven', tb('mcp__todoist__find-tasks-by-date', {}) === 'kijkt in Todoist' && tb('mcp__todoist__add-tasks', {}) === 'werkt Todoist bij');
toets('ToolSearch = geen stap', tb('ToolSearch', { query: 'x' }) === null);
toets('onbekende tool', tb('IetsNieuws', { x: 'geheim' }) === 'zoekt iets op');

// 2. Privacy: geen inhoud uit de invoer, elke uitvoer uit de vaste lijst
const vast = new Set([S.STAP_ONBEKEND, S.STAP_ANTWOORD].concat(Object.values(S.SKILL), Object.values(S.SCRIPT)));
['leest een mail', 'haalt een bijlage uit je mail', 'zoekt in je mail', 'zoekt in je Outlook-mail', 'kijkt in WhatsApp', 'zet de agenda-afspraak klaar',
  'kijkt in de agenda', "kijkt bij je sms'jes", 'zet een klus klaar', 'zoekt in de databank', 'zoekt in je Brain', 'leest een eigen werkbestand',
  'maakt een bestand voor je', 'leest wat je meestuurde', 'werkt aan een bestand', 'legt iets vast in je Brain', 'leest een document', 'bekijkt een afbeelding',
  'leest een pagina in je Brain', 'zoekt op internet', 'leest een webpagina', 'zet een hulpje aan het werk', 'kijkt op een website', 'kijkt in Todoist',
  'werkt Todoist bij', 'kijkt in de automatiseringen', 'zoekt in de medische literatuur'].forEach((x) => vast.add(x));
const GEHEIM = 'Zwartkoppel';
const namen = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Skill', 'WebSearch', 'WebFetch', 'Agent', 'mcp__todoist__find-tasks', 'mcp__x__' + GEHEIM, GEHEIM];
const invoeren = [
  { command: 'grep -r ' + GEHEIM + ' .' }, { command: GEHEIM + '.py --x' }, { command: 'curl -d \'{"actie":"' + GEHEIM.toLowerCase() + '_zoeken"}\'' },
  { command: 'python3 ' + GEHEIM + '.py' }, { file_path: '/io/a/in/' + GEHEIM + '.pdf' }, { file_path: '/' + GEHEIM + '.md' }, { skill: GEHEIM },
  { query: GEHEIM }, { url: 'https://' + GEHEIM + '.nl' }, { prompt: GEHEIM, description: GEHEIM }, { command: 'cd ' + GEHEIM + ' && ' + GEHEIM },
];
let lek = 0, buiten = 0;
namen.forEach((n) => invoeren.forEach((inp) => {
  const s = S.stapVoor({ type: 'tool_use', name: n, input: inp });
  if (s === null) return;
  if (String(s).toLowerCase().indexOf(GEHEIM.toLowerCase()) >= 0) lek++;
  if (!vast.has(s)) buiten++;
}));
toets('geen enkele stap bevat inhoud uit de invoer (' + namen.length * invoeren.length + ' combinaties)', lek === 0);
toets('elke stap komt uit de vaste lijst', buiten === 0);

// 3. Volger op een echt bestand
function regel(type, ts, content) { return JSON.stringify({ type, timestamp: new Date(ts).toISOString(), message: { role: type, content } }) + '\n'; }
const tool = (name, input) => ({ type: 'tool_use', id: 'x', name, input });
(async function () {
  const pad = path.join(T, 'sessie.log');
  const oud = Date.now() - 3600e3;
  fs.writeFileSync(pad, regel('assistant', oud, [tool('WebSearch', { query: 'oud' })]) + regel('user', oud, [{ type: 'tool_result', content: 'x' }]));
  const progress = {};
  const t0 = Date.now();
  const stop = S.volg({ pad, progress, vanafMs: t0 - 2000, lees: S.fsLezer(fs), intervalMs: 100 });
  await slaap(250);
  toets('oude geschiedenis telt niet', S.stappenUitslag(progress, Date.now()).length === 0);
  // regel van vóór de start (tijdstempel) die na de eerste meting toch binnenkomt: telt niet
  fs.appendFileSync(pad, regel('assistant', t0 - 60000, [tool('WebFetch', { url: 'x' })]));
  fs.appendFileSync(pad, regel('assistant', Date.now(), [{ type: 'thinking', thinking: 'geheim' }, tool('Bash', { command: 'curl -d \'{"actie":"mail_zoeken","q":"' + GEHEIM + '"}\'' })]));
  await slaap(300);
  let u = S.stappenUitslag(progress, Date.now());
  toets('nieuwe stap binnen 0,3 s: ' + JSON.stringify(u), u.length === 1 && u[0] === 'zoekt in je mail');
  fs.appendFileSync(pad, regel('user', Date.now(), [{ type: 'tool_result', content: GEHEIM }]));
  fs.appendFileSync(pad, regel('assistant', Date.now(), [tool('Bash', { command: 'curl -d \'{"actie":"mail_zoeken"}\'' })]));   // zelfde soort
  fs.appendFileSync(pad, regel('assistant', Date.now(), [tool('Read', { file_path: '/opt/data/io/q/in/a.pdf' })]));
  // halve regel: pas verwerkt als hij af is
  const half = regel('assistant', Date.now(), [tool('Skill', { skill: 'agenda-wachter' })]);
  fs.appendFileSync(pad, half.slice(0, 40));
  await slaap(300);
  u = S.stappenUitslag(progress, Date.now());
  toets('zelfde soort na elkaar = één stap, halve regel wacht: ' + JSON.stringify(u), JSON.stringify(u) === JSON.stringify(['zoekt in je mail', 'leest wat je meestuurde']));
  fs.appendFileSync(pad, half.slice(40));
  fs.appendFileSync(pad, regel('assistant', Date.now(), [tool('WebSearch', { query: GEHEIM })]));
  fs.appendFileSync(pad, regel('user', Date.now(), [{ type: 'tool_result', content: 'x' }]));
  await slaap(300);
  u = S.stappenUitslag(progress, Date.now());
  toets('hooguit 3, oudste valt weg: ' + JSON.stringify(u), JSON.stringify(u) === JSON.stringify(['leest wat je meestuurde', 'kijkt in de agenda', 'zoekt op internet']));
  u = S.stappenUitslag(progress, Date.now() + 3500);
  toets('3 s na een tool-uitslag: werkt aan het antwoord: ' + JSON.stringify(u), u[u.length - 1] === 'werkt aan het antwoord' && u.length === 3);
  // enorme regel zonder einde wordt overgeslagen, daarna gaat het gewoon verder
  const groot = Buffer.alloc(17 * 1024 * 1024, 0x61);
  fs.appendFileSync(pad, groot);
  await slaap(600);
  fs.appendFileSync(pad, 'staart van de grote regel\n' + regel('assistant', Date.now(), [tool('Skill', { skill: 'bank-lezen' })]));
  await slaap(600);
  u = S.stappenUitslag(progress, Date.now());
  toets('na een te grote regel weer bij: ' + JSON.stringify(u), u[u.length - 1] === 'kijkt bij de bank');
  toets('geen inhoud in de staat', JSON.stringify(progress.stappenStaat).indexOf(GEHEIM) < 0 && JSON.stringify(progress.stappenStaat).indexOf('geheim') < 0);
  stop();
  fs.appendFileSync(pad, regel('assistant', Date.now(), [tool('WebFetch', { url: 'x' })]));
  await slaap(300);
  u = S.stappenUitslag(progress, Date.now());
  toets('na stop niets meer', u[u.length - 1] === 'kijkt bij de bank');
  // nieuwe sessie: logboek bestaat nog niet bij de start
  const pad2 = path.join(T, 'nieuw.log'), p2 = {};
  const stop2 = S.volg({ pad: pad2, progress: p2, vanafMs: Date.now() - 2000, lees: S.fsLezer(fs), intervalMs: 100 });
  await slaap(250);
  fs.writeFileSync(pad2, regel('user', Date.now(), 'vraag') + regel('assistant', Date.now(), [tool('Grep', { pattern: GEHEIM })]));
  await slaap(300);
  toets('nieuwe sessie (logboek later aangemaakt): ' + JSON.stringify(S.stappenUitslag(p2, Date.now())), JSON.stringify(S.stappenUitslag(p2, Date.now())) === '["zoekt in je Brain"]');
  stop2();
  // Codex ZOU 2: parallelle tools — pas na de laatste uitslag "werkt aan het antwoord"
  const p3 = { stappenStaat: { stappen: [], laatst: null, open: {} } }, nu3 = Date.now();
  S.verwerkRegel(p3.stappenStaat, JSON.stringify({ type: 'assistant', timestamp: new Date(nu3).toISOString(), message: { content: [{ type: 'tool_use', id: 'a1', name: 'WebSearch', input: {} }, { type: 'tool_use', id: 'a2', name: 'WebFetch', input: {} }] } }), nu3 - 1000, nu3);
  S.verwerkRegel(p3.stappenStaat, JSON.stringify({ type: 'user', timestamp: new Date(nu3).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'x' }] } }), nu3 - 1000, nu3);
  const half3 = S.stappenUitslag(p3, nu3 + 5000);
  S.verwerkRegel(p3.stappenStaat, JSON.stringify({ type: 'user', timestamp: new Date(nu3).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'a2', content: 'x' }] } }), nu3 - 1000, nu3);
  const heel3 = S.stappenUitslag(p3, nu3 + 5000);
  toets('parallelle tools: na één van twee uitslagen nog geen "werkt aan het antwoord", na beide wel: ' + JSON.stringify([half3, heel3]), half3[half3.length - 1] === 'leest een webpagina' && heel3[heel3.length - 1] === 'werkt aan het antwoord');
  toets('lege progress = []', JSON.stringify(S.stappenUitslag({}, Date.now())) === '[]');

  // 4. server.js-koppeling (statisch): app-beurten volgen, uitslag geeft stappen, stop in finish
  const srv = fs.readFileSync(path.join(HIER, 'server.js'), 'utf8');
  toets('server: runOpts.stappen alleen bij app-beurten', /if \(j\.app\) runOpts\.stappen = true;/.test(srv));
  toets('server: volger in runClaude vóór de spawn, met loperlezer', srv.indexOf('const stappenStop = ') > srv.indexOf('const projDir = viaLoper ? socevProjectDirFor(cwd)') && srv.indexOf('const stappenStop = ') < srv.indexOf("const child = viaLoper ? loperSpawn('claude'") && /beurtStappen\.volg\(\{ pad: path\.join\(projDir, eigenId \+ '\.jsonl'\)/.test(srv) && /viaLoper \? loperStappenLees/.test(srv));
  toets('server: stop in finish', /clearInterval\(watchdog\);\n      if \(stappenStop\) stappenStop\(\);/.test(srv));
  toets('server: /app/uitslag geeft stappen', /stappen: typeof beurtStappen !== 'undefined' && beurtStappen && j\.progress \? beurtStappen\.stappenUitslag\(j\.progress, Date\.now\(\)\) : \[\]/.test(srv));
  toets('uitrol: beurt-stappen.js gaat mee in de release', /beurt-stappen\.js/.test(fs.readFileSync(path.join(HIER, 'uitrol.sh'), 'utf8')));
  console.log(ok + '/' + fout);
  process.exit(fout ? 1 : 0);
})();
EINDE
node "$T/toets.js" "$HIER" "$T"
