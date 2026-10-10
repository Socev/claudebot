#!/usr/bin/env bash
# uitrol.sh — zet een nieuwe release neer op /opt/data/app en laat de supervisor
# hem oppakken. Draait ALS 'claude' op de pod, aangeroepen door de uitrolworkflow.
#
# GEBRUIK:  /app/uitrol.sh <git-sha|branch>
#           omgeving: UITROL_NU=1 (niet wachten), UITROL_WACHT_MAX=<s> (standaard 1800),
#           UITROL_DROOG=1 (niet omzetten, voor toetsen), UITROL_MARKER=<pad> (standaard /opt/data/uitrol-wacht),
#           UITROL_NACONTROLE=0 (geen echt-nacontrole), UITROL_NACONTROLE_MAX=<s> (standaard 90), UITROL_BOX=<pad>
#           exit 1 = mislukt, ook als de nacontrole terugzette (wv358)
#
# WAAROM DIT EEN SCRIPT IS EN GEEN REGEL IN EEN PROMPT. De uitrol bestaat uit
# symlink-chirurgie op een draaiende pod: `vorige` bijwerken, `current` omzetten,
# het kind herstarten. Dat als los commando door een taalmodel laten samenstellen
# is precies het soort handeling waarbij één ontbrekende `-n` bij `ln` een symlink
# IN de doelmap maakt in plaats van eroverheen — en dan wijst `current` nergens
# meer heen. Hier staat het één keer goed, getest, en de workflow roept het aan.
#
# WAT HET NIET DOET: beslissen of de nieuwe release goed is. Dat doet de
# boot-zelfcontrole van de supervisor, en die flipt zelf terug. Eén uitzondering
# (wv358): een release die gezond opkomt maar in een wegwerpmap draait (/health
# server.echt false) ziet de supervisor niet; die zet stap 4b terug.
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

# Review-fix 5-9-2026 (vondst machinekamer): een branchnaam eerst op ORIGIN oplossen.
# De lokale branch 'main' van de kloon wordt door niets bijgewerkt; wie 'main' vroeg
# kreeg wat de kloon toevallig had, met 'release staat er al' als geruststelling -
# oude code, groen log. Een sha of tag blijft gewoon werken (tweede poging).
SHA="$(git -C "$BRON_REPO" rev-parse --verify --quiet "origin/${REF}^{commit}" \
       || git -C "$BRON_REPO" rev-parse --verify --quiet "${REF}^{commit}")" \
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

# ── 2b. wachten tot het rustig is (28-9-2026, akkoord David) ─────────────────
# Een herstart doodt elke lopende beurt en elk resultaat dat n8n nog niet ophaalde: het antwoord
# verdwijnt dan stil (27-9 22:42). Wacht daarom tot /health lopend.beurten, lopend.onopgehaald
# en agents.lopend alle drie 0 zijn. Hooguit UITROL_WACHT_MAX seconden (standaard 1800), daarna
# toch - met een logregel. UITROL_NU=1 slaat het wachten over (noodgeval).
#
# Uitrolmarker (7-10-2026, wv91, akkoord David): zolang dit script op stilte wacht, staat MARKER er. De
# werkvoorraad-tikker en POST /agent met een machinekamer:-label starten dan niets nieuws - anders raakt het
# wachten nooit leeg en drukt het na WACHT_MAX door over een lopende agent heen (7-10 19:26, wv79 afgebroken).
# Agents voor David starten gewoon. Elke wachtronde ververst de mtime; de pod negeert een marker die 5 min niet
# ververst is of waarvan het proces weg is (kill -9, containerherstart). De trap wist hem alleen als hij nog van
# DIT proces is: een tweede uitrol die hem intussen overnam, blijft beschermd (Fable-review wv91 #4, #5).
# De wikkels in /opt/data/mk-scripts (uitrol-na-agents.sh, uitrol-als-auto-stil.sh) zetten dezelfde marker met
# hun eigen pid en exec'en dit script: zelfde pid, dus de marker loopt naadloos door.
MARKER="${UITROL_MARKER:-/opt/data/uitrol-wacht}"
marker_zet(){ printf '{"sha":"%s","start_iso":"%s","pid":%s}\n' "$KORT" "${MARKER_START:=$(date -Iseconds)}" "$$" > "$MARKER.nieuw.$$" \
  && mv -f "$MARKER.nieuw.$$" "$MARKER"; }
marker_weg(){ rm -f "$MARKER.nieuw.$$"; grep -q "\"pid\":$$}" "$MARKER" 2>/dev/null && rm -f "$MARKER"; return 0; }
if [ "${UITROL_NU:-0}" != "1" ]; then
  marker_zet || log "LET OP: kon de uitrolmarker $MARKER niet zetten"
  trap marker_weg EXIT
  trap 'exit 130' INT TERM HUP
  WACHT_MAX="${UITROL_WACHT_MAX:-1800}"; GEWACHT=0; TOCH=0
  while :; do
    DRUK="$(curl -s -m 5 "http://127.0.0.1:${PORT:-8080}/health" | python3 -c 'import json,sys
try:
  j=json.load(sys.stdin); l=j.get("lopend") or {}; a=j.get("agents") or {}
  print(int(l.get("beurten",0))+int(l.get("onopgehaald",0))+int(a.get("lopend",0)))
except Exception: print(0)' 2>/dev/null || echo 0)"
    [ "${DRUK:-0}" = "0" ] && break
    if [ "$GEWACHT" -ge "$WACHT_MAX" ]; then log "LET OP: na ${GEWACHT}s nog ${DRUK} lopend - uitrol gaat toch door"; TOCH=1; break; fi
    if [ "$GEWACHT" = "0" ]; then log "wachten: ${DRUK} beurt(en)/resultaat(en)/agent(s) lopend"; fi
    sleep 10; GEWACHT=$((GEWACHT+10))
    marker_zet 2>/dev/null || true   # verversen; een overgenomen marker (tweede uitrol) wordt weer van ons - beide wachten
  done
  if [ "$GEWACHT" -gt 0 ] && [ "$TOCH" = "0" ]; then log "rustig na ${GEWACHT}s"; fi
fi

# UITROL_DROOG=1: alleen ophalen, klaarzetten en wachten (met marker), niet omzetten en niets herstarten. Voor toetsen.
if [ "${UITROL_DROOG:-0}" = "1" ]; then log "droog: gestopt na het wachten, niets omgezet"; exit 0; fi

# Gesprekken met het spraakkastje (socev-auto, 3-10-2026) tellen bewust NIET mee als blokkade: een hangend gesprek
# zou de uitrol 30 minuten ophouden. Wel een logregel, zodat een afgebroken gesprek te verklaren is.
TUN="$(curl -s -m 5 "http://127.0.0.1:${PORT:-8080}/health" | python3 -c 'import json,sys
try: print(int((json.load(sys.stdin).get("auto") or {}).get("tunnels",0)))
except Exception: print(0)' 2>/dev/null || echo 0)"
[ "${TUN:-0}" != "0" ] && log "LET OP: ${TUN} gesprek(ken) met het spraakkastje lopen; die breken af bij de herstart"

# ── 3. omzetten ─────────────────────────────────────────────────────────────
HUIDIG="$(readlink "$CURRENT" 2>/dev/null || echo '')"
VORIGE_OUD="$(readlink "$VORIGE" 2>/dev/null || echo '')"   # wv358: terug te zetten als de nacontrole terugzet
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
# Alleen kinderen onder DEZE releases-map (wv358): een toets met een eigen APP_ROOT raakt zo nooit het productiekind.
# Wat dit nog wel raakt: een proef die als `node /opt/data/app/releases/<sha>/server.js` op een andere poort draait.
PIDS="$(pgrep -f "node .*${RELEASES}/[^/]*/server\.js" || true)"
if [ -n "$PIDS" ]; then
  log "kind stoppen (pid $(echo "$PIDS" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill -TERM $PIDS 2>/dev/null || true
else
  log "geen draaiend kind gevonden - de supervisor start er zelf een"
fi

# ── 4b. nacontrole: draait de nieuwe release op de echte paden? (wv358, 10-10-2026) ──────────────────────
# Sinds wv349 valt server.js terug op een wegwerpmap (/tmp/socev-app-proef-<pid>) als realpath(__dirname) niet gelijk
# is aan realpath(RELEASE_DIR) (SERVER_ECHT). In productie betekent dat: verse Telegram-sessies, agents nooit afgerond,
# rolbestand niet ververst, app op lege data - terwijl /health gewoon ok zegt, dus de boot-zelfcontrole van de
# supervisor slaagt. Daarom hier: zodra /health de nieuwe versie toont, server.echt en app.echt lezen. Alleen een
# expliciete false telt (een oude release zonder veld is geen meting). False -> current terug naar HUIDIG, vorige
# terug naar wat hij was, het KORT-kind stoppen (de supervisor herstart vanaf HUIDIG mét boot-zelfcontrole), een rij
# in de machinekamer-box en exit 1. Niet bij een droge uitrol (stopt hierboven), zonder gestopt kind (geen supervisor,
# bijvoorbeeld een toets) of zonder HUIDIG (vers volume: niets om naar terug te gaan; de Werkvoorraad-tikker meldt het).
# De periodieke kant (podstart, image-wissel) bewaakt n8n AI - Werkvoorraad-tikker (knoop Echt-alarm?).
BOX="${UITROL_BOX:-/opt/data/AI_SecondBrain/00_Systeem/Meldingen/machinekamer.md}"
health_veld(){ curl -s -m 5 "http://127.0.0.1:${PORT:-8080}/health" | python3 -c 'import json,sys
try:
  j=json.load(sys.stdin); s=j.get("server") or {}; a=j.get("app") or {}
  e=[x.get("echt") for x in (s,a) if isinstance(x,dict) and "echt" in x]
  print(str(j.get("versie","")) + " " + ("nee" if False in e else ("ja" if True in e else "onbekend")))
except Exception: print("- onbekend")' 2>/dev/null || echo "- onbekend"; }
box_rij(){ [ -f "$BOX" ] || { log "LET OP: box $BOX bestaat niet - geen rij geschreven"; return 0; }
  python3 - "$BOX" "$1" "$2" "$3" "$4" <<'PYBOX' || log "LET OP: kon geen rij in de box schrijven"
import sys, datetime
p, titel, zag, status, kost = sys.argv[1:6]
s = open(p, encoding='utf-8').read()
i = s.find('**Formaat**')
if i < 0: sys.exit(1)
j = s.index('\n', i) + 1
nu = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
rij = ('\n## [log] %s — %s\n- status: %s\n- van: uitrol.sh (nacontrole wv358)\n- wat ik zag: %s\n'
       '- wat het David kost als het blijft liggen: %s\n'
       '- voorstel: oorzaak zoeken in /opt/data/bin/uitrol.log, supervisor.log en de release; niet opnieuw uitrollen voor het verklaard is.\n') % (nu, titel, status, zag, kost)
import os
tmp = os.path.join(os.path.dirname(p), '.' + os.path.basename(p) + '.uitrol.tmp')   # punt ervoor: Obsidian/rclone negeren hem
open(tmp, 'w', encoding='utf-8').write(s[:j] + rij + s[j:])
os.replace(tmp, p)
PYBOX
}
if [ "${UITROL_NACONTROLE:-1}" = "1" ] && [ -n "$PIDS" ] && [ -n "$HUIDIG" ]; then
  NC_MAX="${UITROL_NACONTROLE_MAX:-90}"; NC_TOT=$((SECONDS + NC_MAX)); STAND="- onbekend"
  while [ "$SECONDS" -lt "$NC_TOT" ]; do
    STAND="$(health_veld)"; [ "${STAND%% *}" = "$KORT" ] && break
    sleep 2
  done
  if [ "${STAND%% *}" != "$KORT" ]; then
    log "LET OP: nacontrole - /health toont na ${NC_MAX}s versie ${STAND%% *}, niet $KORT (trage start of terugflip door de supervisor; zie supervisor.log)"
  elif [ "${STAND#* }" = "ja" ]; then
    log "nacontrole: $KORT draait op de echte paden (echt: ja)"
  elif [ "${STAND#* }" != "nee" ]; then
    log "nacontrole: $KORT toont geen echt-veld (release van vóór wv349) - niet te toetsen"
  else
    log "FOUT: nacontrole - $KORT draait in een wegwerpmap (/health server.echt/app.echt false); terugzetten naar $HUIDIG"
    if [ "$(readlink "$CURRENT" 2>/dev/null)" != "releases/$KORT" ]; then
      log "current wijst al naar $(readlink "$CURRENT" 2>/dev/null) - de supervisor was ons voor; niets omgezet"
    else
      ln -sfn "$HUIDIG" "$CURRENT.nieuw" && mv -Tf "$CURRENT.nieuw" "$CURRENT" || fout "kon current niet terugzetten (current wijst nog naar $KORT)"
      log "current -> $HUIDIG (teruggezet)"
      if [ -n "$VORIGE_OUD" ] && [ -f "$APP_ROOT/$VORIGE_OUD/server.js" ]; then
        ln -sfn "$VORIGE_OUD" "$VORIGE.nieuw" && mv -Tf "$VORIGE.nieuw" "$VORIGE" && log "vorige -> $VORIGE_OUD (teruggezet)"
      else
        log "LET OP: vorige blijft $HUIDIG (de oude vorige '${VORIGE_OUD}' is er niet meer); de supervisor heeft dan geen terugvalrelease"
      fi
      KPIDS="$(pgrep -f "node .*${RELEASES}/${KORT}/server\.js" || true)"
      if [ -n "$KPIDS" ]; then
        log "kind van $KORT stoppen (pid $(echo "$KPIDS" | tr '\n' ' '))"
        # shellcheck disable=SC2086
        kill -TERM $KPIDS 2>/dev/null || true
      else
        log "geen kind van $KORT meer gevonden - de supervisor start vanaf $HUIDIG"
      fi
    fi
    TERUG="$(basename "$HUIDIG")"; NC_TOT=$((SECONDS + NC_MAX)); STAND="- onbekend"
    while [ "$SECONDS" -lt "$NC_TOT" ]; do
      STAND="$(health_veld)"; [ "${STAND%% *}" = "$TERUG" ] && break
      sleep 2
    done
    if [ "${STAND%% *}" != "$TERUG" ]; then UITSLAG="na ${NC_MAX}s draait versie ${STAND%% *}, niet $TERUG - zie supervisor.log"
    elif [ "${STAND#* }" = "nee" ]; then UITSLAG="ook $TERUG draait in een wegwerpmap: de oorzaak zit buiten de release (supervisor/image, RELEASE_DIR) - pod herstarten of image nakijken"
    else UITSLAG="$TERUG draait weer (echt: ${STAND#* })"; fi
    case "$UITSLAG" in
      "$TERUG draait weer"*) KOST="niets zolang $TERUG echt draait; de nieuwe code staat niet live." ;;
      *) KOST="veel: verse Telegram-sessies, agents worden niet afgerond, de app draait op lege data (de Werkvoorraad-tikker start niets en meldt het in de debug-bot)." ;;
    esac
    log "nacontrole: $UITSLAG"
    box_rij "Uitrol $KORT teruggezet: release draaide in een wegwerpmap (server.echt false)" \
      "uitrol.sh zette current naar releases/$KORT; /health gaf echt=false (realpath(__dirname) != realpath(RELEASE_DIR), zie server.js SERVER_ECHT). Teruggezet naar $HUIDIG. Uitslag: $UITSLAG." \
      "open — uitrol.sh nacontrole $(date '+%-d-%-m %H:%M')" "$KOST"
    exit 1
  fi
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
