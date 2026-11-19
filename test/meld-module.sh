#!/usr/bin/env bash
# wv3424 (actieplan Fable 19-11, B81): één meldmodule (meld.js) voor bewaker.js en schijfdruk.js. Eigen paden, nep-server, nep-box,
# nep-bericht.py; raakt de pod niet. Kruisproef: BEWAKER_JS=<oude bewaker.js> -> A1, A3, B1 rood.
# "Trage schijf" = preload test/meld-traag.js: de eerste TRAAG_N renames naar de box (of een symlink) duren TRAAG_MS (in het eigen
# proces én in kinderen; een echte schijf in State D is niet na te bootsen zonder root, zie het rapport).
#   A  bewaker (pad: server hangt, geen supervisor als ouder): de box-schrijf hangt langer dan de grens, intussen schrijft een ander een rij
#      A1 de rij van de ander blijft staan (de "mislukte" schrijf landt niet later met oude inhoud)
#      A2 de bewakerrij komt via de herkansing precies één keer in de box, met vast kenmerk
#      A3 om 02:00 (stille uren) gaat het seintje toch één keer naar bericht.py, met de sleutel van het incident
#   B  zetLink (meld.js): een omzetting die de grens overschrijdt, landt niet later (kind krijgt SIGKILL)
#   C  meld.js: een kenmerk dat al in de box staat, wordt niet nog eens geschreven (exit 4 = staat er al)
#   D  echte bericht.py om 02:00 met een onbereikbare pod: vastgehouden tot 07:00 (wachtbestand stap tot7), niets verstuurd
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d /tmp/meldmodule-XXXXXX)"
PIDS=""
opruimen(){ for p in $PIDS; do kill -9 "$p" 2>/dev/null; done; pkill -9 -f "$W/rel/meld.js" 2>/dev/null; rm -rf "$W"; }
trap opruimen EXIT INT TERM
FOUT=0
rood(){ echo "ROOD  $1"; FOUT=1; }
groen(){ echo "GROEN $1"; }
wachtOp(){ local i; for i in $(seq 1 $((${2:-10} * 4))); do eval "$1" && return 0; sleep 0.25; done; return 1; }

mkdir -p "$W/rel" "$W/bin" "$W/app"
cp "${BEWAKER_JS:-$HIER/bewaker.js}" "$W/rel/bewaker.js"
cp "$HIER/meld.js" "$HIER/vault-veilig.js" "$W/rel/"
printf '# box\n\n**Formaat** (proef)\n\n## [week] 2026-10-01 10:00 — bestaande rij\n- status: open\n' > "$W/box.md"
printf '#!/usr/bin/env python3\nimport sys\nopen("%s/seintjes.txt","a").write(" | ".join(sys.argv[1:])+"\\n")\n' "$W" > "$W/bericht.py"
echo '{}' > "$W/agents.json"

# ── A: bewaker, server hangt, ouder is geen supervisor -> box-rij + seintje ──────────────────────────────────────────
POORT=$(node "$HIER/test/vrije-poort.js")
cat > "$W/server.js" <<'JS'
const fs = require('fs'), W = process.env.PROEF_WERK;
setInterval(function () { while (fs.existsSync(W + '/pauze')) {} }, 100);
require('http').createServer(function (q, r) { r.setHeader('content-type', 'application/json'); r.end('{"ok":true,"versie":"x","lopend":{"beurten":0,"onopgehaald":0},"agents":{"lopend":0}}'); })
  .listen(+process.env.PORT, '127.0.0.1');
JS
PROEF_WERK="$W" PORT="$POORT" node "$W/server.js" & SP=$!; PIDS="$PIDS $SP"; disown "$SP"
wachtOp "curl -s -o /dev/null http://127.0.0.1:$POORT/" 10 || rood "A: nep-server start niet"
env APP_ROOT="$W/app" BIN_DIR="$W/bin" BEWAKER_STAAT="$W/staat.json" BEWAKER_SLOT="$W/slot" BEWAKER_BOX="$W/box.md" \
  BEWAKER_BERICHT="$W/bericht.py" BEWAKER_AGENTS="$W/agents.json" UITROL_MARKER="$W/uitrol-wacht" BEWAKER_UIT="$W/uit" \
  API_LOG="$W/bin/api.log" BEWAKER_INSPECTOR=0 SCHIJFDRUK_SOCK="$W/geen.sock" BEWAKER_UUR=2 BEWAKER_TIK_MS=500 BEWAKER_TIMEOUT_MS=500 \
  BEWAKER_GRENS_MS=2000 BEWAKER_MIN_MISSERS=2 BEWAKER_CONTEXT_MS=600000 BEWAKER_WEES_MS=600000 RELEASE_DIR="$W/rel" \
  BEWAKER_BOX_MS=3000 MELD_HERKANS_MS=2000 \
  NODE_OPTIONS="--require $HIER/test/meld-traag.js" TRAAG_DOEL=box.md TRAAG_N=1 TRAAG_MS=12000 TRAAG_TELLER="$W/traag-teller" TRAAG_MARKER="$W/traag-bezig" \
  node "$W/rel/bewaker.js" --server-pid "$SP" --poort "$POORT" &
BW=$!; PIDS="$PIDS $BW"; disown "$BW"
wachtOp "grep -q gewapend '$W/bin/supervisor.log' 2>/dev/null" 15 || rood "A: bewaker werd niet gewapend"
touch "$W/pauze"
if wachtOp "[ -s '$W/traag-bezig' ]" 20; then
  # een andere schrijver (zonder grendel, het ergste geval) zet nu een rij, terwijl de bewaker op zijn rename wacht
  python3 - "$W/box.md" <<'PY'
import sys, os
p = sys.argv[1]; t = open(p, encoding='utf-8').read()
i = t.index('\n## [')
t = t[:i] + '\n## [week] 2026-11-19 12:00 — rij van een ander\n- status: open\n' + t[i:]
tmp = p + '.ander'; open(tmp, 'w', encoding='utf-8').write(t); os.replace(tmp, p)
PY
else rood "A: de box-schrijf van de bewaker begon niet (geen trage rename gezien)"; fi
rm -f "$W/pauze"
sleep 15   # ruim voorbij de trage rename (12 s) en de herkansing (3 + 2 s)
grep -q "rij van een ander" "$W/box.md" && groen "A1 rij van een ander blijft staan" || rood "A1 rij van een ander is weg (late schrijf met oude inhoud): $(grep -c '^## ' "$W/box.md") koppen"
N=$(grep -c "geen supervisor als ouder" "$W/box.md" || true)
K=$(grep -c "^- kenmerk: bewaker-geen-sup-$SP\$" "$W/box.md" || true)
[ "$N" = "1" ] && [ "$K" = "1" ] && groen "A2 bewakerrij één keer, met kenmerk bewaker-geen-sup-$SP" || rood "A2 bewakerrij $N keer, kenmerk $K keer"
grep -q "Formaat" "$W/box.md" && grep -q "bestaande rij" "$W/box.md" && groen "A2 box verder heel" || rood "A2 box beschadigd"
S=$(grep -c . "$W/seintjes.txt" 2>/dev/null || echo 0)
[ "$S" = "1" ] && grep -q -- "--sleutel | bewaker-geen-sup-$SP" "$W/seintjes.txt" && groen "A3 om 02:00 één seintje naar bericht.py (die houdt het vast tot 07:00)" \
  || rood "A3 seintjes om 02:00: $S ($(head -c 200 "$W/seintjes.txt" 2>/dev/null))"
kill -9 "$BW" 2>/dev/null; wait "$BW" 2>/dev/null

# ── B: zetLink zonder late landing ───────────────────────────────────────────────────────────────────────────────────
mkdir -p "$W/links/oud" "$W/links/nieuw"; ln -s oud "$W/links/vorige"
cat > "$W/link-proef.js" <<'JS'
// Gebruikt de zetLink van de bewaker onder toets: nieuwe code via meld.js, oude code (fsp onder metGrens) uit het bestand geknipt.
const fs = require('fs'), path = require('path'), fsp = fs.promises;
const bron = fs.readFileSync(process.argv[2], 'utf8');
let zet;
if (/meld\.zetLink/.test(bron)) {
  const m = require(path.join(path.dirname(process.argv[2]), 'meld.js')).maak({ linkMs: 1500 });
  zet = m.zetLink;
} else {
  const knip = (naam) => { const i = bron.indexOf(naam); let d = 0, j = bron.indexOf('{', i); for (; j < bron.length; j++) { if (bron[j] === '{') d++; else if (bron[j] === '}' && --d === 0) break; } return bron.slice(i, j + 1); };
  const C = { fs: 1500 };
  eval(knip('function metGrens(') + '\n' + knip('async function zetLink(') + '\nzet = zetLink;');
}
zet(process.argv[3], 'nieuw').then((ok) => { console.log(ok ? 'gelukt' : 'mislukt'); setTimeout(() => process.exit(0), 5000); });   // 5 s blijven leven: een late landing moet kunnen gebeuren
JS
U=$(env NODE_OPTIONS="--require $HIER/test/meld-traag.js" TRAAG_DOEL=vorige TRAAG_N=1 TRAAG_MS=4000 TRAAG_TELLER="$W/link-teller" TRAAG_MARKER="$W/link-bezig" \
  node "$W/link-proef.js" "$W/rel/bewaker.js" "$W/links/vorige" 2>&1)
sleep 1   # het proefproces leefde al 5 s na de uitslag (voorbij de trage rename)
L=$(readlink "$W/links/vorige")
[ "$U" = "mislukt" ] && [ "$L" = "oud" ] && groen "B zetLink 'mislukt' en landt ook later niet (vorige -> oud)" || rood "B zetLink zei '$U', vorige wijst nu naar '$L'"

# ── C: kenmerk staat er al -> niet nog eens ─────────────────────────────────────────────────────────────────────────
RIJ=$(node -e 'console.log(JSON.stringify(require(process.argv[1]).metKenmerk("\n## [direct] 2026-11-19 12:00 — proefrij\n- status: open\n", "proef-1")))' "$W/rel/meld.js")
node "$W/rel/meld.js" poging "$W/box.md" proef-1 "$RIJ"; E1=$?
node "$W/rel/meld.js" poging "$W/box.md" proef-1 "$RIJ"; E2=$?
[ "$E1" = "0" ] && [ "$E2" = "4" ] && [ "$(grep -c 'proefrij' "$W/box.md")" = "1" ] && groen "C tweede poging met hetzelfde kenmerk schrijft niets (exit 0, dan 4)" || rood "C exit $E1/$E2, proefrij $(grep -c proefrij "$W/box.md") keer"

# ── D: echte bericht.py houdt een nachtbericht vast tot 07:00 ───────────────────────────────────────────────────────
BP=/opt/data/mk-scripts/bericht.py
if [ -f "$BP" ]; then
  env -u API_SECRET -u N8N_API_KEY BERICHT_MAP="$W/bm" BERICHT_ROUTE=app BERICHT_POD=http://127.0.0.1:1 BERICHT_TG=http://127.0.0.1:1 \
    BERICHT_NU=2026-11-20T02:00:00 python3 "$BP" --klasse normaal --sleutel bewaker-proef "proefseintje" > "$W/bp.uit" 2>&1
  if grep -l '"stap": "tot7"' "$W"/bm/bericht-wacht/* >/dev/null 2>&1 && grep -q '2026-11-20T07:00:00' "$W"/bm/bericht-wacht/* && grep -q "07:00" "$W/bp.uit"; then
    groen "D bericht.py om 02:00 (pod onbereikbaar): vastgehouden tot 07:00"
  else rood "D bericht.py: $(head -c 300 "$W/bp.uit")"; fi
else echo "OVERGESLAGEN D (geen $BP)"; fi

[ "$FOUT" = "0" ] && echo "ALLES GROEN" || echo "ER IS ROOD"
exit "$FOUT"
