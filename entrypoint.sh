#!/usr/bin/env bash
# entrypoint.sh — draait als root: zorgt dat het volume van 'claude' is,
# zakt daarna naar de non-root gebruiker en start de supervisor (run.sh).
set -u
mkdir -p /opt/data/bin /opt/data/io /opt/data/AI_SecondBrain "${REPO_DIR:-/opt/data/repo}"
# Volume kan root-owned aangemaakt zijn; geef het aan 'claude'
chown -R claude:claude /opt/data 2>/dev/null || true
# fetch-secrets.sh haalt de podsecrets op en exec't daarna de rest van de keten,
# zodat run.sh en server.js ze als omgeving erven. Dat dit VOOR gosu staat is
# bewust: gosu behoudt de omgeving over de privilegedrop heen (su - zou hem
# wissen). Het script schrijft niets naar schijf.
exec /app/fetch-secrets.sh gosu claude /app/run.sh
