import { canonical, fail, hash, type CanonicalNode, type Op, type Snapshot } from './core.js';
import type { Engine } from './engine.js';

type Draft = ReturnType<Engine['diff']>;
type Conflict = { key: string; kind: string; message: string; choices: string[] };

function luminance(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return NaN;
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
    const value = parseInt(color.slice(i * 2 + 1, i * 2 + 3), 16) / 255;
    return sum + weight * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  }, 0);
}
export function contrast(text: string, background: string) {
  const a = luminance(text),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function independentTextEdit(op: Op, draft: Draft, tools: readonly string[]) {
  const before = op.before as CanonicalNode | null;
  const after = op.after as CanonicalNode | null;
  const group = draft.groups.find((group) => group.id === op.groupId);
  return (
    group &&
    tools.includes(group.tool) &&
    before?.id &&
    after?.id === before.id &&
    canonical({ ...before, text: after.text }) === canonical(after)
  );
}

export function mergeIntent(
  drafts: Draft[],
  selections: Record<string, string> = {},
  editableTokens = false,
  independentTextTools: readonly string[] = [],
) {
  const first = drafts[0];
  if (!first || new Set(drafts.map((d) => d.review.id)).size !== drafts.length)
    fail('invalid_draft_selection');
  if (
    drafts.some(
      (d) =>
        d.review.base_hash !== first.review.base_hash ||
        !['pending', 'approved'].includes(d.review.status),
    )
  )
    fail('incompatible_drafts', 'Select open drafts captured against the same canvas.');
  const projected: Snapshot = structuredClone(first.base);
  const writers = new Map<string, { draft: Draft; ops: Op[] }[]>();
  const tokens = new Map<string, Map<string, string | undefined>>();
  const changes = drafts.flatMap((d) =>
    d.ops.map((op) => ({ ...op, agent: d.review.agent, draftId: d.review.id })),
  );
  const conflicts = new Map<string, Conflict>();
  for (const draft of drafts) {
    for (const target of new Set(
      draft.ops.flatMap((op) => (op.targetNodeId ? [op.targetNodeId] : [])),
    )) {
      const scope = writers.get(target) ?? [];
      scope.push({ draft, ops: draft.ops.filter((op) => op.targetNodeId === target) });
      writers.set(target, scope);
    }
    for (const key of new Set(draft.ops.flatMap((op) => (op.varName ? [op.varName] : [])))) {
      const values = tokens.get(key) ?? new Map();
      values.set(draft.review.id, draft.projected.tokens[key]);
      tokens.set(key, values);
      const value = draft.projected.tokens[key];
      if (value === undefined) delete projected.tokens[key];
      else projected.tokens[key] = value;
    }
  }
  for (const [target, scopes] of writers) {
    if (scopes.length === 1) {
      projected.canvas[target] = scopes[0]!.draft.projected.canvas[target] ?? [];
      continue;
    }
    const nodes = projected.canvas[target];
    const pathOwners = new Map<string, string>();
    let independent = Boolean(nodes);
    for (const { draft, ops } of scopes) {
      for (const op of ops) {
        if (!independentTextEdit(op, draft, independentTextTools)) {
          independent = false;
          continue;
        }
        const after = op.after as CanonicalNode;
        const owner = pathOwners.get(after.id!);
        const index =
          nodes?.findIndex((node) => node.id === after.id && node.path === after.path) ?? -1;
        if ((owner && owner !== draft.review.id) || index === -1) independent = false;
        else {
          pathOwners.set(after.id!, draft.review.id);
        }
      }
    }
    if (!independent) {
      conflicts.set(target, {
        key: target,
        kind: 'subtree_replay',
        message: 'Drafts overlap on the same layer or include an overlapping subtree replacement.',
        choices: [],
      });
      continue;
    }
    const merged = new Map<string, CanonicalNode>();
    for (const { draft } of scopes)
      for (const node of draft.projected.canvas[target] ?? [])
        if (node.id && pathOwners.get(node.id) === draft.review.id) merged.set(node.id, node);
    projected.canvas[target] = nodes!.map((node) => merged.get(node.id ?? '') ?? node);
  }
  for (const [key, values] of tokens) {
    const unique = [...new Set(values.values())];
    if (unique.length < 2) continue;
    conflicts.set(key, {
      key,
      kind: 'token',
      message: `${key} has competing values.`,
      choices: editableTokens && !unique.includes(undefined) ? (unique as string[]) : [],
    });
  }
  const bg = '--color-bg',
    fg = '--color-text';
  const foregroundOwners = tokens.get(fg),
    backgroundOwners = tokens.get(bg);
  const changedText = changes.filter(
    (op) => op.space === 'node' && JSON.stringify(op.after)?.includes(`var(${fg})`),
  );
  const ratio = contrast(projected.tokens[fg] ?? '', projected.tokens[bg] ?? '');
  if (
    foregroundOwners &&
    backgroundOwners &&
    changedText.some((op) => [...backgroundOwners.keys()].some((owner) => owner !== op.draftId)) &&
    ratio < 4.5
  ) {
    const choices = [...new Set([first.base.tokens[fg], '#ffffff', '#d4f6df', '#000000'])].filter(
      (value): value is string =>
        typeof value === 'string' && contrast(value, projected.tokens[bg]!) >= 4.5,
    );
    conflicts.set(fg, {
      key: fg,
      kind: 'cross_keyspace_contrast',
      message: `${fg} on ${bg} has ${ratio.toFixed(2)}:1 contrast. Choose a text color with at least 4.5:1.`,
      choices: editableTokens ? choices : [],
    });
  }
  for (const [key, value] of Object.entries(selections)) {
    if (!conflicts.get(key)?.choices.includes(value)) fail('invalid_resolution', key);
    projected.tokens[key] = value;
  }
  const unresolved = [...conflicts.values()].filter((item) => !Object.hasOwn(selections, item.key));
  if (
    selections[fg] &&
    conflicts.get(fg)?.kind === 'cross_keyspace_contrast' &&
    !(contrast(projected.tokens[fg]!, projected.tokens[bg]!) >= 4.5)
  )
    fail('invalid_resolution', fg);
  return {
    base: first.base,
    projected,
    changes,
    conflicts: [...conflicts.values()],
    unresolved,
    draftIds: drafts.map((d) => d.review.id),
    intentHash: hash(drafts.map((d) => [d.review.id, d.diffHash])),
  };
}
