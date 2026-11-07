#!/usr/bin/env bash
# Toetst MemoryLane × Immich (wv2120, 31-10-2026; ontwerp vault fase R § 15): witte lijst (alleen lezen + leeg album aanmaken + albumnaam wijzigen, wv2225;
# wv2614 Studio: origineel lezen, nieuwe eigen foto + stapel + album, nooit een bestaande foto wijzigen), metadata in
# miniaturen, albums idempotent per herinnering, foto's alleen uit een gekoppeld album, foto's bij de deellinks alleen als David het aanzet.
# Nep-Immich en nep-D1, alleen verzonnen tekst en beelden; raakt /opt/data niet. Gebruik: bash test/memorylane-immich.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" immich.js memorylane-fotos.js memorylane-plaatje.js; then echo "ROOD  immich.js/memorylane-fotos.js logt naar de console of gebruikt eval"; exit 1; fi
echo "GROEN poort: geen console"
if grep -nE "'DELETE'|DELETE /" immich.js | grep -v '^\s*[0-9]*:\s*\*'; then echo "ROOD  immich.js noemt DELETE"; exit 1; fi
# wv2614: PUT alleen in de witte lijst (één tak), de eigen-lijstcontrole en inAlbum (één aanroep, alleen /api/albums/<id>/assets met { ids: [eigenId] })
if [ "$(grep -c "'PUT'" immich.js)" != 3 ] || ! grep -q "verzoek('PUT', '/api/albums/' + albumId + '/assets', undefined, { ids: \[eigenId\] })" immich.js; then echo "ROOD  immich.js gebruikt PUT buiten inAlbum"; exit 1; fi
# wv2614: uploaden en stapelen elk precies één aanroep; nergens een pad met /api/assets/<id> achter PUT/PATCH/DELETE
[ "$(grep -c "verzoek('POST', '/api/assets'" immich.js)" = 1 ] || { echo "ROOD  POST /api/assets buiten uploaden"; exit 1; }
[ "$(grep -c "verzoek('POST', '/api/stacks'" immich.js)" = 1 ] || { echo "ROOD  POST /api/stacks buiten stapelen"; exit 1; }
if grep -nE "verzoek\('(PUT|PATCH|DELETE)', '/api/assets" immich.js; then echo "ROOD  wijziging op een bestaande foto"; exit 1; fi
# wv2225: PATCH alleen in de witte lijst (één tak) en in hernoemAlbum (één aanroep, alleen albumName)
if [ "$(grep -c "'PATCH'" immich.js)" != 2 ] || ! grep -q "verzoek('PATCH', '/api/albums/' + id, null, { albumName: naam })" immich.js; then echo "ROOD  immich.js gebruikt PATCH buiten hernoemAlbum"; exit 1; fi
echo "GROEN poort: immich.js kent geen DELETE; PATCH alleen voor de albumnaam; PUT alleen eigen foto in album; upload en stapel elk één aanroep (wv2614)"
node --no-warnings --test --test-reporter=spec test/memorylane-immich.test.js
