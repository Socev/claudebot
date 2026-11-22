#!/bin/sh
# wal-archief.sh (wv3180) — archive_command: één WAL-segment zstd-gecomprimeerd naar /opt/data/pg/wal-archief, 7 dagen bewaard.
# Exit 0 alleen als het bestand er volledig staat (anders probeert postgres het opnieuw; een bestaand niet-leeg bestand telt als klaar).
# wv3869 (Olares-uitval 21-22 nov): een leeg bestand telt niet meer als klaar (B5 bleef na de vastloper 0 bytes staan en gold als
#   gearchiveerd), fsync vóór de naamwissel, en groep pgsock zodat de machinekamer (claude, lid van pgsock) het archief met
#   pg_waldump kan lezen. Dat geeft claude niets nieuws: die leest de databank al via sb-sql (pg_read_all_data); socev zit niet in pgsock.
#   WAL_ARCHIEF_MAP alleen voor de toets (test/wal-archief.sh); postgres geeft geen omgeving mee.
set -eu
p="$1"; f="$2"; d="${WAL_ARCHIEF_MAP:-/opt/data/pg/wal-archief}"
[ -s "$d/$f.zst" ] && exit 0
zstd -q -f -o "$d/.$f.zst.tmp" "$p"
chmod 0640 "$d/.$f.zst.tmp"
chgrp pgsock "$d/.$f.zst.tmp" 2>/dev/null || true
sync "$d/.$f.zst.tmp"
mv "$d/.$f.zst.tmp" "$d/$f.zst"
# opruimen hooguit eens per uur (markeerbestand)
if [ ! -f "$d/.opgeruimd" ] || [ -n "$(find "$d/.opgeruimd" -mmin +60 2>/dev/null)" ]; then
  find "$d" -maxdepth 1 -name '*.zst' -mtime +7 -delete 2>/dev/null || true
  touch "$d/.opgeruimd"
fi
exit 0
