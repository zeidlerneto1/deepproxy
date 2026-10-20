# ─── Stage 1: build ─────────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ─── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM node:24-slim

# System deps + Chromium needed by Playwright. `npx playwright install --with-deps`
# installs both the browser and its OS dependencies in one shot, so we keep this
# image lean by not also pulling google-chrome-stable (we use the bundled Chromium).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Install the bundled Chromium + OS dependencies for headless operation.
RUN npx playwright install --with-deps chromium

# ─── RDP / desktop ────────────────────────────────────────────────────────────
# Instala um servidor RDP (xrdp) + desktop leve (XFCE) para logar no container.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       xrdp \
       xorgxrdp \
       xserver-xorg-core \
       xfce4 \
       xfce4-terminal \
       dbus-x11 \
       firefox-esr \
       supervisor \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/^port=3389/port=3389/' /etc/xrdp/xrdp.ini \
    && useradd -m -s /bin/bash user \
    && echo "user:user" | chpasswd \
    && echo "root:root" | chpasswd

# Config Xorg do xrdp: aponta para o driver xrdpdev (xorgxrdp), necessário para
# o X server renderizar o desktop no container headless. Sem isso o Xorg cai em
# "no screens found" e o RDP fica com tela branca.
COPY xrdp-conf/xorg.conf /etc/xrdp/xorg.conf

# Config do supervisor: sobe o app Node e o xrdp juntos.
COPY supervisord.conf /etc/supervisor/conf.d/deepsproxy.conf

# The profile dir must exist and be writable so the browser session can persist.
RUN mkdir -p /app/deepseek_profile

ENV PORT=3030
EXPOSE 3030 3389
CMD ["/usr/bin/supervisord", "-n"]
