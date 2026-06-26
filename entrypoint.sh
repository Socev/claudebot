#!/usr/bin/env bash
# entrypoint.sh — draait als root: zorgt dat het volume van 'claude' is,
# zakt daarna naar de non-root gebruiker en start de supervisor (run.sh).
set -u
mkdir -p /opt/data/bin /opt/data/AI_SecondBrain
# Volume kan root-owned aangemaakt zijn; geef het aan 'claude'
chown -R claude:claude /opt/data 2>/dev/null || true
exec gosu claude /app/run.sh
