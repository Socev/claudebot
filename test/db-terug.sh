#!/usr/bin/env bash
# test/db-terug.sh (wv3241) — terug-modus van db-wacht.sh + db/db-terug.js met wegwerp-clusters, zonder root en zonder R230:
# A = "Olares" (draait onder db-wacht.sh --lus), B = "uitwijk op de R230" (basebackup van A, gepromoveerd, eigen schrijfwerk,
# netjes gestopt, als tar met aanvraag in een nep-R230-map; ssh = bash -c). Kruisproeven: afwijkende LSN en een kopie met
# standby.signal worden geweigerd en A blijft draaien met zijn eigen data. Daarna de echte wissel: A heeft B's data, tijdlijn 2,
# oude map opzij, uitkomst gemeld, tweede ronde wisselt niet nog eens. Eist PostgreSQL 17 in $PG_BIN (pod/image).
# Gebruik: bash test/db-terug.sh      Exit 0 = alles groen.
set -uo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"; SRC="$(dirname "$HIER")"
PGB="${PG_BIN:-/usr/lib/postgresql/17/bin}"
[ -x "$PGB/postgres" ] || { echo "SKIP: geen PostgreSQL 17 in $PGB"; exit 0; }
T="$(mktemp -d /tmp/db-terug.XXXXXX)"; chmod 700 "$T"
P=$((56000 + RANDOM % 900)); P2=$((P + 1))
WPID=""
groen=0; rood=0
ok(){ if eval "$2"; then echo "OK    $1"; groen=$((groen+1)); else echo "FOUT  $1   [$2]"; rood=$((rood+1)); fi; }
opruimen(){
  : > "$T/stop/stop" 2>/dev/null
  for _ in $(seq 1 30); do [ -n "$WPID" ] && kill -0 "$WPID" 2>/dev/null || break; sleep 0.5; done
  [ -n "$WPID" ] && kill "$WPID" 2>/dev/null
  "$PGB/pg_ctl" -D "$T/b/data" -m immediate stop >/dev/null 2>&1
  "$PGB/pg_ctl" -D "$T/pg/17/data" -m immediate stop >/dev/null 2>&1
  pkill -f -- "-D $T/" 2>/dev/null
  rm -rf "$T"
}
trap opruimen EXIT
mkdir -p "$T/pg/17" "$T/pg/terug" "$T/sock" "$T/sockb" "$T/stop" "$T/init" "$T/r230"
for f in init-cluster.sql init-db.sql; do echo "select 1;" > "$T/init/$f"; done
export PGHOST="$T/sock" PGPORT="$P"
q(){ "$PGB/psql" -X -qAt -h "$T/sock" -p "$P" -U pgbaas -d postgres -c "$1" 2>/dev/null; }
qb(){ "$PGB/psql" -X -qAt -h "$T/sockb" -p "$P2" -U pgbaas -d postgres -c "$1" 2>/dev/null; }
ctl(){ LC_ALL=C "$PGB/pg_controldata" "$1" | sed -n "s/^$2: *//p"; }

# ── A: "Olares" ──
"$PGB/initdb" -D "$T/pg/17/data" -U pgbaas --auth-local=trust --auth-host=reject --encoding=UTF8 --locale=C.UTF-8 >/dev/null || exit 1
cat >> "$T/pg/17/data/postgresql.conf" <<EOF
port = $P
listen_addresses = ''
unix_socket_directories = '$T/sock'
wal_level = replica
max_wal_senders = 4
shared_buffers = 32MB
EOF
printf 'local all all trust\nlocal replication all trust\n' > "$T/pg/17/data/pg_hba.conf"
PG_BASIS="$T/pg" PG_SOCK="$T/sock" PG_STOPMAP="$T/stop" PG_INIT_MAP="$T/init" bash "$SRC/db/db-wacht.sh" --lus </dev/null >/dev/null 2>&1 &
WPID=$!
for _ in $(seq 1 60); do grep -q "init-SQL toegepast" "$T/pg/db-wacht.log" 2>/dev/null && break; sleep 0.5; done
ok "A draait onder db-wacht (--lus)" 'grep -q "init-SQL toegepast" "$T/pg/db-wacht.log"'
q "create role postgres login; create table public.proef(id int primary key, t text); insert into public.proef select g, md5(g::text) from generate_series(1,100) g; grant select on public.proef to postgres" >/dev/null

# ── B: reserve van A, gepromoveerd (tijdlijn 2), uitwijkwerk, netjes gestopt ──
"$PGB/pg_basebackup" -h "$T/sock" -p "$P" -U pgbaas -D "$T/b/data" -X stream -R -c fast >/dev/null 2>&1
ok "B basebackup van A" '[ -e "$T/b/data/standby.signal" ]'
cp "$T/pg/17/data/postgresql.conf" "$T/b/conf-van-a"
printf "port = %s\nunix_socket_directories = '%s'\n" "$P2" "$T/sockb" >> "$T/b/data/postgresql.conf"
"$PGB/pg_ctl" -D "$T/b/data" -l "$T/b/log" -w start >/dev/null || { cat "$T/b/log"; exit 1; }
"$PGB/pg_ctl" -D "$T/b/data" -w promote >/dev/null
qb "insert into public.proef select g, md5(g::text) from generate_series(101,300) g; create table public.uitwijk_werk(x int); insert into public.uitwijk_werk values (42)"
q "insert into public.proef values (9001, 'olares-tijdens-uitwijk')"     # gaat met de oude map opzij
REF="$(qb "select count(*)||':'||md5(string_agg(id||t, ',' order by id)) from public.proef")"
"$PGB/pg_ctl" -D "$T/b/data" -m fast -w stop >/dev/null
cp "$T/b/conf-van-a" "$T/b/data/postgresql.conf"       # zoals echt: de map draagt de conf van Olares
ok "B netjes gestopt, tijdlijn 2" '[ "$(ctl "$T/b/data" "Database cluster state")" = "shut down" ] && [ "$(ctl "$T/b/data" "Latest checkpoint'"'"'s TimeLineID")" = 2 ]'
LSN="$(ctl "$T/b/data" 'Latest checkpoint location')"; SID="$(ctl "$T/b/data" 'Database system identifier')"

maak_aanvraag(){  # <id> <map> <lsn> [status]
  tar -C "$2" -cf "$T/r230/$1.tar" data
  local sha bytes; sha="$(sha256sum < "$T/r230/$1.tar" | cut -c1-64)"; bytes="$(stat -c %s "$T/r230/$1.tar")"
  printf '{"id":"%s","status":"%s","sha256":"%s","bytes":%s,"checkpoint_lsn":"%s","tijdlijn":2,"systeem_id":"%s"}\n' \
    "$1" "${4:-aangevraagd}" "$sha" "$bytes" "$3" "$SID" > "$T/r230/aanvraag.json"
  rm -f "$T/r230/olares.json"
}
ronde(){ DB_TERUG_SSH='["bash","-c"]' DB_TERUG_SUDO=0 DB_TERUG_R230="$T/r230" PG_BASIS="$T/pg" PG_STOPMAP="$T/stop" PG_SOCK="$T/sock" \
  PGPORT="$P" DB_TERUG_WACHT_S=60 node "$SRC/db/db-terug.js" ronde 2>&1 | tail -1; }
telling(){ q "select count(*) from public.proef"; }

# ── 0: geen aanvraag / andere status ──
uit="$(ronde)"; ok "0 geen aanvraag: geen" '[ "$uit" = "{\"uitkomst\":\"geen\"}" ]'
maak_aanvraag 20261116-200000-aaaaaaaa "$T/b" "$LSN" ingetrokken
uit="$(ronde)"; ok "0 ingetrokken aanvraag: geen, niets opgehaald" 'printf "%s" "$uit" | grep -q "\"uitkomst\":\"geen\"" && [ ! -e "$T/pg/terug/20261116-200000-aaaaaaaa" ]'

# ── K1: kruisproef — LSN wijkt af → geweigerd, A blijft ──
maak_aanvraag 20261116-200001-bbbbbbbb "$T/b" "0/1"
uit="$(ronde)"
ok "K1 afwijkende LSN: fout, gemeld op de R230" 'printf "%s" "$uit" | grep -q "\"uitkomst\":\"fout\"" && grep -q "\"stand\":\"fout\"" "$T/r230/olares.json" && grep -q "wijkt af van de R230" "$T/pg/terug-20261116-200001-bbbbbbbb.json"'
ok "K1 A draait nog met zijn eigen data (101 rijen), geen oude map opzij" '[ "$(telling)" = 101 ] && [ -z "$(ls -d "$T"/pg/17/data.oud-* 2>/dev/null)" ] && [ ! -e "$T/stop/terug" ]'

# ── K2: kruisproef — kopie met standby.signal → geweigerd ──
mkdir -p "$T/b2"; cp -a "$T/b/data" "$T/b2/data"; touch "$T/b2/data/standby.signal"
maak_aanvraag 20261116-200002-cccccccc "$T/b2" "$LSN"
uit="$(ronde)"
ok "K2 kopie met standby.signal: geweigerd, A ongemoeid" 'printf "%s" "$uit" | grep -q "\"uitkomst\":\"fout\"" && grep -q "reserve of niet netjes" "$T/pg/terug-20261116-200002-cccccccc.json" && [ "$(telling)" = 101 ]'

# ── K3: kruisproef — kopie beschadigd onderweg (sha256) → niet ingezet, volgende ronde opnieuw ──
maak_aanvraag 20261116-200003-dddddddd "$T/b" "$LSN"
sed -i 's/"sha256":"\(.\)/"sha256":"0/' "$T/r230/aanvraag.json"; sed -i 's/"sha256":"00/"sha256":"01/' "$T/r230/aanvraag.json"
uit="$(ronde)"
ok "K3 sha256 wijkt af: bezig (opnieuw), geen verzoek aan db-wacht" 'printf "%s" "$uit" | grep -q "\"uitkomst\":\"bezig\"" && [ ! -e "$T/stop/terug" ] && [ "$(telling)" = 101 ]'

# ── W: de echte wissel ──
ID=20261116-200004-eeeeeeee
maak_aanvraag "$ID" "$T/b" "$LSN"
uit="$(ronde)"
ok "W ronde: klaar" 'printf "%s" "$uit" | grep -q "\"uitkomst\":\"klaar\""'
ok "W olares.json: stand klaar, LSN/tijdlijn/systeem gelijk aan de aanvraag" 'grep -q "\"stand\":\"klaar\"" "$T/r230/olares.json" && grep -q "\"olares\":{\"checkpoint_lsn\":\"$LSN\",\"tijdlijn\":2,\"systeem_id\":\"$SID\",\"in_recovery\":false" "$T/r230/olares.json"'
ok "W A heeft nu de data van de uitwijk (tellingen + md5 gelijk)" '[ "$(q "select count(*)||'"':'"'||md5(string_agg(id||t, '"','"' order by id)) from public.proef")" = "$REF" ] && [ "$(q "select x from public.uitwijk_werk")" = 42 ]'
ok "W schrijvend, tijdlijn 2" '[ "$(q "select pg_is_in_recovery()")" = f ] && [ "$(q "select timeline_id from pg_control_checkpoint()")" = 2 ]'
OUD="$(ls -d "$T"/pg/17/data.oud-* 2>/dev/null | head -1)"
ok "W oude datamap opzij (niet gewist)" '[ -n "$OUD" ] && [ -s "$OUD/PG_VERSION" ] && [ ! -e "$T/pg/17/terug-$ID" ]'
ok "W verzoek opgeruimd, uitkomst 0640" '[ ! -e "$T/stop/terug" ] && [ "$(stat -c %a "$T/pg/terug-$ID.json")" = 640 ]'
q "insert into public.proef values (9002, 'na-terug')" >/dev/null
uit="$(ronde)"
ok "W tweede ronde: weer klaar, geen tweede wissel, nieuwe schrijfactie blijft" 'printf "%s" "$uit" | grep -q "\"uitkomst\":\"klaar\"" && [ "$(ls -d "$T"/pg/17/data.oud-* | wc -l)" = 1 ] && [ "$(q "select count(*) from public.proef where id = 9002")" = 1 ]'
ok "W db-wacht leeft nog (zelfde lus)" 'kill -0 "$WPID" 2>/dev/null && grep -q "terug-modus: postgres opnieuw starten" "$T/pg/db-wacht.log"'

# ── S: de haak in server.js (statisch): alleen kant olares + verse stand vps + eigen databank, na elke rolronde ──
ok "S rolwachter roept db-terug aan na elke ronde" 'grep -q "try { dbTerugRonde(); } catch (e) { logError(.dbterug., e); }" "$SRC/server.js"'
ok "S alleen kant olares, verse lezing vps, met socket" 'sed -n "/^function dbTerugRonde/,/^}/p" "$SRC/server.js" | grep -q "ROL_KANT !== .olares." && sed -n "/^function dbTerugRonde/,/^}/p" "$SRC/server.js" | grep -q "rol.actieve_kant === .vps. && rol.gelezen && Date.now() - rol.gelezen < 30000" && sed -n "/^function dbTerugRonde/,/^}/p" "$SRC/server.js" | grep -q "s.PGSQL.5432"'
echo "── $groen groen, $rood fout"
[ "$rood" = 0 ]
