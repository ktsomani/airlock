import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDB } from '../src/db.js';
import { Schemas, toolHash } from '../src/schema.js';
import { Engine } from '../src/engine.js';
import {
  MockPaper,
  mockAdapter,
  classify,
  connectWithTimeout,
  stdioCommand,
} from '../src/paper.js';
import { flatten, matchNodes, normalize } from '../src/html.js';
import { config, DEV_SECRET } from '../src/config.js';
import { snapshotHash } from '../src/core.js';
import { runtime } from '../src/runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});
async function setup() {
  const db = openDB(':memory:');
  cleanup.push(() => db.close());
  const paper = new MockPaper(),
    schemas = new Schemas(db, paper, 'mock', 60000, 'test');
  await schemas.refresh();
  return { db, paper, schemas, engine: new Engine(db, paper, schemas, mockAdapter, DEV_SECRET) };
}
const html = (targetNodeId = 'hero', html = '<h1 id="hello">Hello</h1>') => ({
  targetNodeId,
  html,
});
describe('runtime contracts', () => {
  it('preserves removals recorded by another registry when accepting drift', async () => {
    const { db, paper, schemas } = await setup();
    const other = new Schemas(db, paper, 'mock', 60000, 'test');
    const tools = await paper.listTools();
    vi.spyOn(paper, 'listTools').mockResolvedValue(tools.filter((t) => t.name !== 'set_tokens'));
    await other.refresh();
    schemas.acceptDrift();
    await expect(schemas.guard('set_tokens')).rejects.toMatchObject({ code: 'SCHEMA_REMOVED' });
  });
  it('does not hide a malformed discovered catalog behind a cached contract', async () => {
    const { paper, schemas } = await setup();
    const tools = await paper.listTools();
    vi.spyOn(paper, 'listTools').mockResolvedValue([...tools, tools[0]!]);
    await expect(schemas.refresh(true)).rejects.toMatchObject({ code: 'invalid_schema' });
  });
  it('hashes input and output but never description', () => {
    const t = {
      name: 'write',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      description: 'a',
    };
    expect(toolHash(t)).toBe(toolHash({ ...t, description: 'typo corrected' }));
    expect(toolHash(t)).not.toBe(toolHash({ ...t, outputSchema: { type: 'object' } }));
    expect(toolHash(t)).not.toBe(toolHash({ ...t, inputSchema: { type: 'string' } }));
  });
  it('canonicalizes object key order', () =>
    expect(
      toolHash({ name: 'a', inputSchema: { type: 'object', properties: { a: {}, b: {} } } }),
    ).toBe(toolHash({ name: 'a', inputSchema: { properties: { b: {}, a: {} }, type: 'object' } })));
  it('persists distinct changed and removed sets; acceptance never restores a tool', async () => {
    const { paper, schemas } = await setup();
    const list = await paper.listTools();
    vi.spyOn(paper, 'listTools').mockResolvedValue(
      list
        .filter((t) => t.name !== 'set_tokens')
        .map((t) => (t.name === 'write_html' ? { ...t, inputSchema: { type: 'object' } } : t)),
    );
    await schemas.refresh();
    expect(schemas.cache?.changed).toEqual(['write_html']);
    expect(schemas.cache?.removed).toEqual(['set_tokens']);
    await expect(schemas.guard('write_html')).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    schemas.acceptDrift();
    expect(schemas.cache?.changed).toEqual([]);
    await expect(schemas.guard('set_tokens')).rejects.toMatchObject({ code: 'SCHEMA_REMOVED' });
    await schemas.refresh();
    expect(schemas.cache?.removed).toEqual(['set_tokens']);
  });
  it('does not flag prose drift', async () => {
    const { paper, schemas } = await setup();
    const list = await paper.listTools();
    vi.spyOn(paper, 'listTools').mockResolvedValue(
      list.map((t) => ({ ...t, description: 'New prose' })),
    );
    await schemas.refresh();
    expect(schemas.cache?.changed).toEqual([]);
  });
  it('unaccepted drift survives subsequent refreshes', async () => {
    const { paper, schemas } = await setup();
    const list = await paper.listTools();
    vi.spyOn(paper, 'listTools').mockResolvedValue(
      list.map((t) => ({ ...t, outputSchema: { type: 'object' } })),
    );
    await schemas.refresh();
    await schemas.refresh();
    expect(schemas.cache?.changed.length).toBe(list.length);
  });
  it('restored removed tools require inspection', async () => {
    const { paper, schemas } = await setup();
    const list = await paper.listTools();
    const spy = vi.spyOn(paper, 'listTools').mockResolvedValue([]);
    await schemas.refresh();
    schemas.acceptDrift();
    spy.mockResolvedValue(list);
    await schemas.refresh();
    expect(schemas.cache?.removed).toEqual([]);
    expect(schemas.cache?.changed).toContain('write_html');
  });
  it('uses a live cache only inside TTL and marks degraded', async () => {
    const { db, paper } = await setup();
    let now = 100000;
    const s = new Schemas(db, paper, 'live', 1000, 'live', () => now);
    await s.refresh();
    vi.spyOn(paper, 'listTools').mockRejectedValue(new Error('offline'));
    now += 999;
    expect((await s.refresh(true)).degraded).toBe(true);
    now++;
    await expect(s.refresh(true)).rejects.toMatchObject({ code: 'schema_stale' });
  });
  it('boot refresh does not fall back even within TTL', async () => {
    const { schemas, paper } = await setup();
    vi.spyOn(paper, 'listTools').mockRejectedValue(new Error('offline'));
    await expect(schemas.refresh(false)).rejects.toThrow('offline');
  });
  it('fresh triggers discovery once TTL expires', async () => {
    const { db, paper } = await setup();
    let now = 10000;
    const s = new Schemas(db, paper, 'mock', 100, 'clock', () => now);
    const spy = vi.spyOn(paper, 'listTools');
    await s.refresh();
    await s.fresh();
    expect(spy).toHaveBeenCalledTimes(1);
    now += 101;
    await s.fresh();
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('validates staged arguments using the discovered schema', async () => {
    const { engine } = await setup();
    const r = await engine.open('A');
    await expect(engine.stage(r.review.id, 'write_html', { html: 'x' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
  });
});
describe('structural normalization', () => {
  it('flattens multi-node HTML into canonical nodes', () => {
    const f = flatten(
      '<main id="a"><h1 data-testid="title" class="z a"> Hello   world </h1><p style="color: var(--ink); --ink: red">Copy</p></main>',
    );
    expect(f.nodes).toHaveLength(3);
    expect(f.nodes[1]).toMatchObject({
      path: '/0/0',
      tag: 'h1',
      testid: 'title',
      classes: ['a', 'z'],
      text: ' Hello   world ',
    });
    expect(f.tokens).toEqual({ '--ink': 'red' });
    expect(f.nodes[2]?.style).toEqual({ color: 'var(--ink)' });
  });
  it('preserves quoted semicolons and unrelated attributes', () => {
    const f = flatten(
      '<a href="/next" style="background: url(\'data:x;a:b\'); color: red">Next</a>',
    );
    expect(f.nodes[0]?.style.background).toBe("url('data:x;a:b')");
    expect(f.nodes[0]?.attributes.href).toBe('/next');
  });
  it('matches IDs before reordered positions', () => {
    const a = flatten('<p id="a">A</p><p id="b">B</p>').nodes,
      b = flatten('<p id="b">B</p><p id="a">New A</p>').nodes;
    const m = matchNodes(a, b).matches;
    expect(m.get(0)).toBe(1);
    expect(m.get(1)).toBe(0);
  });
  it('matches testids then semantic signatures', () => {
    const a = flatten('<p data-testid="a">A</p><p class="b">B</p>').nodes,
      b = flatten('<p class="b">B</p><p data-testid="a">Changed</p>').nodes;
    const m = matchNodes(a, b).matches;
    expect(m.get(0)).toBe(1);
    expect(m.get(1)).toBe(0);
  });
  it('uses sibling LCS for text edits and inserted elements', () => {
    const a = flatten('<main><h1>Old</h1><p>Copy</p></main>').nodes,
      b = flatten('<main><span>New</span><h1>Changed</h1><p>Copy</p></main>').nodes;
    expect(matchNodes(a, b).matches.get(2)).toBe(1);
  });
  it('emits individual structural changes, never a string HTML diff', () => {
    const n = normalize([{ kind: 'html', ...html() }], { canvas: {}, tokens: {} }, 'g');
    expect(n.ops[0]?.after).toMatchObject({ tag: 'h1', text: 'Hello' });
    expect(n.ops[0]?.space).toBe('node');
  });
  it('stores custom properties only in the token keyspace', () => {
    const n = normalize(
      [{ kind: 'html', ...html('hero', '<p style="--accent: red; color: var(--accent)">A</p>') }],
      { canvas: {}, tokens: {} },
      'g',
    );
    expect(n.ops.filter((o) => o.space === 'token')[0]).toMatchObject({
      varName: '--accent',
      after: 'red',
    });
    expect((n.ops.find((o) => o.space === 'node')?.after as any).style).toEqual({
      color: 'var(--accent)',
    });
  });
  it('rejects ambiguous identities and unsupported stylesheet normalization', () => {
    expect(() =>
      normalize(
        [{ kind: 'html', ...html('a', '<p id="x"></p><p id="x"></p>') }],
        { canvas: {}, tokens: {} },
        'g',
      ),
    ).toThrow('Duplicate');
    expect(() => flatten('<style>:root {--a:red}</style>')).toThrow('Stylesheets');
  });
});
describe('text fidelity', () => {
  it('retains unwrapped root text as canonical text nodes', () => {
    const result = normalize(
      [{ kind: 'html', targetNodeId: 'copy', html: 'Hello <b>world</b>!' }],
      { canvas: {}, tokens: {} },
      'g',
    );
    expect(result.ops).toHaveLength(3);
    expect(result.state.canvas.copy?.filter((n) => n.tag === '#text').map((n) => n.text)).toEqual([
      'Hello ',
      '!',
    ]);
  });
  it('retains significant whitespace in preformatted content', () => {
    const state = { canvas: { code: flatten('<pre>a  b</pre>').nodes }, tokens: {} };
    const result = normalize(
      [{ kind: 'html', targetNodeId: 'code', html: '<pre>a b</pre>' }],
      state,
      'g',
    );
    expect(result.ops).toHaveLength(1);
    expect((result.ops[0]?.before as any).text).toBe('a  b');
    expect((result.ops[0]?.after as any).text).toBe('a b');
  });
  it('preserves whitespace-only root text nodes between siblings', () => {
    const state = { canvas: { block: flatten('<p>before</p> <p>after</p>').nodes }, tokens: {} };
    const result = normalize(
      [{ kind: 'html', targetNodeId: 'block', html: '<p>before</p>  <p>after</p>' }],
      state,
      'g',
    );
    expect(result.ops.some((op) => op.space === 'node' && (op.after as any)?.tag === '#text')).toBe(
      true,
    );
  });
  it('detects text moving across a child node', () => {
    const state = { canvas: { a: flatten('<p>Hello <b>world</b>!</p>').nodes }, tokens: {} };
    const result = normalize(
      [{ kind: 'html', targetNodeId: 'a', html: '<p><b>world</b>Hello !</p>' }],
      state,
      'g',
    );
    expect(result.ops.length).toBeGreaterThan(0);
  });
});
describe('review staging and approvals', () => {
  it('captures a shared base hash across distinct snapshot IDs', async () => {
    const { engine } = await setup();
    const a = await engine.open('A'),
      b = await engine.open('B');
    expect(a.review.snapshot_id).not.toBe(b.review.snapshot_id);
    expect(a.review.base_hash).toBe(b.review.base_hash);
    expect(a.review.base_hash).toBe(snapshotHash(a.base));
  });
  it('stages without writing to Paper and keeps independent projections', async () => {
    const { engine, paper } = await setup();
    const a = await engine.open('A'),
      b = await engine.open('B');
    await engine.stage(a.review.id, 'write_html', html());
    expect(paper.calls.filter((c) => c.name === 'write_html')).toHaveLength(0);
    expect(engine.diff(b.review.id).ops).toHaveLength(0);
  });
  it('detects global token conflicts without targetNodeId', async () => {
    const { engine } = await setup();
    const a = await engine.open('A'),
      b = await engine.open('B');
    await engine.stage(a.review.id, 'set_tokens', { tokens: { '--x': 'red' } });
    await engine.stage(b.review.id, 'set_tokens', { tokens: { '--x': 'blue' } });
    expect(engine.conflicts(a.review.id)[0]?.kind).toBe('token');
    expect(engine.ops(a.review.id)[0]?.targetNodeId).toBeUndefined();
    await expect(engine.approve(a.review.id)).rejects.toMatchObject({ code: 'review_conflict' });
  });
  it('detects cross-keyspace references both ways', async () => {
    const { engine } = await setup();
    const a = await engine.open('A'),
      b = await engine.open('B');
    await engine.stage(a.review.id, 'write_html', html('hero', '<p style="color: var(--x)">A</p>'));
    await engine.stage(b.review.id, 'set_tokens', { tokens: { '--x': 'red' } });
    expect(engine.conflicts(a.review.id)[0]?.kind).toBe('node_token');
    expect(engine.conflicts(b.review.id)[0]?.kind).toBe('node_token');
  });
  it('does not join different base states', async () => {
    const { engine, paper } = await setup();
    const a = await engine.open('A');
    await engine.stage(a.review.id, 'set_tokens', { tokens: { '--x': 'red' } });
    paper.state.tokens['--other'] = 'blue';
    const b = await engine.open('B');
    await engine.stage(b.review.id, 'set_tokens', { tokens: { '--x': 'green' } });
    expect(engine.conflicts(a.review.id)).toEqual([]);
  });
  it('conservatively detects whole-subtree replay overlaps', async () => {
    const { engine } = await setup();
    const a = await engine.open('A'),
      b = await engine.open('B');
    await engine.stage(a.review.id, 'write_html', html('hero', '<p id="a">A</p>'));
    await engine.stage(b.review.id, 'write_html', html('hero', '<p id="b">B</p>'));
    expect(engine.conflicts(a.review.id)[0]?.kind).toBe('subtree_replay');
  });
  it('stores only token hashes and invalidates approval on any new operation', async () => {
    const { engine, db } = await setup();
    const r = await engine.open('A');
    await engine.stage(r.review.id, 'write_html', html());
    const a = await engine.approve(r.review.id);
    expect(a.diffHash).toBe(engine.diffHash(r.review.id));
    const row = db
      .prepare('SELECT approval_token_hash FROM reviews WHERE id=?')
      .get(r.review.id) as any;
    expect(row.approval_token_hash).not.toContain(a.approvalToken);
    await engine.stage(r.review.id, 'set_tokens', { tokens: { '--x': 'red' } });
    await expect(engine.admit(r.review.id, a.approvalToken)).rejects.toMatchObject({
      code: 'stale_approval',
    });
  });
  it('rejects mutated diffs and wrong approval tokens', async () => {
    const { engine, db } = await setup();
    const r = await engine.open('A');
    await engine.stage(r.review.id, 'write_html', html());
    const a = await engine.approve(r.review.id);
    await expect(engine.admit(r.review.id, 'wrong')).rejects.toMatchObject({
      code: 'invalid_approval',
    });
    const op = engine.ops(r.review.id)[0]!;
    op.after = { changed: true };
    db.prepare('UPDATE node_ops SET json=? WHERE op_id=?').run(JSON.stringify(op), op.opId);
    await expect(engine.admit(r.review.id, a.approvalToken)).rejects.toMatchObject({
      code: 'stale_approval',
    });
  });
  it('rejecting a review resolves its pending conflicts', async () => {
    const { engine } = await setup();
    const a = await engine.open('A'),
      b = await engine.open('B');
    for (const r of [a, b])
      await engine.stage(r.review.id, 'set_tokens', { tokens: { '--x': 'red' } });
    await engine.reject(b.review.id);
    expect(engine.conflicts(a.review.id)).toEqual([]);
  });
  it('forwards finish_working_on_nodes without staging', async () => {
    const { engine, paper } = await setup();
    const r = await engine.open('A');
    expect(classify('finish_working_on_nodes', mockAdapter)).toBe('passthrough');
    await engine.call('finish_working_on_nodes', {}, r.review.id);
    expect(engine.ops(r.review.id)).toHaveLength(0);
    expect(paper.calls.at(-1)?.name).toBe('finish_working_on_nodes');
    await expect(engine.stage(r.review.id, 'finish_working_on_nodes', {})).rejects.toMatchObject({
      code: 'not_a_write',
    });
  });
  it('blocks direct unreviewed writes and treats unknown tools as writes', async () => {
    const { engine } = await setup();
    expect(classify('new_mystery_tool')).toBe('write');
    await expect(engine.call('write_html', html())).rejects.toMatchObject({
      code: 'review_required',
    });
  });
});
describe('non-atomic replay', () => {
  async function prepared() {
    const s = await setup();
    const r = await s.engine.open('Three groups');
    await s.engine.stage(r.review.id, 'write_html', html('a', '<main><p>A</p><p>B</p></main>'));
    await s.engine.stage(r.review.id, 'write_html', html('b', '<main><p>C</p><p>D</p></main>'));
    await s.engine.stage(r.review.id, 'set_tokens', { tokens: { '--x': 'red' } });
    const a = await s.engine.approve(r.review.id);
    return { ...s, r: r.review.id, a };
  }
  it('applies ordered groups once and always reports atomic:false', async () => {
    const { engine, paper, r, a } = await prepared();
    const report = await engine.admit(r, a.approvalToken);
    expect(report.atomic).toBe(false);
    expect(report.status).toBe('admitted');
    expect(report.groups.map((g) => g.status)).toEqual(['applied', 'applied', 'applied']);
    await engine.admit(r, a.approvalToken);
    expect(paper.writeCount).toBe(3);
  });
  it('marks all failed-group ops unknown and all later groups skipped', async () => {
    const { engine, paper, r, a } = await prepared();
    paper.failOn = 2;
    const report = await engine.admit(r, a.approvalToken);
    expect(report).toMatchObject({
      atomic: false,
      status: 'partial',
      partialWithinGroup: 'unknown',
    });
    expect(report.groups.map((g) => g.status)).toEqual(['applied', 'failed', 'skipped']);
    expect(report.ops.filter((o) => o.status === 'failed')).toHaveLength(3);
    expect(
      report.ops
        .filter((o) => o.status === 'failed')
        .every((o) => o.appliedWithinGroup === 'unknown'),
    ).toBe(true);
    expect(paper.writeCount).toBe(2);
  });
  it('requires explicit resume, then skips applied groups and retries entire failed group', async () => {
    const { engine, paper, r, a } = await prepared();
    paper.failOn = 2;
    await engine.admit(r, a.approvalToken);
    await expect(engine.admit(r, a.approvalToken)).rejects.toMatchObject({
      code: 'resume_required',
    });
    paper.failOn = undefined;
    const report = await engine.admit(r, a.approvalToken, true);
    expect(report.status).toBe('admitted');
    expect(
      paper.calls.filter((c) => c.name === 'write_html').map((c) => c.args.targetNodeId),
    ).toEqual(['a', 'b', 'b']);
    expect(paper.writeCount).toBe(4);
  });
  it('does not claim a thrown call had no effect or attempt rollback', async () => {
    const { engine, paper, r, a } = await prepared();
    const original = paper.callTool.bind(paper);
    vi.spyOn(paper, 'callTool').mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (name === 'write_html') throw new Error('Response lost after application');
      return result;
    });
    const report = await engine.admit(r, a.approvalToken);
    expect(report.partialWithinGroup).toBe('unknown');
    expect(paper.state.canvas.a).toHaveLength(3);
    expect(paper.calls.filter((c) => c.name === 'write_html')).toHaveLength(1);
  });
  it('checks for changed base before first admission', async () => {
    const { engine, paper, r, a } = await prepared();
    paper.state.tokens['--outside'] = 'blue';
    await expect(engine.admit(r, a.approvalToken)).rejects.toMatchObject({ code: 'base_changed' });
    expect(paper.writeCount).toBe(0);
  });
  it('binds staged groups to contracts even after drift acceptance', async () => {
    const { engine, paper, schemas, r, a } = await prepared();
    const list = await paper.listTools();
    vi.spyOn(paper, 'listTools').mockResolvedValue(
      list.map((t) => (t.name === 'write_html' ? { ...t, outputSchema: { type: 'object' } } : t)),
    );
    await schemas.refresh();
    schemas.acceptDrift();
    await expect(engine.admit(r, a.approvalToken)).rejects.toMatchObject({
      code: 'staged_schema_drift',
    });
  });
  it('blocks concurrent mutations during admission', async () => {
    const { engine, paper, r, a } = await prepared();
    const original = paper.callTool.bind(paper);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    vi.spyOn(paper, 'callTool').mockImplementation(async (name, args) => {
      if (name === 'write_html') {
        started();
        await gate;
      }
      return original(name, args);
    });
    const pending = engine.admit(r, a.approvalToken);
    await ready;
    await expect(engine.open('Concurrent')).rejects.toMatchObject({ code: 'engine_busy' });
    release();
    await pending;
  });
  it('recovers crash ambiguity only with explicit stopped confirmation', async () => {
    const { engine, db, r } = await prepared();
    const groups = engine.groups(r);
    db.prepare("UPDATE reviews SET status='admitting' WHERE id=?").run(r);
    db.prepare("UPDATE groups SET status='applying' WHERE id=?").run(groups[0]!.id);
    db.prepare("INSERT INTO locks VALUES('engine','dead-process')").run();
    expect(() => engine.recover(false)).toThrow();
    engine.recover(true);
    expect(engine.report(r)).toMatchObject({
      atomic: false,
      status: 'partial',
      partialWithinGroup: 'unknown',
    });
    expect(engine.groups(r).map((g) => g.status)).toEqual(['failed', 'skipped', 'skipped']);
  });
});
describe('configuration and connection', () => {
  it('defaults to mock and gates live with both settings and a secret', () => {
    expect(config({}).mode).toBe('mock');
    expect(() => config({ PAPER_MCP_MODE: 'live' })).toThrow();
    expect(() => config({ PAPER_MCP_MODE: 'live', AIRLOCK_LIVE_CONFIRM: '1' })).toThrow();
    expect(() =>
      config({
        PAPER_MCP_MODE: 'live',
        AIRLOCK_LIVE_CONFIRM: '1',
        AIRLOCK_APPROVAL_SECRET: DEV_SECRET,
      }),
    ).toThrow();
    expect(
      config({
        PAPER_MCP_MODE: 'live',
        AIRLOCK_LIVE_CONFIRM: '1',
        AIRLOCK_APPROVAL_SECRET: 'x'.repeat(32),
      }).mode,
    ).toBe('live');
  });
  it('validates remote JSON headers', () => {
    expect(
      config({ PAPER_MCP_HEADERS: '{"Authorization":"Bearer test"}' }).headers.Authorization,
    ).toBe('Bearer test');
    expect(() => config({ PAPER_MCP_HEADERS: '[]' })).toThrow();
    expect(() => config({ PAPER_MCP_HEADERS: '{"x":12}' })).toThrow();
  });
  it('parses quoted stdio arguments and rejects shell operators', () => {
    expect(stdioCommand('stdio:node "a path/bridge.js" --flag "two words"')).toEqual({
      command: 'node',
      args: ['a path/bridge.js', '--flag', 'two words'],
    });
    expect(() => stdioCommand('stdio:node bridge.js | cat')).toThrow();
    expect(() => stdioCommand('stdio:node bridge.js; echo bad')).toThrow();
  });
  it('times out connect with the exact actionable message and closes transport', async () => {
    vi.useFakeTimers();
    const client = { connect: () => new Promise<void>(() => {}), close: vi.fn(async () => {}) };
    const p = connectWithTimeout(client, {}, 'http://localhost:29979/mcp', 8000);
    const check = expect(p).rejects.toThrow(
      'Could not connect to Paper MCP at http://localhost:29979/mcp. Is Paper Desktop running with a file open?',
    );
    await vi.advanceTimersByTimeAsync(8000);
    await check;
    expect(client.close).toHaveBeenCalledOnce();
  });
  it('clears timeout after a successful connection', async () => {
    vi.useFakeTimers();
    const c = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    await connectWithTimeout(c, {}, 'x', 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.close).not.toHaveBeenCalled();
  });
  it('boot always discovers and marks mock fixture source catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-'));
    const rt = await runtime(true, config({ AIRLOCK_DATA_DIR: dir }));
    expect(rt.schemas.cache?.source).toBe('catalog');
    await rt.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
