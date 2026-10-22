#!/usr/bin/env bash
# bisync-filter.sh [filter] [run.sh] — het vault-syncfilter (wv813) met een echte rclone bisync tussen twee proefmappen.
#
# WAAROM. bisync-filter.txt moet voorkomen dat een script of Windows-codebestand uit de vault op Google Drive en zo op Davids
# pc komt, ook als het bestand van claude is ("geleend eigendom": socev vult een claude-bestand en hernoemt het; Fable wv785
# #2) en ook in de 5 minuten voordat socev-rechten.sh een eigen bestand van socev hernoemt. Deze toets bewijst dat met een
# echte bisync (local ↔ local, zoals run.sh hem draait), plus de zelftoets en dat run.sh het filter overal meegeeft.
# Geen docker nodig: lokaal op de pod (`bash test/bisync-filter.sh`) en in CI in het image (filter /app/bisync-filter.txt).
set -uo pipefail
HIER="$(cd "$(dirname "$0")/.." && pwd)"
F="${1:-$HIER/bisync-filter.txt}"
RUN="${2:-$HIER/run.sh}"
TOETS="$(dirname "$F")/bisync-filter-toets.sh"; [ -r "$TOETS" ] || TOETS="$HIER/bisync-filter-toets.sh"
RECHTEN="$(dirname "$F")/socev-rechten.sh"; [ -r "$RECHTEN" ] || RECHTEN="$HIER/socev-rechten.sh"
export RCLONE_CONFIG=/dev/null
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fout=0; goed=0
ok(){ if bash -c "$2" >/dev/null 2>&1; then echo "  OK    $1"; goed=$((goed + 1)); else echo "  FOUT  $1"; fout=$((fout + 1)); fi; }
export T F

echo "== zelftoets =="
ok "bisync-filter-toets: het echte filter, met de WINCODE-lijst van socev-rechten.sh" "bash '$TOETS' '$F' '$RECHTEN'"
printf -- '- {{\\.ps1$}}\n- *.py\n' > "$T/kapot.txt"
ok "  weigert een filter dat niet past ({{\\.ps1\$}} laat alles door)" "! bash '$TOETS' '$T/kapot.txt'"
ok "  weigert een leeg filter"                                  ": > '$T/leeg.txt'; ! bash '$TOETS' '$T/leeg.txt'"
ok "  weigert een ontbrekend filter"                            "! bash '$TOETS' '$T/bestaat-niet.txt'"
printf -- '+ **\n' > "$T/alles.txt"
ok "  weigert een filter dat alles toelaat"                     "! bash '$TOETS' '$T/alles.txt'"

echo "== echte bisync: vault (path2) met code van claude, Drive (path1) leeg =="
D="$T/drive"; V="$T/vault"; W="$T/werk"; export D V W
mkdir -p "$D" "$V/00_Systeem/Tokens" "$V/01_Ontwikkeling/0b-werkmap" "$V/.claude/skills/x" "$V/.obsidian" "$V/10_Zakelijk/huisbot/.claude"
echo notitie > "$V/00_Systeem/a.md"; echo '{}' > "$V/00_Systeem/Tokens/prijzen.json"; echo leen > "$V/00_Systeem/leen.md"
echo leen2 > "$V/00_Systeem/leen2.md"
echo 'print(1)' > "$V/01_Ontwikkeling/0b-werkmap/outlook_meelezen.py"; echo 'x' > "$V/01_Ontwikkeling/0b-werkmap/taak.ps1"
echo skill > "$V/.claude/skills/x/SKILL.md"; echo 'print(2)' > "$V/.claude/skills/x/s.py"; echo '{}' > "$V/.obsidian/app.json"
echo '{"hooks":{}}' > "$V/10_Zakelijk/huisbot/.claude/settings.json"; echo pdf > "$V/00_Systeem/stuk.pdf"
bis(){ rclone bisync "$D" "$V" --filter-from "$F" --create-empty-src-dirs --conflict-resolve newer --resilient --recover \
         --max-lock 2m --workdir "$W" "$@" >> "$T/bisync.log" 2>&1; }
export -f bis
# Overgang zoals bij de herstart naar dit image (Fable wv813 #4): listings van vandaag (zonder filter), dan een ronde mét.
ok "overgang: koppeling zónder filter (listings zoals vandaag op de pod)" "rclone bisync \$D \$V --resync --resync-mode newer --create-empty-src-dirs --workdir \$W >> \$T/bisync.log 2>&1 && [ -f \$D/01_Ontwikkeling/0b-werkmap/taak.ps1 ]"
: > "$T/bisync.log"
ok "  eerste ronde mét filter: geslaagd, geen resync nodig, niets gewist aan een van beide kanten" "bis -v && grep -q 'Bisync successful' \$T/bisync.log && ! grep -q 'Must run --resync' \$T/bisync.log && [ -f \$D/01_Ontwikkeling/0b-werkmap/taak.ps1 ] && [ -f \$V/01_Ontwikkeling/0b-werkmap/taak.ps1 ] && [ -f \$D/01_Ontwikkeling/0b-werkmap/outlook_meelezen.py ]"
ok "  tweede ronde: geen wijzigingen" "bis -v && tail -20 \$T/bisync.log | grep -q 'No changes found'"
# Daarna een verse Drive-kant, zodat de rest meet wat het filter zelf doet (en niet wat er van vóór het filter stond).
rm -rf "$D" "$W"; mkdir -p "$D"
ok "eerste koppeling: resync --resync-mode newer met het filter (zoals zelfherstel en SYNC_INIT)" "bis --resync --resync-mode newer"
ok "  documenten en de wortel-.claude/.obsidian staan op Drive" "[ -f \$D/00_Systeem/a.md ] && [ -f \$D/00_Systeem/stuk.pdf ] && [ -f \$D/.claude/skills/x/SKILL.md ] && [ -f \$D/.claude/skills/x/s.py ] && [ -f \$D/.obsidian/app.json ]"
ok "  geen code van de vault op Drive (.py, .ps1, geneste .claude)" "[ ! -e \$D/01_Ontwikkeling/0b-werkmap/outlook_meelezen.py ] && [ ! -e \$D/01_Ontwikkeling/0b-werkmap/taak.ps1 ] && [ ! -e \$D/10_Zakelijk/huisbot/.claude ]"

echo "== aanval vanuit de vault (wat een socev-gesprek kan) =="
# geleend eigendom: een bestand vullen en hernoemen; een nieuw script op de plek die de pc-taak draait; Windows-varianten
echo 'Write-Host x' > "$V/00_Systeem/leen.md"; mv "$V/00_Systeem/leen.md" "$V/00_Systeem/geleend.ps1"
echo 'import x' > "$V/00_Systeem/leen2.md"; mv "$V/00_Systeem/leen2.md" "$V/00_Systeem/Tokens/verzamel-claude.mjs"
echo x > "$V/00_Systeem/Tokens/tokens_pc.PS1. "; echo x > "$V/00_Systeem/Start.CmD."; echo x > "$V/00_Systeem/snelkoppeling.lnk"
mkdir -p "$V/00_Systeem/.Claude" "$V/00_Systeem/.vscode"; echo '{"hooks":{}}' > "$V/00_Systeem/.Claude/settings.json"
echo '{}' > "$V/00_Systeem/.vscode/tasks.json"; printf '[.ShellClassInfo]\nIconResource=\\\\x\\y\n' > "$V/00_Systeem/desktop.ini"
echo x > "$V/00_Systeem/evil.msı"; mkdir -p "$V/00_Systeem/repo/.git"; echo '[core]' > "$V/00_Systeem/repo/.git/config"   # Fable wv813 #1, #2
echo 'print(3)' >> "$V/01_Ontwikkeling/0b-werkmap/outlook_meelezen.py"   # bestaand script gewijzigd
echo 'nieuw' >> "$V/00_Systeem/a.md"                                       # gewone wijziging
echo 'vanpc' > "$D/00_Systeem/vanpc.py"; echo 'pc-notitie' > "$D/00_Systeem/pc.md"   # pc-kant
ok "gewone bisync-ronde met het filter" "bis"
ok "  geleend eigendom (md → .ps1) niet op Drive"            "[ ! -e \$D/00_Systeem/geleend.ps1 ]"
ok "  en de oude naam is van Drive weg (hernoemen = verwijderen + nieuw)" "[ ! -e \$D/00_Systeem/leen.md ]"
ok "  verzamel-claude.mjs (wat de pc-taak draaide) niet op Drive" "[ ! -e \$D/00_Systeem/Tokens/verzamel-claude.mjs ]"
ok "  Windows-varianten (tokens_pc.PS1. , Start.CmD., .lnk) niet op Drive" "[ -z \"\$(ls \$D/00_Systeem/Tokens | grep -i ps1)\" ] && [ -z \"\$(ls \$D/00_Systeem | grep -iE 'cmd|lnk')\" ]"
ok "  geneste .Claude/.vscode/.git, desktop.ini en .msı (Turkse ı) niet op Drive" "[ ! -e \$D/00_Systeem/.Claude ] && [ ! -e \$D/00_Systeem/.vscode ] && [ ! -e \$D/00_Systeem/desktop.ini ] && [ ! -e \$D/00_Systeem/repo/.git/config ] && [ -z \"\$(ls \$D/00_Systeem | grep 'evil')\" ]"
ok "  gewijzigd script niet over, gewone wijziging wel"       "[ ! -e \$D/01_Ontwikkeling/0b-werkmap/outlook_meelezen.py ] && grep -q nieuw \$D/00_Systeem/a.md"
ok "  pc-kant: notitie wel in de vault, .py niet"             "[ -f \$V/00_Systeem/pc.md ] && [ ! -e \$V/00_Systeem/vanpc.py ]"
ok "  niets gewist: vault-kant houdt al zijn bestanden"       "[ -f \$V/00_Systeem/geleend.ps1 ] && [ -f \$V/00_Systeem/Tokens/verzamel-claude.mjs ] && [ -f \$V/01_Ontwikkeling/0b-werkmap/taak.ps1 ] && [ -f \$D/00_Systeem/vanpc.py ]"
ok "zelfherstel-resync met het filter zet ze ook niet over"   "bis --resync --resync-mode newer && [ ! -e \$D/00_Systeem/geleend.ps1 ] && [ ! -e \$D/00_Systeem/Tokens/verzamel-claude.mjs ]"
echo nieuw > "$V/00_Systeem/droog.md"; echo 'Write-Host' > "$V/00_Systeem/droog.ps1"; : > "$T/bisync.log"
ok "dry-run (toets uit de opdracht): nieuw .md wel genoemd, nieuw .ps1 en de aanvalsbestanden niet" "bis --dry-run -v; grep -q 'droog\\.md' \$T/bisync.log && ! grep -qE 'droog\\.ps1|geleend\\.ps1|verzamel-claude\\.mjs|tokens_pc' \$T/bisync.log && [ ! -e \$D/00_Systeem/droog.md ]"
ok "controle: zónder filter gaat geleend.ps1 wél mee (de toets kan falen)" "rclone bisync \$D \$V --resync --resync-mode newer --workdir \$T/w2 >/dev/null 2>&1 && [ -f \$D/00_Systeem/geleend.ps1 ]"

echo "== run.sh geeft het filter overal mee =="
export RUN
ok "elke rclone bisync-aanroep in run.sh heeft het filter"    "[ \"\$(grep -vE '^\\s*#' \"\$RUN\" | grep -c 'rclone bisync')\" -ge 4 ] && ! grep -vE '^\\s*#' \"\$RUN\" | grep 'rclone bisync' | grep -vqE 'FILTER\\[@\\]|--filter-from'"
ok "  filter en zelftoets vast op /app (niet via de omgeving)" "grep -qx 'SYNC_FILTER=/app/bisync-filter.txt' \"\$RUN\" && grep -qx 'SYNC_FILTER_TOETS=/app/bisync-filter-toets.sh' \"\$RUN\""
ok "  zelftoets vóór de eerste bisync, anders SYNC STOP"     "awk '/^sync_lus\\(\\)/{s=1} s&&/SYNC_FILTER_TOETS/{t=NR} s&&/rclone bisync/&&!b{b=NR} END{exit !(t && b && t<b)}' \"\$RUN\" && grep -q 'SYNC STOP: syncfilter' \"\$RUN\""
# codeplek_dicht uit run.sh, los gedraaid op een proefvault (Fable wv813 #6)
sed -n '/^codeplek_dicht()/,/^}/p' "$RUN" > "$T/grendel.sh"; export GV="$T/gv"
mkdir -p "$GV/.claude/skills/x" "$GV/.obsidian"; echo s > "$GV/.claude/skills/x/SKILL.md"
ok "  ronde overgeslagen als codeplek_dicht faalt"           "grep -A3 '^sync_ronde()' \"\$RUN\" | grep -q 'codeplek_dicht'"
ok "  codeplek_dicht: .claude/.obsidian zonder socev-schrijfrecht = dicht" "VAULT=\$GV; . \$T/grendel.sh; codeplek_dicht"
if id socev >/dev/null 2>&1 && command -v setfacl >/dev/null; then
  ok "  codeplek_dicht: socev rw op een skillbestand = open (ronde overslaan)" "setfacl -m u:socev:rw \$GV/.claude/skills/x/SKILL.md && VAULT=\$GV; . \$T/grendel.sh; ! codeplek_dicht"
  ok "  codeplek_dicht: standaard-ACL socev rwx op .obsidian = open" "setfacl -x u:socev \$GV/.claude/skills/x/SKILL.md && setfacl -d -m u:socev:rwx \$GV/.obsidian && VAULT=\$GV; . \$T/grendel.sh; ! codeplek_dicht"
else
  echo "  info  geen gebruiker socev of setfacl hier: ACL-gevallen alleen in uid-scheiding.sh"
fi
DF="$HIER/Dockerfile"; export DF
if [ -r "$DF" ]; then
  ok "Dockerfile zet filter en zelftoets in /app (root)"   "grep -q 'COPY bisync-filter.txt bisync-filter-toets.sh /app/' \"\$DF\" && grep -q '/app/bisync-filter.txt /app/bisync-filter-toets.sh' \"\$DF\""
fi

echo "bisync-filter: $goed OK, $fout fout(en)"
[ "$fout" = 0 ]
