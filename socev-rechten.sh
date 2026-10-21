#!/usr/bin/env bash
# socev-rechten.sh — bestandsrechten voor de uid-scheiding (wv699, 21-10-2026; keten-categorie, zit in het image).
#
# WAAROM. Socev-gesprekken gaan (fase 2) als gebruiker socev (1002) draaien, zodat ze niet bij de omgeving en de bestanden
# van de pod-gebruiker claude (1001) kunnen: kluissleutel, bunq-sleutelpaar, passkeys, n8n, Cloudflare, Telegram. Dit script
# zet de rechten die daarbij horen. Bouwplan "Socev-gesprekken onder eigen gebruiker - sleutelscheiding", § 3.2 en § 5.
#
# DRAAIT ALS claude (1001), nooit als root: de eigenaar mag zelf ACL's zetten, en zo kan een symlink die socev in de vault
# legt nooit een root-schrijfactie omleiden. Alle rondes met find -execdir en setfacl -P (geen symlink volgen, ook niet een
# map halverwege het pad die socev tussendoor vervangt).
#   vol       bij elke containerstart (socev-voorbereiding.sh) en eens per dag (run.sh)
#   na-ronde  elke 5 minuten (run.sh, ook als bisync passief is): ACL en masker herstellen op wat er veranderde, plus de
#             bewaakte plekken
#
# WAT socev MAG
#   /opt/data               alleen doorlopen (0711), niet opsommen; alle andere entries o-rwx
#   AI_SecondBrain          lezen en schrijven (ACL u:socev:rwX + standaard-ACL u:socev,u:claude), MAAR:
#     - de vault-wortel zelf alleen r-x: geen .mcp.json, .codex of nieuwe .claude ernaast, .claude niet weg te hernoemen
#     - code-plekken op elke diepte alleen r-X: .claude/, .obsidian/, .codex/, .vscode/, .mcp.json, .sync-id en scripts
#       (*.js, *.mjs, *.py, *.sh …) (Fable wv689 #1 en wv699 #3/#4: code en hookconfig die de machinekamer draait,
#       Obsidian-plug-ins die op Davids pc draaien); wat socev zelf zo noemt krijgt een andere naam
#   io                      alleen doorlopen (x); per smalle job zet server.js zelf een ACL (fase 2); bestaande jobmappen o-rwx
#   bin                     alleen doorlopen (x) + bisync.log lezen (nachtconsolidatie, vault-concierge); niet olares-cli e.d.
#   auto-memory             doorlopen tot .claude/projects/-opt-data-AI-SecondBrain/memory, die zelf rwX (gedeeld geheugen)
# Faalt iets, dan meldt het script dat en gaat het door: de pod mag hier nooit op blijven hangen.
set -u
umask 077
D=/opt/data
V="${VAULT_DIR:-$D/AI_SecondBrain}"
IO=$D/io
BIN=$D/bin
MEM=$D/.claude/projects/-opt-data-AI-SecondBrain/memory
STEMPEL=$BIN/.socev-masker-stempel
WAT="${1:-vol}"
FOUTEN=0
log(){ echo "$(date '+%F %T') socev-rechten $WAT: $*"; }
acl(){ setfacl -P "$@" 2>/dev/null || FOUTEN=$((FOUTEN + 1)); }

[ "$(id -un)" = "claude" ] || { log "STOP: draait als $(id -un), moet claude zijn"; exit 1; }
command -v setfacl >/dev/null || { log "STOP: setfacl ontbreekt (pakket acl)"; exit 1; }
id socev >/dev/null 2>&1 || { log "STOP: gebruiker socev ontbreekt"; exit 1; }

# Code-plekken: wat 1001 (machinekamer) of Davids pc als code of config uitvoert. Op elke diepte (Fable wv699 #3:
# 10_Zakelijk/.../huisbot/.claude), plus losse scripts (Fable wv699 #4). Voor socev alleen lezen.
CODEPLEK=( -path '*/.claude' -o -path '*/.claude/*' -o -path '*/.obsidian' -o -path '*/.obsidian/*' -o -name .mcp.json
  -o -path '*/.codex' -o -path '*/.codex/*' -o -path '*/.vscode' -o -path '*/.vscode/*' -o -name .sync-id
  -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.ts' -o -name '*.py' -o -name '*.sh' -o -name '*.bash' )
# Alle rondes met -execdir: find houdt de map vast en geeft ./naam door, zodat een map die socev tussendoor door een
# symlink vervangt de wijziging niet buiten de vault kan laten landen (Fable wv699 #1; xargs met volle paden kon dat wel).
# vault_acl <acl> [extra find-voorwaarden]: eigen bestanden en mappen buiten de code-plekken.
vault_acl(){ local a="$1"; shift
  find "$V" -mindepth 1 ! -type l -user claude ! \( "${CODEPLEK[@]}" \) "$@" -execdir setfacl -P -m "$a" {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1)); }
vault_acl_d(){ local a="$1"; shift
  find "$V" -mindepth 1 -type d -user claude ! \( "${CODEPLEK[@]}" \) "$@" -execdir setfacl -P -d -m "$a" {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1)); }
# code_acl [extra]: de code-plekken zelf (van claude) alleen lezen; mappen erven dat.
code_acl(){
  find "$V" -mindepth 1 ! -type l -user claude \( "${CODEPLEK[@]}" \) "$@" -execdir setfacl -P -m u:socev:rX,m::rwX {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  find "$V" -mindepth 1 -type d -user claude \( "${CODEPLEK[@]}" \) "$@" -execdir setfacl -P -d -m u:socev:rX,u:claude:rwX,m::rwX {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
}
vault_wortel(){
  # Wortel: lezen en doorlopen, niet schrijven (geen .mcp.json/.codex/nieuwe .claude ernaast, .claude niet weg te
  # hernoemen); nieuwe kinderen erven wel rwX (standaard-ACL). De ouder /opt/data is niet van socev, dus -P volstaat.
  acl -m u:socev:r-x,m::rwx "$V"
  acl -d -m u:socev:rwX,u:claude:rwX,m::rwX "$V"
}

# Code-plekken die socev zelf aanmaakt (de wortel kan niet, dieper wel): andere naam en een logregel. Code-bestanden van
# socev alleen melden (fase 2 meet of dat legitiem voorkomt).
vault_vreemde_codeplekken(){
  local ts; ts=$(date +%Y%m%d%H%M%S)
  find "$V" -mindepth 2 -user socev \( -name .claude -o -name .mcp.json -o -name .codex -o -name .obsidian -o -name .vscode \) \
    -prune -execdir mv -n -- {} "{}.socev-geblokkeerd-$ts" \; -printf '%p\n' 2>/dev/null | while IFS= read -r p; do
    log "LET OP: $p (van socev) hernoemd naar *.socev-geblokkeerd-$ts: code-plek"
  done
  if [ -f "$STEMPEL" ]; then
    find "$V" -type f -user socev -cnewer "$STEMPEL" \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.ts' -o -name '*.py' \
      -o -name '*.sh' -o -name '*.bash' \) -printf '%p\n' 2>/dev/null | head -20 | while IFS= read -r p; do log "let op: code van socev in de vault: $p"; done
  fi
}

# /opt/data/.claude: alles o-rwx behalve de gedeelde memory-map (socev mag daar alleen doorheen, op naam).
claude_thuis_dicht(){
  [ -d "$D/.claude" ] || return 0
  find "$D/.claude" -path "$MEM" -prune -o ! -type l -user claude -perm /o=rwx -execdir chmod o-rwx {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
}

bin_en_log(){
  acl -m u:socev:x "$BIN"
  [ -f "$BIN/bisync.log" ] && acl -m u:socev:r,m::rwx "$BIN/bisync.log"
  return 0
}

if [ "$WAT" = "vol" ]; then
  T0=$(date +%s)
  chmod 0711 "$D" 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  # Alle entries direct onder /opt/data: o-rwx (dieper hoeft niet: zonder o+x kom je er niet in). socev-thuis is van socev.
  find "$D" -mindepth 1 -maxdepth 1 ! -type l -user claude -perm /o=rwx -execdir chmod o-rwx {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  if [ -d "$V" ]; then
    # Eerst wortel en code-plekken, dan de rest: ook bij de dagronde is er geen moment waarop socev daar schrijfrecht heeft.
    vault_wortel
    code_acl
    vault_acl u:socev:rwX,m::rwX
    vault_acl_d u:socev:rwX,u:claude:rwX,m::rwX
    vault_vreemde_codeplekken
  fi
  # io: doorlopen, en bestaande jobmappen dicht voor anderen. Geen standaard-ACL: machinekamer-jobs blijven dicht.
  if [ -d "$IO" ]; then
    acl -m u:socev:x "$IO"
    find "$IO" -mindepth 1 -maxdepth 1 ! -type l -user claude -perm /o=rwx -execdir chmod o-rwx {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  fi
  # bin: doorlopen, niets opsommen of starten (olares-cli, cloudflared, gitleaks …), bisync.log lezen.
  if [ -d "$BIN" ]; then
    find "$BIN" -mindepth 1 -maxdepth 1 ! -type l -user claude -perm /o=rwx -execdir chmod o-rwx {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    bin_en_log
  fi
  # Auto-memory: socev-thuis/.claude/projects/-opt-data-AI-SecondBrain/memory is een symlink hierheen (socev-thuis.py).
  if [ -d "$D/.claude" ]; then
    claude_thuis_dicht
    mkdir -p "$MEM" 2>/dev/null
    acl -m u:socev:x "$D/.claude" "$D/.claude/projects" "$D/.claude/projects/-opt-data-AI-SecondBrain"
    find "$MEM" ! -type l -user claude -execdir setfacl -P -m u:socev:rwX,m::rwX {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    find "$MEM" -type d -user claude -execdir setfacl -P -d -m u:socev:rwX,u:claude:rwX,m::rwX {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  fi
  touch "$STEMPEL" 2>/dev/null
  date '+%Y-%m-%d' > "$BIN/laatste-socev-rechten" 2>/dev/null
  log "klaar in $(( $(date +%s) - T0 )) s, fouten: $FOUTEN"
  exit 0
fi

if [ "$WAT" = "na-ronde" ]; then
  # Programma's die zelf een modus zetten (rclone, cp -p, editors) maken het ACL-masker krapper (Fable #4); een bestand dat
  # met mv van buiten binnenkomt heeft geen ACL. Wat sinds de vorige keer veranderde (ctime: rclone zet de mtime van Drive
  # terug) krijgt zijn ACL en masker terug. Alleen eigen bestanden.
  [ -d "$V" ] || exit 0
  NIEUW="$STEMPEL.nieuw"
  touch "$NIEUW" 2>/dev/null
  if [ -f "$STEMPEL" ]; then
    code_acl -cnewer "$STEMPEL"
    vault_acl u:socev:rwX,m::rwX -cnewer "$STEMPEL"
    vault_acl_d u:socev:rwX,u:claude:rwX,m::rwX -cnewer "$STEMPEL"
    [ -d "$MEM" ] && { find "$MEM" ! -type l -user claude -cnewer "$STEMPEL" -execdir setfacl -P -m u:socev:rwX,m::rwX {} + 2>/dev/null || true; }
  fi
  # Wortel: is er schrijfrecht voor socev bijgekomen (iemand zette de ACL anders), dan terug.
  getfacl -cp "$V" 2>/dev/null | grep -q '^user:socev:.w' && { log "vault-wortel had schrijfrecht voor socev: hersteld"; vault_wortel; }
  vault_vreemde_codeplekken
  mv -f "$NIEUW" "$STEMPEL" 2>/dev/null
  claude_thuis_dicht
  bin_en_log
  [ "$FOUTEN" = "0" ] || log "fouten: $FOUTEN"
  exit 0
fi

log "onbekende opdracht (vol | na-ronde)"
exit 2
