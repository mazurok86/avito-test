FROM node:22-bookworm-slim

# Why a clean Node image instead of ghcr.io/puppeteer/puppeteer:
#   * puppeteer's base ships Chrome for Testing, which has no Widevine CDM
#     bundled (legal restriction) — sites probing
#     navigator.requestMediaKeySystemAccess('com.widevine.alpha', …) can tell
#     CfT from real Chrome. google-chrome-stable from Google's apt repo is
#     bit-for-bit what regular Linux desktop users run.
#   * Everything in the image is visible in this Dockerfile (no magic).
#   * We control the Chrome version (and its updates).

# Pinned Chrome version for reproducible prod builds.
#
# To bump:
#   1) Query current stable:
#        curl -s https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages \
#          | awk '/^Package: google-chrome-stable$/,/^$/' | grep -E '^(Version|SHA256):'
#   2) Update CHROME_VERSION below to the printed Version.
#   3) Rebuild + smoke-test (auth flow, message capture).
#
# Caveat: Google's apt repo only keeps the latest stable + (usually) the
# previous one. ~2-4 weeks after a bump in the upstream channel the .deb for
# our pinned version disappears from the repo and `docker build` will fail
# with "Unable to locate package google-chrome-stable=<version>". When that
# happens either bump the pin to current stable, or pre-download the .deb
# into a private artifact store and COPY it instead of apt-installing.
ARG CHROME_VERSION=148.0.7778.178-1

ENV DEBIAN_FRONTEND=noninteractive

# One big install:
#   * google-chrome-stable from Google's apt repo (with key) — apt pulls all
#     of Chrome's runtime deps (libnss3, libgbm1, libxkbcommon0, libcups2, …)
#     transitively
#   * locales + tzdata     — proper Intl, Date, Accept-Language
#   * font set (latin, cyrillic, CJK, emoji) — font-fingerprint diversity
#   * xvfb + xauth         — virtual X display so Chrome can run *headful*
#   * openbox              — minimal window manager so Chrome's window gets
#                            title bar / borders / a non-zero position
#                            (outerWidth != innerWidth — a fingerprint signal)
#   * dbus / dbus-x11      — session bus stubs Chrome expects on Linux desktop
#   * pulseaudio + libasound2 — AudioContext returns a non-degenerate fingerprint
#   * libgl1 / libgles2    — GL stack so WebGL/canvas isn't a stub
#   * x11vnc / novnc / websockify — opt-in remote view of the Xvfb session
#                            (gated by ENABLE_VNC in entrypoint.sh)
# `apt-get upgrade -y` patches whatever security updates Debian has shipped
# for node:22-bookworm-slim since the base image's last tag refresh. This
# trades bit-for-bit build reproducibility (same Dockerfile, different build
# = potentially different patch levels) for CVE coverage — acceptable for
# prod, where security patches matter more than perfect determinism. Chrome
# itself is pinned (CHROME_VERSION above) and held (apt-mark hold) so this
# step can't drag it off the pin.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        wget \
        gnupg \
        ca-certificates \
    && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        google-chrome-stable=${CHROME_VERSION} \
    && apt-mark hold google-chrome-stable \
    && apt-get install -y --no-install-recommends \
        locales \
        tzdata \
        dumb-init \
        xvfb \
        xauth \
        x11-utils \
        openbox \
        x11vnc \
        novnc \
        websockify \
        dbus \
        dbus-x11 \
        pulseaudio \
        libasound2 \
        libgl1 \
        libgles2 \
        fonts-liberation \
        fonts-liberation2 \
        fonts-dejavu-core \
        fonts-freefont-ttf \
        fonts-noto-core \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        fonts-roboto \
    && sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' \
              -e 's/# ru_RU.UTF-8 UTF-8/ru_RU.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && ln -sf /usr/share/zoneinfo/Europe/Moscow /etc/localtime \
    && echo "Europe/Moscow" > /etc/timezone \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Locale + timezone exposed to Chrome / V8 (navigator.language, Intl, Date).
# PUPPETEER_EXECUTABLE_PATH points puppeteer at the apt-installed Chrome.
# PUPPETEER_SKIP_DOWNLOAD prevents `npm install puppeteer` from downloading
# Chrome for Testing into ~/.cache/puppeteer (we don't want CfT in the image
# at all — see Widevine note above).
ENV LANG=ru_RU.UTF-8 \
    LANGUAGE=ru_RU:ru \
    LC_ALL=ru_RU.UTF-8 \
    TZ=Europe/Moscow \
    DISPLAY=:99 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json nest-cli.json ./
COPY src ./src
COPY client ./client

RUN npm run build

# Entrypoint brings up Xvfb (+ openbox + a session dbus, optionally x11vnc +
# noVNC) before exec'ing the node process.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Reuse the stock `node` user (UID 1000) shipped with node:bookworm-slim.
# UID 1000 matches the pptruser that the previous puppeteer-base image used,
# so any existing `chrome-profile` named volume stays readable across the
# image swap.
#
# We intentionally do NOT switch to USER node here — the entrypoint starts as
# root for one-time per-container setup (chown the persistent profile volume
# so it's writable regardless of what UID owned files on previous runs) and
# drops privileges to `node` via setpriv before exec'ing anything that matters.
RUN mkdir -p /app/.chrome-profile \
    && chown -R node:node /app \
    && usermod -aG audio,video node

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_USER_DATA_DIR=/app/.chrome-profile

EXPOSE 3000
# 5900: raw VNC, 6080: noVNC web UI. Only opened when ENABLE_VNC=true and
# the host actually publishes them (see docker-compose.yml).
EXPOSE 5900 6080

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
