import { parse, HTMLElement, TextNode } from 'node-html-parser';
import {
  canonical,
  fail,
  hash,
  id,
  type CanonicalNode,
  type Mutation,
  type Op,
  type Snapshot,
} from './core.js';
// Split declarations only at top-level semicolons (quoted data URLs remain intact).
export function declarations(css: string): Record<string, string> {
  const parts: string[] = [];
  let piece = '',
    quote = '',
    depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === '\\') {
      piece += c + (css[++i] ?? '');
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) {
      parts.push(piece);
      piece = '';
      continue;
    }
    piece += c;
  }
  parts.push(piece);
  return Object.fromEntries(
    parts
      .filter((p) => p.includes(':'))
      .map((p) => {
        const n = p.indexOf(':');
        return [p.slice(0, n).trim(), p.slice(n + 1).trim()] as [string, string];
      })
      .filter(([k]) => k),
  );
}
export function flatten(html: string) {
  const root = parse(html, { comment: false });
  const nodes: CanonicalNode[] = [];
  const tokens: Record<string, string> = {};
  function visit(parent: HTMLElement, prefix: string) {
    parent.childNodes
      .filter((n): n is HTMLElement => n instanceof HTMLElement)
      .forEach((el, index) => {
        const path = prefix + '/' + index;
        const style = declarations(el.getAttribute('style') ?? '');
        // Mock normalization convention: custom properties are global token changes.
        for (const [k, v] of Object.entries(style))
          if (k.startsWith('--')) {
            tokens[k] = v;
            delete style[k];
          }
        if (el.rawTagName.toLowerCase() === 'style')
          fail(
            'unsupported_html',
            'Stylesheets require an endpoint-specific adapter. Use inline styles and explicit token mutations.',
          );
        const attributes = Object.fromEntries(
          Object.entries(el.attributes).filter(
            ([k]) => !['id', 'data-testid', 'class', 'style'].includes(k),
          ),
        );
        nodes.push({
          path,
          tag: el.rawTagName.toLowerCase(),
          id: el.id || null,
          testid: el.getAttribute('data-testid') ?? null,
          classes: [...el.classList.values()].sort(),
          text: el.textContent,
          style,
          attributes,
        });
        visit(el, path);
      });
  }
  visit(root, '');
  // Element text includes descendants; unwrapped root text needs its own canonical node.
  root.childNodes.forEach((node, index) => {
    if (node instanceof TextNode && node.textContent.length > 0)
      nodes.push({
        path: '/text-' + index,
        tag: '#text',
        id: null,
        testid: null,
        classes: [],
        text: node.textContent,
        style: {},
        attributes: {},
      });
  });
  return { nodes, tokens };
}
const signature = (n: CanonicalNode) => n.tag + '|' + n.classes.join(' ') + '|' + hash(n.text);
const parent = (n: CanonicalNode) => n.path.slice(0, n.path.lastIndexOf('/'));
export function matchNodes(before: CanonicalNode[], after: CanonicalNode[]) {
  const matches = new Map<number, number>();
  const used = new Set<number>();
  for (const key of [(n: CanonicalNode) => n.id, (n: CanonicalNode) => n.testid, signature]) {
    const a = new Map<string, number[]>(),
      b = new Map<string, number[]>();
    before.forEach((n, i) => {
      const k = key(n);
      if (k && !used.has(i)) a.set(k, [...(a.get(k) ?? []), i]);
    });
    after.forEach((n, i) => {
      const k = key(n);
      if (k && !matches.has(i)) b.set(k, [...(b.get(k) ?? []), i]);
    });
    for (const [k, indices] of b)
      if (indices.length === 1 && a.get(k)?.length === 1) {
        matches.set(indices[0]!, a.get(k)![0]!);
        used.add(a.get(k)![0]!);
      }
  }
  // Parent-first sibling LCS. Previously matched parents anchor renamed/moved subtrees.
  const parents = [...new Set(after.map(parent))].sort(
    (a, b) => a.split('/').length - b.split('/').length,
  );
  for (const p of parents) {
    const pi = after.findIndex((n) => n.path === p);
    const oldParent = p === '' ? '' : matches.has(pi) ? before[matches.get(pi)!]!.path : undefined;
    if (oldParent === undefined) continue;
    const aa = before
      .map((n, i) => ({ n, i }))
      .filter((x) => parent(x.n) === oldParent && !used.has(x.i));
    const bb = after
      .map((n, i) => ({ n, i }))
      .filter((x) => parent(x.n) === p && !matches.has(x.i));
    const dp = Array.from(
      { length: aa.length + 1 },
      () => Array(bb.length + 1).fill(0) as number[],
    );
    for (let i = aa.length - 1; i >= 0; i--)
      for (let j = bb.length - 1; j >= 0; j--)
        dp[i]![j] =
          aa[i]!.n.tag === bb[j]!.n.tag
            ? 1 + dp[i + 1]![j + 1]!
            : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0,
      j = 0;
    while (i < aa.length && j < bb.length) {
      if (aa[i]!.n.tag === bb[j]!.n.tag) {
        matches.set(bb[j]!.i, aa[i]!.i);
        used.add(aa[i]!.i);
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
      else j++;
    }
  }
  return { matches, used };
}
const nodeKey = (n: CanonicalNode) =>
  n.id ? 'id:' + n.id : n.testid ? 'testid:' + n.testid : 'path:' + n.path;
export function normalize(mutations: Mutation[], base: Snapshot, groupId: string) {
  const state: Snapshot = structuredClone(base);
  const ops: Op[] = [];
  const token = (name: string, value: string | null) => {
    if (!/^--[\w-]+$/.test(name)) fail('invalid_token');
    const before = state.tokens[name] ?? null;
    if (before === value) return;
    ops.push({
      opId: id(),
      groupId,
      space: 'token',
      key: name,
      varName: name,
      before,
      after: value,
      status: 'pending',
    });
    if (value === null) delete state.tokens[name];
    else state.tokens[name] = value;
  };
  for (const m of mutations) {
    if (m.kind === 'token') {
      token(m.varName, m.value);
      continue;
    }
    if (m.kind !== 'html' || typeof m.html !== 'string' || !m.targetNodeId)
      fail('invalid_mutation');
    const { nodes, tokens } = flatten(m.html);
    const before = state.canvas[m.targetNodeId] ?? [];
    const { matches, used } = matchNodes(before, nodes);
    for (const field of ['id', 'testid'] as const) {
      const seen = new Set<string>();
      for (const n of nodes)
        if (n[field]) {
          if (seen.has(n[field]!)) fail('ambiguous_node_identity', `Duplicate ${field}`);
          seen.add(n[field]!);
        }
    }
    const add = (b: CanonicalNode | null, a: CanonicalNode | null) => {
      if (canonical(b) === canonical(a)) return;
      ops.push({
        opId: id(),
        groupId,
        space: 'node',
        key: m.targetNodeId + '::' + nodeKey(b ?? a!),
        targetNodeId: m.targetNodeId,
        before: b,
        after: a,
        status: 'pending',
      });
    };
    nodes.forEach((n, i) => add(matches.has(i) ? before[matches.get(i)!]! : null, n));
    before.forEach((n, i) => {
      if (!used.has(i)) add(n, null);
    });
    state.canvas[m.targetNodeId] = nodes;
    for (const [k, v] of Object.entries(tokens)) token(k, v);
  }
  return { state, ops };
}
export const tokenRefs = (value: unknown) => [
  ...new Set([...canonical(value).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!)),
];
