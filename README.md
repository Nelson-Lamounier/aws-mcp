# wiki-mcp

> **Portfolio knowledge-base MCP server** — exposes wiki pages as
> [FastMCP](https://github.com/punkpeye/fastmcp) tools and REST endpoints.
> Built with TypeScript, Node.js 22, and AWS SDK v3.

Consumed by:
- **Claude Code** (stdio transport — local integration)
- **Bedrock Strategist agent** (httpStream transport — via K8s pod)
- **Lambda functions** (REST API — `/api/*` routes)

---

## Architecture

```
                 ┌────────────────────────────────────┐
                 │          wiki-mcp (Node.js)         │
                 │                                     │
  Claude Code ───┤  stdio transport (MCP_MODE=stdio)  │
                 │                                     │
  Bedrock agent ─┤  httpStream  POST /mcp             │
                 │              GET  /sse              │
                 │              GET  /healthz          │
  Lambda callers─┤  REST API    GET  /api/constraints  │
                 │              GET  /api/page?path=… │
                 │              GET  /api/search?q=…  │
                 └────────────────────────────────────┘
                              │
               ┌──────────────┴──────────────┐
         Local dev (WIKI_LOCAL_PATH)   Production (WIKI_S3_BUCKET)
               │                              │
         ./wiki/*.md              s3://bucket/kb-docs/*.md
```

---

## Quick Start

### Prerequisites

- Node.js ≥ 22
- Yarn 4 (`corepack enable && corepack prepare yarn@stable --activate`)

### Install

```bash
yarn install
```

### Local Development

```bash
# Copy example env and set your local KB path
cp .env.example .env
# Edit .env: set WIKI_LOCAL_PATH=/path/to/your/kb-docs

yarn dev    # starts on http://localhost:8000 with hot-reload
```

### Production Build

```bash
yarn build           # compiles TypeScript → dist/
yarn start           # runs dist/server.js
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WIKI_S3_BUCKET` | Prod | — | S3 bucket containing Markdown wiki files |
| `WIKI_LOCAL_PATH` | Dev | — | Local path to the knowledge-base directory |
| `WIKI_KB_PREFIX` | No | `kb-docs` | S3 object key prefix for wiki files |
| `PORT` | No | `8000` | HTTP server port |
| `MCP_MODE` | No | — | Set to `stdio` for Claude Code local mode |
| `SERVICE_VERSION` | No | `1.0.0` | Version string in health responses |

> **One of `WIKI_S3_BUCKET` or `WIKI_LOCAL_PATH` must be set.** The server exits at startup if neither is provided.

---

## MCP Tools

All tools are available via JSON-RPC at `POST /mcp`.

| Tool | Description |
|---|---|
| `get_index` | Returns the top-level `index.md` — start here |
| `get_page` | Returns a single page by path (without `.md`) |
| `get_pages_combined` | Fetches multiple pages joined with `---` dividers |
| `list_pages` | Lists available page paths, optionally filtered by category |
| `search` | Keyword search over page paths and content |
| `get_resume_constraints` | Shortcut: returns hard-rules, gap-boundaries and voice-library |

### Tool Usage Examples

```typescript
// Using MCP SDK
await client.callTool({ name: 'get_index', arguments: {} });
await client.callTool({ name: 'get_page', arguments: { path: 'tools/argocd' } });
await client.callTool({ name: 'list_pages', arguments: { category: 'resume' } });
await client.callTool({ name: 'search', arguments: { query: 'DORA', category: 'tools' } });
```

---

## REST API

All REST endpoints are served on the same port as the MCP server.

### `GET /healthz`

Kubernetes liveness/readiness probe.

```json
{
  "status": "ok",
  "service": "wiki-mcp",
  "version": "1.0.0",
  "timestamp": "2026-04-17T03:00:00.000Z"
}
```

### `GET /api/constraints`

Returns resume hard-rules, gap-boundaries, and voice-library pages combined.

```bash
curl http://localhost:8000/api/constraints
```

### `GET /api/achievements`

Returns the engineering achievements page.

### `GET /api/career`

Returns the career-narrative page.

### `GET /api/page?path=<wiki-path>`

Returns any wiki page by path.

```bash
curl "http://localhost:8000/api/page?path=tools/argocd"
```

**Response:**
```json
{
  "path": "tools/argocd",
  "content": "# ArgoCD\n…"
}
```

**Error (400):**
```json
{ "error": "Missing required query parameter: ?path=<page-path>" }
```

### `GET /api/search?q=<term>&category=<cat>`

Keyword search. `category` is optional.

```bash
curl "http://localhost:8000/api/search?q=DORA&category=tools"
```

**Response:**
```json
{
  "query": "DORA",
  "category": "tools",
  "results": [
    { "path": "tools/dora-metrics", "snippet": "DORA metrics track…" }
  ]
}
```

---

## Dev CLI

Test MCP tools against a running server:

```bash
yarn dev                          # start server in another terminal first
yarn client                       # smoke test (index + list + constraints)
yarn client get tools/argocd      # fetch a page
yarn client search "DORA"         # keyword search
yarn client list resume           # list a category
yarn client combined a/page b/page # fetch multiple pages combined
```

---

## Knowledge-Base Structure

The KB directory (local or S3) must follow this structure:

```
<root>/
├── index.md           ← top-level index (returned by get_index)
└── wiki/
    ├── resume/
    │   ├── hard-rules.md
    │   ├── gap-boundaries.md
    │   ├── voice-library.md
    │   ├── achievements.md
    │   └── career-narrative.md
    └── tools/
        ├── argocd.md
        └── …
```

---

## Docker

Multi-stage Node.js 22 build. Production image runs as **non-root user uid 1001**.

```bash
# Build
docker build -t wiki-mcp:local .

# Run (local mode)
docker run -p 8000:8000 \
  -e WIKI_LOCAL_PATH=/app/wiki \
  -v /path/to/kb:/app/wiki:ro \
  wiki-mcp:local

# Run (S3 mode — uses EC2 Instance Profile automatically)
docker run -p 8000:8000 \
  -e WIKI_S3_BUCKET=bedrock-dev-kb-data \
  wiki-mcp:local
```

---

## CI/CD

GitHub Actions workflow: `.github/workflows/deploy-mcp.yml`

**Triggers:**
- Push to `main` or `develop` when `src/**/*.ts`, `package.json`, `yarn.lock`, `tsconfig.json`, or `Dockerfile` changes
- Manual `workflow_dispatch`

**Pipeline:**
1. `build-wiki-mcp` — builds Docker image, exports to tar (no AWS needed)
2. `push-wiki-mcp` — OIDC auth → read ECR URL from SSM → push image → force ArgoCD sync

**Image tag format:** `{git-sha}-r{run_attempt}`

**ECR SSM path:** `/shared/ecr-wiki-mcp/development/repository-uri`

---

## Security

| Control | Implementation |
|---|---|
| AWS credentials | EC2 Instance Profile (IMDS) — zero K8s secrets |
| Container user | Non-root, uid 1001 |
| CI/CD auth | GitHub OIDC — no long-lived AWS keys |
| Image provenance | Pinned action SHAs (`@<hash>`) |

---

## Project Structure

```
my-mcp/
├── src/
│   ├── server.ts          # FastMCP app — MCP tools + Hono REST routes
│   ├── kb.ts              # WikiKB class — local/S3 backends + TTL cache
│   └── client.ts          # Dev test CLI
├── dist/                  # Compiled output (git-ignored)
├── package.json
├── tsconfig.json
├── Dockerfile             # Node 22 multi-stage build
├── .env.example
└── .github/
    ├── actions/configure-aws/   # OIDC credential action
    └── workflows/deploy-mcp.yml
```
