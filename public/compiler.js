const byId = (id) => document.getElementById(id);
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const safeTags = new Set(
  'article aside blockquote button div em footer h1 h2 h3 h4 header main nav ol li p section small span strong ul'.split(
    ' ',
  ),
);
const colors = /^(?:#[0-9a-f]{3,8}|[a-z]+|var\(--[\w-]+\)|rgba?\([\d.%, /]+\))$/i;
const paperPreviewStyles = new Map([
  ['font-size', /^\d+(?:\.\d+)?px$/],
  ['line-height', /^\d+(?:\.\d+)?(?:px)?$/],
  ['font-weight', /^(?:normal|bold|[1-9]00)$/],
  ['display', /^(?:flex|block|inline-flex|inline-block)$/],
  ['flex-direction', /^(?:row|column)$/],
  ['gap', /^\d+(?:\.\d+)?px$/],
  ['padding', /^(?:\d+(?:\.\d+)?px)(?: \d+(?:\.\d+)?px){0,3}$/],
  ['width', /^\d+(?:\.\d+)?px$/],
  ['border-radius', /^\d+(?:\.\d+)?px$/],
]);
let csrf, intent, resolution;
let generation = 0,
  busy = false,
  resume = false;
let selections = Object.create(null);
let selected = new Set();
let draftList = [];

async function request(path, body) {
  const options =
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Airlock-CSRF': csrf },
          body: JSON.stringify(body),
        };
  const response = await fetch('/api/' + path, options);
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
  return result;
}

function paint(container, snapshot, changes = []) {
  container.replaceChildren();
  if (!snapshot) {
    const empty = element('div', '', 'preview-empty');
    empty.append(
      element('span', '', 'empty-icon'),
      element(
        'p',
        container.id === 'base'
          ? 'Select a draft to inspect its base.'
          : 'The proposed canvas appears here.',
      ),
    );
    container.append(empty);
    return;
  }
  const scene = element('div', '', 'preview');
  for (const [key, value] of Object.entries(snapshot.tokens)) {
    if (/^--[\w-]+$/.test(key) && colors.test(value)) scene.style.setProperty(key, value);
  }
  const tree = element('ul', '', 'tree');
  const changed = new Map(
    changes.flatMap((op) => (op.after?.path ? [[op.targetNodeId + ':' + op.after.path, op]] : [])),
  );
  const agents = [...new Set(changes.map((op) => op.agent))];
  for (const [target, nodes] of Object.entries(snapshot.canvas)) {
    const parents = new Map();
    const children = new Map();
    const parentPath = (path) => path.slice(0, path.lastIndexOf('/'));
    for (const node of nodes) {
      const path = parentPath(node.path);
      const siblings = children.get(path) ?? [];
      siblings.push(node);
      children.set(path, siblings);
    }
    for (const node of nodes) {
      const parent = parents.get(parentPath(node.path)) ?? scene;
      let directText = node.text;
      for (const child of children.get(node.path) ?? [])
        directText = directText.replace(child.text, '');
      const live = element(safeTags.has(node.tag) ? node.tag : 'div', directText);
      if (live.tagName === 'BUTTON') live.disabled = true;
      for (const key of ['color', 'background-color']) {
        const value = node.style?.[key];
        if (value && colors.test(value)) live.style.setProperty(key, value);
      }
      if (node.id && node.style?.['box-sizing'] === 'border-box') {
        live.style.boxSizing = 'border-box';
        live.style.maxWidth = '100%';
        for (const [key, pattern] of paperPreviewStyles) {
          const value = node.style[key];
          if (value && pattern.test(value)) live.style.setProperty(key, value);
        }
      }
      parent.append(live);
      parents.set(node.path, live);
      const op = changed.get(target + ':' + node.path);
      const type =
        op && (!op.before ? 'added' : op.before.text !== node.text ? 'retexted' : 'changed');
      const row = element('li', '', 'node' + (type ? ' ' + type : ''));
      const branch = element('span', '', 'node-label');
      branch.append(element('strong', '<' + node.tag + (node.id ? ' #' + node.id : '') + '>'));
      if (directText) branch.append(element('span', directText, 'node-text'));
      row.append(branch);
      row.title = target + ' ' + node.path;
      row.style.marginInlineStart = Math.min(5, node.path.split('/').length - 2) * 0.75 + 'rem';
      if (op)
        row.append(
          element('span', op.agent, 'agent' + (agents.indexOf(op.agent) > 0 ? ' other' : '')),
        );
      tree.append(row);
    }
  }
  container.append(scene, element('h3', 'Node tree', 'tree-title'), tree);
  if (!tree.children.length) container.append(element('p', 'No nodes in this snapshot.', 'empty'));
}

function unresolvedCount() {
  return (
    intent?.conflicts.filter((conflict) => !Object.hasOwn(selections, conflict.key)).length ?? 0
  );
}
function setAction() {
  const unresolved = unresolvedCount();
  byId('compile').disabled = busy || (!resolution && (!intent?.changes.length || unresolved > 0));
  byId('compile-label').textContent = resume
    ? 'Resume Merge'
    : resolution
      ? 'Retry Merge'
      : 'Compile & Merge Drafts';
  let readiness = 'Select drafts to begin';
  if (busy) readiness = 'Compiling draftsâ€¦';
  else if (resume) readiness = 'Merge partially applied';
  else if (resolution) readiness = 'Drafts resolved';
  else if (unresolved)
    readiness = `${unresolved} ${unresolved === 1 ? 'conflict' : 'conflicts'} to resolve`;
  else if (intent?.changes.length)
    readiness = `${intent.draftIds.length} ${intent.draftIds.length === 1 ? 'draft' : 'drafts'} ready to merge`;
  else if (intent) readiness = 'No changes to merge';
  else if (!byId('ledger').hidden) readiness = 'Merge ledger available';
  byId('merge-readiness').textContent = readiness;
}
function renderDrafts() {
  const list = byId('draft-list');
  list.replaceChildren();
  for (const draft of draftList.filter(
    (d) => ['pending', 'approved'].includes(d.status) && !d.compiled,
  )) {
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = selected.has(draft.id);
    input.disabled = busy || Boolean(resolution);
    input.addEventListener('change', () => {
      if (input.checked) selected.add(draft.id);
      else selected.delete(draft.id);
      void preview();
    });
    const details = element('span', '', 'draft-details');
    details.append(element('strong', draft.title), element('small', draft.agent));
    label.append(input, details);
    list.append(label);
  }
  if (!list.children.length) list.append(element('span', 'No open drafts.', 'empty'));
}
function renderIntent() {
  paint(byId('base'), intent?.base);
  const content = byId('conflicts');
  content.replaceChildren();
  if (!intent?.conflicts.length)
    content.append(
      element(
        'p',
        intent ? 'No conflicts in this selection.' : 'Conflicts appear when drafts overlap.',
        'empty',
      ),
    );
  for (const conflict of intent?.conflicts ?? []) {
    const card = element('div', '', 'conflict');
    const contrast = conflict.kind === 'cross_keyspace_contrast';
    card.append(
      element('span', contrast ? 'Contrast conflict' : 'Overlapping change', 'conflict-type'),
    );
    card.append(element('strong', conflict.key, 'conflict-key'), element('p', conflict.message));
    const result = element('p', '', 'conflict-result');
    result.hidden = true;
    result.setAttribute('aria-live', 'polite');
    const swatches = element('div', '', 'swatches');
    for (const value of conflict.choices) {
      const button = element('button');
      button.type = 'button';
      button.dataset.value = value;
      button.setAttribute('aria-pressed', String(selections[conflict.key] === value));
      const swatch = element('span', '', 'swatch');
      if (colors.test(value)) swatch.style.backgroundColor = value;
      button.append(swatch, document.createTextNode(value));
      button.addEventListener('click', () => {
        if (busy || resolution) return;
        selections[conflict.key] = value;
        for (const choice of swatches.children)
          choice.setAttribute('aria-pressed', String(choice.dataset.value === value));
        card.dataset.resolved = 'true';
        result.textContent = `Previewing ${value}`;
        result.hidden = false;
        renderProjection();
      });
      swatches.append(button);
    }
    card.append(swatches, result);
    content.append(card);
  }
  renderProjection();
}
function renderProjection() {
  const count = byId('conflict-count');
  const unresolved = unresolvedCount();
  count.hidden = !intent;
  count.textContent = unresolved ? `${unresolved} open` : 'Clear';
  count.dataset.open = String(Boolean(unresolved));
  paint(
    byId('projected'),
    intent && { ...intent.projected, tokens: { ...intent.projected.tokens, ...selections } },
    intent?.changes,
  );
  setAction();
}
async function preview() {
  const version = ++generation;
  selections = Object.create(null);
  intent = undefined;
  renderIntent();
  byId('status').textContent = '';
  if (!selected.size) return;
  try {
    const next = await request('merge/preview', { draftIds: [...selected] });
    if (version !== generation) return;
    intent = next;
    renderIntent();
  } catch (error) {
    if (version === generation) byId('status').textContent = error.message;
  }
}
async function refresh() {
  const state = await request('state');
  csrf = state.csrf;
  draftList = state.reviews;
  byId('environment').textContent = state.mode === 'mock' ? 'Mock canvas' : 'Paper Desktop';
  byId('demo').hidden = state.mode !== 'mock' || draftList.length > 0;
  renderDrafts();
}
function showLedger(ledger) {
  byId('ledger').hidden = false;
  byId('ledger-summary').textContent =
    (ledger.status === 'admitted'
      ? `${ledger.groups.length} tool calls applied`
      : 'Partial merge') +
    (ledger.partialWithinGroup ? ' Â· Application within the failed call is unknown.' : '');
  byId('ledger-groups').replaceChildren(
    ...ledger.groups.map((group) => {
      const row = element('li', '', 'ledger-row');
      const detail = element('div');
      detail.append(element('code', group.tool));
      if (group.error) detail.append(element('p', group.error.message));
      const status = element('span', group.status, 'badge ledger-state');
      status.dataset.state = group.status;
      row.append(detail, status);
      return row;
    }),
  );
}
async function compile() {
  if (byId('compile').disabled) return;
  busy = true;
  byId('status').textContent = 'Compilingâ€¦';
  setAction();
  renderDrafts();
  try {
    if (!resolution)
      resolution = await request('merge/resolve', {
        draftIds: intent.draftIds,
        selections,
        intentHash: intent.intentHash,
      });
    const ledger = await request('admit', {
      reviewId: resolution.draftId,
      approvalToken: resolution.approvalToken,
      resume,
    });
    showLedger(ledger);
    resume = ledger.status === 'partial';
    byId('status').textContent = resume
      ? 'Inspect the live canvas before resuming the failed call.'
      : 'Merge complete.';
    if (!resume) {
      resolution = undefined;
      selected.clear();
      intent = undefined;
      await refresh();
    }
  } catch (error) {
    byId('status').textContent = error.message;
  } finally {
    busy = false;
    setAction();
    renderDrafts();
  }
}
byId('compile').addEventListener('click', compile);
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.repeat) {
    event.preventDefault();
    void compile();
  }
});
byId('demo').addEventListener('click', async () => {
  byId('demo').disabled = true;
  try {
    const result = await request('merge/demo', {});
    selected = new Set(result.draftIds);
    intent = result.intent;
    await refresh();
    renderIntent();
  } catch (error) {
    byId('status').textContent = error.message;
  } finally {
    byId('demo').disabled = false;
  }
});
byId('merge-shortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform)
  ? 'âŒ˜ Enter'
  : 'Ctrl Enter';
renderIntent();
refresh().catch((error) => {
  byId('status').textContent = error.message;
});
