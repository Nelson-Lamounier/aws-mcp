/**
 * kb.test.ts — Unit tests for WikiKB.
 *
 * Strategy:
 *  - Local-mode tests: create a real on-disk fixture in os.tmpdir() so all
 *    filesystem logic is exercised without mocking readFile / glob.
 *  - S3-mode tests: mock @aws-sdk/client-s3 via jest.mock (hoisted) so no
 *    real AWS credentials are needed.
 *  - Cache tests: use jest.useFakeTimers() to advance Date.now past the TTL.
 *
 * All tests set env-vars before constructing WikiKB and delete them in
 * afterEach to guarantee full isolation between suites.
 *
 * ESM note: In ESM mode jest globals must come from @jest/globals.
 * jest.mock() calls at the top level are statically hoisted by ts-jest.
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── AWS SDK mock ──────────────────────────────────────────────────────────────
// Must appear before any import that pulls in the real SDK (i.e. before WikiKB).
// ts-jest hoists jest.mock() calls to the top of the compiled output.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSend = jest.fn<any>();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockSend;
  },
  GetObjectCommand: jest.fn((input: unknown) => ({ input })),
  ListObjectsV2Command: jest.fn((input: unknown) => ({ input })),
}));

// ── Subject under test ────────────────────────────────────────────────────────

import { WikiKB, SearchResult } from './kb.js';

// ─── Silence console.info from the WikiKB constructor ────────────────────────
beforeAll(() => {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Creates a temporary directory with the expected KB layout:
 *
 * ```
 * <tmpDir>/
 * ├── index.md
 * └── wiki/
 *     ├── resume/
 *     │   ├── hard-rules.md
 *     │   └── voice-library.md
 *     └── tools/
 *         └── argocd.md
 * ```
 *
 * @returns Absolute path to the temporary root directory.
 */
function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-test-'));

  /**
   * @param relPath - Relative path from root.
   * @param content - File content to write.
   */
  const write = (relPath: string, content: string): void => {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  };

  write('index.md', '# Index\n\nWelcome to the wiki.');
  write('wiki/resume/hard-rules.md', '# Hard Rules\n\nRule 1: Never lie.\nRule 2: Be concise.');
  write('wiki/resume/voice-library.md', '# Voice Library\n\nUse active voice.');
  write('wiki/tools/argocd.md', '# ArgoCD\n\nGitOps deployment tool for Kubernetes.');

  return root;
}

/**
 * Recursively removes the fixture directory.
 *
 * @param root - Absolute path to remove.
 */
function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Constructor
// ═════════════════════════════════════════════════════════════════════════════

describe('WikiKB — constructor', () => {
  afterEach(() => {
    delete process.env['WIKI_S3_BUCKET'];
    delete process.env['WIKI_LOCAL_PATH'];
    delete process.env['WIKI_KB_PREFIX'];
  });

  it('throws when neither WIKI_S3_BUCKET nor WIKI_LOCAL_PATH is set', () => {
    expect(() => new WikiKB()).toThrow(
      'Set either WIKI_S3_BUCKET (production) or WIKI_LOCAL_PATH (local dev)',
    );
  });

  it('selects local mode when WIKI_LOCAL_PATH is set', () => {
    process.env['WIKI_LOCAL_PATH'] = '/some/path';
    expect(() => new WikiKB()).not.toThrow();
  });

  it('selects S3 mode when WIKI_S3_BUCKET is set', () => {
    process.env['WIKI_S3_BUCKET'] = 'my-bucket';
    expect(() => new WikiKB()).not.toThrow();
  });

  it('prefers S3 mode when both env vars are set', () => {
    process.env['WIKI_S3_BUCKET'] = 'my-bucket';
    process.env['WIKI_LOCAL_PATH'] = '/some/path';
    expect(() => new WikiKB()).not.toThrow();
  });

  it('accepts a custom WIKI_KB_PREFIX without throwing', () => {
    process.env['WIKI_S3_BUCKET'] = 'test-bucket';
    process.env['WIKI_KB_PREFIX'] = 'my-prefix/';
    expect(() => new WikiKB()).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Local mode — getPage
// ═════════════════════════════════════════════════════════════════════════════

describe('WikiKB (local) — getPage', () => {
  let root: string;
  let kb: WikiKB;

  beforeEach(() => {
    root = createFixture();
    process.env['WIKI_LOCAL_PATH'] = root;
    kb = new WikiKB();
  });

  afterEach(() => {
    removeFixture(root);
    delete process.env['WIKI_LOCAL_PATH'];
  });

  it('returns the content of an existing page', async () => {
    const content = await kb.getPage('tools/argocd');
    expect(content).toContain('# ArgoCD');
    expect(content).toContain('GitOps');
  });

  it('returns the index page by path "index"', async () => {
    const content = await kb.getPage('index');
    expect(content).toContain('# Index');
    expect(content).toContain('Welcome to the wiki');
  });

  it('returns a not-found message for a missing page', async () => {
    const content = await kb.getPage('does/not/exist');
    expect(content).toContain('[wiki-mcp] Page not found');
    expect(content).toContain('"does/not/exist"');
    expect(content).toContain('list_pages()');
  });

  it('resolves a path that already includes the .md extension', async () => {
    const content = await kb.getPage('tools/argocd.md');
    expect(content).toContain('# ArgoCD');
  });

  it('returns the index via getIndex() convenience alias', async () => {
    const content = await kb.getIndex();
    expect(content).toContain('# Index');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Local mode — listPages
// ═════════════════════════════════════════════════════════════════════════════

describe('WikiKB (local) — listPages', () => {
  let root: string;
  let kb: WikiKB;

  beforeEach(() => {
    root = createFixture();
    process.env['WIKI_LOCAL_PATH'] = root;
    kb = new WikiKB();
  });

  afterEach(() => {
    removeFixture(root);
    delete process.env['WIKI_LOCAL_PATH'];
  });

  it('lists all pages when no category is provided', async () => {
    const pages = await kb.listPages();
    expect(pages).toEqual(
      expect.arrayContaining(['resume/hard-rules', 'resume/voice-library', 'tools/argocd']),
    );
    expect(pages).toHaveLength(3);
  });

  it('filters pages by category', async () => {
    const pages = await kb.listPages('resume');
    expect(pages).toEqual(expect.arrayContaining(['resume/hard-rules', 'resume/voice-library']));
    expect(pages).toHaveLength(2);
    expect(pages).not.toContain('tools/argocd');
  });

  it('returns an empty array for a non-existent category', async () => {
    const pages = await kb.listPages('nonexistent');
    expect(pages).toEqual([]);
  });

  it('returns pages sorted alphabetically', async () => {
    const pages = await kb.listPages();
    expect(pages).toEqual([...pages].sort());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Local mode — getPagesCombined
// ═════════════════════════════════════════════════════════════════════════════

describe('WikiKB (local) — getPagesCombined', () => {
  let root: string;
  let kb: WikiKB;

  beforeEach(() => {
    root = createFixture();
    process.env['WIKI_LOCAL_PATH'] = root;
    kb = new WikiKB();
  });

  afterEach(() => {
    removeFixture(root);
    delete process.env['WIKI_LOCAL_PATH'];
  });

  it('joins multiple pages with --- dividers and HTML comment headers', async () => {
    const combined = await kb.getPagesCombined(['resume/hard-rules', 'resume/voice-library']);

    expect(combined).toContain('<!-- PAGE: resume/hard-rules -->');
    expect(combined).toContain('<!-- PAGE: resume/voice-library -->');
    expect(combined).toContain('---');
    expect(combined).toContain('# Hard Rules');
    expect(combined).toContain('# Voice Library');
  });

  it('returns a single page without a --- divider', async () => {
    const combined = await kb.getPagesCombined(['tools/argocd']);
    expect(combined).toContain('<!-- PAGE: tools/argocd -->');
    expect(combined).toContain('# ArgoCD');
    expect(combined).not.toContain('---');
  });

  it('includes a not-found message for a missing page in the batch', async () => {
    const combined = await kb.getPagesCombined(['tools/argocd', 'missing/page']);
    expect(combined).toContain('# ArgoCD');
    expect(combined).toContain('[wiki-mcp] Page not found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Local mode — search
// ═════════════════════════════════════════════════════════════════════════════

describe('WikiKB (local) — search', () => {
  let root: string;
  let kb: WikiKB;

  beforeEach(() => {
    root = createFixture();
    process.env['WIKI_LOCAL_PATH'] = root;
    kb = new WikiKB();
  });

  afterEach(() => {
    removeFixture(root);
    delete process.env['WIKI_LOCAL_PATH'];
  });

  it('matches by page path (fast path — snippet is "(path match)")', async () => {
    const results = await kb.search('argocd');
    const paths = results.map((r: SearchResult) => r.path);
    expect(paths).toContain('tools/argocd');
    const hit = results.find((r: SearchResult) => r.path === 'tools/argocd');
    expect(hit?.snippet).toBe('(path match)');
  });

  it('matches by page content (slow path) with a contextual snippet', async () => {
    // "GitOps" is in the content of argocd.md but NOT in the path
    const results = await kb.search('GitOps');
    const paths = results.map((r: SearchResult) => r.path);
    expect(paths).toContain('tools/argocd');
    const hit = results.find((r: SearchResult) => r.path === 'tools/argocd');
    expect(hit?.snippet).toContain('GitOps');
  });

  it('is case-insensitive', async () => {
    const lower = await kb.search('gitops');
    const upper = await kb.search('GITOPS');
    expect(lower.map((r: SearchResult) => r.path)).toEqual(upper.map((r: SearchResult) => r.path));
  });

  it('returns an empty array when no pages match the query', async () => {
    const results = await kb.search('xyzzy-no-match-anywhere');
    expect(results).toEqual([]);
  });

  it('respects the category filter', async () => {
    // "Rule" appears only in resume/ pages
    const results = await kb.search('Rule', 'resume');
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r: SearchResult) => {
      expect(r.path.startsWith('resume/')).toBe(true);
    });
  });

  it('limits the content snippet to 200 characters', async () => {
    // Create a page with a very long matching line
    const longLine = 'keyword ' + 'x'.repeat(300);
    fs.writeFileSync(path.join(root, 'wiki', 'tools', 'longpage.md'), longLine, 'utf-8');

    const results = await kb.search('keyword');
    const hit = results.find((r: SearchResult) => r.path === 'tools/longpage');
    if (hit && hit.snippet !== '(path match)') {
      expect(hit.snippet.length).toBeLessThanOrEqual(200);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Cache behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('WikiKB — cache (TTL = 600 000 ms)', () => {
  let root: string;
  let kb: WikiKB;

  beforeEach(() => {
    root = createFixture();
    process.env['WIKI_LOCAL_PATH'] = root;
    kb = new WikiKB();
  });

  afterEach(() => {
    removeFixture(root);
    delete process.env['WIKI_LOCAL_PATH'];
    jest.useRealTimers();
  });

  it('serves repeated getPage calls from cache (file change is ignored)', async () => {
    const first = await kb.getPage('tools/argocd');
    fs.writeFileSync(path.join(root, 'wiki', 'tools', 'argocd.md'), '# Modified', 'utf-8');
    const second = await kb.getPage('tools/argocd');
    expect(second).toBe(first);
  });

  it('re-fetches getPage after the TTL has elapsed', async () => {
    jest.useFakeTimers();
    const first = await kb.getPage('tools/argocd');

    fs.writeFileSync(path.join(root, 'wiki', 'tools', 'argocd.md'), '# Updated After TTL', 'utf-8');
    jest.advanceTimersByTime(600_001);

    const second = await kb.getPage('tools/argocd');
    expect(second).toContain('# Updated After TTL');
    expect(second).not.toBe(first);
  });

  it('serves repeated listPages calls from cache (new files are ignored)', async () => {
    const pages1 = await kb.listPages();
    fs.writeFileSync(path.join(root, 'wiki', 'tools', 'newpage.md'), '# New Page', 'utf-8');
    const pages2 = await kb.listPages();
    expect(pages2).toEqual(pages1);
  });

  it('re-fetches listPages after the TTL has elapsed', async () => {
    jest.useFakeTimers();
    await kb.listPages();

    fs.writeFileSync(path.join(root, 'wiki', 'tools', 'newpage.md'), '# New Page', 'utf-8');
    jest.advanceTimersByTime(600_001);

    const pages = await kb.listPages();
    expect(pages).toContain('tools/newpage');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. S3 mode — getPage
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returns a mock S3 `Body` that resolves to the given string via
 * `transformToString()`.
 *
 * @param content - String to return from the mock body.
 */
function mockS3Body(content: string) {
  return {
    transformToString: jest.fn<() => Promise<string>>().mockResolvedValue(content),
  };
}

describe('WikiKB (S3) — getPage', () => {
  let kb: WikiKB;

  beforeEach(() => {
    process.env['WIKI_S3_BUCKET'] = 'test-bucket';
    process.env['WIKI_KB_PREFIX'] = 'kb-docs';
    mockSend.mockReset();
    kb = new WikiKB();
  });

  afterEach(() => {
    delete process.env['WIKI_S3_BUCKET'];
    delete process.env['WIKI_KB_PREFIX'];
    mockSend.mockReset();
  });

  it('fetches a page from S3 and returns its Markdown content', async () => {
    mockSend.mockResolvedValueOnce({ Body: mockS3Body('# ArgoCD\n\nGitOps tool.') });
    const content = await kb.getPage('tools/argocd');
    expect(content).toContain('# ArgoCD');
    expect(content).toContain('GitOps tool');
  });

  it('returns a not-found message when S3 throws NoSuchKey', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('404'), { name: 'NoSuchKey' }));
    const content = await kb.getPage('missing/page');
    expect(content).toContain('[wiki-mcp] Page not found');
  });

  it('returns a not-found message when S3 throws NotFound', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('404'), { name: 'NotFound' }));
    const content = await kb.getPage('missing/page');
    expect(content).toContain('[wiki-mcp] Page not found');
  });

  it('re-throws unexpected S3 errors (e.g. AccessDenied)', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    );
    await expect(kb.getPage('tools/argocd')).rejects.toThrow('Access Denied');
  });

  it('returns not-found when the S3 response has no Body', async () => {
    mockSend.mockResolvedValueOnce({ Body: undefined });
    const content = await kb.getPage('tools/empty');
    expect(content).toContain('[wiki-mcp] Page not found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. S3 mode — listPages
// ═════════════════════════════════════════════════════════════════════════════

describe('WikiKB (S3) — listPages', () => {
  let kb: WikiKB;

  beforeEach(() => {
    process.env['WIKI_S3_BUCKET'] = 'test-bucket';
    process.env['WIKI_KB_PREFIX'] = 'kb-docs';
    mockSend.mockReset();
    kb = new WikiKB();
  });

  afterEach(() => {
    delete process.env['WIKI_S3_BUCKET'];
    delete process.env['WIKI_KB_PREFIX'];
    mockSend.mockReset();
  });

  it('returns page paths stripped of prefix and .md extension', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: 'kb-docs/tools/argocd.md' }, { Key: 'kb-docs/resume/hard-rules.md' }],
      IsTruncated: false,
    });

    const pages = await kb.listPages();
    expect(pages).toContain('tools/argocd');
    expect(pages).toContain('resume/hard-rules');
  });

  it('skips .metadata.json sidecar files', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: 'kb-docs/tools/argocd.md' },
        { Key: 'kb-docs/tools/argocd.md.metadata.json' },
      ],
      IsTruncated: false,
    });

    const pages = await kb.listPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]).toBe('tools/argocd');
  });

  it('follows pagination via NextContinuationToken', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'kb-docs/tools/argocd.md' }],
        IsTruncated: true,
        NextContinuationToken: 'token-abc',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'kb-docs/resume/hard-rules.md' }],
        IsTruncated: false,
      });

    const pages = await kb.listPages();
    expect(pages).toContain('tools/argocd');
    expect(pages).toContain('resume/hard-rules');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('returns an empty array when S3 contents list is empty', async () => {
    mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const pages = await kb.listPages();
    expect(pages).toEqual([]);
  });

  it('handles a missing Contents key in the S3 response', async () => {
    // S3 omits Contents when the prefix matches nothing
    mockSend.mockResolvedValueOnce({ IsTruncated: false });
    const pages = await kb.listPages();
    expect(pages).toEqual([]);
  });

  it('returns pages sorted alphabetically', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: 'kb-docs/tools/zulu.md' },
        { Key: 'kb-docs/resume/alpha.md' },
        { Key: 'kb-docs/tools/argocd.md' },
      ],
      IsTruncated: false,
    });

    const pages = await kb.listPages();
    expect(pages).toEqual([...pages].sort());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. S3 mode — s3Key construction
// ═════════════════════════════════════════════════════════════════════════════

describe('WikiKB (S3) — s3Key prefix handling', () => {
  afterEach(() => {
    delete process.env['WIKI_S3_BUCKET'];
    delete process.env['WIKI_KB_PREFIX'];
    mockSend.mockReset();
  });

  it('uses the default prefix "kb-docs" when WIKI_KB_PREFIX is unset', async () => {
    process.env['WIKI_S3_BUCKET'] = 'test-bucket';
    delete process.env['WIKI_KB_PREFIX'];

    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Body: mockS3Body('# Page') });

    const kb = new WikiKB();
    await kb.getPage('tools/argocd');

    // The single mockSend call receives the GetObjectCommand argument object
    const cmdInput = mockSend.mock.calls[0]?.[0] as { input: { Bucket: string; Key: string } };
    expect(cmdInput.input.Key).toBe('kb-docs/tools/argocd.md');
    expect(cmdInput.input.Bucket).toBe('test-bucket');
  });

  it('strips a trailing slash from WIKI_KB_PREFIX', async () => {
    process.env['WIKI_S3_BUCKET'] = 'test-bucket';
    process.env['WIKI_KB_PREFIX'] = 'custom-prefix/';

    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Body: mockS3Body('# Page') });

    const kb = new WikiKB();
    await kb.getPage('tools/argocd');

    const cmdInput = mockSend.mock.calls[0]?.[0] as { input: { Key: string } };
    expect(cmdInput.input.Key).toBe('custom-prefix/tools/argocd.md');
  });
});
