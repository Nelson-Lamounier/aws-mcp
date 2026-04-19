/**
 * server.ts — FastMCP wiki-mcp server entry point.
 *
 * Exposes the portfolio knowledge-base as:
 *   • 6 MCP tools  — consumed by Claude Code / Bedrock agents via JSON-RPC
 *   • 6 REST routes — consumed by Lambda functions and health probes
 *
 * Custom HTTP routes are added via `server.getApp()` which returns the
 * underlying Hono instance. This is the correct API for fastmcp ≥3.x.
 *
 * Transport selection (via MCP_MODE env var):
 *   MCP_MODE=stdio   → stdio transport (Claude Code local integration)
 *   <default>        → httpStream transport on PORT (default 8000)
 *
 * AWS credentials are resolved automatically from EC2 Instance Profile (IMDS).
 * No Kubernetes secrets are required.
 *
 * @module server
 */

import 'dotenv/config';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { WikiKB } from './kb.js';

// ── Initialisation ─────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8000', 10);
const MCP_MODE = process.env['MCP_MODE'] ?? '';
const SERVICE_VERSION = process.env['SERVICE_VERSION'] ?? '1.0.0';

/**
 * Shared knowledge-base instance.
 * Will throw at startup if neither WIKI_S3_BUCKET nor WIKI_LOCAL_PATH is set.
 */
let kb: WikiKB;

try {
  kb = new WikiKB();
} catch (err) {
  console.error('[wiki-mcp] Failed to initialise WikiKB:', (err as Error).message);
  process.exit(1);
}

// ── FastMCP server ──────────────────────────────────────────────────────────

const server = new FastMCP({
  name: 'wiki-kb',
  version: SERVICE_VERSION as `${number}.${number}.${number}`,
  instructions: [
    'Portfolio knowledge-base server. Use get_index() first to understand the structure,',
    'then get_page() to retrieve specific reference material.',
    'All page paths are without the .md extension (e.g. "resume/agent-guide").',
    'Use list_pages() to discover available pages in a category.',
    'Use search() to find pages by keyword.',
  ].join(' '),
});

// ── MCP Tools ───────────────────────────────────────────────────────────────

/**
 * get_index — returns the top-level index page.
 * The recommended first call for any agent to understand the KB structure.
 */
server.addTool({
  name: 'get_index',
  description:
    'Returns the top-level index page for the portfolio knowledge base. ' +
    'Start here to understand the available categories and navigation structure.',
  parameters: z.object({}),
  execute: async () => {
    return await kb.getIndex();
  },
});

/**
 * get_page — returns the full Markdown content of any page.
 */
server.addTool({
  name: 'get_page',
  description:
    'Returns the full Markdown content of a wiki page. ' +
    'Use list_pages() first to find available paths. ' +
    'Paths do not include the .md extension.',
  parameters: z.object({
    path: z
      .string()
      .min(1)
      .describe('Wiki page path without .md extension, e.g. "tools/argocd", "resume/agent-guide".'),
  }),
  execute: async ({ path }) => {
    return await kb.getPage(path);
  },
});

/**
 * get_pages_combined — fetches multiple pages and concatenates them.
 * Minimises round-trips for agents that need several pages at once.
 */
server.addTool({
  name: 'get_pages_combined',
  description:
    'Fetches multiple wiki pages and returns them joined with --- dividers. ' +
    'Use to minimise tool calls when you need several related pages.',
  parameters: z.object({
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe('List of wiki page paths without .md extension.'),
  }),
  execute: async ({ paths }) => {
    return await kb.getPagesCombined(paths);
  },
});

/**
 * list_pages — returns a list of available page paths.
 */
server.addTool({
  name: 'list_pages',
  description:
    'Returns a list of all available wiki page paths (without .md extension). ' +
    'Filter by category to narrow results (e.g. "resume", "tools", "infrastructure").',
  parameters: z.object({
    category: z
      .string()
      .optional()
      .describe(
        'Optional category subdirectory to filter by, e.g. "resume", "tools", "infrastructure".',
      ),
  }),
  execute: async ({ category }) => {
    const pages = await kb.listPages(category ?? '');
    return JSON.stringify(pages, null, 2);
  },
});

/**
 * search — full-text keyword search over page paths and content.
 */
server.addTool({
  name: 'search',
  description:
    'Searches wiki page paths and content for the given keyword(s). ' +
    'Returns up to 20 results, each with the page path and a matching snippet.',
  parameters: z.object({
    query: z
      .string()
      .min(1)
      .describe('Search keyword or phrase, e.g. "ArgoCD", "DORA", "Bedrock".'),
    category: z.string().optional().describe('Optional category to restrict the search to.'),
  }),
  execute: async ({ query, category }) => {
    const results = await kb.search(query, category ?? '');
    return JSON.stringify(results, null, 2);
  },
});

/**
 * get_resume_constraints — convenience shortcut for the Strategist agent.
 * Returns all hard-rule and archetype-selection pages for resume generation.
 *
 * Pages included:
 *   agent-guide     — confidence thresholds, ordering rules, ATS rules, banned verbs
 *   gap-awareness   — what NOT to claim; absent/partial concepts with safe framing
 *   voice-library   — authentic phrase anchors, banned AI terms, sentence variation
 *   role-archetypes — per-role emphasis maps and archetype selector (deterministic delivery
 *                     avoids Pinecone ranking miss for low-signal JDs like ops/data-center roles)
 *   achievements    — canonical bullet templates and project templates per role type
 */
server.addTool({
  name: 'get_resume_constraints',
  description:
    'Returns the hard rules, gap boundaries, voice library, role archetypes, and achievement ' +
    'bullet templates for resume generation. Used by the Strategist agent to enforce ' +
    'non-negotiable constraints and select the correct role archetype.',
  parameters: z.object({}),
  execute: async () => {
    return await kb.getPagesCombined([
      'resume/agent-guide',
      'resume/gap-awareness',
      'resume/voice-library',
      'resume/role-archetypes',
      'resume/achievements',
    ]);
  },
});

// ── REST Routes via Hono ────────────────────────────────────────────────────
//
// `server.getApp()` returns the underlying Hono instance.
// Routes registered here are available on the same port as the MCP server.
// Hono context `c`:
//   c.json(body, status?)  → JSON response
//   c.req.query('key')     → query string value
//   c.status(code)         → set status code
//

const app = server.getApp();

/**
 * GET /healthz — Kubernetes liveness and readiness probe.
 */
app.get('/healthz', async (c) => {
  return c.json({
    status: 'ok',
    service: 'wiki-mcp',
    version: SERVICE_VERSION,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/constraints — fetches resume constraint pages for Lambda callers.
 * Returns all hard-rule and archetype-selection pages combined.
 *
 * role-archetypes and achievements are included here (not left to Pinecone)
 * because archetype selection must be deterministic — semantic ranking can miss
 * these pages for low-signal JDs (e.g. ops/data-center roles with no tech keywords).
 */
app.get('/api/constraints', async (c) => {
  const content = await kb.getPagesCombined([
    'resume/agent-guide',
    'resume/gap-awareness',
    'resume/voice-library',
    'resume/role-archetypes',
    'resume/achievements',
  ]);
  return c.json({ content });
});

/**
 * GET /api/achievements — returns the engineering achievements wiki page.
 */
app.get('/api/achievements', async (c) => {
  const content = await kb.getPage('resume/achievements');
  return c.json({ content });
});

/**
 * GET /api/career — returns the career-narrative wiki page.
 */
app.get('/api/career', async (c) => {
  const content = await kb.getPage('resume/career-history');
  return c.json({ content });
});

/**
 * GET /api/page — returns any wiki page by query parameter.
 *
 * Query parameters:
 *   ?path=<wiki-page-path>  (required, without .md extension)
 */
app.get('/api/page', async (c) => {
  const pagePath = c.req.query('path');

  if (!pagePath) {
    return c.json({ error: 'Missing required query parameter: ?path=<page-path>' }, 400);
  }

  const content = await kb.getPage(pagePath);
  return c.json({ path: pagePath, content });
});

/**
 * GET /api/search — keyword search over wiki pages.
 *
 * Query parameters:
 *   ?q=<term>        (required)
 *   ?category=<cat>  (optional, e.g. "resume", "tools")
 */
app.get('/api/search', async (c) => {
  const query = c.req.query('q');
  const category = c.req.query('category') ?? '';

  if (!query) {
    return c.json({ error: 'Missing required query parameter: ?q=<term>' }, 400);
  }

  const results = await kb.search(query, category);
  return c.json({ query, category: category || null, results });
});

// ── Entry point ─────────────────────────────────────────────────────────────

if (MCP_MODE === 'stdio') {
  /**
   * Stdio transport — used by Claude Code for local integration.
   * Reads/writes JSON-RPC messages on stdin/stdout.
   */
  console.error('[wiki-mcp] Starting in stdio mode');
  server.start({ transportType: 'stdio' });
} else {
  /**
   * HTTP streaming transport — used by K8s pods and remote agents.
   * MCP endpoint: POST /mcp   (JSON-RPC over HTTP streaming)
   * SSE endpoint: GET  /sse   (legacy SSE for older clients)
   * Health probe:  GET  /healthz
   */
  console.info(`[wiki-mcp] Starting httpStream on port ${PORT}`);
  server.start({
    transportType: 'httpStream',
    httpStream: { port: PORT, host: '0.0.0.0' },
  });
}
