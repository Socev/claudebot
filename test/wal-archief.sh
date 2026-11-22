#!/usr/bin/env bash
# test/wal-archief.sh (wv3869) — archive_command db/wal-archief.sh met een wegwerpmap (WAL_ARCHIEF_MAP), als claude of in CI.
# 1 gewoon archiveren: niet leeg, zstd klopt, 0640, groep pgsock (als die bestaat); 2 een leeg bestand (de B5 van 22-11) telt
# niet als klaar en wordt opnieuw geschreven; 3 een bestaand niet-leeg bestand blijft ongemoeid (exit 0); 4 geen .tmp achter.
set -u
S="${1:-$(dirname "$0")/../db/wal-archief.sh}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/arch" "$T/wal"
rood=0; ok(){ if [ "$1" = 0 ]; then echo "  OK    $2"; else echo "  ROOD  $2"; rood=$((rood+1)); fi; }
head -c 65536 /dev/urandom > "$T/wal/000000010000000000000001"
cp "$T/wal/000000010000000000000001" "$T/wal/000000010000000000000002"
cp "$T/wal/000000010000000000000001" "$T/wal/000000010000000000000003"
export WAL_ARCHIEF_MAP="$T/arch"
sh "$S" "$T/wal/000000010000000000000001" 000000010000000000000001; ok $? "1 exit 0"
A="$T/arch/000000010000000000000001.zst"
[ -s "$A" ] && zstd -q -d -c "$A" | cmp -s - "$T/wal/000000010000000000000001"; ok $? "1 niet leeg en zstd = segment"
[ "$(stat -c %a "$A")" = 640 ]; ok $? "1 modus 0640"
if getent group pgsock >/dev/null && id -nG | tr ' ' '\n' | grep -qx pgsock; then
  [ "$(stat -c %G "$A")" = pgsock ]; ok $? "1 groep pgsock"
else echo "  --    1 groep pgsock (niet lid van pgsock hier: overgeslagen)"; fi
: > "$T/arch/000000010000000000000002.zst"
sh "$S" "$T/wal/000000010000000000000002" 000000010000000000000002; ok $? "2 exit 0"
[ -s "$T/arch/000000010000000000000002.zst" ] && zstd -q -t "$T/arch/000000010000000000000002.zst"; ok $? "2 leeg bestand opnieuw geschreven"
printf 'al-hier' > "$T/arch/000000010000000000000003.zst"
sh "$S" "$T/wal/000000010000000000000003" 000000010000000000000003; ok $? "3 exit 0"
[ "$(cat "$T/arch/000000010000000000000003.zst")" = al-hier ]; ok $? "3 niet-leeg bestand ongemoeid"
[ -z "$(find "$T/arch" -name '.*.tmp')" ]; ok $? "4 geen .tmp achtergebleven"
echo "wal-archief: $rood rood"; [ "$rood" = 0 ]
