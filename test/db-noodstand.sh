#!/usr/bin/env bash
# Toetst B103 (actieplan Fable-reviews 19-11-2026): de pod start ook als de eigen databank niet opkomt, en zegt waarom.
#   A. fetch-secrets.sh (lokale kluisroute via adres.env, nep-gosu en nep-sleep in PATH):
#      pg-uit → meteen noodstand zonder kluisaanroep; databank antwoordt niet → noodstand na alle pogingen; geweigerd geheim,
#      kluis zonder Claude-token en de Supabase-route blijven fataal (exit 78); de gewone lokale start is ongewijzigd.
#   B. db/db-wacht.sh --lus tegen een wegwerp-cluster (als PG 17 er is en niet als root): pg-uit houdt alleen de databank tegen en
#      weghalen start hem alsnog; een start die niet kan (17/data.oud-* zonder datamap = de oude exit 1) wacht en start vanzelf na
#      herstel; de stand in PG_STAND volgt (uit/wacht/draait/gestopt).
#   C. run.sh (blok noodstand geknipt): alleen in de noodstand, en pas na twee goede rondes, roept hij afsluiten aan.
#   D. server.js (blok noodstand geknipt): /health.noodstand.
# Gebruik: bash test/db-noodstand.sh [bronmap]   (bronmap = andere kopie voor de kruisproef). Exit 0 = alles groen.
set -u
cd "$(dirname "$0")/.." || exit 1
SRC="${1:-$PWD}"
W="$(mktemp -d)"; WPID=""
PGB=/usr/lib/postgresql/17/bin
opruimen(){ [ -n "$WPID" ] && { : > "$W/b/stop/stop" 2>/dev/null; sleep 2; kill "$WPID" 2>/dev/null; }
  [ -d "$W/b/pg/17/data" ] && "$PGB/pg_ctl" -D "$W/b/pg/17/data" -m immediate stop >/dev/null 2>&1; rm -rf "$W"; }
trap opruimen EXIT
fout=0
toets(){ if [ "$2" = 1 ]; then echo "GROEN $1"; else echo "ROOD  $1${3:+  [$3]}"; fout=$((fout + 1)); fi; }
regels(){ wc -l < "$1" | tr -d ' '; }

# ── A. fetch-secrets.sh ─────────────────────────────────────────────────────
mkdir -p "$W/bin"
# nep-gosu (zoals test/adres-env.sh): faalt de eerste NEP_FAAL keer (= geen databank); NEP_ANTWOORD kiest het antwoord daarna
cat > "$W/bin/gosu" <<'SH'
#!/bin/sh
echo "$*" >> "$NEP_GOSU_LOG"
n=$(wc -l < "$NEP_GOSU_LOG")
[ "$n" -le "${NEP_FAAL:-0}" ] && exit 1
case "${NEP_ANTWOORD:-goed}" in
  goed) printf '{"ok":true,"secrets":[{"naam":"claude_code_oauth_token","waarde":"van-lokaal"}]}' ;;
  zondertoken) printf '{"ok":true,"secrets":[{"naam":"n8n_mcp_token","waarde":"x"}]}' ;;
  *) printf '{"ok":false}' ;;
esac
SH
# nep-sleep: de wachttijden tussen pogingen (tot 85 s) niet echt wachten
printf '#!/bin/sh\nexit 0\n' > "$W/bin/sleep"
chmod +x "$W/bin/gosu" "$W/bin/sleep"
cat > "$W/druk.sh" <<'SH'
#!/bin/sh
echo "TOKEN ${CLAUDE_CODE_OAUTH_TOKEN:-AFWEZIG}"; echo "NOOD ${POD_NOODSTAND:-AFWEZIG}"; echo "REDEN ${POD_NOODSTAND_REDEN:-}"
echo "SINDS ${POD_NOODSTAND_SINDS:-AFWEZIG}"; echo "BOOT ${POD_BOOTSTRAP_SECRET:-AFWEZIG}"; echo "GELADEN [${SECRETS_GELADEN-ONGEZET}]"
SH
chmod +x "$W/druk.sh"
GOED='SUPABASE_URL=http://127.0.0.1:8091\nSB_SQL_LOKAAL=1\n'
DICHT=$(node test/vrije-poort.js) || exit 1   # niemand luistert: Supabase-route onbereikbaar
draai(){ # draai <naam> <adres.env|-> [VAR=waarde ...]
  local naam="$1" inh="$2"; shift 2
  : > "$W/gosu.log"; rm -f "$W/adres.env"; [ "$inh" = - ] || printf '%b' "$inh" > "$W/adres.env"
  env -i PATH="$W/bin:$PATH" HOME="$W" POD_BOOTSTRAP_SECRET=nep-bootstrap SUPABASE_URL="http://127.0.0.1:$DICHT" \
    FETCH_SECRETS_ADRES_ENV="$W/adres.env" FETCH_SECRETS_PG_UIT="$W/pg-uit" NEP_GOSU_LOG="$W/gosu.log" "$@" \
    bash "$SRC/fetch-secrets.sh" "$W/druk.sh" > "$W/$naam.uit" 2>&1
  echo $? > "$W/$naam.rc"; cp "$W/gosu.log" "$W/$naam.gosu"
}
rc(){ cat "$W/$1.rc"; }
heeft(){ grep -q -- "$2" "$W/$1.uit"; }

draai gewoon "$GOED"
toets 'A0 gewone lokale start: token, geen noodstand' "$([ "$(rc gewoon)" = 0 ] && heeft gewoon '^TOKEN van-lokaal$' && heeft gewoon '^NOOD AFWEZIG$' && echo 1)" "$(tail -2 "$W/gewoon.uit" | tr '\n' ' ')"
touch "$W/pg-uit"; draai uit "$GOED"; rm -f "$W/pg-uit"
toets 'A1 pg-uit: start in noodstand zonder kluisaanroep' "$([ "$(rc uit)" = 0 ] && [ "$(regels "$W/uit.gosu")" = 0 ] && heeft uit '^NOOD databank-weg$' && heeft uit '^REDEN noodschakelaar pg-uit' && echo 1)" "rc $(rc uit); $(grep fetch-secrets "$W/uit.uit" | tail -1)"
toets 'A1b noodstand: geen token, geen bootstrapgeheim, lege namenlijst, tijdstip, logregel' "$(heeft uit '^TOKEN AFWEZIG$' && heeft uit '^BOOT AFWEZIG$' && heeft uit '^GELADEN \[\]$' && ! heeft uit '^SINDS AFWEZIG$' && heeft uit 'NOODSTAND databank-weg' && echo 1)"
draai weg "$GOED" NEP_FAAL=99
toets 'A2 databank antwoordt niet: alle 8 pogingen, dan noodstand (exit 0)' "$([ "$(rc weg)" = 0 ] && [ "$(regels "$W/weg.gosu")" = 8 ] && heeft weg '^NOOD databank-weg$' && heeft weg '^REDEN databank antwoordt niet na 8 poging' && heeft weg '^TOKEN AFWEZIG$' && echo 1)" "rc $(rc weg); gosu $(regels "$W/weg.gosu")"
draai weiger "$GOED" NEP_ANTWOORD=weiger
toets 'A3 geweigerd bootstrapgeheim blijft fataal (78, geen noodstand)' "$([ "$(rc weiger)" = 78 ] && ! heeft weiger 'NOODSTAND' && echo 1)"
draai zonder "$GOED" NEP_ANTWOORD=zondertoken
toets 'A4 kluis antwoordt zonder Claude-token: fataal (78)' "$([ "$(rc zonder)" = 78 ] && ! heeft zonder 'NOODSTAND' && echo 1)"
touch "$W/pg-uit"; draai supa -; rm -f "$W/pg-uit"
toets 'A5 Supabase-route (geen adres.env) onbereikbaar: ongewijzigd fataal, ook met pg-uit' "$([ "$(rc supa)" = 78 ] && ! heeft supa 'NOODSTAND' && [ "$(regels "$W/supa.gosu")" = 0 ] && echo 1)"
touch "$W/pg-uit"; draai vps "$GOED" SOCEV_KANT=vps; rm -f "$W/pg-uit"
toets 'A6 kant vps negeert adres.env: geen noodstand' "$([ "$(rc vps)" = 78 ] && ! heeft vps 'NOODSTAND' && echo 1)"

# ── B. db-wacht.sh --lus ────────────────────────────────────────────────────
if [ -x "$PGB/postgres" ] && [ "$(id -u)" != 0 ]; then
  B="$W/b"; mkdir -p "$B/pg/17" "$B/sock" "$B/stop" "$B/init" "$B/stand"; chmod 0700 "$B/pg/17"
  for f in init-cluster.sql init-db.sql; do echo "select 1;" > "$B/init/$f"; done
  printf "listen_addresses = ''\nunix_socket_directories = '%s'\nport = 5432\n" "$B/sock" > "$B/init/postgresql.socev.conf"
  ST="$B/stand/stand"
  start_wacht(){ PG_BASIS="$B/pg" PG_SOCK="$B/sock" PG_STOPMAP="$B/stop" PG_INIT_MAP="$B/init" PG_UIT="$B/pg-uit" PG_STAND="$ST" PG_HERSTEL_S=1 \
    bash "$SRC/db/db-wacht.sh" --lus </dev/null >/dev/null 2>&1 & WPID=$!; }
  stop_wacht(){ : > "$B/stop/stop"; for _ in $(seq 1 40); do kill -0 "$WPID" 2>/dev/null || break; sleep 0.5; done; rm -f "$B/stop/stop"; }
  stand_is(){ grep -q "\"stand\":\"$1\"" "$ST" 2>/dev/null; }
  wacht_op(){ for _ in $(seq 1 "$2"); do stand_is "$1" && return 0; sleep 0.5; done; return 1; }
  touch "$B/pg-uit"; start_wacht; sleep 2
  toets 'B1 pg-uit: db-wacht leeft, geen postgres, stand uit' "$(kill -0 "$WPID" 2>/dev/null && [ ! -S "$B/sock/.s.PGSQL.5432" ] && stand_is uit && echo 1)" "$(cat "$ST" 2>/dev/null)"
  rm -f "$B/pg-uit"
  wacht_op draait 80
  toets 'B2 pg-uit weg: databank start alsnog (initdb + postgres), stand draait' "$(stand_is draait && "$PGB/pg_isready" -q -h "$B/sock" && echo 1)" "$(cat "$ST" 2>/dev/null); $(tail -2 "$B/pg/db-wacht.log" 2>/dev/null | tr '\n' ' ')"
  stop_wacht
  toets 'B3 stopverzoek: db-wacht weg, stand gestopt' "$(! kill -0 "$WPID" 2>/dev/null && stand_is gestopt && echo 1)"
  # de oude 'exit 1': een achtergebleven 17/data.oud-* zonder datamap
  mv "$B/pg/17/data" "$B/pg/17/data.oud-proef"
  start_wacht
  wacht_op wacht 20
  toets 'B4 start die niet kan: db-wacht leeft en wacht, stand wacht met de reden, geen initdb' "$(kill -0 "$WPID" 2>/dev/null && stand_is wacht && grep -q 'geen initdb' "$ST" && [ ! -e "$B/pg/17/data" ] && echo 1)" "$(cat "$ST" 2>/dev/null)"
  mv "$B/pg/17/data.oud-proef" "$B/pg/17/data"
  wacht_op draait 40
  toets 'B5 oorzaak hersteld: databank start vanzelf, zonder herstart van db-wacht' "$(kill -0 "$WPID" 2>/dev/null && stand_is draait && "$PGB/pg_isready" -q -h "$B/sock" && echo 1)" "$(cat "$ST" 2>/dev/null)"
  toets 'B6 stand is geldige JSON, groep pgsock (leesbaar voor claude, Codex MOET 1)' "$(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$ST" 2>/dev/null && { ! getent group pgsock >/dev/null || [ "$(stat -c %G "$ST")" = pgsock ]; } && echo 1)" "$(stat -c '%U:%G %a' "$ST" 2>/dev/null)"
  stop_wacht; WPID=""
else
  echo "OVERGESLAGEN B (geen PG 17 of root)"
fi

# ── C. run.sh: blok noodstand ───────────────────────────────────────────────
sed -n '/^# noodstand:begin/,/^# noodstand:end/p' "$SRC/run.sh" > "$W/nood.sh"
toets 'C0 blok noodstand gevonden in run.sh' "$(grep -q 'noodstand_bewaak()' "$W/nood.sh" && grep -q 'noodstand_bewaak' <(sed -n '/^# bewaker/,$p' "$SRC/run.sh") && echo 1)"
python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$W/.s.PGSQL.5432" 2>/dev/null
printf '#!/bin/sh\n[ -e "%s/klaar" ]\n' "$W" > "$W/bin/pg_isready"; chmod +x "$W/bin/pg_isready"
c(){ # c <POD_NOODSTAND|-> <klaar 0|1> <aantal rondes> → aantal afsluiten-aanroepen
  rm -f "$W/klaar"; [ "$2" = 1 ] && touch "$W/klaar"
  ( [ "$1" = - ] && unset POD_NOODSTAND || export POD_NOODSTAND="$1"
    NOODSTAND_SOCK="$W" NOODSTAND_PGREADY="$W/bin/pg_isready"; export NOODSTAND_SOCK NOODSTAND_PGREADY
    log(){ :; }; N=0; afsluiten(){ N=$((N + 1)); }
    . "$W/nood.sh"; for _ in $(seq 1 "$3"); do noodstand_bewaak; done; echo "$N" )
}
toets 'C1 zonder noodstand: nooit afsluiten' "$([ "$(c - 1 3)" = 0 ] && echo 1)"
toets 'C2 noodstand, databank weg: niet afsluiten' "$([ "$(c databank-weg 0 3)" = 0 ] && echo 1)"
toets 'C3 noodstand, databank één ronde terug: nog niet' "$([ "$(c databank-weg 1 1)" = 0 ] && echo 1)"
toets 'C4 noodstand, databank twee rondes terug: afsluiten (container herstart)' "$([ "$(c databank-weg 1 2)" -ge 1 ] && echo 1)"

# ── D. server.js: /health.noodstand ─────────────────────────────────────────
sed -n '/\/\* noodstand:begin/,/\/\* noodstand:end/p' "$SRC/server.js" > "$W/nood.js"
printf '{"stand":"wacht","reden":"geen datamap maar wel 17/data.oud-*","tijd":"2026-11-19T20:00:00Z"}\n' > "$W/stand.json"
d(){ node -e '
const fs = require("fs"); eval(fs.readFileSync(process.argv[1], "utf8"));
const env = process.argv[3] ? { POD_NOODSTAND: process.argv[3], POD_NOODSTAND_REDEN: "noodschakelaar pg-uit staat aan" } : {};
process.stdout.write(JSON.stringify(noodstandInfo(env, process.argv[2])));' "$W/nood.js" "$1" "${2:-}" 2>/dev/null; }
toets 'D1 zonder noodstand: aan false, wel de databankstand' "$(d "$W/stand.json" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.aan===false && j.databank.stand==="wacht" ? 0 : 1)' 2>/dev/null && echo 1)"
toets 'D2 noodstand: aan, soort, reden, herstel' "$(d "$W/stand.json" databank-weg | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.aan===true && j.soort==="databank-weg" && /pg-uit/.test(j.reden) && j.herstel ? 0 : 1)' 2>/dev/null && echo 1)"
toets 'D3 geen standbestand: databank null, geen fout' "$(d "$W/bestaat-niet" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.aan===false && j.databank===null ? 0 : 1)' 2>/dev/null && echo 1)"
toets 'D4 /health toont noodstand' "$(grep -q 'noodstand: noodstandInfo(),' "$SRC/server.js" && echo 1)"

echo "db-noodstand: $fout rood"
[ "$fout" = 0 ]
