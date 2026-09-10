# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-bookworm-slim AS build

# better-sqlite3 needs a toolchain when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

COPY server ./server
COPY client ./client

RUN npm run build

# Drop dev dependencies so only runtime code is copied forward.
# npm workspaces hoist to the root, so server/node_modules may not exist at all;
# create it so the COPY below is valid either way.
RUN npm prune --omit=dev && mkdir -p /app/server/node_modules

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp powers restreaming - playing a video through this server when the site
# refuses to be embedded. It lives in its own venv because Debian marks the
# system Python as externally managed, and because it is the one dependency
# that needs updating on its own schedule: YouTube changes things every few
# weeks and yt-dlp catches up shortly after. To update without waiting for a
# new image:
#
#   docker exec -u 0 <container> /opt/ytdlp/bin/pip install -U yt-dlp
#
# Restreaming stays off until an admin turns it on, so a missing or stale
# yt-dlp never affects a server that does not use the feature.
RUN python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir --upgrade pip yt-dlp \
    && /opt/ytdlp/bin/yt-dlp --version

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    CLIENT_DIR=/app/client/dist \
    YTDLP_PATH=/opt/ytdlp/bin/yt-dlp

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/package.json ./package.json

# The image runs unprivileged; the volume must be writable by uid 1000.
RUN mkdir -p /data && chown -R node:node /data /app /opt/ytdlp
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
