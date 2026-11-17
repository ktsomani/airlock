// Current Airlock snapshots store flat canonical records, not original DOM or
// cascade provenance. Keep that distinction visible in the source label.
const validTag = /^[a-z][a-z0-9-]*$/;
function project(canvas, tokens, identities) {
  const page = document.createElement('div');
  page.className = 'airlock-projection';
  for (const [key, value] of Object.entries(tokens ?? {})) {
    if (/^--[\w-]+$/.test(key) && typeof value === 'string') page.style.setProperty(key, value);
  }
  for (const [scope, records] of Object.entries(canvas)) {
    const group = document.createElement('section');
    group.setAttribute('aria-label', scope);
    page.append(group);
    const paths = new Map();
    const parents = new Set(records.map(node => node.path?.slice(0, node.path.lastIndexOf('/'))));
    for (const node of records) {
      if (!node.path) continue;
      const parent = paths.get(node.path.slice(0, node.path.lastIndexOf('/'))) ?? group;
      if (node.tag === '#text') {
        const text = document.createElement('span');
        text.dataset.mergeStateId = identities.get(scope + '::path:' + node.path) ?? '';
        text.textContent = node.text;
        parent.append(text);
        continue;
      }
      const tag = validTag.test(node.tag) ? node.tag : 'div';
      // Avoid custom elements and resource-bearing tags even during projection construction.
      const el = document.createElement(['img','iframe','link','script','style','object','embed','audio','video','source'].includes(tag) || tag.includes('-') ? 'div' : tag);
      for (const [name, value] of Object.entries(node.attributes ?? {})) {
        if (/^(title|role|aria-[\w-]+)$/.test(name)) el.setAttribute(name, value);
      }
      if (node.id) el.id = node.id;
      if (node.testid) el.dataset.testid = node.testid;
      if (node.classes?.length) el.className = node.classes.join(' ');
      for (const [name, value] of Object.entries(node.style ?? {})) el.style.setProperty(name, value);
      const key = scope + '::' + (node.id ? 'id:' + node.id : node.testid ? 'testid:' + node.testid : 'path:' + node.path);
      el.dataset.mergeStateId = identities.get(key) ?? key;
      if (!parents.has(node.path)) el.textContent = node.text;
      parent.append(el);
      paths.set(node.path, el);
    }
  }
  return { html: page.outerHTML, css: '.airlock-projection { padding:16px; color:#18231e; background:#e5ebe0; min-height:100vh; }' };
}

export function fromAirlock(diff) {
  const beforeIds = new Map(), proposedIds = new Map();
  const changes = [];
  const operations = new Map();
  const scopedKey = (scope, node) => scope + '::' +
    (node?.id ? 'id:' + node.id : node?.testid ? 'testid:' + node.testid : 'path:' + node?.path);
  const present = (canvas, scope, node) => (canvas[scope] ?? []).find(candidate =>
    scopedKey(scope, candidate) === scopedKey(scope, node));
  for (const op of diff.ops) {
    if (op.space === 'node' && !operations.has(op.key)) operations.set(op.key, op);
  }
  for (const [key, op] of operations) {
    const scope = op.targetNodeId;
    const first = present(diff.base.canvas, scope, op.before ?? op.after);
    const last = present(diff.projected.canvas, scope, op.after ?? op.before);
    if (!first && !last) continue;
    if (first) beforeIds.set(scopedKey(scope, first), key);
    if (last) proposedIds.set(scopedKey(scope, last), key);
    const names = new Set([...Object.keys(first?.style ?? {}), ...Object.keys(last?.style ?? {})]);
    const properties = [...names].filter(name => first?.style?.[name] !== last?.style?.[name])
      .map(name => ({name, before: first?.style?.[name], after: last?.style?.[name]}));
    changes.push({ id: key, label: last?.id ?? first?.id ?? last?.tag ?? first?.tag,
      structural: true, properties });
  }
  return {
    id: diff.review.id, title: diff.review.title, diffHash: diff.diffHash,
    source: 'Airlock projection',
    note: 'Reconstructed from Airlock’s canonical nodes. Computed values, original DOM and winning rules require a full snapshot pair.',
    before: project(diff.base.canvas, diff.base.tokens, beforeIds),
    proposed: project(diff.projected.canvas, diff.projected.tokens, proposedIds),
    changes,
  };
}
