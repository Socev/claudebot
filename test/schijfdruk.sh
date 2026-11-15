#!/usr/bin/env bash
# Toets voor wv3124: schijfdruk.js (schijfdrukmeting per minuut buiten server.js). Nep-/proc (SCHIJFDRUK_PROC), eigen map,
# eigen socket en eigen box; raakt de pod niet. Draait met een tik van 250 ms in plaats van 60 s.
#
#   A deltas     nep-diskstats in drie standen: de delta's in de ring en in /recent kloppen met een onafhankelijke
#                berekening (python), partities en loop-apparaten komen er niet in, een teller die terugspringt geeft geen delta.
#   B slot       tweede start met dezelfde sha stopt; een andere sha neemt het slot over (de oude stopt).
#   C herstart   na doden en opnieuw starten staat de geschiedenis weer in het geheugen (piek 24 u blijft).
#   D hangt      het ringbestand is een FIFO zonder lezer (= een schrijfpoging die nooit terugkomt): de meter blijft meten en
#                antwoorden, buffert (uitstaand groeit, hangt_s loopt op), en schrijft alles zodra de schijf weer leeft.
#   E alarm      full avg60 > 50 % langer dan de (verkorte) grens: precies één box-rij met tijdvak en apparaat; een tweede
#                aaneengesloten periode binnen de pauze: geen tweede rij; boven de pauze wel.
#   F ring       oude ringbestanden boven het maximum worden opgeruimd.
#   H lezing     een /proc-bestand dat nooit antwoordt (FIFO): na MAXOPEN open lezingen start er niets nieuws meer, de meter blijft antwoorden.
#   I nvme       nep-sysfs (wv3126): ms per opdracht, MB, aantallen en status per minuut kloppen met een onafhankelijke berekening (python).
#   J oordeel    drukperiode: 'drukte van elders' bij veel MB en normale latentie, 'schijf hapert' bij trage opdrachten bij weinig MB,
#                'niet vast te stellen' zonder NVMe; geen incident en geen bericht bij alleen een traag venster.
#   K incident   vastzittende I/O of status ≠ live: precies één box-rij #schijf-hapert en één bericht (nep-bericht.py), geen tweede na
#                een herstart (haper.json), in de stille uren wel de rij en geen bericht, een gezonde schijf geen rij.
#   G kosten     echte /proc: CPU-tijd en geheugen van de meter per sample, en wat dat per minuut betekent.
# Kruisproef: SCHIJFDRUK_KRUIS=1 laat de toets een bewust foute kopie draaien (delta zonder aftrekken): A moet dan rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
TOP="$(mktemp -d)"
FOUT=0
opruimen(){ pkill -9 -f "$TOP/" 2>/dev/null; sleep 0.3; rm -rf "$TOP"; }
trap opruimen EXIT
rood(){ echo "ROOD: $1"; FOUT=1; }
groen(){ echo "GROEN: $1"; }
JS="$HIER/schijfdruk.js"
if [ "${SCHIJFDRUK_KRUIS:-0}" = "1" ]; then
  mkdir -p "$TOP/fout"; sed -e 's/const dr = s\[n\].rs - v.rs, dw = s\[n\].ws - v.ws, dtk = s\[n\].tick - v.tick;/const dr = s[n].rs, dw = s[n].ws, dtk = s[n].tick;/' \
    -e 's/const dr = st.r - v.st.r, dw = st.w - v.st.w,/const dr = st.r, dw = st.w,/' "$JS" > "$TOP/fout/schijfdruk.js"
  JS="$TOP/fout/schijfdruk.js"
fi

nep(){  # nep <map> <full60> <rs_nvme> <ws_nvme> <tick_nvme>  — schrijft een nep-/proc
  mkdir -p "$1/pressure"
  printf 'some avg10=1.50 avg60=2.00 avg300=3.00 total=100\nfull avg10=%s avg60=%s avg300=1.00 total=50\n' "$2" "$2" > "$1/pressure/io"
  echo "0.50 0.60 0.70 1/200 4242" > "$1/loadavg"
  cat > "$1/diskstats" <<EOF
   7       0 loop0 99 0 99 0 0 0 99 0 0 77 0 0 0 0 0 0 0
 259       0 nvme0n1 10 0 $3 5 10 0 $4 5 2 $5 0 0 0 0 0 0 0
 259       1 nvme0n1p1 10 0 5000 5 10 0 5000 5 0 5000 0 0 0 0 0 0 0
 252       2 dm-2 10 0 700 5 10 0 800 5 0 40 0 0 0 0 0 0 0
   8       0 sda 10 0 10 5 10 0 10 5 0 10 0 0 0 0 0 0 0
EOF
}
vraag(){ curl -s --max-time 3 --unix-socket "$S/meter.sock" "http://x$1"; }
wachtOp(){ local i; for i in $(seq 1 $(( $2 * 4 ))); do eval "$1" && return 0; sleep 0.25; done; return 1; }
json(){ python3 -c "import sys,json; j=json.load(sys.stdin); print(eval(sys.argv[1], {'j': j}))" "$1" 2>/dev/null; }

opzet(){
  W="$TOP/$1"; S="$W/map"; P="$W/proc"; mkdir -p "$S"
  printf '# box\n\n**Formaat** (proef)\n\n## [week] 2026-10-01 10:00 — bestaande rij\n- status: open\n' > "$W/box.md"
  printf 'import sys\nopen(sys.argv[0][:-3] + ".log", "a").write(" ".join(sys.argv[1:]) + "\\n")\n' > "$W/bericht.py"   # nep: nooit een echt bericht
}
nepsys(){  # nepsys <staat> <r> <rsec> <rms> <w> <wsec> <wms> <infl> <ticks> [temp_millic] [discards] — schrijft een nep-/sys (atomair)
  local D="$W/sys"; mkdir -p "$D/class/nvme/nvme0/nvme0n1" "$D/class/nvme/nvme0/hwmon3" "$D/block/nvme0n1"
  echo "$1" > "$D/.s"; mv "$D/.s" "$D/class/nvme/nvme0/state"
  echo "${10:-43000}" > "$D/.t"; mv "$D/.t" "$D/class/nvme/nvme0/hwmon3/temp1_input"
  echo "$2 0 $3 $4 $5 0 $6 $7 $8 $9 $9 ${11:-0} 0 0 0 0 0" > "$D/.b"; mv "$D/.b" "$D/block/nvme0n1/stat"
}
start(){  # start <sha> [extra env…]
  local sha="$1"; shift
  env SCHIJFDRUK_DIR="$S" SCHIJFDRUK_PROC="$P" SCHIJFDRUK_BOX="$W/box.md" SCHIJFDRUK_SHA="$sha" SCHIJFDRUK_TIK_MS=250 \
    SCHIJFDRUK_FS_MS=1500 SCHIJFDRUK_UIT="$W/uit" SCHIJFDRUK_SYS="$W/sys" SCHIJFDRUK_BERICHT="$W/bericht.py" SCHIJFDRUK_UUR=12 \
    SCHIJFDRUK_NV_MS=100 SCHIJFDRUK_NV_STIL_S=1 "$@" setsid node "$JS" >/dev/null 2>&1 &
  echo $!
}

# ── A deltas ──────────────────────────────────────────────────────────────────────────────────────────────────────
opzet a; nep "$P" 0.00 1000 2000 300
M=$(start sha1)
wachtOp '[ -S "$S/meter.sock" ] && [ "$(vraag /samenvatting | json "j[\"records_geheugen\"]")" -ge 2 ] 2>/dev/null' 10 || rood "A: meter start niet"
nep "$P" 0.00 1500 2600 380; sleep 0.8   # +500 / +600 / +80 ms
nep "$P" 0.00 1500 2600 380; sleep 0.2
nep "$P" 0.00 1400 2700 400; sleep 0.8   # rs terug (geen delta), ws +100, tick +20
vraag "/recent?min=5" > "$W/recent.json"
python3 - "$W/recent.json" <<'PY' && groen "A: delta's kloppen met de onafhankelijke berekening (nvme: +500/+600/+80 ms in één record, dm-2 en sda stil, geen loop/partitie, teller terug = geen delta)" || rood "A: delta's kloppen niet"
import json, sys
j = json.load(open(sys.argv[1]))
rs = j['records']
assert all('nvme0n1p1' not in r.get('d', {}) and 'loop0' not in r.get('d', {}) for r in rs), 'partitie of loop in de ring'
som = [0, 0, 0]
for r in rs:
    for n, v in r.get('d', {}).items():
        if n == 'nvme0n1':
            som = [som[0] + v[0], som[1] + v[1], som[2] + v[2]]
        else:
            assert False, 'stil apparaat heeft delta: %s %s' % (n, v)
# stand 1→2: +500/+600/+80; stand 2→3: rs springt terug (−100) = teller teruggezet: het hele apparaat dat minuut geen delta
assert som == [500, 600, 80], som
assert all(v >= 0 for r in rs for x in r.get('d', {}).values() for v in x[:3])
assert rs[0]['io'][2] == 0 and rs[0]['la'] == [0.5, 0.6, 0.7]
assert rs[-1]['dt'] and 0.1 < rs[-1]['dt'] < 1.0, rs[-1].get('dt')
PY
S1=$(vraag /samenvatting)
[ "$(echo "$S1" | json 'j["laatste"]["load1"]')" = "0.5" ] && [ "$(echo "$S1" | json 'j["piek_24u"]["full_avg60"]["waarde"] == 0')" = "True" ] && groen "A: /samenvatting heeft laatste minuut en piek 24 u" || rood "A: samenvatting onvolledig: $S1"
RING=$(ls "$S"/ring-*.jsonl 2>/dev/null | head -1)
wachtOp '[ -s "$RING" ]' 5; RING=$(ls "$S"/ring-*.jsonl 2>/dev/null | head -1)
[ -s "$RING" ] && python3 -c "import json,sys; [json.loads(l) for l in open(sys.argv[1])]" "$RING" && groen "A: ringbestand staat er en elke regel is JSON" || rood "A: ringbestand ontbreekt of is stuk"

# ── B slot ────────────────────────────────────────────────────────────────────────────────────────────────────────
M2=$(start sha1); sleep 1.5
kill -0 "$M2" 2>/dev/null && rood "B: tweede meter met dezelfde sha draait nog" || groen "B: tweede meter met dezelfde sha stopte"
kill -0 "$M" 2>/dev/null && groen "B: eerste meter draait nog" || rood "B: eerste meter is weg"
M3=$(start sha2); wachtOp '! kill -0 "$M" 2>/dev/null' 10 && groen "B: andere sha neemt het slot over (oude meter gestopt)" || rood "B: oude meter draait nog na overname"
wachtOp '[ "$(vraag /samenvatting | json "j[\"versie\"]")" = "sha2" ]' 10 && groen "B: nieuwe versie antwoordt op de socket" || rood "B: nieuwe versie antwoordt niet"

# ── C herstart: geschiedenis ──────────────────────────────────────────────────────────────────────────────────────
nep "$P" 42.00 1400 2700 400; sleep 1
P1=$(vraag /samenvatting | json 'j["piek_24u"]["full_avg60"]["waarde"]'); N1=$(vraag /samenvatting | json 'j["records_geheugen"]')
kill -9 "$M3" 2>/dev/null; sleep 0.5; nep "$P" 0.00 1400 2700 400
M4=$(start sha2); wachtOp '[ "$(vraag /samenvatting | json "j[\"records_geheugen\"]")" -gt "$N1" ] 2>/dev/null' 10
N2=$(vraag /samenvatting | json 'j["records_geheugen"]'); P2=$(vraag /samenvatting | json 'j["piek_24u"]["full_avg60"]["waarde"]')
[ "$P1" = "42" ] && [ "$P2" = "42" ] && [ "${N2:-0}" -gt "${N1:-0}" ] && groen "C: na een herstart staat de geschiedenis weer in het geheugen (piek 42 %, $N1 → $N2 records)" || rood "C: geschiedenis niet teruggelezen (piek $P1/$P2, records $N1/$N2)"
kill "$M4" 2>/dev/null; wachtOp '! kill -0 "$M4" 2>/dev/null' 5; [ ! -e "$S/meter.pid" ] && groen "C: nette stop wist het slot" || rood "C: slot bleef staan na SIGTERM"

# ── D schijf hangt ────────────────────────────────────────────────────────────────────────────────────────────────
opzet d; nep "$P" 0.00 1000 2000 300
NU=$(date -u +%Y%m%d); UU=$(( $(date -u +%-H) / 6 * 6 )); NAAM=$(printf 'ring-%s-%02d.jsonl' "$NU" "$UU")
mkfifo "$S/$NAAM"
MD=$(start shaD)
wachtOp '[ "$(vraag /samenvatting | json "j[\"records_geheugen\"]")" -ge 6 ] 2>/dev/null' 10 || rood "D: meter meet niet door terwijl de schijf hangt"
SD=$(vraag /samenvatting)
UIT=$(echo "$SD" | json 'j["schrijven"]["uitstaand"]'); HANGT=$(echo "$SD" | json 'j["schrijven"]["hangt_s"]')
[ "${UIT:-0}" -ge 5 ] && [ "$(echo "$SD" | json 'j["laatste"]["leeftijd_s"] < 3')" = "True" ] && groen "D: meter blijft meten en antwoorden bij een hangende schrijfpoging (uitstaand $UIT, hangt_s $HANGT)" || rood "D: uitstaand=$UIT, samenvatting: $SD"
RUIM=$(ps -o rss= -p "$MD" | tr -d ' ')
( while :; do cat "$S/$NAAM" >> "$W/uit-fifo"; done ) & CP=$!   # de schijf leeft weer: er komt een (blijvende) lezer
wachtOp '[ "$(vraag /samenvatting | json "j[\"schrijven\"][\"uitstaand\"]")" = "0" ] 2>/dev/null' 10 && groen "D: na herstel van de schijf is alles weggeschreven (uitstaand 0)" || rood "D: uitstaand liep niet leeg"
kill "$MD" 2>/dev/null; pkill -P "$CP" 2>/dev/null; kill "$CP" 2>/dev/null
[ "$(grep -c . "$W/uit-fifo")" -ge 5 ] && groen "D: de gebufferde records kwamen op schijf ($(grep -c . "$W/uit-fifo") regels, geen verlies)" || rood "D: te weinig regels op schijf ($(grep -c . "$W/uit-fifo"))"
sort "$W/uit-fifo" | uniq -d | grep -q . && rood "D: dubbele regels na herstel" || groen "D: geen dubbele regels"

# ── E alarm ───────────────────────────────────────────────────────────────────────────────────────────────────────
opzet e; nep "$P" 80.00 1000 2000 300
ME=$(start shaE SCHIJFDRUK_ALARM_MS=1500 SCHIJFDRUK_ALARM_PAUZE_MS=60000)
for i in 1 2 3 4 5 6 7 8; do nep "$P" 80.00 $((1000+i*400)) $((2000+i*100)) $((300+i*200)); sleep 0.5; done
N=$(grep -c "Schijfdruk hoog" "$W/box.md")
[ "$N" = "1" ] && groen "E: één box-rij na langer dan de grens" || rood "E: $N rijen na de grens (verwacht 1)"
grep -q "zwaarste apparaat in dit tijdvak nvme0n1" "$W/box.md" && grep -q "#schijfdruk-hoog" "$W/box.md" && groen "E: rij noemt tijdvak en apparaat" || rood "E: rij mist apparaat: $(sed -n 5,14p "$W/box.md")"
head -c 400 "$W/box.md" | grep -q "Formaat" && grep -q "bestaande rij" "$W/box.md" && groen "E: bestaande box-rijen bleven staan" || rood "E: box beschadigd"
nep "$P" 5.00 5000 5000 5000; sleep 0.6; nep "$P" 80.00 5100 5100 5100; sleep 2.5   # dalen en weer stijgen, binnen de pauze
N=$(grep -c "Schijfdruk hoog" "$W/box.md")
[ "$N" = "1" ] && groen "E: tweede periode binnen de pauze geeft geen tweede rij" || rood "E: $N rijen na tweede periode"
[ -s "$S/alarm.json" ] && groen "E: alarm.json bewaart het tijdstip" || rood "E: alarm.json ontbreekt"
kill "$ME" 2>/dev/null; sleep 0.5
nep "$P" 80.00 7000 7000 7000
ME=$(start shaE2 SCHIJFDRUK_ALARM_MS=1500 SCHIJFDRUK_ALARM_PAUZE_MS=1000); sleep 3.5
N=$(grep -c "Schijfdruk hoog" "$W/box.md")
[ "$N" = "2" ] && groen "E: boven de pauze (en na een herstart) volgt wel weer een rij" || rood "E: $N rijen na de pauze (verwacht 2)"
kill "$ME" 2>/dev/null
opzet e2; nep "$P" 30.00 1000 2000 300; ME=$(start shaE3 SCHIJFDRUK_ALARM_MS=500); sleep 3; kill "$ME" 2>/dev/null
[ "$(grep -c "Schijfdruk hoog" "$W/box.md")" = "0" ] && groen "E: 30 % (onder de grens) geeft nooit een rij" || rood "E: rij bij 30 %"

# ── F ring opruimen ───────────────────────────────────────────────────────────────────────────────────────────────
opzet f; nep "$P" 0.00 1000 2000 300
for d in 01 02 03 04 05 06 07 08 09 10 11 12; do echo '{"t":"2026-10-'$d'T00:00:00Z"}' > "$S/ring-202610$d-00.jsonl"; done
MF=$(start shaF SCHIJFDRUK_BEWAAR=8); wachtOp '[ "$(ls "$S"/ring-*.jsonl | wc -l)" -le 8 ]' 10
kill "$MF" 2>/dev/null
AANTAL=$(ls "$S"/ring-*.jsonl | wc -l); NIEUWSTE=$(ls "$S"/ring-*.jsonl | head -1 | xargs basename)
[ "$AANTAL" -le 8 ] && [ ! -e "$S/ring-20261001-00.jsonl" ] && groen "F: ringbestanden boven het maximum opgeruimd ($AANTAL over, oudste weg)" || rood "F: $AANTAL ringbestanden"

# ── H /proc-lezing hangt ───────────────────────────────────────────────────────────────────────────────────────────
opzet h; nep "$P" 0.00 1000 2000 300; rm "$P/loadavg"; mkfifo "$P/loadavg"
MH=$(start shaH SCHIJFDRUK_PROC_MS=300); sleep 9
SH=$(vraag /samenvatting); RH=$(vraag "/recent?min=5")
[ "$(echo "$SH" | json 'j["records_geheugen"]')" -ge 20 ] 2>/dev/null && groen "H: meter blijft records schrijven terwijl loadavg-lezingen vastzitten" || rood "H: te weinig records: $SH"
echo "$RH" | json 'any("lezingen hangen" in r.get("fout","") for r in j["records"])' | grep -q True && groen "H: na MAXOPEN open lezingen start er geen nieuwe meer (record 'lezingen hangen')" || rood "H: geen overslagrecord"
TH=$(ls /proc/$MH/task | wc -l); [ "$(echo "$SH" | json 'j["laatste"]["leeftijd_s"] < 3')" = "True" ] && groen "H: socket antwoordt, laatste record vers ($TH threads)" || rood "H: socket traag/stil"
kill -9 "$MH" 2>/dev/null

# ── I nvme (nep-sysfs) ────────────────────────────────────────────────────────────────────────────────────────────
opzet i; nep "$P" 0.00 1000 2000 300; nepsys live 100 0 100 200 0 400 0 1000
MI=$(start shaI)
wachtOp '[ "$(vraag /samenvatting | json "j[\"records_geheugen\"]")" -ge 2 ] 2>/dev/null' 10 || rood "I: meter start niet"
sleep 0.6; nepsys live 300 20480 500 250 40960 25400 0 1300 44000   # +200 lezen (10 MB, 400 ms), +50 schrijven (20 MB, 25000 ms), +300 ms bezet
sleep 1.2
RI=$(vraag "/recent?min=5")
echo "$RI" | python3 -c "
import sys, json
j = json.load(sys.stdin)
hits = [r['nv']['nvme0n1'] for r in j['records'] if 'nv' in r and r['nv']['nvme0n1']['r'] == 200]
assert len(hits) == 1, 'records met de delta: %d' % len(hits)
v = hits[0]
# onafhankelijke verwachting uit de nep-getallen
assert v['w'] == 50 and v['mr'] == 10.0 and v['mw'] == 20.0, v
assert abs(v['lr'] - 400/200) < 0.11 and abs(v['lw'] - 25000/50) < 0.11 and abs(v['lm'] - 500) < 0.11, v
assert v['s'] == 'live' and v['t'] == 44.0 and v['i'] == 0, v
print('delta ok', v)
" && groen "I: nv per minuut klopt (200 lees 2,0 ms, 50 schrijf 500 ms, 10/20 MB, temperatuur 44, status live)" || rood "I: nv-delta klopt niet: $(echo "$RI" | head -c 600)"
[ "$(vraag /samenvatting | json 'j["nvme"]["apparaten"]["nvme0n1"]["piek_venster_ms"]["waarde"]')" = "500" ] && groen "I: samenvatting toont de piek (500 ms) voor /health" || rood "I: samenvatting.nvme: $(vraag /samenvatting | json 'j["nvme"]')"
kill "$MI" 2>/dev/null

# ── J oordeel ─────────────────────────────────────────────────────────────────────────────────────────────────────
# J1 veel MB bij normale latentie → drukte van elders
opzet j1; nep "$P" 80.00 1000 2000 300; nepsys live 0 0 0 0 0 0 0 0
MJ=$(start shaJ1 SCHIJFDRUK_ALARM_MS=1500 SCHIJFDRUK_ALARM_PAUZE_MS=600000)
for i in 1 2 3 4 5 6 7 8 9 10; do nepsys live 0 0 0 $((i*3000)) $((i*1310720)) $((i*3000)) 0 $((i*100)); nep "$P" 80.00 $((1000+i*400)) $((2000+i*100)) $((300+i*200)); sleep 0.5; done
grep -q "oordeel: drukte van elders" "$W/box.md" && groen "J1: veel MB bij normale latentie = 'drukte van elders'" || rood "J1: $(grep -n 'oordeel' "$W/box.md" | head -c 600)"
grep -q "#schijf-hapert" "$W/box.md" && rood "J1: valse hapering-rij" || groen "J1: geen hapering-rij"
kill "$MJ" 2>/dev/null
# J2 trage opdrachten bij weinig MB → schijf hapert (zonder dat status of stilstand afwijkt: geen incident, geen bericht)
opzet j2; nep "$P" 80.00 1000 2000 300; nepsys live 0 0 0 0 0 0 0 0
MJ=$(start shaJ2 SCHIJFDRUK_ALARM_MS=1500 SCHIJFDRUK_ALARM_PAUZE_MS=600000)
for i in 1 2 3 4 5 6 7 8 9 10; do nepsys live 0 0 0 $((i*10)) $((i*80)) $((i*8000)) 0 $((i*100)); nep "$P" 80.00 $((1000+i*400)) $((2000+i*100)) $((300+i*200)); sleep 0.5; done
grep -q "oordeel: schijf hapert" "$W/box.md" && groen "J2: 800 ms per opdracht bij weinig MB = 'schijf hapert'" || rood "J2: $(grep -n 'oordeel' "$W/box.md" | head -c 600)"
grep -q "Schijfdruk hoog.*schijf hapert" "$W/box.md" && groen "J2: oordeel staat ook in de titel" || rood "J2: titel mist oordeel"
{ grep -q "#schijf-hapert" "$W/box.md" || [ -s "$W/bericht.log" ]; } && rood "J2: incident/bericht zonder statusafwijking of stilstand" || groen "J2: geen incident en geen bericht (alleen traag)"
kill "$MJ" 2>/dev/null
# J3 zonder NVMe-meting → niet vast te stellen
opzet j3; nep "$P" 80.00 1000 2000 300
MJ=$(start shaJ3 SCHIJFDRUK_ALARM_MS=1500)
for i in 1 2 3 4 5 6 7 8; do nep "$P" 80.00 $((1000+i*400)) $((2000+i*100)) $((300+i*200)); sleep 0.5; done
grep -q "oordeel: niet vast te stellen" "$W/box.md" && groen "J3: zonder sysfs 'niet vast te stellen'" || rood "J3: $(grep -n 'oordeel' "$W/box.md" | head -c 400)"
kill "$MJ" 2>/dev/null

# ── K incident ────────────────────────────────────────────────────────────────────────────────────────────────────
# K1 vastzittende I/O: inflight 3 en geen enkele opdracht afgerond
opzet k1; nep "$P" 0.00 1000 2000 300; nepsys live 100 0 100 200 0 400 3 1000
MK=$(start shaK1)
wachtOp '[ "$(grep -c "#schijf-hapert" "$W/box.md")" -ge 1 ]' 12
sleep 3
[ "$(grep -c "#schijf-hapert" "$W/box.md")" = "1" ] && groen "K1: vastzittende I/O geeft precies één box-rij (ook na 3 s extra)" || rood "K1: $(grep -c '#schijf-hapert' "$W/box.md") rijen"
grep -q "^## \[direct\] .*Schijf van Olares hapert: vastzittende I/O" "$W/box.md" && groen "K1: rij is [direct] en noemt de reden" || rood "K1: rij: $(grep -n 'hapert' "$W/box.md" | head -c 300)"
[ "$(grep -c . "$W/bericht.log" 2>/dev/null)" = "1" ] && grep -q "zoals in oktober" "$W/bericht.log" && groen "K1: één bericht aan David in gewone taal" || rood "K1: bericht.log: $(cat "$W/bericht.log" 2>/dev/null)"
[ "$(vraag /samenvatting | json 'j["nvme"]["incident"]["bericht_david"]')" = "True" ] && groen "K1: /health.schijfdruk.nvme.incident toont het incident" || rood "K1: samenvatting: $(vraag /samenvatting | json 'j["nvme"]["incident"]')"
head -c 400 "$W/box.md" | grep -q "Formaat" && grep -q "bestaande rij" "$W/box.md" && groen "K1: bestaande box-rijen bleven staan" || rood "K1: box beschadigd"
# herstart terwijl het nog duurt: haper.json houdt een tweede rij en een tweede bericht tegen
kill "$MK" 2>/dev/null; wachtOp '! kill -0 "$MK" 2>/dev/null' 5
MK=$(start shaK1b); sleep 4
[ "$(grep -c "#schijf-hapert" "$W/box.md")" = "1" ] && [ "$(grep -c . "$W/bericht.log")" = "1" ] && groen "K1: na een herstart geen tweede rij en geen tweede bericht (haper.json)" || rood "K1: rijen $(grep -c '#schijf-hapert' "$W/box.md"), berichten $(grep -c . "$W/bericht.log")"
kill "$MK" 2>/dev/null
# K2 status ≠ live
opzet k2; nep "$P" 0.00 1000 2000 300; nepsys resetting 100 0 100 200 0 400 0 1000
MK=$(start shaK2); wachtOp '[ "$(grep -c "#schijf-hapert" "$W/box.md")" -ge 1 ]' 12; sleep 1
grep -q 'status "resetting" in plaats van live' "$W/box.md" && [ "$(grep -c "#schijf-hapert" "$W/box.md")" = "1" ] && groen "K2: status resetting = één box-rij" || rood "K2: $(grep -n 'hapert' "$W/box.md" | head -c 300)"
kill "$MK" 2>/dev/null
# K3 stille uren: wel de rij, geen bericht
opzet k3; nep "$P" 0.00 1000 2000 300; nepsys resetting 100 0 100 200 0 400 0 1000
MK=$(start shaK3 SCHIJFDRUK_UUR=2); wachtOp '[ "$(grep -c "#schijf-hapert" "$W/box.md")" -ge 1 ]' 12; sleep 2
[ "$(grep -c "#schijf-hapert" "$W/box.md")" = "1" ] && [ ! -s "$W/bericht.log" ] && groen "K3: om 02:00 wel de rij, geen bericht" || rood "K3: rijen $(grep -c '#schijf-hapert' "$W/box.md"), bericht: $(cat "$W/bericht.log" 2>/dev/null)"
kill "$MK" 2>/dev/null
# K5 een lange trim: lezen/schrijven staan stil maar discards lopen door (inflight telt die mee) = geen stilstand
opzet k5; nep "$P" 0.00 1000 2000 300; nepsys live 100 0 100 200 0 400 2 1000 43000 0
MK=$(start shaK5)
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do nepsys live 100 0 100 200 0 400 2 1000 43000 $i; sleep 0.3; done
{ grep -q "#schijf-hapert" "$W/box.md" || [ -s "$W/bericht.log" ]; } && rood "K5: trim (discards lopen door) telt als stilstand" || groen "K5: voortgang in discards is geen stilstand"
kill "$MK" 2>/dev/null
# K4 gezonde schijf die druk bezig is: niets
opzet k4; nep "$P" 0.00 1000 2000 300; nepsys live 0 0 0 0 0 0 0 0
MK=$(start shaK4)
for i in 1 2 3 4 5 6 7 8 9 10; do nepsys live $((i*50)) $((i*400)) $((i*50)) $((i*50)) $((i*400)) $((i*50)) $((i%2)) $((i*20)); sleep 0.3; done
{ grep -q "#schijf-hapert" "$W/box.md" || [ -s "$W/bericht.log" ]; } && rood "K4: melding bij een gezonde schijf" || groen "K4: gezonde, bezige schijf geeft geen melding"
kill "$MK" 2>/dev/null

# ── G kosten (echte /proc, 100 ms-tik) ────────────────────────────────────────────────────────────────────────────
opzet g
MG=$(env SCHIJFDRUK_DIR="$S" SCHIJFDRUK_BERICHT="$W/bericht.py" SCHIJFDRUK_BOX="$W/box.md" SCHIJFDRUK_NV_MS=100 SCHIJFDRUK_SHA=shaG SCHIJFDRUK_TIK_MS=100 SCHIJFDRUK_UIT="$W/uit" setsid node "$JS" >/dev/null 2>&1 & echo $!)
sleep 1; T1=$(awk '{print $14+$15}' /proc/$MG/stat); N1=$(vraag /samenvatting | json 'j["records_geheugen"]'); IO1=$(awk '/^(rchar|wchar):/{s+=$2} END{print s}' /proc/$MG/io)
sleep 15
T2=$(awk '{print $14+$15}' /proc/$MG/stat); N2=$(vraag /samenvatting | json 'j["records_geheugen"]'); IO2=$(awk '/^(rchar|wchar):/{s+=$2} END{print s}' /proc/$MG/io)
RSS=$(ps -o rss= -p "$MG" | tr -d ' '); SG=$(vraag /samenvatting)
kill "$MG" 2>/dev/null
python3 - "$T1" "$T2" "$N1" "$N2" "$IO1" "$IO2" "$RSS" <<'PY'
import sys
t1, t2, n1, n2, i1, i2, rss = map(float, sys.argv[1:])
n = n2 - n1
cpu_ms = (t2 - t1) * 10
print("KOSTEN: %d samples in 15 s; CPU %.1f ms per sample (%.2f ms per minuut); IO %.0f B per sample (rchar+wchar, incl. /proc-lezingen en ring); RSS %.0f MB" % (n, cpu_ms / n, cpu_ms / n, (i2 - i1) / n, rss / 1024))
PY
[ -n "$SG" ] && echo "$SG" | json 'j["laatste"]' | head -c 400; echo

[ "$FOUT" = "0" ] && echo "ALLES GROEN" || { echo "ER IS ROOD"; exit 1; }
