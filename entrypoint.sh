#!/usr/bin/env bash
# entrypoint.sh — draait als root: zorgt dat het volume van 'claude' is,
# zakt daarna naar de non-root gebruiker en start de supervisor (run.sh).
set -u
mkdir -p /opt/data/bin /opt/data/io /opt/data/AI_SecondBrain "${REPO_DIR:-/opt/data/repo}"
# ── Tweede brein (5-9-2026): Codex naast Claude ──────────────────────────────
# Beide CLI's zien dezelfde vault, skills en instructies. De symlinks staan
# BUITEN de vault (de bisync naar Drive/Windows kent geen symlinks) en worden
# bij elke start opnieuw gezet, dus ze kunnen niet kwijtraken.
CODEX_HOME="${CODEX_HOME:-/opt/data/.codex}"
VAULT="${VAULT_DIR:-/opt/data/AI_SecondBrain}"
mkdir -p "$CODEX_HOME" /opt/data/.agents
# 1. skills: Codex leest $HOME/.agents/skills en volgt symlinks; .claude/skills blijft de bron.
ln -sfn "$VAULT/.claude/skills" /opt/data/.agents/skills
# 2. instructies: Codex leest AGENTS.md, niet CLAUDE.md. Als globale AGENTS.md
#    krijgt hij de persona (CLAUDE.md); de werkwijze (AGENTS.md in de vault-root)
#    leest hij daarna zelf, want de vault is zijn werkmap.
ln -sfn "$VAULT/CLAUDE.md" "$CODEX_HOME/AGENTS.md"
# 3. config: alleen bootstrappen als er nog geen staat (de pod mag hem daarna zelf beheren).
#    De n8n-MCP-server komt uit N8N_MCP_URL (chart-env), niet uit de repo (review-fix A7).
if [ ! -f "$CODEX_HOME/config.toml" ]; then
  cp /app/codex-config.toml "$CODEX_HOME/config.toml"
  if [ -n "${N8N_MCP_URL:-}" ]; then
    printf '\n[mcp_servers.n8n]\nurl = "%s"\nbearer_token_env_var = "N8N_MCP_TOKEN"\n' "$N8N_MCP_URL" >> "$CODEX_HOME/config.toml"
  fi
fi
# 4. de schakelaar: standaard Claude, geen fallback (David kiest, niet parallel).
[ -f /opt/data/runtime.json ] || printf '{ "default": "claude", "fallback": "", "models": { "codex": "gpt-6-astra" } }\n' > /opt/data/runtime.json
# Volume kan root-owned aangemaakt zijn; geef het aan 'claude'
chown -R claude:claude /opt/data 2>/dev/null || true
# fetch-secrets.sh haalt de podsecrets op en exec't daarna de rest van de keten,
# zodat run.sh en server.js ze als omgeving erven. Dat dit VOOR gosu staat is
# bewust: gosu behoudt de omgeving over de privilegedrop heen (su - zou hem
# wissen). Het script schrijft niets naar schijf.
exec /app/fetch-secrets.sh gosu claude /app/run.sh
