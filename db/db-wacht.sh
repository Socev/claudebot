#!/usr/bin/env bash
# db-wacht.sh (wv3180) — start en bewaakt de eigen Postgres van de pod (ontwerp § 1).
#   Als root (vanuit entrypoint.sh, op de achtergrond, vóór fetch-secrets.sh: geen pod-sleutel in deze omgeving):
#     mappen en rechten, kluissleutel naar /opt/data/pg/kluis.key (0400 pg), oom_score_adj -500, dan `gosu pg` naar de lus.
#   Als pg: initdb (superuser pgbaas) als de datamap leeg is, postgres starten, init-SQL toepassen (idempotent), wachten;
#     sterft postgres, dan herstart met oplopende wachttijd. /run/pgstop/stop (gezet door run.sh bij SIGTERM) = netjes stoppen.
# Noodschakelaar: /opt/data/pg-uit bestaat → niets starten. Faalt hier iets, dan start de pod gewoon door (de databank is dan weg).
set -u
PGBIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
BASIS="${PG_BASIS:-/opt/data/pg}"
DATA="$BASIS/17/data"
SOCK="${PG_SOCK:-/run/pg}"
STOPMAP="${PG_STOPMAP:-/run/pgstop}"
INIT="${PG_INIT_MAP:-/app/db}"
LOG="$BASIS/db-wacht.log"
log(){ printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true; }

[ -x "$PGBIN/postgres" ] || exit 0
[ -e /opt/data/pg-uit ] && exit 0

if [ "$(id -u)" = "0" ]; then
  id pg >/dev/null 2>&1 || exit 0
  mkdir -p "$BASIS/17" "$BASIS/wal-archief" "$BASIS/log" "$SOCK" "$STOPMAP"
  chown pg:pgsock "$BASIS" "$BASIS/wal-archief" "$BASIS/log"; chmod 0750 "$BASIS" "$BASIS/wal-archief" "$BASIS/log"
  chown pg:pg "$BASIS/17"; chmod 0700 "$BASIS/17"
  [ -d "$DATA" ] && { chown -R pg:pg "$DATA"; chmod 0700 "$DATA"; }
  # verse container: er draait hier nog geen postmaster; een achtergebleven pid-bestand (na SIGKILL) kan een PID noemen die nu van een
  # ander proces is, en dan weigert postgres te starten
  rm -f "$DATA/postmaster.pid"
  chown pg:pgsock "$SOCK"; chmod 0750 "$SOCK"
  # PostgREST-socket (wv3180, Codex MOET 1): alleen claude
  mkdir -p /run/pgrst; chown claude:claude /run/pgrst; chmod 0700 /run/pgrst
  # stopverzoek: alleen claude (run.sh) kan het zetten, pg kan het zien (0711, vaste naam)
  chown claude:claude "$STOPMAP"; chmod 0711 "$STOPMAP"; rm -f "$STOPMAP/stop"
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
  if echo -500 > /proc/self/oom_score_adj 2>/dev/null; then log "oom_score_adj -500"; else log "oom_score_adj niet te zetten (geen CAP_SYS_RESOURCE)"; fi
  exec gosu pg "$0" --lus
fi

[ "${1:-}" = "--lus" ] || { echo "gebruik: als root starten (entrypoint)" >&2; exit 2; }
umask 077
if [ ! -s "$DATA/PG_VERSION" ]; then
  log "lege datamap: initdb"
  if "$PGBIN/initdb" -D "$DATA" -U pgbaas --auth-local=peer --auth-host=reject --encoding=UTF8 --locale=C.UTF-8 \
       --locale-provider=icu --icu-locale=en-US --data-checksums >> "$LOG" 2>&1; then
    printf "\n# wv3180: pod-instellingen uit het image\ninclude = '%s/postgresql.socev.conf'\n" "$INIT" >> "$DATA/postgresql.conf"
  else
    log "initdb faalde — geen databank"; exit 1
  fi
fi

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
WACHT=(2 5 10 20 30 60)
n=0
while ! stop_gevraagd; do
  "$PGBIN/postgres" -D "$DATA" >> "$LOG" 2>&1 &
  PID=$!
  log "postgres gestart (pid $PID)"
  init_sql
  gestart=$(date +%s)
  while kill -0 "$PID" 2>/dev/null; do
    if stop_gevraagd; then
      log "stopverzoek: fast shutdown"
      kill -INT "$PID" 2>/dev/null
      for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
      log "postgres gestopt"; exit 0
    fi
    sleep 1
  done
  wait "$PID" 2>/dev/null; rc=$?
  [ $(( $(date +%s) - gestart )) -gt 300 ] && n=0
  w=${WACHT[$n]}; [ $n -lt $(( ${#WACHT[@]} - 1 )) ] && n=$((n+1))
  log "postgres stopte (rc $rc) — herstart over ${w}s"
  for _ in $(seq 1 "$w"); do stop_gevraagd && exit 0; sleep 1; done
done
