/**
 * client.ts — Development test CLI for the wiki-mcp MCP server.
 *
 * Connects to a running wiki-mcp httpStream server and exercises MCP tools.
 * Requires the server to be running first (`yarn dev` in a separate terminal).
 *
 * Usage:
 *   yarn client                       # smoke test (index + list + constraints)
 *   yarn client get tools/argocd       # fetch a specific page
 *   yarn client search "DORA"          # keyword search
 *   yarn client list resume            # list a category
 *   yarn client combined a b c         # fetch multiple pages combined
 *
 * @module client
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SERVER_URL = process.env['MCP_SERVER_URL'] ?? 'http://localhost:8000';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates and connects a reusable MCP SDK client to the local server.
 *
 * @returns Connected {@link Client} instance.
 */
async function createClient(): Promise<Client> {
  const client = new Client({ name: 'wiki-mcp-test-cli', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`));
  await client.connect(transport);
  return client;
}

/**
 * Calls an MCP tool and returns the first text content block.
 *
 * @param client - Connected MCP client.
 * @param name   - Tool name, e.g. `"get_page"`.
 * @param args   - Tool arguments object.
 * @returns Text content of the tool response.
 */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

// ── Commands ───────────────────────────────────────────────────────────────

/**
 * Runs the default smoke test — exercises index, list, and constraints tools.
 *
 * @param client - Connected MCP client.
 */
async function smokeTest(client: Client): Promise<void> {
  console.log('\n=== get_index ===');
  const index = await callTool(client, 'get_index', {});
  console.log(index.slice(0, 600), '\n[truncated]');

  console.log('\n=== list_pages (resume) ===');
  const list = await callTool(client, 'list_pages', { category: 'resume' });
  console.log(list);

  console.log('\n=== get_resume_constraints ===');
  const constraints = await callTool(client, 'get_resume_constraints', {});
  console.log(constraints.slice(0, 800), '\n[truncated]');
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Main CLI dispatcher — parses `process.argv` and runs the appropriate command.
 */
async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const client = await createClient();

  try {
    switch (command) {
      case 'get': {
        const pagePath = rest[0];
        if (!pagePath) throw new Error('Usage: yarn client get <page-path>');
        console.log('\n=== get_page:', pagePath, '===');
        const content = await callTool(client, 'get_page', { path: pagePath });
        console.log(content);
        break;
      }

      case 'search': {
        const query = rest.join(' ');
        if (!query) throw new Error('Usage: yarn client search <query>');
        console.log('\n=== search:', query, '===');
        const results = await callTool(client, 'search', { query });
        console.log(results);
        break;
      }

      case 'list': {
        const category = rest[0] ?? '';
        console.log('\n=== list_pages:', category || '(all)', '===');
        const pages = await callTool(client, 'list_pages', { category });
        console.log(pages);
        break;
      }

      case 'combined': {
        if (rest.length === 0) throw new Error('Usage: yarn client combined <path1> <path2> ...');
        console.log('\n=== get_pages_combined:', rest.join(', '), '===');
        const combined = await callTool(client, 'get_pages_combined', { paths: rest });
        console.log(combined.slice(0, 1200), '\n[truncated]');
        break;
      }

      default: {
        await smokeTest(client);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error('[wiki-mcp-client] Error:', err);
  process.exit(1);
});
