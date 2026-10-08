#!/usr/bin/env bash
# Toetst (8-10-2026, uitwijk stap 6d): de kant in fetch-secrets.sh.
#   - kant vps: cloudflare_tunnel_token_olares gaat uit de omgeving (en uit SECRETS_GELADEN); N8N_MCP_TOKEN en
#     N8N_API_KEY komen uit UITWIJK_* in plaats van uit de kluis, of blijven leeg als die ontbreken.
#   - kant olares (ook zonder SOCEV_KANT): niets verandert; UITWIJK_* wordt genegeerd en weggehaald.
#   - ongeldige kant: afsluiten met 78, vóór de kluis wordt aangeroepen.
# Draait fetch-secrets.sh met `env -i` (de echte podomgeving gaat NIET mee) tegen een nep-RPC op 127.0.0.1.
# Het commando achter fetch-secrets drukt alleen hashes en aanwezigheid af, nooit waarden.
set -u
cd "$(dirname "$0")/.." || exit 1
W="$(mktemp -d)"; trap 'kill "$NEP" 2>/dev/null; rm -rf "$W"' EXIT
POORT=$(node test/vrije-poort.js) || exit 1
fout=0
toets(){ if [ "$2" = 1 ]; then echo "GROEN $1"; else echo "ROOD  $1${3:+  [$3]}"; fout=$((fout + 1)); fi; }
h(){ printf '%s' "$1" | sha256sum | cut -c1-12; }

node -e '
const http = require("http"), fs = require("fs");
const n = (p) => fs.appendFileSync(process.argv[2], p + "\n");
http.createServer((q, s) => { let b = ""; q.on("data", (d) => b += d); q.on("end", () => { n("rpc");
  s.writeHead(200, { "content-type": "application/json" });
  s.end(JSON.stringify({ ok: true, secrets: [
    { naam: "claude_code_oauth_token", waarde: "nep-claude" },
    { naam: "n8n_mcp_token", waarde: "kluis-mcp" },
    { naam: "n8n_api_key", waarde: "kluis-api" },
    { naam: "cloudflare_tunnel_token_olares", waarde: "kluis-tunnel" } ] })); }); })
  .listen(parseInt(process.argv[1], 10), "127.0.0.1");
' "$POORT" "$W/rpc.log" & NEP=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$POORT/" && break; sleep 0.1; done

# Het commando na fetch-secrets: per naam AFWEZIG of de hash (12 tekens).
cat > "$W/druk.sh" <<'SH'
#!/bin/sh
for n in N8N_MCP_TOKEN N8N_API_KEY CLOUDFLARE_TUNNEL_TOKEN_OLARES UITWIJK_N8N_MCP_TOKEN UITWIJK_N8N_API_KEY POD_BOOTSTRAP_SECRET FETCH_SECRETS_KANT; do
  v="$(printenv "$n")"
  if [ -z "$v" ]; then echo "$n AFWEZIG"; else echo "$n $(printf '%s' "$v" | sha256sum | cut -c1-12)"; fi
done
echo "SECRETS_GELADEN $SECRETS_GELADEN"
SH
chmod +x "$W/druk.sh"

draai(){  # draai <naam> [VAR=waarde ...] — uitvoer naar $W/<naam>.uit, log naar $W/<naam>.log, exitcode in $W/<naam>.rc
  local naam="$1"; shift
  env -i PATH="$PATH" HOME="$W" POD_BOOTSTRAP_SECRET=nep-bootstrap SUPABASE_URL="http://127.0.0.1:$POORT" \
    SUPABASE_ANON_KEY=nep-anon "$@" bash ./fetch-secrets.sh "$W/druk.sh" > "$W/$naam.uit" 2> "$W/$naam.err"
  echo $? > "$W/$naam.rc"
  grep 'fetch-secrets:' "$W/$naam.uit" "$W/$naam.err" > "$W/$naam.log" 2>/dev/null
}
waarde(){ grep "^$2 " "$W/$1.uit" | cut -d' ' -f2; }

# 1. kant olares (geen SOCEV_KANT): kluiswaarden staan, UITWIJK_* genegeerd en weg
draai olares UITWIJK_N8N_MCP_TOKEN=vps-mcp
toets 'olares: start' "$([ "$(cat "$W/olares.rc")" = 0 ] && echo 1)"
toets 'olares: N8N_MCP_TOKEN = kluiswaarde' "$([ "$(waarde olares N8N_MCP_TOKEN)" = "$(h kluis-mcp)" ] && echo 1)"
toets 'olares: N8N_API_KEY = kluiswaarde' "$([ "$(waarde olares N8N_API_KEY)" = "$(h kluis-api)" ] && echo 1)"
toets 'olares: tunneltoken blijft' "$([ "$(waarde olares CLOUDFLARE_TUNNEL_TOKEN_OLARES)" = "$(h kluis-tunnel)" ] && echo 1)"
toets 'olares: UITWIJK_* weg' "$([ "$(waarde olares UITWIJK_N8N_MCP_TOKEN)" = AFWEZIG ] && echo 1)"
toets 'olares: genegeerd-regel' "$(grep -q 'kant olares: \$UITWIJK_N8N_MCP_TOKEN genegeerd' "$W/olares.log" && echo 1)"
toets 'olares: FETCH_SECRETS_KANT=olares' "$([ "$(waarde olares FETCH_SECRETS_KANT)" = "$(h olares)" ] && echo 1)"
toets 'olares: tunnelnaam in SECRETS_GELADEN' "$(grep -q '^SECRETS_GELADEN .*cloudflare_tunnel_token_olares' "$W/olares.uit" && echo 1)"
toets 'olares: bootstrapgeheim niet doorgegeven' "$([ "$(waarde olares POD_BOOTSTRAP_SECRET)" = AFWEZIG ] && echo 1)"

# 2. kant vps met override: VPS-waarden, tunneltoken weg (ook uit de namenlijst)
draai vps SOCEV_KANT=vps UITWIJK_N8N_MCP_TOKEN=vps-mcp UITWIJK_N8N_API_KEY=vps-api
toets 'vps: start' "$([ "$(cat "$W/vps.rc")" = 0 ] && echo 1)"
toets 'vps: N8N_MCP_TOKEN = VPS-waarde' "$([ "$(waarde vps N8N_MCP_TOKEN)" = "$(h vps-mcp)" ] && echo 1)"
toets 'vps: N8N_API_KEY = VPS-waarde' "$([ "$(waarde vps N8N_API_KEY)" = "$(h vps-api)" ] && echo 1)"
toets 'vps: tunneltoken weg' "$([ "$(waarde vps CLOUDFLARE_TUNNEL_TOKEN_OLARES)" = AFWEZIG ] && echo 1)"
toets 'vps: tunnelnaam niet in SECRETS_GELADEN' "$(grep -q '^SECRETS_GELADEN ' "$W/vps.uit" && ! grep -q '^SECRETS_GELADEN .*cloudflare_tunnel' "$W/vps.uit" && grep -q '^SECRETS_GELADEN .*n8n_mcp_token' "$W/vps.uit" && echo 1)"
toets 'vps: UITWIJK_* weg' "$([ "$(waarde vps UITWIJK_N8N_MCP_TOKEN)" = AFWEZIG ] && [ "$(waarde vps UITWIJK_N8N_API_KEY)" = AFWEZIG ] && echo 1)"
toets 'vps: FETCH_SECRETS_KANT=vps' "$([ "$(waarde vps FETCH_SECRETS_KANT)" = "$(h vps)" ] && echo 1)"

# 3. kant vps zonder override: geen Olares-waarden voor n8n
draai vps2 SOCEV_KANT=vps
toets 'vps zonder override: N8N_* leeg' "$([ "$(waarde vps2 N8N_MCP_TOKEN)" = AFWEZIG ] && [ "$(waarde vps2 N8N_API_KEY)" = AFWEZIG ] && echo 1)"
toets 'vps zonder override: n8n-namen niet in SECRETS_GELADEN' "$(grep -q '^SECRETS_GELADEN ' "$W/vps2.uit" && ! grep -qE '^SECRETS_GELADEN .*(n8n_mcp_token|n8n_api_key)' "$W/vps2.uit" && grep -q '^SECRETS_GELADEN .*claude_code_oauth_token' "$W/vps2.uit" && echo 1)"
toets 'vps zonder override: logregel ontbreekt' "$(grep -q 'UITWIJK_N8N_API_KEY ontbreekt' "$W/vps2.log" && echo 1)"

# 4. ongeldige kant: 78 en geen RPC-aanroep (lockout: niet eens aankloppen)
voor=$(wc -l < "$W/rpc.log")
draai fout SOCEV_KANT=VPS
toets 'ongeldige kant: exit 78' "$([ "$(cat "$W/fout.rc")" = 78 ] && echo 1)"
toets 'ongeldige kant: geen RPC-aanroep' "$([ "$(wc -l < "$W/rpc.log")" = "$voor" ] && echo 1)"
draai leeg SOCEV_KANT=
toets 'lege kant = olares' "$([ "$(waarde leeg FETCH_SECRETS_KANT)" = "$(h olares)" ] && echo 1)"

# 5. overgangsmodus (geen bootstrap) op vps: ook daar de kant
env -i PATH="$PATH" HOME="$W" SOCEV_KANT=vps CLAUDE_CODE_OAUTH_TOKEN=x CLOUDFLARE_TUNNEL_TOKEN_OLARES=kluis-tunnel \
  bash ./fetch-secrets.sh "$W/druk.sh" > "$W/over.uit" 2>&1
toets 'overgangsmodus vps: tunneltoken weg' "$([ "$(waarde over CLOUDFLARE_TUNNEL_TOKEN_OLARES)" = AFWEZIG ] && echo 1)"

# 6. geen waarde in enig log
lek=0
for v in kluis-mcp kluis-api kluis-tunnel vps-mcp vps-api nep-bootstrap nep-anon nep-claude; do
  cat "$W"/*.log "$W"/*.err "$W/over.uit" 2>/dev/null | grep -q -- "$v" && lek=1
done
toets 'geen waarde in de logregels' "$([ "$lek" = 0 ] && echo 1)"

echo; [ "$fout" = 0 ] && echo 'ALLES GROEN' || echo "$fout ROOD"
exit $([ "$fout" = 0 ] && echo 0 || echo 1)
