#!/usr/bin/env bash
# test/syncthing-rechten.sh [syncthing-bin] [stignore] — wat doet Syncthing met rechten, symlinks en het filter? (wv1277, 25-10-2026)
#
# WAAROM. Syncthing schrijft in de pod als claude (1001) in de vault, waar socev (1002) via de standaard-ACL moet kunnen lezen en
# schrijven (uid-scheiding wv699). Een programma dat zelf een modus zet, maakt het ACL-masker krapper (Fable wv689 #4). En de
# vault-veilig-regel (wv900): nooit door een symlink schrijven. Deze toets bewijst met twee echte Syncthing-instanties op
# 127.0.0.1 (A = de pod, met umask 077 zoals run.sh; B = een apparaat van David) dat:
#   1. een bestand en een map die van B komen in A de ACL van de ouder erven, met socev rw (masker niet versmald);
#   2. A niet door een symlink schrijft die iemand in de vault zette (geen bestand buiten de map);
#   3. het filter in beide richtingen werkt: code van A gaat niet naar B, code en workspace.json van B komen niet in A;
#   4. de vault-.stignore een symlink naar een alleen-lezen bestand buiten de map mag zijn (zo zet run.sh hem neer).
# Geen echte gebruiker socev nodig: de toets kijkt naar de ACL (u:1002), zoals setfacl hem zet.
set -uo pipefail
HIER="$(cd "$(dirname "$0")/.." && pwd)"
ST="${1:-${SYNCTHING_BIN:-/opt/data/syncthing/bin/syncthing}}"
IGN="${2:-$HIER/syncthing-stignore.txt}"
[ -x "$ST" ] || { echo "syncthing ontbreekt ($ST) - toets overgeslagen"; exit 0; }
command -v setfacl >/dev/null || { echo "setfacl ontbreekt - toets overgeslagen"; exit 0; }
T="$(mktemp -d)"; PIDS=()
opruimen(){ for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; sleep 1; rm -rf "$T"; }
trap opruimen EXIT
[ -n "${TOETS_HOUD_LOG:-}" ] && trap 'cp $T/A.log $TOETS_HOUD_LOG; opruimen' EXIT
fout=0; goed=0
ok(){ if bash -c "$2" >/dev/null 2>&1; then echo "  OK    $1"; goed=$((goed + 1)); else echo "  FOUT  $1"; fout=$((fout + 1)); fi; }
export T

vrij(){ python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
for x in A B; do "$ST" generate --home="$T/$x" --no-port-probing >/dev/null 2>&1 || { echo "generate faalde"; exit 1; }; done
GA=$(vrij); GB=$(vrij); LA=$(vrij); LB=$(vrij)
IDA=$("$ST" device-id --home="$T/A" 2>/dev/null || "$ST" --home="$T/A" --device-id 2>/dev/null)
IDB=$("$ST" device-id --home="$T/B" 2>/dev/null || "$ST" --home="$T/B" --device-id 2>/dev/null)
mkdir -p "$T/a" "$T/b" "$T/buiten"
# A krijgt de ACL van de vault: claude en socev rwX als standaard, masker rwX.
setfacl -m u:1002:rwx,m::rwx "$T/a" && setfacl -d -m u:1002:rwX,u:$(id -u):rwX,m::rwX "$T/a"
cp "$IGN" "$T/ignore.txt"; chmod 0444 "$T/ignore.txt"; ln -s "$T/ignore.txt" "$T/a/.stignore"
cfg(){ # home gui listen eigen-id ander-id ander-listen map
  python3 - "$@" <<'EOF'
import sys,xml.etree.ElementTree as ET
home,gui,lis,me,other,olis,path=sys.argv[1:]
t=ET.parse(home+'/config.xml'); r=t.getroot()
for f in r.findall('folder'): r.remove(f)
o=r.find('options')
for k,v in (('listenAddress','tcp://127.0.0.1:'+lis),('globalAnnounceEnabled','false'),('localAnnounceEnabled','false'),
            ('relaysEnabled','false'),('natEnabled','false'),('urAccepted','-1'),('autoUpgradeIntervalH','0'),('startBrowser','false')):
    for e in o.findall(k): o.remove(e)
    ET.SubElement(o,k).text=v
r.find('gui').find('address').text='127.0.0.1:'+gui
d=ET.SubElement(r,'device',{'id':other,'name':'ander','compression':'metadata','introducer':'false','autoAcceptFolders':'false'})
ET.SubElement(d,'address').text='tcp://127.0.0.1:'+olis
f=ET.SubElement(r,'folder',{'id':'f','label':'f','path':path,'type':'sendreceive','rescanIntervalS':'5','fsWatcherEnabled':'true',
  'fsWatcherDelayS':'1','ignorePerms':'true'})
ET.SubElement(f,'device',{'id':me}); ET.SubElement(f,'device',{'id':other})
for k in ('syncOwnership','sendOwnership','syncXattrs','sendXattrs'): ET.SubElement(f,k).text='false'
t.write(home+'/config.xml')
EOF
}
cfg "$T/A" "$GA" "$LA" "$IDA" "$IDB" "$LB" "$T/a"
cfg "$T/B" "$GB" "$LB" "$IDB" "$IDA" "$LA" "$T/b"
start(){ ( umask "$2"; STNOUPGRADE=1 exec "$ST" serve --home="$T/$1" --no-browser --no-restart --no-upgrade >"$T/$1.log" 2>&1 ) & PIDS+=($!); }
start A 077; start B 022
wacht(){ for _ in $(seq 1 120); do bash -c "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
export -f wacht

echo "== B schrijft, A ontvangt (rechten) =="
mkdir -p "$T/b/sub"; echo notitie > "$T/b/x.md"; echo diep > "$T/b/sub/y.md"
ok "A heeft x.md en sub/y.md binnen 60 s" "wacht '[ -f \$T/a/x.md ] && [ -f \$T/a/sub/y.md ]'"
# effectief recht van socev (1002) = ACL-regel EN masker
socev_rw(){ getfacl -cpn "$1" 2>/dev/null | awk -F: '/^user:1002:/{u=substr($3,1,3)} /^mask::/{m=substr($3,1,3)} END{exit !(u ~ /^rw/ && m ~ /^rw/)}'; }
export -f socev_rw
ok "  x.md: socev effectief rw (ACL geërfd, masker niet versmald)" "socev_rw \$T/a/x.md"
ok "  sub/: standaard-ACL met socev rwx (nieuwe bestanden erven verder)" "getfacl -cpn \$T/a/sub | grep -q '^default:user:1002:rwx' && socev_rw \$T/a/sub"
ok "  sub/y.md: socev effectief rw" "socev_rw \$T/a/sub/y.md"
ok "  x.md is van de pod-gebruiker (geen eigenaar overgenomen)" "[ \"\$(stat -c %u \$T/a/x.md)\" = \"$(id -u)\" ]"

echo "== filter in beide richtingen =="
echo 'Write-Host x' > "$T/b/evil.ps1"; mkdir -p "$T/b/.obsidian" "$T/b/kode"; echo '{}' > "$T/b/.obsidian/workspace.json"; echo 'print(1)' > "$T/b/kode/s.py"
echo 'print(2)' > "$T/a/pod.py"; echo '[core]' > "$T/a/pod.git-niet"; mkdir -p "$T/a/sub/.git"; echo '[core]' > "$T/a/sub/.git/config"
echo merk > "$T/b/merk-b.md"; echo merk > "$T/a/merk-a.md"
ok "merkbestanden zijn over (sync loopt nog)" "wacht '[ -f \$T/a/merk-b.md ] && [ -f \$T/b/merk-a.md ]'"
sleep 3
ok "  code van B komt niet in A (.ps1, .py, .obsidian/workspace.json)" "[ ! -e \$T/a/evil.ps1 ] && [ ! -e \$T/a/kode/s.py ] && [ ! -e \$T/a/.obsidian/workspace.json ]"
ok "  code van A gaat niet naar B (.py, geneste .git)" "[ ! -e \$T/b/pod.py ] && [ ! -e \$T/b/sub/.git ]"
ok "  .stignore (symlink) zelf gaat niet naar B" "[ ! -e \$T/b/.stignore ]"

echo "== symlink in A: Syncthing schrijft er niet doorheen =="
mkdir -p "$T/b/sub2"; echo een > "$T/b/sub2/eerst.md"
ok "sub2/eerst.md is in A" "wacht '[ -f \$T/a/sub2/eerst.md ]'"
kill "${PIDS[0]}"; sleep 2
rm -rf "$T/a/sub2"; ln -s "$T/buiten" "$T/a/sub2"   # wat een aanvaller in de vault zou doen
echo aanval > "$T/b/sub2/door-de-link.md"
start A 077
sleep 15
ok "  niets geschreven in de map achter de symlink" "[ -z \"\$(ls -A \$T/buiten)\" ]"
ok "  A heeft het geweigerd en logt waarom (symlink in het pad)" "grep -iE 'door-de-link|sub2' \$T/A.log | grep -qiE 'symlink|not a directory|conflict'"
ok "  de symlink staat er nog als symlink (niet vervangen door een map met inhoud erachter)" "[ -L \$T/a/sub2 ] || [ ! -e \$T/buiten/door-de-link.md ]"

echo "syncthing-rechten: $goed OK, $fout fout(en)"
[ "$fout" = 0 ]
