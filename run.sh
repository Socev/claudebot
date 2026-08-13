#!/usr/bin/env bash
# run.sh — draait als gebruiker 'claude'. Start + bewaakt:
#   - de Claude-API (server.js)         altijd
#   - de vault-sync (rclone bisync)     altijd
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
#
# Extra env voor de sync (defaults = het oude gedrag, claudebot merkt niets):
#   SYNC_ENABLED   1 (default) of 0
#   SYNC_REMOTE    gdrive (default)      — rclone-remote
#   SYNC_PATH      AI_SecondBrain (default) — pad binnen die remote
#   SYNC_INTERVAL  300 (default)         — seconden tussen twee rondes
#   SYNC_INIT      0 (default)           — 1 = eenmalig een resync toestaan
set -u
export HOME=/opt/data
export PATH=/usr/local/bin:/opt/data/bin:$PATH
VAULT="${VAULT_DIR:-/opt/data/AI_SecondBrain}"
REPO_DIR="${REPO_DIR:-/opt/data/repo}"
REPO_URL="${GIT_REPO_URL:-}"
BIN=/opt/data/bin
mkdir -p "$BIN" "$VAULT"
log(){ echo "$(date '+%F %T') $*"; }

# ── Sync-instellingen ───────────────────────────────────────────────────────
SYNC_ENABLED="${SYNC_ENABLED:-1}"
SYNC_REMOTE="${SYNC_REMOTE:-gdrive}"
SYNC_PATH="${SYNC_PATH:-AI_SecondBrain}"
SYNC_INTERVAL="${SYNC_INTERVAL:-300}"
SYNC_INIT="${SYNC_INIT:-0}"
BRON="${SYNC_REMOTE}:${SYNC_PATH}"
MARKER="$VAULT/.sync-id"
SYNCLOG="$BIN/bisync.log"

# De bisync-toestand blijft op de standaardplek ($HOME/.cache/rclone/bisync).
# HOME is /opt/data en dat is het persistent volume, dus die overleeft een
# podherstart. Verplaatsen zou de bestaande vergelijkingslijsten ongeldig maken
# en daarmee juist een resync afdwingen — precies wat we willen vermijden.

# ── Grendel: een vault die bij een andere bron hoort, koppelen we niet om ────
# Alleen een variabele is te zwak: één verkeerd gezette env en de speelpod trekt
# het echte brein binnen. De koppeling ligt daarom vast in de vault zelf.
if [ -f "$MARKER" ]; then
  HUIDIG="$(cat "$MARKER" 2>/dev/null || echo '')"
  if [ "$HUIDIG" != "$BRON" ]; then
    log "SYNC STOP: $VAULT hoort bij '$HUIDIG', niet bij '$BRON'. Sync uitgezet."
    log "Klopt dit wel? Verwijder dan met de hand $MARKER."
    SYNC_ENABLED=0
  fi
fi

sync_ronde(){
  rclone bisync "$BRON" "$VAULT" \
    --create-empty-src-dirs --conflict-resolve newer >> "$SYNCLOG" 2>&1
}

sync_lus(){
  # Uitgezet? Dan blijft dit proces wél leven, anders herstart de supervisor
  # hem elke 30 seconden opnieuw en loopt het log vol.
  if [ "$SYNC_ENABLED" != "1" ]; then
    echo "$(date) sync staat uit (SYNC_ENABLED=$SYNC_ENABLED)" >> "$SYNCLOG"
    while true; do sleep 3600; done
  fi

  while ! rclone listremotes 2>/dev/null | grep -q "^${SYNC_REMOTE}:"; do
    echo "$(date) WACHT: rclone-remote ${SYNC_REMOTE} nog niet geconfigureerd" >> "$SYNCLOG"
    sleep "$SYNC_INTERVAL"
  done

  # Allereerste koppeling: bisync heeft nog geen vergelijkingslijsten en weigert.
  # Die eerste --resync kan bestanden overschrijven, dus die doen we NOOIT
  # vanzelf. Zet SYNC_INIT=1 als je hem bewust wilt.
  if [ "$SYNC_INIT" = "1" ] && [ ! -f "$MARKER" ]; then
    echo "$(date) eerste koppeling met $BRON — resync, nieuwste bestand wint" >> "$SYNCLOG"
    if rclone bisync "$BRON" "$VAULT" --resync --resync-mode newer \
         --create-empty-src-dirs >> "$SYNCLOG" 2>&1; then
      printf '%s' "$BRON" > "$MARKER"
      echo "$(date) koppeling vastgelegd in .sync-id" >> "$SYNCLOG"
    else
      echo "$(date) FOUT: eerste resync mislukt — vault ongemoeid gelaten" >> "$SYNCLOG"
    fi
  fi

  FOUTEN=0
  while true; do
    if sync_ronde; then
      FOUTEN=0
      # Na een geslaagde ronde de koppeling vastleggen als dat nog niet gebeurd is.
      # Zo krijgt ook een bestaande pod de grendel zonder dat iemand iets doet.
      [ -f "$MARKER" ] || printf '%s' "$BRON" > "$MARKER"
    else
      FOUTEN=$((FOUTEN + 1))
      echo "$(date) bisync-ronde mislukt ($FOUTEN achter elkaar)" >> "$SYNCLOG"
      # GEEN automatische --resync meer. De oude terugval deed dat bij ELKE fout,
      # ook bij een netwerkhapering of een verweesde lock, en liet dan Path1
      # winnen. Dat wist stilletjes werk. Herstel dat gegevens kan verwijderen
      # hoort mensenwerk te zijn.
      if [ "$FOUTEN" -ge 3 ]; then
        echo "$(date) LET OP: drie mislukte rondes. Waarschijnlijk is met de hand" >> "$SYNCLOG"
        echo "$(date)   rclone bisync \"$BRON\" \"$VAULT\" --resync --resync-mode newer" >> "$SYNCLOG"
        echo "$(date) nodig. Draai die eerst met --dry-run." >> "$SYNCLOG"
      fi
    fi
    sleep "$SYNC_INTERVAL"
  done
}

start_sync(){
  sync_lus &
  SYNC_PID=$!; log "sync gestart (pid $SYNC_PID) — $BRON <-> $VAULT, elke ${SYNC_INTERVAL}s"
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
rclone listremotes 2>/dev/null | grep -q "^${SYNC_REMOTE}:" || log "LET OP: rclone-remote '${SYNC_REMOTE}' ontbreekt — draai 'rclone config' als gebruiker claude."
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
