"""
kb.py — Wiki content backend with local filesystem and S3 modes.

Local mode (development):
    Set WIKI_LOCAL_PATH to the knowledge-base repo root.
    Reads wiki/ pages and index.md directly from disk — no AWS needed.

S3 mode (production / K8s pod):
    Set WIKI_S3_BUCKET (and optionally WIKI_KB_PREFIX).
    Reads from the kb-docs/ prefix populated by sync-wiki.py.
    Uses EC2 Instance Profile credentials (IMDS) — zero K8s secrets.

Cache: 10-minute in-memory TTL for both modes.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

CACHE_TTL = 600       # 10 min
MAX_SEARCH = 20


class WikiKB:
    """
    Wiki content reader.  Instantiated once at server startup.

    Backend selection (checked in order):
      1. WIKI_S3_BUCKET set  → S3 mode
      2. WIKI_LOCAL_PATH set → local filesystem mode
      3. Neither             → RuntimeError at startup
    """

    def __init__(self) -> None:
        s3_bucket = os.environ.get("WIKI_S3_BUCKET", "")
        local_path = os.environ.get("WIKI_LOCAL_PATH", "")

        if s3_bucket:
            import boto3
            self._s3 = boto3.client("s3")
            self._bucket = s3_bucket
            self._prefix = os.environ.get("WIKI_KB_PREFIX", "kb-docs").rstrip("/")
            self._mode = "s3"
            log.info("WikiKB: S3 mode — s3://%s/%s/", self._bucket, self._prefix)
        elif local_path:
            self._root = Path(local_path)
            if not self._root.exists():
                raise RuntimeError(f"WIKI_LOCAL_PATH does not exist: {local_path}")
            self._mode = "local"
            log.info("WikiKB: local mode — %s", self._root)
        else:
            raise RuntimeError(
                "Set either WIKI_S3_BUCKET (production) or WIKI_LOCAL_PATH (local dev)"
            )

        # key → (timestamp, content or json-serialised list)
        self._cache: dict[str, tuple[float, str]] = {}

    # -----------------------------------------------------------------------
    # Cache
    # -----------------------------------------------------------------------

    def _get(self, key: str) -> Optional[str]:
        entry = self._cache.get(key)
        if entry and (time.monotonic() - entry[0]) < CACHE_TTL:
            return entry[1]
        return None

    def _put(self, key: str, value: str) -> None:
        self._cache[key] = (time.monotonic(), value)

    # -----------------------------------------------------------------------
    # Local backend
    # -----------------------------------------------------------------------

    def _local_path(self, wiki_path: str) -> Path:
        """
        Resolve a wiki path to a local filesystem path.

        'tools/argocd'    → <root>/wiki/tools/argocd.md
        'index'           → <root>/index.md
        """
        if not wiki_path.endswith(".md"):
            wiki_path = wiki_path + ".md"
        if wiki_path == "index.md":
            return self._root / "index.md"
        return self._root / "wiki" / wiki_path

    def _local_fetch(self, wiki_path: str) -> Optional[str]:
        path = self._local_path(wiki_path)
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8")

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

    # -----------------------------------------------------------------------
    # S3 backend
    # -----------------------------------------------------------------------

    def _s3_key(self, wiki_path: str) -> str:
        if not wiki_path.endswith(".md"):
            wiki_path = wiki_path + ".md"
        return f"{self._prefix}/{wiki_path}"

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

    # -----------------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------------

    def get_page(self, path: str) -> str:
        """
        Return full markdown content of a wiki page.

        path examples: 'tools/argocd', 'resume/agent-guide', 'index'
        """
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

    def get_pages_combined(self, paths: list[str]) -> str:
        """Fetch multiple pages and concatenate with dividers."""
        return "\n\n---\n\n".join(
            f"<!-- PAGE: {p} -->\n\n{self.get_page(p)}" for p in paths
        )

    def list_pages(self, category: str = "") -> list[str]:
        """List wiki page paths (without .md). Optional category filter."""
        cache_key = f"list:{category or '__all__'}"
        cached = self._get(cache_key)
        if cached is not None:
            return json.loads(cached)

        pages = (
            self._local_list(category) if self._mode == "local"
            else self._s3_list(category)
        )

        self._put(cache_key, json.dumps(pages))
        return pages

    def search(self, query: str, category: str = "") -> list[dict]:
        """
        Keyword search over page paths and content.
        Returns up to MAX_SEARCH results with { path, snippet }.
        """
        query_lower = query.lower()
        results: list[dict] = []

        for page_path in self.list_pages(category):
            # Fast path: title match (no content fetch)
            if query_lower in page_path.lower():
                results.append({"path": page_path, "snippet": f"(path match)"})
                if len(results) >= MAX_SEARCH:
                    break
                continue

            # Content search
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

    def get_index(self) -> str:
        return self.get_page("index")
