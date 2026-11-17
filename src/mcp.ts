import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { errorJSON, fail, type Tool } from './core.js';
import type { Engine } from './engine.js';
import { classify } from './paper.js';
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = { type: 'string', minLength: 1 };
const controls: Tool[] = [
  {
    name: 'merge_open_draft',
    description: 'Open a draft against the current canvas and global tokens.',
    inputSchema: object({ title: str, agent: str }, ['title']),
  },
  { name: 'merge_list_drafts', description: 'List drafts.', inputSchema: object({}) },
  {
    name: 'merge_list_contracts',
    description:
      'Discover original upstream contracts, provenance, drift and removed tools. Use these runtime schemas to construct draft arguments.',
    inputSchema: object({}),
  },
  {
    name: 'merge_diff_intent',
    description: 'Inspect normalized node/token operations and conflicts.',
    inputSchema: object({ reviewId: str }, ['reviewId']),
  },
  {
    name: 'merge_write_draft',
    description: 'Record a discovered write tool in a draft without mutating Paper.',
    inputSchema: object({ reviewId: str, tool: str, arguments: { type: 'object' } }, [
      'reviewId',
      'tool',
      'arguments',
    ]),
  },
  {
    name: 'merge_commit',
    description:
      'Commit a human-resolved draft using its resolution token. Non-atomic; failed groups may have partially applied. Resume retries the whole failed group.',
    inputSchema: object({ reviewId: str, approvalToken: str, resume: { type: 'boolean' } }, [
      'reviewId',
      'approvalToken',
    ]),
  },
];
const humanControls: Tool[] = [
  { name: 'merge_resolve', description: 'Resolve a draft at the inspected diff hash.', inputSchema: object({ reviewId: str, diffHash: str }, ['reviewId', 'diffHash']) },
  { name: 'merge_discard', description: 'Discard a draft.', inputSchema: object({ reviewId: str }, ['reviewId']) },
];
export function mcpServer(engine: Engine, humanResolver = false) {
  const server = new Server(
    { name: 'airlock', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cache = await engine.schemas.fresh();
    const forwarded = cache.tools.filter(
      (t) => classify(t.name, engine.adapter) !== 'write' && !/^(airlock_|merge_)/.test(t.name),
    );
    return { tools: [...controls, ...(humanResolver ? humanControls : []), ...forwarded] as any };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const a = request.params.arguments ?? {},
        name = request.params.name;
      const text = (key: string) => {
        if (typeof a[key] !== 'string' || !a[key]) fail('invalid_arguments', key + ' is required');
        return a[key] as string;
      };
      let result: unknown;
      switch (name) {
        case 'merge_open_draft':
        case 'airlock_open':
          result = await engine.open(
            text('title'),
            typeof a.agent === 'string' ? a.agent : 'agent',
          );
          break;
        case 'merge_list_drafts':
        case 'airlock_list':
          result = engine.list();
          break;
        case 'merge_list_contracts':
        case 'airlock_tools':
          result = await engine.schemas.fresh();
          break;
        case 'merge_diff_intent':
        case 'airlock_diff':
          result = engine.diff(text('reviewId'));
          break;
        case 'merge_write_draft':
        case 'airlock_stage':
          if (!a.arguments || typeof a.arguments !== 'object' || Array.isArray(a.arguments))
            fail('invalid_arguments', 'merge_write_draft requires {reviewId, tool, arguments}.');
          result = await engine.stage(
            text('reviewId'),
            text('tool'),
            a.arguments as Record<string, unknown>,
          );
          break;
        case 'merge_commit':
        case 'airlock_admit':
          if (a.resume !== undefined && typeof a.resume !== 'boolean') fail('invalid_arguments');
          result = await engine.admit(text('reviewId'), text('approvalToken'), a.resume === true);
          break;
        case 'merge_resolve':
          if (!humanResolver) fail('human_resolution_required');
          result = await engine.approve(text('reviewId'), text('diffHash'));
          break;
        case 'merge_discard':
          if (!humanResolver) fail('human_resolution_required');
          result = await engine.reject(text('reviewId'));
          break;
        default:
          if (/^(airlock_|merge_)/.test(name)) fail('unknown_tool');
          return await engine.call(name, a);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorJSON(e)) }] };
    }
  });
  return server;
}
export async function serveMCP(engine: Engine, humanResolver = false) {
  const server = mcpServer(engine, humanResolver);
  await server.connect(new StdioServerTransport());
  return server;
}
