#!/usr/bin/env bash
# Toetst pdf-lezer.js (wv1431, PDF-verwerking via Claude): CI-poort, schema's, kosten, de echte SDK tegen een nep-API op 127.0.0.1
# (expliciete sleutel en basis, fallbacks + beta-kop, effort, structured output, cache_control, document), terugvallen, grens met
# reservering en telling na een herstart, patiëntregel fail-closed, schaduw zonder tekst, batches. Alles verzonnen; raakt geen pod,
# kluis of het echte API-tegoed. Gebruik: bash test/pdf-lezer.sh
# SDK: PDF_SDK=<map met package.json>; anders de brug op de pod (/opt/data/pdf-lezer/vendor), anders (CI) npm install in een wegwerpmap,
# dezelfde versie als package.json.
set -u
cd "$(dirname "$0")/.." || exit 1
if [ -z "${PDF_SDK:-}" ]; then
  if [ -f /opt/data/pdf-lezer/vendor/node_modules/@anthropic-ai/sdk/package.json ]; then PDF_SDK=/opt/data/pdf-lezer/vendor
  else
    W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
    V="$(node -e 'console.log(require("./package.json").dependencies["@anthropic-ai/sdk"])')"
    echo '{"private":true}' > "$W/package.json"
    if (cd "$W" && npm install --silent --no-audit --no-fund --ignore-scripts "@anthropic-ai/sdk@$V" >/dev/null 2>&1); then PDF_SDK="$W"
    elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error::@anthropic-ai/sdk@$V niet te installeren: SDK-toetsen kunnen niet draaien"; exit 1
    else echo "WAARSCHUWING: @anthropic-ai/sdk niet te installeren: SDK-toetsen overgeslagen"; fi
  fi
fi
PDF_SDK="${PDF_SDK:-}" node --test --test-reporter=spec test/pdf-lezer.test.js
