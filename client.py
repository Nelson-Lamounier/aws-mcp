"""
client.py — Local test client for wiki-mcp.

Requires the server to be running:
    python server.py

Usage:
    python client.py                    # smoke test: index + resume constraints
    python client.py get tools/argocd   # fetch a specific page
    python client.py search "DORA"      # keyword search
    python client.py list resume        # list pages in a category
"""

from __future__ import annotations

import asyncio
import sys

from fastmcp import Client

SERVER_URL = "http://localhost:8000/mcp"


async def smoke_test() -> None:
    """Default: run a quick smoke test of the key tools."""
    async with Client(SERVER_URL) as client:
        print("=== get_index (first 500 chars) ===")
        r = await client.call_tool("get_index", {})
        text = str(r.data or "")
        print(text[:500], "..." if len(text) > 500 else "")

        print("\n=== list_pages(resume) ===")
        r = await client.call_tool("list_pages", {"category": "resume"})
        for page in (r.data or []):
            print(" ", page)

        print("\n=== get_resume_constraints (first 400 chars) ===")
        r = await client.call_tool("get_resume_constraints", {})
        text = str(r.data or "")
        print(text[:400], "..." if len(text) > 400 else "")

        print("\n✅  Smoke test passed.")


async def get_page(path: str) -> None:
    async with Client(SERVER_URL) as client:
        r = await client.call_tool("get_page", {"path": path})
        print(r.data or "(not found)")


async def search(query: str) -> None:
    async with Client(SERVER_URL) as client:
        r = await client.call_tool("search", {"query": query})
        for item in (r.data or []):
            print(f"  {item['path']}: {item['snippet'][:80]}")


async def list_pages(category: str = "") -> None:
    async with Client(SERVER_URL) as client:
        r = await client.call_tool("list_pages", {"category": category})
        for page in (r.data or []):
            print(" ", page)


if __name__ == "__main__":
    args = sys.argv[1:]

    if not args:
        asyncio.run(smoke_test())
    elif args[0] == "get" and len(args) == 2:
        asyncio.run(get_page(args[1]))
    elif args[0] == "search" and len(args) == 2:
        asyncio.run(search(args[1]))
    elif args[0] == "list":
        asyncio.run(list_pages(args[1] if len(args) > 1 else ""))
    else:
        print("Usage: python client.py [get <path> | search <query> | list [category]]")
        sys.exit(1)
