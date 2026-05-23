# syntax=docker/dockerfile:1.7

# ---- builder ----------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS builder
WORKDIR /app

# No native deps: ritsu uses node:sqlite (built-in) and zero other C add-ons,
# so we don't need python3/make/g++ during npm install.

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev deps from node_modules for the runtime image
RUN npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Data dir mounted as a named volume in compose so SQLite persists across runs.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=7333 \
    MCP_HOST=0.0.0.0 \
    ADMIN_PORT=7334 \
    ADMIN_HOST=0.0.0.0 \
    DB_PATH=/app/data/ritsu.db \
    LOG_LEVEL=info

EXPOSE 7333 7334

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.ADMIN_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
