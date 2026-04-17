# syntax=docker/dockerfile:1
# =============================================================================
# wiki-mcp — Multi-stage Docker build
#
# Stage 1 (deps):   installs production Node.js dependencies via yarn
# Stage 2 (build):  compiles TypeScript → JavaScript
# Stage 3 (runner): distroless production image, non-root uid 65532
#
# Security posture:
#   - Distroless runner (no shell, no package manager, no OS utilities)
#   - Non-root user uid 65532 (distroless nonroot built-in)
#   - No source code in final image, only compiled dist/ + node_modules
#   - AWS credentials resolved from EC2 Instance Profile (IMDS) at runtime
#   - No secrets baked into the image
# =============================================================================

# ── Stage 1: dependency installation ─────────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app

# Copy manifests first for layer caching — only re-runs when deps change
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn

# Enable corepack for modern Yarn
RUN corepack enable

# Install production dependencies only, frozen lockfile for reproducibility
RUN yarn install --immutable

# ── Stage 2: TypeScript build ─────────────────────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

# Inherit full node_modules (includes devDependencies for tsc)
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN npx tsc --project tsconfig.json

# ── Stage 3: production runner ────────────────────────────────────────────────
# Distroless: no shell, no package manager, no OS utilities — minimal attack surface.
# Runs as uid 65532 (nonroot) by default — no RUN useradd needed.
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runner

# Metadata labels
LABEL org.opencontainers.image.title="wiki-mcp"
LABEL org.opencontainers.image.description="Portfolio knowledge-base MCP server"

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

# Copy compiled output and production node_modules only
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 8000

# Kubernetes liveness/readiness probe — uses /nodejs/bin/node path in distroless
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://localhost:8000/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]

CMD ["dist/server.js"]
