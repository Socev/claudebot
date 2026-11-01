#!/usr/bin/env bash
# Toetst (wv2146, 1-11-2026): welke Supabase-sleutel fetch-secrets.sh naar rpc/sb_pod_secrets_lezen stuurt.
#   - standaard de publishable-constante uit het script (geen sleutel in de omgeving nodig);
#   - SUPABASE_PUBLISHABLE_KEY uit de omgeving wint van de constante;
#   - SUPABASE_ANON_KEY (legacy, nog in de chart) wordt genegeerd, tenzij SUPABASE_LEGACY_TERUG=1 (review wv2134 MOET 1);
#   - een verkeerd bootstrapgeheim: geweigerd, exit 78, precies één aanroep (geen lockout voeden) (review wv2134 MOET 2);
#   - geen van de sleutelnamen gaat mee naar het commando erachter, en geen waarde in het log.
# Draait met `env -i` tegen een nep-RPC op 127.0.0.1 die alleen hashes van de kopregels bijhoudt.
set -u
cd "$(dirname "$0")/.." || exit 1
W="$(mktemp -d)"; trap 'kill "$NEP" 2>/dev/null; rm -rf "$W"' EXIT
POORT=$(node test/vrije-poort.js) || exit 1
fout=0
toets(){ if [ "$2" = 1 ]; then echo "GROEN $1"; else echo "ROOD  $1${3:+  [$3]}"; fout=$((fout + 1)); fi; }
h(){ printf '%s' "$1" | sha256sum | cut -c1-12; }
CONST="$(sed -n "s/^SUPABASE_PUBLISHABLE_STANDAARD='\(.*\)'$/\1/p" fetch-secrets.sh)"
toets 'constante gevonden en van de vorm sb_publishable_' "$(case "$CONST" in sb_publishable_?*) echo 1;; esac)"

node -e '
const http = require("http"), fs = require("fs"), crypto = require("crypto");
const h = (v) => crypto.createHash("sha256").update(v || "").digest("hex").slice(0, 12);
http.createServer((q, s) => { let b = ""; q.on("data", (d) => b += d); q.on("end", () => {
  let p = ""; try { p = JSON.parse(b).p_bootstrap; } catch (e) {}
  const bearer = (q.headers.authorization || "").replace(/^Bearer /, "");
  fs.appendFileSync(process.argv[2], h(q.headers.apikey) + " " + h(bearer) + "\n");
  s.writeHead(200, { "content-type": "application/json" });
  if (p !== "nep-bootstrap") return s.end(JSON.stringify({ ok: false }));
  s.end(JSON.stringify({ ok: true, secrets: [ { naam: "claude_code_oauth_token", waarde: "nep-claude" }, { naam: "n8n_mcp_token", waarde: "kluis-mcp" } ] })); }); })
  .listen(parseInt(process.argv[1], 10), "127.0.0.1");
' "$POORT" "$W/rpc.log" & NEP=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$POORT/" && break; sleep 0.1; done
: > "$W/rpc.log"

cat > "$W/druk.sh" <<'SH'
#!/bin/sh
for n in SUPABASE_ANON_KEY SUPABASE_PUBLISHABLE_KEY SUPABASE_LEGACY_TERUG SB_SLEUTEL SUPABASE_PUBLISHABLE_STANDAARD POD_BOOTSTRAP_SECRET CLAUDE_CODE_OAUTH_TOKEN; do
  v="$(printenv "$n")"
  if [ -z "$v" ]; then echo "$n AFWEZIG"; else echo "$n $(printf '%s' "$v" | sha256sum | cut -c1-12)"; fi
done
echo "SECRETS_GELADEN $SECRETS_GELADEN"
SH
chmod +x "$W/druk.sh"

# draai <naam> [VAR=waarde ...]: alleen bootstrapgeheim en URL, de rest per geval
draai(){
  local naam="$1"; shift
  : > "$W/rpc.log"
  env -i PATH="$PATH" HOME="$W" POD_BOOTSTRAP_SECRET=nep-bootstrap SUPABASE_URL="http://127.0.0.1:$POORT" \
    "$@" bash ./fetch-secrets.sh "$W/druk.sh" > "$W/$naam.uit" 2> "$W/$naam.err"
  echo $? > "$W/$naam.rc"
  cp "$W/rpc.log" "$W/$naam.rpc"
  grep -h 'fetch-secrets:' "$W/$naam.uit" "$W/$naam.err" > "$W/$naam.log" 2>/dev/null
}
waarde(){ grep "^$2 " "$W/$1.uit" | cut -d' ' -f2; }
kop(){ [ "$(wc -l < "$W/$1.rpc")" = 1 ] && [ "$(cat "$W/$1.rpc")" = "$(h "$2") $(h "$2")" ]; }
geen_sleutels(){ for n in SUPABASE_ANON_KEY SUPABASE_PUBLISHABLE_KEY SUPABASE_LEGACY_TERUG SB_SLEUTEL SUPABASE_PUBLISHABLE_STANDAARD POD_BOOTSTRAP_SECRET; do
  [ "$(waarde "$1" "$n")" = AFWEZIG ] || return 1; done; }

# 1. alleen de publishable-constante (geen sleutel in de omgeving)
draai alleen
toets 'alleen constante: start (rc 0)' "$([ "$(cat "$W/alleen.rc")" = 0 ] && echo 1)"
toets 'alleen constante: apikey en Bearer = constante, één aanroep' "$(kop alleen "$CONST" && echo 1)"
toets 'alleen constante: twee geheimen geladen' "$(grep -qx 'SECRETS_GELADEN claude_code_oauth_token,n8n_mcp_token' "$W/alleen.uit" && echo 1)"
toets 'alleen constante: geen sleutelnaam naar het commando' "$(geen_sleutels alleen && echo 1)"

# 2. legacy-env uit de chart, zonder vlag: genegeerd
draai legacy SUPABASE_ANON_KEY=nep-anon
toets 'anon zonder vlag: constante gebruikt' "$(kop legacy "$CONST" && echo 1)"
toets 'anon zonder vlag: logregel genegeerd' "$(grep -q 'SUPABASE_ANON_KEY genegeerd' "$W/legacy.log" && echo 1)"
toets 'anon zonder vlag: geen sleutelnaam naar het commando' "$(geen_sleutels legacy && echo 1)"

# 3. publishable uit de omgeving wint van de constante (ook naast anon)
draai env SUPABASE_PUBLISHABLE_KEY=nep-pub SUPABASE_ANON_KEY=nep-anon
toets 'env-publishable wint' "$(kop env nep-pub && echo 1)"
toets 'env-publishable: start' "$([ "$(cat "$W/env.rc")" = 0 ] && echo 1)"

# 4. noodvlag: legacy bewust terug
draai nood SUPABASE_LEGACY_TERUG=1 SUPABASE_ANON_KEY=nep-anon SUPABASE_PUBLISHABLE_KEY=nep-pub
toets 'noodvlag: anon gebruikt' "$(kop nood nep-anon && echo 1)"
toets 'noodvlag: LET OP-regel' "$(grep -q 'SUPABASE_LEGACY_TERUG=1' "$W/nood.log" && echo 1)"
toets 'noodvlag: geen sleutelnaam naar het commando' "$(geen_sleutels nood && echo 1)"
draai nood2 SUPABASE_LEGACY_TERUG=1
toets 'noodvlag zonder anon: constante' "$(kop nood2 "$CONST" && echo 1)"

# 5. negatief: verkeerd bootstrapgeheim -> geweigerd, 78, precies één aanroep
draai neg POD_BOOTSTRAP_SECRET=fout-geheim
toets 'fout bootstrapgeheim: exit 78' "$([ "$(cat "$W/neg.rc")" = 78 ] && echo 1)"
toets 'fout bootstrapgeheim: precies één aanroep' "$([ "$(wc -l < "$W/neg.rpc")" = 1 ] && echo 1)"
toets 'fout bootstrapgeheim: logregel geweigerd' "$(grep -q 'bootstrap geweigerd door de RPC' "$W/neg.log" && echo 1)"

# 6. lege URL: fataal vóór er iets wordt aangeroepen
draai geenurl SUPABASE_URL=
toets 'geen URL: exit 78 zonder aanroep' "$([ "$(cat "$W/geenurl.rc")" = 78 ] && [ ! -s "$W/geenurl.rpc" ] && echo 1)"

# 7. geen waarde in enig log
lek=0
for v in nep-anon nep-pub nep-bootstrap fout-geheim nep-claude kluis-mcp "$CONST"; do
  cat "$W"/*.log "$W"/*.err 2>/dev/null | grep -qF -- "$v" && lek=1
done
toets 'geen waarde in de logregels' "$([ "$lek" = 0 ] && echo 1)"

echo; [ "$fout" = 0 ] && echo 'ALLES GROEN' || echo "$fout ROOD"
exit $([ "$fout" = 0 ] && echo 0 || echo 1)
