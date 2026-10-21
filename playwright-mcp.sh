#!/bin/bash
# playwright-mcp.sh — Playwright-MCP voor de smalle Socev-gesprekken als socev (wv699; kopie van mk-scripts/playwright-mcp.sh,
# die als 1002 onbereikbaar is, Fable wv689 #8). Zelfde chromium-keuze; uitvoer in de eigen TMPDIR (socev-thuis/tmp).
rev=$(node -e "console.log(require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core/browsers.json').browsers.find(b=>b.name==='chromium').revision)" 2>/dev/null)
exe=/opt/pw-browsers/chromium-$rev/chrome-linux64/chrome
[ -n "$rev" ] && [ -x "$exe" ] || exe=$(ls -d /opt/pw-browsers/chromium-[0-9]*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)
exec /usr/local/bin/playwright-mcp --headless --isolated --output-dir "${TMPDIR:-/tmp}/playwright-mcp" ${exe:+--executable-path "$exe"} "$@"
