#!/usr/bin/env python3
"""Toets argv-wacht (wv698): voorbeelden die geweigerd (2) of doorgelaten (0) moeten worden, met NEP-sleutels in de
omgeving (nooit echte waarden). Gebruik: python3 hook-toets.py [pad-naar-hook]"""
import json, os, subprocess, sys
HOOK = sys.argv[1] if len(sys.argv) > 1 else "/app/argv-wacht.py"
NEP = "nep" + "x" * 30
MK = {"PATH": os.environ["PATH"], "HOME": "/tmp", "N8N_API_KEY": NEP + "1", "API_SECRET": NEP + "2", "CLOUDFLARE_API_TOKEN": NEP + "3",
      "SUPABASE_MCP_TOKEN": NEP + "4", "SUPABASE_SERVICE_ROLE": NEP + "5", "TODOIST_MCP_TOKEN": NEP + "6", "SECRETS_GELADEN": "A,B,C" * 10}
SMAL = {"PATH": os.environ["PATH"], "HOME": "/tmp", "TODOIST_MCP_TOKEN": NEP + "6", "WERKKAMER_SLEUTEL_POD": NEP + "7"}
SMAL_KLUIS = dict(SMAL, SUPABASE_MCP_TOKEN=NEP + "4")
WEIGER = [
  ('curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N/api/v1/workflows"', MK),
  ('curl -s -X POST localhost:8080/run -d "{\\"secret\\":\\"$API_SECRET\\",\\"prompt\\":\\"x\\"}"', MK),
  ('curl -s https://api.cloudflare.com/client/v4/user -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq .', MK),
  ('T=$CLOUDFLARE_API_TOKEN; curl -s -H "Authorization: Bearer $T" https://api.cloudflare.com/', MK),
  ('wget -q --header="apikey: $SUPABASE_SERVICE_ROLE" -O- "$SUPABASE_URL/rest/v1/x"', MK),
  ('curl -s -H "x-api-key: $(printenv N8N_API_KEY)" http://x/', MK),
  ('bash -c \'curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" http://x/\'', MK),
  ('for i in 1 2; do\n  curl -s \\\n    -H "X-N8N-API-KEY: $N8N_API_KEY" \\\n    http://x/$i\ndone', MK),
  ('python3 script.py --token "$SUPABASE_MCP_TOKEN"', MK),
  ('env N8N_API_KEY="$N8N_API_KEY" node x.mjs', MK),
  ('curl -s -u "user:$SUPABASE_MCP_TOKEN" http://x/', SMAL_KLUIS),
  ('grep -c "$API_SECRET" /tmp/x.log', MK),
  ('bash <<EOF\ncurl -H "X-N8N-API-KEY: $N8N_API_KEY" http://x/\nEOF', MK),
  # Fable wv698 #1: tussenvariabelen, voorzetten, heredoc naar bestand
  ('S=$API_SECRET; curl -s -X POST x -d "{\\"secret\\":\\"$S\\"}"', MK),
  ('H="X-N8N-API-KEY: $N8N_API_KEY"; curl -s -H "$H" http://x/', MK),
  ('K=$(printenv N8N_API_KEY)\ncurl -s http://x/ -H "a: $K"', MK),
  ('export TOK="$CLOUDFLARE_API_TOKEN"; python3 x.py "$TOK"', MK),
  ('timeout 20 curl -s -H "Authorization: Bearer $T" http://x/', MK),
  ('nohup curl -s -H "apikey: $T" http://x/ > /tmp/o 2>&1 &', MK),
  ('timeout -s KILL 30 env FOO=1 curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" http://x/', MK),
  ('cat > /tmp/h.sh <<EOF\necho $N8N_API_KEY > /dev/null\nEOF\nbash /tmp/h.sh', MK),
  ("cat > /tmp/h.sh <<'EOF'\ncurl -s -H \"X-N8N-API-KEY: $N8N_API_KEY\" http://x/\nEOF\nbash /tmp/h.sh", MK),
  ({"tool_name": "Write", "tool_input": {"file_path": "/tmp/x.sh", "content": "#!/bin/bash\ncurl -s -H \"X-N8N-API-KEY: $N8N_API_KEY\" http://x/\n"}}, MK),
  ({"tool_name": "Edit", "tool_input": {"file_path": "/tmp/y", "old_string": "a", "new_string": "#!/usr/bin/env bash\nwget --header \"apikey: $SUPABASE_SERVICE_ROLE\" x"}}, MK),
]
MAG = [
  ('curl -s https://example.com/ -o /tmp/x.html', MK),
  ('curl -s -X POST http://localhost:8080/health -H "Content-Type: application/json" -d "{\\"a\\":\\"$HOME\\"}"', MK),
  ('/opt/data/mk-scripts/mk-curl --sleutel N8N_API_KEY --kop X-N8N-API-KEY -- -s "$N8N/api/v1/workflows"', MK),
  ('printf \'header = "X-N8N-API-KEY: %s"\\n\' "$N8N_API_KEY" | curl -s -K - http://x/', MK),
  ('curl -s -K - http://x/ <<EOF\nheader = "X-N8N-API-KEY: $N8N_API_KEY"\nEOF', MK),
  ('N8N_API_KEY="$N8N_API_KEY" python3 /opt/data/mk-scripts/n8n-get.mjs', MK),
  ('[ -n "$N8N_API_KEY" ] && echo "sleutel lengte ${#N8N_API_KEY}"', MK),
  ('curl -s -H "Authorization: Bearer $TODOIST_MCP_TOKEN" https://api.todoist.com/x', SMAL),
  ('curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" http://x/', SMAL),
  ('git log --oneline -5 && grep -rn "N8N_API_KEY" /opt/data/mk-scripts/*.sh | head', MK),
  ('cat > /tmp/x.py <<\'EOF\'\nimport os\nprint(os.environ["N8N_API_KEY"][:0])\nEOF\npython3 /tmp/x.py', MK),
  ('echo "$SECRETS_GELADEN" | tr , "\\n" | wc -l', MK),
  ('curl -s "https://api.github.com/repos/x/y/actions/runs?per_page=$N" | jq \'.workflow_runs[0].status\'', MK),
  ('for f in *.json; do jq -r .name "$f"; done', MK),
  ('timeout 20 curl -s https://example.com/ | head', MK),
  ('cat > /tmp/x.py <<EOF\nprint("$HOME")\nEOF', MK),
  ('K=$N8N_API_KEY; echo "lengte ${#K}"; [ -n "$K" ] && echo ja', MK),
  ('python3 - <<EOF\nimport os\nk="$N8N_API_KEY"\nEOF', MK),
  ('nohup /opt/data/mk-scripts/mk-curl --sleutel N8N_API_KEY --kop X-N8N-API-KEY -- -s http://x/ > /tmp/o 2>&1 &', MK),
  ({"tool_name": "Write", "tool_input": {"file_path": "/tmp/notitie.md", "content": "Fout: curl -H \"X-N8N-API-KEY: $N8N_API_KEY\" (zo niet)"}}, MK),
  ({"tool_name": "Write", "tool_input": {"file_path": "/tmp/goed.sh", "content": "#!/bin/bash\n/opt/data/mk-scripts/mk-curl --sleutel N8N_API_KEY --kop X-N8N-API-KEY -- -s \"$1\"\n"}}, MK),
  ({"tool_name": "Read", "tool_input": {"file_path": "/tmp/x"}}, MK),
]
def run(cmd, env):
    d = cmd if isinstance(cmd, dict) else {"tool_name": "Bash", "tool_input": {"command": cmd}}
    d = dict(d, session_id="toets")
    p = subprocess.run([sys.executable, "-I", HOOK], input=json.dumps(d),
                       capture_output=True, text=True, env=env)
    return p.returncode, p.stderr
fout = 0
for cmd, env in WEIGER:
    c, e = run(cmd, env)
    ok = c == 2 and "mk-curl" in e and NEP not in e
    fout += not ok
    cmd = cmd if isinstance(cmd, str) else json.dumps(cmd, ensure_ascii=False)
    print(("GROEN" if ok else "ROOD ") + " weigert: " + cmd.replace("\n", "⏎")[:110] + ("" if ok else "  [exit %d %s]" % (c, e[:200])))
for cmd, env in MAG:
    c, e = run(cmd, env)
    ok = c == 0
    fout += not ok
    cmd = cmd if isinstance(cmd, str) else json.dumps(cmd, ensure_ascii=False)
    print(("GROEN" if ok else "ROOD ") + " mag:     " + cmd.replace("\n", "⏎")[:110] + ("" if ok else "  [exit %d %s]" % (c, e[:300])))
print("weigeren %d, mag %d, rood %d" % (len(WEIGER), len(MAG), fout))
sys.exit(1 if fout else 0)
