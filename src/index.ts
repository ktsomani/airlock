export { Engine, type MergeLedger } from './engine.js';
export { Schemas, toolHash } from './schema.js';
export { flatten, matchNodes, normalize } from './html.js';
export { config } from './config.js';
export { runtime } from './runtime.js';
export type { Adapter, Paper, Snapshot, Mutation, CanonicalNode, Op, Tool } from './core.js';
import type { Engine } from './engine.js';
/** Human-side API; intentionally not advertised on the agent MCP transport. */
export const merge_resolve = (engine: Engine, reviewId: string, expectedDiffHash?: string) =>
  engine.approve(reviewId, expectedDiffHash);
export const merge_commit = (
  engine: Engine,
  reviewId: string,
  approvalToken: string,
  resume = false,
) => engine.admit(reviewId, approvalToken, resume);
export const airlock_approve = merge_resolve;
export const airlock_admit = merge_commit;
export const merge_discard = (engine: Engine, reviewId: string) => engine.reject(reviewId);
