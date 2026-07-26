# syntax=docker/dockerfile:1.7
# Multi-stage build for llm-proxy P0 scaffold.
#   - stage `build`: produce dist via tsup + (optional) admin-ui singlefile.
#   - stage `runtime`: lean Node 22 alpine, copy dist + locales + admin-ui.html.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Install deps with cache
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Build the app bundle
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY drizzle.config.ts ./
RUN npm run build:app

# Build admin-ui singlefile (if present) — skip gracefully if not yet built
COPY admin-ui ./admin-ui
RUN if [ -f admin-ui/package.json ]; then \
      cd admin-ui && npm install --no-audit --no-fund && npm run build; \
      mkdir -p /app/dist/api && \
      cp admin-ui/dist/admin-ui.html /app/dist/api/admin-ui.html; \
    else \
      echo "admin-ui/package.json not present; skipping admin-ui build"; \
    fi

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production-only deps
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY --from=build /app/dist ./dist
COPY --from=build /app/locales ./locales

# docker-compose 默认会注入 DATABASE_URL 等环境变量；CMD 跑 migrate 再起服务。
CMD ["sh", "-c", "node dist/index.js start --skip-migrate=false"]
