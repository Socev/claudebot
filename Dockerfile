# claude-api — headless Claude CLI als interne Olares-API (+ Drive-sync).
# Twee workspaces in één pod:
#   VAULT_DIR = Second Brain (rclone bisync met Google Drive)
#   REPO_DIR  = git-clone van de GHAWA-website (alleen actief als GIT_REPO_URL is gezet)
FROM node:20-bookworm-slim

# git is nodig voor de GHAWA-workspace (node:slim bevat 'm niet standaard).
# openssh-client is nodig voor de deploy key van socev.dev (git-over-SSH); 18-8-2026.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip bash procps tzdata gosu git openssh-client pandoc poppler-utils ocrmypdf tesseract-ocr-nld \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (levert 'claude') + rclone
RUN npm install -g @anthropic-ai/claude-code
RUN curl -fsSL https://rclone.org/install.sh | bash || true

# ── Chromium-browserbesturing (route C, 16-8-2026) ──────────────────────────
# Systeembibliotheken die headless Chromium nodig heeft (gemeten: 9 ontbraken).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
      libxkbcommon0 libasound2 libatspi2.0-0 libxcomposite1 libxdamage1 libxrandr2 \
      libpango-1.0-0 libcairo2 libxext6 libxfixes3 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# MCP-server + de Chromium-build zelf, in de image (deterministisch, overleeft
# reboots en rebuilds; zelfde build-moment = passende browser-revisie).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npm install -g @playwright/mcp \
 && npx -y playwright install chromium \
 && chmod -R a+rX /opt/pw-browsers

# Non-root gebruiker: 'claude' weigert bypassPermissions als root.
# HOME = /opt/data (hierop mount Olares het persistent volume).
RUN id claude 2>/dev/null || useradd -u 1001 -d /opt/data -s /bin/bash claude

ENV HOME=/opt/data
ENV VAULT_DIR=/opt/data/AI_SecondBrain
ENV REPO_DIR=/opt/data/repo
ENV PORT=8080
ENV TZ=Europe/Amsterdam
# GIT_REPO_URL / GITHUB_PAT bewust NIET hier: die komen uit de deployment-env.

WORKDIR /app
COPY server.js /app/server.js
COPY telegram-claude-bot.js /app/telegram-claude-bot.js
COPY run.sh /app/run.sh
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/run.sh /app/entrypoint.sh

EXPOSE 8080
# entrypoint draait als root (chown volume), zakt dan naar 'claude'
ENTRYPOINT ["/app/entrypoint.sh"]
