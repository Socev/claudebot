#!/usr/bin/env bash
# test/app-passief-poort.sh (wv3873, bouwplan 'App blijft werken als Olares plat ligt' § 4.1 punt 3 en § 4.1 lease)
# Start de ECHTE server.js als proefkopie (kant olares) met een nep-scheidsrechter en nep-Access (eigen RS256-sleutel), en toetst:
#   P  stand vps (deze kant passief): ELKE route die handleApp kent (uit de broncode gehaald: route ===, route.indexOf, p ===,
#      /^… \/app\/…/-regels, upload en ramble) plus losse onbekende paden → 409 met X-Socev-Rol: passief en X-Socev-Kant: olares,
#      behalve GET /app/status → 200 passief:true zonder sessie of apparaat. Niets in de app-staat geschreven (geen sessies/staat).
#   A  poortgeheim fout of geen Access-bewijs → 401 vóór de passief-poort (die verraadt dus niets aan een onbekende).
#   W  stand olares (primair): /app/status zonder passief, POST /app/knop 401 'geen …' (gewone route), X-Socev-Kant olares.
#   L  lease (rolPrimair uit de broncode geknipt): lezing 181 s oud → passief + reden 'lease verlopen'; 10 s oud → primair.
#   S  stand-in (kant vps, SOCEV_ALTIJD_PASSIEF=1): passief; geen spaarstand, nood-spiegel stand_in (wv3909).
#   V  volle pod kant vps, primair (wv3909, fase 1h): spaarstand aan, maxAgents 1 (ook met MAX_AGENTS=3), POST Studio/Imagine 503.
#   B  spaarstand-browser (geknipt): agent geen mcp__playwright, beurt/ophalen/winkelbrowser niet naast een agent.
#   T  geen 'gebruik Telegram' meer in de broncode (Telegram is geen noodingang meer, wv3909).
# Kruisproef: KRUIS=1 bash test/app-passief-poort.sh draait P en L tegen de server.js van origin/main (verwacht: rood).
set -u
cd "$(dirname "$0")/.." || exit 1
SRV="${SERVER_JS:-$PWD/server.js}"
if [ "${KRUIS:-0}" = 1 ]; then K="$(mktemp -d)"; git archive origin/main | tar -x -C "$K"; SRV="$K/server.js"; echo "KRUISPROEF tegen origin/main"; fi
[ -d /app/node_modules ] && export NODE_PATH="/app/node_modules${NODE_PATH:+:$NODE_PATH}"
SERVER_JS="$SRV" node - <<'JS'
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const SRV = process.env.SERVER_JS, BRON = fs.readFileSync(SRV, 'utf8');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'passief-'));
let goed = 0, fout = 0;
const toets = (n, ok, x) => { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (!ok && x !== undefined ? '  [' + String(x).slice(0, 300) + ']' : '')); };

// ── L: lease (geknipt, geen server nodig) ──
(function () {
  const i0 = BRON.indexOf('function rolLeaseOk('), i = i0 > 0 ? i0 : BRON.indexOf('function rolPrimair()'), j = BRON.indexOf('function rolSchrijfBestand()');
  const knip = BRON.slice(i, j).replace(/^\/\/.*$/mg, '');
  const rol = { rol: 'primair', gelezen: Date.now() - 181000, reden: 'x', wissels: 0 }, log = [];
  const f = new Function('rol', 'ROL_GRATIE_MS', 'rolZet', 'rolSchrijfBestand', knip + '\n;return rolPrimair;');
  const rolPrimair = f(rol, 180000, (n, r) => { log.push(n + ':' + r); rol.rol = n; rol.reden = r; }, () => log.push('bestand'));
  toets('L1 lezing 181 s oud: niet primair (lease)', rolPrimair() === false, JSON.stringify(rol));
  toets('L2 overgang via rolZet naar passief met reden lease + rolbestand', rol.rol === 'passief' && /lease verlopen/.test(rol.reden) && log.indexOf('bestand') >= 0, log.join(' '));
  rol.rol = 'primair'; rol.gelezen = Date.now() - 10000;
  toets('L3 lezing 10 s oud: primair', rolPrimair() === true);
  rol.gelezen = 0;
  toets('L4 nooit gelezen maar rol primair: niet primair', rolPrimair() === false);
})();

// ── B: spaarstand-browser (wv3909; geknipt): dicht voor een agent en voor alles zolang er een agent loopt, alleen op kant vps ──
(function () {
  const i = BRON.indexOf('function spaarBrowserDicht('), j = BRON.indexOf('\n', i);
  if (i < 0) return toets('B0 spaarBrowserDicht bestaat', false);
  const maak = (spaar, lopend) => new Function('SPAARSTAND', 'agentInfo', BRON.slice(i, j) + '\n;return spaarBrowserDicht;')(spaar, () => ({ lopend }));
  toets('B1 kant olares: browser nooit dicht', maak(false, 3)(true) === false && maak(false, 3)(false) === false);
  toets('B2 spaarstand: agent zelf geen browser, beurt wel zonder agent, niet naast een agent', maak(true, 0)(true) === true && maak(true, 0)(false) === false && maak(true, 1)(false) === true);
  toets('B3 aangesloten: --disallowedTools mcp__playwright, /ophalen en winkelbrowser', /spaarBrowserDicht\(!!\(opts && opts\.env && opts\.env\[EIND_MARKER\]\)\) \? 'mcp__playwright'/.test(BRON)
    && /if \(spaarBrowserDicht\(false\)\) return stuur\(200/.test(BRON) && /!browserMag\(url\) \|\| spaarBrowserDicht\(false\)/.test(BRON));
  toets('B4 beurt mét browser houdt een agent tegen tot hij klaar is (Codex r1 MOET 2)', /spaarBrowserBeurten\.set\(spaarToken/.test(BRON) && /if \(spaarToken\) spaarBrowserBeurten\.delete\(spaarToken\)/.test(BRON)
    && /\} else if \(SPAARSTAND && spaarBrowserBeurtLopend\(\)\) \{/.test(BRON) && /agentInfo\(\)\.lopend >= maxAgents\(\) \|\| spaarBrowserBeurtLopend\(\)/.test(BRON));
})();

// ── routes uit handleApp ──
const hs = BRON.indexOf('\nfunction handleApp(req, res) {'), he = BRON.indexOf('\n}\n', hs);
const H = BRON.slice(hs, he);
const routes = new Map();
const zet = (m, p) => { if (/^\/app\/[a-z0-9/-]{1,64}$/.test(p)) routes.set(m + ' ' + p, [m, p]); };
for (const x of H.matchAll(/route === '(GET|POST) (\/app\/[^']*)'/g)) zet(x[1], x[2]);
for (const x of H.matchAll(/route\.indexOf\('(GET|POST) (\/app\/[^']*)'\) === 0/g)) zet(x[1], x[2] + (x[2].endsWith('/') ? 'proef' : '/proef'));
for (const x of H.matchAll(/p === '(\/app\/[^']*)'/g)) { zet('GET', x[1]); zet('POST', x[1]); }
for (const x of H.matchAll(/\/\^(GET|POST) \\\/app\\\/([a-z-]+)\\\//g)) zet(x[1], '/app/' + x[2] + '/proef');
zet('POST', '/app/upload/abcdefgh12/1'); zet('POST', '/app/ramble/r20261122-0123456789abcdef/1');
zet('GET', '/app/bestaat-niet'); zet('POST', '/app/nog/een/onbekend/pad');
toets('R0 routes gevonden in handleApp (≥ 150)', routes.size >= 150, routes.size);

// ── nep-scheidsrechter + nep-Access ──
const stand = { kant: 'vps' };
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'proef', alg: 'RS256' });
let TEAM = '';
const bewijs = () => {
  const k = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'proef', typ: 'JWT' })).toString('base64url');
  const n = Math.floor(Date.now() / 1000);
  const i = Buffer.from(JSON.stringify({ iss: TEAM, aud: ['aud-proef'], common_name: 'client-proef', exp: n + 300, nbf: n - 5, iat: n })).toString('base64url');
  return k + '.' + i + '.' + crypto.sign('RSA-SHA256', Buffer.from(k + '.' + i), privateKey).toString('base64url');
};
const nep = http.createServer((q, s) => {
  if (q.url === '/lees') { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end(JSON.stringify([{ actieve_kant: stand.kant, sinds: '2026-11-22T00:00:00Z', versie: 7 }])); }
  if (q.url === '/cdn-cgi/access/certs') { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end(JSON.stringify({ keys: [jwk] })); }
  s.writeHead(404); s.end();
});
nep.listen(0, '127.0.0.1', async () => {
  const lp = nep.address().port, poort = 19000 + Math.floor(Math.random() * 900);
  TEAM = 'http://127.0.0.1:' + lp;
  ['home', 'vault', 'repo', 'io', 'jobout', 'ad'].forEach((m) => fs.mkdirSync(path.join(D, m), { recursive: true }));
  fs.writeFileSync(path.join(D, 'ad', 'config.json'), JSON.stringify({ access_team: TEAM, access_aud: 'aud-proef', servicetoken_client_id: 'client-proef' }));
  const env = Object.assign({}, process.env, { HOME: D + '/home', VAULT_DIR: D + '/vault', REPO_DIR: D + '/repo', IO_DIR: D + '/io', APP_BESTANDEN_DIR: D + '/ab', APP_LOG_DIR: D + '/al', APP_DATA_DIR: D + '/ad',
    APP_UIT_BESTAND: D + '/au', TEL_UIT_BESTAND: D + '/tu', JOBOUT_DIR: D + '/jobout', API_LOG: D + '/api.log', SYNC_LOG: D + '/sync.log', RUNTIME_FILE: D + '/runtime.json', CODEX_HOME: D + '/codex',
    SLEUTELPORTAAL_SLEUTEL: D + '/geen.key', UITROL_MARKER: D + '/uw', ROL_BESTAND: D + '/rol', AGY_MCP_TMP: D + '/agy.json', TUNNEL_UIT_POD: '1', SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares', OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '1', PORT: String(poort),
    SCHEIDS_URL: TEAM, SCHEIDS_LEES_SLEUTEL: 'x', APP_POORT_SECRET: 'poort-proef-' + 'p'.repeat(32) });
  ['CLAUDE_CODE_OAUTH_TOKEN', 'SOCEV_AGENT_RUN', 'RELEASE_DIR', 'SUPABASE_MCP_TOKEN', 'SB_SQL_LOKAAL'].forEach((k) => delete env[k]);
  const uit = fs.openSync(D + '/stdout.log', 'a');
  const p = spawn(process.execPath, [SRV], { env, detached: true, stdio: ['ignore', uit, uit], cwd: path.dirname(SRV) });
  let huidig = p.pid;
  const stop = (rc) => { try { process.kill(-huidig, 'SIGTERM'); } catch (e) {} nep.close(); setTimeout(() => { fs.rmSync(D, { recursive: true, force: true }); process.exit(rc); }, 400); };
  const B = 'http://127.0.0.1:' + poort;
  const health = async () => { try { return await (await fetch(B + '/health', { signal: AbortSignal.timeout(3000) })).json(); } catch (e) { return null; } };
  const wachtRol = async (r) => { for (let n = 0; n < 120; n++) { const h = await health(); if (h && h.uitwijk && h.uitwijk.rol === r && h.uitwijk.leeftijd_s !== null) return h; await new Promise((x) => setTimeout(x, 500)); } return null; };
  const vraag = async (m, pad, kop) => {
    const r = await fetch(B + pad, { method: m, signal: AbortSignal.timeout(15000), headers: Object.assign({ 'x-app-poort': env.APP_POORT_SECRET, 'cf-access-jwt-assertion': bewijs(), 'content-type': 'application/json' }, kop || {}), body: m === 'POST' ? '{}' : undefined });
    let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch (e) {}
    return { s: r.status, j, rol: r.headers.get('x-socev-rol'), kant: r.headers.get('x-socev-kant'), t };
  };
  try {
    const h = await wachtRol('passief');
    toets('P0 server.js start en is passief bij stand vps', !!h, h && JSON.stringify(h.uitwijk));
    if (!h) { console.log(fs.readFileSync(D + '/stdout.log', 'utf8').slice(-2000)); return stop(1); }
    const mis = [];
    for (const [m, pad] of routes.values()) {
      const r = await vraag(m, pad);
      const status = m === 'GET' && pad === '/app/status';
      const ok = status ? (r.s === 200 && r.j && r.j.passief === true && r.j.sessie === false && r.j.apparaat === null && r.rol === 'passief')
                        : (r.s === 409 && r.j && r.j.passief === true && r.rol === 'passief' && r.kant === 'olares');
      if (!ok) mis.push(m + ' ' + pad + ' → ' + r.s + ' ' + (r.t || '').slice(0, 80));
    }
    toets('P1 passief: alle ' + routes.size + ' routes 409 passief (X-Socev-Rol/Kant), GET /app/status 200 passief', mis.length === 0, mis.length + ': ' + mis.slice(0, 6).join(' | '));
    const st = await vraag('GET', '/app/status');
    toets('P2 /app/status passief noemt kant en actieve kant', st.j && st.j.kant === 'olares' && st.j.actieve_kant === 'vps', st.t);
    const ad = fs.readdirSync(D + '/ad').filter((f) => !/^audit/.test(f)).sort();   // de audit telt elke weigering (gewenst)
    toets('P3 passief: geen app-staat geschreven (alleen config.json naast de audit)', ad.join(',') === 'config.json', ad.join(','));
    const a1 = await vraag('POST', '/app/knop', { 'x-app-poort': 'fout' });
    const a2 = await vraag('POST', '/app/knop', { 'cf-access-jwt-assertion': 'a.b.c' });
    toets('A1 fout poortgeheim: 401 vóór de passief-poort', a1.s === 401 && !a1.rol, a1.s + ' ' + a1.t);
    toets('A2 ongeldig Access-bewijs: 401 vóór de passief-poort', a2.s === 401 && !a2.rol, a2.s + ' ' + a2.t);
    stand.kant = 'olares';
    const h2 = await wachtRol('primair');
    toets('W0 stand olares: primair', !!h2, h2 && JSON.stringify(h2.uitwijk));
    if (h2) {
      toets('W0b /health uitwijk.lease_s tussen 1 en 180', h2.uitwijk.lease_s > 0 && h2.uitwijk.lease_s <= 180, h2.uitwijk.lease_s);
      const w1 = await vraag('GET', '/app/status');
      toets('W1 primair: /app/status gewoon (geen passief), X-Socev-Kant olares', w1.s === 200 && w1.j && w1.j.passief === undefined && 'koppelen_open' in w1.j && w1.kant === 'olares' && !w1.rol, w1.t);
      const w2 = await vraag('POST', '/app/knop');
      toets('W2 primair: POST /app/knop naar de gewone route (401 zonder sessie)', w2.s === 401 && !w2.rol, w2.s + ' ' + w2.t);
      const w3 = await vraag('POST', '/app/studio/maak');
      toets('W3 kant olares: geen spaarstand (/health en Studio niet 503 spaarstand)', h2.uitwijk.spaarstand && h2.uitwijk.spaarstand.aan === false && !(w3.j && w3.j.spaarstand), JSON.stringify(h2.uitwijk.spaarstand) + ' ' + w3.s);
    }
    // S — stand-in op de R230 (SOCEV_ALTIJD_PASSIEF=1, kant vps): ook bij stand vps passief
    try { process.kill(-p.pid, 'SIGTERM'); } catch (e) {}
    await new Promise((x) => setTimeout(x, 800));
    stand.kant = 'vps';
    const p2 = spawn(process.execPath, [SRV], { env: Object.assign({}, env, { SOCEV_KANT: 'vps', SOCEV_ALTIJD_PASSIEF: '1' }), detached: true, stdio: ['ignore', uit, uit], cwd: path.dirname(SRV) });
    huidig = p2.pid;
    let hs = null;
    for (let n = 0; n < 120 && !(hs && hs.uitwijk && hs.uitwijk.leeftijd_s !== null); n++) { hs = await health(); await new Promise((x) => setTimeout(x, 500)); }
    toets('S1 stand-in (kant vps, altijd passief) bij stand vps: passief, reden stand-in', hs && hs.uitwijk.rol === 'passief' && /altijd passief/.test(hs.uitwijk.reden) && hs.uitwijk.actieve_kant === 'vps', hs && JSON.stringify(hs.uitwijk));
    const s2 = await vraag('GET', '/app/status'), s3 = await vraag('POST', '/app/koppel/code');
    toets('S2 stand-in: /app/status passief met X-Socev-Kant vps, koppelen 409', s2.s === 200 && s2.j.passief === true && s2.kant === 'vps' && s3.s === 409, s2.t + ' ' + s3.s);
    // wv3909: spaarstand en nood-spiegel zichtbaar in /health; de stand-in heeft geen spaarstand en geen nood-spiegel (doet niets)
    toets('S3 stand-in: spaarstand uit, nood niet ingericht', hs && hs.uitwijk.spaarstand && hs.uitwijk.spaarstand.aan === false && hs.uitwijk.nood && hs.uitwijk.nood.ingericht === false && hs.uitwijk.nood.stand_in === true, hs && JSON.stringify([hs.uitwijk.spaarstand, hs.uitwijk.nood]));
    // V — volle pod op de R230 (kant vps, niet de stand-in), stand vps = primair: SPAARSTAND (wv3909, fase 1h)
    try { process.kill(-p2.pid, 'SIGTERM'); } catch (e) {}
    await new Promise((x) => setTimeout(x, 800));
    const p3 = spawn(process.execPath, [SRV], { env: Object.assign({}, env, { SOCEV_KANT: 'vps', MAX_AGENTS: '3' }), detached: true, stdio: ['ignore', uit, uit], cwd: path.dirname(SRV) });
    huidig = p3.pid;
    const hv = await wachtRol('primair');
    toets('V1 kant vps primair: /health.uitwijk.spaarstand aan, 1 agent', !!hv && hv.uitwijk.spaarstand && hv.uitwijk.spaarstand.aan === true && hv.uitwijk.spaarstand.grenzen.agents === 1, hv && JSON.stringify(hv.uitwijk.spaarstand));
    let ag = null; try { ag = await (await fetch(B + '/agents', { signal: AbortSignal.timeout(3000) })).json(); } catch (e) {}
    toets('V2 spaarstand: maxAgents 1, ook met MAX_AGENTS=3', ag && ag.max_agents === 1, ag && ag.max_agents);
    const v3 = await vraag('POST', '/app/studio/maak'), v4 = await vraag('POST', '/app/imagine/nieuw'), v5 = await vraag('GET', '/app/studio/flows');
    toets('V3 spaarstand: POST Studio/Imagine 503 "ligt stil" (X-Socev-Kant vps), GET Studio niet', v3.s === 503 && v3.j && v3.j.spaarstand === true && v3.kant === 'vps' && v4.s === 503 && v4.j.spaarstand === true && v5.s !== 503 && !(v5.j && v5.j.spaarstand), v3.s + ' ' + v4.s + ' ' + v5.s + ' ' + v5.t);
    toets('V4 nood-spiegel zonder sleutel: niet ingericht, geen aanroep', hv && hv.uitwijk.nood && hv.uitwijk.nood.ingericht === false && !hv.uitwijk.nood.aanroepen, hv && JSON.stringify(hv.uitwijk.nood));
  } catch (e) { toets('uitzondering', false, e && e.stack); }
  toets('T1 geen "gebruik Telegram" / "tik daar" in de app-antwoorden van server.js', !/gebruik Telegram|staat ook in Telegram, tik daar/.test(BRON));
  console.log('── app-passief-poort: ' + goed + ' groen, ' + fout + ' rood');
  stop(fout ? 1 : 0);
});
JS
rc=$?
[ -n "${K:-}" ] && rm -rf "$K"
exit $rc
