import { createHash, randomUUID } from 'node:crypto';
export const canonical = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
};
export const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : canonical(v))
    .digest('hex');
export const id = () => randomUUID();
export class AirlockError extends Error {
  constructor(
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export function fail(code: string, message?: string): never {
  throw new AirlockError(code, message);
}
export function errorJSON(e: unknown) {
  return {
    code: e instanceof AirlockError ? e.code : 'internal_error',
    message: e instanceof Error ? e.message : String(e),
  };
}
export type Tool = {
  name: string;
  description?: string;
  inputSchema: Record<string, any>;
  outputSchema?: Record<string, any>;
  [key: string]: unknown;
};
export type ToolClass = 'read' | 'write' | 'passthrough';
export type CanonicalNode = {
  path: string;
  tag: string;
  id: string | null;
  testid: string | null;
  classes: string[];
  text: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
};
export type Snapshot = { canvas: Record<string, CanonicalNode[]>; tokens: Record<string, string> };
export type Mutation =
  | { kind: 'html'; targetNodeId: string; html: string }
  | { kind: 'token'; varName: string; value: string | null };
export type Op = {
  opId: string;
  groupId: string;
  key: string;
  space: 'node' | 'token';
  targetNodeId?: string;
  varName?: string;
  before: unknown;
  after: unknown;
  status: 'pending' | 'applied' | 'failed' | 'skipped';
  appliedWithinGroup?: 'unknown';
};
export type ToolCall = { name: string; arguments?: Record<string, unknown> };
/** Accept SDK-shaped adapter calls and the original Airlock positional API. */
export function toolCall(
  request: string | ToolCall,
  args?: Record<string, unknown>,
): Required<ToolCall> {
  const name = typeof request === 'string' ? request : request?.name;
  const argumentsValue = typeof request === 'string' ? args : request?.arguments;
  if (typeof name !== 'string' || !name.trim())
    fail('invalid_arguments', 'Tool name must be a non-empty string.');
  if (typeof request !== 'string' && args !== undefined)
    fail(
      'invalid_arguments',
      'Pass arguments inside the tool request or use the positional form, not both.',
    );
  if (
    argumentsValue !== undefined &&
    (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue))
  )
    fail('invalid_arguments', 'Tool arguments must be an object.');
  return { name, arguments: argumentsValue ?? {} };
}
export type Paper = {
  listTools(): Promise<Tool[]>;
  callTool(request: string | ToolCall, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
};
export type Adapter = {
  classify(name: string): ToolClass | undefined;
  capture(paper: Paper): Promise<Snapshot>;
  normalize(
    name: string,
    args: Record<string, unknown>,
    state: Snapshot,
  ): Promise<Mutation[]> | Mutation[];
  replayArgs?(
    name: string,
    args: Record<string, unknown>,
    state: Snapshot,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
};
export const snapshotHash = (s: Snapshot) => hash(canonical(s.canvas) + canonical(s.tokens));
