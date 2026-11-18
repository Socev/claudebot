#!/usr/bin/env bash
# Toetst (wv3207, databankoverstap): de schakelaar /opt/data/.pg/adres.env.
#   A. server.js (blok adresEnv geknipt): alleen exact SUPABASE_URL=http://127.0.0.1:8091 + SB_SQL_LOKAAL=1 zet beide in de
#      omgeving; ontbrekend, ander adres, extra regel of kant vps verandert niets.
#   B. fetch-secrets.sh: met een geldig adres.env geen HTTP-aanroep maar de lokale route (gosu claude node pod-geheimen.js; hier
#      een nep-gosu in PATH), secrets geladen, SUPABASE_URL/SB_SQL_LOKAAL mee naar het commando, herhaalt bij een onbereikbare
#      databank, weigert zonder herkansing bij ok:false; zonder/ongeldig bestand of op kant vps de oude RPC-route.
#   C. db/pod-geheimen.js tegen een wegwerp-cluster (als de PG-binaries er zijn): geheim gaat als parameter mee, antwoord in de
#      PostgREST-vorm, exit 1 zonder databank.
# Kruisproef: zonder de wijziging (main) kleuren A3, B1-B4 rood.
set -u
cd "$(dirname "$0")/.." || exit 1
W="$(mktemp -d)"; NEP=""; trap '[ -n "$NEP" ] && kill "$NEP" 2>/dev/null; [ -d "$W/pg/data" ] && "$PGB/pg_ctl" -D "$W/pg/data" -m immediate stop >/dev/null 2>&1; rm -rf "$W"' EXIT
PGB=/usr/lib/postgresql/17/bin
[ -d /app/node_modules ] && export NODE_PATH="/app/node_modules${NODE_PATH:+:$NODE_PATH}"
fout=0
toets(){ if [ "$2" = 1 ]; then echo "GROEN $1"; else echo "ROOD  $1${3:+  [$3]}"; fout=$((fout + 1)); fi; }

# ── A. server.js ────────────────────────────────────────────────────────────
sed -n '/\/\* adresEnv:begin/,/\/\* adresEnv:end/p' server.js > "$W/blok.js"
toets 'A0 blok adresEnv gevonden in server.js' "$(grep -q 'function pasAdresEnvToe' "$W/blok.js" && echo 1)"
a(){ # a <inhoud|-> [kant] → uitkomst|URL|LOKAAL
  local f="$W/a.env"; rm -f "$f"; [ "$1" = - ] || printf '%b' "$1" > "$f"
  node -e '
const fs = require("fs"); eval(fs.readFileSync(process.argv[1], "utf8"));
const env = { SUPABASE_URL: "https://oud.supabase.co" }; if (process.argv[3]) env.SOCEV_KANT = process.argv[3];
const u = pasAdresEnvToe(env, process.argv[2]); process.stdout.write(u + "|" + env.SUPABASE_URL + "|" + (env.SB_SQL_LOKAAL || "-"));
' "$W/blok.js" "$f" "${2:-}"
}
GOED='SUPABASE_URL=http://127.0.0.1:8091\nSB_SQL_LOKAAL=1\n'
toets 'A1 geen bestand: niets verandert' "$([ "$(a -)" = 'geen bestand|https://oud.supabase.co|-' ] && echo 1)"
toets 'A2 geldig bestand: lokaal' "$([ "$(a "$GOED")" = 'lokaal|http://127.0.0.1:8091|1' ] && echo 1)"
toets 'A3 geldig met commentaar en andere volgorde' "$([ "$(a "# overstap\nSB_SQL_LOKAAL=1\n\nSUPABASE_URL=http://127.0.0.1:8091")" = 'lokaal|http://127.0.0.1:8091|1' ] && echo 1)"
toets 'A4 ander adres: genegeerd' "$([ "$(a 'SUPABASE_URL=http://elders:8091\nSB_SQL_LOKAAL=1\n')" = 'onbekende vorm|https://oud.supabase.co|-' ] && echo 1)"
toets 'A5 extra regel: genegeerd' "$([ "$(a "${GOED}NODE_OPTIONS=--x\n")" = 'onbekende vorm|https://oud.supabase.co|-' ] && echo 1)"
toets 'A6 alleen de schakelaar: genegeerd' "$([ "$(a 'SB_SQL_LOKAAL=1\n')" = 'onbekende vorm|https://oud.supabase.co|-' ] && echo 1)"
toets 'A6b CRLF: genegeerd (zoals fetch-secrets)' "$([ "$(a 'SUPABASE_URL=http://127.0.0.1:8091\r\nSB_SQL_LOKAAL=1\r\n')" = 'onbekende vorm|https://oud.supabase.co|-' ] && echo 1)"
toets 'A6c spatie voor een regel: genegeerd' "$([ "$(a ' SUPABASE_URL=http://127.0.0.1:8091\nSB_SQL_LOKAAL=1\n')" = 'onbekende vorm|https://oud.supabase.co|-' ] && echo 1)"
toets 'A6d ingesprongen commentaar en lege regel met spaties: lokaal' "$([ "$(a '  # x\n   \nSUPABASE_URL=http://127.0.0.1:8091\nSB_SQL_LOKAAL=1\n')" = 'lokaal|http://127.0.0.1:8091|1' ] && echo 1)"
toets 'A7 kant vps: genegeerd' "$([ "$(a "$GOED" vps)" = 'andere kant|https://oud.supabase.co|-' ] && echo 1)"
toets 'A8 server.js past het blok toe vóór sbBeheer' "$(node -e '
const s = require("fs").readFileSync("server.js", "utf8"); const i = s.indexOf("const ADRES_ENV_UITKOMST = pasAdresEnvToe(process.env"), j = s.indexOf("/* sbBeheer:begin");
process.exit(i > 0 && i < j ? 0 : 1)' && echo 1)"

# ── B. fetch-secrets.sh ─────────────────────────────────────────────────────
POORT=$(node test/vrije-poort.js) || exit 1
node -e '
const http = require("http"), fs = require("fs");
http.createServer((q, s) => { let b = ""; q.on("data", (d) => b += d); q.on("end", () => {
  fs.appendFileSync(process.argv[2], "aanroep\n");
  s.writeHead(200, { "content-type": "application/json" });
  s.end(JSON.stringify({ ok: true, secrets: [ { naam: "claude_code_oauth_token", waarde: "van-supabase" } ] })); }); })
  .listen(parseInt(process.argv[1], 10), "127.0.0.1");
' "$POORT" "$W/rpc.log" & NEP=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$POORT/" && break; sleep 0.1; done

mkdir -p "$W/bin"
# nep-gosu: telt aanroepen; faalt de eerste NEP_FAAL keer (exit 1, zoals pod-geheimen zonder databank); daarna het antwoord.
cat > "$W/bin/gosu" <<'SH'
#!/bin/sh
echo "$*" >> "$NEP_GOSU_LOG"
n=$(wc -l < "$NEP_GOSU_LOG")
[ "$n" -le "${NEP_FAAL:-0}" ] && exit 1
if [ "$POD_BOOTSTRAP_SECRET" = nep-bootstrap ]; then
  printf '{"ok":true,"secrets":[{"naam":"claude_code_oauth_token","waarde":"van-lokaal"},{"naam":"n8n_mcp_token","waarde":"x"}]}'
else printf '{"ok":false}'; fi
SH
chmod +x "$W/bin/gosu"
cat > "$W/druk.sh" <<'SH'
#!/bin/sh
echo "TOKEN $CLAUDE_CODE_OAUTH_TOKEN"; echo "URL $SUPABASE_URL"; echo "LOKAAL ${SB_SQL_LOKAAL:-}"
echo "BOOT ${POD_BOOTSTRAP_SECRET:-AFWEZIG}"
SH
chmod +x "$W/druk.sh"
draai(){ # draai <naam> <adres.env-inhoud|-> [VAR=waarde ...]
  local naam="$1" inh="$2"; shift 2
  : > "$W/rpc.log"; : > "$W/gosu.log"; rm -f "$W/adres.env"; [ "$inh" = - ] || printf '%b' "$inh" > "$W/adres.env"
  env -i PATH="$W/bin:$PATH" HOME="$W" POD_BOOTSTRAP_SECRET=nep-bootstrap SUPABASE_URL="http://127.0.0.1:$POORT" \
    FETCH_SECRETS_ADRES_ENV="$W/adres.env" NEP_GOSU_LOG="$W/gosu.log" "$@" \
    bash ./fetch-secrets.sh "$W/druk.sh" > "$W/$naam.uit" 2>&1
  echo $? > "$W/$naam.rc"; cp "$W/rpc.log" "$W/$naam.rpc"; cp "$W/gosu.log" "$W/$naam.gosu"
}
regels(){ wc -l < "$1" | tr -d ' '; }
draai lokaal "$GOED"
toets 'B1 geldig adres.env: lokale route, geen HTTP-aanroep' "$([ "$(regels "$W/lokaal.rpc")" = 0 ] && [ "$(regels "$W/lokaal.gosu")" = 1 ] && grep -qx 'TOKEN van-lokaal' "$W/lokaal.uit" && echo 1)" "$(tail -3 "$W/lokaal.uit" | tr '\n' ' ')"
toets 'B1b gosu als claude naar /app/db/pod-geheimen.js' "$(grep -qx 'claude node /app/db/pod-geheimen.js' "$W/lokaal.gosu" && echo 1)"
toets 'B2 adres + schakelaar mee naar het commando, bootstrap niet' "$(grep -qx 'URL http://127.0.0.1:8091' "$W/lokaal.uit" && grep -qx 'LOKAAL 1' "$W/lokaal.uit" && grep -qx 'BOOT AFWEZIG' "$W/lokaal.uit" && echo 1)"
draai herhaal "$GOED" NEP_FAAL=2
toets 'B3 databank nog niet op: herhaalt en laadt (3 pogingen)' "$([ "$(cat "$W/herhaal.rc")" = 0 ] && [ "$(regels "$W/herhaal.gosu")" = 3 ] && grep -qx 'TOKEN van-lokaal' "$W/herhaal.uit" && echo 1)"
: > "$W/rpc.log"; : > "$W/gosu.log"; printf '%b' "$GOED" > "$W/adres.env"
env -i PATH="$W/bin:$PATH" HOME="$W" POD_BOOTSTRAP_SECRET=fout-geheim-fout-geheim SUPABASE_URL="http://127.0.0.1:$POORT" \
  FETCH_SECRETS_ADRES_ENV="$W/adres.env" NEP_GOSU_LOG="$W/gosu.log" bash ./fetch-secrets.sh "$W/druk.sh" > "$W/weiger.uit" 2>&1; rc=$?
toets 'B4 lokaal geweigerd: exit 78, één poging, geen HTTP' "$([ "$rc" = 78 ] && [ "$(regels "$W/gosu.log")" = 1 ] && [ "$(regels "$W/rpc.log")" = 0 ] && echo 1)"
draai geen -
toets 'B5 geen adres.env: oude RPC-route' "$([ "$(regels "$W/geen.rpc")" = 1 ] && [ "$(regels "$W/geen.gosu")" = 0 ] && grep -qx 'TOKEN van-supabase' "$W/geen.uit" && grep -qx "URL http://127.0.0.1:$POORT" "$W/geen.uit" && echo 1)"
draai vreemd 'SUPABASE_URL=http://127.0.0.1:9999\nSB_SQL_LOKAAL=1\n'
toets 'B6 adres.env met ander adres: genegeerd + logregel, oude route' "$([ "$(regels "$W/vreemd.rpc")" = 1 ] && grep -q 'onbekende vorm' "$W/vreemd.uit" && grep -qx 'LOKAAL ' "$W/vreemd.uit" && echo 1)"
draai crlf 'SUPABASE_URL=http://127.0.0.1:8091\r\nSB_SQL_LOKAAL=1\r\n'
toets 'B6b CRLF: genegeerd zoals server.js, oude route' "$([ "$(regels "$W/crlf.rpc")" = 1 ] && [ "$(regels "$W/crlf.gosu")" = 0 ] && echo 1)"
draai inspring '  # x\n   \nSUPABASE_URL=http://127.0.0.1:8091\nSB_SQL_LOKAAL=1\n'
toets 'B6c ingesprongen commentaar: lokaal zoals server.js' "$([ "$(regels "$W/inspring.rpc")" = 0 ] && [ "$(regels "$W/inspring.gosu")" = 1 ] && echo 1)"
draai vps "$GOED" SOCEV_KANT=vps
toets 'B7 kant vps: adres.env genegeerd, oude route' "$([ "$(regels "$W/vps.rpc")" = 1 ] && [ "$(regels "$W/vps.gosu")" = 0 ] && echo 1)"

# ── C. pod-geheimen.js tegen een wegwerp-cluster ────────────────────────────
if [ -x "$PGB/initdb" ] && [ "$(id -u)" != 0 ]; then
  mkdir -p "$W/pg/sock"
  "$PGB/initdb" -D "$W/pg/data" -U postgres --auth-local=trust --auth-host=reject >/dev/null 2>&1
  # zwaarste logstand (log_statement all) plus de parameter-regels uit de pod-config: het geheim mag nergens in het log komen
  printf "listen_addresses = ''\nunix_socket_directories = '%s'\nport = 5432\nlog_statement = 'all'\n" "$W/pg/sock" >> "$W/pg/data/postgresql.conf"
  grep -E '^log_parameter_max_length' db/postgresql.socev.conf >> "$W/pg/data/postgresql.conf"
  "$PGB/pg_ctl" -D "$W/pg/data" -l "$W/pg/log" -w start >/dev/null 2>&1
  "$PGB/psql" -X -q -h "$W/pg/sock" -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
-- het geheim staat hier alleen als md5, zodat C3 het in het log (ook van deze create) zou zien als het daar toch kwam
create function public.sb_pod_secrets_lezen(p_bootstrap text) returns json language sql as $$
  select case when md5(p_bootstrap) = 'f26db8c90390a2af3034c3de2e1b6c5d' then json_build_object('ok', true, 'secrets',
    json_build_array(json_build_object('naam', 'claude_code_oauth_token', 'waarde', 'x''y"z'))) else json_build_object('ok', false) end $$;
SQL
  uit=$(POD_GEHEIMEN_SOCKET="$W/pg/sock" POD_BOOTSTRAP_SECRET="nep-bootstrap-lang" node db/pod-geheimen.js); rc=$?
  toets 'C1 echte functie: PostgREST-vorm, exit 0' "$([ "$rc" = 0 ] && [ "$uit" = '{"ok":true,"secrets":[{"naam":"claude_code_oauth_token","waarde":"x'"'"'y\"z"}]}' ] && echo 1)" "$uit"
  uit=$(POD_GEHEIMEN_SOCKET="$W/pg/sock" POD_BOOTSTRAP_SECRET="ander'; drop table x; --" node db/pod-geheimen.js); rc=$?
  toets 'C2 ander geheim (met quote): ok:false, exit 0' "$([ "$rc" = 0 ] && [ "$uit" = '{"ok":false}' ] && echo 1)" "$uit"
  toets 'C3 geheim nooit in het log (log_statement all + pod-parameterregels)' "$(! grep -rq 'nep-bootstrap-lang' "$W/pg/data/log" "$W/pg/log" 2>/dev/null && grep -rq 'sb_pod_secrets_lezen(\$1::text)' "$W/pg/data/log" "$W/pg/log" 2>/dev/null && echo 1)"
  "$PGB/pg_ctl" -D "$W/pg/data" -m fast stop >/dev/null 2>&1
  POD_GEHEIMEN_SOCKET="$W/pg/sock" POD_BOOTSTRAP_SECRET=x node db/pod-geheimen.js > "$W/c4.uit" 2> "$W/c4.err"; rc=$?
  toets 'C3b pod-config: log_statement none en parameters nooit gelogd' "$(grep -qx "log_statement = 'none'" db/postgresql.socev.conf && grep -qx 'log_parameter_max_length = 0' db/postgresql.socev.conf && grep -qx 'log_parameter_max_length_on_error = 0' db/postgresql.socev.conf && echo 1)"
  toets 'C4 geen databank: exit 1, niets op stdout' "$([ "$rc" = 1 ] && [ ! -s "$W/c4.uit" ] && echo 1)"
else
  echo "OVERGESLAGEN C (geen PG-binaries of root)"
fi

echo "adres-env: $fout rood"
[ "$fout" = 0 ]
