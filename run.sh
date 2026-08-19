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
#   (GITHUB_PAT is per 19-8-2026 vervallen: de GHAWA-clone gebruikt een eigen
#    credentialbestand, zie GHAWA_CRED verderop)
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
# Het credentialbestand van de GHAWA-clone. Wordt hier NIET aangemaakt: de
# git-tokens vallen buiten de secretronde en staan dus (nog) niet in de RPC.
# Het bestand wordt met de hand gevuld uit het Vault-secret github_pat_ghawa_site.
GHAWA_CRED="${GHAWA_CRED:-/opt/data/.git-credentials-ghawa}"

setup_git(){
  git config --global user.name  "${GIT_USER_NAME:-GHAWA Website Bot}"
  git config --global user.email "${GIT_USER_EMAIL:-bot@ghawa.org}"
  git config --global init.defaultBranch main
  git config --global pull.rebase false
  git config --global --add safe.directory "$REPO_DIR"

  # GEEN globale credential.helper meer, en GEEN $HOME/.git-credentials.
  #
  # Wat hier stond schreef GITHUB_PAT naar $HOME/.git-credentials en zette een
  # GLOBALE `credential.helper store`. Twee problemen tegelijk:
  #   1. Elke git-repo op dit volume erfde die helper en las dus hetzelfde
  #      bestand - ook repo's die er niets mee te maken hebben. Op 18-8 kostte
  #      dat een dag: de socev.dev-token belandde in dat gedeelde bestand en was
  #      bij de eerstvolgende geauthenticeerde fetch weer overschreven.
  #   2. Het token stond in platte tekst op schijf, buiten elke kluis om.
  #
  # Nu krijgt elke repo zijn eigen bestand, en wordt de geerfde keten expliciet
  # gewist met de lege-waarde-truc: git probeert helpers op volgorde, dus zonder
  # die reset zou een globale helper alsnog winnen.
  # Residu van het oude mechanisme opruimen. De lege-helper-reset hieronder
  # maskeert de globale helper al, maar een token hoort niet als restant op
  # schijf te blijven staan - en een volgende beheerder moet niet alsnog op een
  # globale helper stuiten die er niet meer hoort te zijn.
  # HOME van claude is /opt/data (uit de passwd-databank), dus dit is
  # /opt/data/.git-credentials.
  git config --global --unset-all credential.helper 2>/dev/null || true
  rm -f "$HOME/.git-credentials"

  # ── Overbrugging: image :29 op chart 0.0.38 ────────────────────────────────
  # Op een VERS volume bestaat GHAWA_CRED nog niet, en de git-tokens zitten niet
  # in de secret-RPC. Zonder deze regel zou de GHAWA-sync stilvallen bij precies
  # de combinatie die tussen twee uitrollen in bestaat: nieuw image, oude chart.
  # Zolang GITHUB_PAT er nog is, schrijven we het bestand daar eenmalig uit.
  # VERVALT met chart 0.0.40, wanneer GITHUB_PAT uit de podconfiguratie gaat.
  if [ ! -f "$GHAWA_CRED" ] && [ -n "${GITHUB_PAT:-}" ]; then
    printf "https://x-access-token:%s@github.com\n" "$GITHUB_PAT" > "$GHAWA_CRED"
    chmod 600 "$GHAWA_CRED"
    log "overbrugging: credentialbestand uit GITHUB_PAT geschreven; vervalt met chart 0.0.40"
  fi

  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" config --local --unset-all credential.helper 2>/dev/null || true
    git -C "$REPO_DIR" config --local --add credential.helper ''
    git -C "$REPO_DIR" config --local --add credential.helper "store --file=$GHAWA_CRED"
  fi

  if [ ! -f "$GHAWA_CRED" ]; then
    log "LET OP: $GHAWA_CRED ontbreekt - GHAWA-git werkt niet tot dat bestand er is (vullen uit Vault-secret github_pat_ghawa_site)."
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
    # Vers volume zonder credentialbestand: NIET proberen te klonen. Een private
    # repo geeft dan een 403 die als authenticatiefout in git.log belandt, en de
    # lus zou dat elke 300 s herhalen. Overslaan met een duidelijke regel is
    # eerlijker: de rest van de pod werkt gewoon door.
    if [ ! -f "$GHAWA_CRED" ]; then
      log "GHAWA-clone overgeslagen: $GHAWA_CRED ontbreekt op dit volume."
      return
    fi
    log "repo klonen -> $REPO_DIR"
    gitkop "clone $REPO_URL -> $REPO_DIR"
    git clone -c credential.helper= -c "credential.helper=store --file=$GHAWA_CRED" \
      "$REPO_URL" "$REPO_DIR" >> "$BIN/git.log" 2>&1 || { log "clone MISLUKT (zie git.log)"; return; }
    # Meteen na de clone de repo-eigen helper vastleggen.
    setup_git
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
