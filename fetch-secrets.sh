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
VERWACHT="claude_code_oauth_token supabase_mcp_token n8n_mcp_token todoist_mcp_token agent_webhook_secret"

# ── Overgangssituatie: chart nog oud, geen bootstrapgeheim ──────────────────
# Chart 0.0.40 zet POD_BOOTSTRAP_SECRET. Tot die er is, draait de pod nog op de
# losse env-variabelen. Die situatie mag NIET falen, anders ligt de pod plat op
# een chart die verder prima werkt.
if [ -z "${POD_BOOTSTRAP_SECRET:-}" ]; then
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    log "POD_BOOTSTRAP_SECRET leeg, maar CLAUDE_CODE_OAUTH_TOKEN staat in de omgeving -> overgangsmodus, doorstarten op de bestaande env"
    export SECRETS_GELADEN=""
    exec "$@"
  fi
  log "FATAAL: geen POD_BOOTSTRAP_SECRET en geen CLAUDE_CODE_OAUTH_TOKEN in de omgeving - de pod kan niet authenticeren"
  exit 78
fi

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  log "FATAAL: SUPABASE_URL of SUPABASE_ANON_KEY ontbreekt, terwijl er wel een bootstrapgeheim is"
  exit 78
fi

# ── De RPC aanroepen, met oplopende wachttijd ───────────────────────────────
ANTWOORD=""
for ((i = 1; i <= POGINGEN; i++)); do
  ANTWOORD="$(curl -sS -m 20 -X POST "${SUPABASE_URL}${RPC_PAD}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -H 'Content-Type: application/json' \
    -d "{\"p_bootstrap\":\"${POD_BOOTSTRAP_SECRET}\"}" 2>/dev/null)" || ANTWOORD=""

  if printf '%s' "$ANTWOORD" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    log "RPC geslaagd bij poging $i"
    break
  fi

  ANTWOORD=""
  if [ "$i" -lt "$POGINGEN" ]; then
    W=${WACHT[$((i - 1))]}
    log "RPC mislukt (poging $i van $POGINGEN), opnieuw over ${W}s"
    sleep "$W"
  else
    log "RPC mislukt na $POGINGEN pogingen"
  fi
done

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
  log "FATAAL: claude_code_oauth_token ontbreekt na $POGINGEN pogingen - afsluiten zodat kubelet herstart"
  exit 78
fi

for N in $VERWACHT; do
  ENVNAAM="$(printf '%s' "$N" | tr '[:lower:]' '[:upper:]')"
  if [ -z "$(printenv "$ENVNAAM" || true)" ]; then
    log "ONTBREEKT: $N (\$$ENVNAAM) - de pod start wel, dit onderdeel werkt niet"
  fi
done

# Namenlijst voor /health. Uitsluitend namen.
export SECRETS_GELADEN="$GELADEN"
log "klaar; via de RPC geladen: ${GELADEN:-(geen)}"

exec "$@"
