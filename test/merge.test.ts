import { afterEach, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { openDB } from '../src/db.js';
import { demo } from '../src/demo.js';
import { normalize, flatten } from '../src/html.js';
import { mergeIntent } from '../src/merge.js';
import { Engine } from '../src/engine.js';
import { MockPaper, mockAdapter } from '../src/paper.js';
import { Schemas } from '../src/schema.js';

const dbs: ReturnType<typeof openDB>[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

async function setup() {
  const db = openDB(':memory:');
  dbs.push(db);
  const paper = new MockPaper();
  const schemas = new Schemas(db, paper, 'mock', 60000, 'merge');
  await schemas.refresh();
  return { paper, engine: new Engine(db, paper, schemas, mockAdapter, config({}).secret) };
}

it('compiles independent trees, blocks low contrast and writes the chosen color', async () => {
  const { engine, paper } = await setup();
  const { draftIds, intent } = (await demo(engine, true)) as Extract<
    Awaited<ReturnType<typeof demo>>,
    { draftIds: string[] }
  >;
  expect(Object.keys(intent.projected.canvas)).toEqual(expect.arrayContaining(['hero', 'navbar']));
  expect(intent.conflicts).toEqual([
    expect.objectContaining({
      kind: 'cross_keyspace_contrast',
      key: '--color-text',
      choices: ['#ffffff', '#d4f6df'],
    }),
  ]);
  await expect(engine.compile(draftIds, {}, intent.intentHash)).rejects.toMatchObject({
    code: 'unresolved_merge',
  });
  await expect(
    engine.compile(draftIds, { '--color-text': '#242424' }, intent.intentHash),
  ).rejects.toMatchObject({ code: 'invalid_resolution' });
  const compiled = await engine.compile(draftIds, { '--color-text': '#ffffff' }, intent.intentHash);
  const resolved = await engine.approve(compiled.review.id, compiled.diffHash);
  const ledger = await engine.admit(compiled.review.id, resolved.approvalToken);
  expect(ledger).toMatchObject({ atomic: false, status: 'admitted' });
  expect(ledger.groups.map((g) => g.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
  expect(ledger.conflicts[0]?.kind).toBe('cross_keyspace_contrast');
  expect(paper.state).toEqual(compiled.projected);
  expect(draftIds.map((id) => engine.review(id).status)).toEqual(['merged', 'merged']);
});

it('blocks compilation of overlapping subtree replacements', async () => {
  const { engine } = await setup();
  const ids: string[] = [];
  for (const agent of ['Agent A', 'Agent B']) {
    const draft = await engine.open(agent, agent);
    ids.push(draft.review.id);
    await engine.stage(draft.review.id, 'write_html', {
      targetNodeId: 'shared',
      html: '<h1>' + agent + '</h1>',
    });
  }
  const preview = engine.previewMerge(ids);
  expect(preview.unresolved[0]?.kind).toBe('subtree_replay');
  await expect(engine.compile(ids, {}, preview.intentHash)).rejects.toMatchObject({
    code: 'unresolved_merge',
  });
});

it('combines two verified text-layer edits in one frame and blocks a same-layer overlap', async () => {
  const { engine } = await setup();
  const { nodes } = flatten(
    '<div id="frame"><h1 id="heading">Before</h1><p id="copy">Old copy</p></div>',
  );
  nodes[0]!.text = '';
  const target = 'file:frame';
  const base = { canvas: { [target]: nodes }, tokens: {} };
  const draft = async (nodeId: string, text: string) => {
    const { review } = await engine.open(text, text);
    const groupId = review.id;
    const { state, ops } = normalize(
      [{ kind: 'node_text', targetNodeId: target, nodeId, text }],
      base,
      groupId,
    );
    return {
      review,
      base,
      ops,
      projected: state,
      conflicts: [],
      diffHash: groupId,
      groups: [
        {
          id: groupId,
          review_id: review.id,
          ordinal: 0,
          tool: 'set_text_content',
          contract_hash: 'test',
          status: 'pending',
          error_json: null,
          args: {},
        },
      ],
    };
  };
  const a = await draft('heading', 'New headline');
  const b = await draft('copy', 'New copy');
  const c = await draft('heading', 'Alternative headline');
  const textTools = ['set_text_content'];
  const combined = mergeIntent([a, b], {}, false, textTools);
  expect(combined.unresolved).toEqual([]);
  expect(combined.projected.canvas[target]?.map((node) => node.text)).toEqual([
    '',
    'New headline',
    'New copy',
  ]);
  expect(mergeIntent([a, c], {}, false, textTools).unresolved[0]?.kind).toBe('subtree_replay');
  expect(mergeIntent([a, b]).unresolved[0]?.kind).toBe('subtree_replay');
});
