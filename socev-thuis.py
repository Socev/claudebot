#!/usr/bin/env python3
"""socev-thuis.py — de thuismap van gebruiker socev (1002) inrichten (wv699, 21-10-2026; keten-categorie, in het image).

Draait als socev (setpriv vanuit socev-voorbereiding.sh), bij elke containerstart, idempotent. Nooit als root: dit is
socevs eigen map, en een symlink die een Socev-gesprek hier neerlegt mag nooit een root-schrijfactie omleiden.

WAT. /opt/data/socev-thuis wordt HOME, TMPDIR en CODEX_HOME van de smalle gesprekken (fase 2):
  .claude.json   mcpServers vast uit dit script: pubmed, todoist (token uit de omgeving) en een eigen Playwright-regel
                 (/app/playwright-mcp.sh, uitvoer in socev-thuis/tmp). Bewust NIET n8n en Supabase: dat zijn beheersleutels.
                 De rest van het bestand (cache, projecten) beheert de CLI zelf.
  .claude/projects/-opt-data-AI-SecondBrain/memory -> /opt/data/.claude/projects/-opt-data-AI-SecondBrain/memory
                 (zelfde auto-memory als de machinekamer, zoals nu; ACL zet socev-rechten.sh)
  .codex/        config.toml uit /app/codex-config-socev.toml (zonder Supabase en n8n), AGENTS.md -> vault/CLAUDE.md,
                 auth.json alleen als hij nog ontbreekt (kopie via stdin met --codex-auth)
  .agents/skills -> vault/.claude/skills (Codex leest skills daar)
  tmp/           eigen TMPDIR (0700)
  ACL u:claude:rX (+ standaard): server.js mag hier kijken, niet schrijven; transcripts leest hij via de loper.
"""
import json
import os
import subprocess
import sys
import time

THUIS = "/opt/data/socev-thuis"
VAULT = "/opt/data/AI_SecondBrain"
MEM_ECHT = "/opt/data/.claude/projects/-opt-data-AI-SecondBrain/memory"
CODEX_SJABLOON = "/app/codex-config-socev.toml"
MCP = {
    "pubmed": {"type": "http", "url": "https://pubmed.mcp.claude.com/mcp"},
    "todoist": {"type": "http", "url": "https://ai.todoist.net/mcp",
                "headers": {"Authorization": "Bearer ${TODOIST_MCP_TOKEN}"}},
    "playwright": {"command": "/app/playwright-mcp.sh", "args": []},
}


def log(t):
    print(time.strftime("%Y-%m-%d %H:%M:%S") + " socev-thuis: " + t, flush=True)


def schrijf(pad, inhoud, modus=0o600):
    tmp = pad + ".nieuw"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, modus)
    with os.fdopen(fd, "w" if isinstance(inhoud, str) else "wb") as f:
        f.write(inhoud)
    os.replace(tmp, pad)


def map_(pad, modus=0o700):
    if os.path.islink(pad) or (os.path.exists(pad) and not os.path.isdir(pad)):
        os.replace(pad, pad + ".weg-%d" % int(time.time()))
    os.makedirs(pad, mode=modus, exist_ok=True)


def link(pad, doel):
    if os.path.islink(pad) and os.readlink(pad) == doel:
        return
    if os.path.lexists(pad):
        os.replace(pad, pad + ".weg-%d" % int(time.time()))
    os.symlink(doel, pad)


def main():
    if os.getuid() != 1002:
        log("STOP: draait niet als socev")
        return 1
    if os.path.realpath(THUIS) != THUIS or not os.path.isdir(THUIS):
        log("STOP: %s is geen gewone map" % THUIS)
        return 1
    os.umask(0o077)
    # server.js (claude) mag hier kijken, niet schrijven. Wat de CLI later zelf aanmaakt (transcripts 0600, mappen 0700)
    # is voor claude dicht: server.js leest dat via de loper (stat/map/lees), niet rechtstreeks (Fable wv699 #7).
    subprocess.run(["setfacl", "-P", "-m", "u:claude:rX", THUIS], check=False)
    subprocess.run(["setfacl", "-P", "-d", "-m", "u:claude:rX", THUIS], check=False)
    for m in (".claude", ".claude/projects", ".claude/projects/-opt-data-AI-SecondBrain", ".codex", ".agents"):
        map_(os.path.join(THUIS, m), 0o750)
    map_(os.path.join(THUIS, "tmp"), 0o700)
    os.chmod(os.path.join(THUIS, "tmp"), 0o700)
    link(os.path.join(THUIS, ".claude/projects/-opt-data-AI-SecondBrain/memory"), MEM_ECHT)
    link(os.path.join(THUIS, ".agents/skills"), VAULT + "/.claude/skills")
    link(os.path.join(THUIS, ".codex/AGENTS.md"), VAULT + "/CLAUDE.md")

    # .claude.json: alleen mcpServers en het vertrouwen van de vault vastzetten; de rest laten we aan de CLI.
    cj = os.path.join(THUIS, ".claude.json")
    d = {}
    if os.path.isfile(cj) and not os.path.islink(cj):
        try:
            with open(cj) as f:
                d = json.load(f)
            if not isinstance(d, dict):
                d = {}
        except Exception:
            d = {}
    d["mcpServers"] = MCP
    proj = d.setdefault("projects", {}) if isinstance(d.get("projects", {}), dict) else {}
    d["projects"] = proj
    for p in (VAULT, "/opt/data/io"):
        e = proj.setdefault(p, {}) if isinstance(proj.get(p, {}), dict) else {}
        e["hasTrustDialogAccepted"] = True
        e["mcpServers"] = {}
        proj[p] = e
    schrijf(cj, json.dumps(d, indent=2) + "\n")

    # Codex: config altijd uit het image (geen Supabase/n8n-MCP), login alleen als hij ontbreekt.
    try:
        with open(CODEX_SJABLOON) as f:
            schrijf(os.path.join(THUIS, ".codex/config.toml"), f.read())
    except OSError:
        log("let op: %s ontbreekt" % CODEX_SJABLOON)
    auth = os.path.join(THUIS, ".codex/auth.json")
    if "--codex-auth" in sys.argv:
        data = sys.stdin.buffer.read()
        if data and not os.path.exists(auth):
            schrijf(auth, data)
            log("codex-login gekopieerd")

    os.chmod(THUIS, 0o750)
    log("klaar")
    return 0


if __name__ == "__main__":
    sys.exit(main())
