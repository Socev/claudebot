#!/usr/bin/env bash
# test/sb-beheer.sh (wv3180) — sbBeheerQuery/sbBeheerKan in server.js, werkers.js en de twee tools: zonder SB_SQL_LOKAAL de
# Management-API (nep-fetch), met SB_SQL_LOKAAL=1 het lokale /app/sb-sql (nep-script): query via stdin, minimale omgeving,
# foutvorm "Failed to run sql query: …", status 201/400. Echte proef (optioneel): SB_BEHEER_ECHT_BIN = een sb-sql tegen een proefdatabank.
set -u
cd "$(dirname "$0")/.."
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
cat > "$W/nep-sb-sql" <<'NEP'
#!/usr/bin/env bash
q=$(cat)
env | cut -d= -f1 | sort > "$(dirname "$0")/env.txt"
printf '%s' "$q" > "$(dirname "$0")/q.txt"
case "$q" in
  *fout*) echo '{"message":"relation \"x\" does not exist"}' >&2; exit 1 ;;
  *) printf '[{"w":"lokaal","n":1}]' ;;
esac
NEP
chmod +x "$W/nep-sb-sql"
W="$W" node - <<'JS'
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const W = process.env.W;
let rood = 0, groen = 0;
const ok = (c, n) => { if (c) { groen++; console.log('  ok   ' + n); } else { rood++; console.log('  ROOD ' + n); } };
function helper(bestand, a, b) {
  const s = fs.readFileSync(bestand, 'utf8');
  const i = s.indexOf(a), j = s.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('helper niet gevonden in ' + bestand);
  return s.slice(i, j);
}
const bronnen = [
  ['server.js', helper('server.js', '/* sbBeheer:begin', '/* sbBeheer:einde */'), 'https://api.supabase.com/v1/projects/abcdef/database/query'],
  ['werkers.js', "const SB_PROJECT = 'tiwfbqwttnknnblhqpoo';\n" + helper('werkers.js', '// wv3180: beheer-SQL', 'async function haalHartslag'), 'https://api.supabase.com/v1/projects/tiwfbqwttnknnblhqpoo/database/query'],
  ['tools/facturen-paypal.js', helper('tools/facturen-paypal.js', '// wv3180: beheer-SQL', '\nasync function') , 'https://api.supabase.com/v1/projects/abcdef/database/query'],
  ['tools/facturen-fv2-archief.js', helper('tools/facturen-fv2-archief.js', '// wv3180: beheer-SQL', '\nasync function'), 'https://api.supabase.com/v1/projects/abcdef/database/query'],
];
(async function () {
  for (const [naam, code, url] of bronnen) {
    console.log(naam);
    const geroepen = [];
    const env = { SUPABASE_URL: 'https://abcdef.supabase.co', SUPABASE_MCP_TOKEN: 'pat-geheim', ANDERE_SLEUTEL: 'mag-niet-mee', PATH: process.env.PATH, HOME: W };
    const g = { require, Response, AbortSignal, setTimeout, clearTimeout, Promise, JSON, String, process: { env },
      fetch: async (u, o) => { geroepen.push({ u, o }); return new Response('[{"w":"beheer"}]', { status: 201 }); } };
    vm.createContext(g);
    vm.runInContext(code + '\n;globalThis.__h = { sbBeheerKan, sbBeheerQuery };', g);
    const H = g.__h;
    ok(H.sbBeheerKan() === true, 'met token: kan');
    let r = await H.sbBeheerQuery('select 1', { ua: 'socev-toets/1', ms: 5000 });
    ok(r && r.status === 201 && (await r.json())[0].w === 'beheer' && geroepen.length === 1 && geroepen[0].u === url, 'zonder SB_SQL_LOKAAL: Management-API (' + (geroepen[0] && geroepen[0].u) + ')');
    ok(geroepen[0] && geroepen[0].o.headers.Authorization === 'Bearer pat-geheim' && JSON.parse(geroepen[0].o.body).query === 'select 1' && geroepen[0].o.redirect === 'error', 'zelfde kop, body en redirect error');
    delete env.SUPABASE_MCP_TOKEN;
    ok(H.sbBeheerKan() === false && (await H.sbBeheerQuery('select 1')) === null, 'zonder token: geen toegang (null)');
    env.SB_SQL_LOKAAL = '1'; env.SB_SQL_BIN = W + '/nep-sb-sql'; delete env.SUPABASE_URL;
    ok(H.sbBeheerKan() === true, 'SB_SQL_LOKAAL=1: kan, ook zonder Supabase-adres en token');
    r = await H.sbBeheerQuery("select 'geheim-in-de-query'", { ms: 5000 });
    ok(r && r.ok && r.status === 201 && (await r.json())[0].w === 'lokaal' && geroepen.length === 1, 'lokaal: rijen van sb-sql, geen fetch');
    ok(fs.readFileSync(W + '/q.txt', 'utf8') === "select 'geheim-in-de-query'", 'query via stdin');
    const e = fs.readFileSync(W + '/env.txt', 'utf8');
    ok(e.indexOf('ANDERE_SLEUTEL') < 0 && e.indexOf('SUPABASE') < 0 && /SB_SQL_TIMEOUT_MS/.test(e), 'kind krijgt geen pod-omgeving, wel de tijdgrens');
    r = await H.sbBeheerQuery('select fout', { ms: 5000 });
    ok(r && !r.ok && r.status === 400 && /^Failed to run sql query: relation/.test((await r.json()).message), 'fout: 400 met Management-API-vorm');
    env.SB_SQL_BIN = W + '/bestaat-niet';
    r = await H.sbBeheerQuery('select 1', { ms: 5000 });
    ok(r && r.status === 503, 'sb-sql ontbreekt: 503, geen uitzondering');
    if (process.env.SB_BEHEER_ECHT_BIN && naam === 'server.js') {
      env.SB_SQL_BIN = process.env.SB_BEHEER_ECHT_BIN;
      r = await H.sbBeheerQuery("select count(*) as n from vault.decrypted_secrets", { ms: 20000 });
      const j = r && await r.json();
      ok(r && r.status === 201 && j && j[0] && j[0].n > 0, 'echt: kluis lezen via sb-sql (' + (j && j[0] && j[0].n) + ' geheimen)');
    }
  }
  console.log('sb-beheer: ' + groen + ' groen, ' + rood + ' rood');
  process.exit(rood ? 1 : 0);
})().catch((e) => { console.log('ROOD brak af: ' + e.stack); process.exit(1); });
JS
