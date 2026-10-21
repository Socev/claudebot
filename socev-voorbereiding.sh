#!/usr/bin/env bash
# socev-voorbereiding.sh — draait als root vanuit entrypoint.sh, VÓÓR fetch-secrets (wv699, 21-10-2026; keten-categorie).
#
# WAAROM. Uid-scheiding fase 1 (bouwplan "Socev-gesprekken onder eigen gebruiker - sleutelscheiding" § 3.2 en § 5): een
# tweede, onbevoorrechte gebruiker socev (1002) met een eigen thuismap, de bestandsrechten die hem buiten de pod-sleutels
# houden, en de socev-loper die later (fase 2, achter SOCEV_LOPER) de smalle gesprekken als 1002 start. In fase 1 gebruikt
# niemand de loper; alleen de rechten gaan alvast dicht.
#
# Root doet hier alleen wat root moet: de thuismap aanmaken (eigenaar socev) en de root-herstartlus van de loper starten
# (die bindt de socket). Rechten in de vault en /opt/data zet claude zelf, de thuismap vult socev zelf: zo kan een symlink
# van een van beiden nooit een root-schrijfactie omleiden. Niets hier mag de pod tegenhouden: elke fout wordt gelogd en
# de keten gaat door (zonder loper werkt alles als vandaag, want fase 1 gebruikt hem niet).
set -u
THUIS=/opt/data/socev-thuis
P=/usr/local/bin:/usr/bin:/bin
log(){ echo "$(date '+%F %T') socev-voorbereiding: $*"; }

if ! id socev >/dev/null 2>&1; then log "STOP: gebruiker socev ontbreekt in dit image"; exit 0; fi

# 1. Thuismap: van socev, 0750. Een symlink of bestand op die plek gaat opzij (1001 kan dat neerzetten; root volgt hem niet).
if [ -L "$THUIS" ] || { [ -e "$THUIS" ] && [ ! -d "$THUIS" ]; }; then mv -f -- "$THUIS" "$THUIS.weg-$(date +%s)"; fi
mkdir -p "$THUIS" && chown socev:socev "$THUIS" && chmod 0750 "$THUIS" || log "thuismap aanmaken mislukt"

# 2. Rechten, als claude (eigenaar van /opt/data en de vault).
setpriv --reuid=1001 --regid=1001 --init-groups -- env -i PATH=$P HOME=/opt/data VAULT_DIR="${VAULT_DIR:-/opt/data/AI_SecondBrain}" \
  bash /app/socev-rechten.sh vol || log "socev-rechten.sh vol gaf een fout"

# 3. Thuismap vullen, als socev. De Codex-login gaat van claude naar socev via een pijp (geen van beiden leest de ander).
if [ -f /opt/data/.codex/auth.json ] && ! setpriv --reuid=1002 --regid=1002 --clear-groups -- env -i /usr/bin/test -e "$THUIS/.codex/auth.json"; then
  CODEX_AUTH=--codex-auth
else
  CODEX_AUTH=
fi
{ if [ -n "$CODEX_AUTH" ]; then setpriv --reuid=1001 --regid=1001 --init-groups -- env -i /bin/cat /opt/data/.codex/auth.json; fi; } \
  | setpriv --reuid=1002 --regid=1002 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- \
      env -i PATH=$P HOME="$THUIS" python3 -I /app/socev-thuis.py $CODEX_AUTH || log "socev-thuis.py gaf een fout"

# 4. Root-herstartlus van de loper (bindt /run/socev-loper/loper.sock en start de loper als 1002). Lege omgeving: dit proces
#    en de loper zien nooit een pod-sleutel. Logt naar het containerlog.
setsid env -i PATH=$P python3 -I /app/loper-bind.py </dev/null &
log "klaar (loper-lus pid $!)"
exit 0
