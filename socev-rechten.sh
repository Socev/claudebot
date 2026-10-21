#!/usr/bin/env bash
# socev-rechten.sh — bestandsrechten voor de uid-scheiding (wv699, 21-10-2026; keten-categorie, zit in het image).
#
# WAAROM. Socev-gesprekken gaan (fase 2) als gebruiker socev (1002) draaien, zodat ze niet bij de omgeving en de bestanden
# van de pod-gebruiker claude (1001) kunnen: kluissleutel, bunq-sleutelpaar, passkeys, n8n, Cloudflare, Telegram. Dit script
# zet de rechten die daarbij horen. Bouwplan "Socev-gesprekken onder eigen gebruiker - sleutelscheiding", § 3.2 en § 5.
#
# DRAAIT ALS claude (1001), nooit als root: de eigenaar mag zelf ACL's zetten, en zo kan een symlink die socev in de vault
# legt nooit een root-schrijfactie omleiden. Alle setfacl-aanroepen met -P (volgt geen symlink, ook niet als argument).
#   vol       bij elke containerstart (socev-voorbereiding.sh) en eens per dag (run.sh)
#   na-ronde  elke 5 minuten (run.sh, ook als bisync passief is): ACL en masker herstellen op wat er veranderde, plus de
#             bewaakte plekken
#
# WAT socev MAG
#   /opt/data               alleen doorlopen (0711), niet opsommen; alle andere entries o-rwx
#   AI_SecondBrain          lezen en schrijven (ACL u:socev:rwX + standaard-ACL u:socev,u:claude), MAAR:
#     - de vault-wortel zelf alleen r-x: geen .mcp.json, .codex of nieuwe .claude ernaast, .claude niet weg te hernoemen
#     - .claude/ en .obsidian/ alleen r-X (Fable #1: daar staat code en hookconfig die de machinekamer draait; .obsidian
#       bevat plug-ins die op Davids pc draaien), .sync-id alleen r
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
# Lijst (NUL-gescheiden) van paden van claude zelf, zonder symlinks; $1 = wortel, rest = extra find-voorwaarden.
eigen(){ local w="$1"; shift; find "$w" ! -type l -user claude "$@" -print0 2>/dev/null; }

[ "$(id -un)" = "claude" ] || { log "STOP: draait als $(id -un), moet claude zijn"; exit 1; }
command -v setfacl >/dev/null || { log "STOP: setfacl ontbreekt (pakket acl)"; exit 1; }
id socev >/dev/null 2>&1 || { log "STOP: gebruiker socev ontbreekt"; exit 1; }

vault_bewaakt(){
  # Wortel: lezen en doorlopen, niet schrijven; nieuwe kinderen erven wel rwX (standaard-ACL).
  acl -m u:socev:r-x,m::rwx "$V"
  acl -d -m u:socev:rwX,u:claude:rwX,m::rwX "$V"
  local x
  for x in .claude .obsidian; do
    [ -d "$V/$x" ] && [ ! -L "$V/$x" ] || continue
    eigen "$V/$x" | xargs -0 -r setfacl -P -m u:socev:rX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    eigen "$V/$x" -type d | xargs -0 -r setfacl -P -d -m u:socev:rX,u:claude:rwX,m::rwX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  done
  [ -f "$V/.sync-id" ] && acl -m u:socev:r "$V/.sync-id"
  return 0
}

# De vault zonder de wortel en zonder de bewaakte plekken; eigen bestanden, geen symlinks. Extra find-voorwaarden mogen mee.
vault_breed(){
  find "$V" -mindepth 1 \( -path "$V/.claude" -o -path "$V/.obsidian" -o -path "$V/.sync-id" \) -prune \
    -o ! -type l -user claude "$@" -print0 2>/dev/null
}

# Code-plekken die socev in de vault NIET mag aanmaken (hooks, MCP-servers, Codex-projectconfig, Obsidian-plug-ins). In de
# wortel kan het niet (r-x); dieper wel, dus wat socev daar neerzet krijgt een andere naam en een logregel.
vault_vreemde_codeplekken(){
  local p
  find "$V" -mindepth 2 -user socev \( -name .claude -o -name .mcp.json -o -name .codex -o -name .obsidian -o -name .vscode \) \
    -prune -print0 2>/dev/null | while IFS= read -r -d '' p; do
    mv -n -- "$p" "$p.socev-geblokkeerd-$(date +%Y%m%d%H%M%S)" 2>/dev/null && log "LET OP: $p (van socev) hernoemd: codeplek"
  done
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
  find "$D" -mindepth 1 -maxdepth 1 ! -type l -user claude -perm /o=rwx -exec chmod o-rwx {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  # Vault: alles van claude rwX + standaard-ACL op mappen, daarna de bewaakte plekken strenger.
  if [ -d "$V" ]; then
    # Eerst de bewaakte plekken, en de brede ronde slaat ze over: zo is er ook bij de dagronde geen moment waarop socev
    # schrijfrecht op de wortel, .claude of .obsidian heeft.
    vault_bewaakt
    vault_breed | xargs -0 -r setfacl -P -m u:socev:rwX,m::rwX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    vault_breed -type d | xargs -0 -r setfacl -P -d -m u:socev:rwX,u:claude:rwX,m::rwX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    vault_vreemde_codeplekken
  fi
  # io: doorlopen, en bestaande jobmappen dicht voor anderen. Geen standaard-ACL: machinekamer-jobs blijven dicht.
  if [ -d "$IO" ]; then
    acl -m u:socev:x "$IO"
    find "$IO" -mindepth 1 -maxdepth 1 ! -type l -user claude -perm /o=rwx -exec chmod o-rwx {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  fi
  # bin: doorlopen, niets opsommen of starten (olares-cli, cloudflared, gitleaks …), bisync.log lezen.
  if [ -d "$BIN" ]; then
    find "$BIN" -mindepth 1 -maxdepth 1 ! -type l -user claude -perm /o=rwx -exec chmod o-rwx {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    bin_en_log
  fi
  # Auto-memory: socev-thuis/.claude/projects/-opt-data-AI-SecondBrain/memory is een symlink hierheen (socev-thuis.py).
  # Doorlopen tot de map; in /opt/data/.claude zelf alles o-rwx (transcripts, instellingen, hooks), behalve memory.
  if [ -d "$D/.claude" ]; then
    find "$D/.claude" -path "$MEM" -prune -o ! -type l -user claude -perm /o=rwx -exec chmod o-rwx {} + 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    mkdir -p "$MEM" 2>/dev/null
    acl -m u:socev:x "$D/.claude" "$D/.claude/projects" "$D/.claude/projects/-opt-data-AI-SecondBrain"
    eigen "$MEM" | xargs -0 -r setfacl -P -m u:socev:rwX,m::rwX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    eigen "$MEM" -type d | xargs -0 -r setfacl -P -d -m u:socev:rwX,u:claude:rwX,m::rwX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
  fi
  touch "$STEMPEL" 2>/dev/null
  date '+%Y-%m-%d' > "$BIN/laatste-socev-rechten" 2>/dev/null
  log "klaar in $(( $(date +%s) - T0 )) s, fouten: $FOUTEN"
  exit 0
fi

if [ "$WAT" = "na-ronde" ]; then
  # Programma's die zelf een modus zetten (rclone, cp -p, editors) maken het ACL-masker krapper (Fable #4). Wat sinds de
  # vorige keer veranderde (ctime: rclone zet de mtime van Drive terug) krijgt het masker rwX terug. Alleen eigen bestanden.
  [ -d "$V" ] || exit 0
  NIEUW="$STEMPEL.nieuw"
  touch "$NIEUW" 2>/dev/null
  if [ -f "$STEMPEL" ]; then
    # Ook de socev-regel zelf: een bestand dat van buiten de vault binnen werd geschoven (mv uit /tmp) heeft geen ACL.
    vault_breed -cnewer "$STEMPEL" | xargs -0 -r setfacl -P -m u:socev:rwX,m::rwX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    vault_breed -type d -cnewer "$STEMPEL" | xargs -0 -r setfacl -P -d -m u:socev:rwX,u:claude:rwX,m::rwX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    for x in .claude .obsidian; do
      [ -d "$V/$x" ] && [ ! -L "$V/$x" ] || continue
      eigen "$V/$x" -cnewer "$STEMPEL" | xargs -0 -r setfacl -P -m u:socev:rX,m::rwX 2>/dev/null || FOUTEN=$((FOUTEN + 1))
    done
    eigen "$MEM" -cnewer "$STEMPEL" | xargs -0 -r setfacl -P -m u:socev:rwX,m::rwX 2>/dev/null || true
  fi
  mv -f "$NIEUW" "$STEMPEL" 2>/dev/null
  # Bewaakte plekken: is .claude of .obsidian opnieuw aangemaakt (bisync), dan heeft hij de rwX van de wortel geërfd.
  for x in .claude .obsidian; do
    if [ -d "$V/$x" ] && getfacl -cp "$V/$x" 2>/dev/null | grep -q '^user:socev:.w'; then log "$x had schrijfrecht voor socev: hersteld"; vault_bewaakt; fi
  done
  getfacl -cp "$V" 2>/dev/null | grep -q '^user:socev:.w' && { log "vault-wortel had schrijfrecht voor socev: hersteld"; vault_bewaakt; }
  vault_vreemde_codeplekken
  bin_en_log
  [ "$FOUTEN" = "0" ] || log "fouten: $FOUTEN"
  exit 0
fi

log "onbekende opdracht (vol | na-ronde)"
exit 2
