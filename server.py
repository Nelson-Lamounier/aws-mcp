"""
server.py — wiki-mcp FastMCP server.

Exposes the portfolio knowledge base as MCP tools.

Run locally:
    cp .env.example .env        # set WIKI_LOCAL_PATH
    python server.py            # starts on http://localhost:8000/mcp

Run in K8s pod:
    WIKI_S3_BUCKET=<bucket> python server.py

MCP endpoint:  POST /mcp
Health probe:  GET  /healthz
"""

from __future__ import annotations

import logging
import os

import uvicorn
from dotenv import load_dotenv
from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from kb import WikiKB

# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
load_dotenv()   # loads .env if present — no-op in K8s (env vars already injected)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
log = logging.getLogger("wiki_mcp")

# ---------------------------------------------------------------------------
# KB — initialised once, shared across all tool calls
# ---------------------------------------------------------------------------
kb = WikiKB()

# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------
mcp = FastMCP(
    name="wiki-kb",
    instructions=(
        "Portfolio knowledge base for Nelson Lamounier.\n\n"
        "WORKFLOW:\n"
        "1. Call get_resume_constraints() BEFORE any resume generation.\n"
        "2. Call get_index() to orient yourself when you're unsure what pages exist.\n"
        "3. Use get_page() for specific wiki topics.\n"
        "4. Use search() to find pages by keyword when the exact path is unknown."
    ),
)

# ---------------------------------------------------------------------------
# Health + REST API routes
#
# /healthz          — K8s liveness/readiness probe
# /api/constraints  — resume/agent-guide + gap-awareness + voice-library (for Lambda)
# /api/achievements — quantified scorecard (for Lambda)
# /api/career       — Amazon work history (for Lambda)
# /api/page         — arbitrary page by ?path= (for Lambda)
# /api/search       — keyword search by ?q= and optional &category= (for Lambda)
#
# Lambda calls these REST endpoints (single fetch) instead of implementing
# the full MCP streamable-http protocol (3-step handshake + session management).
# ---------------------------------------------------------------------------

@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request) -> Response:
    mode = "s3" if os.environ.get("WIKI_S3_BUCKET") else "local"
    return JSONResponse({"status": "ok", "service": "wiki-mcp", "mode": mode})


@mcp.custom_route("/api/constraints", methods=["GET"])
async def api_constraints(request: Request) -> Response:
    """
    Resume generation constraints — full structured pages, not semantic chunks.
    Returns: resume/agent-guide + resume/gap-awareness + resume/voice-library
    Used by: Research Lambda (replaces 3 Pinecone constraint queries)
    """
    content = kb.get_pages_combined([
        "resume/agent-guide",
        "resume/gap-awareness",
        "resume/voice-library",
    ])
    return Response(content=content, media_type="text/plain; charset=utf-8")


@mcp.custom_route("/api/achievements", methods=["GET"])
async def api_achievements(request: Request) -> Response:
    """Quantified achievement scorecard — evidence-backed numbers only."""
    return Response(content=kb.get_page("resume/achievements"),
                    media_type="text/plain; charset=utf-8")


@mcp.custom_route("/api/career", methods=["GET"])
async def api_career(request: Request) -> Response:
    """Amazon TCSA work history, ATS bullets, certifications."""
    return Response(content=kb.get_page("resume/career-history"),
                    media_type="text/plain; charset=utf-8")


@mcp.custom_route("/api/page", methods=["GET"])
async def api_page(request: Request) -> Response:
    """
    Fetch arbitrary wiki page.
    Query param: path (e.g. tools/argocd, concepts/observability-stack)
    """
    path = request.query_params.get("path", "").strip()
    if not path:
        return JSONResponse({"error": "missing ?path= query parameter"}, status_code=400)
    return Response(content=kb.get_page(path), media_type="text/plain; charset=utf-8")


@mcp.custom_route("/api/search", methods=["GET"])
async def api_search(request: Request) -> Response:
    """
    Keyword search.
    Query params: q (required), category (optional)
    Returns JSON array of { path, snippet } objects.
    """
    query = request.query_params.get("q", "").strip()
    if not query:
        return JSONResponse({"error": "missing ?q= query parameter"}, status_code=400)
    category = request.query_params.get("category", "").strip()
    results = kb.search(query, category)
    return JSONResponse(results)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
def get_index() -> str:
    """
    Get the full wiki index: all pages with one-line summaries, organised by category.
    Good first call when you need to orient yourself before fetching specific pages.
    """
    return kb.get_index()


@mcp.tool()
def get_page(path: str) -> str:
    """
    Get a specific wiki page by path (without .md extension).

    Examples:
        get_page("resume/agent-guide")        — resume generation rules
        get_page("tools/argocd")              — ArgoCD implementation notes
        get_page("concepts/observability-stack") — LGTM stack details
        get_page("ai-engineering/self-healing-agent") — reactive agent design
    """
    return kb.get_page(path)


@mcp.tool()
def get_resume_constraints() -> str:
    """
    Get ALL resume generation constraints in one call.

    Returns combined content from:
      - resume/agent-guide   : hard rules, confidence thresholds (STRONG/PARTIAL/ABSENT),
                               ATS optimisation rules, human-written output rules, banned verbs
      - resume/gap-awareness : what NOT to claim — absent/partial concepts with safe framing
      - resume/voice-library : authentic phrase anchors from Nelson's own writing,
                               banned AI terms, sentence-length variation rules

    MANDATORY: call this before generating any resume bullet, summary, or cover letter.
    The agent-guide contains 10 hard rules that must never be broken.
    """
    return kb.get_pages_combined([
        "resume/agent-guide",
        "resume/gap-awareness",
        "resume/voice-library",
    ])


@mcp.tool()
def get_career_history() -> str:
    """
    Get Amazon TCSA work history, ATS-ready bullet templates,
    certifications (AWS Certified DevOps Engineer – Professional),
    education (Higher Diploma in Computer Science), and performance evidence.
    Use this when generating experience bullets for the Amazon role.
    """
    return kb.get_page("resume/career-history")


@mcp.tool()
def get_achievements() -> str:
    """
    Get the quantified achievement scorecard — all evidence-backed numbers.

    Covers: DORA metrics, CDK test assertions, EC2 boot time, MTTR,
    infrastructure scale (stacks, apps, accounts), AI engineering metrics,
    and Amazon work history accomplishments.

    IMPORTANT: only use numbers from this page — never invent metrics.
    """
    return kb.get_page("resume/achievements")


@mcp.tool()
def list_pages(category: str = "") -> list:
    """
    List available wiki pages.

    Args:
        category: optional filter — one of:
                  projects, concepts, tools, patterns, troubleshooting,
                  commands, comparisons, ai-engineering, resume

    Returns a list of page paths (without .md extension).
    """
    return kb.list_pages(category)


@mcp.tool()
def search(query: str, category: str = "") -> list:
    """
    Search wiki pages by keyword (case-insensitive).

    Args:
        query   : search term, e.g. "ArgoCD", "DORA", "kubeadm", "Bedrock"
        category: optional filter (same values as list_pages)

    Returns up to 20 results: [ { "path": str, "snippet": str } ]
    """
    return kb.search(query, category)


# ---------------------------------------------------------------------------
# Entry point
#
# HTTP mode  (default): python server.py
#   → uvicorn on port 8000, for K8s pod / local HTTP testing / client.py
#
# stdio mode: MCP_MODE=stdio python server.py
#   → FastMCP stdio transport, for Claude Code / Claude Desktop
#   → configured via .mcp.json in your project directory
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    if os.environ.get("MCP_MODE") == "stdio":
        log.info("wiki-mcp starting in stdio mode (Claude Code)")
        mcp.run()   # stdio transport — Claude Code manages the process
    else:
        host = os.environ.get("HOST", "0.0.0.0")
        port = int(os.environ.get("PORT", "8000"))
        log.info("wiki-mcp starting in HTTP mode on %s:%d", host, port)
        uvicorn.run(mcp.http_app(), host=host, port=port, log_level="info")
