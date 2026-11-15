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
    name: 'airlock_open',
    description: 'Open a review against the current canvas and global tokens.',
    inputSchema: object({ title: str, agent: str }, ['title']),
  },
  { name: 'airlock_list', description: 'List reviews.', inputSchema: object({}) },
  {
    name: 'airlock_tools',
    description:
      'Discover original upstream contracts, provenance, drift and removed tools. Use these runtime schemas to construct staged arguments.',
    inputSchema: object({}),
  },
  {
    name: 'airlock_diff',
    description: 'Inspect normalized node/token operations and conflicts.',
    inputSchema: object({ reviewId: str }, ['reviewId']),
  },
  {
    name: 'airlock_stage',
    description: 'Stage a discovered write tool in a review. Never writes to Paper.',
    inputSchema: object({ reviewId: str, tool: str, arguments: { type: 'object' } }, [
      'reviewId',
      'tool',
      'arguments',
    ]),
  },
  {
    name: 'airlock_admit',
    description:
      'Replay a human-approved review with its approval token. Non-atomic; failed groups may have partially applied. Resume retries the whole failed group.',
    inputSchema: object({ reviewId: str, approvalToken: str, resume: { type: 'boolean' } }, [
      'reviewId',
      'approvalToken',
    ]),
  },
];
// Human approval is deliberately not available to an agent on this transport.
export function mcpServer(engine: Engine) {
  const server = new Server(
    { name: 'airlock', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cache = await engine.schemas.fresh();
    const forwarded = cache.tools.filter(
      (t) => classify(t.name, engine.adapter) !== 'write' && !t.name.startsWith('airlock_'),
    );
    return { tools: [...controls, ...forwarded] as any };
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
        case 'airlock_open':
          result = await engine.open(
            text('title'),
            typeof a.agent === 'string' ? a.agent : 'agent',
          );
          break;
        case 'airlock_list':
          result = engine.list();
          break;
        case 'airlock_tools':
          result = await engine.schemas.fresh();
          break;
        case 'airlock_diff':
          result = engine.diff(text('reviewId'));
          break;
        case 'airlock_stage':
          if (!a.arguments || typeof a.arguments !== 'object' || Array.isArray(a.arguments))
            fail('invalid_arguments', 'airlock_stage requires {reviewId, tool, arguments}. Put the upstream tool payload in arguments, not args.');
          result = await engine.stage(
            text('reviewId'),
            text('tool'),
            a.arguments as Record<string, unknown>,
          );
          break;
        case 'airlock_admit':
          if (a.resume !== undefined && typeof a.resume !== 'boolean') fail('invalid_arguments');
          result = await engine.admit(text('reviewId'), text('approvalToken'), a.resume === true);
          break;
        default:
          if (name.startsWith('airlock_')) fail('unknown_tool');
          return await engine.call(name, a);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorJSON(e)) }] };
    }
  });
  return server;
}
export async function serveMCP(engine: Engine) {
  const server = mcpServer(engine);
  await server.connect(new StdioServerTransport());
  return server;
}
