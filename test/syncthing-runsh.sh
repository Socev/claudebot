#!/usr/bin/env bash
# test/syncthing-runsh.sh [syncthing-bin] — het Syncthing-blok van run.sh (wv1277) in scenario's, met een echte Syncthing.
#
# WAAROM. run.sh is PID 1 van de pod; een fout in het Syncthing-blok mag de pod niet laten vallen en de poort moet fail-closed
# zijn: zonder schakelaar, op de passieve kant, met een vreemde binary, een rode filtertoets, een losse config of een
# .stignore die geen symlink naar het filter in /app is, start Syncthing niet (of stopt hij). Het blok wordt uit run.sh geknipt
# (van de kop "Syncthing (wv1277" tot start_sync) en met /app → de werkboom gedraaid.
set -uo pipefail
HIER="$(cd "$(dirname "$0")/.." && pwd)"
STB="${1:-${SYNCTHING_BIN:-/opt/data/syncthing/bin/syncthing}}"
[ -x "$STB" ] || { echo "syncthing ontbreekt ($STB) - toets overgeslagen"; exit 0; }
command -v rclone >/dev/null || { echo "rclone ontbreekt - toets overgeslagen"; exit 0; }
T="$(mktemp -d)"; trap 'st_stop opruimen >/dev/null 2>&1; rm -rf "$T"' EXIT
fout=0; goed=0
ok(){ if eval "$2" >/dev/null 2>&1; then echo "  OK    $1"; goed=$((goed + 1)); else echo "  FOUT  $1"; fout=$((fout + 1)); fi; }
mkdir -p "$T/app" "$T/st/bin" "$T/vault/map"
cp "$HIER/syncthing-stignore.txt" "$HIER/syncthing-filter-toets.py" "$HIER/bisync-filter.txt" "$HIER/socev-rechten.sh" "$T/app/"
chmod 0444 "$T/app/syncthing-stignore.txt"; cp "$STB" "$T/st/bin/syncthing"; echo notitie > "$T/vault/a.md"; echo x > "$T/vault/map/b.md"
sed -n '/^# ── Syncthing (wv1277/,/^start_sync(){/p' "$HIER/run.sh" | sed '$d' | sed "s#/app/#$T/app/#g" > "$T/blok.sh"
grep -q 'st_bewaak()' "$T/blok.sh" || { echo "kon het blok niet uit run.sh knippen"; exit 1; }
log(){ :; }; ROL=primair; rol_primair(){ [ "$ROL" = primair ]; }
VAULT="$T/vault"; SYNC_FILTER="$T/app/bisync-filter.txt"; ST_DIR="$T/st"; ST_SCHAKELAAR="$T/schakelaar.json"
# shellcheck disable=SC1090
. "$T/blok.sh"
ST_SHA256="$(sha256sum "$STB" | cut -d' ' -f1)"
"$ST_BIN" generate --home="$ST_HOME" --no-port-probing >/dev/null 2>&1
python3 - "$ST_HOME/config.xml" "$T/vault" <<'PY'
import sys,socket,xml.etree.ElementTree as ET
p,v=sys.argv[1:]; t=ET.parse(p); r=t.getroot()
for f in r.findall('folder'): r.remove(f)
o=r.find('options')
s=socket.socket(); s.bind(('127.0.0.1',0)); gp=s.getsockname()[1]; s.close()
for k,val in (('listenAddress','tcp://127.0.0.1:0'),('globalAnnounceEnabled','false'),('localAnnounceEnabled','false'),('relaysEnabled','false'),
              ('urAccepted','-1'),('autoUpgradeIntervalH','0'),('crashReportingEnabled','false'),('startBrowser','false')):
    for e in o.findall(k): o.remove(e)
    ET.SubElement(o,k).text=val
g=r.find('gui'); g.find('address').text='127.0.0.1:%d'%gp
for k,val in (('user','claude'),('password','$2a$10$nepnepnepnepnepnepnepuNEPNEPNEPNEPNEPNEPNEPNEPNEPNEPNE')):
    for e in g.findall(k): g.remove(e)
    ET.SubElement(g,k).text=val
f=ET.SubElement(r,'folder',{'id':'socev-vault','label':'vault','path':v,'type':'sendreceive','ignorePerms':'true','rescanIntervalS':'3600','fsWatcherEnabled':'false'})
for k in ('syncOwnership','sendOwnership','syncXattrs','sendXattrs'): ET.SubElement(f,k).text='false'
t.write(p)
PY
cp "$ST_HOME/config.xml" "$T/config.goed"
loopt(){ [ -n "$ST_PID" ] && kill -0 "$ST_PID" 2>/dev/null; }
reset(){ st_stop reset >/dev/null 2>&1; ST_VOLGENDE=0; ST_CRASH=0; cp "$T/config.goed" "$ST_HOME/config.xml"; }

echo "== schakelaar en rol =="
st_bewaak; ok "zonder schakelaarbestand: niet gestart, reden 'schakelaar uit'" '! loopt && [ "$ST_REDEN" = "schakelaar uit" ]'
echo '{"aan": false}' > "$ST_SCHAKELAAR"; st_bewaak; ok "schakelaar uit: niet gestart" '! loopt'
echo '{"aan": "ja"}' > "$ST_SCHAKELAAR"; st_bewaak; ok "schakelaar met iets anders dan true: niet gestart" '! loopt'
echo '{"aan": true}' > "$ST_SCHAKELAAR"; ROL=passief; st_bewaak; ok "passieve kant: niet gestart" '! loopt && [ "$ST_REDEN" = "pod niet primair" ]'
ROL=primair

echo "== poort =="
ST_SHA256=0000; st_bewaak; ok "vreemde binary (sha256): niet gestart, poort rood" '! loopt && [[ "$ST_POORT" == rood:*sha256* ]]'
ok "  na rood pas over een uur opnieuw" '[ "$ST_VOLGENDE" -gt $(( $(date +%s) + 3000 )) ]'
ST_SHA256="$(sha256sum "$STB" | cut -d' ' -f1)"; reset
sed -i 's/<urAccepted>-1</<urAccepted>3</' "$ST_HOME/config.xml"; st_bewaak; ok "statistiek aan in de config: niet gestart" '! loopt && [[ "$ST_POORT" == *statistiek* ]]'
reset; python3 -c "import sys;p=sys.argv[1];s=open(p).read();open(p,'w').write(s.replace('<user>claude</user>',''))" "$ST_HOME/config.xml"
st_bewaak; ok "GUI zonder gebruiker: niet gestart" '! loopt && [[ "$ST_POORT" == *gebruiker* ]]'
reset; sed -i 's/ignorePerms="true"/ignorePerms="false"/' "$ST_HOME/config.xml"; st_bewaak; ok "vaultmap zonder ignorePerms: niet gestart" '! loopt'
reset; sed -i 's#<address>127.0.0.1:#<address>0.0.0.0:#' "$ST_HOME/config.xml"; st_bewaak; ok "GUI op 0.0.0.0: niet gestart" '! loopt'
reset; sed -i 's/<device id="\([A-Z0-9-]*\)" name="\([^"]*\)"/<device id="\1" name="\2" autoAcceptFolders="true"/' "$ST_HOME/config.xml"
st_bewaak; ok "apparaat met automatisch accepteren: niet gestart" '! loopt'
reset; cp "$T/app/syncthing-stignore.txt" "$T/st.bak"; chmod 0644 "$T/app/syncthing-stignore.txt"; grep -v '^(?i)\*\.ps1$' "$T/st.bak" > "$T/app/syncthing-stignore.txt"
st_bewaak; ok "filter zonder *.ps1: filtertoets rood, niet gestart" '! loopt && [[ "$ST_POORT" == *filtertoets* ]]'
cp "$T/st.bak" "$T/app/syncthing-stignore.txt"; chmod 0444 "$T/app/syncthing-stignore.txt"; reset
echo 'Write-Host' > "$T/vault/map/x.PS1"; ok "  (een .PS1 in de vault laat de toets groen: het filter vangt hem)" 'true'

echo "== start en bewaking =="
rm -f "$T/vault/.stignore"; printf 'ik ben geen symlink\n' > "$T/vault/.stignore"
st_bewaak; ok "alles goed: gestart" 'loopt && [[ "$ST_POORT" == groen* ]]'
ok "  vault/.stignore is nu een symlink naar het filter in /app (gewoon bestand vervangen)" '[ -L "$T/vault/.stignore" ] && [ "$(readlink "$T/vault/.stignore")" = "$T/app/syncthing-stignore.txt" ]'
ok "  status.json zegt loopt" 'python3 -c "import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d[\"loopt\"] and d[\"aan\"] else 1)" "$ST_STATUS"'
ok "  filtertoets.json met de vaultspiegel" 'python3 -c "import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d[\"ok\"] and d[\"vault_bestanden\"]>=3 else 1)" "$ST_DIR/filtertoets.json"'
sleep 3; ok "  Syncthing antwoordt en ziet x.PS1 niet" 'grep -q "Completed initial scan" "$ST_LOG" && ! grep -q "x.PS1" "$ST_LOG"'
rm -f "$T/vault/.stignore"; printf '*\n' > "$T/vault/.stignore"; st_bewaak
ok "vervangen .stignore tijdens het draaien: meteen gestopt" '! loopt && [[ "$ST_REDEN" == *symlink* ]]'
ST_VOLGENDE=0; st_bewaak; ok "  volgende ronde: symlink hersteld en weer gestart" 'loopt && [ -L "$T/vault/.stignore" ]'
echo '{"aan": false}' > "$ST_SCHAKELAAR"; st_bewaak; ok "schakelaar uit tijdens het draaien: gestopt" '! loopt && [ "$ST_REDEN" = "schakelaar uit" ]'
echo '{"aan": true}' > "$ST_SCHAKELAAR"; st_bewaak; ok "schakelaar weer aan: gestart" 'loopt'
ROL=passief; st_bewaak; ok "rol wordt passief: gestopt" '! loopt'
ROL=primair; ST_VOLGENDE=0; st_bewaak; sleep 2
ok "  monitor + kind draaien (2 processen op dit home)" '[ "$(st_pids | wc -l)" = 2 ]'
st_stop proef; sleep 1; ok "st_stop laat geen verweesd kind achter (Fable #1)" '[ -z "$(st_pids)" ]'
ST_VOLGENDE=0; st_bewaak; sleep 2; kill -9 "$ST_PID"; sleep 1; st_bewaak
ok "proces gecrasht (alleen de monitor gedood): niet meteen opnieuw (wacht ≥ 60 s), telt herstarts" '! loopt && [ "$ST_CRASH" = 1 ] && [ "$ST_VOLGENDE" -gt $(( $(date +%s) + 60 )) ]'
ok "  het verweesde kind draait nog (zo gedraagt Syncthing zich)" '[ -n "$(st_pids)" ]'
ST_VOLGENDE=0; st_bewaak; sleep 2
ok "  volgende start ruimt de wees op: weer precies 2 processen, eigen pid" 'loopt && [ "$(st_pids | wc -l)" = 2 ] && [[ " $(st_pids | tr "\n" " ") " == *" $ST_PID "* ]]'
python3 -c "import sys;p=sys.argv[1];s=open(p).read();open(p,'w').write(s.replace('</configuration>','<device id=\"AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA\" name=\"indringer\" introducer=\"false\" autoAcceptFolders=\"false\"></device></configuration>'))" "$ST_HOME/config.xml"
st_bewaak; ok "apparaat toegevoegd tijdens het draaien: gestopt (Fable #3)" '! loopt && [[ "$ST_REDEN" == config* ]] && [ -z "$(st_pids)" ]'
ST_VOLGENDE=0; st_bewaak; ok "  volgende ronde: door de poort en weer gestart (nieuwe vingerafdruk)" 'loopt'
reset; sed -i 's#</gui>#<insecureAdminAccess>true</insecureAdminAccess></gui>#' "$ST_HOME/config.xml"
st_bewaak; ok "GUI met insecureAdminAccess: niet gestart" '! loopt && [[ "$ST_POORT" == *insecureAdminAccess* ]]'
reset
ok "run.sh stopt Syncthing bij SIGTERM (afsluiten)" 'grep -q "st_stop \"podstop (SIGTERM)\"" "$HIER/run.sh"'
ok "run.sh roept st_bewaak aan in de bewakerlus" 'grep -qE "^  st_bewaak" "$HIER/run.sh"'
echo "syncthing-runsh: $goed OK, $fout fout(en)"
[ "$fout" = 0 ]
