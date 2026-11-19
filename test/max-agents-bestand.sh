#!/usr/bin/env bash
# Toets maxAgents() (19-11-2026, David fd9c5a09): tijdelijk plafond via /opt/data/max-agents.json; knipt de functie uit server.js.
set -u; D=$(mktemp -d); trap "rm -rf $D" EXIT; R=$(cd "$(dirname "$0")/.." && pwd)
python3 - "$R/server.js" "$D/knip.js" <<'PY'
import sys
s=open(sys.argv[1],encoding="utf-8").read(); a=s.index("const MAX_AGENTS = "); b=s.index("\n}\n",s.index("function maxAgents()"))+3
open(sys.argv[2],"w").write("const fs=require(\"fs\");function logError(){};\n"+s[a:b]+"\nmodule.exports={maxAgents};\n")
PY
sed "s#/tmp/mxt#$D#g" "$R/test/max-agents-bestand.js" > "$D/t.js"; cd "$D" && node t.js
