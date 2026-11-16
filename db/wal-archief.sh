#!/bin/sh
# wal-archief.sh (wv3180) — archive_command: één WAL-segment zstd-gecomprimeerd naar /opt/data/pg/wal-archief, 7 dagen bewaard.
# Exit 0 alleen als het bestand er volledig staat (anders probeert postgres het opnieuw; een bestaand gelijk bestand telt als klaar).
set -eu
p="$1"; f="$2"; d=/opt/data/pg/wal-archief
[ -f "$d/$f.zst" ] && exit 0
zstd -q -f -o "$d/.$f.zst.tmp" "$p"
mv "$d/.$f.zst.tmp" "$d/$f.zst"
chmod 0640 "$d/$f.zst"
# opruimen hooguit eens per uur (markeerbestand)
if [ ! -f "$d/.opgeruimd" ] || [ -n "$(find "$d/.opgeruimd" -mmin +60 2>/dev/null)" ]; then
  find "$d" -maxdepth 1 -name '*.zst' -mtime +7 -delete 2>/dev/null || true
  touch "$d/.opgeruimd"
fi
exit 0
