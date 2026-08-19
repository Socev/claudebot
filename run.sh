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

# Zelfheling, in twee treden:
#   1. Elke ronde draait met --resilient --recover --max-lock: daarmee heelt
#      bisync zelf de meeste breuken (afgebroken ronde, verweesd slot) zonder
#      dat er gegevens op het spel staan.
#   2. Is de toestand toch onherstelbaar kapot ("Must run --resync"), dan doet
#      de lus zelf ÉÉN resync per etmaal, met --resync-mode newer: per bestand
#      wint het nieuwste, ongeacht de kant, en er wordt niets verwijderd. Het
#      enige risico is dat een net verwijderd bestand terugkomt — vervelend,
#      geen verlies. Vaker dan eens per etmaal duidt op een echt defect; dan
#      stopt de zelfheling en is het mensenwerk (en slaat de wachter alarm).
ZELFHERSTEL_MARKER="$BIN/laatste-zelfherstel"
SYNC_AUTO_RESYNC="${SYNC_AUTO_RESYNC:-1}"

sync_ronde(){
  if rclone bisync "$BRON" "$VAULT" \
       --create-empty-src-dirs --conflict-resolve newer \
       --resilient --recover --max-lock 2m >> "$SYNCLOG" 2>&1; then
    echo "$(date '+%F %T') RONDE OK" >> "$SYNCLOG"
    return 0
  fi
  return 1
}

zelfherstel(){
  # Alleen bij de specifieke "listings kwijt"-breuk, niet bij netwerkfouten.
  if ! tail -30 "$SYNCLOG" | grep -q 'Must run --resync'; then return 1; fi
  if [ "$SYNC_AUTO_RESYNC" != "1" ]; then
    echo "$(date '+%F %T') zelfherstel staat uit (SYNC_AUTO_RESYNC=$SYNC_AUTO_RESYNC)" >> "$SYNCLOG"
    return 1
  fi
  if [ -f "$ZELFHERSTEL_MARKER" ]; then
    LEEFTIJD=$(( $(date +%s) - $(stat -c %Y "$ZELFHERSTEL_MARKER" 2>/dev/null || echo 0) ))
    if [ "$LEEFTIJD" -lt 86400 ]; then
      echo "$(date '+%F %T') zelfherstel al gebruikt in de laatste 24 uur - mensenwerk nodig" >> "$SYNCLOG"
      return 1
    fi
  fi
  echo "$(date '+%F %T') ZELFHERSTEL: resync met --resync-mode newer (nieuwste wint, niets wordt verwijderd)" >> "$SYNCLOG"
  if rclone bisync "$BRON" "$VAULT" \
       --resync --resync-mode newer --create-empty-src-dirs >> "$SYNCLOG" 2>&1; then
    touch "$ZELFHERSTEL_MARKER"
    [ -f "$MARKER" ] || printf '%s' "$BRON" > "$MARKER"
    echo "$(date '+%F %T') ZELFHERSTEL geslaagd - sync loopt weer" >> "$SYNCLOG"
    echo "$(date '+%F %T') RONDE OK" >> "$SYNCLOG"
    return 0
  fi
  echo "$(date '+%F %T') ZELFHERSTEL mislukt - mensenwerk nodig" >> "$SYNCLOG"
  return 1
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
    elif zelfherstel; then
      FOUTEN=0
    else
      FOUTEN=$((FOUTEN + 1))
      echo "$(date) ronde mislukt ($FOUTEN achter elkaar)" >> "$SYNCLOG"
      # De oude blinde terugval (resync bij ELKE fout, Path1 wint) is weg.
      # Zelfheling gebeurt hierboven, gericht en begrensd. Komen we hier, dan
      # is het iets dat een mens moet zien — en dat meldt de wachter.
      if [ "$FOUTEN" -ge 3 ]; then
        echo "$(date) LET OP: drie mislukte rondes en zelfherstel kon of mocht niet." >> "$SYNCLOG"
        echo "$(date) Handmatig: rclone bisync \"$BRON\" \"$VAULT\" --resync --resync-mode newer (eerst --dry-run)" >> "$SYNCLOG"
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
  # LET OP: dit is een GLOBALE helper, dus elke git-repo op dit volume erft hem
  # en leest $HOME/.git-credentials - ook repo's die er niets mee te maken hebben.
  # Wil een repo zijn eigen inloggegeven, dan moet die de keten eerst wissen met
  # de lege-waarde-truc: git config --local --unset-all credential.helper, dan
  # --add credential.helper '' en pas daarna --add credential.helper 'store --file=...'.
  # Zonder die reset wint deze globale helper, want git probeert ze op volgorde.
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
  # git.log had geen enkele tijdstempel: 93 regels kale git-uitvoer waaruit niet
  # op te maken viel wanneer iets faalde of hoe vaak. Vandaar per schrijfmoment
  # een kopregel; de git-commando's zelf blijven ongemoeid.
  gitkop(){ printf '%s %s\n' "$(date '+%F %T')" "$1" >> "$BIN/git.log"; }
  # Rotatie: zonder grens groeit dit bestand ongemerkt door.
  if [ -f "$BIN/git.log" ] && [ "$(stat -c %s "$BIN/git.log" 2>/dev/null || echo 0)" -gt 2097152 ]; then
    mv -f "$BIN/git.log" "$BIN/git.log.1"
    gitkop "== log geroteerd naar git.log.1 =="
  fi
  if [ ! -d "$REPO_DIR/.git" ]; then
    log "repo klonen -> $REPO_DIR"
    gitkop "clone $REPO_URL -> $REPO_DIR"
    git clone "$REPO_URL" "$REPO_DIR" >> "$BIN/git.log" 2>&1 || { log "clone MISLUKT (zie git.log)"; return; }
  fi
  cd "$REPO_DIR" || return
  gitkop "fetch origin"
  git fetch origin >> "$BIN/git.log" 2>&1
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    log "repo heeft niet-gecommitte wijzigingen — sync overgeslagen"
    return
  fi
  # productie-branch up to date houden
  gitkop "checkout main + pull origin main"
  git checkout main >> "$BIN/git.log" 2>&1 && git pull origin main >> "$BIN/git.log" 2>&1
  # staging-branch garanderen (bestaat op remote? checkout; anders aanmaken vanaf main)
  if git ls-remote --exit-code --heads origin staging >/dev/null 2>&1; then
    gitkop "checkout staging + pull origin staging"
    git checkout staging >> "$BIN/git.log" 2>&1 && git pull origin staging >> "$BIN/git.log" 2>&1
  else
    gitkop "staging bestaat niet op de remote: lokaal aanmaken vanaf main"
    git checkout -B staging main >> "$BIN/git.log" 2>&1
    gitkop "push -u origin staging"
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
