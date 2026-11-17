#!/usr/bin/env bash
# Toetst browser-mcp.js (wv3251, gedeelde Patchright-browser) zonder externe site: een lokale proefpagina via de MCP-tools.
#  1. de MCP start, browser_navigate opent de proefpagina (titel), navigator.webdriver is false (Patchright)
#  2. vast profiel: een cookie uit gesprek 1 staat er in gesprek 3 nog (persistent), het slotbestand is na afloop weg
#  3. bezet profiel: gesprek 2 tijdens gesprek 1 krijgt een losse browser (log: profiel "los") en werkt gewoon
#  4. opruimen: na afloop draait er geen Xvfb of Chrome van deze toets meer, de werkmap is weg
#  5. (EIS_SCHERM=1) scherm = Xvfb (User-Agent zonder "Headless"), scherm weigert zonder cookie; (EIS_IMAGE=1, rooktest in het
#     image, zet ook EIS_SCHERM) motor = patchright, /app/playwright-mcp.sh loopt via browser-mcp.js
# Lokaal (zonder image): BROWSER_MOTOR_PAD=<pad naar patchright-core> bash test/browser-mcp.sh  (TOETS_MCP_ARGS=--no-sandbox in een
# user-namespace-proef met Xvfb, waar alles als root draait)
# CI: docker run --rm -v "$PWD":/src:ro --user claude --entrypoint bash <image> -c 'EIS_IMAGE=1 bash /src/test/browser-mcp.sh'
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
BMCP="${BMCP:-$SRC/browser-mcp.js}"
W=$(mktemp -d); export HOME="$W/thuis" TMPDIR="$W/tmp"; mkdir -p "$HOME" "$TMPDIR"
fout=0; goed=0
ok() { echo "GROEN $1"; goed=$((goed+1)); }
nee() { echo "ROOD  $1${2:+  [$2]}"; fout=$((fout+1)); }
opruimen() { [ -n "${SRVPID:-}" ] && kill "$SRVPID" 2>/dev/null; if [ -n "${BEWAAR:-}" ]; then echo "werkmap bewaard: $W"; else rm -rf "$W"; fi; }
trap opruimen EXIT

# Proefpagina op een vrije poort (node, geen netwerk naar buiten).
cat > "$W/srv.js" <<'JS'
const http = require('http');
const s = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end('<!doctype html><title>Proefpagina wv3251</title><p id="t">Hallo vanuit de proef</p>');
});
s.listen(0, '127.0.0.1', () => { require('fs').writeFileSync(process.argv[2], String(s.address().port)); });
JS
node "$W/srv.js" "$W/poort" & SRVPID=$!
for i in $(seq 1 50); do [ -s "$W/poort" ] && break; sleep 0.1; done
URL="http://127.0.0.1:$(cat "$W/poort")/"

# Mini-MCP-client: start het commando, voert een reeks tool-aanroepen uit en drukt per aanroep de tekst af (JSON-regels).
cat > "$W/client.js" <<'JS'
const { spawn } = require('child_process');
const [stappen, ...cmd] = process.argv.slice(2);
const p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', id = 0; const wacht = {};
p.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); try { const m = JSON.parse(l); if (m.id && wacht[m.id]) wacht[m.id](m); } catch (e) {} } });
const req = (method, params) => new Promise((r) => { const n = ++id; wacht[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
const tekst = (r) => ((r.result && r.result.content) || []).map((c) => c.text || '').join('\n') || JSON.stringify(r.error || r);
(async () => {
  const t0 = setTimeout(() => { console.log(JSON.stringify({ fout: 'tijd' })); p.kill('SIGKILL'); process.exit(3); }, 90000);
  await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'toets', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  for (const s of JSON.parse(stappen)) {
    if (s.slaap) { await new Promise((r) => setTimeout(r, s.slaap)); continue; }
    if (s.wachtBestand) { for (let i = 0; i < 300 && !require('fs').existsSync(s.wachtBestand); i++) await new Promise((r) => setTimeout(r, 100)); continue; }
    if (s.maakBestand) { require('fs').writeFileSync(s.maakBestand, '1'); continue; }
    console.log(JSON.stringify({ tool: s.name, tekst: tekst(await req('tools/call', s)) }));
  }
  clearTimeout(t0);
  p.stdin.end();
  await new Promise((r) => { p.on('exit', r); setTimeout(() => { p.kill('SIGKILL'); r(); }, 8000); });
})();
JS

export BROWSER_MCP_LOG="$W/start.log"
EVAL='() => JSON.stringify({wd: navigator.webdriver, ua: navigator.userAgent, koek: document.cookie, tekst: document.getElementById("t").textContent})'
NAV="{\"name\":\"browser_navigate\",\"arguments\":{\"url\":\"$URL\"}}"
EV="{\"name\":\"browser_evaluate\",\"arguments\":{\"function\":\"$(sed 's/"/\\"/g' <<<"$EVAL")\"}}"
KOEK='{"name":"browser_evaluate","arguments":{"function":"() => { document.cookie = \"proef=blijft; max-age=86400; path=/\"; return document.cookie; }"}}'

# Gesprek 1 (houdt het profiel vast tot gesprek 2 klaar is) en gesprek 2 (tegelijk → los).
node "$W/client.js" "[$NAV,$EV,$KOEK,{\"maakBestand\":\"$W/een-klaar\"},{\"wachtBestand\":\"$W/twee-klaar\"}]" node "$BMCP" ${TOETS_MCP_ARGS:-} --uitvoer "$W/uit1" > "$W/g1.txt" 2>"$W/g1.err" &
G1=$!
for i in $(seq 1 600); do [ -f "$W/een-klaar" ] && break; sleep 0.1; done
node "$W/client.js" "[$NAV,$EV,{\"maakBestand\":\"$W/twee-klaar\"}]" node "$BMCP" ${TOETS_MCP_ARGS:-} --uitvoer "$W/uit2" > "$W/g2.txt" 2>"$W/g2.err"
touch "$W/twee-klaar"; wait $G1
node "$W/client.js" "[$NAV,$EV]" node "$BMCP" ${TOETS_MCP_ARGS:-} --uitvoer "$W/uit3" > "$W/g3.txt" 2>"$W/g3.err"

veld() { node -e '
  const r = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((x) => x.tool === "browser_evaluate")[0];
  if (!r) { console.log(""); process.exit(0); }
  const m = r.tekst.match(/### Result\s*\n([\s\S]*?)(\n###|$)/); let v = m ? m[1].trim() : r.tekst;
  try { v = JSON.parse(v); if (typeof v === "string") v = JSON.parse(v); } catch (e) {}
  console.log(typeof v === "object" ? String(v[process.argv[2]]) : "");' "$1" "$2"; }

# navigator.webdriver: ook @playwright/mcp verbergt hem (gemeten 17-11); dit is een regressiewacht, geen bewijs van de motor (dat is 5).
grep -q 'Page Title: Proefpagina wv3251' "$W/g1.txt" && ok "1 gesprek 1: proefpagina geopend (titel)" || nee "1 gesprek 1: proefpagina geopend" "$(head -c 400 "$W/g1.txt") $(tail -3 "$W/g1.err")"
[ "$(veld "$W/g1.txt" tekst)" = "Hallo vanuit de proef" ] && ok "1 gesprek 1: tekst gelezen" || nee "1 gesprek 1: tekst gelezen" "$(veld "$W/g1.txt" tekst)"
[ "$(veld "$W/g1.txt" wd)" = "false" ] && ok "1 navigator.webdriver = false" || nee "1 navigator.webdriver = false" "$(veld "$W/g1.txt" wd)"
grep -q 'Page Title: Proefpagina wv3251' "$W/g2.txt" && ok "3 gesprek 2 (tegelijk) werkt" || nee "3 gesprek 2 (tegelijk) werkt" "$(head -c 400 "$W/g2.txt") $(tail -3 "$W/g2.err")"
PROF=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(l.map((x)=>x.profiel==="los"?"los":"vast").join(","))' "$W/start.log")
[ "$PROF" = "vast,los,vast" ] && ok "3 profiel: vast, bezet → los, daarna weer vast" || nee "3 profiel: vast, bezet → los, daarna weer vast" "$PROF"
[ "$(veld "$W/g3.txt" koek)" = "proef=blijft" ] && ok "2 cookie uit gesprek 1 staat er in gesprek 3 nog" || nee "2 cookie bewaard" "$(veld "$W/g3.txt" koek)"
[ "$(veld "$W/g2.txt" koek)" = "" ] && ok "2 losse browser (gesprek 2) heeft geen cookie" || nee "2 losse browser zonder cookie" "$(veld "$W/g2.txt" koek)"
# Slot racevrij (Codex MOET 1): zes gelijktijdige pogingen → precies één houdt het profiel; na afloop is het weer vrij.
RACE=$(node -e '
  const b = require(process.argv[1]); const m = process.argv[2];
  Promise.all(Array.from({ length: 6 }, () => b.pakProfiel(m))).then((r) => { const n = r.filter(Boolean).length; r.forEach((x) => x && x.houder.kill("SIGKILL"));
    setTimeout(() => b.pakProfiel(m).then((y) => { console.log(n + (y ? " vrij" : " bezet")); if (y) y.houder.kill("SIGKILL"); }), 300); });' "$BMCP" "$W/raceprofiel")
[ "$RACE" = "1 vrij" ] && ok "2 slot: van 6 gelijktijdige precies 1, daarna weer vrij" || nee "2 slot racevrij" "$RACE"
[ "$(stat -c %a "$HOME/.cache/socev-browser/profiel")" = "700" ] && ok "2 profielmap 0700" || nee "2 profielmap 0700" "$(stat -c %a "$HOME/.cache/socev-browser/profiel")"
sleep 1
REST=$(ps -eo pid,args | grep -E "Xvfb|chrome" | grep -F "$W" | grep -v grep | wc -l)
[ "$REST" = 0 ] && ok "4 geen Xvfb/Chrome van de toets meer" || nee "4 geen Xvfb/Chrome van de toets meer" "$REST"
[ -z "$(ls "$TMPDIR" | grep browser-mcp-)" ] && ok "4 werkmap opgeruimd" || nee "4 werkmap opgeruimd" "$(ls "$TMPDIR")"

[ "${EIS_IMAGE:-}" = 1 ] && EIS_SCHERM=1
if [ "${EIS_IMAGE:-}" = 1 ]; then
  MOTOR=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).motor)' "$W/start.log")
  [ "$MOTOR" = patchright ] && ok "5 motor = patchright" || nee "5 motor = patchright" "$MOTOR"
  grep -q 'browser-mcp.js' /app/playwright-mcp.sh && ok "5 /app/playwright-mcp.sh loopt via browser-mcp.js" || nee "5 /app/playwright-mcp.sh loopt via browser-mcp.js"
  [ -f /app/browser-mcp.js ] && ok "5 /app/browser-mcp.js in het image" || nee "5 /app/browser-mcp.js in het image"
fi
if [ "${EIS_SCHERM:-}" = 1 ]; then
  SCHERM=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).scherm)' "$W/start.log")
  case "$SCHERM" in :[0-9]*) ok "5 scherm = Xvfb ($SCHERM)";; *) nee "5 scherm = Xvfb" "$SCHERM";; esac
  UA=$(veld "$W/g1.txt" ua)
  case "$UA" in *Headless*|"") nee "5 User-Agent zonder Headless" "$UA";; *) ok "5 User-Agent zonder Headless";; esac
  # Toegang tot het scherm alleen met de cookie: zonder XAUTHORITY weigert Xvfb (andere gebruikers op de pod kunnen er niet bij).
  node "$W/client.js" "[{\"maakBestand\":\"$W/s-klaar\"},{\"wachtBestand\":\"$W/s-stop\"}]" node "$BMCP" --isolated --uitvoer "$W/uit4" > /dev/null 2>&1 &
  G4=$!
  for i in $(seq 1 100); do [ -f "$W/s-klaar" ] && break; sleep 0.1; done; sleep 1
  D=$(tail -1 "$W/start.log" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).scherm))')
  if command -v xdpyinfo >/dev/null 2>&1; then
    env -u XAUTHORITY HOME=/nonexistent DISPLAY="$D" xdpyinfo >/dev/null 2>&1 && nee "5 scherm weigert zonder cookie" || ok "5 scherm weigert zonder cookie"
  else
    R=$(DISPLAY="$D" XAUTHORITY=/dev/null timeout 10 node -e '
      const net=require("net"); const n=process.env.DISPLAY.slice(1);
      const s=net.connect("/tmp/.X11-unix/X"+n,()=>{const b=Buffer.alloc(12);b[0]=0x6c;b.writeUInt16LE(11,2);b.writeUInt16LE(0,4);s.write(b);});
      s.on("data",(d)=>{console.log(d[0]===1?"toegelaten":"geweigerd");s.destroy();}); s.on("error",(e)=>console.log("fout "+e.code));')
    [ "$R" = geweigerd ] && ok "5 scherm weigert zonder cookie" || nee "5 scherm weigert zonder cookie" "$R"
  fi
  touch "$W/s-stop"; wait $G4
fi
if [ "${EIS_IMAGE:-}" = 1 ]; then
  # De echte ingang van de tools (zelfde regel als in .claude.json van socev): /app/playwright-mcp.sh → browser-mcp.js → patchright.
  node "$W/client.js" "[$NAV]" /app/playwright-mcp.sh > "$W/g5.txt" 2>"$W/g5.err"
  grep -q 'Page Title: Proefpagina wv3251' "$W/g5.txt" && ok "5 via /app/playwright-mcp.sh: proefpagina geopend" || nee "5 via /app/playwright-mcp.sh" "$(head -c 300 "$W/g5.txt") $(tail -3 "$W/g5.err")"
  grep -q '"motor":"patchright"' "$TMPDIR/browser-mcp.log" 2>/dev/null && ok "5 via /app/playwright-mcp.sh: motor patchright (log)" || nee "5 via /app/playwright-mcp.sh: motor patchright" "$(cat "$TMPDIR/browser-mcp.log" 2>&1)"
fi

echo "browser-mcp: $goed groen, $fout rood"
[ "$fout" = 0 ]
