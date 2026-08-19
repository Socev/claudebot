#!/usr/bin/env bash
# uitrol.sh — zet een nieuwe release neer op /opt/data/app en laat de supervisor
# hem oppakken. Draait ALS 'claude' op de pod, aangeroepen door de uitrolworkflow.
#
# GEBRUIK:  /app/uitrol.sh <git-sha|branch>
#
# WAAROM DIT EEN SCRIPT IS EN GEEN REGEL IN EEN PROMPT. De uitrol bestaat uit
# symlink-chirurgie op een draaiende pod: `vorige` bijwerken, `current` omzetten,
# het kind herstarten. Dat als los commando door een taalmodel laten samenstellen
# is precies het soort handeling waarbij één ontbrekende `-n` bij `ln` een symlink
# IN de doelmap maakt in plaats van eroverheen — en dan wijst `current` nergens
# meer heen. Hier staat het één keer goed, getest, en de workflow roept het aan.
#
# WAT HET NIET DOET: beslissen of de nieuwe release goed is. Dat doet de
# boot-zelfcontrole van de supervisor, en die flipt zelf terug.
set -u

APP_ROOT="${APP_ROOT:-/opt/data/app}"
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
VORIGE="$APP_ROOT/vorige"
BRON_REPO="${UITROL_REPO:-/opt/data/claudebot-src}"
BEWAAR="${UITROL_BEWAAR:-4}"     # hoeveel releases blijven staan (incl. current + vorige)
LOG="${BIN_DIR:-/opt/data/bin}/uitrol.log"

# Alleen deze bestanden vormen een release. Bewust een expliciete lijst en geen
# `cp -r` van de hele repo: dan zouden .github, Dockerfile en losse testbestanden
# meeverhuizen naar een map die als applicatie wordt gedraaid.
RELEASE_BESTANDEN="server.js telegram-claude-bot.js telegram-reader.js koppel-telegram.js package.json"

log(){ printf '%s uitrol: %s\n' "$(date '+%F %T')" "$1" | tee -a "$LOG"; }
fout(){ log "FOUT: $1"; exit 1; }

REF="${1:-}"
[ -n "$REF" ] || fout "geen git-sha of branch meegegeven"

command -v git >/dev/null 2>&1 || fout "git ontbreekt"
[ -d "$BRON_REPO/.git" ] || fout "geen git-repo op $BRON_REPO"

mkdir -p "$RELEASES" "$(dirname "$LOG")"

# ── 1. ophalen ──────────────────────────────────────────────────────────────
log "ophalen uit $BRON_REPO"
git -C "$BRON_REPO" fetch --quiet origin || fout "git fetch mislukt"

SHA="$(git -C "$BRON_REPO" rev-parse --verify --quiet "${REF}^{commit}" \
       || git -C "$BRON_REPO" rev-parse --verify --quiet "origin/${REF}^{commit}")" \
  || fout "kan $REF niet oplossen naar een commit"
KORT="${SHA:0:12}"
DOEL="$RELEASES/$KORT"

# ── 2. release neerzetten ───────────────────────────────────────────────────
# Eerst in een tijdelijke map bouwen en daarna hernoemen: een half uitgepakte
# release mag nooit onder een naam staan waar `current` naar kan gaan wijzen.
if [ -f "$DOEL/server.js" ]; then
  log "release $KORT staat er al - opnieuw gebruiken"
else
  TMP="$DOEL.bezig.$$"
  rm -rf "$TMP"; mkdir -p "$TMP"
  for b in $RELEASE_BESTANDEN; do
    git -C "$BRON_REPO" show "$SHA:$b" > "$TMP/$b" 2>/dev/null || fout "$b ontbreekt in commit $KORT"
  done
  [ -s "$TMP/server.js" ] || fout "server.js is leeg in commit $KORT"
  node --check "$TMP/server.js" || fout "server.js van $KORT komt de syntaxcontrole niet door"
  mv "$TMP" "$DOEL"
  log "release $KORT klaargezet"
fi

# ── 3. omzetten ─────────────────────────────────────────────────────────────
HUIDIG="$(readlink "$CURRENT" 2>/dev/null || echo '')"
if [ "$HUIDIG" = "releases/$KORT" ]; then
  log "current wijst al naar $KORT - niets om te doen"
  exit 0
fi

# `vorige` wijst hierna naar wat NU draait: dat is het vangnet van de supervisor.
if [ -n "$HUIDIG" ]; then
  ln -sfn "$HUIDIG" "$VORIGE.nieuw" && mv -Tf "$VORIGE.nieuw" "$VORIGE" || fout "kon vorige niet zetten"
  log "vorige -> $HUIDIG"
fi
ln -sfn "releases/$KORT" "$CURRENT.nieuw" && mv -Tf "$CURRENT.nieuw" "$CURRENT" || fout "kon current niet omzetten"
log "current -> releases/$KORT"

# ── 4. kind herstarten ──────────────────────────────────────────────────────
# De supervisor start het kind vanzelf opnieuw op als het stopt, en doet dan zijn
# boot-zelfcontrole. We stoppen dus alleen het kind; de supervisor doet de rest,
# inclusief de terugflip als de nieuwe release niet gezond opkomt.
PIDS="$(pgrep -f "node .*/app/releases/.*/server\.js" || true)"
if [ -n "$PIDS" ]; then
  log "kind stoppen (pid $(echo "$PIDS" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill -TERM $PIDS 2>/dev/null || true
else
  log "geen draaiend kind gevonden - de supervisor start er zelf een"
fi

# ── 5. opruimen ─────────────────────────────────────────────────────────────
# current en vorige blijven altijd staan; de rest op ouderdom.
HOUD_A="$(basename "$(readlink "$CURRENT" 2>/dev/null || echo x)")"
HOUD_B="$(basename "$(readlink "$VORIGE" 2>/dev/null || echo x)")"
n=0
for d in $(ls -1dt "$RELEASES"/*/ 2>/dev/null); do
  naam="$(basename "$d")"
  [ "$naam" = "$HOUD_A" ] && continue
  [ "$naam" = "$HOUD_B" ] && continue
  n=$((n + 1))
  [ "$n" -lt "$BEWAAR" ] && continue
  rm -rf "$d" && log "oude release opgeruimd: $naam"
done

log "klaar - uitgerold naar $KORT (de supervisor controleert nu zelf of hij gezond opkomt)"
