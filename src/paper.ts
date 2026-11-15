import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseCommand } from 'shell-quote';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  fail,
  type Adapter,
  type Paper,
  type Snapshot,
  type Tool,
  type ToolClass,
  type ToolCall,
  toolCall,
} from './core.js';
import type { Config } from './config.js';
import { normalize } from './html.js';
import type { DB } from './db.js';
// Names + rough purposes only. This map is NOT a schema or a write adapter.
export const capabilities: Record<string, { kind: ToolClass; purpose: string }> = {
  get_basic_info: { kind: 'read', purpose: 'Inspect the open file' },
  get_selection: { kind: 'read', purpose: 'Inspect selection' },
  get_node_info: { kind: 'read', purpose: 'Inspect nodes' },
  get_children: { kind: 'read', purpose: 'Inspect child nodes' },
  get_tree_summary: { kind: 'read', purpose: 'Inspect canvas structure' },
  get_screenshot: { kind: 'read', purpose: 'Render a screenshot' },
  get_jsx: { kind: 'read', purpose: 'Read a code representation' },
  get_computed_styles: { kind: 'read', purpose: 'Inspect resolved styles' },
  write_html: { kind: 'write', purpose: 'Create or update HTML-derived canvas nodes' },
  update_styles: { kind: 'write', purpose: 'Change styles' },
  set_text: { kind: 'write', purpose: 'Change text' },
  delete_nodes: { kind: 'write', purpose: 'Remove nodes' },
  create_artboard: { kind: 'write', purpose: 'Create an artboard' },
  duplicate_nodes: { kind: 'write', purpose: 'Duplicate nodes' },
  finish_working_on_nodes: {
    kind: 'passthrough',
    purpose: 'Release working indicators; never staged',
  },
};
export function classify(name: string, adapter?: Adapter): ToolClass {
  if (name === 'finish_working_on_nodes') return 'passthrough';
  const declared = adapter?.classify(name);
  // Adapters cannot reclassify known writes as read/passthrough.
  if (capabilities[name]?.kind === 'write') return 'write';
  return declared ?? capabilities[name]?.kind ?? 'write';
}
export function stdioCommand(endpoint: string) {
  const parts = parseCommand(endpoint.slice(6), {});
  if (!parts.length || parts.some((p) => typeof p !== 'string'))
    fail(
      'invalid_endpoint',
      'stdio commands must contain only a command and quoted arguments; shell operators are forbidden.',
    );
  const [command, ...args] = parts as string[];
  if (!command) fail('invalid_endpoint');
  return { command, args };
}
export async function connectWithTimeout(
  client: { connect(t: any): Promise<void>; close(): Promise<void> },
  transport: any,
  endpoint: string,
  ms: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Could not connect to Paper MCP at ${endpoint}. Is Paper Desktop running with a file open?`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } catch (e) {
    void client.close().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
export class LivePaper implements Paper {
  private client?: Client;
  constructor(private cfg: Config) {}
  async connected() {
    if (this.client) return this.client;
    const client = new Client({ name: 'airlock', version: '0.1.0' }, { capabilities: {} });
    let transport;
    if (this.cfg.endpoint.startsWith('stdio:'))
      transport = new StdioClientTransport({
        ...stdioCommand(this.cfg.endpoint),
        stderr: 'inherit',
      });
    else {
      let url: URL;
      try {
        url = new URL(this.cfg.endpoint);
      } catch {
        return fail('invalid_endpoint');
      }
      if (!['http:', 'https:'].includes(url.protocol)) fail('invalid_endpoint');
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: this.cfg.headers },
      });
    }
    await connectWithTimeout(client, transport, this.cfg.endpoint, this.cfg.timeout);
    this.client = client;
    return client;
  }
  async listTools() {
    const c = await this.connected();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await c.listTools({ cursor });
      tools.push(...(page.tools as Tool[]));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) fail('invalid_pagination');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return tools;
  }
  async callTool(request: string | ToolCall, args?: Record<string, unknown>) {
    const call = toolCall(request, args);
    return (await this.connected()).callTool(call);
  }
  async close() {
    await this.client?.close();
    this.client = undefined;
  }
}
// Entire catalog below is a MOCK-ONLY fixture. Never used to validate live calls.
export const catalog: Tool[] = [
  {
    name: 'get_canvas',
    description: 'Mock fixture: canvas and global tokens',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'write_html',
    description: 'Mock fixture: replace one target subtree with HTML',
    inputSchema: {
      type: 'object',
      required: ['targetNodeId', 'html'],
      properties: { targetNodeId: { type: 'string', minLength: 1 }, html: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'set_tokens',
    description: 'Mock fixture: set global custom properties',
    inputSchema: {
      type: 'object',
      required: ['tokens'],
      properties: {
        tokens: {
          type: 'object',
          propertyNames: { pattern: '^--[\\w-]+$' },
          additionalProperties: { type: ['string', 'null'] },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'finish_working_on_nodes',
    description: 'Mock fixture: release indicators',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
export const mockAdapter: Adapter = {
  classify: (name) =>
    name === 'get_canvas'
      ? 'read'
      : name === 'finish_working_on_nodes'
        ? 'passthrough'
        : ['write_html', 'set_tokens'].includes(name)
          ? 'write'
          : undefined,
  async capture(paper) {
    const result = await paper.callTool('get_canvas', {});
    return result.structuredContent as Snapshot;
  },
  normalize(name, args) {
    if (name === 'write_html')
      return [
        { kind: 'html', targetNodeId: args.targetNodeId as string, html: args.html as string },
      ];
    if (name === 'set_tokens')
      return Object.entries(args.tokens as Record<string, string | null>).map(
        ([varName, value]) => ({ kind: 'token' as const, varName, value }),
      );
    return fail('unsupported_write', name);
  },
};
export class MockPaper implements Paper {
  state: Snapshot = { canvas: {}, tokens: {} };
  calls: { name: string; args: Record<string, unknown> }[] = [];
  failOn?: number;
  writeCount = 0;
  constructor(private db?: DB) {
    const row = db?.prepare("SELECT json FROM kv WHERE key='mock-canvas'").get() as
      { json: string } | undefined;
    if (row) this.state = JSON.parse(row.json);
  }
  async listTools() {
    return structuredClone(catalog);
  }
  async callTool(request: string | ToolCall, argumentsValue?: Record<string, unknown>) {
    const { name, arguments: args } = toolCall(request, argumentsValue);
    const persisted = this.db?.prepare("SELECT json FROM kv WHERE key='mock-canvas'").get() as
      { json: string } | undefined;
    if (persisted) this.state = JSON.parse(persisted.json);
    this.calls.push({ name, args });
    if (name === 'get_canvas')
      return { content: [], structuredContent: structuredClone(this.state) };
    if (name === 'finish_working_on_nodes')
      return { content: [{ type: 'text', text: 'Working indicators cleared.' }] };
    if (++this.writeCount === this.failOn)
      return {
        isError: true,
        content: [
          { type: 'text', text: 'Injected mock failure; internal application is unknown.' },
        ],
      };
    this.state = normalize(
      await mockAdapter.normalize(name, args, this.state),
      this.state,
      'mock',
    ).state;
    this.db
      ?.prepare("INSERT OR REPLACE INTO kv VALUES('mock-canvas',?)")
      .run(JSON.stringify(this.state));
    return { content: [{ type: 'text', text: 'Applied to mock canvas.' }] };
  }
  async close() {}
}
export async function loadAdapter(cfg: Config): Promise<Adapter> {
  if (cfg.mode === 'mock') return mockAdapter;
  if (!cfg.adapterPath)
    return {
      classify: () => undefined,
      capture: async () =>
        fail(
          'adapter_required',
          'Configure AIRLOCK_ADAPTER after inspecting the live tools/list contract.',
        ),
      normalize: () => fail('adapter_required'),
    };
  const module = await import(pathToFileURL(resolve(cfg.adapterPath)).href);
  const adapter = module.default as Adapter;
  if (
    !adapter ||
    !['classify', 'capture', 'normalize'].every((k) => typeof (adapter as any)[k] === 'function')
  )
    fail('invalid_adapter');
  return adapter;
}
