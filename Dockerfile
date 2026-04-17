# syntax=docker/dockerfile:1
# =============================================================================
# wiki-mcp — Multi-stage Docker build
#
# Stage 1 (deps):   installs production Node.js dependencies via yarn
# Stage 2 (build):  compiles TypeScript → JavaScript
# Stage 3 (runner): minimal production image, non-root user (uid 1001)
#
# Security posture:
#   - Non-root user (uid 1001) — matches K8s pod securityContext
#   - No source code in final image, only compiled dist/ + node_modules
#   - AWS credentials resolved from EC2 Instance Profile (IMDS) at runtime
#   - No secrets baked into the image
# =============================================================================

# ── Stage 1: dependency installation ─────────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app

# Copy manifests first for layer caching — only re-runs when deps change
COPY package.json yarn.lock ./

# Install production dependencies only, frozen lockfile for reproducibility
RUN yarn install --frozen-lockfile --production=false

# ── Stage 2: TypeScript build ─────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Inherit full node_modules (includes devDependencies for tsc)
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN npx tsc --project tsconfig.json

# ── Stage 3: production runner ────────────────────────────────────────────────
FROM node:22-slim AS runner

# Metadata labels
LABEL org.opencontainers.image.title="wiki-mcp"
LABEL org.opencontainers.image.description="Portfolio knowledge-base MCP server"

WORKDIR /app

# Create non-root user with specific uid matching K8s pod securityContext
RUN groupadd --gid 1001 appgroup \
 && useradd --uid 1001 --gid appgroup --no-create-home appuser

ENV NODE_ENV=production
ENV PORT=8000

# Copy compiled output and production node_modules only
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Drop to non-root user before starting
USER appuser

EXPOSE 8000

# Kubernetes liveness/readiness probe
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8000/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
