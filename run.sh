#!/usr/bin/env bash
# run.sh — draait als gebruiker 'claude'. Start + bewaakt:
#   - de Claude-API (server.js)         altijd
#   - de Drive-sync (rclone bisync)     altijd
#   - de Telegram-bot (telegram-claude-bot.js)  alleen als TG_TOKEN is gezet
# Zo kun je de in-container bot uitzetten door simpelweg TG_TOKEN leeg te maken
# in Studio (geen rebuild nodig) zodra n8n de Telegram-route overneemt.
set -u
export HOME=/opt/data
export PATH=/usr/local/bin:/opt/data/bin:$PATH
VAULT="${VAULT_DIR:-/opt/data/AI_SecondBrain}"
BIN=/opt/data/bin
mkdir -p "$BIN" "$VAULT"
log(){ echo "$(date '+%F %T') $*"; }

start_sync(){
  bash -c '
    VAULT="'"$VAULT"'"
    while true; do
      if rclone listremotes 2>/dev/null | grep -q "^gdrive:"; then
        rclone bisync "gdrive:AI_SecondBrain" "$VAULT" --create-empty-src-dirs --conflict-resolve newer >> '"$BIN"'/bisync.log 2>&1 \
        || rclone bisync "gdrive:AI_SecondBrain" "$VAULT" --resync --create-empty-src-dirs >> '"$BIN"'/bisync.log 2>&1
      else
        echo "$(date) WACHT: rclone-remote gdrive nog niet geconfigureerd" >> '"$BIN"'/bisync.log
      fi
      sleep 300
    done' &
  SYNC_PID=$!; log "sync gestart (pid $SYNC_PID)"
}
start_api(){
  node /app/server.js >> "$BIN/api.log" 2>&1 &
  API_PID=$!; log "claude-api gestart (pid $API_PID)"
}
start_bot(){
  node /app/telegram-claude-bot.js >> "$BIN/bot.log" 2>&1 &
  BOT_PID=$!; log "telegram-bot gestart (pid $BOT_PID)"
}

# setup-checks
rclone listremotes 2>/dev/null | grep -q "^gdrive:" || log "LET OP: rclone 'gdrive' ontbreekt — draai 'rclone config' als gebruiker claude."
[ -d /opt/data/.claude ] || log "LET OP: Claude nog niet ingelogd — draai 'claude' als gebruiker claude."

start_sync
start_api
[ -n "${TG_TOKEN:-}" ] && start_bot || log "TG_TOKEN leeg: in-container bot uit (n8n verwacht)."

# supervisor
while true; do
  kill -0 "$SYNC_PID" 2>/dev/null || { log "sync herstart"; start_sync; }
  kill -0 "$API_PID"  2>/dev/null || { log "api herstart";  start_api;  }
  if [ -n "${TG_TOKEN:-}" ]; then
    kill -0 "${BOT_PID:-0}" 2>/dev/null || { log "bot herstart"; start_bot; }
  fi
  sleep 30
done
