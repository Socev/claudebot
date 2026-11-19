# claude-api — headless Claude CLI als interne Olares-API (+ Drive-sync).
# Twee workspaces in één pod:
#   VAULT_DIR = Second Brain (rclone bisync met Google Drive)
#   REPO_DIR  = git-clone van de GHAWA-website (alleen actief als GIT_REPO_URL is gezet)
FROM node:22-bookworm-slim

# git is nodig voor de GHAWA-workspace (node:slim bevat 'm niet standaard).
# openssh-client is nodig voor de deploy key van socev.dev (git-over-SSH); 18-8-2026.
# acl (setfacl/getfacl) en python3 (vroeger via ocrmypdf, nu expliciet) voor de uid-scheiding: wv699, 21-10-2026.
# apt-get upgrade (CISO 6-10-2026, akkoord David bundel 5): het basisimage loopt achter op de
# Debian-beveiligingsupdates (trivy: libpcre2, perl); zo neemt elke bouw de openstaande fixes mee.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip bash procps tzdata gosu git openssh-client pandoc poppler-utils ghostscript tesseract-ocr tesseract-ocr-nld \
      acl python3 \
 && rm -rf /var/lib/apt/lists/*

# ocrmypdf en Pillow uit PyPI in plaats van apt (wv3167, CISO 16-11-2026). Het Debian-pakket ocrmypdf trok python3-pil 9.4 mee:
# 7 CRITICAL + 33 HIGH zonder fix in bookworm (trivy). Nu de actuele wheels in /usr/local/lib/python3.11/dist-packages
# (systeem-python, dus ook `python3 -I` van studio-beeld.py en de Imagine-toetsen ziet ze); ghostscript en tesseract blijven uit apt.
# Niet gepind (zoals de Claude-CLI): elke bouw neemt de laatste fixes mee; de versies staan in /app/cli-versies.txt.
# uv (vaste release + sha256) alleen tijdens deze stap; hij blijft niet in het image.
ARG UV_VERSIE=0.13.8
ARG UV_SHA256=5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91
RUN curl -fsSL -o /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/${UV_VERSIE}/uv-x86_64-unknown-linux-gnu.tar.gz" \
 && echo "${UV_SHA256}  /tmp/uv.tgz" | sha256sum -c - \
 && mkdir /tmp/uv && tar -xzf /tmp/uv.tgz -C /tmp/uv --strip-components=1 \
 && UV_NO_CACHE=1 /tmp/uv/uv pip install --system --break-system-packages --python /usr/bin/python3 'pillow>=12' 'ocrmypdf>=17' \
 && rm -rf /tmp/uv /tmp/uv.tgz \
 && ! dpkg -s python3-pil >/dev/null 2>&1 \
 && python3 -I -c "import PIL, sys; assert PIL.__file__.startswith('/usr/local/'), PIL.__file__; print('Pillow', PIL.__version__)" \
 && ocrmypdf --version

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
      echo "node: $(node --version)"; \
      echo "ocrmypdf: $(ocrmypdf --version 2>/dev/null || echo onbekend)"; \
      echo "pillow: $(python3 -I -c 'import PIL; print(PIL.__version__)' 2>/dev/null || echo onbekend)"; } | tee /app/cli-versies.txt

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
      xvfb \
 && rm -rf /var/lib/apt/lists/* && test -x /usr/bin/Xvfb && test -x /usr/bin/xkbcomp \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

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
# Gedeelde browser (wv3251, 17-11-2026, Davids JA): Patchright = Playwright zonder de bekende automatiseringssporen, als motor onder
# dezelfde browser-tools (browser-mcp.js, hieronder naar /app). Versie vast, gelijk aan de 1.64-lijn van de MCP; Xvfb (hierboven)
# geeft Chrome een onzichtbaar scherm. Geen eigen browserdownload: browser-mcp.js gebruikt de Chromium in /opt/pw-browsers.
RUN npm install -g patchright@1.64.3 \
 && test -f /usr/local/lib/node_modules/patchright/node_modules/patchright-core/lib/coreBundle.js

# Non-root gebruiker: 'claude' weigert bypassPermissions als root.
# HOME = /opt/data (hierop mount Olares het persistent volume).
RUN id claude 2>/dev/null || useradd -u 1001 -d /opt/data -s /bin/bash claude
# Tweede gebruiker (uid-scheiding fase 1, wv699, 21-10-2026; bouwplan "Socev-gesprekken onder eigen gebruiker -
# sleutelscheiding"): smalle Socev-gesprekken gaan (fase 2) als socev draaien, zodat ze niet in de processen en bestanden
# van claude kunnen kijken (kluissleutel, bunq, passkeys). Geen login, geen groep claude, thuismap op het volume.
RUN id socev 2>/dev/null || { groupadd -g 1002 socev && useradd -u 1002 -g 1002 -d /opt/data/socev-thuis -M -s /usr/sbin/nologin socev; } \
 && test "$(id -u socev):$(id -g socev):$(id -G socev)" = "1002:1002:1002"

# ── Eigen databank (wv3180, ontwerp 01_Ontwikkeling/Databank naar Olares en R230 § 1) ─────────────────────────────────────────────
# Postgres 17 + pgvector uit PGDG (aptsleutel gepind op vingerafdruk; apt toetst de handtekeningen via signed-by) en PostgREST als
# statische release (vaste versie + sha256). Versies van Postgres volgen de imagebouw (minor-updates); PostgREST staat vast.
# Geen standaardcluster (createcluster.conf); de data staat op het volume (/opt/data/pg, gebruiker pg) en start via /app/db/db-wacht.sh.
# OS-gebruiker pg (geen lid van claude/socev) en groep pgsock voor de socket: claude is lid, socev niet.
ARG PGDG_VINGER=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
ARG POSTGREST_VERSIE=v14.18
ARG POSTGREST_SHA256=98de1c0be7787aea5f5e11a25f303ea0077634d6fc1000b687bfa825fd27d299
COPY db/pgdg-vinger.py /tmp/pgdg-vinger.py
RUN curl -fsSL -o /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && python3 /tmp/pgdg-vinger.py /tmp/pgdg.asc "${PGDG_VINGER}" \
 && install -d -m 0755 /usr/share/postgresql-common/pgdg /etc/postgresql-common \
 && cp /tmp/pgdg.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.conf \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17 postgresql-17-pgvector zstd xz-utils \
 && rm -rf /var/lib/apt/lists/* /tmp/pgdg.asc /tmp/pgdg-vinger.py \
 && curl -fsSL -o /tmp/pgrst.tar.xz "https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSIE}/postgrest-${POSTGREST_VERSIE}-linux-static-x86-64.tar.xz" \
 && echo "${POSTGREST_SHA256}  /tmp/pgrst.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/pgrst.tar.xz -C /usr/local/bin postgrest && chmod 0755 /usr/local/bin/postgrest && rm -f /tmp/pgrst.tar.xz \
 && /usr/local/bin/postgrest --version && /usr/lib/postgresql/17/bin/postgres --version \
 && test -f /usr/share/postgresql/17/extension/vector.control \
 && groupadd -r pgsock && useradd -r -M -U -d /opt/data/pg -s /usr/sbin/nologin pg \
 && usermod -aG pgsock pg && usermod -aG pgsock claude \
 && id -nG claude | grep -qw pgsock && ! id -nG socev | grep -qw pgsock && ! id -nG pg | grep -qwE 'claude|socev' \
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
# wv3180: databank (db-wacht, init-SQL, configuratie, PostgREST-config, sleutelluik, beheer-SQL, vergelijker) — image-categorie
COPY db/ /app/db/
COPY uitrol.sh /app/uitrol.sh
# Bootstrap-config voor Codex; entrypoint kopieert hem alleen als er nog geen staat.
COPY codex-config.toml /app/codex-config.toml
# Uid-scheiding fase 1 (wv699): root-voorbereiding, rechten (als claude), thuismap (als socev), de root-herstartlus die de
# loper-socket bindt, de loper zelf en de Playwright-regel voor socev. Keten-categorie: een loper die met een uitrol mee
# zou bewegen, zou 1001 de code van een 1002-proces laten bepalen.
COPY socev-voorbereiding.sh socev-rechten.sh socev-thuis.py loper-bind.py socev-loper.js playwright-mcp.sh codex-config-socev.toml /app/
# wv3251: de gedeelde browser (MCP op Patchright) voor socev én claude; root-eigendom, alleen via een nieuw image te wijzigen.
COPY browser-mcp.js /app/
# wv3254: "haal deze link op" (ophalen.js) als CLI voor iedereen, ook Socev (node /app/ophalen.js <url>); gebruikt browser-mcp.js hiernaast.
COPY ophalen.js /app/
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
# Jev-label op webtekst (wv2427, idee 7 meetpunt 5 (e)): beheerde PostToolUse-hook web-jev.py + de Jev-module (zelfde blok als de
# pod-terugval van OVIS Intake in de release; C10b vergelijkt de sha256). Root, 0644: socev kan de hook niet uitzetten of wijzigen.
# Uitzetten zonder image: /opt/data/web-jev-uit (alleen claude).
COPY jev-pod.js web-jev.py /app/

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
COPY ecobank-mail.js /app/release-bootstrap/ecobank-mail.js
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
COPY facturen-boekstuk.js /app/release-bootstrap/facturen-boekstuk.js
COPY paypal-zakelijk-lezer.js /app/release-bootstrap/paypal-zakelijk-lezer.js
COPY fin-reconcile.js /app/release-bootstrap/fin-reconcile.js
COPY bewaker.js /app/release-bootstrap/bewaker.js
COPY studio.js /app/release-bootstrap/studio.js
COPY bandjes.js /app/release-bootstrap/bandjes.js
COPY harvester.js /app/release-bootstrap/harvester.js
COPY secondbrain.js /app/release-bootstrap/secondbrain.js
COPY geheimen.js /app/release-bootstrap/geheimen.js
COPY docs-delen.js /app/release-bootstrap/docs-delen.js
COPY zoek-snel.js /app/release-bootstrap/zoek-snel.js
COPY jev-pod.js /app/release-bootstrap/jev-pod.js
COPY gezondheid-app.js /app/release-bootstrap/gezondheid-app.js
COPY financien-vault.js /app/release-bootstrap/financien-vault.js
COPY financien-overzicht.js /app/release-bootstrap/financien-overzicht.js
COPY financien-advies.js /app/release-bootstrap/financien-advies.js
COPY financien-vooruit.js /app/release-bootstrap/financien-vooruit.js
COPY financien-bijsturen.js /app/release-bootstrap/financien-bijsturen.js
COPY stroom-tabel.js /app/release-bootstrap/stroom-tabel.js
COPY tibber-uur.js /app/release-bootstrap/tibber-uur.js
COPY nmbrs-data.js /app/release-bootstrap/nmbrs-data.js
COPY nmbrs-betaal.js /app/release-bootstrap/nmbrs-betaal.js
COPY ah-bonnen.js /app/release-bootstrap/ah-bonnen.js
COPY financien-plan.js /app/release-bootstrap/financien-plan.js
COPY financien-reis.js /app/release-bootstrap/financien-reis.js
COPY financien-vermogen.js /app/release-bootstrap/financien-vermogen.js
COPY financien-corrigeer.js /app/release-bootstrap/financien-corrigeer.js
COPY app-vast.js /app/release-bootstrap/app-vast.js
COPY app-open.js /app/release-bootstrap/app-open.js
COPY intake-telling.js /app/release-bootstrap/intake-telling.js
COPY brain-entiteiten.js /app/release-bootstrap/brain-entiteiten.js
COPY bank-partij.js /app/release-bootstrap/bank-partij.js
COPY huisstijl-pod.js /app/release-bootstrap/huisstijl-pod.js
COPY werkers.js /app/release-bootstrap/werkers.js
COPY intake-router.js /app/release-bootstrap/intake-router.js
COPY keten-match.js /app/release-bootstrap/keten-match.js
COPY mailman.js /app/release-bootstrap/mailman.js
COPY werkstroom.js /app/release-bootstrap/werkstroom.js
COPY docplan-totaal.js /app/release-bootstrap/docplan-totaal.js
COPY docplan-koppel.js /app/release-bootstrap/docplan-koppel.js
COPY docplan-controle.js /app/release-bootstrap/docplan-controle.js
COPY docplan-jaaropgaaf.js /app/release-bootstrap/docplan-jaaropgaaf.js
COPY docplan-bezetting.js /app/release-bootstrap/docplan-bezetting.js
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

RUN chown -R root:root /app/db && chmod 0755 /app/db && chmod 0644 /app/db/* && chmod 0755 /app/db/db-wacht.sh /app/db/wal-archief.sh \
 && rm -f /app/db/pgdg-vinger.py \
 && printf '#!/bin/sh\n# wv3180: beheer-SQL op de eigen databank (stdin → JSON-rijen), zie /app/db/sb-sql.js\nexec node /app/db/sb-sql.js "$@"\n' > /app/sb-sql \
 && chmod 0755 /app/sb-sql && ln -sf /app/db/db-wacht.sh /app/db-wacht.sh \
 && node -e "require('/app/node_modules/pg'); require('/app/node_modules/postgres-array')"
RUN chmod +x /app/run.sh /app/entrypoint.sh /app/fetch-secrets.sh /app/uitrol.sh \
      /app/socev-voorbereiding.sh /app/socev-rechten.sh /app/playwright-mcp.sh \
 && chmod 0644 /app/browser-mcp.js /app/ophalen.js /app/socev-loper.js /app/loper-bind.py /app/socev-thuis.py /app/argv-wacht.py /etc/claude-code/managed-settings.json /app/web-jev.py /app/jev-pod.js \
      /app/bisync-filter.txt /app/bisync-filter-toets.sh /app/syncthing-stignore.txt /app/syncthing-filter-toets.py \
 && chown -R root:root /app/browser-mcp.js /app/ophalen.js /app/socev-* /app/loper-bind.py /app/argv-wacht.py /app/playwright-mcp.sh /etc/claude-code /app/web-jev.py /app/jev-pod.js \
      /app/bisync-filter.txt /app/bisync-filter-toets.sh /app/syncthing-stignore.txt /app/syncthing-filter-toets.py

EXPOSE 8080 8091
# entrypoint draait als root (chown volume), zakt dan naar 'claude'
ENTRYPOINT ["/app/entrypoint.sh"]
