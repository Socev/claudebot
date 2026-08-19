#!/usr/bin/env bash
# fetch-secrets.sh — haalt de podsecrets op uit Supabase en geeft ze als
# omgevingsvariabelen door aan het commando dat erachter staat.
#
# GEBRUIK:  fetch-secrets.sh <commando> [argumenten...]
# In de keten:  exec /app/fetch-secrets.sh gosu claude /app/run.sh
#
# WAAROM EEN WRAPPER EN GEEN LOSS SCRIPT. Een script kan geen variabelen naar
# zijn ouder exporteren. Door het commando zelf te exec'en erven het serverproces
# en al zijn kinderen de omgeving rechtstreeks van dit proces. Dat is meteen de
# reden dat dit vóór `gosu` staat: gosu behoudt de omgeving (in tegenstelling tot
# `su -`, dat hem juist wist), dus wat hier wordt gezet overleeft de privilegedrop.
#
# WAT HIER NOOIT GEBEURT:
#   - niets naar schijf. Geen tijdelijk bestand, geen cache, geen .env.
#   - geen waarde in een logregel, in `ps` of in een foutmelding. Alleen NAMEN.
#
# ENV DIE DIT SCRIPT LEEST:
#   POD_BOOTSTRAP_SECRET  het bootstrapgeheim voor de RPC (leeg = overgangsmodus)
#   SUPABASE_URL          basis-URL van het Supabase-project
#   SUPABASE_ANON_KEY     anon-key; gaat mee als apikey én als Bearer-token
set -u

log() { printf '%s fetch-secrets: %s\n' "$(date '+%F %T')" "$1"; }

RPC_PAD="/rest/v1/rpc/sb_pod_secrets_lezen"
POGINGEN=3
WACHT=(2 5 15)

# snake_case uit de RPC -> HOOFDLETTERS als env-naam.
VERWACHT="claude_code_oauth_token supabase_mcp_token n8n_mcp_token todoist_mcp_token agent_webhook_secret telegram_api_id telegram_api_hash telegram_sessie"

# Namen die mogen ontbreken zonder dat er iets stuk is. telegram_sessie bestaat
# pas NA de eenmalige koppeling (koppel-telegram.js), en de twee api-gegevens
# pas zodra David ze in de kluis heeft gezet. Zonder deze lijst zou het opstartlog
# elke keer drie regels "dit onderdeel werkt niet" tonen voor een toestand die
# gewoon nog moet komen - en dan gaat iemand een storing zoeken die er niet is.
NOG_TE_KOPPELEN="telegram_api_id telegram_api_hash telegram_sessie"

# ── Overgangssituatie: chart nog oud, geen bootstrapgeheim ──────────────────
# Chart 0.0.40 zet POD_BOOTSTRAP_SECRET. Tot die er is, draait de pod nog op de
# losse env-variabelen. Die situatie mag NIET falen, anders ligt de pod plat op
# een chart die verder prima werkt.
if [ -z "${POD_BOOTSTRAP_SECRET:-}" ]; then
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    log "POD_BOOTSTRAP_SECRET leeg, maar CLAUDE_CODE_OAUTH_TOKEN staat in de omgeving -> overgangsmodus, doorstarten op de bestaande env"
    export SECRETS_GELADEN=""
    unset POD_BOOTSTRAP_SECRET SUPABASE_ANON_KEY   # zie de toelichting bij de laatste exec
    exec "$@"
  fi
  log "FATAAL: geen POD_BOOTSTRAP_SECRET en geen CLAUDE_CODE_OAUTH_TOKEN in de omgeving - de pod kan niet authenticeren"
  exit 78
fi

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  log "FATAAL: SUPABASE_URL of SUPABASE_ANON_KEY ontbreekt, terwijl er wel een bootstrapgeheim is"
  exit 78
fi

# ── De RPC aanroepen ────────────────────────────────────────────────────────
# De body wordt door node opgebouwd en via stdin aan curl gevoerd (-d @-). Twee
# redenen, allebei belangrijk:
#   1. JSON.stringify escapet correct bij ELKE tekenset. Een bootstrapgeheim met
#      een dubbele quote of een backslash erin sloopte de handgemaakte body.
#   2. Het geheim staat zo NIET in de commandoregel. Alles in /proc/PID/cmdline
#      is leesbaar voor elk proces van dezelfde gebruiker - en dit draait op een
#      pod waar ook opdrachten van buiten worden uitgevoerd.
bouw_body() {
  node -e 'process.stdout.write(JSON.stringify({ p_bootstrap: process.env.POD_BOOTSTRAP_SECRET || "" }))'
}

# Classificeert het antwoord: ok / geweigerd / onparseerbaar.
klasseer() {
  node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    if (j && j.ok === true) return process.stdout.write("ok");
    if (j && j.ok === false) return process.stdout.write("geweigerd");
    process.stdout.write("onparseerbaar");
  } catch (e) { process.stdout.write("onparseerbaar"); }
});
' 2>/dev/null
}

ANTWOORD=""
GEDAAN=0
for ((i = 1; i <= POGINGEN; i++)); do
  GEDAAN=$i
  RUW="$(bouw_body | curl -sS -m 20 -X POST "${SUPABASE_URL}${RPC_PAD}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -H 'Content-Type: application/json' \
    -d @- 2>/dev/null)"
  CURL_CODE=$?

  if [ "$CURL_CODE" -ne 0 ]; then
    KLASSE="transport"
  else
    KLASSE="$(printf '%s' "$RUW" | klasseer)"
  fi

  case "$KLASSE" in
    ok)
      ANTWOORD="$RUW"
      log "RPC geslaagd bij poging $i"
      break
      ;;
    geweigerd)
      # BEWUST GEEN HERKANSING. Een geldig antwoord met ok:false betekent dat het
      # bootstrapgeheim is afgewezen; nog twee keer aankloppen verandert daar
      # niets aan, maar voedt bij elke crashloop-start wel de lockout aan de
      # andere kant. Dan wordt zelfs een gecorrigeerde chart een uur geweigerd.
      log "bootstrap geweigerd door de RPC - geen herkansing"
      REDEN="bootstrap geweigerd"
      break
      ;;
    *)
      if [ "$i" -lt "$POGINGEN" ]; then
        W=${WACHT[$((i - 1))]}
        log "RPC onbereikbaar of onleesbaar antwoord (poging $i van $POGINGEN), opnieuw over ${W}s"
        sleep "$W"
      else
        log "RPC mislukt na $POGINGEN pogingen"
      fi
      ;;
  esac
done
RUW=""
REDEN="${REDEN:-}"

# ── Uitpakken. Waardes gaan base64 door de pijp, zodat ze nooit in een ──────
# ── logregel, foutmelding of terminalweergave kunnen belanden. ──────────────
GELADEN=""
if [ -n "$ANTWOORD" ]; then
  UITPAK="$(printf '%s' "$ANTWOORD" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    if (!j || j.ok !== true || !Array.isArray(j.secrets)) return;
    for (const g of j.secrets) {
      if (!g || typeof g.naam !== "string" || typeof g.waarde !== "string") continue;
      if (!/^[a-z0-9_]+$/.test(g.naam)) continue;           // geen rare namen doorlaten
      process.stdout.write(g.naam + " " + Buffer.from(g.waarde, "utf8").toString("base64") + "\n");
    }
  } catch (e) { /* stil: de foutmelding zou de body kunnen citeren */ }
});
' 2>/dev/null)"

  while read -r NAAM B64; do
    [ -n "${NAAM:-}" ] || continue
    case " $VERWACHT " in
      *" $NAAM "*) ;;
      *) log "onbekende naam uit de RPC overgeslagen: $NAAM"; continue ;;
    esac
    ENVNAAM="$(printf '%s' "$NAAM" | tr '[:lower:]' '[:upper:]')"
    WAARDE="$(printf '%s' "$B64" | base64 -d 2>/dev/null)"
    if [ -z "$WAARDE" ]; then
      log "lege waarde ontvangen voor $NAAM - niet gezet"
      continue
    fi
    export "$ENVNAAM=$WAARDE"
    GELADEN="${GELADEN:+$GELADEN,}$NAAM"
    log "geladen: $NAAM -> \$$ENVNAAM"
  done <<< "$UITPAK"
fi

# ── Gedifferentieerde degradatie ────────────────────────────────────────────
# Het Claude-token is de enige waar zonder de pod niets kan: geen /run, geen
# nachtketen, geen heartbeat. Ontbreekt die, dan moet de pod ZICHTBAAR ongezond
# zijn - non-zero afsluiten zodat kubelet met backoff herstart - en niet vaag
# ziek doordraaien. De rest is degradatie: wel starten, wel een logregel.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  # Het getal in deze regel is het WERKELIJKE aantal pogingen, niet de bovengrens:
  # bij een geweigerde bootstrap is dat er een, en dat moet het log ook zeggen.
  log "FATAAL: claude_code_oauth_token ontbreekt (${REDEN:-RPC leverde niets}, $GEDAAN poging(en)) - afsluiten zodat kubelet herstart"
  exit 78
fi

# Alleen het Claude-token is fataal (hierboven afgehandeld). Al het andere dat
# ontbreekt levert een logregel op en verder niets: de pod start gewoon door.
for N in $VERWACHT; do
  ENVNAAM="$(printf '%s' "$N" | tr '[:lower:]' '[:upper:]')"
  [ -n "$(printenv "$ENVNAAM" || true)" ] && continue
  case " $NOG_TE_KOPPELEN " in
    *" $N "*)
      log "nog niet gekoppeld: $N (\$$ENVNAAM) - Telegram-lezer is uit tot de koppeling is gedaan"
      ;;
    *)
      log "ONTBREEKT: $N (\$$ENVNAAM) - de pod start wel, dit onderdeel werkt niet"
      ;;
  esac
done

# Namenlijst voor /health. Uitsluitend namen.
export SECRETS_GELADEN="$GELADEN"
log "klaar; via de RPC geladen: ${GELADEN:-(geen)}"

# De sleutels tot de kluis gaan NIET mee de rest van de keten in. server.js en de
# jobs hebben ze niet nodig, en kubelet levert ze bij elke herstart opnieuw aan.
# Zonder deze regel kan iemand met /run-toegang ze uit /proc/self/environ vissen -
# en daarmee alle secrets opnieuw ophalen, wat elke rotatie zinloos maakt.
unset POD_BOOTSTRAP_SECRET SUPABASE_ANON_KEY

exec "$@"
