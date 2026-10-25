#!/usr/bin/env bash
# test/syncthing-filter.sh [syncthing-bin] [stignore] [bisync-filter] — de filtertoets van Syncthing (wv1277) en zijn tegenproeven.
#
# WAAROM. syncthing-filter-toets.py is de poort waarop run.sh Syncthing wel of niet start. Een toets die altijd groen geeft, is
# geen poort: elke hieronder kapotgemaakte variant (een extensie, een ı/ſ-variant, de niet-ASCII-regel, een config-map, de
# quarantaine, workspace.json mee, een te strenge regel, een extensie die alleen bisync kreeg, een lege of omgekeerde stignore)
# moet rood geven.
set -uo pipefail
HIER="$(cd "$(dirname "$0")/.." && pwd)"
ST="${1:-${SYNCTHING_BIN:-/opt/data/syncthing/bin/syncthing}}"
IGN="${2:-$HIER/syncthing-stignore.txt}"
BF="${3:-$HIER/bisync-filter.txt}"
TOETS="$(dirname "$IGN")/syncthing-filter-toets.py"; [ -r "$TOETS" ] || TOETS="$HIER/syncthing-filter-toets.py"
RECHTEN="$(dirname "$BF")/socev-rechten.sh"; [ -r "$RECHTEN" ] || RECHTEN="$HIER/socev-rechten.sh"
[ -x "$ST" ] || { echo "syncthing ontbreekt ($ST) - toets overgeslagen"; exit 0; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fout=0; goed=0
tk(){ python3 -I "$TOETS" --stignore "$1" --bisync "${2:-$BF}" --rechten "$RECHTEN" --syncthing "$ST" >/dev/null 2>&1; }
groen(){ if tk "$2" "${3:-}"; then echo "  OK    $1"; goed=$((goed + 1)); else echo "  FOUT  $1"; fout=$((fout + 1)); fi; }
rood(){ tk "$2" "${3:-}"; local rc=$?; if [ "$rc" = 1 ]; then echo "  OK    $1"; goed=$((goed + 1)); else echo "  FOUT  $1 (exit $rc)"; fout=$((fout + 1)); fi; }
groen "het echte filter is groen" "$IGN"
grep -v '^(?i)\*\.ps1$' "$IGN" > "$T/a";                        rood "zonder *.ps1" "$T/a"
: > "$T/b";                                                      rood "lege stignore" "$T/b"
{ echo '!*'; cat "$IGN"; } > "$T/c";                             rood "!* vooraan (alles mee)" "$T/c"
grep -v 'pſ1' "$IGN" > "$T/d";                                   rood "zonder de ſ-varianten van ps1" "$T/d"
grep -v '^\*\.\*\[! -~\]\*$' "$IGN" > "$T/e";                    rood "zonder de niet-ASCII-regel" "$T/e"
grep -v '^!\*\[! -~\]\*\.\[!\. \]\*$' "$IGN" > "$T/e2";          rood "zonder de redding (Stamboom-namen vallen weg)" "$T/e2"
grep -v '^(?i).git$' "$IGN" > "$T/f";                            rood "zonder .git" "$T/f"
grep -v '^\*\.socev-geblokkeerd' "$IGN" > "$T/g";                rood "zonder quarantaine" "$T/g"
sed 's#^/.obsidian/workspace.json#!/.obsidian/workspace.json#' "$IGN" > "$T/h"; rood "workspace.json mee" "$T/h"
{ echo '*.md'; cat "$IGN"; } > "$T/i";                           rood "*.md weg (te streng, geen benoemde soort)" "$T/i"
grep -v '^!/.claude' "$IGN" > "$T/j";                            rood "wortel-.claude niet meer mee" "$T/j"
grep -v '^\*\.$' "$IGN" > "$T/k";                                rood "zonder de regel voor een punt aan het eind" "$T/k"
sed 's/|mda)/|mda|xyz)/' "$BF" > "$T/bf";                        rood "bisync kreeg een extensie die Syncthing mist" "$IGN" "$T/bf"
sed 's/(claude|obsidian|/(claude|obsidian|nieuwmap|/' "$BF" > "$T/bf2"; rood "bisync kreeg een config-map die Syncthing mist" "$IGN" "$T/bf2"
python3 -I "$TOETS" --stignore "$T/bestaat-niet" --bisync "$BF" --syncthing "$ST" >/dev/null 2>&1; rc=$?
if [ "$rc" != 0 ]; then echo "  OK    ontbrekende stignore: niet groen (exit $rc)"; goed=$((goed + 1)); else echo "  FOUT  ontbrekende stignore groen"; fout=$((fout + 1)); fi
echo "syncthing-filter: $goed OK, $fout fout(en)"
[ "$fout" = 0 ]
