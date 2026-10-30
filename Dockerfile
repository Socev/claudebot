# claude-api — headless Claude CLI als interne Olares-API (+ Drive-sync).
# Twee workspaces in één pod:
#   VAULT_DIR = Second Brain (rclone bisync met Google Drive)
#   REPO_DIR  = git-clone van de GHAWA-website (alleen actief als GIT_REPO_URL is gezet)
FROM node:22-bookworm-slim

# git is nodig voor de GHAWA-workspace (node:slim bevat 'm niet standaard).
# openssh-client is nodig voor de deploy key van socev.dev (git-over-SSH); 18-8-2026.
# acl (setfacl/getfacl) en python3 (al aanwezig via ocrmypdf, nu expliciet) voor de uid-scheiding: wv699, 21-10-2026.
# apt-get upgrade (CISO 6-10-2026, akkoord David bundel 5): het basisimage loopt achter op de
# Debian-beveiligingsupdates (trivy: libpcre2, perl); zo neemt elke bouw de openstaande fixes mee.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip bash procps tzdata gosu git openssh-client pandoc poppler-utils ocrmypdf tesseract-ocr-nld \
      acl python3 \
 && rm -rf /var/lib/apt/lists/*

# npm zelf bijwerken (CISO 6-10-2026): de npm die met node:22 meekomt bevat oude pacote, sigstore,
# brace-expansion, picomatch en ip-address met bekende lekken. Hoofdversie 11 (werkt op node 22.9+);
# 12 eist node 22.22.2+ en is een grotere sprong. Vóór de globale installaties hieronder.
RUN npm install -g npm@11 && npm --version

# Claude Code CLI (levert 'claude') + rclone.
# BEWUST NIET GEPIND - opdracht David 22-9-2026: "Je moet hem niet pinnen op een vast nummer, hij
# moet altijd de laatste pakken." Reden: een nieuw model vraagt regelmatig een nieuwere CLI (Opus
# 5.5 eiste 2.1.280 terwijl image 42 op 2.1.268 stond), en dan wil je dat een herbouw dat vanzelf
# meeneemt in plaats van dat er eerst een versienummer moet worden bijgewerkt.
# Wat dat kost, en hoe dat is opgevangen: welke CLI in een image zit, staat dan niet meer in dit
# bestand. Daarom schrijft de bouwstap hieronder de geinstalleerde versies weg naar
# /app/cli-versies.txt en zet ze in het bouwlog, zodat per image naderhand te achterhalen is wat
# erin zat. (De Codex-CLI blijft wel gepind: daar is het --json-formaat nog experimenteel.)
RUN npm install -g @anthropic-ai/claude-code
# Tweede brein (5-9-2026): OpenAI Codex CLI (levert 'codex'), gepind zoals de
# Claude-CLI. Bump bewust: het --json-formaat heet nog 'experimental'.
# 2-10-2026 naar 0.160.0, na een naast-elkaar-toets tegen 0.153.4: zelfde events (thread.started,
# turn.started, item.completed/agent_message, turn.completed), -o en resume <thread> werken,
# prompt met '-' ok, rollout-bestanden op dezelfde plek.
RUN npm install -g @openai/codex@0.160.0
RUN curl -fsSL https://rclone.org/install.sh | bash || true
# Derde brein (27-9-2026): Antigravity CLI (levert 'agy', Gemini op Davids Google AI Pro-login),
# via het officiele installatiescript naar /usr/local/bin. Het script kent geen versievlag, dus
# niet gepind - zoals de Claude-CLI; welke versie erin zit, staat in /app/cli-versies.txt.
# Automatische update UIT: de CLI mag zichzelf niet midden in een beurt vervangen, en /health
# moet de versie tonen die echt draait. Login en gesprekken staan op het volume (~/.gemini).
ENV AGY_CLI_DISABLE_AUTO_UPDATE=1
RUN curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh \
 && bash /tmp/agy-install.sh --dir /usr/local/bin \
 && rm -f /tmp/agy-install.sh \
 && test -x /usr/local/bin/agy && /usr/local/bin/agy --version
# Welke versies zitten er in DIT image? Zonder pin is dat anders niet te achterhalen.
RUN mkdir -p /app && { echo "gebouwd: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
      echo "claude-code: $(claude --version 2>/dev/null || echo onbekend)"; \
      echo "codex: $(codex --version 2>/dev/null || echo onbekend)"; \
      echo "agy: $(agy --version 2>/dev/null || echo onbekend)"; \
      echo "node: $(node --version)"; } | tee /app/cli-versies.txt

# ── PGS-tool (3-10-2026, David: "alles draait mee in de huidige pod") ───────
# bcftools/samtools/tabix voor genotypering op PGS-posities uit Davids BAM/VCF (01_Ontwikkeling/PGS-tool).
RUN apt-get update && apt-get install -y --no-install-recommends bcftools samtools tabix \
 && rm -rf /var/lib/apt/lists/* && bcftools --version | head -1 && samtools --version | head -1

# ── Chromium-browserbesturing (route C, 16-8-2026) ──────────────────────────
# Systeembibliotheken die headless Chromium nodig heeft (gemeten: 9 ontbraken).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
      libxkbcommon0 libasound2 libatspi2.0-0 libxcomposite1 libxdamage1 libxrandr2 \
      libpango-1.0-0 libcairo2 libxext6 libxfixes3 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# MCP-server + de Chromium-build zelf, in de image (deterministisch, overleeft
# reboots en rebuilds). Versie vast en de browser via de MCP zelf (wv604, 19-10-2026):
# `npx -y playwright install` haalde de nieuwste losse playwright en dus een andere
# revisie (1248) dan de MCP verwacht (1247). install-browser gebruikt de playwright
# die in de MCP zit. Ophogen = versie hier aanpassen; de wrapper
# mk-scripts/playwright-mcp.sh zoekt het buildnummer zelf.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npm install -g @playwright/mcp@0.0.83 \
 && playwright-mcp install-browser chromium \
 && chmod -R a+rX /opt/pw-browsers

# Non-root gebruiker: 'claude' weigert bypassPermissions als root.
# HOME = /opt/data (hierop mount Olares het persistent volume).
RUN id claude 2>/dev/null || useradd -u 1001 -d /opt/data -s /bin/bash claude
# Tweede gebruiker (uid-scheiding fase 1, wv699, 21-10-2026; bouwplan "Socev-gesprekken onder eigen gebruiker -
# sleutelscheiding"): smalle Socev-gesprekken gaan (fase 2) als socev draaien, zodat ze niet in de processen en bestanden
# van claude kunnen kijken (kluissleutel, bunq, passkeys). Geen login, geen groep claude, thuismap op het volume.
RUN id socev 2>/dev/null || { groupadd -g 1002 socev && useradd -u 1002 -g 1002 -d /opt/data/socev-thuis -M -s /usr/sbin/nologin socev; } \
 && test "$(id -u socev):$(id -g socev):$(id -G socev)" = "1002:1002:1002"

ENV HOME=/opt/data
# Codex: auth.json, config.toml en sessies op het persistente volume, naast /opt/data/.claude.
ENV CODEX_HOME=/opt/data/.codex
ENV VAULT_DIR=/opt/data/AI_SecondBrain
ENV REPO_DIR=/opt/data/repo
ENV PORT=8080
ENV TZ=Europe/Amsterdam
# GIT_REPO_URL / GITHUB_PAT bewust NIET hier: die komen uit de deployment-env.

# ── Versiestempel ───────────────────────────────────────────────────────────
# De CI vult GIT_SHA met de commit waaruit dit image is gebouwd. Die waarde is de
# naam van de bootstrap-release op een vers volume, en verschijnt in /health als
# image_versie. Zonder stempel is achteraf niet vast te stellen welke code er in
# een draaiend image zit - en dan is "hij draait" geen bruikbaar antwoord.
ARG GIT_SHA=onbekend
ENV IMAGE_SHA=${GIT_SHA}
ENV APP_ROOT=/opt/data/app
ENV APP_BOOTSTRAP=/app/release-bootstrap

WORKDIR /app
# Ketenonderdelen: blijven in het image draaien en bewegen dus NIET mee met een
# uitrol. Dat is bewust - een kapotte supervisor of entrypoint kun je op de pod
# niet meer repareren, dus die horen bij de image-categorie.
COPY run.sh /app/run.sh
COPY entrypoint.sh /app/entrypoint.sh
COPY fetch-secrets.sh /app/fetch-secrets.sh
COPY supervisor.js /app/supervisor.js
COPY uitrol.sh /app/uitrol.sh
# Bootstrap-config voor Codex; entrypoint kopieert hem alleen als er nog geen staat.
COPY codex-config.toml /app/codex-config.toml
# Uid-scheiding fase 1 (wv699): root-voorbereiding, rechten (als claude), thuismap (als socev), de root-herstartlus die de
# loper-socket bindt, de loper zelf en de Playwright-regel voor socev. Keten-categorie: een loper die met een uitrol mee
# zou bewegen, zou 1001 de code van een 1002-proces laten bepalen.
COPY socev-voorbereiding.sh socev-rechten.sh socev-thuis.py loper-bind.py socev-loper.js playwright-mcp.sh codex-config-socev.toml /app/
# Syncfilter van de vault (wv813): scripts en Windows-code niet naar Drive/Davids pc; run.sh toetst het vóór de eerste bisync.
# Root-eigendom en in het image: socev noch een uitrol kan het filter verruimen.
COPY bisync-filter.txt bisync-filter-toets.sh /app/
# Syncthing-filter van de vault (wv1277): zelfde effect als bisync-filter.txt, voor de Synology en Davids pc's. De vault-.stignore
# is een symlink hierheen (root, alleen-lezen); run.sh draait de toets vóór elke start van Syncthing (fail-closed).
COPY syncthing-stignore.txt syncthing-filter-toets.py /app/
# argv-hook als managed settings (Fable wv698 #4): root-eigendom, dus geen sessie kan hem uitzetten of omzeilen, en hij
# geldt ook voor sessies met een andere HOME. allowManagedHooksOnly: hooks uit HOME of de vault worden genegeerd.
COPY argv-wacht.py /app/argv-wacht.py
COPY managed-settings.json /etc/claude-code/managed-settings.json

# De applicatiecode staat op TWEE plekken. /app/release-bootstrap is de kopie die
# een vers volume vult; daarna draait de pod uit /opt/data/app/current en raakt
# deze kopie niet meer aan. De losse /app/*.js blijven staan omdat bestaande
# aanroepen (koppel-telegram, telegram-reader vanaf de opdrachtregel) ernaar
# verwijzen; die zijn geen onderdeel van de draaiende API.
COPY server.js /app/release-bootstrap/server.js
COPY telegram-reader.js /app/release-bootstrap/telegram-reader.js
COPY koppel-telegram.js /app/release-bootstrap/koppel-telegram.js
COPY package.json /app/release-bootstrap/package.json
COPY bank-lezer.js /app/release-bootstrap/bank-lezer.js
COPY bunq-lezer.js /app/release-bootstrap/bunq-lezer.js
COPY bank-archief.js /app/release-bootstrap/bank-archief.js
COPY paypal-bewijs.js /app/release-bootstrap/paypal-bewijs.js
COPY financien-app.js /app/release-bootstrap/financien-app.js
COPY pot-afschrift.js /app/release-bootstrap/pot-afschrift.js
COPY mt940-lezer.js /app/release-bootstrap/mt940-lezer.js
COPY facturen-kern.js /app/release-bootstrap/facturen-kern.js
COPY facturen-bank.js /app/release-bootstrap/facturen-bank.js
COPY pot-datahub.js /app/release-bootstrap/pot-datahub.js
COPY pot-verzend.js /app/release-bootstrap/pot-verzend.js
COPY pot-app.js /app/release-bootstrap/pot-app.js
COPY facturen-db.js /app/release-bootstrap/facturen-db.js
COPY facturen.js /app/release-bootstrap/facturen.js
COPY facturen-koerier.js /app/release-bootstrap/facturen-koerier.js
COPY facturen-ingang.js /app/release-bootstrap/facturen-ingang.js
COPY facturen-validatie.js /app/release-bootstrap/facturen-validatie.js
COPY fin-toewijzing.js /app/release-bootstrap/fin-toewijzing.js
COPY facturen-creditcard.js /app/release-bootstrap/facturen-creditcard.js
COPY facturen-paypal.js /app/release-bootstrap/facturen-paypal.js
COPY facturen-maandspec.js /app/release-bootstrap/facturen-maandspec.js
COPY paypal-zakelijk-lezer.js /app/release-bootstrap/paypal-zakelijk-lezer.js
COPY fin-reconcile.js /app/release-bootstrap/fin-reconcile.js
COPY bewaker.js /app/release-bootstrap/bewaker.js
COPY studio.js /app/release-bootstrap/studio.js
COPY bandjes.js /app/release-bootstrap/bandjes.js
COPY harvester.js /app/release-bootstrap/harvester.js
COPY secondbrain.js /app/release-bootstrap/secondbrain.js
COPY docs-delen.js /app/release-bootstrap/docs-delen.js
COPY zoek-snel.js /app/release-bootstrap/zoek-snel.js
COPY gezondheid-app.js /app/release-bootstrap/gezondheid-app.js
COPY financien-vault.js /app/release-bootstrap/financien-vault.js
COPY app-vast.js /app/release-bootstrap/app-vast.js
COPY app-open.js /app/release-bootstrap/app-open.js
COPY intake-telling.js /app/release-bootstrap/intake-telling.js
COPY brain-entiteiten.js /app/release-bootstrap/brain-entiteiten.js
COPY huisstijl-pod.js /app/release-bootstrap/huisstijl-pod.js
COPY werkers.js /app/release-bootstrap/werkers.js
COPY intake-router.js /app/release-bootstrap/intake-router.js
COPY mailman.js /app/release-bootstrap/mailman.js
COPY werkstroom.js /app/release-bootstrap/werkstroom.js
COPY ideeen.js /app/release-bootstrap/ideeen.js
COPY ideeen-filter.js /app/release-bootstrap/ideeen-filter.js
COPY aix.js /app/release-bootstrap/aix.js
COPY audio.js /app/release-bootstrap/audio.js
COPY spreektekst.js /app/release-bootstrap/spreektekst.js
COPY mediatheek.js /app/release-bootstrap/mediatheek.js
COPY ovis-register.js /app/release-bootstrap/ovis-register.js
COPY ovis-plekken.js /app/release-bootstrap/ovis-plekken.js
COPY pdf-lezer.js /app/release-bootstrap/pdf-lezer.js
COPY openai-hulp.js /app/release-bootstrap/openai-hulp.js
COPY facturen-kaart.js /app/release-bootstrap/facturen-kaart.js
COPY omzet.js omzet-huisstijl.js xlsx-schrijver.js /app/release-bootstrap/

COPY server.js /app/server.js
COPY telegram-reader.js /app/telegram-reader.js
COPY koppel-telegram.js /app/koppel-telegram.js

# GramJS (pakket 'telegram') voor de Telegram-lezer. Eerst alleen package.json
# kopieren en installeren: zo hoeft deze laag niet opnieuw te bouwen als er
# alleen een .js-bestand verandert.
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

RUN chmod +x /app/run.sh /app/entrypoint.sh /app/fetch-secrets.sh /app/uitrol.sh \
      /app/socev-voorbereiding.sh /app/socev-rechten.sh /app/playwright-mcp.sh \
 && chmod 0644 /app/socev-loper.js /app/loper-bind.py /app/socev-thuis.py /app/argv-wacht.py /etc/claude-code/managed-settings.json \
      /app/bisync-filter.txt /app/bisync-filter-toets.sh /app/syncthing-stignore.txt /app/syncthing-filter-toets.py \
 && chown -R root:root /app/socev-* /app/loper-bind.py /app/argv-wacht.py /app/playwright-mcp.sh /etc/claude-code \
      /app/bisync-filter.txt /app/bisync-filter-toets.sh /app/syncthing-stignore.txt /app/syncthing-filter-toets.py

EXPOSE 8080
# entrypoint draait als root (chown volume), zakt dan naar 'claude'
ENTRYPOINT ["/app/entrypoint.sh"]
