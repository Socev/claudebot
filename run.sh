#!/usr/bin/env bash
# run.sh — draait als gebruiker 'claude'. Start + bewaakt:
#   - de Claude-API (server.js)         altijd
#   - de vault-sync (rclone bisync)     altijd, per ronde alleen met schakelbestand /opt/data/bisync.json {"aan": true} (wv1308)
#   - Syncthing (vault ↔ Davids apparaten) alleen met schakelaar /opt/data/syncthing.json aan (wv1277)
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
# Naast SYNC_ENABLED (env, alleen bij de start gelezen) telt sinds wv1308 het schakelbestand /opt/data/bisync.json, per ronde
# gelezen: alleen {"aan": true} laat bisync draaien (zie "Schakelbestand bisync" hieronder).
set -u
# Uid-scheiding (wv699, 21-10-2026): wat de pod-gebruiker voortaan maakt, is privé (0600/0700), ook /tmp/agy-mcp_config.json
# e.d. In de vault en de memory-map telt de standaard-ACL (die geeft socev en claude rwX), niet deze umask. Supervisor en
# server.js erven hem (supervisor.js zet hem ook zelf).
umask 077
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
# Syncfilter (wv813, 22-10-2026): scripts en Windows-code gaan niet naar Drive (en dus Davids pc), en komen er ook niet
# vandaan; .claude/ en .obsidian/ in de vaultwortel wel (socev kan daar niet schrijven). Waarom en wat: bisync-filter.txt.
# ELKE bisync hieronder krijgt dit filter mee, ook de resyncs: een ronde zonder filter zou een geblokkeerd bestand alsnog
# overzetten. Werkt het filter niet (bisync-filter-toets.sh), dan synct de lus niet (fail-closed).
# Vast in het image (root), niet via de omgeving te verleggen (Fable wv813 #12).
SYNC_FILTER=/app/bisync-filter.txt
SYNC_FILTER_TOETS=/app/bisync-filter-toets.sh
FILTER=( --filter-from "$SYNC_FILTER" )
# De uitzondering + /.claude/** en + /.obsidian/** in het filter leunt op de ACL: socev mag daar niets schrijven. Vóór elke
# ronde nagaan (± 10 ms); kan socev het toch, dan deze ronde niet (Fable wv813 #6). De na-ronde zet de ACL terug.
codeplek_dicht(){
  local d
  for d in "$VAULT/.claude" "$VAULT/.obsidian"; do
    [ -e "$d" ] || continue
    getfacl -R -P -p "$d" 2>/dev/null | grep -qE '^(default:)?(user:socev:|other::)(rw|-w)' && return 1
    [ -z "$(find -P "$d" \( -user socev -o -perm /o=w \) -print -quit 2>/dev/null)" ] || return 1
  done
  return 0
}

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

# Gedeelde grendel tussen de synclus en de vault-snapshot. rclone heeft zijn
# eigen --max-lock, maar dat beschermt alleen bisync tegen bisync. De tar mag
# nooit lopen terwijl er gesynct wordt: dan tar je een half doorgevoerde ronde
# en heb je een backup van een tussentoestand.
VAULT_LOCK="$BIN/.vault.lock"

# ── Rolwachter (uitwijk stap 3, 6-10-2026) ──────────────────────────────────
# Er is altijd maar één actieve kant (olares | vps). server.js leest die elke minuut uit Supabase en schrijft het
# rolbestand; alleen een VERS bestand met rol=primair laat bisync en de GHAWA-sync draaien. Ontbreekt het, is het
# oud of zegt het iets anders: niets naar gedeelde opslag (fail-closed). Bouwplan uitwijk §4.2.
ROL_BESTAND="${ROL_BESTAND:-$BIN/uitwijk-rol}"
ROL_MAX_LEEFTIJD="${ROL_MAX_LEEFTIJD:-300}"
rol_veld(){ sed -n "s/^$1=//p" "$ROL_BESTAND" 2>/dev/null | head -1; }
rol_primair(){
  local r t g n
  r="$(rol_veld rol)"; t="$(rol_veld tijd)"; g="$(rol_veld gelezen)"; n="$(date +%s)"
  [ "$r" = "primair" ] || return 1
  case "$t" in (*[!0-9]*|'') return 1 ;; esac
  case "$g" in (*[!0-9]*|'') return 1 ;; esac
  [ $(( n - t )) -le "$ROL_MAX_LEEFTIJD" ] && [ $(( n - g )) -le "$ROL_MAX_LEEFTIJD" ]
}
# Bij elke podstart: een rolbestand van vóór deze start (bv. vlak voor een crash) telt niet (Fable-review #1).
rol_reset_podstart(){
  printf 'rol=passief\nkant=%s\ntijd=%s\ngelezen=0\nreden=podstart\n' "${SOCEV_KANT:-olares}" "$(date +%s)" > "$ROL_BESTAND.tmp" \
    && mv -f "$ROL_BESTAND.tmp" "$ROL_BESTAND"
}

# ── Schakelbestand bisync (wv1308, 26-10-2026; ontwerp OVIS Intake § 11.4 stap 0, Fable MOET #1) ─────────────────────────────
# WAAROM. Sinds 26-10 schrijft geen n8n-koppeling meer via Drive in de vault; de vault gaat via Syncthing naar Davids apparaten en
# de R230. bisync met Drive gaat daarom uit (Davids punt 9: Drive alleen nog voor de versleutelde back-up). Uitzetten moet zonder
# image of chart kunnen, en een ONTBREKEND of kapot schakelbestand mag bisync nooit aanzetten: een (zelfherstel-)resync tegen
# een bevroren Drive-map haalt gewiste bestanden terug en Syncthing duwt ze dan naar alle apparaten.
# HOE. Vóór elke ronde, vóór de zelfherstel-resync en vóór de eerste koppeling, en nog eens ONDER de vault-grendel:
#   - onderhoudsstand van de vault (wv1271, onderhoud.js; Second Brain 2.0 § 7.1a): staat ONDERHOUD_BESTAND er als gewoon
#     bestand van deze gebruiker en zegt hij niet {"aan": false}, dan geen ronde (onderhoud.js houdt dan ook de grendel vast);
#   - BISYNC_SCHAKELAAR: alleen een gewoon bestand van deze gebruiker met {"aan": true} = ronde. {"aan": false} = uit;
#     ontbreekt, onleesbaar, andere eigenaar of geen true/false = ook geen ronde (fail-closed).
# Geen ronde = één regel (UIT of ONDERHOUD) per uur en bij elke wisseling in bisync.log; geen "ronde mislukt", dus geen zelfherstel.
# /health.sync toont de stand (velden uit en schakelaar, server.js syncInfo).
BISYNC_SCHAKELAAR="${BISYNC_SCHAKELAAR:-/opt/data/bisync.json}"
ONDERHOUD_BESTAND="${ONDERHOUD_BESTAND:-/opt/data/onderhoudsstand.json}"
GEEN_RONDE=99   # afspraak tussen de subshell onder de grendel en de lus; rclone zelf geeft 0–10
# bisync_stand: aan | uit | ontbreekt | ongeldig | onderhoud (altijd één woord; bij twijfel nooit 'aan').
bisync_stand(){
  local s
  s="$(python3 -I -c '
import json,os,stat,sys
sch,oh=sys.argv[1:]; uid=os.getuid()
def lees(p):
    try: s=os.lstat(p)
    except FileNotFoundError: return "weg",None
    except OSError: return "fout",None
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=uid: return "vreemd",None
    try:
        with open(p,encoding="utf-8") as f: return "ok",json.load(f)
    except Exception: return "fout",None
w,m=lees(oh)
if w=="fout" or (w=="ok" and not (isinstance(m,dict) and m.get("aan") is False)): print("onderhoud"); sys.exit()
w,m=lees(sch)
if w=="weg": print("ontbreekt")
elif w!="ok" or not isinstance(m,dict) or not isinstance(m.get("aan"),bool): print("ongeldig")
else: print("aan" if m["aan"] else "uit")
' "$BISYNC_SCHAKELAAR" "$ONDERHOUD_BESTAND" 2>/dev/null)"
  case "$s" in (aan|uit|ontbreekt|ongeldig|onderhoud) echo "$s" ;; (*) echo ongeldig ;; esac
}
BS_VORIG=""; BS_GEMELD=0
# bisync_niet <stand>: de regel in bisync.log, bij een wisseling meteen en verder hooguit één per uur.
bisync_niet(){
  local nu; nu=$(date +%s)
  [ "$1" = "$BS_VORIG" ] && [ $(( nu - BS_GEMELD )) -lt 3600 ] && return 0
  case "$1" in
    uit)       echo "$(date '+%F %T') UIT: bisync staat uit (schakelbestand $BISYNC_SCHAKELAAR zegt aan=false) - geen ronde" >> "$SYNCLOG" ;;
    ontbreekt) echo "$(date '+%F %T') UIT: schakelbestand $BISYNC_SCHAKELAAR ontbreekt - geen ronde (aanzetten: {\"aan\": true})" >> "$SYNCLOG" ;;
    onderhoud) echo "$(date '+%F %T') ONDERHOUD: onderhoudsstand van de vault staat aan ($ONDERHOUD_BESTAND) - geen ronde" >> "$SYNCLOG" ;;
    *)         echo "$(date '+%F %T') UIT: schakelbestand $BISYNC_SCHAKELAAR ongeldig (geen gewoon bestand van $(id -un) met {\"aan\": true|false}) - geen ronde" >> "$SYNCLOG" ;;
  esac
  BS_VORIG="$1"; BS_GEMELD=$nu
}
# bisync_mag: 0 als er een ronde mag; anders de regel en 1. Na een periode zonder ronde één regel AAN.
bisync_mag(){
  local s; s="$(bisync_stand)"
  if [ "$s" = aan ]; then
    [ -n "$BS_VORIG" ] && [ "$BS_VORIG" != aan ] && echo "$(date '+%F %T') AAN: bisync hervat (schakelbestand aan, geen onderhoudsstand)" >> "$SYNCLOG"
    BS_VORIG=aan; return 0
  fi
  bisync_niet "$s"; return 1
}

# sync_ronde: 0 = RONDE OK, $GEEN_RONDE = onder de grendel bleek bisync uit of in onderhoud (geen fout), anders mislukt.
# De stand wordt ONDER de grendel opnieuw gelezen: wie hem tussen de controle en de grendel uitzet (of de onderhoudsstand die
# de grendel pakt), krijgt daarna geen ronde meer achteraan (wv1308).
sync_ronde(){
  local rc
  ( flock 9 || exit 1
    [ "$(bisync_stand)" = aan ] || exit "$GEEN_RONDE"
    rclone bisync "$BRON" "$VAULT" "${FILTER[@]}" \
       --create-empty-src-dirs --conflict-resolve newer \
       --resilient --recover --max-lock 2m >> "$SYNCLOG" 2>&1 ) 9>>"$VAULT_LOCK"
  rc=$?
  if [ "$rc" = 0 ]; then
    echo "$(date '+%F %T') RONDE OK" >> "$SYNCLOG"
    return 0
  fi
  return "$rc"
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
  # Schakelbestand en onderhoudsstand ook hier, en de resync onder dezelfde grendel als sync_ronde (wv1308; wv1271 Fable ZOU 5).
  bisync_mag || return 1
  echo "$(date '+%F %T') ZELFHERSTEL: resync met --resync-mode newer (nieuwste wint, niets wordt verwijderd)" >> "$SYNCLOG"
  local rc
  ( flock 9 || exit 1
    [ "$(bisync_stand)" = aan ] || exit "$GEEN_RONDE"
    rclone bisync "$BRON" "$VAULT" "${FILTER[@]}" \
       --resync --resync-mode newer --create-empty-src-dirs >> "$SYNCLOG" 2>&1 ) 9>>"$VAULT_LOCK"
  rc=$?
  if [ "$rc" = "$GEEN_RONDE" ]; then
    echo "$(date '+%F %T') ZELFHERSTEL niet gedaan: bisync bleek onder de grendel uit of in onderhoud" >> "$SYNCLOG"
    return 1
  fi
  if [ "$rc" = 0 ]; then
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

  # Filter eerst toetsen (wv813): een rclone-filter dat niet past, laat stil alles door. Faalt de toets, dan geen bisync
  # (zoals hierboven: proces blijft leven); de stilte valt op in bisync.log en bij de syncwachters.
  if ! FT="$(bash "$SYNC_FILTER_TOETS" "$SYNC_FILTER" /app/socev-rechten.sh 2>&1)"; then
    echo "$(date '+%F %T') SYNC STOP: syncfilter $SYNC_FILTER werkt niet - geen bisync tot een image met een goed filter" >> "$SYNCLOG"
    printf '%s\n' "$FT" | head -20 >> "$SYNCLOG"
    # Hoorbaar (Fable wv813 #5): alleen bij een podstart, dus hooguit één bericht per start; best-effort.
    [ -r /opt/data/mk-scripts/bericht.py ] && timeout 60 python3 /opt/data/mk-scripts/bericht.py --klasse normaal \
      "Vault-sync staat stil sinds de herstart: het syncfilter van dit image werkt niet (bisync.log, SYNC STOP). Er is niets weg. Niet terug naar een image zonder filter: eerst nalopen (bouwplan uid-scheiding § 8)." \
      >/dev/null 2>&1 || true
    while true; do sleep 3600; done
  fi
  echo "$(date '+%F %T') $FT" >> "$SYNCLOG"

  while ! rclone listremotes 2>/dev/null | grep -q "^${SYNC_REMOTE}:"; do
    echo "$(date) WACHT: rclone-remote ${SYNC_REMOTE} nog niet geconfigureerd" >> "$SYNCLOG"
    sleep "$SYNC_INTERVAL"
  done

  # Allereerste koppeling: bisync heeft nog geen vergelijkingslijsten en weigert.
  # Die eerste --resync kan bestanden overschrijven, dus die doen we NOOIT
  # vanzelf. Zet SYNC_INIT=1 als je hem bewust wilt.
  if [ "$SYNC_INIT" = "1" ] && [ ! -f "$MARKER" ] && codeplek_dicht && bisync_mag; then
    echo "$(date) eerste koppeling met $BRON — resync, nieuwste bestand wint" >> "$SYNCLOG"
    if ( flock 9 || exit 1; [ "$(bisync_stand)" = aan ] || exit "$GEEN_RONDE"
         rclone bisync "$BRON" "$VAULT" "${FILTER[@]}" --resync --resync-mode newer \
         --create-empty-src-dirs >> "$SYNCLOG" 2>&1 ) 9>>"$VAULT_LOCK"; then
      printf '%s' "$BRON" > "$MARKER"
      echo "$(date) koppeling vastgelegd in .sync-id" >> "$SYNCLOG"
    else
      echo "$(date) FOUT: eerste resync mislukt — vault ongemoeid gelaten" >> "$SYNCLOG"
    fi
  fi

  FOUTEN=0; ROL_VORIG=""; ROL_START="$(date +%s)"; ROL_GEMELD=0
  while true; do
    if ! rol_primair; then
      if [ "$ROL_VORIG" != "passief" ]; then
        echo "$(date '+%F %T') PASSIEF: bisync overgeslagen (rol=$(rol_veld rol), reden: $(rol_veld reden))" >> "$SYNCLOG"
        ROL_VORIG=passief
      fi
      if [ "$ROL_GEMELD" = "0" ] && [ "$(rol_veld reden)" = "podstart" ] && [ $(( $(date +%s) - ROL_START )) -ge 600 ]; then
        echo "$(date '+%F %T') LET OP: na 10 min schrijft niemand het rolbestand (release zonder rolwachter?) - bisync blijft stil" >> "$SYNCLOG"
        ROL_GEMELD=1
      fi
      sleep 30; continue
    fi
    [ "$ROL_VORIG" = "passief" ] && echo "$(date '+%F %T') PRIMAIR: bisync hervat" >> "$SYNCLOG"
    ROL_VORIG=primair
    # Schakelbestand en onderhoudsstand (wv1308): geen ronde, geen fout, geen zelfherstel.
    if ! bisync_mag; then sleep "$SYNC_INTERVAL"; continue; fi
    # Grendel vóór élke bisync, ook het zelfherstel (Fable-natoets wv813 #1): kan socev in .claude/.obsidian schrijven, dan
    # deze ronde niet; geen "ronde mislukt" (dat zou zelfherstel starten), wel elke keer een regel, en RONDE OK blijft uit.
    if ! codeplek_dicht; then
      echo "$(date '+%F %T') LET OP: socev kan schrijven in .claude/ of .obsidian/ van de vault - ronde overgeslagen (syncfilter wv813)" >> "$SYNCLOG"
      sleep "$SYNC_INTERVAL"; continue
    fi
    sync_ronde; RC=$?
    if [ "$RC" = 0 ]; then
      FOUTEN=0
      # Na een geslaagde ronde de koppeling vastleggen als dat nog niet gebeurd is.
      # Zo krijgt ook een bestaande pod de grendel zonder dat iemand iets doet.
      [ -f "$MARKER" ] || printf '%s' "$BRON" > "$MARKER"
    elif [ "$RC" = "$GEEN_RONDE" ]; then
      bisync_mag || true   # de regel UIT/ONDERHOUD; geen fout en geen zelfherstel
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
        echo "$(date) Handmatig: rclone bisync \"$BRON\" \"$VAULT\" --filter-from $SYNC_FILTER --resync --resync-mode newer (eerst --dry-run)" >> "$SYNCLOG"
      fi
    fi
    sleep "$SYNC_INTERVAL"
  done
}

# ── Uid-scheiding (wv699): ACL en masker elke 5 minuten ─────────────────────────
# rclone, cp -p en editors zetten soms zelf een modus; dan wordt het ACL-masker krapper en kan socev een vaultbestand niet
# meer schrijven (Fable wv689 #4); een bestand dat met mv van buiten binnenkomt heeft helemaal geen ACL. Elke 5 minuten
# (de bisync-cadans, maar los van de rol) krijgt wat veranderde zijn ACL terug, en worden .claude/.obsidian, de vault-wortel
# en bisync.log nagelopen. Eens per dag de volledige ronde. Alles als claude (dit script); fouten stoppen de lus nooit.
SOCEV_RECHTEN=/app/socev-rechten.sh
SOCEV_RECHTEN_LOG="$BIN/socev-rechten.log"
socev_rechten(){
  [ -f "$SOCEV_RECHTEN" ] && id socev >/dev/null 2>&1 || return 0
  if [ -f "$SOCEV_RECHTEN_LOG" ] && [ "$(stat -c %s "$SOCEV_RECHTEN_LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    mv -f "$SOCEV_RECHTEN_LOG" "$SOCEV_RECHTEN_LOG.1"
  fi
  bash "$SOCEV_RECHTEN" "$1" >> "$SOCEV_RECHTEN_LOG" 2>&1 || true
}
SOCEV_NA_LAATST=0
socev_na_ronde_indien_nodig(){
  local nu; nu=$(date +%s)
  [ $(( nu - SOCEV_NA_LAATST )) -ge 300 ] || return 0
  SOCEV_NA_LAATST=$nu
  socev_rechten na-ronde
}
SOCEV_VOL_MARKER="$BIN/laatste-socev-rechten"
socev_vol_indien_nodig(){
  local vandaag; vandaag="$(date '+%Y-%m-%d')"
  [ "$(cat "$SOCEV_VOL_MARKER" 2>/dev/null)" = "$vandaag" ] && return 0
  # Niet midden in de nachtsessies van 02:30-04:30; de dagronde mag daarna.
  [ "$(date +%H)" -ge 5 ] || return 0
  socev_rechten vol   # schrijft zelf de marker
}

# ── Syncthing (wv1277, 25-10-2026; Davids plan "Opslag en sync", akkoord 25-10 14:21) ───────────────────────────────────────────
# WAAROM. De vault gaat sinds 25-10 ook via Syncthing naar de Synology thuis, de laptop en de werk-pc: daar is het een gewone,
# snelle map in plaats van Drive-streaming. bisync met Drive blijft draaien (n8n schrijft nog op Drive, fase-0-bouwplan § 2.2).
# HOE. Binary en home op het volume (/opt/data/syncthing; apparaatsleutel = het apparaat-ID dat Davids apparaten kennen), proces
# als kind van dit script, GUI/REST alleen op 127.0.0.1 met wachtwoord, geen statistiek, geen zelf-update (vaste sha256 hieronder;
# bijwerken = nieuwe binary + nieuwe sha256 in een image). Alleen op de primaire kant (rolbestand, zoals bisync).
# Schakelaar /opt/data/syncthing.json {"aan": true}: ontbreekt of uit = Syncthing gestopt; bisync merkt daar niets van.
# POORT (fail-closed): vóór elke start (1) binary met de vaste sha256, (2) de vault-.stignore is een symlink naar het filter in
# /app (root, alleen-lezen; socev kan de wortel en dat bestand niet schrijven), (3) syncthing-filter-toets.py groen: het filter
# laat weg wat bisync-filter.txt weglaat, op een proefboom én op een spiegel van de echte vaultnamen, (4) de config: GUI alleen
# 127.0.0.1 met wachtwoord, geen statistiek of zelf-update, geen automatisch accepteren of introducer, en de vaultmap met
# ignorePerms en zonder eigenaar/xattr-sync. Rood = niet starten, regel in syncthing-run.log en status.json, over een uur opnieuw.
# Tijdens het draaien: elke ronde (30 s) de symlink nagaan; anders meteen stoppen.
ST_DIR="${ST_DIR:-/opt/data/syncthing}"
ST_BIN="$ST_DIR/bin/syncthing"
ST_HOME="$ST_DIR/home"
ST_LOG="$ST_DIR/syncthing.log"
ST_RUNLOG="$ST_DIR/syncthing-run.log"
ST_STATUS="$ST_DIR/status.json"
ST_SCHAKELAAR="${ST_SCHAKELAAR:-/opt/data/syncthing.json}"
ST_IGNORE=/app/syncthing-stignore.txt
ST_TOETS=/app/syncthing-filter-toets.py
ST_MAP_ID=socev-vault
ST_SHA256=f5c12679f2bad1b5eff619ba7b04ead1a457e439a1e55dc640d4d8995d7f4dbd   # syncthing v2.1.7 linux-amd64 (GitHub-release, 20-10-2026)
ST_PID=""; ST_VINGER=""; ST_VOLGENDE=0; ST_CRASH=0; ST_REDEN="nog niet gestart"; ST_POORT="niet gedraaid"; ST_GESTART=0
stlog(){
  if [ -f "$ST_RUNLOG" ] && [ "$(stat -c %s "$ST_RUNLOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then mv -f "$ST_RUNLOG" "$ST_RUNLOG.1"; fi
  printf '%s %s\n' "$(date '+%F %T')" "$1" >> "$ST_RUNLOG" 2>/dev/null
}
st_status(){
  [ -d "$ST_DIR" ] || return 0
  python3 -I - "$ST_STATUS" "${ST_PID:-}" "$ST_REDEN" "$ST_POORT" "$ST_GESTART" "$ST_CRASH" "$(st_schakelaar_aan && echo 1 || echo 0)" <<'PY' 2>/dev/null || true
import json,os,sys,time
p,pid,reden,poort,gestart,crash,aan=sys.argv[1:]
d={'aan':aan=='1','pid':int(pid) if pid else None,'loopt':bool(pid),'reden':reden,'poort':poort,
   'gestart':int(gestart) or None,'herstarts':int(crash),'tijd':int(time.time())}
with open(p+'.nieuw','w') as f: json.dump(d,f)
os.replace(p+'.nieuw',p)
PY
}
st_schakelaar_aan(){ [ -f "$ST_SCHAKELAAR" ] && python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("aan") is True else 1)' "$ST_SCHAKELAAR" 2>/dev/null; }
st_vault_in_config(){ grep -q "<folder id=\"$ST_MAP_ID\"" "$ST_HOME/config.xml" 2>/dev/null; }
# De symlink vault/.stignore -> /app/syncthing-stignore.txt (atomisch neerzetten; de wortel is van claude, socev heeft r-x).
st_ignore_goed(){ [ -L "$VAULT/.stignore" ] && [ "$(readlink "$VAULT/.stignore")" = "$ST_IGNORE" ] && [ -r "$ST_IGNORE" ]; }
st_ignore_zet(){
  st_ignore_goed && return 0
  [ -r "$ST_IGNORE" ] || return 1
  ln -sfn "$ST_IGNORE" "$VAULT/.stignore.nieuw.$$" && mv -fT "$VAULT/.stignore.nieuw.$$" "$VAULT/.stignore" || { rm -f "$VAULT/.stignore.nieuw.$$"; return 1; }
  st_ignore_goed
}
# st_config_ok [vinger]: zonder argument de controle (exit 1 + reden); met 'vinger' een sha256 over wat er tijdens het draaien niet
# ongemerkt mag veranderen (apparaten, mappen met pad/type/delen, GUI, onveilige vlaggen). Elke ronde nagelopen (Fable wv1277 #3):
# wie de API-sleutel heeft (elk claude-proces) kan via REST een apparaat of map toevoegen; dan stopt Syncthing en gaat de volgende
# start weer door de poort.
st_config_ok(){
  python3 -I - "$ST_HOME/config.xml" "$ST_MAP_ID" "$VAULT" "${1:-}" <<'PY'
import sys,os,hashlib,xml.etree.ElementTree as ET
cfg,mid,vault,modus=sys.argv[1:]
r=ET.parse(cfg).getroot(); fout=[]
g=r.find('gui')
if modus=='vinger':
    v=[]
    for d in sorted(r.findall('device'),key=lambda d:d.get('id','')): v.append(('d',d.get('id'),d.get('introducer'),d.get('autoAcceptFolders')))
    for f in sorted(r.findall('folder'),key=lambda f:f.get('id','')):
        v.append(('f',f.get('id'),f.get('path'),f.get('type'),f.get('ignorePerms'),tuple(sorted(x.get('id','') for x in f.findall('device')))))
    if g is not None: v.append(('g',g.findtext('address'),g.findtext('user'),g.findtext('password'),g.findtext('insecureAdminAccess'),
                                g.findtext('insecureSkipHostcheck'),g.get('enabled')))
    print(hashlib.sha256(repr(v).encode()).hexdigest()); sys.exit(0)
if g is None or (g.findtext('address') or '').split(':')[0] not in ('127.0.0.1',): fout.append('GUI niet alleen op 127.0.0.1')
if g is not None and not (g.findtext('user') or '').strip(): fout.append('GUI zonder gebruiker')
if g is not None and not (g.findtext('password') or '').strip(): fout.append('GUI zonder wachtwoord')
for k in ('insecureAdminAccess','insecureSkipHostcheck','insecureAllowFrameLoading'):
    if g is not None and (g.findtext(k) or 'false').strip()=='true': fout.append('GUI: %s aan'%k)
o=r.find('options')
def opt(k): return (o.findtext(k) or '').strip() if o is not None else ''
if opt('urAccepted') not in ('-1',): fout.append('gebruiksstatistiek niet uit (urAccepted %s)'%opt('urAccepted'))
if opt('autoUpgradeIntervalH') not in ('0',): fout.append('zelf-update niet uit')
if opt('crashReportingEnabled')!='false': fout.append('crashrapporten niet uit')
for d in r.findall('device'):
    if d.get('autoAcceptFolders')=='true': fout.append('apparaat %s accepteert mappen automatisch'%d.get('id','')[:7])
    if d.get('introducer')=='true': fout.append('apparaat %s is introducer'%d.get('id','')[:7])
dd=r.find('defaults/device')
if dd is not None and dd.get('autoAcceptFolders')=='true': fout.append('standaardapparaat accepteert mappen automatisch')
rv=os.path.realpath(vault)
for f in r.findall('folder'):
    p=os.path.realpath(os.path.expanduser(f.get('path','')))
    if f.get('id')==mid:
        if p!=rv: fout.append('vaultmap wijst naar %s'%p)
        if f.get('ignorePerms')!='true': fout.append('vaultmap zonder ignorePerms')
        for k in ('syncOwnership','sendOwnership','syncXattrs','sendXattrs'):
            if (f.findtext(k) or 'false').strip()!='false': fout.append('vaultmap: %s aan'%k)
        if f.get('type') not in ('sendreceive','sendonly'): fout.append('vaultmap type %s'%f.get('type'))
    elif p==rv or p.startswith(rv+os.sep) or rv.startswith(p+os.sep):
        fout.append('map %s overlapt de vault'%f.get('id'))
if fout: print('; '.join(fout)); sys.exit(1)
PY
}
st_poort(){
  local uit
  [ -x "$ST_BIN" ] || { ST_POORT="rood: binary ontbreekt ($ST_BIN)"; return 1; }
  [ "$(sha256sum "$ST_BIN" 2>/dev/null | cut -d' ' -f1)" = "$ST_SHA256" ] || { ST_POORT="rood: binary heeft niet de vaste sha256"; return 1; }
  [ -r "$ST_IGNORE" ] && [ -r "$ST_TOETS" ] || { ST_POORT="rood: filter of toets ontbreekt in /app"; return 1; }
  [ -f "$ST_HOME/config.xml" ] || { ST_POORT="rood: geen config ($ST_HOME)"; return 1; }
  if st_vault_in_config; then
    st_ignore_zet || { ST_POORT="rood: kan vault/.stignore niet als symlink naar $ST_IGNORE zetten"; return 1; }
  fi
  # Op de achtergrond + wait (Fable wv1277 #4): een SIGTERM van Kubernetes wacht dan niet op de toets (± 7 s, grens 120 s).
  timeout 120 python3 -I "$ST_TOETS" --stignore "$ST_IGNORE" --bisync "$SYNC_FILTER" --rechten /app/socev-rechten.sh \
    --syncthing "$ST_BIN" --vault "$VAULT" --json "$ST_DIR/filtertoets.json" > "$ST_DIR/filtertoets.uit" 2>&1 &
  if ! wait $!; then
    ST_POORT="rood: filtertoets - $(tail -3 "$ST_DIR/filtertoets.uit" 2>/dev/null | tr '\n' ' ' | cut -c1-400)"; return 1
  fi
  stlog "$(tail -1 "$ST_DIR/filtertoets.uit" 2>/dev/null)"
  if ! uit="$(st_config_ok 2>&1)"; then ST_POORT="rood: config - $(printf '%s' "$uit" | cut -c1-300)"; return 1; fi
  ST_VINGER="$(st_config_ok vinger 2>/dev/null)"
  ST_POORT="groen $(date '+%F %T')"
  return 0
}
st_start(){
  local p
  for p in $(st_pids); do kill -KILL "$p" 2>/dev/null && stlog "rest van een Syncthing-proces opgeruimd vóór de start (pid $p)"; done
  ( STNOUPGRADE=1 STNORESTART=1 exec "$ST_BIN" serve --home="$ST_HOME" --no-browser --no-restart --no-upgrade \
      --log-file="$ST_LOG" --log-max-size=5000000 --log-max-old-files=2 >/dev/null 2>&1 ) &
  ST_PID=$!; ST_GESTART=$(date +%s); ST_REDEN="loopt"
  stlog "gestart (pid $ST_PID)"; log "syncthing gestart (pid $ST_PID)"
}
# Syncthing 2.x draait als monitor + kind (ook met --no-restart; Fable wv1277 #1): stoppen raakt beide, en vóór een start
# worden resten van een eerder proces op hetzelfde home opgeruimd (een verweesd kind houdt de databank vast en synct onbewaakt).
# Alleen processen die echt syncthing heten (comm) én dit home hebben: een shell met dezelfde tekst in zijn opdrachtregel blijft heel.
st_pids(){ local p; for p in $(pgrep -u "$(id -u)" -x syncthing 2>/dev/null); do
  tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null | grep -qxF -- "--home=$ST_HOME" && echo "$p"; done; }
st_stop(){
  local p kinderen
  if [ -n "$ST_PID" ]; then
    kinderen="$(pgrep -P "$ST_PID" 2>/dev/null | tr '\n' ' ')"
    kill -TERM "$ST_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$ST_PID" 2>/dev/null || break; sleep 0.5; done
    for p in $ST_PID $kinderen; do kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null; done
  fi
  for p in $(st_pids); do kill -KILL "$p" 2>/dev/null && stlog "rest van een Syncthing-proces opgeruimd (pid $p)"; done
  [ -n "$ST_PID" ] && { stlog "gestopt (pid $ST_PID): $1"; log "syncthing gestopt: $1"; }
  ST_PID=""; ST_REDEN="$1"
}
st_bewaak(){
  local nu wil=1 waarom=""
  nu=$(date +%s)
  if ! st_schakelaar_aan; then wil=0; waarom="schakelaar uit"; elif ! rol_primair; then wil=0; waarom="pod niet primair"; fi
  if [ -n "$ST_PID" ]; then
    if [ "$wil" = 0 ]; then st_stop "$waarom"
    elif ! kill -0 "$ST_PID" 2>/dev/null; then
      ST_CRASH=$((ST_CRASH + 1)); ST_PID=""; ST_REDEN="proces gestopt (herstart $ST_CRASH)"
      local wacht=$(( 60 * (1 << (ST_CRASH > 5 ? 5 : ST_CRASH)) )); [ "$wacht" -gt 1800 ] && wacht=1800
      ST_VOLGENDE=$(( nu + wacht )); stlog "proces weg; opnieuw na ${wacht}s"
    elif st_vault_in_config && ! st_ignore_goed; then
      st_stop "vault/.stignore is geen symlink meer naar het filter in /app"; ST_VOLGENDE=$(( nu + 60 ))
    elif ! st_config_ok >/dev/null 2>&1 || [ "$(st_config_ok vinger 2>/dev/null)" != "$ST_VINGER" ]; then
      st_stop "config veranderd tijdens het draaien (apparaat, map of GUI): opnieuw door de poort"; ST_VOLGENDE=$(( nu + 60 ))
    fi
  elif [ "$wil" = 1 ] && [ "$nu" -ge "$ST_VOLGENDE" ]; then
    if st_poort; then st_start
    else ST_REDEN="poort rood"; ST_VOLGENDE=$(( nu + 3600 )); stlog "$ST_POORT"; log "syncthing niet gestart: $ST_POORT"; fi
  elif [ "$wil" = 0 ]; then ST_REDEN="$waarom"
  fi
  st_status
}

start_sync(){
  sync_lus &
  SYNC_PID=$!; log "sync gestart (pid $SYNC_PID) — $BRON <-> $VAULT, elke ${SYNC_INTERVAL}s"
}
# De API draait sinds image :33 NIET meer rechtstreeks uit het image, maar als kind
# van de supervisor, vanaf /opt/data/app/current. Zo kan de code worden uitgerold
# zonder image-bouw, en kan de pod een mislukte release zelf terugzetten. Waarom een
# meebewegende image-tag is afgevallen: zie de kop van supervisor.js.
start_api(){
  node /app/supervisor.js >> "$BIN/api.log" 2>&1 &
  API_PID=$!; log "supervisor gestart (pid $API_PID) — API draait vanaf /opt/data/app/current"
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
[ -f "${CODEX_HOME:-/opt/data/.codex}/auth.json" ] || log "LET OP: Codex nog niet ingelogd — draai 'codex login --device-auth' als gebruiker claude (tweede brein blijft tot dan onbruikbaar; Claude draait gewoon)."

rol_reset_podstart
start_sync
if [ -n "$REPO_URL" ]; then
  mkdir -p "$REPO_DIR"
  setup_git
  # Bij de start is de rol nog niet gelezen (passief): de bewakerlus pakt de GHAWA-sync op zodra hij primair is.
  if rol_primair; then sync_repo; else log "GHAWA-sync wacht op rol primair (uitwijk-rolwachter)"; fi
else
  log "GIT_REPO_URL leeg: GHAWA-workspace uit."
fi
start_api
[ -n "${TG_TOKEN:-}" ] && start_bot || log "TG_TOKEN leeg: in-container bot uit (n8n verwacht)."

# ── Vault-snapshot ───────────────────────────────────────────────────────────
# Waarom dit bestaat: bisync is SYNCHRONISATIE, geen backup. Een verwijdering
# plant zich voort naar Drive, en dan is hij op beide kanten weg. Dit is de enige
# plek waar een oude toestand van de vault bewaard blijft.
BACKUP_DIR="${BACKUP_DIR:-/opt/data/backups}"
BACKUP_LOG="$BIN/backup.log"
BACKUP_MARKER="$BIN/laatste-vault-snapshot"
BACKUP_MAX_LOG=$((5 * 1024 * 1024))

blog(){
  # Rotatie in het schrijfpad, zoals api.log: eerst toetsen, dan schrijven.
  if [ -f "$BACKUP_LOG" ] && [ "$(stat -c %s "$BACKUP_LOG" 2>/dev/null || echo 0)" -gt "$BACKUP_MAX_LOG" ]; then
    mv -f "$BACKUP_LOG" "$BACKUP_LOG.1"
  fi
  printf '%s %s\n' "$(date '+%F %T')" "$1" >> "$BACKUP_LOG"
}

vault_snapshot(){
  mkdir -p "$BACKUP_DIR"
  local dag doel vaultkb vrijkb bestanden inhoud marge rc
  dag="$(date '+%Y-%m-%d')"
  doel="$BACKUP_DIR/vault-$dag.tgz"

  if [ -f "$doel" ]; then blog "snapshot van $dag bestaat al - overgeslagen"; return 0; fi

  # Ruimtecheck VOORAF. Een tar die halverwege op een volle schijf stukloopt
  # laat een onbruikbaar bestand achter en kan de pod meeslepen.
  vaultkb="$(du -sk "$VAULT" 2>/dev/null | awk '{print $1}')"
  vrijkb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2{print $4}')"
  if [ -z "$vaultkb" ] || [ -z "$vrijkb" ]; then
    blog "FOUT: kon vaultgrootte of vrije ruimte niet vaststellen - snapshot overgeslagen"
    return 1
  fi
  if [ "$vrijkb" -lt $(( vaultkb * 2 )) ]; then
    blog "FOUT: te weinig vrije ruimte (${vrijkb}K vrij, vault ${vaultkb}K, vereist 2x) - snapshot overgeslagen"
    return 1
  fi

  blog "start snapshot -> $doel (vault ${vaultkb}K, vrij ${vrijkb}K)"

  # Zelfde grendel als de synclus: nooit tarren tijdens een ronde.
  flock "$VAULT_LOCK" tar -czf "$doel" -C "$(dirname "$VAULT")" "$(basename "$VAULT")" 2>>"$BACKUP_LOG"
  rc=$?
  # tar geeft 1 bij "file changed as we read it". Dat is bij een levende vault
  # normaal en geen reden om de backup weg te gooien; 2 en hoger wel.
  if [ "$rc" -ge 2 ]; then
    blog "FOUT: tar gaf exitcode $rc - onbruikbaar bestand verwijderd"
    rm -f "$doel"
    return 1
  fi
  [ "$rc" -eq 1 ] && blog "let op: tar gaf 1 (bestand gewijzigd tijdens lezen) - normaal, backup behouden"

  # Inhoudscontrole: een tar die slaagt zegt niets over wat erin zit.
  bestanden="$(find "$VAULT" -type f | wc -l)"
  inhoud="$(tar -tzf "$doel" 2>/dev/null | wc -l)"
  marge=$(( bestanden / 50 ))            # 2 procent
  [ "$marge" -lt 5 ] && marge=5
  if [ "$inhoud" -lt $(( bestanden - marge )) ]; then
    blog "FOUT: inhoudscontrole faalt - $inhoud items in het archief tegen $bestanden bestanden in de vault (marge $marge); bestand verwijderd"
    rm -f "$doel"
    return 1
  fi
  blog "snapshot klaar: $(du -h "$doel" | awk '{print $1}'), $inhoud items (vault $bestanden bestanden)"

  vault_retentie
  printf '%s' "$dag" > "$BACKUP_MARKER"
  return 0
}

# Retentie: 14 dagelijkse + 8 wekelijkse (zondag) + 6 maandelijkse (de 1e).
# Een snapshot die aan een van de drie regels voldoet, blijft staan.
vault_retentie(){
  local nu bestand dag ts leeftijd dow dom bewaar verwijderd=0
  nu="$(date +%s)"
  for bestand in "$BACKUP_DIR"/vault-*.tgz; do
    [ -e "$bestand" ] || continue
    dag="$(basename "$bestand" .tgz | sed 's/^vault-//')"
    ts="$(date -d "$dag" +%s 2>/dev/null)" || continue
    leeftijd=$(( (nu - ts) / 86400 ))
    dow="$(date -d "$dag" +%u)"    # 7 = zondag
    dom="$(date -d "$dag" +%d)"
    bewaar=0
    [ "$leeftijd" -le 14 ] && bewaar=1
    [ "$dow" = "7" ] && [ "$leeftijd" -le 56 ] && bewaar=1
    [ "$dom" = "01" ] && [ "$leeftijd" -le 186 ] && bewaar=1
    if [ "$bewaar" -eq 0 ]; then
      rm -f "$bestand" && verwijderd=$((verwijderd + 1))
    fi
  done
  [ "$verwijderd" -gt 0 ] && blog "retentie: $verwijderd oude snapshot(s) verwijderd"
  return 0
}

# Eenmaal per dag, niet bij elke lus-iteratie: het stempelbestand houdt bij
# welke dag er al gedraaid is.
vault_snapshot_indien_nodig(){
  local vandaag gedaan
  vandaag="$(date '+%Y-%m-%d')"
  gedaan="$(cat "$BACKUP_MARKER" 2>/dev/null || echo '')"
  [ "$gedaan" = "$vandaag" ] && return 0
  vault_snapshot || blog "snapshot van $vandaag niet gelukt - morgen opnieuw"
  return 0
}

# ── Netjes stoppen ──────────────────────────────────────────────────────────
# Kubernetes stuurt SIGTERM naar PID 1, en dat is dit script (entrypoint.sh,
# fetch-secrets.sh en gosu exec'en allemaal, dus er komt geen extra proces tussen).
# Zonder trap negeert bash het signaal tijdens `sleep` en wordt de pod na de
# genadetijd hard afgeschoten — midden in een lopende job of een vault-snapshot.
# Het signaal gaat daarom door naar de supervisor, die het op zijn beurt aan het
# kind doorgeeft. Pas als die weg is, stopt dit script.
STOPPEN=0
afsluiten(){
  [ "$STOPPEN" = "1" ] && return
  STOPPEN=1
  log "SIGTERM ontvangen — doorgeven aan de supervisor (pid ${API_PID:-onbekend})"
  [ -n "${ST_PID:-}" ] && st_stop "podstop (SIGTERM)"   # wv1277: Syncthing netjes laten afsluiten (index op het volume)
  [ -n "${API_PID:-}" ] && kill -TERM "$API_PID" 2>/dev/null
  for _ in $(seq 1 40); do
    kill -0 "${API_PID:-0}" 2>/dev/null || { log "supervisor is gestopt — run.sh stopt"; exit 0; }
    sleep 0.5
  done
  log "supervisor stopt niet binnen 20 s — alsnog stoppen"
  exit 0
}
trap afsluiten TERM INT

# bewaker
GIT_EVERY=300; last_git=$(date +%s)
while true; do
  [ "$STOPPEN" = "1" ] && break
  kill -0 "$SYNC_PID" 2>/dev/null || { log "sync herstart"; start_sync; }
  kill -0 "$API_PID"  2>/dev/null || { log "api herstart";  start_api;  }
  if [ -n "${TG_TOKEN:-}" ]; then
    kill -0 "${BOT_PID:-0}" 2>/dev/null || { log "bot herstart"; start_bot; }
  fi
  if [ -n "$REPO_URL" ]; then
    now=$(date +%s)
    if [ $(( now - last_git )) -ge "$GIT_EVERY" ]; then rol_primair && sync_repo; last_git=$now; fi
  fi
  vault_snapshot_indien_nodig
  socev_vol_indien_nodig
  socev_na_ronde_indien_nodig
  st_bewaak   # wv1277: Syncthing (schakelaar, rol, poort, symlink)
  sleep 30
done
