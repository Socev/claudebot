#!/usr/bin/env bash
# db-wacht.sh (wv3180) — start en bewaakt de eigen Postgres van de pod (ontwerp § 1).
#   Als root (vanuit entrypoint.sh, op de achtergrond, vóór fetch-secrets.sh: geen pod-sleutel in deze omgeving):
#     mappen en rechten, kluissleutel naar /opt/data/pg/kluis.key (0400 pg), oom_score_adj -500, dan `gosu pg` naar de lus.
#   Als pg: initdb (superuser pgbaas) als de datamap leeg is, postgres starten, init-SQL toepassen (idempotent), wachten;
#     sterft postgres, dan herstart met oplopende wachttijd. /run/pgstop/stop (gezet door run.sh bij SIGTERM) = netjes stoppen.
#   wv3241 terug-modus: /run/pgstop/terug (alleen claude kan het zetten; db-terug.js na `uitwijk naar-olares` op de R230) = de koude
#     kopie van de uitwijkdatabank in /opt/data/pg/terug/<id>/data.tar inzetten: uitpakken en toetsen terwijl postgres nog draait,
#     dan netjes stoppen, de huidige datamap opzij (17/data.oud-<tijd>, nooit gewist), de kopie op zijn plek, postgres weer starten.
#     Uitkomst in /opt/data/pg/terug-<id>.json (0640 pg:pgsock). Faalt een toets vóór het stoppen, dan blijft alles zoals het was.
# Noodschakelaar (B103, 19-11-2026): /opt/data/pg-uit bestaat → de databank start niet, db-wacht WACHT tot het bestand weg is en start
#   hem dan alsnog. De pod draait door: fetch-secrets.sh komt dan op in de noodstand 'databank-weg' (de kluis staat in deze databank),
#   en run.sh laat de container herstarten zodra de databank antwoordt, zodat de kluissecrets er dan wel zijn.
# Kan de databank niet starten (half terugzetten, initdb faalt): niet meer stoppen (niemand herstartte db-wacht daarna), maar wachten
#   met oplopende tussentijd (1 → 10 min) en opnieuw proberen; de reden staat in db-wacht.log en in de stand.
# Stand: $PG_STAND (/run/pgstand/stand, 0640 pg:pgsock), één JSON-regel {stand: uit|wacht|start|draait|herstart|gestopt, reden, tijd}.
#   fetch-secrets.sh (root) en server.js (/health.noodstand.databank) lezen hem; geen sleutels, geen SQL.
set -u
PGBIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
BASIS="${PG_BASIS:-/opt/data/pg}"
DATA="$BASIS/17/data"
SOCK="${PG_SOCK:-/run/pg}"
STOPMAP="${PG_STOPMAP:-/run/pgstop}"
INIT="${PG_INIT_MAP:-/app/db}"
LOG="$BASIS/db-wacht.log"
PG_UIT="${PG_UIT:-/opt/data/pg-uit}"
STAND="${PG_STAND:-/run/pgstand/stand}"
log(){ printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true; }
# stand <stand> [reden] — atomair (tmp + mv in dezelfde map); de reden zonder aanhalingstekens, backslashes en stuurtekens (geldige JSON)
stand(){
  local d t r; d="$(dirname "$STAND")"; t="$d/.stand.$$"
  r="$(printf '%s' "${2:-}" | LC_ALL=C tr -d '\000-\037"\\' | cut -c1-200)"
  printf '{"stand":"%s","reden":"%s","tijd":"%s"}\n' "$1" "$r" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$t" 2>/dev/null \
    && chmod 0640 "$t" 2>/dev/null && { chgrp pgsock "$t" 2>/dev/null || true; } \
    && mv -f "$t" "$STAND" 2>/dev/null || rm -f "$t" 2>/dev/null
  return 0
}
# B103: de noodschakelaar houdt alleen de databank tegen, niet de pod; weg = alsnog starten
wacht_pg_uit(){
  [ -e "$PG_UIT" ] || return 0
  log "noodschakelaar $PG_UIT: databank blijft uit tot het bestand weg is (de pod draait door in noodstand)"
  stand uit "noodschakelaar pg-uit staat aan"
  while [ -e "$PG_UIT" ]; do [ -e "$STOPMAP/stop" ] && { stand gestopt "stopverzoek"; exit 0; }; sleep 5; done
  log "noodschakelaar weg: databank start"
  stand start "noodschakelaar weg"
}

[ -x "$PGBIN/postgres" ] || exit 0

if [ "$(id -u)" = "0" ]; then
  id pg >/dev/null 2>&1 || exit 0
  # B103: standmap (pg schrijft, claude leest via groep pgsock; root schrijft de eerste stand)
  # Codex MOET 1: groep pgsock op elk standbestand (setgid op de map + chgrp in stand()), anders leest claude een bestand van root of pg niet
  mkdir -p "$(dirname "$STAND")"; chown pg:pgsock "$(dirname "$STAND")"; chmod 2750 "$(dirname "$STAND")"
  stand start "db-wacht gestart"
  wacht_pg_uit
  mkdir -p "$BASIS/17" "$BASIS/wal-archief" "$BASIS/log" "$SOCK" "$STOPMAP"
  chown pg:pgsock "$BASIS" "$BASIS/wal-archief" "$BASIS/log"; chmod 0750 "$BASIS" "$BASIS/wal-archief" "$BASIS/log"
  # wv3869: archiefbestanden leesbaar voor groep pgsock (claude meet met pg_waldump); bestanden van vóór wv3869 waren pg:pg
  find "$BASIS/wal-archief" -maxdepth 1 -type f -name '*.zst' ! -group pgsock -exec chgrp pgsock {} + 2>/dev/null || true
  chown pg:pg "$BASIS/17"; chmod 0700 "$BASIS/17"
  [ -d "$DATA" ] && { chown -R pg:pg "$DATA"; chmod 0700 "$DATA"; }
  # verse container: er draait hier nog geen postmaster; een achtergebleven pid-bestand (na SIGKILL) kan een PID noemen die nu van een
  # ander proces is, en dan weigert postgres te starten
  rm -f "$DATA/postmaster.pid"
  chown pg:pgsock "$SOCK"; chmod 0750 "$SOCK"
  # PostgREST-socket (wv3180, Codex MOET 1): alleen claude
  mkdir -p /run/pgrst; chown claude:claude /run/pgrst; chmod 0700 /run/pgrst
  # stopverzoek: alleen claude (run.sh) kan het zetten, pg kan het zien (0711, vaste naam)
  chown claude:claude "$STOPMAP"; chmod 0711 "$STOPMAP"; rm -f "$STOPMAP/stop" "$STOPMAP/terug"
  # wv3241: ontvangstmap voor de terug-kopie: claude schrijft, pg leest (groep pgsock, setgid), socev komt niet in /opt/data/pg
  mkdir -p "$BASIS/terug"; chown claude:pgsock "$BASIS/terug"; chmod 2750 "$BASIS/terug"
  touch "$LOG"; chown pg:pgsock "$LOG"; chmod 0640 "$LOG"
  if [ -f /opt/data/.pg/kluis.key ]; then
    install -o pg -g pg -m 0400 /opt/data/.pg/kluis.key "$BASIS/kluis.key" || log "kluissleutel kopiëren faalde"
  fi
  # wv3187: replicatiewachtwoord van rol reserve (warme reserve op de R230, ontwerp § 5); init-reserve.sql leest het als pg.
  # Zonder bestand: geen rol en geen slot (en een oud bestand gaat weg).
  if [ -s /opt/data/.pg/reserve.wachtwoord ]; then
    install -o pg -g pg -m 0400 /opt/data/.pg/reserve.wachtwoord "$BASIS/reserve.pw" || log "reservewachtwoord kopiëren faalde"
  else
    rm -f "$BASIS/reserve.pw"
  fi
  # wv3202: lukt alleen met CAP_SYS_RESOURCE (Olares geeft die niet; postgres blijft dan op de containerwaarde). Daarom zet de pod
  # zijn agentprocessen op 1000 (server.js oomEerst, socev-loper.js): die vallen bij geheugennood eerst.
  if echo -500 > /proc/self/oom_score_adj 2>/dev/null; then log "oom_score_adj -500"; else log "oom_score_adj niet te zetten (geen CAP_SYS_RESOURCE); agents staan op 1000"; fi
  exec gosu pg "$0" --lus
fi

[ "${1:-}" = "--lus" ] || { echo "gebruik: als root starten (entrypoint)" >&2; exit 2; }
umask 077
initdb_als_leeg(){
if [ ! -s "$DATA/PG_VERSION" ]; then
  # Codex MOET 2: nooit een lege databank maken naast een opzij gezette (dan is er iets misgegaan bij een terugwissel)
  if ls -d "$BASIS"/17/data.oud-* >/dev/null 2>&1; then log "geen datamap maar wel 17/data.oud-*: geen initdb, geen start (machinekamer)"; exit 1; fi
  log "lege datamap: initdb"
  if "$PGBIN/initdb" -D "$DATA" -U pgbaas --auth-local=peer --auth-host=reject --encoding=UTF8 --locale=C.UTF-8 \
       --locale-provider=icu --icu-locale=en-US --data-checksums >> "$LOG" 2>&1; then
    printf "\n# wv3180: pod-instellingen uit het image\ninclude = '%s/postgresql.socev.conf'\n" "$INIT" >> "$DATA/postgresql.conf"
  else
    log "initdb faalde — geen databank"; exit 1
  fi
fi
}

PID=""
stop_gevraagd(){ [ -e "$STOPMAP/stop" ]; }
init_sql(){
  for _ in $(seq 1 60); do "$PGBIN/pg_isready" -q -h "$SOCK" && break; sleep 1; done
  if "$PGBIN/psql" -X -q -h "$SOCK" -U pgbaas -d postgres -v ON_ERROR_STOP=1 -f "$INIT/init-cluster.sql" -f "$INIT/init-db.sql" >> "$LOG" 2>&1; then
    log "init-SQL toegepast"
  else
    log "init-SQL faalde (zie hierboven)"
  fi
  # wv3187: rol reserve + slot r230 apart (een fout hier raakt de rest van de init niet)
  if [ -f "$INIT/init-reserve.sql" ]; then
    if PG_RESERVE_PW="$BASIS/reserve.pw" "$PGBIN/psql" -X -q -h "$SOCK" -U pgbaas -d postgres -v ON_ERROR_STOP=1 -f "$INIT/init-reserve.sql" >> "$LOG" 2>&1; then
      log "reserve-SQL toegepast"
    else
      log "reserve-SQL faalde (zie hierboven)"
    fi
  fi
}
# ── terug-modus (wv3241) ──────────────────────────────────────────────────────────────────────────────────────
# Het verzoek (regels sleutel=waarde, door claude) noemt id, sha256 van de tar en wat pg_controldata van de kopie moet zeggen
# (checkpoint_lsn, tijdlijn, systeem_id; gemeten op de R230 ná de nette stop). Paden komen nooit uit het verzoek: alleen het id.
TERUG_HERSTART=0
terug_waarde(){ sed -n "s/^$1=//p" "$STOPMAP/terug" 2>/dev/null | head -1 | tr -cd "$2"; }
terug_id(){ local id; id="$(terug_waarde id 'A-Za-z0-9-')"; [[ "$id" =~ ^[A-Za-z0-9-]{8,48}$ ]] && printf '%s' "$id"; }
terug_open(){ local id; [ -s "$STOPMAP/terug" ] && id="$(terug_id)" && [ ! -e "$BASIS/terug-$id.json" ]; }
controle(){ LC_ALL=C "$PGBIN/pg_controldata" "$1" 2>/dev/null | sed -n "s/^$2: *//p" | head -1; }
terug_uitkomst(){  # <id> <uitkomst> <reden> [extra json-velden]
  local f="$BASIS/terug-$1.json"
  printf '{"id":"%s","uitkomst":"%s","reden":"%s","tijd":"%s"%s}\n' "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${4:-}" > "$f.tmp" \
    && chmod 0640 "$f.tmp" && mv -f "$f.tmp" "$f"
  log "terug $1: $2 ${3}"
}
terug_uitvoeren(){
  local id sha lsn tli sid tar nieuw oud k_staat k_lsn k_tli k_sid h_tli rc
  id="$(terug_id)" || return 0
  sha="$(terug_waarde sha256 '0-9a-f')"; lsn="$(terug_waarde checkpoint_lsn '0-9A-F/')"
  tli="$(terug_waarde tijdlijn '0-9')"; sid="$(terug_waarde systeem_id '0-9')"
  tar="$BASIS/terug/$id/data.tar"; nieuw="$BASIS/17/terug-$id"
  log "terugverzoek $id: kopie uitpakken en toetsen (postgres draait nog)"
  [ ${#sha} = 64 ] && [ -n "$lsn" ] && [ -n "$tli" ] && [ -n "$sid" ] || { terug_uitkomst "$id" fout "verzoek onvolledig"; return 0; }
  [ -f "$tar" ] || { terug_uitkomst "$id" fout "kopie ontbreekt"; return 0; }
  [ "$(sha256sum < "$tar" | cut -c1-64)" = "$sha" ] || { terug_uitkomst "$id" fout "sha256 van de kopie wijkt af"; return 0; }
  rm -rf "$nieuw"; mkdir -p "$nieuw" || { terug_uitkomst "$id" fout "uitpakmap niet te maken"; return 0; }
  if ! tar -C "$nieuw" --no-same-owner -xf "$tar" 2>>"$LOG"; then rm -rf "$nieuw"; terug_uitkomst "$id" fout "uitpakken faalde (schijf vol?)"; return 0; fi
  local d="$nieuw/data"
  if [ ! -s "$d/PG_VERSION" ] || [ "$(cat "$d/PG_VERSION")" != "$(cat "$DATA/PG_VERSION")" ]; then rm -rf "$nieuw"; terug_uitkomst "$id" fout "geen databank van dezelfde hoofdversie"; return 0; fi
  if [ -e "$d/standby.signal" ] || [ -e "$d/recovery.signal" ] || [ -e "$d/postmaster.pid" ]; then
    rm -rf "$nieuw"; terug_uitkomst "$id" fout "kopie is een reserve of niet netjes gestopt (signal/pid)"; return 0
  fi
  k_staat="$(controle "$d" 'Database cluster state')"; k_lsn="$(controle "$d" 'Latest checkpoint location')"
  k_tli="$(controle "$d" "Latest checkpoint's TimeLineID")"; k_sid="$(controle "$d" 'Database system identifier')"
  h_tli="$(controle "$DATA" "Latest checkpoint's TimeLineID")"
  if [ "$k_staat" != "shut down" ]; then rm -rf "$nieuw"; terug_uitkomst "$id" fout "kopie niet netjes gestopt ($k_staat)"; return 0; fi
  if [ "$k_lsn" != "$lsn" ] || [ "$k_tli" != "$tli" ] || [ "$k_sid" != "$sid" ]; then
    rm -rf "$nieuw"; terug_uitkomst "$id" fout "kopie wijkt af van de R230 (lsn $k_lsn/$lsn, tijdlijn $k_tli/$tli, systeem gelijk: $([ "$k_sid" = "$sid" ] && echo ja || echo nee))"; return 0
  fi
  # alleen een afstammeling van deze databank (zelfde systeem-id: de reserve was een kopie van Olares) en niet van een oudere tijdlijn
  if [ "$k_sid" != "$(controle "$DATA" 'Database system identifier')" ]; then rm -rf "$nieuw"; terug_uitkomst "$id" fout "kopie hoort bij een andere databank (systeem-id)"; return 0; fi
  if [ -n "$h_tli" ] && [ "$k_tli" -lt "$h_tli" ]; then rm -rf "$nieuw"; terug_uitkomst "$id" fout "kopie is ouder dan de huidige databank (tijdlijn $k_tli < $h_tli)"; return 0; fi
  log "terugverzoek $id: kopie klopt (lsn $k_lsn, tijdlijn $k_tli); postgres netjes stoppen"
  kill -INT "$PID" 2>/dev/null
  for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$PID" 2>/dev/null; then rm -rf "$nieuw"; terug_uitkomst "$id" fout "postgres stopte niet binnen 60 s; huidige databank blijft"; TERUG_HERSTART=1; return 0; fi
  oud="data.oud-$(date -u +%Y%m%d-%H%M%S)"
  # Codex MOET 2: dagboek vóór de eerste verplaatsing; valt het proces tussen de twee mv's weg, dan zet terug_herstel bij de
  # volgende start de oude map terug (vóór initdb kan draaien)
  printf 'id=%s\noud=%s\nnieuw=%s\nlsn=%s\ntli=%s\nsid=%s\n' "$id" "$oud" "terug-$id" "$k_lsn" "$k_tli" "$k_sid" > "$BASIS/terug-bezig.tmp" \
    && sync "$BASIS/terug-bezig.tmp" 2>/dev/null; mv -f "$BASIS/terug-bezig.tmp" "$BASIS/terug-bezig" && sync "$BASIS" 2>/dev/null
  if ! mv "$DATA" "$BASIS/17/$oud"; then rm -f "$BASIS/terug-bezig"; rm -rf "$nieuw"; terug_uitkomst "$id" fout "huidige datamap niet opzij te zetten; blijft"; TERUG_HERSTART=1; return 0; fi
  if ! mv "$d" "$DATA"; then
    mv "$BASIS/17/$oud" "$DATA"; rm -f "$BASIS/terug-bezig"; rm -rf "$nieuw"; terug_uitkomst "$id" fout "kopie niet op zijn plek te zetten; oude datamap terug"; TERUG_HERSTART=1; return 0
  fi
  sync "$BASIS/17" 2>/dev/null
  chmod 0700 "$DATA"; rmdir "$nieuw" 2>/dev/null || true
  terug_uitkomst "$id" gewisseld "kopie ingezet, oude datamap opzij" ",\"oud\":\"$oud\",\"checkpoint_lsn\":\"$k_lsn\",\"tijdlijn\":$k_tli,\"systeem_id\":\"$k_sid\""
  rm -f "$BASIS/terug-bezig"
  TERUG_HERSTART=1
}
# Bij de start (vóór initdb): een onderbroken wissel afmaken (kopie stond al op zijn plek) of terugdraaien (oude map terug).
terug_herstel(){
  local j="$BASIS/terug-bezig" id oud lsn tli sid
  [ -s "$j" ] || return 0
  id="$(sed -n 's/^id=//p' "$j" | head -1 | tr -cd 'A-Za-z0-9-')"; oud="$(sed -n 's/^oud=//p' "$j" | head -1 | tr -cd 'A-Za-z0-9.-')"
  lsn="$(sed -n 's/^lsn=//p' "$j" | head -1 | tr -cd '0-9A-F/')"; tli="$(sed -n 's/^tli=//p' "$j" | head -1 | tr -cd '0-9')"
  sid="$(sed -n 's/^sid=//p' "$j" | head -1 | tr -cd '0-9')"
  if [ -z "$oud" ] || [ ! -e "$BASIS/17/$oud" ]; then
    # Codex ronde 2: de eerste verplaatsing gebeurde nog niet → de datamap is nog de oude databank; nooit "gewisseld" melden
    [ -s "$DATA/PG_VERSION" ] || { log "terug $id: geen datamap en geen $oud; geen start, dagboek blijft (machinekamer)"; exit 1; }
    log "terug $id: onderbroken vóór de wissel; huidige datamap blijft"
    terug_uitkomst "$id" fout "wissel onderbroken vóór het verplaatsen; huidige databank blijft"
  elif [ -s "$DATA/PG_VERSION" ]; then
    if [ "$(controle "$DATA" 'Latest checkpoint location')" = "$lsn" ] && [ "$(controle "$DATA" "Latest checkpoint's TimeLineID")" = "$tli" ] \
       && [ "$(controle "$DATA" 'Database system identifier')" = "$sid" ]; then
      log "terug $id: onderbroken na het inzetten (datamap = de kopie volgens pg_controldata); wissel afgemaakt"
      [ -e "$BASIS/terug-$id.json" ] || terug_uitkomst "$id" gewisseld "kopie ingezet (na onderbreking afgemaakt), oude datamap opzij" ",\"oud\":\"$oud\",\"checkpoint_lsn\":\"$lsn\",\"tijdlijn\":${tli:-0},\"systeem_id\":\"$sid\""
    else
      log "terug $id: datamap én $oud bestaan, en de datamap is niet de kopie; geen start (machinekamer)"; exit 1
    fi
  elif [ -s "$BASIS/17/$oud/PG_VERSION" ]; then
    [ -e "$DATA" ] && mv "$DATA" "$BASIS/17/data.kapot-$(date -u +%Y%m%d-%H%M%S)"
    if mv "$BASIS/17/$oud" "$DATA"; then
      log "terug $id: onderbroken tussen de verplaatsingen; oude datamap teruggezet"
      terug_uitkomst "$id" fout "wissel onderbroken; oude datamap teruggezet"
    else
      log "terug $id: oude datamap terugzetten faalde; geen start (machinekamer)"; exit 1
    fi
  else
    log "terug $id: onderbroken en geen bruikbare datamap of $oud; geen start (machinekamer)"; exit 1
  fi
  rm -f "$j"
}

wacht_pg_uit
# B103: een start die niet kan (exit 1 in terug_herstel/initdb_als_leeg, in een subshell) stopt db-wacht niet meer: wachten en opnieuw.
# Herstelt iemand de oorzaak (bv. een achtergebleven 17/data.oud-* opgeruimd), dan start de databank vanzelf, zonder podherstart.
HW="${PG_HERSTEL_S:-60}"   # alleen een toets zet dit korter
until ( terug_herstel && initdb_als_leeg ); do
  reden="$(tail -n 1 "$LOG" 2>/dev/null | cut -d' ' -f2-)"
  stand wacht "${reden:-databank kan niet starten (zie db-wacht.log)}"
  log "databank start niet; opnieuw over ${HW}s"
  for _ in $(seq 1 "$HW"); do stop_gevraagd && { stand gestopt "stopverzoek"; exit 0; }; sleep 1; done
  HW=$(( HW * 2 )); [ "$HW" -gt 600 ] && HW=600
done
WACHT=(2 5 10 20 30 60)
n=0
while ! stop_gevraagd; do
  "$PGBIN/postgres" -D "$DATA" >> "$LOG" 2>&1 &
  PID=$!
  log "postgres gestart (pid $PID)"
  init_sql
  if kill -0 "$PID" 2>/dev/null && "$PGBIN/pg_isready" -q -h "$SOCK"; then stand draait; fi
  gestart=$(date +%s)
  while kill -0 "$PID" 2>/dev/null; do
    if stop_gevraagd; then
      log "stopverzoek: fast shutdown"
      kill -INT "$PID" 2>/dev/null
      for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
      log "postgres gestopt"; stand gestopt "stopverzoek"; exit 0
    fi
    if terug_open; then terug_uitvoeren; [ "$TERUG_HERSTART" = 1 ] && break; fi
    sleep 1
  done
  wait "$PID" 2>/dev/null; rc=$?
  if [ "$TERUG_HERSTART" = 1 ]; then TERUG_HERSTART=0; n=0; log "terug-modus: postgres opnieuw starten (rc $rc)"; continue; fi
  [ $(( $(date +%s) - gestart )) -gt 300 ] && n=0
  w=${WACHT[$n]}; [ $n -lt $(( ${#WACHT[@]} - 1 )) ] && n=$((n+1))
  log "postgres stopte (rc $rc) — herstart over ${w}s"
  stand herstart "postgres stopte (rc $rc), herstart over ${w}s"
  for _ in $(seq 1 "$w"); do stop_gevraagd && { stand gestopt "stopverzoek"; exit 0; }; sleep 1; done
done
