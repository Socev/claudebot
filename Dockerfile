# claude-api — headless Claude CLI als interne Olares-API (+ Drive-sync).
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip bash procps tzdata gosu pandoc \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (levert 'claude') + rclone
RUN npm install -g @anthropic-ai/claude-code
RUN curl -fsSL https://rclone.org/install.sh | bash || true

# Non-root gebruiker: 'claude' weigert bypassPermissions als root.
# HOME = /opt/data (hierop mount Olares het persistent volume).
RUN id claude 2>/dev/null || useradd -u 1001 -d /opt/data -s /bin/bash claude

ENV HOME=/opt/data
ENV VAULT_DIR=/opt/data/AI_SecondBrain
ENV PORT=8080
ENV TZ=Europe/Amsterdam

WORKDIR /app
COPY server.js /app/server.js
COPY telegram-claude-bot.js /app/telegram-claude-bot.js
COPY run.sh /app/run.sh
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/run.sh /app/entrypoint.sh

EXPOSE 8080
# entrypoint draait als root (chown volume), zakt dan naar 'claude'
ENTRYPOINT ["/app/entrypoint.sh"]
