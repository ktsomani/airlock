import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  canonical,
  fail,
  hash,
  id,
  snapshotHash,
  type Adapter,
  type Op,
  type Paper,
  type Snapshot,
} from './core.js';
import type { DB } from './db.js';
import { Schemas, toolHash } from './schema.js';
import { mergeIntent } from './merge.js';
import { classify, mockAdapter } from './paper.js';
import { normalize, tokenRefs } from './html.js';
type Review = {
  id: string;
  title: string;
  agent: string;
  snapshot_id: string;
  projection_json: string;
  status: string;
  approval_token_hash: string | null;
  approved_diff_hash: string | null;
  created_at: string;
  base_hash: string;
};
type Group = {
  id: string;
  review_id: string;
  ordinal: number;
  tool: string;
  args_json: string;
  contract_hash: string;
  status: string;
  error_json: string | null;
};
export type MergeLedger = ReturnType<Engine['ledger']>;
export class Engine {
  constructor(
    public db: DB,
    public paper: Paper,
    public schemas: Schemas,
    public adapter: Adapter,
    private secret: string,
  ) {}
  // The durable lock deliberately does not expire: a crashed in-flight call may have landed.
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const owner = id();
    try {
      this.db.prepare('INSERT INTO locks VALUES(?,?)').run('engine', owner);
    } catch {
      fail(
        'engine_busy',
        'Another operation is active or the process was interrupted. Inspect before running airlock recover.',
      );
    }
    try {
      return await work();
    } finally {
      this.db.prepare('DELETE FROM locks WHERE key=? AND owner=?').run('engine', owner);
    }
  }
  review(reviewId: string): Review {
    const row = this.db
      .prepare(
        'SELECT r.*,s.base_hash FROM reviews r JOIN snapshots s ON s.id=r.snapshot_id WHERE r.id=?',
      )
      .get(reviewId) as Review | undefined;
    if (!row) fail('review_not_found');
    return row;
  }
  list() {
    return (
      this.db
        .prepare(
          'SELECT r.*,s.base_hash FROM reviews r JOIN snapshots s ON s.id=r.snapshot_id ORDER BY created_at DESC',
        )
        .all() as Review[]
    ).map(({ approval_token_hash, approved_diff_hash, projection_json, ...r }) => ({ ...r, compiled: Boolean(this.mergeSources(r.id)) }));
  }
  groups(reviewId: string) {
    return this.db
      .prepare('SELECT * FROM groups WHERE review_id=? ORDER BY ordinal')
      .all(reviewId) as Group[];
  }
  ops(reviewId: string): Op[] {
    return (
      this.db
        .prepare(
          'SELECT json FROM node_ops WHERE review_id=? UNION ALL SELECT json FROM token_ops WHERE review_id=?',
        )
        .all(reviewId, reviewId) as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  diffHash(reviewId: string) {
    return hash(
      this.ops(reviewId)
        .sort((a, b) => a.opId.localeCompare(b.opId, 'en'))
        .map((op) => ({ opId: op.opId, after: op.after })),
    );
  }
  private snapshot(reviewId: string): Snapshot {
    const r = this.review(reviewId);
    const s = this.db.prepare('SELECT * FROM snapshots WHERE id=?').get(r.snapshot_id) as {
      canvas_json: string;
      tokens_json: string;
    };
    return { canvas: JSON.parse(s.canvas_json), tokens: JSON.parse(s.tokens_json) };
  }
  async open(title: string, agent = 'human') {
    return this.locked(async () => {
      const state = await this.adapter.capture(this.paper);
      if (!state?.canvas || !state?.tokens) fail('invalid_snapshot');
      const snapshotId = id(),
        reviewId = id();
      this.db.transaction(() => {
        this.db
          .prepare('INSERT INTO snapshots VALUES(?,?,?,?)')
          .run(snapshotId, canonical(state.canvas), canonical(state.tokens), snapshotHash(state));
        this.db
          .prepare(
            'INSERT INTO reviews(id,title,agent,snapshot_id,projection_json,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(reviewId, title, agent, snapshotId, canonical(state), new Date().toISOString());
      })();
      return this.diff(reviewId);
    });
  }
  async call(name: string, args: Record<string, unknown>, reviewId?: string) {
    const kind = classify(name, this.adapter);
    if (kind !== 'write') {
      await this.schemas.validate(name, args);
      return this.paper.callTool(name, args);
    }
    if (!reviewId)
      fail(
        'review_required',
        'Open a draft and write through merge_write_draft. Direct writes cannot reach Paper.',
      );
    return this.stage(reviewId, name, args);
  }
  async stage(reviewId: string, name: string, args: Record<string, unknown>) {
    return this.locked(async () => {
      const tool = await this.schemas.validate(name, args);
      if (classify(name, this.adapter) !== 'write')
        fail('not_a_write', 'Read and passthrough calls are forwarded directly, never staged.');
      const r = this.review(reviewId);
      if (this.mergeSources(reviewId)) fail('compiled_draft_readonly');
      if (!['pending', 'approved'].includes(r.status)) fail('review_not_editable');
      const groupId = id();
      const { state, ops } = normalize(
        await this.adapter.normalize(name, args, JSON.parse(r.projection_json)),
        JSON.parse(r.projection_json),
        groupId,
      );
      if (!ops.length) return { reviewId, noOp: true, diffHash: this.diffHash(reviewId) };
      const replayArgs = this.adapter.replayArgs
        ? await this.adapter.replayArgs(name, args, JSON.parse(r.projection_json))
        : args;
      await this.schemas.validate(name, replayArgs);
      this.db.transaction(() => {
        this.db
          .prepare(
            'INSERT INTO groups(id,review_id,ordinal,tool,args_json,contract_hash) VALUES(?,?,?,?,?,?)',
          )
          .run(
            groupId,
            reviewId,
            this.groups(reviewId).length,
            name,
            canonical(replayArgs),
            toolHash(tool),
          );
        for (const op of ops) {
          if (op.space === 'node')
            this.db
              .prepare('INSERT INTO node_ops VALUES(?,?,?,?,?)')
              .run(op.opId, groupId, reviewId, op.key, canonical(op));
          else
            this.db
              .prepare('INSERT INTO token_ops VALUES(?,?,?,?,?)')
              .run(op.opId, groupId, reviewId, op.varName, canonical(op));
        }
        this.db
          .prepare(
            "UPDATE reviews SET projection_json=?,status='pending',approval_token_hash=NULL,approved_diff_hash=NULL WHERE id=?",
          )
          .run(canonical(state), reviewId);
      })();
      return this.diff(reviewId);
    });
  }
  private mergeSources(id: string): { draftIds: string[]; intentHash: string; conflicts: ReturnType<typeof mergeIntent>['conflicts'] } | undefined {
    const row = this.db.prepare('SELECT json FROM kv WHERE key=?').get('merge:' + id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  previewMerge(draftIds: string[], selections: Record<string, string> = {}) {
    if (!Array.isArray(draftIds) || draftIds.length === 0 || draftIds.some(id => typeof id !== 'string' || this.mergeSources(id)))
      fail('invalid_draft_selection');
    return mergeIntent(draftIds.map(id => this.diff(id)), selections, this.adapter === mockAdapter, this.adapter.independentTextTools);
  }

  async compile(draftIds: string[], selections: Record<string, string>, expectedIntent: string) {
    return this.locked(async () => {
      const intent = this.previewMerge(draftIds, selections);
      if (intent.intentHash !== expectedIntent) fail('stale_diff');
      if (intent.unresolved.length) fail('unresolved_merge');
      if (draftIds.some(draftId => this.conflicts(draftId).some(conflict => !draftIds.includes(conflict.reviewId))))
        fail('review_conflict', 'A draft outside this selection overlaps the merge. Inspect it before compiling.');
      const reviewId = id();
      const base = this.review(draftIds[0]!);
      const replayTokens = { ...intent.base.tokens };
      const groups: { id: string; tool: string; args: Record<string, unknown>; contract: string; ops: Op[] }[] = [];
      for (const source of draftIds) {
        const ops = this.ops(source);
        for (const group of this.groups(source)) {
          const args = JSON.parse(group.args_json) as Record<string, unknown>;
          const groupOps = ops.filter(op => op.groupId === group.id);
          const groupId = id();
          if (group.tool !== 'set_tokens' && groupOps.some(op => op.varName && Object.hasOwn(selections, op.varName)))
            fail('unsupported_token_resolution', 'A selected token also comes from an inline write. Resolve that value in its source draft.');
          if (this.adapter === mockAdapter && group.tool === 'set_tokens') {
            const values = args.tokens as Record<string, string | null>;
            args.tokens = Object.fromEntries(groupOps.flatMap(op => op.varName
              ? [[op.varName, Object.hasOwn(selections, op.varName) ? selections[op.varName] : values[op.varName]]]
              : []));
            await this.schemas.validate(group.tool, args);
          }
          const compiledOps = groupOps.map(op => {
            if (!op.varName) return { ...op, groupId, opId: id() };
            const key = op.varName;
            const before = replayTokens[key] ?? null;
            const after = Object.hasOwn(selections, key) ? selections[key]! : op.after;
            if (typeof after === 'string') replayTokens[key] = after;
            else delete replayTokens[key];
            return { ...op, groupId, opId: id(), before, after };
          });
          groups.push({ id: groupId, tool: group.tool, args, contract: group.contract_hash, ops: compiledOps });
        }
      }
      if (!groups.length) fail('empty_review');
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO reviews(id,title,agent,snapshot_id,projection_json,created_at) VALUES(?,?,?,?,?,?)')
          .run(reviewId, 'Compiled drafts', 'human', base.snapshot_id, canonical(intent.projected), new Date().toISOString());
        this.db.prepare('INSERT INTO kv VALUES(?,?)').run('merge:' + reviewId, canonical({
          draftIds, intentHash: intent.intentHash, conflicts: intent.conflicts,
        }));
        for (const [ordinal, group] of groups.entries()) {
          this.db.prepare('INSERT INTO groups(id,review_id,ordinal,tool,args_json,contract_hash) VALUES(?,?,?,?,?,?)')
            .run(group.id, reviewId, ordinal, group.tool, canonical(group.args), group.contract);
          for (const op of group.ops)
            this.db.prepare(`INSERT INTO ${op.space === 'node' ? 'node_ops' : 'token_ops'} VALUES(?,?,?,?,?)`)
              .run(op.opId, group.id, reviewId, op.varName ?? op.key, canonical(op));
        }
      })();
      return this.diff(reviewId);
    });
  }

  conflicts(reviewId: string) {
    const r = this.review(reviewId),
      own = this.ops(reviewId);
    const conflicts: {
      reviewId: string;
      opId: string;
      otherOpId: string;
      kind: string;
      key: string;
    }[] = [];
    const others = this.db
      .prepare(
        "SELECT r.id FROM reviews r JOIN snapshots s ON r.snapshot_id=s.id WHERE s.base_hash=? AND r.id<>? AND r.status IN ('pending','approved','partial','admitting')",
      )
      .all(r.base_hash, reviewId) as { id: string }[];
    const sources = this.mergeSources(reviewId)?.draftIds ?? [];
    for (const other of others.filter(other => !sources.includes(other.id)))
      for (const a of own)
        for (const b of this.ops(other.id)) {
          if (a.space === b.space && a.key === b.key)
            conflicts.push({
              reviewId: other.id,
              opId: a.opId,
              otherOpId: b.opId,
              kind: a.space === 'token' ? 'token' : 'node',
              key: a.key,
            });
          else if (a.space === b.space && a.space === 'node' && a.targetNodeId === b.targetNodeId)
            conflicts.push({
              reviewId: other.id,
              opId: a.opId,
              otherOpId: b.opId,
              kind: 'subtree_replay',
              key: a.targetNodeId!,
            });
          else if (a.space !== b.space) {
            const node = a.space === 'node' ? a : b,
              token = a.space === 'token' ? a : b;
            if (tokenRefs([node.before, node.after]).includes(token.varName!))
              conflicts.push({
                reviewId: other.id,
                opId: a.opId,
                otherOpId: b.opId,
                kind: 'node_token',
                key: token.varName!,
              });
          }
        }
    return conflicts;
  }
  diff(reviewId: string) {
    const { approval_token_hash, approved_diff_hash, projection_json, ...review } =
      this.review(reviewId);
    return {
      review,
      base: this.snapshot(reviewId),
      projected: JSON.parse(projection_json) as Snapshot,
      ops: this.ops(reviewId),
      groups: this.groups(reviewId).map(({ args_json, ...g }) => ({
        ...g,
        args: JSON.parse(args_json),
      })),
      diffHash: this.diffHash(reviewId),
      conflicts: this.conflicts(reviewId),
    };
  }
  private digest(token: string) {
    return createHmac('sha256', this.secret).update(token).digest('hex');
  }
  async approve(reviewId: string, expectedDiffHash?: string) {
    return this.locked(async () => {
      const r = this.review(reviewId);
      if (!['pending', 'approved', 'partial'].includes(r.status)) fail('review_not_approvable');
      if (!this.ops(reviewId).length) fail('empty_review');
      if (this.conflicts(reviewId).length) fail('review_conflict');
      const diffHash = this.diffHash(reviewId);
      if (expectedDiffHash && expectedDiffHash !== diffHash)
        fail(
          'stale_diff',
          'The diff changed since you inspected it. Review the current changes before approving.',
        );
      const approvalToken = randomBytes(32).toString('base64url');
      this.db
        .prepare(
          "UPDATE reviews SET approval_token_hash=?,approved_diff_hash=?,status=CASE WHEN status='partial' THEN 'partial' ELSE 'approved' END WHERE id=?",
        )
        .run(this.digest(approvalToken), diffHash, reviewId);
      return { approvalToken, diffHash };
    });
  }
  async reject(reviewId: string) {
    return this.locked(async () => {
      const r = this.review(reviewId);
      if (!['pending', 'approved', 'partial'].includes(r.status)) fail('review_not_rejectable');
      this.db
        .prepare(
          "UPDATE reviews SET status='rejected',approval_token_hash=NULL,approved_diff_hash=NULL WHERE id=?",
        )
        .run(reviewId);
      return { reviewId, status: 'rejected' };
    });
  }
  private markGroup(group: Group, status: Op['status'], error?: unknown) {
    this.db
      .prepare('UPDATE groups SET status=?,error_json=? WHERE id=?')
      .run(status, error ? canonical(error) : null, group.id);
    for (const op of this.ops(group.review_id).filter((o) => o.groupId === group.id)) {
      op.status = status;
      if (status === 'failed') op.appliedWithinGroup = 'unknown';
      else delete op.appliedWithinGroup;
      this.db
        .prepare(
          `UPDATE ${op.space === 'node' ? 'node_ops' : 'token_ops'} SET json=? WHERE op_id=?`,
        )
        .run(canonical(op), op.opId);
    }
  }
  ledger(reviewId: string) {
    const groups = this.groups(reviewId);
    return {
      reviewId,
      status: this.review(reviewId).status,
      conflicts: this.mergeSources(reviewId)?.conflicts ?? [],
      atomic: false as const,
      partialWithinGroup: groups.some((g) => g.status === 'failed') ? ('unknown' as const) : null,
      groups: groups.map((g) => ({
        groupId: g.id,
        tool: g.tool,
        status: g.status,
        error: g.error_json ? JSON.parse(g.error_json) : null,
      })),
      ops: this.ops(reviewId),
    };
  }
  /** Compatibility alias for callers of the original report API. */
  report(reviewId: string): MergeLedger {
    return this.ledger(reviewId);
  }
  async admit(reviewId: string, approvalToken: string, resume = false) {
    return this.locked(async () => {
      const r = this.review(reviewId);
      if (r.status === 'partial' && !resume)
        fail(
          'resume_required',
          'This review partially applied. Inspect Paper and use --resume to retry the first failed group.',
        );
      if (!['approved', 'partial', 'admitted'].includes(r.status)) fail('stale_approval');
      if (!r.approved_diff_hash || r.approved_diff_hash !== this.diffHash(reviewId))
        fail('stale_approval');
      const digest = this.digest(approvalToken);
      if (
        !r.approval_token_hash ||
        !timingSafeEqual(Buffer.from(digest), Buffer.from(r.approval_token_hash))
      )
        fail('invalid_approval');
      if (r.status === 'admitted') return this.ledger(reviewId);
      const compilation = this.mergeSources(reviewId);
      if (compilation && r.status !== 'partial' && this.previewMerge(compilation.draftIds).intentHash !== compilation.intentHash)
        fail('stale_diff');
      if (this.conflicts(reviewId).length) fail('review_conflict');
      await this.schemas.refresh(false);
      const remaining = this.groups(reviewId).filter((g) => g.status !== 'applied');
      const base = this.snapshot(reviewId);
      const replayPayloads = new Map<string, Record<string, unknown>>();
      for (const g of remaining) {
        const savedArgs = JSON.parse(g.args_json) as Record<string, unknown>;
        const args = this.adapter.replayArgs
          ? await this.adapter.replayArgs(g.tool, savedArgs, base)
          : savedArgs;
        const t = await this.schemas.validate(g.tool, args);
        if (toolHash(t) !== g.contract_hash)
          fail(
            'staged_schema_drift',
            'A staged group uses an earlier contract. Open a new review after updating the adapter.',
          );
        replayPayloads.set(g.id, args);
      }
      if (
        r.status !== 'partial' &&
        snapshotHash(await this.adapter.capture(this.paper)) !== r.base_hash
      )
        fail(
          'base_changed',
          'The canvas changed since this review opened. Open a new review against the current state.',
        );
      this.db.prepare("UPDATE reviews SET status='admitting' WHERE id=?").run(reviewId);
      for (let i = 0; i < remaining.length; i++) {
        const g = remaining[i]!;
        const args = replayPayloads.get(g.id)!;
        this.db.prepare("UPDATE groups SET status='applying',args_json=? WHERE id=?").run(canonical(args), g.id);
        let failure: unknown;
        try {
          const result = await this.paper.callTool(g.tool, args);
          if (result?.isError) {
            failure = result;
            const detail = Array.isArray(result.content)
              ? result.content.filter((block: { type?: string; text?: string }) => block.type === 'text').map((block: { text?: string }) => block.text).join('\n')
              : '';
            throw new Error(detail || JSON.stringify(result));
          }
          this.db.transaction(() => this.markGroup(g, 'applied'))();
        } catch (e) {
          console.error(`Airlock replay failed · review ${reviewId} · group ${g.id} · ${g.tool}`, failure ?? e);
          this.db.transaction(() => {
            this.markGroup(g, 'failed', {
              message: e instanceof Error ? e.message : String(e),
              appliedWithinGroup: 'unknown',
            });
            for (const later of remaining.slice(i + 1)) this.markGroup(later, 'skipped');
            this.db.prepare("UPDATE reviews SET status='partial' WHERE id=?").run(reviewId);
          })();
          return this.ledger(reviewId);
        }
      }
      this.db.transaction(() => {
        this.db.prepare("UPDATE reviews SET status='admitted' WHERE id=?").run(reviewId);
        for (const source of compilation?.draftIds ?? [])
          this.db.prepare("UPDATE reviews SET status='merged',approval_token_hash=NULL,approved_diff_hash=NULL WHERE id=? AND status IN ('pending','approved')").run(source);
      })();
      return this.ledger(reviewId);
    });
  }
  // Explicit operator recovery only, after stopping all Airlock processes.
  recover(confirmed: boolean) {
    if (!confirmed)
      fail(
        'recovery_confirmation_required',
        'Stop all Airlock processes and inspect Paper, then use --confirm-stopped.',
      );
    return this.db.transaction(() => {
      const active = this.db.prepare("SELECT id FROM reviews WHERE status='admitting'").all() as {
        id: string;
      }[];
      for (const r of active) {
        for (const g of this.groups(r.id)) {
          if (g.status === 'applying')
            this.markGroup(g, 'failed', {
              message: 'Interrupted during replay; application is unknown.',
            });
          else if (g.status !== 'applied') this.markGroup(g, 'skipped');
        }
        this.db.prepare("UPDATE reviews SET status='partial' WHERE id=?").run(r.id);
      }
      this.db.prepare('DELETE FROM locks').run();
      return { recovered: active.map((r) => r.id), atomic: false };
    })();
  }
}
