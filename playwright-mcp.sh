#!/bin/bash
# playwright-mcp.sh — Playwright-MCP voor de smalle Socev-gesprekken als socev (wv699; kopie van mk-scripts/playwright-mcp.sh,
# die als 1002 onbereikbaar is, Fable wv689 #8). Zelfde chromium-keuze; uitvoer in de eigen TMPDIR (socev-thuis/tmp).
# wv3251 (17-11-2026): staat browser-mcp.js in het image, dan loopt alles via de gedeelde Patchright-browser (eigen onzichtbaar scherm,
# vast profiel in socev-thuis/.cache/socev-browser). Zonder dat bestand (ouder image) het oude gedrag hieronder.
if [ -f /app/browser-mcp.js ] && [ "${BROWSER_OUD:-}" != 1 ]; then
  export BROWSER_MCP_LOG="${TMPDIR:-/tmp}/browser-mcp.log"
  exec node /app/browser-mcp.js --uitvoer "${TMPDIR:-/tmp}/playwright-mcp" "$@"
fi
rev=$(node -e "console.log(require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core/browsers.json').browsers.find(b=>b.name==='chromium').revision)" 2>/dev/null)
exe=/opt/pw-browsers/chromium-$rev/chrome-linux64/chrome
[ -n "$rev" ] && [ -x "$exe" ] || exe=$(ls -d /opt/pw-browsers/chromium-[0-9]*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)
exec /usr/local/bin/playwright-mcp --headless --isolated --output-dir "${TMPDIR:-/tmp}/playwright-mcp" ${exe:+--executable-path "$exe"} "$@"
