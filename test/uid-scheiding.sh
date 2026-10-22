#!/usr/bin/env bash
# uid-scheiding.sh <image> [chart.env] — uid-scheiding fase 1 (wv699) in een wegwerpcontainer van het image.
#
# Draait het ECHTE entrypoint.sh (met socev-voorbereiding.sh), alleen fetch-secrets.sh is vervangen door een doorgeefluik
# (`exec "$@"`) via een bind-mount in deze toets: er is in het image geen schakelaar om het laden van secrets over te slaan.
# Het volume krijgt vooraf nepbestanden op de plekken die op de pod gevoelig zijn, met de ruime modi van vandaag (umask 022).
# Daarna: als 1002 niets bij 1001, als 1002 wel de vault (behalve .claude/.obsidian), de loper alleen voor 1001, en 1001
# werkt als vandaag. Bouwplan "Socev-gesprekken onder eigen gebruiker - sleutelscheiding" § 3.7 fase 1 en § 5.
set -uo pipefail
IMAGE="$1"
ENVF="${2:-}"
HIER="$(cd "$(dirname "$0")" && pwd)"
C=uidtoets
VOL=uidtoets-vol
fout=0
ok(){ if bash -c "$2" >/dev/null 2>&1; then echo "  OK    $1"; else echo "  FOUT  $1"; fout=$((fout + 1)); fi; }
niet(){ if bash -c "$2" >/dev/null 2>&1; then echo "  FOUT  $1 (lukte, hoort te falen)"; fout=$((fout + 1)); else echo "  OK    $1"; fi; }
r(){ docker exec -u 0 "$C" bash -c "$1"; }
a(){ printf "docker exec -u 1001:1001 %s bash -c %q" "$C" "$1"; }   # als claude
s(){ printf "docker exec -u 1002:1002 %s bash -c %q" "$C" "$1"; }   # als socev
V=/opt/data/AI_SecondBrain
M=/opt/data/.claude/projects/-opt-data-AI-SecondBrain/memory
SM=/opt/data/socev-thuis/.claude/projects/-opt-data-AI-SecondBrain/memory

docker rm -f "$C" >/dev/null 2>&1; docker volume rm "$VOL" >/dev/null 2>&1
printf '#!/bin/sh\n# toets: geen kluis, keten gewoon doorgeven\nexec "$@"\n' > /tmp/nep-fetch-secrets.sh; chmod 755 /tmp/nep-fetch-secrets.sh

echo "== volume vullen zoals op de pod (alles van claude, umask 022) =="
docker run --rm -v "$VOL":/opt/data --entrypoint /bin/bash "$IMAGE" -c '
  set -e; umask 022; cd /opt/data
  mkdir -p bank/bunq mk-scripts socev-app-data bin io/mkjob/out AI_SecondBrain/.claude/skills/x AI_SecondBrain/.obsidian \
    AI_SecondBrain/00_Systeem .claude/projects/-opt-data-AI-SecondBrain/memory .claude/hooks .codex
  chmod 755 bank   # slechtste geval: op de pod is bank/ 0700, hier wereldleesbaar
  echo "{\"bunq_api_key\":\"NEP-CI\"}" > bank/bunq/staat.json
  printf "#!/bin/sh\necho mk\n" > mk-scripts/x.sh; chmod 755 mk-scripts/x.sh
  echo "{\"passkeys\":\"NEP-CI\"}" > socev-app-data/register.json
  echo "{\"mcpServers\":{}}" > .claude.json
  echo "{\"hooks\":{}}" > .claude/settings.json; echo "# hook" > .claude/hooks/h.py
  echo "skill" > AI_SecondBrain/.claude/skills/x/SKILL.md; echo "{}" > AI_SecondBrain/.claude/settings.local.json
  echo "{}" > AI_SecondBrain/.obsidian/app.json
  mkdir -p AI_SecondBrain/10_Zakelijk/huisbot/.claude AI_SecondBrain/00_Systeem/Lessen
  echo "{\"hooks\":{}}" > AI_SecondBrain/10_Zakelijk/huisbot/.claude/settings.json
  echo "console.log(1)" > AI_SecondBrain/00_Systeem/Lessen/les-vastleggen.mjs
  echo "gdrive:AI_SecondBrain" > AI_SecondBrain/.sync-id
  echo "inhoud" > AI_SecondBrain/00_Systeem/a.md; echo "persona" > AI_SecondBrain/CLAUDE.md
  echo "uitvoer machinekamer" > io/mkjob/out/r.txt
  echo "ronde ok" > bin/bisync.log; printf "#!/bin/sh\necho olares\n" > bin/olares-cli; chmod 755 bin/olares-cli
  echo "geheugen" > .claude/projects/-opt-data-AI-SecondBrain/memory/m.md
  echo "{\"tokens\":\"NEP-CI\"}" > .codex/auth.json; chmod 600 .codex/auth.json
  # wv785: bytecode, pakketten en Windows-code van claude in de vault, en een symlink van claude (die blijft)
  mkdir -p AI_SecondBrain/00_Systeem/py/__pycache__
  echo "print(1)" > AI_SecondBrain/00_Systeem/py/m.py; echo "pyc" > AI_SecondBrain/00_Systeem/py/__pycache__/m.cpython-311.pyc
  for f in oud.pyc pak.zip taak.ps1 Taak.BAT run.cmd x.vbs mod.psm1; do echo "code" > AI_SecondBrain/00_Systeem/$f; done
  ln -s a.md AI_SecondBrain/00_Systeem/claude-link
  chown -R 1001:1001 /opt/data
  # wv785: de oude Codex-loginkopie in de thuismap van socev (stond er sinds wv699)
  mkdir -p socev-thuis/.codex; echo "{\"tokens\":\"NEP-CI\"}" > socev-thuis/.codex/auth.json; chmod 600 socev-thuis/.codex/auth.json
  chown -R 1002:1002 socev-thuis'

start(){
  docker run -d --name "$C" -v "$VOL":/opt/data -v /tmp/nep-fetch-secrets.sh:/app/fetch-secrets.sh:ro \
    ${ENVF:+--env-file "$ENVF"} "$IMAGE" >/dev/null
  for i in $(seq 1 90); do
    if docker exec "$C" curl -fsS -m 3 http://127.0.0.1:8080/health -o /tmp/h.json 2>/dev/null; then echo "  /health na ${i}s"; return 0; fi
    sleep 1
  done
  echo "  FOUT  /health kwam niet"; docker logs "$C" 2>&1 | tail -40; return 1
}
loper(){ docker exec -u 1001:1001 "$C" node /tmp/loper-klant.js /run/socev-loper/loper.sock "$1" ${2:+--tot-einde "$2"}; }
# Samengestelde toetsen als functies (ok/niet draaien hun tweede argument in een nieuwe bash).
zonder_sleutels(){ r "tr '\\0' '\\n' < /proc/$1/environ" | grep -qE '^(API_SECRET|SUPABASE|AGENT_WEBHOOK|POD_BOOTSTRAP|TG_|N8N_)' && return 1; r "test -r /proc/$1/environ"; }
loper_status(){ r "cat /proc/$1/status" > /tmp/st.txt && grep -qE '^NoNewPrivs:\s*1' /tmp/st.txt && grep -qE '^CapBnd:\s*0+$' /tmp/st.txt \
  && grep -qE '^CapEff:\s*0+$' /tmp/st.txt && grep -qE '^Groups:\s*$' /tmp/st.txt && grep -qE '^Uid:\s*1002\s' /tmp/st.txt; }
managed(){
  [ "$(r 'stat -c "%U %a" /etc/claude-code/managed-settings.json')" = "root 644" ] || return 1
  [ "$(r 'stat -c %U /app/argv-wacht.py')" = "root" ] || return 1
  r 'cat /etc/claude-code/managed-settings.json' | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["allowManagedHooksOnly"] is True and d["hooks"]["PreToolUse"][0]["hooks"][0]["command"]=="python3 -I /app/argv-wacht.py" else 1)'
}
cli_managed(){ [ "$(r 'grep -a -c /etc/claude-code "$(readlink -f "$(command -v claude)")"')" -gt 0 ]; }
umask_server(){ r "grep -E '^Umask:' /proc/$1/status" | grep -q '0077'; }
stat_is(){ [ "$(r "stat -c '$2' $1")" = "$3" ]; }
export -f r loper zonder_sleutels loper_status managed cli_managed umask_server stat_is
export C

echo "== container starten met het echte entrypoint =="
start || exit 1
docker cp "$HIER/loper-klant.js" "$C":/tmp/loper-klant.js
docker cp "$HIER/argv-hook-toets.py" "$C":/tmp/argv-hook-toets.py
r 'chmod 644 /tmp/loper-klant.js /tmp/argv-hook-toets.py'
echo "-- containerlog (socev-regels) --"; docker logs "$C" 2>&1 | grep -E 'socev|loper' | head -20
ok "voorbereiding: rechten zonder fouten" "docker logs $C 2>&1 | grep -q 'socev-rechten vol: klaar in .* fouten: 0'"
ok "voorbereiding: thuismap ingericht" "docker logs $C 2>&1 | grep -q 'socev-thuis: klaar'"
ok "root-lus heeft de socket gebonden" "docker logs $C 2>&1 | grep -q 'loper-bind: socket /run/socev-loper/loper.sock gebonden'"

SERVER=$(r "pgrep -u 1001 -f 'node .*/server\.js' | head -1")
echo "  server.js pid: ${SERVER:-?}"
ok   "server.js draait als 1001"                             "[ -n '$SERVER' ] && stat_is /proc/$SERVER '%u' 1001"
[ -n "$SERVER" ] || { echo "  STOP  zonder server.js-pid zeggen de proc-toetsen niets"; docker logs "$C" 2>&1 | tail -30; exit 1; }

echo "== als 1002: niets van 1001 =="
niet "/proc/1/environ (run.sh, 1001) lezen"                 "$(s 'cat /proc/1/environ')"
niet "/proc/<server.js>/environ lezen"                       "$(s "cat /proc/$SERVER/environ")"
ok   "/proc/<server.js>/cmdline blijft leesbaar (DEKT NIET, § 3.6)" "$(s "cat /proc/$SERVER/cmdline")"
niet "/opt/data opsommen"                                    "$(s 'ls /opt/data')"
niet "bank/bunq/staat.json lezen (ook als bank/ 0755 is)"    "$(s 'cat /opt/data/bank/bunq/staat.json')"
niet "mk-scripts opsommen"                                   "$(s 'ls /opt/data/mk-scripts')"
niet "mk-scripts/x.sh lezen"                                 "$(s 'cat /opt/data/mk-scripts/x.sh')"
niet "socev-app-data (passkeys) lezen"                       "$(s 'cat /opt/data/socev-app-data/register.json')"
niet ".claude.json van 1001 lezen"                           "$(s 'cat /opt/data/.claude.json')"
niet ".claude/settings.json van 1001 lezen"                  "$(s 'cat /opt/data/.claude/settings.json')"
niet ".claude/projects van 1001 opsommen"                    "$(s 'ls /opt/data/.claude/projects')"
niet ".codex/auth.json van 1001 lezen"                       "$(s 'cat /opt/data/.codex/auth.json')"
niet "io opsommen"                                           "$(s 'ls /opt/data/io')"
niet "machinekamer-jobuitvoer in io lezen"                   "$(s 'cat /opt/data/io/mkjob/out/r.txt')"
niet "bin opsommen"                                          "$(s 'ls /opt/data/bin')"
niet "bin/olares-cli starten"                                "$(s '/opt/data/bin/olares-cli')"
ok   "bin/bisync.log lezen (nachtconsolidatie)"              "$(s 'cat /opt/data/bin/bisync.log')"

echo "== als 1002: vault wel, code-plekken niet =="
ok   ".claude/skills lezen"                                  "$(s "cat $V/.claude/skills/x/SKILL.md")"
niet ".claude/skills/x/SKILL.md wijzigen"                    "$(s "echo x >> $V/.claude/skills/x/SKILL.md")"
niet "nieuw bestand onder .claude/skills"                    "$(s "touch $V/.claude/skills/x/nieuw.mjs")"
niet ".claude/settings.local.json wijzigen"                  "$(s "echo '{}' > $V/.claude/settings.local.json")"
niet ".claude weg-hernoemen"                                 "$(s "mv $V/.claude $V/.claude-weg")"
niet ".mcp.json in de vault-wortel"                          "$(s "touch $V/.mcp.json")"
niet ".codex in de vault-wortel"                             "$(s "mkdir $V/.codex")"
niet ".obsidian wijzigen"                                    "$(s "echo x >> $V/.obsidian/app.json")"
niet ".sync-id wijzigen"                                     "$(s "echo x > $V/.sync-id")"
niet "geneste .claude (huisbot) wijzigen"                  "$(s "echo x >> $V/10_Zakelijk/huisbot/.claude/settings.json")"
for f in py/__pycache__/m.cpython-311.pyc oud.pyc pak.zip taak.ps1 Taak.BAT run.cmd x.vbs mod.psm1; do
  niet "$f van claude wijzigen (wv785)"                     "$(s "echo x >> $V/00_Systeem/$f")"
done
ok   "pak.zip en taak.ps1 van claude lezen"                  "$(s "cat $V/00_Systeem/pak.zip $V/00_Systeem/taak.ps1")"
niet "nieuw bestand in __pycache__ van claude (wv785)"       "$(s "echo x > $V/00_Systeem/py/__pycache__/n.cpython-311.pyc")"
niet "script in de vault (les-vastleggen.mjs) wijzigen"      "$(s "echo x >> $V/00_Systeem/Lessen/les-vastleggen.mjs")"
ok   "script in de vault lezen"                              "$(s "cat $V/00_Systeem/Lessen/les-vastleggen.mjs")"
ok   "DEKT NIET: script verwijderen en opnieuw schrijven lukt (map is rwX; signaal in het log, geen slot; fase 2: scripts verhuizen)" "$(s "cp $V/00_Systeem/Lessen/les-vastleggen.mjs /tmp/l.mjs && rm -f $V/00_Systeem/Lessen/les-vastleggen.mjs && cp /tmp/l.mjs $V/00_Systeem/Lessen/les-vastleggen.mjs")"
niet "CLAUDE.md in de wortel verwijderen"                    "$(s "rm -f $V/CLAUDE.md; [ ! -e $V/CLAUDE.md ]")"
ok   "CLAUDE.md in de wortel bewerken (in place)"            "$(s "echo socev >> $V/CLAUDE.md")"
ok   "nieuw bestand in 00_Systeem"                           "$(s "echo nieuw > $V/00_Systeem/socev.md")"
ok   "bestaand bestand in 00_Systeem wijzigen"               "$(s "echo erbij >> $V/00_Systeem/a.md")"
ok   "submap + bestand maken"                                "$(s "mkdir -p $V/00_Systeem/sub && echo y > $V/00_Systeem/sub/f.md")"
ok   "1001 leest en wijzigt wat 1002 maakte"                 "$(a "cat $V/00_Systeem/socev.md && echo z >> $V/00_Systeem/socev.md && echo q >> $V/00_Systeem/sub/f.md && cat $V/00_Systeem/sub/f.md")"
ok   "1002 wijzigt wat 1001 met umask 077 maakte"            "$(a "umask 077; echo c > $V/00_Systeem/van-claude.md && mkdir $V/00_Systeem/cmap && echo d > $V/00_Systeem/cmap/e.md")"
ok   "  (vervolg) 1002 schrijft erin"                        "$(s "echo s >> $V/00_Systeem/van-claude.md && echo s >> $V/00_Systeem/cmap/e.md && touch $V/00_Systeem/cmap/nieuw")"
ok   "1001 ruimt submap van 1002 op"                         "$(a "rm -r $V/00_Systeem/sub")"

echo "== gedeeld geheugen =="
ok   "1002 schrijft in memory via de symlink"                "$(s "echo m2 >> $SM/m.md && echo n > $SM/nieuw.md")"
ok   "1001 leest en wijzigt dat"                             "$(a "grep -q m2 $M/m.md && cat $M/nieuw.md && echo o >> $M/nieuw.md")"

echo "== maskerherstel (rclone, cp -p) en code-plekken dieper in de vault =="
ok   "rclone (als 1001, umask 077 zoals run.sh) schrijft in de vault" "$(a "umask 077; echo r > /tmp/r.md && rclone copyto /tmp/r.md $V/00_Systeem/rclone.md")"
ok   "  1002 kan het rclone-bestand wijzigen"                "$(s "echo s >> $V/00_Systeem/rclone.md")"
ok   "cp -p van een 0644-bestand (als 1001)"                 "$(a "echo p > /tmp/p.md && chmod 644 /tmp/p.md && cp -p /tmp/p.md $V/00_Systeem/cpp.md")"
if bash -c "$(s "test -w $V/00_Systeem/cpp.md")" >/dev/null 2>&1; then echo "  info  cp -p-bestand was al schrijfbaar voor 1002"; else echo "  info  cp -p-bestand vóór herstel niet schrijfbaar voor 1002 (masker r--), zoals verwacht"; fi
ok   "1002 legt symlinks in de vault naar 1001-bestanden"    "$(s "ln -s /opt/data/.claude.json $V/00_Systeem/naar-claude-json && ln -s /opt/data/mk-scripts $V/00_Systeem/naar-mk")"
ok   "1002 legt een symlink binnen de vault en een in het gedeelde geheugen" "$(s "ln -s a.md $V/00_Systeem/naar-a && mkdir -p $V/00_Systeem/diep/er && ln -s /opt/data/bank $V/00_Systeem/diep/er/naar-bank && ln -s /opt/data/.claude.json $SM/MEMORY-link.md")"
ok   "1002 zet een .claude-map in een submap"                "$(s "mkdir -p $V/00_Systeem/.claude && echo '{}' > $V/00_Systeem/.claude/settings.json")"
ok   "1002 zet Windows-code, bytecode en een zip in de vault (wv785)" "$(s "echo x > $V/00_Systeem/nieuw.ps1 && echo x > $V/00_Systeem/Start.CMD && echo x > $V/00_Systeem/los.pyc && mkdir -p $V/00_Systeem/sub3/__pycache__ && echo x > $V/00_Systeem/sub3/__pycache__/z.cpython-311.pyc && echo x > $V/00_Systeem/eigen.zip")"
ok   "1002 probeert de uitzondering: x.socev-geblokkeerd-9.ps1, map *.socev-geblokkeerd-1/ met .bat, en een .js" "$(s "echo x > $V/00_Systeem/x.socev-geblokkeerd-9.ps1 && mkdir -p $V/00_Systeem/m.socev-geblokkeerd-1 && echo x > $V/00_Systeem/m.socev-geblokkeerd-1/y.bat && echo x > $V/00_Systeem/z.js")"
ok   "geleend eigendom — 1002 vult een bestand van 1001 en hernoemt het naar .ps1 (kan; het syncfilter houdt het van Drive, wv813)" "$(a "echo leen > $V/00_Systeem/leen.md") && $(s "echo 'Write-Host x' > $V/00_Systeem/leen.md && mv $V/00_Systeem/leen.md $V/00_Systeem/geleend.ps1")"
ok   "DEKT NIET: 1002 hernoemt __pycache__ van 1001 weg en zet een eigen neer (map is rwX)" "$(s "mv $V/00_Systeem/py/__pycache__ $V/00_Systeem/py/pyc-weg && mkdir $V/00_Systeem/py/__pycache__ && echo vals > $V/00_Systeem/py/__pycache__/m.cpython-311.pyc")"
ok   "na-ronde (als 1001)"                                   "$(a "bash /app/socev-rechten.sh na-ronde > /tmp/na-ronde.log 2>&1")"
r 'cat /tmp/na-ronde.log' | sed 's/^/    | /' | head -20
ok   "  1002 kan cp -p-bestand na maskerherstel wijzigen"    "$(s "echo s >> $V/00_Systeem/cpp.md")"
ok   "  symlinks niet gevolgd: .claude.json en mk-scripts zonder socev-ACL" "$(a "! getfacl -cp /opt/data/.claude.json /opt/data/mk-scripts 2>/dev/null | grep -q socev")"
niet "  1002 leest .claude.json via de symlink"              "$(s "cat $V/00_Systeem/naar-claude-json")"
ok   "  .claude van socev in de submap hernoemd"             "$(a "[ ! -e $V/00_Systeem/.claude ] && ls -d $V/00_Systeem/.claude.socev-geblokkeerd-*")"
ok   "  symlinks van socev weg (vault, diep, memory), doelen ongemoeid (wv785)" "$(a "for l in $V/00_Systeem/naar-claude-json $V/00_Systeem/naar-mk $V/00_Systeem/naar-a $V/00_Systeem/diep/er/naar-bank $M/MEMORY-link.md; do [ ! -L \$l ] && [ ! -e \$l ] || exit 1; done; [ -f /opt/data/.claude.json ] && [ -d /opt/data/mk-scripts ] && [ -f $V/00_Systeem/a.md ] && [ -d /opt/data/bank ]")"
ok   "  symlink van claude blijft"                           "$(a "[ -L $V/00_Systeem/claude-link ]")"
ok   "  logregel per weggehaalde symlink, met het doel"      "[ \"\$(r 'grep -c \"symlink van socev weg: .* -> \" /tmp/na-ronde.log')\" = 5 ] && r 'grep -q \"naar-bank -> /opt/data/bank\" /tmp/na-ronde.log'"
ok   "  Windows-code van socev hernoemd (nieuw.ps1, Start.CMD)" "$(a "[ ! -e $V/00_Systeem/nieuw.ps1 ] && [ ! -e $V/00_Systeem/Start.CMD ] && ls $V/00_Systeem/nieuw.ps1.socev-geblokkeerd-* $V/00_Systeem/Start.CMD.socev-geblokkeerd-*")"
ok   "  ook met 'socev-geblokkeerd' in de naam, in een geblokkeerde map, en *.js (Fable wv785 #1, #8)" "$(a "[ ! -e $V/00_Systeem/x.socev-geblokkeerd-9.ps1 ] && [ ! -e $V/00_Systeem/m.socev-geblokkeerd-1/y.bat ] && [ ! -e $V/00_Systeem/z.js ] && ls $V/00_Systeem/z.js.socev-geblokkeerd-*")"
ok   "  geleend eigendom: blijft in de vault staan en wordt gemeld (Drive: zie syncfilter hieronder)" "$(a "[ -f $V/00_Systeem/geleend.ps1 ]") && r 'grep -q \"Windows-code nieuw of gewijzigd (niet van socev): .*geleend.ps1\" /tmp/na-ronde.log'"
ok   "  geen 'mislukt' bij het hernoemen"                    "! r 'grep -q \"(van socev) mislukt\" /tmp/na-ronde.log'"
ok   "  bytecode van socev weg (los.pyc, __pycache__ in sub3 en py)" "$(a "[ ! -e $V/00_Systeem/los.pyc ] && [ ! -e $V/00_Systeem/sub3/__pycache__ ] && [ ! -e $V/00_Systeem/py/__pycache__ ]")"
ok   "  zip van socev blijft (alleen gemeld)"                "$(a "[ -f $V/00_Systeem/eigen.zip ]") && r 'grep -q \"code van socev in de vault: .*eigen.zip\" /tmp/na-ronde.log'"
ok   "  na-ronde zonder fouten"                              "! r 'grep -q fouten: /tmp/na-ronde.log'"

echo "== syncfilter (wv813): geleend eigendom komt niet op Drive (en dus niet op Davids pc) =="
ok   "run.sh toetste het syncfilter vóór de sync-lus"        "r 'grep -q \"bisync-filter-toets: ok\" /opt/data/bin/bisync.log'"
ok   "filter en zelftoets van root (0644), 1002 kan ze niet wijzigen" "stat_is /app/bisync-filter.txt '%U %a' 'root 644' && stat_is /app/bisync-filter-toets.sh '%U %a' 'root 644' && $(s '! test -w /app/bisync-filter.txt && ! test -w /app')"
ok   "zelftoets in het image, met de WINCODE-lijst van het image" "$(a 'bash /app/bisync-filter-toets.sh /app/bisync-filter.txt /app/socev-rechten.sh')"
ok   "bisync als 1001 met het filter (zoals run.sh) naar een nep-Drive: eerste koppeling" "$(a "mkdir -p /tmp/drive && rclone bisync /tmp/drive $V --filter-from /app/bisync-filter.txt --resync --resync-mode newer --create-empty-src-dirs --workdir /tmp/bwd > /tmp/bisync-toets.log 2>&1")"
ok   "  geleend eigendom: geleend.ps1 (van claude, door 1002 gevuld) niet op Drive — was DEKT NIET (Fable wv785 #2)" "$(a "[ -f $V/00_Systeem/geleend.ps1 ] && [ ! -e /tmp/drive/00_Systeem/geleend.ps1 ]")"
ok   "  scripts en Windows-code van claude niet op Drive"   "$(a "for f in taak.ps1 Taak.BAT run.cmd x.vbs mod.psm1 oud.pyc py/m.py py/pyc-weg/m.cpython-311.pyc Lessen/les-vastleggen.mjs; do [ ! -e /tmp/drive/00_Systeem/\$f ] || exit 1; done; [ ! -e /tmp/drive/10_Zakelijk/huisbot/.claude ]")"
ok   "  documenten, wortel-.claude en .obsidian wel op Drive" "$(a "[ -f /tmp/drive/00_Systeem/a.md ] && [ -f /tmp/drive/CLAUDE.md ] && [ -f /tmp/drive/.claude/skills/x/SKILL.md ] && [ -f /tmp/drive/.obsidian/app.json ]")"
ok   "1002 vult nog een bestand van 1001 en hernoemt het naar .mjs (wat de pc-taak Tokenboekhouding draaide)" "$(a "mkdir -p $V/00_Systeem/Tokens && echo '{}' > $V/00_Systeem/Tokens/prijzen.json") && $(s "echo 'import x' > $V/00_Systeem/Tokens/prijzen.json && mv $V/00_Systeem/Tokens/prijzen.json $V/00_Systeem/Tokens/verzamel-claude.mjs")"
ok   "  volgende ronde: niet op Drive, prijzen.json wel van Drive weg" "$(a "rclone bisync /tmp/drive $V --filter-from /app/bisync-filter.txt --create-empty-src-dirs --workdir /tmp/bwd >> /tmp/bisync-toets.log 2>&1 && [ ! -e /tmp/drive/00_Systeem/Tokens/verzamel-claude.mjs ] && [ ! -e /tmp/drive/00_Systeem/Tokens/prijzen.json ] && [ -f $V/00_Systeem/Tokens/verzamel-claude.mjs ]")"

echo "== loper-socket =="
ok   "map /run/socev-loper root 0755"                        "stat_is /run/socev-loper '%U:%G %a' 'root:root 755'"
ok   "socket root:claude 0660"                               "stat_is /run/socev-loper/loper.sock '%U:%G %a' 'root:claude 660'"
ok   "1002 kan niet verbinden (EACCES)"                      "$(s "node -e \"require('net').connect('/run/socev-loper/loper.sock').on('error',e=>process.exit(e.code==='EACCES'?0:1)).on('connect',()=>process.exit(1))\"")"
niet "1002 kan de socket niet weghalen of vervangen"        "$(s 'rm -f /run/socev-loper/loper.sock || exit 1; [ ! -e /run/socev-loper/loper.sock ]')"
PING=$(loper '{"op":"ping"}')
echo "  ping: $PING"
LOPER=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["antwoorden"][0]["pid"])' "$PING" 2>/dev/null)
ok   "1001 bereikt de loper, die draait als 1002"            "python3 -c 'import json,sys; a=json.loads(sys.argv[1])[\"antwoorden\"][0]; sys.exit(0 if a[\"ok\"] and a[\"uid\"]==1002 and a[\"gid\"]==1002 else 1)' '$PING'"
ok   "loper-versie wv785-1 (volg in één tick, socket-eigenaar)" "grep -q '\"versie\":\"wv785-1\"' <<<'$PING'"
ok   "loper: uid 1002, NoNewPrivs 1, geen capabilities, geen groepen" "loper_status $LOPER"
ok   "loper-omgeving zonder pod-sleutels"                    "zonder_sleutels $LOPER"
LUS=$(r "pgrep -u 0 -f loper-bind.py | head -1")
ok   "root-lus draait als root met lege omgeving"            "[ -n '$LUS' ] && zonder_sleutels $LUS"
niet "1001 leest de omgeving van de loper niet"             "$(a "cat /proc/$LOPER/environ")"
START=$(loper '{"op":"start","id":"versie","brein":"claude","args":["--version"],"cwd":"/opt/data/AI_SecondBrain","env":{"PATH":"/usr/local/bin:/usr/bin:/bin"}}' versie)
echo "  claude --version via de loper: $START" | cut -c1-300
ok   "1001 start via de socket claude --version als 1002"   "python3 -c 'import json,re,sys; u=json.loads(sys.argv[1]); sys.exit(0 if u[\"einde\"]==dict(code=0,signaal=None) and re.search(r\"\\d+\\.\\d+\\.\\d+\", u[\"uit\"]) else 1)' '$START'"
U=$(loper '{"op":"start","id":"envtoets","brein":"claude","args":["--version"],"cwd":"/opt/data/AI_SecondBrain","env":{"N8N_API_KEY":"x"}}')
ok   "loper weigert een pod-sleutel in env"                  "grep -q env-geweigerd <<<'$U'"
U=$(loper '{"op":"start","id":"cwdtoets","brein":"claude","args":["--version"],"cwd":"/opt/data"}')
ok   "loper weigert cwd /opt/data"                           "grep -q cwd-geweigerd <<<'$U'"
ok   "1002 kan de loper stoppen (hinder, geen inbraak)"      "$(s "kill $LOPER")"
T0=$(date +%s); NIEUW=""
for i in $(seq 1 25); do
  P2=$(loper '{"op":"ping"}' 2>/dev/null)
  NIEUW=$(python3 -c 'import json,sys; a=json.loads(sys.argv[1])["antwoorden"]; print(a[0]["pid"] if a and a[0].get("ok") else "")' "$P2" 2>/dev/null)
  [ -n "$NIEUW" ] && [ "$NIEUW" != "$LOPER" ] && break
  sleep 0.2
done
DUUR=$(( $(date +%s) - T0 ))
ok   "loper binnen 5 s terug (${DUUR}s, pid $LOPER -> ${NIEUW:-?})" "[ -n '$NIEUW' ] && [ '$NIEUW' != '$LOPER' ] && [ $DUUR -le 5 ]"

echo "== thuismap van socev =="
ok   "socev-thuis van socev, 0750"                           "stat_is /opt/data/socev-thuis '%U:%G %a' 'socev:socev 750'"
ok   ".claude.json: pubmed, todoist, playwright; geen n8n of supabase" "$(s "python3 -c \"import json; d=json.load(open('/opt/data/socev-thuis/.claude.json')); import sys; sys.exit(0 if sorted(d['mcpServers'])==['playwright','pubmed','todoist'] and d['mcpServers']['playwright']['command']=='/app/playwright-mcp.sh' else 1)\"")"
ok   "codex-config zonder supabase/n8n"                      "$(s "! grep -qE '^\[mcp_servers\.(supabase|n8n)' /opt/data/socev-thuis/.codex/config.toml && grep -q '^\[mcp_servers\.todoist' /opt/data/socev-thuis/.codex/config.toml")"
ok   "geen Codex-loginkopie meer in socev-thuis (wv785)"     "! r 'test -e /opt/data/socev-thuis/.codex/auth.json'"
ok   "  oude kopie weggehaald en gelogd"                     "docker logs $C 2>&1 | grep -q 'socev-thuis: codex-loginkopie weggehaald (auth.json)'"
ok   "  login van 1001 ongemoeid"                            "$(a "grep -q NEP-CI /opt/data/.codex/auth.json")"
ok   "codex-config en AGENTS.md wel op hun plek"             "r 'test -f /opt/data/socev-thuis/.codex/config.toml && test -L /opt/data/socev-thuis/.codex/AGENTS.md'"
ok   "eigen TMPDIR 0700"                                     "stat_is /opt/data/socev-thuis/tmp '%U %a' 'socev 700'"
ok   "memory-symlink op zijn plek"                           "[ \"\$(r 'readlink $SM')\" = '$M' ]"
ok   "1001 kan de thuismap zien, niet erin schrijven"        "$(a 'ls /opt/data/socev-thuis >/dev/null && ! touch /opt/data/socev-thuis/x')"

echo "== 1001 zoals vandaag =="
ok   "server.js met umask 0077"                              "umask_server $SERVER"
ok   "/health ok"                                            "docker exec $C curl -fsS -m 3 http://127.0.0.1:8080/health | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)[\"ok\"] is True else 1)'"
ok   "1001 leest zijn eigen bestanden nog"                   "$(a 'cat /opt/data/bank/bunq/staat.json /opt/data/mk-scripts/x.sh /opt/data/socev-app-data/register.json /opt/data/.claude.json /opt/data/io/mkjob/out/r.txt')"
ok   "managed settings: root, hook python3 -I /app/argv-wacht.py, allowManagedHooksOnly" "managed"
ok   "argv-hook in het image: 24 weigeren + 22 doorlaten"   "$(a 'python3 /tmp/argv-hook-toets.py /app/argv-wacht.py')"
ok   "CLI-binary noemt /etc/claude-code (string; of de hook vuurt, meet fase 2 in de pod)" "cli_managed"

echo "== herstart: idempotent, eigendom blijft =="
docker restart "$C" >/dev/null
sleep 2
for i in $(seq 1 90); do docker exec "$C" curl -fsS -m 3 http://127.0.0.1:8080/health >/dev/null 2>&1 && break; sleep 1; done
ok   "tweede start: rechten zonder fouten"                   "[ \"\$(docker logs $C 2>&1 | grep -c 'socev-rechten vol: klaar in .* fouten: 0')\" = 2 ]"
ok   "tweede start: niets opzij gezet"                       "! docker exec $C bash -c 'ls -d /opt/data/socev-thuis.weg-* /opt/data/socev-thuis/*.weg-* /opt/data/socev-thuis/.claude/projects/*/*.weg-* 2>/dev/null | grep -q .'"
ok   "bestand van socev in de vault blijft van socev"        "stat_is $V/00_Systeem/socev.md '%U' socev"
ok   "thuismap blijft van socev (chown slaat hem over)"      "stat_is /opt/data/socev-thuis/.claude.json '%U' socev"
niet "na herstart: 1002 nog steeds niet bij staat.json"      "$(s 'cat /opt/data/bank/bunq/staat.json')"
ok   "na herstart: loper bereikbaar"                         "loper '{\"op\":\"ping\"}' | grep -q '\"uid\":1002'"

docker logs "$C" 2>&1 | grep -E 'socev|loper' | tail -8
docker rm -f "$C" >/dev/null 2>&1; docker volume rm "$VOL" >/dev/null 2>&1
echo "uid-scheiding: $fout fout(en)"
[ "$fout" = 0 ]
