import { afterEach, describe, expect, it } from 'vitest';
import { createServer, get, type Server as HTTPServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDB } from '../src/db.js';
import { MockPaper, mockAdapter, LivePaper, catalog } from '../src/paper.js';
import { Schemas } from '../src/schema.js';
import { Engine } from '../src/engine.js';
import { mcpServer } from '../src/mcp.js';
import { serveWeb } from '../src/web.js';
import { config, DEV_SECRET } from '../src/config.js';
const cleanup: (() => any)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const db = openDB(':memory:');
  cleanup.push(() => db.close());
  const paper = new MockPaper(),
    schemas = new Schemas(db, paper, 'mock', 60000, 'integration');
  await schemas.refresh();
  return new Engine(db, paper, schemas, mockAdapter, DEV_SECRET);
}
const close = (s: HTTPServer) =>
  new Promise<void>((resolve, reject) => {
    s.closeAllConnections();
    s.close((e) => (e ? reject(e) : resolve()));
  });
const parse = (r: any) => JSON.parse(r.content[0].text);
describe('MCP boundary', () => {
  it('discovers contracts, stages through MCP, blocks self-approval and admits human-approved work', async () => {
    const engine = await setup(),
      server = mcpServer(engine),
      client = new Client({ name: 'test-agent', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    cleanup.push(() => client.close());
    cleanup.push(() => server.close());
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('merge_write_draft');
    expect(tools.tools.map((t) => t.name)).toContain('finish_working_on_nodes');
    expect(tools.tools.map((t) => t.name)).not.toContain('merge_resolve');
    expect(tools.tools.map((t) => t.name)).not.toContain('write_html');
    const contracts = parse(await client.callTool({ name: 'merge_list_contracts', arguments: {} }));
    expect(contracts.source).toBe('catalog');
    expect(contracts.tools.find((t: any) => t.name === 'write_html').inputSchema).toBeDefined();
    const r = parse(
      await client.callTool({
        name: 'merge_open_draft',
        arguments: { title: 'Agent change', agent: 'Codex' },
      }),
    );
    const stage = parse(
      await client.callTool({
        name: 'merge_write_draft',
        arguments: {
          reviewId: r.review.id,
          tool: 'write_html',
          arguments: { targetNodeId: 'hero', html: '<h1>Hello</h1><p>World</p>' },
        },
      }),
    );
    expect(stage.ops).toHaveLength(2);
    const blocked = await client.callTool({
      name: 'merge_resolve',
      arguments: { reviewId: r.review.id },
    });
    expect(blocked.isError).toBe(true);
    const approval = await engine.approve(r.review.id, stage.diffHash);
    const report = parse(
      await client.callTool({
        name: 'merge_commit',
        arguments: { reviewId: r.review.id, approvalToken: approval.approvalToken },
      }),
    );
    expect(report).toMatchObject({ status: 'admitted', atomic: false });
  });
  it('starts the CLI on stdio with protocol-clean stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-stdio-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new Client({ name: 'stdio-test', version: '1' }),
      transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', resolve('src/cli.ts'), 'serve'],
        env: {
          ...(Object.fromEntries(
            Object.entries(process.env).filter(([, v]) => v !== undefined),
          ) as Record<string, string>),
          PAPER_MCP_MODE: 'mock',
          AIRLOCK_DATA_DIR: dir,
        },
        stderr: 'pipe',
      });
    cleanup.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools.some((t) => t.name === 'merge_list_contracts')).toBe(true);
    const r = parse(
      await client.callTool({ name: 'merge_open_draft', arguments: { title: 'Across processes' } }),
    );
    expect(r.review.status).toBe('pending');
  }, 20000);
});
describe('local human API', () => {
  async function web() {
    const engine = await setup(),
      cfg = { ...config({}), port: 0 };
    const server = await serveWeb(engine, cfg);
    cleanup.push(() => close(server));
    cfg.port = (server.address() as any).port;
    const url = `http://127.0.0.1:${cfg.port}`;
    const state = await (await fetch(url + '/api/state')).json();
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(url + '/api/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Airlock-CSRF': state.csrf, ...headers },
        body: JSON.stringify(body),
      });
      return res.json();
    };
    return { engine, url, state, post };
  }
  it('serves the UI, requires CSRF and rejects foreign origins and hosts', async () => {
    const { url } = await web();
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Visual Merge Compiler');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const noCSRF = await fetch(url + '/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"bad"}',
    });
    expect((await noCSRF.json()).error.code).toBe('invalid_csrf');
    const origin = await fetch(url + '/api/state', {
      headers: { Origin: 'https://untrusted.example' },
    });
    expect((await origin.json()).error.code).toBe('invalid_origin');
    const host = await new Promise<any>((resolve, reject) => {
      const req = get(url + '/api/state', { headers: { Host: 'untrusted.example' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
    });
    expect(host.error.code).toBe('invalid_host');
  });
  it('serves the compiler and commits its chosen contrast resolution', async () => {
    const { url, post } = await web();
    expect((await fetch(url + '/compiler.js')).status).toBe(200);
    const { draftIds, intent } = await post('merge/demo', {});
    expect(intent.conflicts[0].kind).toBe('cross_keyspace_contrast');
    const resolution = await post('merge/resolve', {
      draftIds, selections: { '--color-text': '#ffffff' }, intentHash: intent.intentHash,
    });
    const ledger = await post('admit', {
      reviewId: resolution.draftId, approvalToken: resolution.approvalToken,
    });
    expect(ledger).toMatchObject({ status: 'admitted', atomic: false });
    expect(ledger.groups.every((group: { status: string }) => group.status === 'applied')).toBe(true);
  });
  it('completes open → stage → inspect → approve → admit and never returns stored token hashes', async () => {
    const { engine, url, post } = await web();
    const r = await post('open', { title: 'Human flow' });
    const staged = await post('stage', {
      reviewId: r.review.id,
      tool: 'set_tokens',
      arguments: { tokens: { '--accent': 'green' } },
    });
    expect(staged.ops[0].space).toBe('token');
    expect(engine.paper instanceof MockPaper && (engine.paper as MockPaper).state.tokens).toEqual(
      {},
    );
    const approval = await post('approve', { reviewId: r.review.id, diffHash: staged.diffHash });
    expect(approval.approvalToken).toBeDefined();
    const state = await (await fetch(url + '/api/state')).text();
    expect(state).not.toContain(approval.approvalToken);
    expect(state).not.toContain('approval_token_hash');
    const report = await post('admit', {
      reviewId: r.review.id,
      approvalToken: approval.approvalToken,
    });
    expect(report).toMatchObject({ atomic: false, status: 'admitted' });
  });
  it('rejects approval when unseen changes were staged after the displayed diff', async () => {
    const { post } = await web();
    const r = await post('open', { title: 'Changing review' });
    const staged = await post('stage', {
      reviewId: r.review.id,
      tool: 'set_tokens',
      arguments: { tokens: { '--a': 'red' } },
    });
    await post('stage', {
      reviewId: r.review.id,
      tool: 'set_tokens',
      arguments: { tokens: { '--b': 'blue' } },
    });
    expect(
      (await post('approve', { reviewId: r.review.id, diffHash: staged.diffHash })).error.code,
    ).toBe('stale_diff');
    expect((await post('approve', { reviewId: r.review.id })).error.code).toBe(
      'diff_hash_required',
    );
  });
});
describe('remote-capable upstream transport', () => {
  it('connects with Streamable HTTP headers and follows tools/list pagination', async () => {
    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      seen.push(req.headers.authorization ?? '');
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const mcp = new Server(
        { name: 'fixture-endpoint', version: '1' },
        { capabilities: { tools: {} } },
      );
      mcp.setRequestHandler(ListToolsRequestSchema, async (r) =>
        r.params?.cursor
          ? { tools: catalog.slice(2) as any }
          : { tools: catalog.slice(0, 2) as any, nextCursor: 'page-2' },
      );
      mcp.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: 'text', text: 'fixture response' }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => close(server));
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
    const paper = new LivePaper(
      config({
        PAPER_MCP_MODE: 'live',
        AIRLOCK_LIVE_CONFIRM: '1',
        AIRLOCK_APPROVAL_SECRET: 's'.repeat(32),
        PAPER_MCP_ENDPOINT: endpoint,
        PAPER_MCP_HEADERS: '{"Authorization":"Bearer fixture-only"}',
      }),
    );
    cleanup.push(() => paper.close());
    expect((await paper.listTools()).map((t) => t.name)).toEqual(catalog.map((t) => t.name));
    expect(await paper.callTool('finish_working_on_nodes', {})).toMatchObject({
      content: [{ text: 'fixture response' }],
    });
    // Adapter-style requests must reach the real SDK with a string params.name.
    expect(await paper.callTool({ name: 'finish_working_on_nodes', arguments: {} })).toMatchObject({
      content: [{ text: 'fixture response' }],
    });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((header) => header === 'Bearer fixture-only')).toBe(true);
  }, 20000);
});
