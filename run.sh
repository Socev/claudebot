#!/usr/bin/env bash
# run.sh — draait als gebruiker 'claude'. Start + bewaakt:
#   - de Claude-API (server.js)         altijd
#   - de Drive-sync (rclone bisync)     altijd
#   - de git-repo van de GHAWA-site     alleen als GIT_REPO_URL is gezet
#   - de Telegram-bot (telegram-claude-bot.js)  alleen als TG_TOKEN is gezet
# Zo kun je de in-container bot uitzetten door simpelweg TG_TOKEN leeg te maken
# in Studio (geen rebuild nodig) zodra n8n de Telegram-route overneemt.
#
# Extra env voor de GHAWA-website-workspace (in Olares Studio in te stellen):
#   GIT_REPO_URL   bv. https://github.com/Socev/ghawa-site.git  (leeg = git-deel uit)
#   GITHUB_PAT     fine-grained PAT met contents:write op ALLEEN die repo
#   REPO_DIR       /opt/data/repo (default)
#   GIT_USER_NAME / GIT_USER_EMAIL  identiteit voor commits
set -u
export HOME=/opt/data
export PATH=/usr/local/bin:/opt/data/bin:$PATH
VAULT="${VAULT_DIR:-/opt/data/AI_SecondBrain}"
REPO_DIR="${REPO_DIR:-/opt/data/repo}"
REPO_URL="${GIT_REPO_URL:-}"
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

# ── Git-workspace (GHAWA-site) — alleen actief als GIT_REPO_URL is gezet ─────
setup_git(){
  git config --global user.name  "${GIT_USER_NAME:-GHAWA Website Bot}"
  git config --global user.email "${GIT_USER_EMAIL:-bot@ghawa.org}"
  git config --global credential.helper store
  git config --global init.defaultBranch main
  git config --global pull.rebase false
  git config --global --add safe.directory "$REPO_DIR"
  if [ -n "${GITHUB_PAT:-}" ]; then
    # https-push zonder interactieve login
    printf "https://x-access-token:%s@github.com\n" "$GITHUB_PAT" > "$HOME/.git-credentials"
    chmod 600 "$HOME/.git-credentials"
  else
    log "LET OP: GITHUB_PAT leeg — pushen naar GitHub zal mislukken."
  fi
}

# Klonen (1e keer) of bijwerken. Raakt NOOIT een vuile werkmap aan: als Claude
# midden in een wijziging zit, doen we alleen 'fetch' en verder niets.
sync_repo(){
  if [ ! -d "$REPO_DIR/.git" ]; then
    log "repo klonen -> $REPO_DIR"
    git clone "$REPO_URL" "$REPO_DIR" >> "$BIN/git.log" 2>&1 || { log "clone MISLUKT (zie git.log)"; return; }
  fi
  cd "$REPO_DIR" || return
  git fetch origin >> "$BIN/git.log" 2>&1
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    log "repo heeft niet-gecommitte wijzigingen — sync overgeslagen"
    return
  fi
  # productie-branch up to date houden
  git checkout main >> "$BIN/git.log" 2>&1 && git pull origin main >> "$BIN/git.log" 2>&1
  # staging-branch garanderen (bestaat op remote? checkout; anders aanmaken vanaf main)
  if git ls-remote --exit-code --heads origin staging >/dev/null 2>&1; then
    git checkout staging >> "$BIN/git.log" 2>&1 && git pull origin staging >> "$BIN/git.log" 2>&1
  else
    git checkout -B staging main >> "$BIN/git.log" 2>&1
    git push -u origin staging >> "$BIN/git.log" 2>&1 || log "kon staging-branch niet pushen (PAT?)"
  fi
  # node_modules warmhouden zodat 'npm run build' snel is
  if [ -f package.json ] && [ ! -d node_modules ]; then
    log "npm install (eenmalig, kan even duren)"
    npm install >> "$BIN/npm.log" 2>&1 || log "npm install gaf een fout (zie npm.log)"
  fi
  cd /opt/data || true
}

# setup-checks
rclone listremotes 2>/dev/null | grep -q "^gdrive:" || log "LET OP: rclone 'gdrive' ontbreekt — draai 'rclone config' als gebruiker claude."
[ -d /opt/data/.claude ] || log "LET OP: Claude nog niet ingelogd — draai 'claude' als gebruiker claude."

start_sync
if [ -n "$REPO_URL" ]; then
  mkdir -p "$REPO_DIR"
  setup_git
  sync_repo
else
  log "GIT_REPO_URL leeg: GHAWA-workspace uit."
fi
start_api
[ -n "${TG_TOKEN:-}" ] && start_bot || log "TG_TOKEN leeg: in-container bot uit (n8n verwacht)."

# supervisor
GIT_EVERY=300; last_git=$(date +%s)
while true; do
  kill -0 "$SYNC_PID" 2>/dev/null || { log "sync herstart"; start_sync; }
  kill -0 "$API_PID"  2>/dev/null || { log "api herstart";  start_api;  }
  if [ -n "${TG_TOKEN:-}" ]; then
    kill -0 "${BOT_PID:-0}" 2>/dev/null || { log "bot herstart"; start_bot; }
  fi
  if [ -n "$REPO_URL" ]; then
    now=$(date +%s)
    if [ $(( now - last_git )) -ge "$GIT_EVERY" ]; then sync_repo; last_git=$now; fi
  fi
  sleep 30
done
