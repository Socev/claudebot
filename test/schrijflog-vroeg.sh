#!/usr/bin/env bash
# wv2155: schrijfLog moet ook vóór de initialisatie van zijn eigen constanten veilig zijn. server.js roept hem al bij het laden
# aan (r. 186: release zonder mk-tekst.js, zoals de bootstrapkopie in het image). Met STDOUT_IS_API_LOG als const crashte het kind
# daar met een TDZ-ReferenceError (CI-rooktest deel B rood 31-10/1-11, 53b2b50..ab1ca8b).
# Toets: een kopie van server.js die schrijfLog als allereerste regel aanroept en dan stopt.
#   1. nieuwe server.js: exit 0 en de regel op stdout;  K. kruisproef KRUIS_REF (standaard 53b2b50): crasht met ReferenceError.
set -u
cd "$(dirname "$0")/.." || exit 1
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
fout=0
maak() {  # $1 = bron, $2 = doel: na de shebang een vroege schrijfLog-aanroep en een nette stop
  { head -1 "$1"; echo "schrijfLog('wv2155-vroeg'); process.exit(0);"; tail -n +2 "$1"; } > "$2"
}
maak server.js "$W/nieuw.js"
uit=$(env -u RELEASE_DIR node "$W/nieuw.js" 2>&1); code=$?
if [ "$code" = 0 ] && grep -q '^wv2155-vroeg$' <<<"$uit"; then echo "GROEN 1 vroege schrijfLog: exit 0 en regel op stdout"
else echo "ROOD  1 vroege schrijfLog: exit $code"; echo "$uit" | head -5; fout=$((fout+1)); fi
REF="${KRUIS_REF:-53b2b50}"
if git show "$REF:server.js" > "$W/oud-bron.js" 2>/dev/null && ! cmp -s server.js "$W/oud-bron.js"; then
  maak "$W/oud-bron.js" "$W/oud.js"
  uit=$(env -u RELEASE_DIR node "$W/oud.js" 2>&1); code=$?
  if [ "$code" != 0 ] && grep -q "Cannot access 'STDOUT_IS_API_LOG' before initialization" <<<"$uit"; then echo "GROEN K kruisproef $REF crasht (TDZ)"
  else echo "ROOD  K kruisproef $REF crasht niet (exit $code): toets 1 is dan niets waard"; fout=$((fout+1)); fi
else echo "OVERGESLAGEN K kruisproef ($REF niet leesbaar of gelijk)"; fi
[ "$fout" = 0 ] && echo "ALLES GROEN" || echo "ROOD: $fout"
exit "$fout"
