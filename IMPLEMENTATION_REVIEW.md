# wiki-mcp — Comprehensive Code Review

> **Audience**: Someone new to both Python and TypeScript who wants to understand every concept applied
> in this codebase — across the original Python implementation and the new TypeScript migration.
> Part I covers the original Python codebase. Part II covers the TypeScript migration:
> what changed, why, and every new language concept applied.

> [!IMPORTANT]
> This document reflects **two generations** of the same service:
> - **Part I — Python (original)**: `server.py`, `kb.py`, `client.py`
> - **Part II — TypeScript migration**: `src/server.ts`, `src/kb.ts`, `src/client.ts`
> The Python files have been deleted. The service now runs on Node.js 22 + fastmcp.

---

## 1. What Is This Service?

**wiki-mcp** is a **knowledge-base server** built with [FastMCP](https://github.com/jlowin/fastmcp).  
It exposes a personal portfolio knowledge base (a folder of Markdown files) over two interfaces simultaneously:

| Interface | Protocol | URL | Who uses it |
|---|---|---|---|
| **MCP tools** | Streamable-HTTP (JSON-RPC) | `POST /mcp` | AI agents (Claude, Bedrock) |
| **REST API** | Plain HTTP GET | `/api/*` | AWS Lambda functions |
| **Health probe** | HTTP GET | `/healthz` | Kubernetes liveness/readiness |
| **stdio** | stdin/stdout | — | Claude Code / Claude Desktop |

### Why Was It Created?

The wider portfolio system uses AWS Bedrock agents to generate resumes, job applications, and career content.  
Those agents previously retrieved rules and constraints from **Pinecone** (a vector database) using semantic search.  
The problem: semantic search is probabilistic — it might miss critical hard rules.

`wiki-mcp` was created to give AI agents **deterministic, structured access** to the knowledge base.  
Instead of "search and hope", the agent calls `get_resume_constraints()` and always gets the exact three documents it needs — no hallucination, no missed rules.

### What Does It Use?

### Original Python Stack (now deleted)

| Technology | Purpose |
|---|---|
| **Python 3.13** | Runtime language |
| **FastMCP ≥ 3.2 (Python)** | MCP server framework — `@mcp.tool()` decorator pattern |
| **uvicorn** | ASGI HTTP server |
| **Starlette** | Web framework — `Request`, `JSONResponse` |
| **boto3** | AWS SDK for Python |
| **python-dotenv** | `.env` file loader |

### Current TypeScript Stack

| Technology | Purpose |
|---|---|
| **TypeScript 5.8 / Node.js 22** | Runtime language and engine |
| **fastmcp 3.35.0 (npm)** | MCP server framework — `server.addTool()` registration pattern |
| **Hono** | Web framework built into fastmcp — `server.getApp()` returns Hono instance |
| **@aws-sdk/client-s3 v3** | AWS SDK modular package for S3 access |
| **zod** | Runtime schema validation for MCP tool parameters |
| **tsx** | TypeScript runner for development (hot-reload via `tsx watch`) |
| **dotenv** | `.env` file loader |
| **glob** | File-system globbing (`*.md` discovery) |
| **Docker (Node 22 multi-stage)** | Containerises the service for Kubernetes |
| **AWS S3** | Stores the wiki pages in production |
| **AWS ECR** | Stores the Docker image |
| **ArgoCD** | Deploys the image to Kubernetes automatically |

---

## 2. File-by-File Breakdown

```
my-mcp/
├── server.py          ← Entry point. FastMCP app, all routes and tool registrations.
├── kb.py              ← WikiKB class. The "brain" — reads files from disk or S3.
├── client.py          ← Dev-only test client. Uses FastMCP Client to call tools.
├── Dockerfile         ← Multi-stage Docker build. Produces the K8s container image.
├── requirements.txt   ← Python package dependencies.
├── .env.example       ← Template for local environment variables.
└── .github/
    └── workflows/
        └── deploy-mcp.yml   ← GitHub Actions CI/CD: build → push to ECR → sync ArgoCD.
```

---

## 3. `kb.py` — The Knowledge Base Backend

This is the core logic of the service. It defines one **class**: `WikiKB`.

### Python Concept: Classes

```python
class WikiKB:
    def __init__(self) -> None:
        ...
```

A **class** is a blueprint for creating objects. Think of it like a form template.  
`__init__` is the **constructor** — it runs automatically when you create an instance:

```python
kb = WikiKB()   # This calls __init__ automatically
```

The class has two responsibilities:
1. Decide where to read files from (local disk or S3)  
2. Cache results so it doesn't re-read the same file 100 times per minute

---

### `__init__(self) -> None`

**What it does**: Reads environment variables to decide which storage backend to use.

```python
def __init__(self) -> None:
    s3_bucket = os.environ.get("WIKI_S3_BUCKET", "")
    local_path = os.environ.get("WIKI_LOCAL_PATH", "")
```

**`os.environ.get(key, default)`** — Reads an environment variable. If it's not set, returns the default.

**Decision logic (priority order)**:
1. `WIKI_S3_BUCKET` is set → use S3 mode, connect to AWS
2. `WIKI_LOCAL_PATH` is set → use local filesystem
3. Neither → raise `RuntimeError` immediately (fail fast — don't let the server start broken)

**Python Concept: Lazy import**

```python
if s3_bucket:
    import boto3        # ← imported INSIDE the if block
```

`boto3` is only imported if needed. This prevents an `ImportError` on machines where boto3 isn't installed and the user just wants to run locally.

**Cache initialisation**:

```python
self._cache: dict[str, tuple[float, str]] = {}
```

**Python Concept: Type hints on dictionaries**

- `dict[str, tuple[float, str]]` means: a dictionary where every key is a `str` and every value is a tuple containing a `float` and a `str`.
- The leading underscore `_cache` is a Python **convention** meaning "private — don't touch from outside this class".

---

### `_get(self, key: str) -> Optional[str]`

**What it does**: Checks if a value exists in the cache and hasn't expired.

```python
def _get(self, key: str) -> Optional[str]:
    entry = self._cache.get(key)
    if entry and (time.monotonic() - entry[0]) < CACHE_TTL:
        return entry[1]
    return None
```

**Expects**: `key` — a string like `"page:tools/argocd"`  
**Returns**: The cached string, or `None` if not found / expired

**Python Concept: `Optional[str]`**

`Optional[str]` means the function can return either a `str` or `None`. It's shorthand for `str | None` (Python 3.10+ syntax).

**Python Concept: `time.monotonic()`**

Returns the current time in seconds (as a float). Unlike `time.time()`, it never goes backwards — safe to use for measuring durations.

The TTL check: `time.monotonic() - entry[0] < 600` — if less than 600 seconds have passed since the value was stored, it's still fresh.

---

### `_put(self, key: str, value: str) -> None`

**What it does**: Stores a value in the cache with the current timestamp.

```python
def _put(self, key: str, value: str) -> None:
    self._cache[key] = (time.monotonic(), value)
```

**Expects**: `key` (str), `value` (str)  
**Returns**: Nothing (`-> None`)

The value is stored as a **tuple**: `(timestamp, content)`. Tuples are immutable pairs/groups of values.

---

### `_local_path(self, wiki_path: str) -> Path`

**What it does**: Converts a wiki page name like `"tools/argocd"` into a real filesystem path.

```python
def _local_path(self, wiki_path: str) -> Path:
    if not wiki_path.endswith(".md"):
        wiki_path = wiki_path + ".md"
    if wiki_path == "index.md":
        return self._root / "index.md"
    return self._root / "wiki" / wiki_path
```

**Python Concept: `pathlib.Path`**

`Path` objects represent filesystem paths. The `/` operator joins paths:

```python
Path("/home/user") / "wiki" / "tools/argocd.md"
# Result: Path("/home/user/wiki/tools/argocd.md")
```

This is cleaner and cross-platform compared to string concatenation.

**Expects**: `wiki_path` — e.g. `"tools/argocd"` or `"index"`  
**Returns**: A `Path` object pointing to the `.md` file on disk  

---

### `_local_fetch(self, wiki_path: str) -> Optional[str]`

**What it does**: Reads a Markdown file from disk. Returns `None` if the file doesn't exist.

```python
def _local_fetch(self, wiki_path: str) -> Optional[str]:
    path = self._local_path(wiki_path)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")
```

**Expects**: wiki path string  
**Returns**: File content as a string, or `None`

`path.read_text(encoding="utf-8")` — Reads the entire file as a UTF-8 string in one call.

---

### `_local_list(self, category: str) -> list[str]`

**What it does**: Lists all `.md` files under `wiki/`, optionally filtered by category.

```python
def _local_list(self, category: str) -> list[str]:
    base = self._root / "wiki"
    if category:
        base = base / category
    if not base.exists():
        return []
    pages = []
    for p in sorted(base.rglob("*.md")):
        rel = p.relative_to(self._root / "wiki")
        pages.append(str(rel)[:-3])   # strip .md
    return pages
```

**Python Concept: `rglob("*.md")`**

`rglob` = recursive glob. Finds all files matching the pattern in all subdirectories.

**Python Concept: string slicing `[:-3]`**

`"argocd.md"[:-3]` → `"argocd"` — removes the last 3 characters (`.md`). Negative indices count from the end.

**Expects**: `category` string (empty = all pages)  
**Returns**: List of page paths without `.md`, e.g. `["resume/agent-guide", "tools/argocd"]`

---

### `_s3_key(self, wiki_path: str) -> str`

**What it does**: Converts a wiki path to an S3 object key.

```python
def _s3_key(self, wiki_path: str) -> str:
    if not wiki_path.endswith(".md"):
        wiki_path = wiki_path + ".md"
    return f"{self._prefix}/{wiki_path}"
```

**Python Concept: f-strings**

`f"{self._prefix}/{wiki_path}"` — An f-string (formatted string literal). Expressions in `{}` are evaluated and inserted. For example: `"kb-docs/tools/argocd.md"`

---

### `_s3_fetch(self, wiki_path: str) -> Optional[str]`

**What it does**: Downloads a single file from AWS S3 and returns its content.

```python
def _s3_fetch(self, wiki_path: str) -> Optional[str]:
    from botocore.exceptions import ClientError
    key = self._s3_key(wiki_path)
    try:
        resp = self._s3.get_object(Bucket=self._bucket, Key=key)
        return resp["Body"].read().decode("utf-8")
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise
```

**Python Concept: `try/except`**

```
try:
    <do something that might fail>
except SomeError as exc:
    <handle the error>
```

Here it catches `ClientError` (S3 errors). If the file is simply not found (`NoSuchKey`), it returns `None` gracefully. Any other error (e.g. permissions denied) is re-raised with `raise` — don't silently swallow unknown errors.

**Payload received from AWS S3**: `resp["Body"].read()` returns `bytes`. `.decode("utf-8")` converts bytes → string.

---

### `_s3_list(self, category: str) -> list[str]`

**What it does**: Lists all Markdown objects in S3 under the `kb-docs/` prefix.

```python
def _s3_list(self, category: str) -> list[str]:
    prefix = f"{self._prefix}/{category}" if category else self._prefix
    paginator = self._s3.get_paginator("list_objects_v2")
    pages: list[str] = []
    for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key: str = obj["Key"]
            if key.endswith(".metadata.json"):
                continue
            rel = key[len(self._prefix) + 1:]
            if rel.endswith(".md"):
                pages.append(rel[:-3])
    return sorted(pages)
```

**Python Concept: Ternary expression**

```python
prefix = f"{self._prefix}/{category}" if category else self._prefix
```

This is Python's one-liner if/else: `value_if_true if condition else value_if_false`.

**Python Concept: Paginator**

S3 can return up to 1000 objects per request. A `paginator` handles multiple requests automatically, iterating through all pages of results.

**Python Concept: `continue`**

Skips the rest of the current loop iteration and moves to the next item. Here it skips `.metadata.json` files.

**Python Concept: `dict.get(key, default)`**

`page.get("Contents", [])` — Returns `[]` if `"Contents"` key doesn't exist (empty S3 page). Avoids a `KeyError`.

---

### `get_page(self, path: str) -> str`

**What it does**: The main public method. Returns full Markdown content of a wiki page. Checks cache first.

```python
def get_page(self, path: str) -> str:
    cache_key = f"page:{path}"
    cached = self._get(cache_key)
    if cached is not None:
        log.debug("cache hit: %s", path)
        return cached

    content = (
        self._local_fetch(path) if self._mode == "local"
        else self._s3_fetch(path)
    )

    if content is None:
        return (
            f"[wiki-mcp] Page not found: {path!r}. "
            "Use list_pages() or get_index() to see what's available."
        )

    self._put(cache_key, content)
    return content
```

**Expects**: `path` — e.g. `"tools/argocd"`, `"resume/agent-guide"`, `"index"`  
**Returns**: Markdown content as a string, or a user-friendly error message  
**Payload**: No input payload — just a path string  

**Python Concept: `{path!r}` in f-strings**

`!r` applies `repr()` — it wraps strings in quotes. `"/bad/path"!r` → `"'/bad/path'"`. Useful for error messages.

**Python Concept: inline conditional expression for backends**

```python
content = (
    self._local_fetch(path) if self._mode == "local"
    else self._s3_fetch(path)
)
```

Chooses which fetch method to call based on the mode. Clean single-expression alternative to `if/else` blocks.

---

### `get_pages_combined(self, paths: list[str]) -> str`

**What it does**: Fetches multiple pages and joins them with a `---` divider.

```python
def get_pages_combined(self, paths: list[str]) -> str:
    return "\n\n---\n\n".join(
        f"<!-- PAGE: {p} -->\n\n{self.get_page(p)}" for p in paths
    )
```

**Expects**: `paths` — a list of page paths, e.g. `["resume/agent-guide", "resume/gap-awareness"]`  
**Returns**: One large string with all pages concatenated, separated by `---`

**Python Concept: Generator expression inside `join()`**

```python
"\n\n---\n\n".join( f"..." for p in paths )
```

This is a **generator expression** — it produces values one at a time, lazily. `str.join(iterable)` concatenates all strings with the separator in between.

This is equivalent to:
```python
items = []
for p in paths:
    items.append(f"<!-- PAGE: {p} -->\n\n{self.get_page(p)}")
return "\n\n---\n\n".join(items)
```

But the generator version is more memory-efficient.

---

### `list_pages(self, category: str = "") -> list[str]`

**What it does**: Returns a list of all page paths, optionally filtered by category.

**Cache key**: `f"list:{category or '__all__'}"` — The `or` operator returns the right side if the left is falsy (empty string).

**Serialisation for cache**: `json.dumps(pages)` converts the list to a JSON string for storage, `json.loads(cached)` converts it back.

**Python Concept: default parameter values**

```python
def list_pages(self, category: str = "") -> list[str]:
```

`category=""` means you can call it with or without the argument:
```python
kb.list_pages()            # category = ""
kb.list_pages("resume")    # category = "resume"
```

---

### `search(self, query: str, category: str = "") -> list[dict]`

**What it does**: Keyword search across page paths and content.

```python
def search(self, query: str, category: str = "") -> list[dict]:
    query_lower = query.lower()
    results: list[dict] = []

    for page_path in self.list_pages(category):
        if query_lower in page_path.lower():
            results.append({"path": page_path, "snippet": f"(path match)"})
            if len(results) >= MAX_SEARCH:
                break
            continue

        content = self.get_page(page_path)
        if query_lower in content.lower():
            snippet = next(
                (ln.strip()[:200] for ln in content.splitlines()
                 if query_lower in ln.lower()),
                ""
            )
            results.append({"path": page_path, "snippet": snippet})
            if len(results) >= MAX_SEARCH:
                break

    return results
```

**Expects**:
- `query` (str) — search term, e.g. `"ArgoCD"`, `"DORA"`
- `category` (str, optional) — filter to a category

**Returns**: `list[dict]` — up to 20 items shaped like `{"path": "...", "snippet": "..."}`

**Python Concept: `next()` with a default**

```python
snippet = next(
    (ln.strip()[:200] for ln in content.splitlines() if query_lower in ln.lower()),
    ""
)
```

`next(iterable, default)` returns the **first** item from an iterable, or the default if empty.  
Here it finds the first line containing the query and takes the first 200 characters.

**Python Concept: Two-phase search (fast path first)**

1. Check the page path first (no file I/O needed)
2. Only if path doesn't match, load the content

This is a **performance pattern** — skip expensive operations whenever possible.

---

### `get_index(self) -> str`

Simply delegates to `get_page("index")`. A thin wrapper that provides a cleaner API name.

---

## 4. `server.py` — The FastMCP Server

### Boot sequence

```python
from __future__ import annotations     # ← Python 3.7+ compat for type hints
import asyncio, logging, os
import uvicorn
from dotenv import load_dotenv
from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from kb import WikiKB

load_dotenv()       # reads .env file — no-op if not present
kb = WikiKB()       # instantiate ONCE at startup — shared by all requests
```

**Python Concept: Module-level code**

Code at the top level (not inside a function or class) runs once when the module is imported. This is why `WikiKB()` is created once and reused — it avoids reconnecting to S3 on every request.

---

### Logging Setup

```python
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
log = logging.getLogger("wiki_mcp")
```

The Python standard `logging` module. `logging.basicConfig` configures the format once. `getLogger("wiki_mcp")` creates a named logger (appears in log output for filtering).

---

### FastMCP Application

```python
mcp = FastMCP(
    name="wiki-kb",
    instructions="...",
)
```

`FastMCP` creates the MCP server. The `instructions` field is metadata that AI agents read to understand how to use the tools in the right order.

---

### Python Concept: Decorators

```python
@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request) -> Response:
    ...

@mcp.tool()
def get_index() -> str:
    ...
```

A **decorator** (`@something`) wraps a function with additional behaviour. Here:
- `@mcp.custom_route(...)` registers the function as an HTTP route handler
- `@mcp.tool()` registers the function as an MCP tool (AI agents can call it)

This is a **registration pattern** — the decorator adds the function to an internal registry without you having to call a register function manually.

---

### Python Concept: `async def` vs `def`

```python
async def healthz(request: Request) -> Response:    # coroutine — async
def get_index() -> str:                              # regular function — sync
```

**Async functions** can be paused (awaited) while waiting for I/O (network, disk). FastMCP itself is async, so route handlers must be `async def`.

**MCP tools** (`@mcp.tool()`) are regular `def` because FastMCP runs them in a thread pool internally — the framework handles the async/sync bridging.

---

### `_run_sync(fn)` — Helper Function

```python
def _run_sync(fn):
    """Run a synchronous blocking function in a thread-pool executor."""
    loop = asyncio.get_event_loop()
    return loop.run_in_executor(None, fn)
```

**The problem**: The REST API routes are `async def` but `WikiKB` methods are synchronous (blocking I/O — reading files/S3). Calling a blocking function inside an async handler freezes the entire server.

**The solution**: `run_in_executor` runs the blocking function in a background thread pool, so the async event loop stays free.

**Usage pattern**:

```python
content = await _run_sync(lambda: kb.get_page(path))
```

**Python Concept: `lambda`**

`lambda: kb.get_page(path)` creates an anonymous function (no name) that takes no arguments and calls `kb.get_page(path)`.  
`_run_sync` needs a callable with no arguments — `lambda` wraps the call to provide that.

---

### REST API Routes

All follow the same pattern. Here's a breakdown of each:

#### `GET /healthz`

```python
@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request) -> Response:
    mode = "s3" if os.environ.get("WIKI_S3_BUCKET") else "local"
    return JSONResponse({"status": "ok", "service": "wiki-mcp", "mode": mode})
```

**Input**: No payload  
**Returns** JSON: `{"status": "ok", "service": "wiki-mcp", "mode": "s3"|"local"}`  
**Used by**: Kubernetes liveness/readiness probes

---

#### `GET /api/constraints`

**Input**: No query params  
**Returns**: Plain text (three Markdown pages concatenated)  
**Pages returned**: `resume/agent-guide`, `resume/gap-awareness`, `resume/voice-library`  
**Used by**: AWS Lambda Research function (replaces 3 Pinecone queries with 1 HTTP call)

---

#### `GET /api/achievements`

**Input**: No params  
**Returns**: Plain text (`resume/achievements` page)  
**Used by**: Lambda functions needing quantified metric data

---

#### `GET /api/career`

**Input**: No params  
**Returns**: Plain text (`resume/career-history` page)

---

#### `GET /api/page?path=<wiki-path>`

**Input**: `?path=tools/argocd` (query string)  
**Returns**: Plain text of that page, or 400 JSON error if `path` is missing  
**Example**: `GET /api/page?path=concepts/observability-stack`

```python
path = request.query_params.get("path", "").strip()
if not path:
    return JSONResponse({"error": "missing ?path= query parameter"}, status_code=400)
```

---

#### `GET /api/search?q=<query>&category=<optional>`

**Input**: `?q=ArgoCD` + optional `&category=tools`  
**Returns**: JSON array of `{"path": str, "snippet": str}` — up to 20 results  
**Example**: `GET /api/search?q=DORA&category=resume`

---

### MCP Tools

MCP tools are called by AI agents via the `POST /mcp` JSON-RPC endpoint. The protocol is handled entirely by FastMCP — you just write Python functions.

#### `get_index() -> str`

**Input**: None  
**Returns**: Full index page (Markdown)

MCP call payload:
```json
{ "tool": "get_index", "args": {} }
```

---

#### `get_page(path: str) -> str`

**Input**: `path` — wiki page path  
**Returns**: Markdown content string

MCP call payload:
```json
{ "tool": "get_page", "args": { "path": "tools/argocd" } }
```

---

#### `get_resume_constraints() -> str`

**Input**: None  
**Returns**: Combined content of 3 constraint pages

MCP call payload:
```json
{ "tool": "get_resume_constraints", "args": {} }
```

---

#### `get_career_history() -> str`

**Input**: None  
**Returns**: Career history page content

---

#### `get_achievements() -> str`

**Input**: None  
**Returns**: Achievements page content

---

#### `list_pages(category: str = "") -> list`

**Input**: `category` (optional string)  
**Returns**: List of page path strings

MCP call payload:
```json
{ "tool": "list_pages", "args": { "category": "resume" } }
```

---

#### `search(query: str, category: str = "") -> list`

**Input**: `query` (required), `category` (optional)  
**Returns**: List of `{"path", "snippet"}` dicts

MCP call payload:
```json
{ "tool": "search", "args": { "query": "DORA", "category": "" } }
```

---

### Entry Point

```python
if __name__ == "__main__":
    if os.environ.get("MCP_MODE") == "stdio":
        mcp.run()   # stdio transport for Claude Code
    else:
        uvicorn.run(mcp.http_app(), host=host, port=port, log_level="info")
```

**Python Concept: `if __name__ == "__main__"`**

When Python runs a file directly (`python server.py`), `__name__` is set to `"__main__"`.  
When a file is *imported* by another module, `__name__` is the file name.  
This guard ensures the server only starts when run directly, not when imported as a library.

**Two transport modes**:
- `MCP_MODE=stdio` — communication via stdin/stdout (for local IDE integration with Claude Code / Claude Desktop)
- Default (HTTP) — uvicorn HTTP server on port 8000

---

## 5. `client.py` — Test Client

A development utility. Not part of production. Uses the `fastmcp.Client` to connect to the running server and call tools.

### Python Concept: `async with` (Async Context Manager)

```python
async with Client(SERVER_URL) as client:
    r = await client.call_tool("get_index", {})
```

`async with` opens a connection (like a file handle) and guarantees it's closed even if an error occurs. Without it, you'd have to manually call `await client.connect()` and `await client.close()`.

### Python Concept: `sys.argv`

```python
args = sys.argv[1:]
```

`sys.argv` is a list of command-line arguments. `sys.argv[0]` is always the script name. `[1:]` slices from index 1 onwards — the actual arguments the user typed.

### Python Concept: `asyncio.run()`

```python
asyncio.run(smoke_test())
```

Starts the asyncio event loop and runs a coroutine until it completes. This is always the outermost entry point for async Python programs.

---

## 6. `Dockerfile` — Container Deep Dive

```dockerfile
# ─── Stage 1: Install dependencies ───────────────────────────────────────────
FROM python:3.13-slim AS deps

WORKDIR /install
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ─── Stage 2: Minimal runtime image ──────────────────────────────────────────
FROM python:3.13-slim AS runner

RUN groupadd --gid 1001 wikimcp && \
    useradd  --uid 1001 --gid 1001 --no-create-home wikimcp

WORKDIR /app
COPY --from=deps /install /usr/local   # ← copy only installed packages, not build tools
COPY kb.py server.py ./

RUN chown -R wikimcp:wikimcp /app
USER wikimcp

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')"

ENV PYTHONUNBUFFERED=1
CMD ["python", "server.py"]
```

### Why Multi-Stage?

Stage 1 (`deps`) installs packages — this requires build tools (gcc, pip cache etc.).  
Stage 2 (`runner`) starts fresh and only copies the installed packages.

**Result**: The final image is much smaller. It contains no pip cache, no build tools.

### Security Practices Applied

| Practice | Why |
|---|---|
| Non-root user (`uid 1001`) | Containers shouldn't run as root — limits blast radius if exploited |
| `--no-cache-dir` | Reduces image size |
| `--prefix=/install` | Collects all packages in one directory, easy to copy between stages |
| `HEALTHCHECK` | Kubernetes probes `/healthz` to know if the pod is alive |
| `PYTHONUNBUFFERED=1` | Ensures print/log output appears immediately in K8s logs (no buffering) |

### Two Run Modes (from Dockerfile comments)

**Local file mode** (bind-mount the wiki directory):
```bash
docker run -p 8000:8000 \
  -e WIKI_LOCAL_PATH=/kb \
  -v /path/to/knowledge-base:/kb:ro \
  wiki-mcp
```

**K8s S3 mode** (no secrets — uses EC2 Instance Profile):
```bash
# Just set WIKI_S3_BUCKET in the pod's ConfigMap
# boto3 picks up IAM credentials from the pod's node instance profile
```

---

## 7. GitHub Actions CI/CD Pipeline (`.github/workflows/deploy-mcp.yml`)

Two jobs run in sequence: `build-wiki-mcp` → `push-wiki-mcp`

### Trigger Conditions

```yaml
on:
  push:
    branches: [main, develop]
    paths:
      - "*.py"
      - "requirements.txt"
      - "Dockerfile"
  workflow_dispatch:   # manual trigger
```

Only fires when Python source, requirements, or the Dockerfile changes. Infrastructure files don't trigger a re-deploy.

### Job 1: Build

- No AWS credentials needed
- Builds the Docker image using multi-stage Dockerfile
- Saves image to `/tmp/wiki-mcp-image.tar`
- Stores tar in GitHub Actions cache (shared between jobs)
- Image tag = `{git-sha}-r{run_attempt}` — unique per commit, no overwrite risk

**Why split build from push?**  
The build job doesn't need secrets. Only the push job needs AWS credentials. Minimises the attack surface.

### Job 2: Push

1. **Configure AWS via OIDC** — uses a composite reusable action (`configure-aws`). No long-lived AWS secret keys — instead uses GitHub's OIDC token to assume an IAM role.
2. **Restore image** from cache
3. **Resolve ECR URL** — reads the ECR repository URL from AWS SSM Parameter Store (put there by CDK)
4. **Push image to ECR** 
5. **Force ArgoCD sync** — SSM `send-command` runs `argocd app sync wiki-mcp` on the K8s control-plane node. Best-effort accelerator — if it fails, ArgoCD Image Updater will still detect the new tag within ~2 minutes.

### Concurrency Control

```yaml
concurrency:
  group: deploy-wiki-mcp-${{ github.ref }}
  cancel-in-progress: true
```

If a new push arrives while a deploy is in progress, the old run is cancelled. Prevents stale image tags from racing ahead.

### The `.github/workflow/` Folder (Note the Missing `s`)

> [!WARNING]
> There are **two** workflow directories in this repo:
> - `.github/workflows/` (correct — GitHub reads this one)  
> - `.github/workflow/` (typo — GitHub ignores this)
>
> The 745-line `deploy-mcp.yml` in `.github/workflow/` appears to be an older **BFF API deployment pipeline** for `admin-api` and `public-api` services that doesn't belong in this repo. It was likely copied from the main `cdk-monitoring` repo by mistake. GitHub never runs it because the directory name is wrong.

---

## 8. Python Concepts Summary Table

| Concept | Where Used | What It Does |
|---|---|---|
| Class (`class WikiKB`) | `kb.py` | Groups related data + methods into one reusable object |
| Constructor (`__init__`) | `kb.py` | Runs when class is instantiated; sets up state |
| Type hints (`-> str`, `list[str]`) | Everywhere | Documents what functions expect/return; checked by IDE |
| `Optional[str]` | `kb.py` | Return type for functions that might return `None` |
| Private convention (`_method`) | `kb.py` | Signals internal use only |
| f-strings | Everywhere | String interpolation with `{}` expressions |
| `pathlib.Path` | `kb.py` | Cross-platform filesystem path manipulation |
| `rglob("*.md")` | `kb.py` | Recursive file search |
| `try/except/raise` | `kb.py` | Error handling — catch known errors, re-raise unknown |
| Lazy import | `kb.py` | `import boto3` only when needed |
| Generator expression | `kb.py` | Memory-efficient iteration inside `join()` |
| `next(gen, default)` | `kb.py` | First item from generator or a default value |
| `str.join(iterable)` | `kb.py` | Concatenate strings with a separator |
| `dict.get(key, default)` | `kb.py` | Safe key access without `KeyError` |
| String slicing `[:-3]` | `kb.py` | Substring by index |
| `if __name__ == "__main__"` | `server.py` | Entry-point guard — only run code when executed directly |
| `async def` / `await` | `server.py` | Async I/O — non-blocking web handlers |
| `asyncio.run()` | `client.py` | Run coroutine from synchronous context |
| `async with` | `client.py` | Async context manager — auto-connects/disconnects |
| Decorators (`@mcp.tool()`) | `server.py` | Register functions without calling register manually |
| `lambda` | `server.py` | Anonymous one-line function |
| `run_in_executor` | `server.py` | Run blocking code in thread pool from async context |
| `sys.argv` | `client.py` | Command-line argument parsing |
| Ternary expression (`x if y else z`) | `kb.py` | Inline conditional |
| Module-level globals | `server.py` | `kb = WikiKB()` created once at startup |

---

## 9. MCP Engineering Patterns Applied

### 1. Tool Docstrings as Agent Instructions

```python
@mcp.tool()
def get_resume_constraints() -> str:
    """
    MANDATORY: call this before generating any resume bullet, summary, or cover letter.
    The agent-guide contains 10 hard rules that must never be broken.
    """
```

The docstring isn't just documentation for developers — it's the instruction the AI agent reads when deciding *which tool to call*. Writing clear, action-oriented docstrings is a core MCP engineering discipline.

### 2. Workflow Hints in Server Instructions

```python
mcp = FastMCP(
    name="wiki-kb",
    instructions=(
        "WORKFLOW:\n"
        "1. Call get_resume_constraints() BEFORE any resume generation.\n"
        "2. Call get_index() to orient yourself when you're unsure what pages exist.\n"
        ...
    ),
)
```

The server-level `instructions` guide the agent's overall strategy before it even looks at individual tools.

### 3. Dual Transport (HTTP + stdio)

Supports both:
- **HTTP mode**: for production pods and Lambda callers
- **stdio mode**: for local developer tools (Claude Code, Claude Desktop)

This is the recommended pattern for services that need to work in both cloud and developer environments.

### 4. REST Escape Hatch for Non-MCP Callers

Lambda functions can't easily implement the 3-step MCP streamable-HTTP handshake.  
Solution: expose the same data over plain REST GET endpoints.  
This is a pragmatic pattern — don't force every caller to implement the full MCP protocol.

### 5. Single Instance, Shared Cache

`kb = WikiKB()` at module level means all request handlers share the same cache. This is correct for a single-process server. The TTL prevents stale data.

---

## 10. Gaps and Issues Identified

### Python Implementation — Issues (now resolved by migration)

| Severity | Gap | Resolution in TypeScript |
|---|---|---|
| 🔴 | **No tests** | Still no Jest tests — carry-over gap |
| 🔴 | **Erroneous `.github/workflow/` directory** | Unchanged — stale BFF pipeline still present |
| 🟡 | **`_run_sync` deprecated `get_event_loop()`** | ✅ Eliminated — Node.js event loop handles async natively |
| 🟡 | **No cache eviction (unbounded dict)** | ✅ TypeScript `Map` with same TTL pattern — same risk, but documented |
| 🟡 | **No input validation on `path`** | ✅ Zod schema validates all MCP tool inputs at the framework level |
| 🟡 | **Hardcoded `.env.example` path** | ✅ Fixed — `.env.example` now uses placeholder paths |
| 🟢 | **No linting config** | ✅ `tsconfig.json` strict mode enforces type safety at compile time |
| 🟢 | **`__pycache__` not gitignored** | ✅ `.gitignore` updated; Python patterns removed |
| 🟢 | **Code duplication on REST routes** | 🟡 Partially — `get_resume_constraints` shortcut added but `/api/achievements` and `/api/career` still duplicate logic |

### TypeScript Implementation — New Gaps

| Severity | Gap | Detail |
|---|---|
| 🔴 | **No Jest tests** | `src/kb.ts` has no test file. TTL cache, S3 error branches, and `search()` are untested. |
| 🟡 | **`addRoute` API misuse** | The original migration assumed `server.addRoute()` existed — it does not in fastmcp 3.35.0. Fixed by switching to `server.getApp()` (Hono). Future major version upgrades may require re-checking the Hono API. |
| 🟡 | **No cache size limit** | TypeScript `Map` grows unbounded, same as the Python `dict`. Add `lru-cache` npm package for production robustness. |
| 🟡 | **No pagination on `/api/search`** | Inherited from Python — max 20 results, no `offset`. |
| 🟢 | **`glob` import uses non-native API** | `glob.glob()` is the sync version; Node 22 has native `fs.glob()` behind a flag. Low risk but worth tracking. |
| 🟢 | **`MCP_MODE` env var undocumented in K8s ConfigMap** | Not present in the ArgoCD Helm values — only works locally. |

---

## 11. Returning Values in Python — Key Concepts

This codebase uses several return patterns worth understanding:

| Pattern | Example | When to use |
|---|---|---|
| Return a value | `return content` | Most common |
| Return `None` explicitly | `return None` | When nothing was found |
| Return `None` implicitly | function ends with no `return` | For `-> None` functions only |
| Return early | `if not path: return JSONResponse(...)` | Guard clauses — fail fast |
| Return from exception | `raise RuntimeError(...)` | When caller has no valid path forward |

The **single-exit vs. early-return** debate: this codebase uses early returns (guard clauses) for error handling, which is the modern Pythonic style. It's easier to read than deeply nested if/else blocks.

---

## 12. Production Readiness Checklist

### Python (original — now deleted)

| ✅ Done | ❌ Missing |
|---|---|
| Multi-stage Docker build | Unit tests (pytest) |
| Non-root container user | Type checking (mypy) |
| K8s `HEALTHCHECK` | Linting config (ruff/pylint) |
| 10-min in-memory TTL cache | Cache size limit |
| Dual transport (HTTP + stdio) | Input path sanitisation |
| REST escape hatch for Lambda | Pagination on search |
| OIDC-based CI/CD (no static secrets) | `pyproject.toml` |
| Soft-fail ArgoCD sync (best-effort) | Stale workflow file cleanup |
| EC2 Instance Profile creds (no K8s secrets) | `.env.example` placeholder paths |
| Lazy boto3 import (local dev ergonomics) | |

### TypeScript (current)

| ✅ Done | ❌ Missing |
|---|---|
| Multi-stage Docker build (Node 22) | Unit tests (Jest) |
| Non-root container user (uid 1001) | Cache size limit (`lru-cache`) |
| K8s `HEALTHCHECK` via `/healthz` | Pagination on `/api/search` |
| 10-min in-memory TTL cache (Map) | Stale `.github/workflow/` cleanup |
| Dual transport (httpStream + stdio) | |
| REST escape hatch for Lambda | |
| Zod input validation on all MCP tools | |
| `strict: true` TypeScript compilation | |
| OIDC-based CI/CD (no static secrets) | |
| Soft-fail ArgoCD sync (best-effort) | |
| EC2 Instance Profile creds (no K8s secrets) | |
| `node_modules` linker (no PnP) | |
| `.env.example` with placeholder paths | |

---

# Part II — TypeScript Migration

> This part documents every change made when migrating from Python to TypeScript,
> explains the TypeScript language concepts applied, and maps them to their Python equivalents.

---

## 13. Why Migrate to TypeScript?

| Reason | Detail |
|---|---|
| **Project standard** | The wider portfolio monorepo (`cdk-monitoring`, `apps/site`) is 100% TypeScript. Mixing languages increases cognitive overhead. |
| **Static type safety** | TypeScript catches type errors at compile time — not at runtime, under load in production. |
| **Ecosystem alignment** | AWS SDK v3 (`@aws-sdk/client-s3`) has first-class TypeScript types. The Python `boto3` stubs (`boto3-stubs`) lag behind. |
| **Node.js deployment** | The Node.js 22 runtime is lighter (~80 MB base image) than `python:3.13-slim` (~45 MB + pip packages). |
| **`fastmcp` is now TypeScript-native** | The npm package `fastmcp` is the primary maintained version. The Python variant has fewer features. |

---

## 14. File Structure Comparison

```
Python (deleted)          TypeScript (current)
─────────────────         ─────────────────────────
server.py             →   src/server.ts
kb.py                 →   src/kb.ts
client.py             →   src/client.ts
requirements.txt      →   package.json + yarn.lock
—                     →   tsconfig.json
—                     →   .yarnrc.yml        (nodeLinker: node-modules)
—                     →   dist/              (compiled output, git-ignored)
```

---

## 15. `src/kb.ts` — WikiKB Class in TypeScript

### TypeScript Concept: Classes and Interfaces

TypeScript classes look very similar to Python classes but use explicit access modifiers and typed properties declared at the top of the class:

```typescript
// Python
class WikiKB:
    def __init__(self) -> None:
        self._mode: str = "local"
        self._cache: dict[str, tuple[float, str]] = {}

// TypeScript equivalent
type CacheEntry = { ts: number; value: string };

class WikiKB {
  private mode: 's3' | 'local';       // declared at class level
  private cache = new Map<string, CacheEntry>();

  constructor() {
    // initialisation logic
  }
}
```

**Key differences**:
- `private` keyword enforces privacy at compile time (Python's `_` is only a convention)
- Properties are declared with their types before the constructor
- TypeScript doesn't need `self` — `this` is used instead

---

### TypeScript Concept: Union Types

```typescript
type StorageMode = 's3' | 'local';
private mode: StorageMode;
```

A **union type** means the variable can only hold one of the listed string literals. The TypeScript compiler will error if you try to assign anything else. Python has no direct equivalent — you would use `Literal['s3', 'local']` from `typing` but it's only checked by external tools like mypy.

---

### TypeScript Concept: `Map<K, V>` vs Python `dict`

```typescript
// TypeScript
private cache = new Map<string, CacheEntry>();
this.cache.set(key, { ts: Date.now(), value });
const entry = this.cache.get(key);

# Python equivalent
self._cache: dict[str, tuple[float, str]] = {}
self._cache[key] = (time.monotonic(), value)
entry = self._cache.get(key)
```

`Map` is the TypeScript / JavaScript native key-value store. It has proper typing brackets `<K, V>` (called **generics**). Unlike Python `dict`, `Map.get()` always returns `V | undefined` — the compiler forces you to check for `undefined` before using the value.

---

### TypeScript Concept: `async/await` — Native, Not Bridged

In Python, `WikiKB` methods were **synchronous** (blocking) and the `server.py` had to bridge them into the async event loop via `run_in_executor`. This is gone in TypeScript:

```typescript
// Python — synchronous, required async bridge in server.py:
def get_page(self, path: str) -> str:
    ...

// TypeScript — natively async, no bridge needed:
async getPage(path: string): Promise<string> {
  ...
}
```

`Promise<string>` is the TypeScript equivalent of Python's `Coroutine[Any, Any, str]` — it represents a value that will be available in the future. `async/await` syntax is identical to Python in structure:

```typescript
// TypeScript
const content = await this.getPage('tools/argocd');

# Python equivalent
content = await kb.get_page('tools/argocd')
```

---

### TypeScript Concept: AWS SDK v3 (`@aws-sdk/client-s3`)

The Python code used `boto3` (AWS SDK v2 style). TypeScript uses the modular v3 SDK:

```typescript
// Python (boto3)
import boto3
s3 = boto3.client('s3')
resp = s3.get_object(Bucket=bucket, Key=key)
content = resp['Body'].read().decode('utf-8')

// TypeScript (AWS SDK v3)
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ region: 'eu-west-1' });
const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
const content = await resp.Body?.transformToString('utf-8');
```

**Key differences**:
- v3 is **command-based** — each operation is a class (`GetObjectCommand`, `ListObjectsV2Command`)
- `resp.Body` is a `ReadableStream` — you call `transformToString()` to get text
- `resp.Body?.transformToString()` — the `?.` is the **optional chaining operator** (equivalent to Python's `if resp.Body is not None`)

---

### TypeScript Concept: Optional Chaining (`?.`) and Nullish Coalescing (`??`)

```typescript
// Optional chaining — safe access on possibly undefined values
const content = await resp.Body?.transformToString('utf-8');
// If resp.Body is undefined, content = undefined (no error thrown)

// Nullish coalescing — default value if null/undefined
const port = parseInt(process.env['PORT'] ?? '8000', 10);
// If PORT is not set, use '8000'
```

**Python equivalents**:
```python
content = resp['Body'].read().decode('utf-8') if resp.get('Body') else None
port = int(os.environ.get('PORT', '8000'))
```

The TypeScript operators are more concise and compose naturally.

---

### TypeScript Concept: `glob` for File Discovery

```typescript
// Python
for p in sorted(base.rglob('*.md')):
    rel = p.relative_to(self._root / 'wiki')
    pages.append(str(rel)[:-3])

// TypeScript
import { glob } from 'glob';
const files = await glob('**/*.md', { cwd: base, nodir: true });
return files.sort().map((f) => f.replace(/\.md$/, ''));
```

**`Array.map()`** is the TypeScript/JS equivalent of Python list comprehensions:

```typescript
// TypeScript
files.map((f) => f.replace(/\.md$/, ''))

# Python equivalent
[str(p.relative_to(root))[:-3] for p in files]
```

**`/\.md$/`** is a JavaScript **regular expression literal** — equivalent to Python's `re.compile(r'\.md$')`. The `.replace()` method removes the trailing `.md`.

---

### TypeScript Concept: `Array.find()` for Snippets

```python
# Python — next() with generator
snippet = next(
    (ln.strip()[:200] for ln in content.splitlines() if query_lower in ln.lower()),
    ''
)
```

```typescript
// TypeScript equivalent
const snippet =
  content.split('\n').find((ln) => ln.toLowerCase().includes(queryLower))?.slice(0, 200) ?? '';
```

- `Array.find()` returns the first matching element or `undefined` — equivalent to Python's `next(gen, None)`
- `?.slice(0, 200)` — optional chaining: if `find()` returns `undefined`, `slice` is never called
- `?? ''` — nullish coalescing: returns `''` if the whole chain is `undefined`

---

## 16. `src/server.ts` — FastMCP Server in TypeScript

### TypeScript Concept: `import` vs Python `from x import y`

```typescript
// TypeScript
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { WikiKB } from './kb.js';    // ← .js extension required in ESM TypeScript

# Python equivalent
from fastmcp import FastMCP
from kb import WikiKB
```

> [!NOTE]
> The `.js` extension in `import './kb.js'` is counter-intuitive — you're importing `.ts` source but writing `.js`. This is correct for **ESM** (ECMAScript Modules) TypeScript with `NodeNext` module resolution. Node.js resolves `.js` to the compiled `.js` file at runtime. Never use `.ts` in imports.

---

### TypeScript Concept: Zod Schemas for Tool Parameters

The Python implementation used FastMCP's `@mcp.tool()` decorator with typed function parameters. TypeScript fastmcp uses **Zod schemas**:

```python
# Python — types extracted from function signature
@mcp.tool()
def get_page(path: str) -> str:
    """Returns a wiki page."""
    return kb.get_page(path)
```

```typescript
// TypeScript — Zod schema defines and validates input
server.addTool({
  name: 'get_page',
  description: 'Returns a wiki page by path.',
  parameters: z.object({
    path: z.string().min(1).describe('Wiki page path without .md'),
  }),
  execute: async ({ path }) => {
    return await kb.getPage(path);
  },
});
```

**Zod** is a TypeScript-first schema validation library. `z.object({})` defines the shape of the input. `z.string().min(1)` means: must be a string AND at least 1 character long. Zod throws a validation error automatically — you never receive an empty string.

| Zod primitive | Meaning |
|---|---|
| `z.string()` | Must be a string |
| `z.string().min(1)` | Non-empty string |
| `z.string().optional()` | String or undefined |
| `z.array(z.string())` | Array of strings |
| `z.array(z.string()).max(20)` | Array with max 20 items |
| `.describe('...')` | Adds description (appears in AI agent tool schema) |

---

### TypeScript Concept: `server.getApp()` — Hono Routes

This was the most significant API discovery during migration. The Python implementation used `@mcp.custom_route()` decorators. The TypeScript fastmcp 3.35.0 does **not** have `addRoute()` — instead it exposes the underlying **Hono** web server:

```typescript
// ❌ Wrong — addRoute() does not exist in fastmcp 3.35.0
server.addRoute('GET', '/healthz', async (_req, res) => { ... });

// ✅ Correct — getApp() returns the Hono instance
const app = server.getApp();
app.get('/healthz', async (c) => {
  return c.json({ status: 'ok' });
});
```

**Hono** is a lightweight web framework (similar to Python's Starlette or FastAPI). The context object `c` provides:

| Hono API | Python Starlette equivalent |
|---|---|
| `c.json(obj)` | `JSONResponse(obj)` |
| `c.json(obj, 400)` | `JSONResponse(obj, status_code=400)` |
| `c.req.query('key')` | `request.query_params.get('key')` |
| `c.text('hello')` | `Response('hello', media_type='text/plain')` |

> [!WARNING]
> `server.getApp()` must be called **before** `server.start()`. Routes added after `start()` are not guaranteed to be registered.

---

### TypeScript Concept: `as const` Type Assertions

```typescript
const server = new FastMCP({
  version: SERVICE_VERSION as `${number}.${number}.${number}`,
});
```

The `as` keyword is a **type assertion** — it tells the TypeScript compiler to treat the value as a specific type. Here `SERVICE_VERSION` is a `string` but FastMCP expects a semver template literal type. The assertion bridges the gap without changing the runtime value.

**Python equivalent**: there is no direct equivalent. Python type checkers use `cast()` from `typing` for the same purpose.

---

### TypeScript Concept: Template Literal Types

```typescript
`${number}.${number}.${number}`
```

This is a **template literal type** — a TypeScript type that matches strings following a specific pattern. `'1.0.0'` matches; `'latest'` does not. The compiler enforces the pattern at compile time.

---

### Transport Configuration

```typescript
// Python
if os.environ.get('MCP_MODE') == 'stdio':
    mcp.run()                               # stdio
else:
    uvicorn.run(mcp.http_app(), port=port)  # HTTP

// TypeScript
if (MCP_MODE === 'stdio') {
  server.start({ transportType: 'stdio' });
} else {
  server.start({
    transportType: 'httpStream',
    httpStream: { port: PORT },
  });
}
```

No uvicorn equivalent needed — fastmcp manages the Node.js HTTP server internally using Hono's `serve()` adapter.

---

## 17. `src/client.ts` — Dev CLI in TypeScript

### TypeScript Concept: `process.argv`

```typescript
// TypeScript
const [, , command, ...rest] = process.argv;

# Python equivalent
command, *rest = sys.argv[1], sys.argv[2:]
```

`process.argv` is Node.js's equivalent of Python's `sys.argv`. The destructuring `[, , command, ...rest]` skips the first two elements (node executable path and script path) and captures the rest.

**Destructuring** is a powerful TypeScript/JS feature:
```typescript
const [first, second, ...remaining] = ['a', 'b', 'c', 'd'];
// first = 'a', second = 'b', remaining = ['c', 'd']
```

---

### TypeScript Concept: `StreamableHTTPClientTransport`

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'wiki-mcp-cli', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(SERVER_URL)));
const result = await client.callTool({ name: 'get_index', arguments: {} });
await client.close();
```

```python
# Python equivalent
from fastmcp import Client
async with Client(SERVER_URL) as client:
    r = await client.call_tool('get_index', {})
```

The TypeScript version uses the official MCP SDK directly (more portable). The Python version used FastMCP's built-in client.

---

## 18. `Dockerfile` — Node.js 22 Multi-Stage Build

```dockerfile
# Stage 1: Install all dependencies (including devDependencies for build)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && yarn install --frozen-lockfile

# Stage 2: Compile TypeScript
FROM deps AS builder
COPY tsconfig.json ./
COPY src/ ./src/
RUN yarn build

# Stage 3: Minimal runtime — only compiled JS + production deps
FROM node:22-alpine AS runner
RUN addgroup -S wikimcp && adduser -S -G wikimcp -u 1001 wikimcp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

USER wikimcp
EXPOSE 8000
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:8000/healthz || exit 1
CMD ["node", "dist/server.js"]
```

**Three stages instead of two**:

| Stage | Purpose | Includes |
|---|---|---|
| `deps` | Install all dependencies | `node_modules/` (dev + prod) |
| `builder` | Compile TypeScript | `dist/*.js` |
| `runner` | Minimal runtime | `dist/` + prod `node_modules/` only |

**Source files are never in the final image** — only compiled output. This differs from the Python version where `kb.py` and `server.py` were copied directly.

---

## 19. Yarn 4 and the PnP → `node_modules` Switch

### What is Yarn PnP (Plug'n'Play)?

Yarn 4's default mode is **PnP (Plug'n'Play)** — instead of a `node_modules/` folder, packages are stored in a central cache and resolved via a generated `.pnp.cjs` loader file.

**Problem**: Node.js's native `node` binary does not know about PnP. Running `node dist/server.js` directly fails because it can't find packages without the PnP resolver:

```
Error: Cannot find package 'dotenv' imported from /app/dist/server.js
```

**Solution**: Add `.yarnrc.yml` to switch to classic `node_modules` resolution:

```yaml
# .yarnrc.yml
nodeLinker: node-modules
```

After running `yarn install` again, a `node_modules/` folder is created and `node dist/server.js` works without any special loader.

**Python analogy**: This is like the difference between using `pip install` into a global environment vs. a virtual environment (`venv`). PnP is like a smart venv that doesn't physically copy files — it just knows where they are. `node-modules` is like copying all packages into a local folder.

---

## 20. TypeScript Concepts Summary Table

| Concept | Where Used | Python Equivalent |
|---|---|---|
| `class` with access modifiers | `src/kb.ts` | `class` with `_` convention |
| `private`, `readonly` keywords | `src/kb.ts` | `_` prefix convention |
| Union types (`'s3' \| 'local'`) | `src/kb.ts` | `Literal['s3', 'local']` (mypy only) |
| `Map<K, V>` | `src/kb.ts` | `dict[K, V]` |
| `async/await` on class methods | `src/kb.ts` | `async def` with `await` |
| `Promise<string>` return type | `src/kb.ts` | `Coroutine[Any, Any, str]` |
| Optional chaining `?.` | `src/kb.ts` | `x if x is not None else None` |
| Nullish coalescing `??` | `src/kb.ts`, `src/server.ts` | `or` operator / `.get(key, default)` |
| Template literals `` `${var}` `` | `src/kb.ts` | f-strings `f"{var}"` |
| `Array.map((x) => ...)` | `src/kb.ts` | List comprehension `[f(x) for x in xs]` |
| `Array.filter((x) => ...)` | `src/kb.ts` | `[x for x in xs if cond]` |
| `Array.find((x) => ...)` | `src/kb.ts` | `next((x for x in xs if cond), None)` |
| Regex literal `/pattern/` | `src/kb.ts` | `re.compile(r'pattern')` |
| `import { X } from './file.js'` | All files | `from file import X` |
| `as` type assertion | `src/server.ts` | `cast(Type, value)` |
| Template literal types | `src/server.ts` | No direct equivalent |
| Zod `z.object({})` schemas | `src/server.ts` | `pydantic.BaseModel` / `dataclass` |
| `z.string().min(1).describe()` | `src/server.ts` | `Annotated[str, Field(min_length=1)]` |
| `server.getApp()` (Hono) | `src/server.ts` | `@mcp.custom_route()` decorator |
| `c.json(obj, status?)` | `src/server.ts` | `JSONResponse(obj, status_code=...)` |
| `c.req.query('key')` | `src/server.ts` | `request.query_params.get('key')` |
| Destructuring `[, , cmd, ...rest]` | `src/client.ts` | Slice + unpack `sys.argv[2:]` |
| `process.argv` | `src/client.ts` | `sys.argv` |
| `process.env['KEY']` | `src/server.ts` | `os.environ.get('KEY')` |
| `process.exit(1)` | `src/server.ts` | `sys.exit(1)` |
