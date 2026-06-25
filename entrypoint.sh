#!/usr/bin/env bash
# entrypoint.sh — start + bewaakt de sync-lus en de Telegram-bot.
# Kubernetes houdt de container overeind; deze supervisor herstart de
# losse processen als ze binnenin omvallen. Twee lagen veerkracht.
set -u
export HOME=/opt/data
export PATH=/usr/local/bin:/opt/data/bin:$PATH
VAULT="${VAULT_DIR:-/opt/data/AI_SecondBrain}"
BIN=/opt/data/bin
mkdir -p "$BIN" "$VAULT"

log() { echo "$(date '+%F %T') $*"; }

# ---- sync-lus: houdt de vault gelijk met Google Drive -----------------------
start_sync() {
  bash -c '
    VAULT="'"$VAULT"'"
    while true; do
      if rclone listremotes 2>/dev/null | grep -q "^gdrive:"; then
        rclone bisync "gdrive:AI_SecondBrain" "$VAULT" \
          --create-empty-src-dirs --conflict-resolve newer >> '"$BIN"'/bisync.log 2>&1 \
        || rclone bisync "gdrive:AI_SecondBrain" "$VAULT" \
          --resync --create-empty-src-dirs >> '"$BIN"'/bisync.log 2>&1
      else
        echo "$(date) WACHT: rclone-remote \"gdrive\" nog niet geconfigureerd" >> '"$BIN"'/bisync.log
      fi
      sleep 300
    done' &
  SYNC_PID=$!
  log "sync-lus gestart (pid $SYNC_PID)"
}

# ---- Telegram-bot -----------------------------------------------------------
start_bot() {
  node /app/telegram-claude-bot.js >> "$BIN/bot.log" 2>&1 &
  BOT_PID=$!
  log "telegram-bot gestart (pid $BOT_PID)"
}

# Setup-status loggen (handig bij eerste deploy)
if ! rclone listremotes 2>/dev/null | grep -q "^gdrive:"; then
  log "LET OP: rclone-remote 'gdrive' ontbreekt — draai eenmalig 'rclone config' in deze container."
fi
if [ ! -f /opt/data/.claude/.credentials.json ] && [ ! -d /opt/data/.claude ]; then
  log "LET OP: Claude nog niet ingelogd — draai eenmalig 'claude' in deze container om in te loggen."
fi

start_sync
start_bot

# ---- supervisor -------------------------------------------------------------
while true; do
  kill -0 "$SYNC_PID" 2>/dev/null || { log "sync-lus weg, herstart"; start_sync; }
  kill -0 "$BOT_PID"  2>/dev/null || { log "bot weg, herstart";     start_bot;  }
  sleep 30
done
