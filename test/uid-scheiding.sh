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
  echo "gdrive:AI_SecondBrain" > AI_SecondBrain/.sync-id
  echo "inhoud" > AI_SecondBrain/00_Systeem/a.md; echo "persona" > AI_SecondBrain/CLAUDE.md
  echo "uitvoer machinekamer" > io/mkjob/out/r.txt
  echo "ronde ok" > bin/bisync.log; printf "#!/bin/sh\necho olares\n" > bin/olares-cli; chmod 755 bin/olares-cli
  echo "geheugen" > .claude/projects/-opt-data-AI-SecondBrain/memory/m.md
  echo "{\"tokens\":\"NEP-CI\"}" > .codex/auth.json; chmod 600 .codex/auth.json
  chown -R 1001:1001 /opt/data'

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

SERVER=$(r "pgrep -u 1001 -f 'app/current/server.js' | head -1")
echo "  server.js pid: ${SERVER:-?}"
ok "server.js draait als 1001" "[ -n '$SERVER' ]"

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
ok   "rclone (als 1001) schrijft in de vault"                "$(a "echo r > /tmp/r.md && rclone copyto /tmp/r.md $V/00_Systeem/rclone.md")"
ok   "  1002 kan het rclone-bestand wijzigen"                "$(s "echo s >> $V/00_Systeem/rclone.md")"
ok   "cp -p van een 0644-bestand (als 1001)"                 "$(a "echo p > /tmp/p.md && chmod 644 /tmp/p.md && cp -p /tmp/p.md $V/00_Systeem/cpp.md")"
niet "  1002 kan cp -p-bestand vóór maskerherstel niet wijzigen (masker r--)" "$(s "echo s >> $V/00_Systeem/cpp.md")"
ok   "1002 zet een .claude-map in een submap"                "$(s "mkdir -p $V/00_Systeem/.claude && echo '{}' > $V/00_Systeem/.claude/settings.json")"
ok   "na-ronde (als 1001)"                                   "$(a "bash /app/socev-rechten.sh na-ronde")"
ok   "  1002 kan cp -p-bestand na maskerherstel wijzigen"    "$(s "echo s >> $V/00_Systeem/cpp.md")"
ok   "  .claude van socev in de submap hernoemd"             "$(a "[ ! -e $V/00_Systeem/.claude ] && ls -d $V/00_Systeem/.claude.socev-geblokkeerd-*")"

echo "== loper-socket =="
ok   "map /run/socev-loper root 0755"                        "stat_is /run/socev-loper '%U:%G %a' 'root:root 755'"
ok   "socket root:claude 0660"                               "stat_is /run/socev-loper/loper.sock '%U:%G %a' 'root:claude 660'"
ok   "1002 kan niet verbinden (EACCES)"                      "$(s "node -e \"require('net').connect('/run/socev-loper/loper.sock').on('error',e=>process.exit(e.code==='EACCES'?0:1)).on('connect',()=>process.exit(1))\"")"
niet "1002 kan de socket niet weghalen of vervangen"        "$(s 'rm -f /run/socev-loper/loper.sock || exit 1; [ ! -e /run/socev-loper/loper.sock ]')"
PING=$(loper '{"op":"ping"}')
echo "  ping: $PING"
LOPER=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["antwoorden"][0]["pid"])' "$PING" 2>/dev/null)
ok   "1001 bereikt de loper, die draait als 1002"            "python3 -c 'import json,sys; a=json.loads(sys.argv[1])[\"antwoorden\"][0]; sys.exit(0 if a[\"ok\"] and a[\"uid\"]==1002 and a[\"gid\"]==1002 else 1)' '$PING'"
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
ok   "codex-config zonder supabase/n8n"                      "$(s "! grep -qE 'supabase|n8n' /opt/data/socev-thuis/.codex/config.toml && grep -q todoist /opt/data/socev-thuis/.codex/config.toml")"
ok   "codex-login gekopieerd (socev, 0600)"                  "stat_is /opt/data/socev-thuis/.codex/auth.json '%U %a' 'socev 600'"
ok   "memory-symlink op zijn plek"                           "[ \"\$(r 'readlink $SM')\" = '$M' ]"
ok   "1001 kan de thuismap zien, niet erin schrijven"        "$(a 'ls /opt/data/socev-thuis >/dev/null && ! touch /opt/data/socev-thuis/x')"

echo "== 1001 zoals vandaag =="
ok   "server.js met umask 0077"                              "umask_server $SERVER"
ok   "/health ok"                                            "docker exec $C curl -fsS -m 3 http://127.0.0.1:8080/health | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)[\"ok\"] is True else 1)'"
ok   "1001 leest zijn eigen bestanden nog"                   "$(a 'cat /opt/data/bank/bunq/staat.json /opt/data/mk-scripts/x.sh /opt/data/socev-app-data/register.json /opt/data/.claude.json /opt/data/io/mkjob/out/r.txt')"
ok   "managed settings: root, hook python3 -I /app/argv-wacht.py, allowManagedHooksOnly" "managed"
ok   "argv-hook in het image: 24 weigeren + 22 doorlaten"   "$(a 'python3 /tmp/argv-hook-toets.py /app/argv-wacht.py')"
ok   "CLI kent /etc/claude-code/managed-settings.json"       "cli_managed"

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
