#!/usr/bin/env bash
# bisync-filter-toets.sh <filterbestand> [socev-rechten.sh] — werkt het vault-syncfilter echt? (wv813, 22-10-2026; in het image)
#
# WAAROM. Een rclone-filter dat niet past, faalt stil: rclone laat dan gewoon alles door (gemeten: '- {{\.ps1$}}' liet elk
# .ps1 door). run.sh draait deze toets vóór de eerste bisync en synct niet als hij faalt (fail-closed); test/bisync-filter.sh
# en test/uid-scheiding.sh draaien hem ook. Zie bisync-filter.txt.
#
# HOE. Een proefboom in een tijdelijke map; rclone lsf met het filter moet precies de toegestane bestanden tonen. Is
# socev-rechten.sh meegegeven, dan moet ook elke Windows-codesoort uit zijn WINCODE-lijst (en de scripts uit CODEPLEK) vallen,
# zodat de twee lijsten niet uit elkaar lopen. Exit 0 = goed; anders 1 met per afwijking een regel op stderr.
set -u
# Hermetisch: geen echte rclone.conf (een versleutelde zou om een wachtwoord vragen en de synclus stil laten hangen; #9).
export RCLONE_CONFIG=/dev/null
F="${1:?filterbestand}"
R="${2:-}"
[ -r "$F" ] || { echo "bisync-filter-toets: filter $F ontbreekt of is onleesbaar" >&2; exit 1; }
command -v rclone >/dev/null || { echo "bisync-filter-toets: rclone ontbreekt" >&2; exit 1; }
T="$(mktemp -d)" || exit 1
trap 'rm -rf "$T"' EXIT
mag=( "a.md" "map/b.docx" "map/c.pdf" "map/d.json" "map/e.zip" "map/f.html" "map/g.txt" "map/h.ts" "map/py.md" "map/ps1"
      ".claude/skills/x/SKILL.md" ".claude/skills/x/s.py" ".claude/settings.json" ".obsidian/app.json" ".sync-id"
      "map/Café ü.md" "Dossier.Ünal/brief.docx" "map/notitie über.md" )
niet=( "map/x.ps1" "map/X.PS1" "map/y.ps1." "map/y2.ps1 " "map/y3.Ps1. ." "map/z.py" "map/z.mjs" "map/z.js" "map/z.cjs"
       "map/z.sh" "map/z.bat" "map/Z.CMD" "map/z.vbs" "map/z.lnk" "map/z.url" "map/z.exe" "map/z.hta" "map/z.pyc" "map/z.pyw"
       "map/z.docm" "map/z.xlsm" "map/z.skill" "map/z.scf" "map/z.library-ms" "map/z.searchConnector-ms" "map/desktop.ini"
       "map/Desktop.INI" "map/__pycache__/m.cpython-311.pyc" "map/__pycache__/notitie.md" "map/.claude/settings.json"
       "map/.CLAUDE/settings.json" "map/.vscode/tasks.json" "map/.codex/config.toml" "map/.obsidian/plugins/p/main.js"
       "map/.mcp.json" "verzamel-claude.mjs" "00_Systeem/Tokens/tokens_pc.ps1"
       "map/evil.msı" "map/evil.pıf. " "map/x.ınf" "map/.git/config" "map/.git/hooks/pre-commit" "map/.Cursor/mcp.json"
       "map/node_modules/p/index.md" "map/z.ps1.socev-geblokkeerd-20261022-1" "map/z.pyd" "map/z.wsb" "map/z.accdb"
       "map/z.iqy" "map/z.rdp" )
if [ -n "$R" ]; then
  [ -r "$R" ] || { echo "bisync-filter-toets: $R onleesbaar" >&2; exit 1; }
  # Elke -iname '*.ext' en -name '*.ext' uit socev-rechten.sh behalve .ts (video) en .zip (gewoon document op de pc).
  while IFS= read -r ext; do
    case "$ext" in ts|zip) continue ;; esac
    niet+=( "wincode/w.$ext" )
  done < <(grep -oE -- "-i?name '\*\.[A-Za-z0-9_-]+'" "$R" | sed -E "s/.*\*\.([^']+)'/\1/" | sort -u)
fi
for p in "${mag[@]}" "${niet[@]}"; do mkdir -p "$T/$(dirname "$p")" && printf 'proef\n' > "$T/$p" || exit 1; done
uit="$(rclone lsf -R --files-only --filter-from "$F" "$T" 2>&1)" || { echo "bisync-filter-toets: rclone lsf faalde: $uit" >&2; exit 1; }
fout=0
for p in "${mag[@]}"; do grep -qxF -- "$p" <<<"$uit" || { echo "bisync-filter-toets: hoort mee te gaan, valt weg: $p" >&2; fout=1; }; done
for p in "${niet[@]}"; do ! grep -qxF -- "$p" <<<"$uit" || { echo "bisync-filter-toets: hoort weg te vallen, gaat mee: $p" >&2; fout=1; }; done
[ "$(grep -c . <<<"$uit")" = "${#mag[@]}" ] || { echo "bisync-filter-toets: onverwacht aantal: $(grep -c . <<<"$uit") i.p.v. ${#mag[@]}" >&2; fout=1; }
[ "$fout" = 0 ] && echo "bisync-filter-toets: ok (${#mag[@]} mee, ${#niet[@]} weg)"
exit "$fout"
