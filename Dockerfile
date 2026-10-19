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

# The profile dir must exist and be writable so the browser session can persist.
RUN mkdir -p /app/deepseek_profile

ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
