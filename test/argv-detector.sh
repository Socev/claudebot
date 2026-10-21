#!/usr/bin/env bash
# Toetst de argv-detector (wv698, 21-10-2026): het blok "argv-detector" uit server.js draait in een vm-context met een
# NEP-sleutel in een eigen omgeving, een wegwerp-box en een wegwerp-staat. Opzettelijke lekkers (perl/python met de
# nep-waarde als argument) moeten gemeld worden: één box-rij per (proces, script, sleutel) per dag, met sleutelNAAM en
# ouderketen, nooit de waarde; een procesnaam met opmaaktekens wordt geschoond. Raakt de pod en de echte box niet.
# Gebruik: bash test/argv-detector.sh
set -u
cd "$(dirname "$0")/.." || exit 1
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
NEP=$(head -c 48 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 32)
printf -- '---\n# box\n\n## [week] 2026-01-01 00:00 — oude rij\n- status: open\n' > "$W/box.md"
cp "$(command -v perl)" "$W/x\`y*z" 2>/dev/null || cp "$(command -v perl)" "$W/xyz"
cat > "$W/lekker.sh" <<'SH'
perl -e 'sleep 2' "x-api-key: $1"
SH
fouten=0
toets(){ if [ "$2" = 0 ]; then echo "GROEN $1"; else echo "ROOD  $1"; fouten=$((fouten+1)); fi; }
# de detector krijgt de nep-sleutel via zijn omgeving (env -i: geen echte sleutel), nooit via argv
env -i PATH="$PATH" ARGV_NEP_TOKEN="$NEP" ARGV_NIET_SECRET="kort" SECRETS_GELADEN="ARGV_NEP_TOKEN,ANDER_NAAM_LANG" W="$W" node - > "$W/uit.json" 2> "$W/fout.txt" <<'JS' &
const fs = require('fs'), path = require('path'), crypto = require('crypto'), vm = require('vm');
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── argv-detector (wv698)'), b = src.indexOf('// ── einde argv-detector');
if (a < 0 || b < 0) { console.log(JSON.stringify({ fout: 'blok niet gevonden' })); process.exit(0); }
const log = [];
const g = { require, fs, path, crypto, Buffer, process, setInterval, clearInterval, setTimeout, Date, JSON, Map, Set, Promise,
  logError: (w, e) => log.push('fout ' + w + ' ' + (e && e.code)), schrijfLog: (s) => log.push(s),
  velden: (o) => Object.keys(o).map(k => k + '=' + o[k]).join(' '), nu: () => new Date().toISOString() };
vm.createContext(g);
vm.runInContext(src.slice(a, b) + '\n;globalThis.__d = { argvDetStart, argvDetInfo, argvDet, argvDetSleutels };', g);
const W = process.env.W;
const namen = g.__d.argvDetSleutels(process.env).map(s => s.naam);
g.__d.argvDetStart({ env: process.env, boxPad: path.join(W, 'box.md'), staatPad: path.join(W, 'staat.json'), intervalMs: 250 });
setTimeout(() => { console.log(JSON.stringify({ namen, info: g.__d.argvDetInfo({ detail: true }), kort: g.__d.argvDetInfo(), log })); process.exit(0); }, 6500);
JS
DET=$!
sleep 1
env -u SOCEV_AGENT_RUN SOCEV_SESSIE=toets-sessie bash "$W/lekker.sh" "$NEP" &   # treffer 1 (perl) + 2 (bash met de waarde als $1)
sleep 0.2
bash "$W/lekker.sh" "$NEP" &          # zelfde proces/script/sleutel: geen nieuwe box-rij
sleep 0.2
"$W"/x*z -e 'sleep 2' "$NEP" &        # procesnaam met opmaaktekens
perl -e 'sleep 2' "zonder sleutel" &  # geen treffer
GROOT=$(head -c 100000 /dev/zero | tr '\0' a)
perl -e 'sleep 2' "$GROOT" "$GROOT" "$GROOT" "$GROOT" &   # cmdline van 400 kB: begrensd gelezen, geen fout
wait $DET; wait
cat "$W/fout.txt" >&2
node -e '
const fs = require("fs"); const W = process.argv[1], NEP = process.argv[2];
const u = JSON.parse(fs.readFileSync(W + "/uit.json", "utf8")); const box = fs.readFileSync(W + "/box.md", "utf8");
const staat = fs.existsSync(W + "/staat.json") ? fs.readFileSync(W + "/staat.json", "utf8") : "";
const rijen = box.split("\n").filter(l => /^## \[week\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} — Sleutel in een opdrachtregel/.test(l));
const r = (n, ok, x) => console.log((ok ? "GROEN " : "ROOD  ") + n + (ok ? "" : "  [" + JSON.stringify(x).slice(0, 300) + "]"));
let f = 0; const t = (n, ok, x) => { r(n, ok, x); if (!ok) f++; };
t("alleen de nep-sleutel is bewaakt (SECRETS_GELADEN en korte waarden niet)", JSON.stringify(u.namen) === JSON.stringify(["ARGV_NEP_TOKEN"]), u.namen);
t("treffers geteld (>= 4: perl, bash, perl, x?y?z)", u.info && u.info.treffers_24u >= 4, u.info);
t("per sleutel alleen de naam", u.info && Object.keys(u.info.per_sleutel_24u).join() === "ARGV_NEP_TOKEN", u.info);
t("box: precies 3 nieuwe rijen (perl+lekker.sh, bash, geschoonde naam) — dubbele niet", rijen.length === 3, rijen);
t("box: oude rij staat er nog onder", /oude rij/.test(box) && box.indexOf("oude rij") > box.indexOf("Sleutel in een opdrachtregel"), null);
t("box: ouderketen en script genoemd", /ouderketen `perl ← bash/.test(box) && /script `[^`]*lekker\.sh`/.test(box), box.slice(0, 600));
t("box: procesnaam geschoond (geen backtick of ster)", /`x\?y\?z`/.test(box) || /`xyz`/.test(box), rijen);
t("waarde nergens: box", box.indexOf(NEP) < 0, null);
t("waarde nergens: staat", staat.indexOf(NEP) < 0, null);
t("waarde nergens: log/uitvoer", JSON.stringify(u).indexOf(NEP) < 0, null);
t("geen fouten in de detector", u.info && u.info.fouten === 0, u.log);
t("box: sessie uit SOCEV_SESSIE", /job\/sessie `toets-sessie`/.test(box), rijen);
t("/health kort: geen sleutelnamen of tijden", u.kort && !("per_sleutel_24u" in u.kort) && !("laatste_iso" in u.kort) && u.kort.treffers_24u === u.info.treffers_24u, u.kort);
t("geen tmp-bestanden achtergebleven", fs.readdirSync(W).filter(n => /\.tmp$/.test(n)).length === 0, fs.readdirSync(W));
t("staat 0600", (fs.statSync(W + "/staat.json").mode & 0o777) === 0o600, null);
process.exit(f ? 1 : 0);
' "$W" "$NEP"
rc=$?
toets "argv-detector als geheel" $rc
grep -q "detector: argvDetInfo()" server.js; toets "/health heeft detector" $?
grep -q "argvDetectorStart();" server.js; toets "start na listen" $?
[ $fouten = 0 ] && echo "argv-detector: alles groen" || { echo "argv-detector: $fouten rood"; exit 1; }
