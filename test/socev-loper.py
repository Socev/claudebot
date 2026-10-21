#!/usr/bin/env python3
"""Toets socev-loper.js zonder docker en zonder tweede gebruiker (wv699): het protocol en de weigeringen.
De echte scheiding (uid 1002, socketrechten, ACL's) toetst test/uid-scheiding.sh in een container van het image.

Bindt zelf een socket (zoals loper-bind.py, zonder setpriv), start de loper met fd 3 en nep-breinen, en loopt alle ops na.
Gebruik: python3 test/socev-loper.py  (vanuit de repo-root; node 22 nodig)"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KLANT = os.path.join(REPO, "test", "loper-klant.js")
T = tempfile.mkdtemp(prefix="loper-toets-")
VAULT, IO, THUIS, BUITEN = (os.path.join(T, x) for x in ("vault", "io", "thuis", "buiten"))
for m in (VAULT, IO + "/job1", THUIS + "/.claude/projects/p", THUIS + "/.codex/sessions", THUIS + "/tmp", BUITEN):
    os.makedirs(m)
open(THUIS + "/.claude/projects/p/s.jsonl", "w").write('{"regel":1}\n')
open(THUIS + "/.claude.json", "w").write("{}")
open(BUITEN + "/geheim", "w").write("geheim")
os.symlink(BUITEN + "/geheim", THUIS + "/.claude/projects/p/naar-buiten")
os.symlink(BUITEN, VAULT + "/link-naar-buiten")
NEP = os.path.join(T, "nep-claude")
open(NEP, "w").write("""#!/bin/bash
echo "nep-claude $*"
echo "HOME=$HOME TMPDIR=$TMPDIR CODEX_HOME=$CODEX_HOME PWD=$PWD"
case "$1" in
  lees-stdin) cat ;;
  slaap) sleep 30 ;;
  env) env | sort ;;
  fds) for f in /proc/$$/fd/*; do echo "fd $(basename $f) -> $(readlink $f)"; done ;;
esac
exit 0
""")
os.chmod(NEP, 0o755)
SOCK = os.path.join(T, "loper.sock")
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(SOCK)
s.listen(16)
if s.fileno() != 3:
    os.dup2(s.fileno(), 3)
os.set_inheritable(3, True)
ENV = {"PATH": os.environ["PATH"], "SOCEV_LOPER_VAULT": VAULT, "SOCEV_LOPER_IO": IO, "SOCEV_LOPER_THUIS": THUIS,
       "SOCEV_LOPER_BREINEN": json.dumps({"claude": NEP, "codex": NEP})}
loper = {"p": None}
stoppen = {"ja": False}


def start_loper():
    loper["p"] = subprocess.Popen(["node", os.path.join(REPO, "socev-loper.js")], env=ENV, pass_fds=(3,),
                                  stdin=subprocess.DEVNULL, stderr=open(T + "/loper.log", "a"))


start_loper()
time.sleep(0.6)

fout = 0


def klant(verzoeken, tot_einde=None, wacht_ms=15000):
    cmd = ["node", KLANT, SOCK, json.dumps(verzoeken), "--wacht-ms", str(wacht_ms)]
    if tot_einde:
        cmd += ["--tot-einde", tot_einde]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout)


def ok(naam, voorwaarde, info=""):
    global fout
    print(("GROEN " if voorwaarde else "ROOD  ") + naam + ("" if voorwaarde else "  " + str(info)[:400]))
    fout += 0 if voorwaarde else 1


r = klant({"op": "ping"})
ok("ping", r["antwoorden"][0]["ok"] and r["antwoorden"][0]["uid"] == os.getuid(), r)

r = klant({"op": "start", "id": "j1", "brein": "claude", "args": ["--version"], "cwd": VAULT,
           "env": {"HOME": "/opt/data", "TMPDIR": "/tmp", "PATH": "/usr/bin:/bin"}}, tot_einde="j1")
ok("start claude --version in de vault, code 0", r["einde"] == {"code": 0, "signaal": None}, r)
ok("uitvoer komt door", "nep-claude --version" in r["uit"], r)
ok("HOME/TMPDIR/CODEX_HOME door de loper gezet (server.js telt niet)",
   "HOME=%s TMPDIR=%s/tmp CODEX_HOME=%s/.codex" % (THUIS, THUIS, THUIS) in r["uit"], r["uit"])

r = klant({"op": "start", "id": "j2", "brein": "bash", "args": ["-c", "id"], "cwd": VAULT})
ok("brein bash geweigerd", r["antwoorden"][0].get("fout") == "brein-geweigerd", r)
r = klant({"op": "start", "id": "j3", "brein": "claude", "args": [], "cwd": BUITEN})
ok("cwd buiten vault/io geweigerd", r["antwoorden"][0].get("fout") == "cwd-geweigerd", r)
r = klant({"op": "start", "id": "j4", "brein": "claude", "args": [], "cwd": VAULT + "/link-naar-buiten"})
ok("cwd via symlink naar buiten geweigerd", r["antwoorden"][0].get("fout") == "cwd-geweigerd", r)
r = klant({"op": "start", "id": "j5", "brein": "claude", "args": [], "cwd": VAULT + "/../buiten"})
ok("cwd via .. naar buiten geweigerd", r["antwoorden"][0].get("fout") == "cwd-geweigerd", r)
r = klant({"op": "start", "id": "j6", "brein": "claude", "args": [], "cwd": VAULT,
           "env": {"N8N_API_KEY": "x", "SUPABASE_MCP_TOKEN": "y", "TODOIST_MCP_TOKEN": "z", "LD_PRELOAD": "/x.so"}})
a = r["antwoorden"][0]
ok("pod-sleutels in env geweigerd (N8N_API_KEY, SUPABASE_MCP_TOKEN, LD_PRELOAD), todoist niet",
   a.get("fout") == "env-geweigerd" and set(a.get("namen", [])) == {"N8N_API_KEY", "SUPABASE_MCP_TOKEN", "LD_PRELOAD"}, a)
r = klant({"op": "start", "id": "j6b", "brein": "claude", "args": [], "cwd": VAULT,
           "env": {"CLOUDFLARE_TUNNEL_TOKEN_OLARES": "x", "INCEPTRON_API_KEY": "y", "SITE_TELLINGEN_SLEUTEL": "z",
                   "VAULT_BACKUP_CRYPT_WACHTWOORD": "w", "GEMINI_API_KEY_AUTO": "v", "WERKKAMER_SLEUTEL_POD": "ok",
                   "SOCEV_SESSIE": "ok", "SUPABASE_RPC_CONTACTEN": "ok", "CLAUDE_CODE_OAUTH_TOKEN": "ok"}})
a = r["antwoorden"][0]
ok("sleutelachtige namen buiten de smalle lijst geweigerd; smalle (werkkamer, rpc, oauth, sessie) niet",
   a.get("fout") == "env-geweigerd" and set(a.get("namen", [])) == {"CLOUDFLARE_TUNNEL_TOKEN_OLARES", "INCEPTRON_API_KEY",
   "SITE_TELLINGEN_SLEUTEL", "VAULT_BACKUP_CRYPT_WACHTWOORD", "GEMINI_API_KEY_AUTO"}, a)
r = klant({"op": "start", "id": "j6c", "brein": "claude", "args": ["env"], "cwd": VAULT,
           "env": {"WERKKAMER_SLEUTEL_POD": "wk", "SOCEV_SESSIE": "s", "SUPABASE_RPC_CONTACTEN": "rpc", "TODOIST_MCP_TOKEN": "td"}},
          tot_einde="j6c")
ok("smalle sleutels komen in de omgeving van het kind", all(x in r["uit"] for x in ("WERKKAMER_SLEUTEL_POD=wk", "SUPABASE_RPC_CONTACTEN=rpc", "TODOIST_MCP_TOKEN=td")), r)
r = klant({"op": "start", "id": "j6d", "brein": "claude", "args": ["fds"], "cwd": VAULT}, tot_einde="j6d")
LUISTER = os.readlink("/proc/self/fd/3")
ok("kind erft de luistersocket van de loper niet (%s)" % LUISTER, "fd 0" in r["uit"] and LUISTER not in r["uit"], r["uit"])
r = klant({"op": "start", "id": "j7", "brein": "claude", "args": ["--x"], "cwd": IO + "/job1"}, tot_einde="j7")
ok("cwd in io toegestaan", r["einde"] == {"code": 0, "signaal": None}, r)

r = klant({"op": "start", "id": "j8", "brein": "codex", "args": ["lees-stdin"], "cwd": VAULT, "invoer": "hallo via stdin"},
          tot_einde="j8")
ok("invoer bij start gaat naar stdin (codex)", "hallo via stdin" in r["uit"], r)

# leeft + stop
r = klant([{"op": "start", "id": "j9", "brein": "claude", "args": ["slaap"], "cwd": VAULT, "env": {"SOCEV_AGENT_RUN": "abc123"}}],
          wacht_ms=1500)
pid = r["antwoorden"][0].get("pid")
time.sleep(0.4)
r = klant([{"op": "leeft", "pid": pid, "naam": "SOCEV_AGENT_RUN", "waarde": "abc123"},
           {"op": "leeft", "pid": pid, "naam": "SOCEV_AGENT_RUN", "waarde": "anders"},
           {"op": "leeft", "pid": pid, "naam": "SOCEV_AGENT_RUN"},
           {"op": "leeft", "naam": "SOCEV_AGENT_RUN", "waarde": "abc123"},
           {"op": "leeft", "pid": pid, "naam": "PATH"},
           {"op": "leeft", "pid": 1, "naam": "SOCEV_AGENT_RUN", "waarde": "abc123"}])
A = r["antwoorden"]
ok("leeft met juiste marker = true", A[0].get("leeft") is True, A[0])
ok("leeft met andere waarde = false", A[1].get("leeft") is False, A[1])
ok("leeft zonder waarde geeft de markerwaarde", A[2].get("waarde") == "abc123", A[2])
ok("leeft zonder pid vindt het proces", any(x["pid"] == pid for x in A[3].get("pids", [])), A[3])
ok("alleen SOCEV_-markers (PATH geweigerd)", A[4].get("fout") == "naam-ongeldig", A[4])
ok("proces van een andere uid (pid 1) telt niet", A[5].get("leeft") is False or os.getuid() == os.stat("/proc/1").st_uid, A[5])
r = klant([{"op": "lijst"}])
ok("lijst noemt de lopende job zonder inhoud", any(j["id"] == "j9" and not j["klaar"] for j in r["antwoorden"][0]["jobs"])
   and "uit" not in json.dumps(r["antwoorden"][0]["jobs"][0]).replace("uit_bytes", ""), r)
r = klant([{"op": "volg", "id": "j9"}, {"op": "stop", "id": "j9", "signaal": "SIGTERM"}], tot_einde="j9")
ok("stop -> einde met SIGTERM, volg op een nieuwe verbinding", r["einde"] and r["einde"]["signaal"] == "SIGTERM", r)
ok("volg stuurt de buffer na", "nep-claude slaap" in r["uit"], r)
r = klant([{"op": "volg", "id": "j1"}], tot_einde="j1")
ok("volg op een afgeronde job: buffer + einde", "nep-claude --version" in r["uit"] and r["einde"]["code"] == 0, r)

# lees / stat / map
r = klant([{"op": "lees", "pad": THUIS + "/.claude/projects/p/s.jsonl"},
           {"op": "lees", "pad": THUIS + "/.claude.json"},
           {"op": "lees", "pad": THUIS + "/.claude/projects/p/naar-buiten"},
           {"op": "lees", "pad": THUIS + "/.claude/projects/../../buiten/geheim"},
           {"op": "stat", "pad": THUIS + "/.claude/projects/p/s.jsonl"},
           {"op": "map", "pad": THUIS + "/.claude/projects/p"},
           {"op": "lees", "pad": THUIS + "/.claude/projects/p/s.jsonl", "vanaf": 2, "max": 5}])
A = r["antwoorden"]
import base64  # noqa: E402
ok("lees binnen projects", A[0].get("ok") and base64.b64decode(A[0]["b64"]) == b'{"regel":1}\n', A[0])
ok("lees .claude.json geweigerd", A[1].get("fout") == "pad-geweigerd", A[1])
ok("lees via symlink naar buiten geweigerd", A[2].get("fout") == "pad-geweigerd", A[2])
ok("lees via .. geweigerd", A[3].get("fout") == "pad-geweigerd", A[3])
ok("stat binnen projects", A[4].get("grootte") == 12, A[4])
ok("map binnen projects", any(x["naam"] == "s.jsonl" for x in A[5].get("namen", [])), A[5])
ok("lees met vanaf/max", base64.b64decode(A[6].get("b64", "")) == b"regel", A[6])

r = klant([{"op": "bestaat-niet"}, {"op": "stop", "id": "onbekend"}])
ok("onbekende op en job netjes geweigerd", r["antwoorden"][0].get("fout") == "onbekende-op" and r["antwoorden"][1].get("fout") == "onbekende-job", r)

# Loper weg -> opnieuw (zoals de root-lus): de socket blijft dezelfde en werkt weer.
loper["p"].kill()
loper["p"].wait()
t0 = time.time()
start_loper()
terug = False
while time.time() - t0 < 5:
    r = klant({"op": "ping"}, wacht_ms=800)
    if r["antwoorden"] and r["antwoorden"][0].get("ok"):
        terug = True
        break
ok("na kill terug op dezelfde socket binnen 5 s", terug, r)

log = open(T + "/loper.log").read()
ok("log bevat geen inhoud (geen args, env of uitvoer)", "hallo via stdin" not in log and "abc123" not in log and "--version" not in log, log[-400:])

loper["p"].kill()
shutil.rmtree(T, ignore_errors=True)
print("rood: %d" % fout)
sys.exit(1 if fout else 0)
