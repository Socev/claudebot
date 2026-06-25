# claude-telegram-bot — headless Claude CLI + Telegram + Drive-sync, als Olares-app.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip bash procps tzdata \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (levert het 'claude'-commando)
RUN npm install -g @anthropic-ai/claude-code

# rclone (voor Google Drive bisync)
RUN curl -fsSL https://rclone.org/install.sh | bash || true

# HOME = persistent volume (/app/data wordt hierop gemount in Olares)
ENV HOME=/opt/data
ENV VAULT_DIR=/opt/data/AI_SecondBrain
ENV PORT=8080
ENV TZ=Europe/Amsterdam

WORKDIR /app
COPY telegram-claude-bot.js /app/telegram-claude-bot.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
