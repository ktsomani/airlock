export { Engine } from './engine.js';
export { Schemas, toolHash } from './schema.js';
export { flatten, matchNodes, normalize } from './html.js';
export { config } from './config.js';
export { runtime } from './runtime.js';
export type { Adapter, Paper, Snapshot, Mutation, CanonicalNode, Op, Tool } from './core.js';
import type { Engine } from './engine.js';
/** Human-side API; intentionally not advertised on the agent MCP transport. */
export const airlock_approve = (engine: Engine, reviewId: string, expectedDiffHash?: string) =>
  engine.approve(reviewId, expectedDiffHash);
export const airlock_admit = (
  engine: Engine,
  reviewId: string,
  approvalToken: string,
  resume = false,
) => engine.admit(reviewId, approvalToken, resume);
