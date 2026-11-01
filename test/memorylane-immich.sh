#!/usr/bin/env bash
# Toetst MemoryLane × Immich (wv2120, 31-10-2026; ontwerp vault fase R § 15): witte lijst (alleen lezen + leeg album aanmaken + albumnaam wijzigen, wv2225), metadata in
# miniaturen, albums idempotent per herinnering, foto's alleen uit een gekoppeld album, foto's bij de deellinks alleen als David het aanzet.
# Nep-Immich en nep-D1, alleen verzonnen tekst en beelden; raakt /opt/data niet. Gebruik: bash test/memorylane-immich.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" immich.js memorylane-fotos.js; then echo "ROOD  immich.js/memorylane-fotos.js logt naar de console of gebruikt eval"; exit 1; fi
echo "GROEN poort: geen console"
if grep -nE "method: *'(PUT|DELETE)'|'(PUT|DELETE)'" immich.js; then echo "ROOD  immich.js noemt PUT of DELETE"; exit 1; fi
# wv2225: PATCH alleen in de witte lijst (één tak) en in hernoemAlbum (één aanroep, alleen albumName)
if [ "$(grep -c "'PATCH'" immich.js)" != 2 ] || ! grep -q "verzoek('PATCH', '/api/albums/' + id, null, { albumName: naam })" immich.js; then echo "ROOD  immich.js gebruikt PATCH buiten hernoemAlbum"; exit 1; fi
echo "GROEN poort: immich.js kent geen PUT/DELETE; PATCH alleen voor de albumnaam"
node --no-warnings --test --test-reporter=spec test/memorylane-immich.test.js
