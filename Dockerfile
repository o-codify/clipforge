# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.1.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1 API_URL=http://127.0.0.1:8420
ARG RELEASE_SHA=local
ENV RELEASE_SHA=$RELEASE_SHA
RUN pnpm build
# Installation timestamps are irrelevant at runtime and would invalidate the
# dependency layer on every otherwise identical GitHub build.
RUN CI=true pnpm install --prod --frozen-lockfile --ignore-scripts \
    && rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json \
    && rm -rf apps/web/.next/cache

FROM node:22-bookworm-slim AS cpu-worker
RUN apt-get update && apt-get install --no-install-recommends -y \
    python3 python3-venv ffmpeg fonts-dejavu-core libgomp1 ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY workers/python/requirements-cpu.txt /tmp/requirements-cpu.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements-cpu.txt
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node workers ./workers
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node assets ./assets
COPY --chown=node:node models ./models
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    PATH=/opt/venv/bin:$PATH PYTHON_BIN=/opt/venv/bin/python \
    DATA_ROOT=/storage/data OUT_ROOT=/storage/out MODELS_ROOT=/storage/models \
    ASSETS_ROOT=/app/assets HF_HOME=/storage/models/huggingface \
    SPEECH_DEVICE=cpu SPEECH_BATCH_SIZE=1 SPEECH_CPU_THREADS=2 RENDER_CONCURRENCY=1 \
    API_PORT=8420 WEB_PORT=3000 AUTO_PUBLISH_ENABLED=false
RUN mkdir -p /storage/data /storage/out /storage/models \
    && chown -R node:node /storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=8s --start-period=150s --retries=3 \
    CMD ["node", "scripts/healthcheck.mjs"]
ENTRYPOINT ["dumb-init", "--single-child", "--"]
CMD ["node", "scripts/production.mjs"]

# Production server: UI, API and scheduler. Media stays on the local PC.
FROM node:22-bookworm-slim AS server
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Dependencies stay in a separate stable layer: a code-only release should not
# download and unpack thousands of unchanged dependency files on the small VPS.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/web/.next ./apps/web/.next
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --chown=node:node scripts ./scripts
ARG RELEASE_SHA=local
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 RELEASE_SHA=$RELEASE_SHA WORKER_ROLE=control \
    DATA_ROOT=/storage/data OUT_ROOT=/storage/out MODELS_ROOT=/storage/models \
    API_PORT=8420 WEB_PORT=3000 AUTO_PUBLISH_ENABLED=false
RUN mkdir -p /storage/data /storage/out /storage/models && chown -R node:node /storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=8s --start-period=150s --retries=3 \
    CMD ["node", "scripts/healthcheck.mjs"]
ENTRYPOINT ["dumb-init", "--single-child", "--"]
CMD ["node", "scripts/production.mjs"]
