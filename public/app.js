const $ = (s) => document.querySelector(s);
let state,
  selected,
  detail,
  tab = 'all',
  toastTimer;
const approvals = new Map();
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
async function api(path, data) {
  const r = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers:
      data === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'X-Airlock-CSRF': state.csrf },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.code + ': ' + j.error.message);
  return j;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 6500);
}
const run = (fn) => async (event) => {
  const button = event?.currentTarget;
  try {
    if (button) button.disabled = true;
    await fn(event);
  } catch (e) {
    toast(e.message);
  } finally {
    if (button) button.disabled = false;
  }
};
const badge = (status) => `<span class="status ${esc(status)}">${esc(status)}</span>`;
const time = (date) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
async function refresh() {
  state = await api('state');
  $('#mode').textContent = state.mode === 'mock' ? 'Mock canvas · local' : 'Live Paper connection';
  $('#environment').textContent = state.mode.toUpperCase() + ' MODE';
  $('#connection').textContent = state.schemas.degraded ? 'Cached connection' : 'Local connection';
  $('#pending-count').textContent = state.reviews.filter((r) =>
    ['pending', 'approved', 'partial'].includes(r.status),
  ).length;
  $('#admitted-count').textContent = state.reviews.filter((r) => r.status === 'admitted').length;
  $('#review-count').textContent = state.reviews.length;
  $('#chamber-count').textContent = state.reviews.length;
  const issues = state.schemas.changed.length + state.schemas.removed.length;
  $('#health').textContent = issues
    ? 'Needs review'
    : state.schemas.degraded
      ? 'Cached'
      : 'Connected';
  $('#schema-age').textContent =
    `${state.schemas.tools.length} tools · ${state.schemas.source === 'catalog' ? 'mock catalog' : 'live discovery'}`;
  if (!selected && state.reviews.length) selected = state.reviews[0].id;
  renderList();
  if (selected) {
    const next = await api('reviews/' + selected);
    if (JSON.stringify(next) !== JSON.stringify(detail)) {
      detail = next;
      renderDetail();
    }
  }
}
function renderList() {
  const term = $('#search').value.toLowerCase(),
    status = $('#status-filter').value;
  const list = state.reviews.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      `${r.title} ${r.agent}`.toLowerCase().includes(term),
  );
  $('#review-list').innerHTML = list.length
    ? list
        .map(
          (r) =>
            `<button class="review-item ${r.id === selected ? 'selected' : ''}" data-review="${esc(r.id)}"><div class="item-top"><span>${esc(r.id.slice(0, 8))}</span>${badge(r.status)}</div><h3>${esc(r.title)}</h3><div class="item-bottom">◈ &nbsp; ${esc(r.agent)} <span>· ${time(r.created_at)}</span></div></button>`,
        )
        .join('')
    : '<div class="list-empty">No reviews here yet.<br>New work starts with a snapshot.</div>';
  document.querySelectorAll('[data-review]').forEach(
    (b) =>
      (b.onclick = run(async () => {
        selected = b.dataset.review;
        tab = 'all';
        detail = await api('reviews/' + selected);
        renderList();
        renderDetail();
      })),
  );
}
function value(v) {
  if (v === null) return '∅';
  if (typeof v === 'string') return v;
  if (v?.tag) {
    const label = `<${v.tag}${v.id ? ' #' + v.id : ''}${v.classes?.length ? ' .' + v.classes.join('.') : ''}>`;
    return [
      label,
      v.text,
      ...Object.entries(v.style ?? {}).map(([k, v]) => k + ': ' + v),
      Object.keys(v.attributes ?? {}).length ? JSON.stringify(v.attributes) : '',
      'path ' + v.path,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(v, null, 2);
}
function renderDetail() {
  if (!detail) return;
  const { review: r, ops, conflicts, groups, diffHash } = detail;
  const nodes = ops.filter((o) => o.space === 'node'),
    tokens = ops.filter((o) => o.space === 'token');
  const filtered = tab === 'nodes' ? nodes : tab === 'tokens' ? tokens : ops;
  const canEdit = ['pending', 'approved'].includes(r.status),
    canApprove =
      ['pending', 'approved', 'partial'].includes(r.status) && ops.length && !conflicts.length;
  const approved = approvals.get(r.id);
  if (approved && approved.diffHash !== diffHash) approvals.delete(r.id);
  $('#review-content').innerHTML =
    `<div class="detail-head"><div class="detail-meta"><span>REVIEW / ${esc(r.id.slice(0, 8))}</span>${badge(r.status)}</div><h2>${esc(r.title)}</h2><div class="detail-sub">◈ &nbsp; ${esc(r.agent)} &nbsp; · &nbsp; ${groups.length} tool call${groups.length === 1 ? '' : 's'} &nbsp; · &nbsp; ${nodes.length} node / ${tokens.length} token changes</div><div class="detail-actions"><a class="button" href="/pressure/?review=${encodeURIComponent(r.id)}">Open in Pressure ↗</a>${canEdit ? '<button class="button" id="stage">＋ Stage call</button>' : ''}${canApprove ? '<button class="button approve" id="approve">✓ Approve diff</button>' : ''}${approvals.has(r.id) && ['approved', 'partial'].includes(r.status) ? `<button class="button primary" id="admit">${r.status === 'partial' ? 'Resume admission' : 'Admit to canvas'} ↗</button>` : ''}${canEdit || r.status === 'partial' ? `<button class="button danger" id="reject">${r.status === 'partial' ? 'Close partial review' : 'Reject'}</button>` : ''}</div></div>${r.status === 'partial' ? '<div class="banner">Admission stopped. A failed tool call may have partially applied. Inspect Paper before resuming: the entire failed call will be retried.</div>' : ''}${conflicts.length ? `<div class="banner">${conflicts.length} overlapping operation pair${conflicts.length === 1 ? '' : 's'} in pending reviews. Resolve them before approval. ${[...new Set(conflicts.map((c) => c.kind + ' · ' + c.key))].map(esc).join(', ')}</div>` : ''}<div class="tabs"><button class="tab ${tab === 'all' ? 'active' : ''}" data-tab="all">All changes <span>${ops.length}</span></button><button class="tab ${tab === 'nodes' ? 'active' : ''}" data-tab="nodes">Nodes <span>${nodes.length}</span></button><button class="tab ${tab === 'tokens' ? 'active' : ''}" data-tab="tokens">Tokens <span>${tokens.length}</span></button><button class="tab ${tab === 'calls' ? 'active' : ''}" data-tab="calls">Tool calls <span>${groups.length}</span></button></div><div class="ops">${tab === 'calls' ? groups.map((g, i) => `<div class="group">${i + 1}. <code>${esc(g.tool)}</code>${badge(g.status)}<p>${esc(g.id.slice(0, 12))} · contract ${esc(g.contract_hash.slice(0, 12))}</p>${g.error_json ? `<p>${esc(g.error_json)}</p>` : ''}<details><summary>Original arguments</summary><pre class="value">${esc(JSON.stringify(g.args, null, 2))}</pre></details></div>`).join('') : filtered.length ? filtered.map((op) => `<article class="op"><div class="op-head"><span class="op-icon">${op.space === 'token' ? '◈' : op.before === null ? '+' : op.after === null ? '−' : '↗'}</span><code>${esc(op.varName ?? op.after?.id ?? op.before?.id ?? op.key)}</code><span class="op-label">${op.before === null ? 'ADDED' : op.after === null ? 'REMOVED' : 'MODIFIED'} · ${esc(op.status)}</span></div><div class="op-values"><div class="value"><small>BEFORE</small>${esc(value(op.before))}</div><div class="value after"><small>AFTER</small>${esc(value(op.after))}</div></div>${op.appliedWithinGroup ? '<div class="contract-warning">Applied within failed group: unknown</div>' : ''}</article>`).join('') : '<div class="empty"><h3>A little room for possibility.</h3><p>Stage a tool call to see its structural changes here.</p></div>'}</div><div class="review-bottom"><span>BASE ${esc(r.base_hash.slice(0, 10))} &nbsp; / &nbsp; DIFF ${esc(diffHash.slice(0, 10))}</span><span>${conflicts.length ? 'Overlaps need attention' : 'No cross-review conflicts'} · atomic: false</span></div>`;
  document.querySelectorAll('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.tab;
        renderDetail();
      }),
  );
  if ($('#stage')) $('#stage').onclick = stageModal;
  if ($('#approve'))
    $('#approve').onclick = run(async () => {
      const approval = await api('approve', { reviewId: r.id, diffHash });
      approvals.set(r.id, approval);
      toast('Diff approved. Admission is a separate step.');
      await refresh();
    });
  if ($('#admit')) $('#admit').onclick = () => admitModal(r);
  if ($('#reject'))
    $('#reject').onclick = () => {
      modal(
        r.status === 'partial' ? 'Close partial review?' : 'Reject this review?',
        `<p class="modal-copy">${r.status === 'partial' ? 'Inspect Paper first. Closing ends retries and clears review conflicts. Any changes already applied in Paper remain.' : `Close “${esc(r.title)}” without admitting its staged calls.`}</p><div class="modal-actions"><button class="button danger" id="confirm-reject">${r.status === 'partial' ? 'Close review' : 'Reject review'}</button></div>`,
      );
      $('#confirm-reject').onclick = run(async () => {
        await api('reject', { reviewId: r.id });
        $('#modal').close();
        approvals.delete(r.id);
        await refresh();
      });
    };
}
function modal(title, body) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  if (!$('#modal').open) $('#modal').showModal();
}
function openModal() {
  modal(
    'Open a review',
    '<p class="modal-copy">Start with a snapshot of the current canvas and its global tokens.</p><form id="open-form"><label class="form-field">Review title<input id="title" placeholder="What are you working on?" required maxlength="160" autofocus></label><div class="modal-actions"><button class="button primary">Open review ↗</button></div></form>',
  );
  $('#open-form').onsubmit = run(async (e) => {
    e.preventDefault();
    const r = await api('open', { title: $('#title').value });
    selected = r.review.id;
    $('#modal').close();
    await refresh();
  });
  $('#title').focus();
}
function stageModal() {
  const writes = state.schemas.tools.filter((t) => state.classes[t.name] === 'write');
  modal(
    'Stage a tool call',
    `<p class="modal-copy">This call stays in the chamber. Arguments are validated against the ${state.mode === 'mock' ? 'mock-only fixture' : 'discovered live contract'}.</p><form id="stage-form"><label class="form-field">Discovered tool<select id="tool">${writes.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></label><label class="form-field">Arguments · JSON<textarea id="args" spellcheck="false">{}</textarea></label><details><summary class="modal-copy">Inspect runtime input schema</summary><pre class="value" id="input-schema"></pre></details><div class="modal-actions"><button class="button primary" ${writes.length ? '' : 'disabled'}>Stage call ↗</button></div></form>`,
  );
  const update = () => {
    const tool = writes.find((t) => t.name === $('#tool').value);
    $('#input-schema').textContent = JSON.stringify(tool?.inputSchema ?? {}, null, 2);
    const properties = tool?.inputSchema?.properties;
    if (
      state.mode === 'live' && tool?.name === 'write_html' &&
      ['fileId', 'targetNodeId', 'html'].every(key => properties?.[key]?.type === 'string') &&
      properties?.mode?.enum?.includes('insert-children')
    ) {
      const roots = Object.entries(detail?.projected?.canvas ?? {}).filter(
        ([key, nodes]) => /^[^:]+:[^:]+$/.test(key) && Array.isArray(nodes) && nodes.length === 0,
      );
      if (roots.length === 1) {
        const [fileId, targetNodeId] = roots[0][0].split(':');
        $('#args').value = JSON.stringify(
          { fileId, targetNodeId, mode: 'insert-children', html: '<h1>Hello Live Paper!</h1>' },
          null,
          2,
        );
        return;
      }
    }
    $('#args').value =
      state.mode === 'mock' && tool?.name === 'write_html'
        ? JSON.stringify(
            { targetNodeId: 'welcome', html: '<h1 id="headline">Make room for good work.</h1>' },
            null,
            2,
          )
        : state.mode === 'mock' && tool?.name === 'set_tokens'
          ? JSON.stringify({ tokens: { '--accent': '#b8ef72' } }, null, 2)
          : '{}';
  };
  $('#tool').onchange = update;
  if (state.mode === 'live' && writes.some(tool => tool.name === 'write_html')) {
    $('#tool').value = 'write_html';
  }
  update();
  $('#stage-form').onsubmit = run(async (e) => {
    e.preventDefault();
    await api('stage', {
      reviewId: selected,
      tool: $('#tool').value,
      arguments: JSON.parse($('#args').value),
    });
    approvals.delete(selected);
    $('#modal').close();
    await refresh();
    toast('Call staged. Your canvas is untouched.');
  });
}
function admitModal(r) {
  modal(
    r.status === 'partial' ? 'Resume admission?' : 'Admit to canvas?',
    `<p class="modal-copy">${r.status === 'partial' ? 'Confirm you inspected Paper after the failure. Applied groups are skipped; the entire first failed group is retried and could duplicate effects.' : 'Tool-call groups replay in order. Admission stops on the first failure. A failed group may have partially applied; there is no automatic rollback.'}</p><p class="contract-warning">atomic: false · partial application can be unknown</p><div class="modal-actions"><button class="button primary" id="confirm-admit">${r.status === 'partial' ? 'I inspected Paper · Resume' : 'Admit approved changes'} ↗</button></div>`,
  );
  $('#confirm-admit').onclick = run(async () => {
    const report = await api('admit', {
      reviewId: r.id,
      approvalToken: approvals.get(r.id).approvalToken,
      resume: r.status === 'partial',
    });
    $('#modal').close();
    await refresh();
    toast(
      report.status === 'admitted'
        ? 'Approved changes admitted to the canvas.'
        : report.groups.find(group => group.status === 'failed')?.error?.message ??
          'Admission stopped. Inspect the failed call before resuming.',
    );
  });
}
function schemaModal() {
  const c = state.schemas;
  modal(
    'Tool contracts',
    `<p class="modal-copy">${c.source === 'catalog' ? 'Mock-only catalog. These are not Paper contracts.' : 'Contracts discovered from the configured endpoint via tools/list.'}<br>Fetched ${esc(new Date(c.fetchedAt).toLocaleString())} · ${c.degraded ? 'degraded cache' : 'connected'}</p>${c.changed.length ? `<p class="contract-warning">Changed: ${esc(c.changed.join(', '))}</p>` : ''}${c.removed.length ? `<p class="contract-warning">Removed: ${esc(c.removed.join(', '))}. These cannot be accepted.</p>` : ''}<div class="schema-tools">${c.tools.map((t) => `<div class="schema-row"><code>${esc(t.name)}</code><span>${esc(state.classes[t.name])}</span><span>${esc(c.toolHashes[t.name].slice(0, 12))}</span><details><summary>Runtime contract</summary><pre>${esc(JSON.stringify({ inputSchema: t.inputSchema, outputSchema: t.outputSchema }, null, 2))}</pre></details></div>`).join('')}</div><div class="modal-actions"><button class="button" id="refresh-schema">Refresh discovery</button>${c.changed.length ? '<button class="button primary" id="accept-schema">Accept changed contracts</button>' : ''}</div>`,
  );
  $('#refresh-schema').onclick = run(async () => {
    await api('schema/refresh', {});
    await refresh();
    schemaModal();
  });
  if ($('#accept-schema'))
    $('#accept-schema').onclick = run(async () => {
      await api('schema/accept', {});
      await refresh();
      schemaModal();
    });
}
$('#new-review').onclick = openModal;
$('#empty-open').onclick = openModal;
$('#close-modal').onclick = () => $('#modal').close();
$('#nav-schema').onclick = () => state && schemaModal();
$('#nav-reviews').onclick = () => {
  if ($('#modal').open) $('#modal').close();
};
$('#search').oninput = renderList;
$('#status-filter').onchange = renderList;
refresh().catch((e) => toast(e.message));
setInterval(() => {
  if (!$('#modal').open)
    refresh().catch((e) => {
      $('#connection').textContent = 'Connection interrupted';
    });
}, 5000);
