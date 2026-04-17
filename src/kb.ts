/**
 * kb.ts — Wiki content backend with local filesystem and S3 modes.
 *
 * Local mode (development):
 *   Set WIKI_LOCAL_PATH to the knowledge-base repo root.
 *   Reads wiki/ pages and index.md directly from disk — no AWS needed.
 *
 * S3 mode (production / K8s pod):
 *   Set WIKI_S3_BUCKET (and optionally WIKI_KB_PREFIX).
 *   Reads from the kb-docs/ prefix populated by sync-wiki.py.
 *   Uses EC2 Instance Profile credentials (IMDS) — zero K8s secrets.
 *
 * Cache: 10-minute in-memory TTL for both modes.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';

/** Cache entry shape: monotonic timestamp (ms) + string value. */
interface CacheEntry {
  ts: number;
  value: string;
}

/** One search result returned by {@link WikiKB.search}. */
export interface SearchResult {
  path: string;
  snippet: string;
}

/** Cache TTL in milliseconds (10 minutes). */
const CACHE_TTL_MS = 600_000;

/** Maximum number of search results returned. */
const MAX_SEARCH = 20;

/**
 * Wiki content reader.  Instantiated once at server startup and shared
 * across all request handlers.
 *
 * Backend selection (checked in order):
 *   1. WIKI_S3_BUCKET set  → S3 mode
 *   2. WIKI_LOCAL_PATH set → local filesystem mode
 *   3. Neither             → throws at construction time
 */
export class WikiKB {
  /** Resolved operating mode. */
  private readonly mode: 'local' | 's3';

  // ── Local-mode state ──────────────────────────────────────────────────────

  /** Absolute path to the knowledge-base repo root (local mode). */
  private readonly localRoot: string;

  // ── S3-mode state ─────────────────────────────────────────────────────────

  /** S3 client — lazily assigned in constructor (only in s3 mode). */
  private s3Client?: import('@aws-sdk/client-s3').S3Client;
  private readonly s3Bucket: string;
  private readonly s3Prefix: string;

  // ── Cache ─────────────────────────────────────────────────────────────────

  /** In-memory TTL cache: cache-key → { ts, value }. */
  private readonly cache = new Map<string, CacheEntry>();

  // ── Constructor ───────────────────────────────────────────────────────────

  /**
   * Initialises the backend from environment variables.
   *
   * @throws {Error} When neither WIKI_S3_BUCKET nor WIKI_LOCAL_PATH is set.
   */
  constructor() {
    const s3Bucket = process.env['WIKI_S3_BUCKET'] ?? '';
    const localPath = process.env['WIKI_LOCAL_PATH'] ?? '';
    this.s3Bucket = s3Bucket;
    this.s3Prefix = (process.env['WIKI_KB_PREFIX'] ?? 'kb-docs').replace(/\/$/, '');
    this.localRoot = localPath;

    if (s3Bucket) {
      this.mode = 's3';
      console.info(`WikiKB: S3 mode — s3://${s3Bucket}/${this.s3Prefix}/`);
    } else if (localPath) {
      this.mode = 'local';
      console.info(`WikiKB: local mode — ${localPath}`);
    } else {
      throw new Error('Set either WIKI_S3_BUCKET (production) or WIKI_LOCAL_PATH (local dev)');
    }
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────

  /**
   * Returns a cached value if it exists and has not expired.
   *
   * @param key - Cache key.
   * @returns The cached string, or `undefined` if absent / stale.
   */
  private cacheGet(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts < CACHE_TTL_MS) return entry.value;
    this.cache.delete(key); // evict stale entry eagerly
    return undefined;
  }

  /**
   * Stores a value in the cache with the current timestamp.
   *
   * @param key   - Cache key.
   * @param value - Value to store.
   */
  private cachePut(key: string, value: string): void {
    this.cache.set(key, { ts: Date.now(), value });
  }

  // ── Local backend ─────────────────────────────────────────────────────────

  /**
   * Resolves a wiki path to an absolute filesystem path.
   *
   * @example
   *   'tools/argocd'  → '<root>/wiki/tools/argocd.md'
   *   'index'         → '<root>/index.md'
   *
   * @param wikiPath - Wiki page path without `.md` extension.
   * @returns Absolute path string.
   */
  private localPath(wikiPath: string): string {
    const withExt = wikiPath.endsWith('.md') ? wikiPath : `${wikiPath}.md`;
    if (withExt === 'index.md') return path.join(this.localRoot, 'index.md');
    return path.join(this.localRoot, 'wiki', withExt);
  }

  /**
   * Reads a Markdown file from the local filesystem.
   *
   * @param wikiPath - Wiki page path without `.md` extension.
   * @returns File content, or `undefined` if the file does not exist.
   */
  private async localFetch(wikiPath: string): Promise<string | undefined> {
    try {
      return await readFile(this.localPath(wikiPath), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /**
   * Lists all Markdown page paths under `wiki/`, optionally filtered by category.
   *
   * @param category - Optional subdirectory name (e.g. `"resume"`).
   * @returns Sorted list of page paths without `.md` extension.
   */
  private async localList(category: string): Promise<string[]> {
    const base = category
      ? path.join(this.localRoot, 'wiki', category)
      : path.join(this.localRoot, 'wiki');

    const pattern = path.join(base, '**', '*.md').replace(/\\/g, '/');
    const wikiBase = path.join(this.localRoot, 'wiki');

    const files = await glob(pattern, { nodir: true });
    return files
      .map((f) => {
        const rel = path.relative(wikiBase, f);
        return rel.replace(/\.md$/, '').replace(/\\/g, '/');
      })
      .sort();
  }

  // ── S3 backend ────────────────────────────────────────────────────────────

  /**
   * Lazily initialises and returns the AWS S3 client.
   * Credentials are resolved from the EC2 Instance Profile (IMDS) automatically.
   *
   * @returns Shared {@link S3Client} instance.
   */
  private async getS3Client(): Promise<import('@aws-sdk/client-s3').S3Client> {
    if (!this.s3Client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.s3Client = new S3Client({});
    }
    return this.s3Client;
  }

  /**
   * Builds the S3 object key for a given wiki page path.
   *
   * @param wikiPath - Wiki page path without `.md` extension.
   * @returns S3 key string, e.g. `"kb-docs/tools/argocd.md"`.
   */
  private s3Key(wikiPath: string): string {
    const withExt = wikiPath.endsWith('.md') ? wikiPath : `${wikiPath}.md`;
    return `${this.s3Prefix}/${withExt}`;
  }

  /**
   * Downloads a single Markdown file from S3.
   *
   * @param wikiPath - Wiki page path without `.md` extension.
   * @returns File content as a string, or `undefined` if the object does not exist.
   * @throws Re-throws any S3 error that is not a 404 / NoSuchKey.
   */
  private async s3Fetch(wikiPath: string): Promise<string | undefined> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getS3Client();
    const key = this.s3Key(wikiPath);

    try {
      const resp = await client.send(new GetObjectCommand({ Bucket: this.s3Bucket, Key: key }));
      if (!resp.Body) return undefined;
      return await resp.Body.transformToString('utf-8');
    } catch (err) {
      const code = (err as { name?: string })?.name;
      if (code === 'NoSuchKey' || code === 'NotFound') return undefined;
      throw err;
    }
  }

  /**
   * Lists all Markdown page paths in S3 under the configured prefix.
   *
   * @param category - Optional sub-prefix to filter by (e.g. `"resume"`).
   * @returns Sorted list of page paths without `.md` extension.
   */
  private async s3List(category: string): Promise<string[]> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await this.getS3Client();

    const prefix = category ? `${this.s3Prefix}/${category}` : this.s3Prefix;

    const pages: string[] = [];
    let continuationToken: string | undefined;

    do {
      const resp = await client.send(
        new ListObjectsV2Command({
          Bucket: this.s3Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of resp.Contents ?? []) {
        const key = obj.Key ?? '';
        if (key.endsWith('.metadata.json')) continue;
        const rel = key.slice(this.s3Prefix.length + 1); // strip prefix + leading slash
        if (rel.endsWith('.md')) {
          pages.push(rel.slice(0, -3)); // strip .md
        }
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    return pages.sort();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns the full Markdown content of a wiki page.
   * Results are cached for {@link CACHE_TTL_MS}.
   *
   * @param pagePath - Wiki page path without `.md` extension,
   *                   e.g. `"tools/argocd"`, `"resume/agent-guide"`, `"index"`.
   * @returns Markdown content string, or a user-friendly not-found message.
   */
  async getPage(pagePath: string): Promise<string> {
    const cacheKey = `page:${pagePath}`;
    const cached = this.cacheGet(cacheKey);
    if (cached !== undefined) return cached;

    const content =
      this.mode === 'local' ? await this.localFetch(pagePath) : await this.s3Fetch(pagePath);

    if (content === undefined) {
      return (
        `[wiki-mcp] Page not found: "${pagePath}". ` +
        "Use list_pages() or get_index() to see what's available."
      );
    }

    this.cachePut(cacheKey, content);
    return content;
  }

  /**
   * Fetches multiple wiki pages and concatenates them with `---` dividers.
   *
   * @param paths - Array of wiki page paths (without `.md`).
   * @returns Combined Markdown string with HTML comment headers per page.
   */
  async getPagesCombined(paths: string[]): Promise<string> {
    const pages = await Promise.all(
      paths.map(async (p) => `<!-- PAGE: ${p} -->\n\n${await this.getPage(p)}`),
    );
    return pages.join('\n\n---\n\n');
  }

  /**
   * Lists available wiki page paths (without `.md` extension).
   * Results are cached for {@link CACHE_TTL_MS}.
   *
   * @param category - Optional category filter, e.g. `"resume"`, `"tools"`.
   * @returns Sorted list of page path strings.
   */
  async listPages(category = ''): Promise<string[]> {
    const cacheKey = `list:${category || '__all__'}`;
    const cached = this.cacheGet(cacheKey);
    if (cached !== undefined) return JSON.parse(cached) as string[];

    const pages =
      this.mode === 'local' ? await this.localList(category) : await this.s3List(category);

    this.cachePut(cacheKey, JSON.stringify(pages));
    return pages;
  }

  /**
   * Performs a case-insensitive keyword search over page paths and content.
   *
   * Two-phase approach:
   *   1. Fast path — checks page path (no I/O).
   *   2. Content path — loads and searches page body.
   *
   * @param query    - Search term, e.g. `"ArgoCD"`, `"DORA"`, `"Bedrock"`.
   * @param category - Optional category filter.
   * @returns Up to {@link MAX_SEARCH} results, each with `path` and `snippet`.
   */
  async search(query: string, category = ''): Promise<SearchResult[]> {
    const queryLower = query.toLowerCase();
    const results: SearchResult[] = [];
    const allPages = await this.listPages(category);

    for (const pagePath of allPages) {
      if (results.length >= MAX_SEARCH) break;

      // Fast path: title match — no content fetch required
      if (pagePath.toLowerCase().includes(queryLower)) {
        results.push({ path: pagePath, snippet: '(path match)' });
        continue;
      }

      // Content search
      const content = await this.getPage(pagePath);
      if (content.toLowerCase().includes(queryLower)) {
        const matchingLine = content
          .split('\n')
          .find((ln) => ln.toLowerCase().includes(queryLower));
        const snippet = matchingLine?.trim().slice(0, 200) ?? '';
        results.push({ path: pagePath, snippet });
      }
    }

    return results;
  }

  /**
   * Returns the full index page (`index.md`).
   * Convenience alias for {@link getPage}(`"index"`).
   *
   * @returns Markdown content of the index page.
   */
  async getIndex(): Promise<string> {
    return this.getPage('index');
  }
}
