const $ = (s) => document.querySelector(s);
let state,
  selected = new URLSearchParams(location.search).get('review'),
  detail,
  tab = 'all',
  toastTimer;
let queueMarkup = '';
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
  const dialog = button?.closest('dialog');
  try {
    dialog?.querySelector('.dialog-error')?.remove();
    if (button?.matches('form')) {
      if (button.getAttribute('aria-busy') === 'true') return;
      button.setAttribute('aria-busy', 'true');
      button.querySelector('button[type="submit"],button:not([type])')?.setAttribute('disabled', '');
    } else if (button) button.disabled = true;
    await fn(event);
  } catch (e) {
    if (dialog?.open) {
      const error = document.createElement('p');
      error.className = 'dialog-error';
      error.setAttribute('role', 'alert');
      error.textContent = e.message;
      dialog.querySelector('#modal-body').append(error);
    } else toast(e.message);
  } finally {
    if (button?.matches('form')) {
      button.removeAttribute('aria-busy');
      button.querySelector('button[type="submit"],button:not([type])')?.removeAttribute('disabled');
    } else if (button) button.disabled = false;
  }
};
const badge = (status) => `<span class="status ${esc(status)}">${esc(status)}</span>`;
const time = (date) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
async function refresh() {
  state = await api('state');
  $('#mode').textContent = state.mode === 'mock' ? 'Mock canvas · local' : 'Live Paper connection';
  $('#environment').textContent = state.mode.toUpperCase() + ' MODE';
  $('#environment').classList.toggle('live', state.mode === 'live');
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
  if (!state.reviews.some(review => review.id === selected)) selected = state.reviews[0]?.id;
  renderList();
  if (selected) {
    const id = selected;
    const next = await api('reviews/' + id);
    if (id !== selected) return;
    if (JSON.stringify(next) !== JSON.stringify(detail)) {
      detail = next;
      renderDetail();
    }
  }
}
function renderList() {
  if (!state) return;
  const term = $('#search').value.toLowerCase(),
    status = $('#status-filter').value;
  const list = state.reviews.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      `${r.title} ${r.agent}`.toLowerCase().includes(term),
  );
  const html = list.length
    ? list
        .map(
          (r) =>
            `<button class="review-item ${r.id === selected ? 'selected' : ''}" aria-pressed="${r.id === selected}" data-review="${esc(r.id)}"><div class="item-top"><span>${esc(r.id.slice(0, 8))}</span>${badge(r.status)}</div><h3>${esc(r.title)}</h3><div class="item-bottom">${esc(r.agent)} <span>· ${time(r.created_at)}</span></div></button>`,
        )
        .join('')
    : `<div class="list-empty">${state.reviews.length ? 'No reviews match these filters.' : 'No reviews yet.'}</div>`;
  if (html === queueMarkup) return;
  queueMarkup = html;
  const focusId = document.activeElement?.dataset.review;
  $('#review-list').innerHTML = html;
  if (focusId) $('#review-list').querySelector(`[data-review="${CSS.escape(focusId)}"]`)?.focus({preventScroll:true});
  document.querySelectorAll('[data-review]').forEach(
    (b) =>
      (b.onclick = run(() => selectReview(b.dataset.review))),
  );
}
async function selectReview(id) {
  const next = await api('reviews/' + id);
  selected = id;
  tab = 'all';
  detail = next;
  const url = new URL(location.href);
  url.searchParams.set('review', id);
  history.replaceState(null, '', url);
  renderList();
  renderDetail();
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
function renderGroup(group, index) {
  let failure = group.error_json;
  if (failure) {
    try { failure = JSON.parse(failure).message ?? failure; } catch { /* Older rows may store plain text. */ }
  }
  return `<div class="group"><span>${index + 1}.</span><code>${esc(group.tool)}</code>${badge(group.status)}
    ${failure ? `<p class="contract-warning">${esc(failure)}</p>` : ''}
    <details><summary>Replay arguments</summary><pre class="value">${esc(JSON.stringify(group.args, null, 2))}</pre></details>
  </div>`;
}
function renderOp(op) {
  const action = op.before === null ? 'Added' : op.after === null ? 'Removed' : 'Modified';
  const label = op.varName ?? op.after?.id ?? op.before?.id ?? op.after?.tag ?? op.before?.tag ?? op.key;
  const path = op.after?.path ?? op.before?.path;
  return `<article class="op">
    <div class="op-head">
      <span class="op-icon" aria-hidden="true">${op.space === 'token' ? '◈' : action === 'Added' ? '+' : action === 'Removed' ? '−' : '↗'}</span>
      <code>${esc(label)}</code>${path ? `<span class="muted">${esc(path)}</span>` : ''}
      <span class="op-label">${action} · ${esc(op.status)}</span>
    </div>
    <div class="op-values"><div class="value"><small>BEFORE</small>${esc(value(op.before))}</div><div class="value after"><small>AFTER</small>${esc(value(op.after))}</div></div>
    ${op.appliedWithinGroup ? '<p class="contract-warning">Application within the failed call is unknown.</p>' : ''}
  </article>`;
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
  const host = $('#review-content');
  const active = host.contains(document.activeElement) ? document.activeElement : null;
  const focusId = active?.id;
  const focusTab = active?.dataset.tab;
  const scroll = host.querySelector('.ops')?.scrollTop ?? 0;
  const blocked = conflicts.length > 0;
  const retry = r.status === 'partial';
  const completed = r.status === 'admitted';
  const closed = r.status === 'rejected';
  const canAdmit = approvals.has(r.id) && ['approved', 'partial'].includes(r.status) && !blocked;
  const stageReady = ops.length > 0;
  const reviewed = ['approved', 'partial', 'admitting', 'admitted'].includes(r.status);
  const current = !stageReady ? 0 : !reviewed ? 1 : completed ? -1 : 2;
  const steps = [
    ['Draft change', stageReady],
    ['Review diff', reviewed],
    [retry ? 'Admission stopped' : 'Commit to canvas', completed],
  ];
  const lifecycle = closed ? '' : `<ol class="lifecycle" aria-label="Review progress">${steps.map(([label, done], i) => {
    const isCurrent = current === i;
    return `<li class="${done ? 'done' : ''} ${isCurrent ? 'current' : ''} ${isCurrent && (retry || blocked) ? 'blocked' : ''}" ${isCurrent ? 'aria-current="step"' : ''}><span aria-hidden="true">${done ? '✓' : i + 1}</span>${label}</li>`;
  }).join('')}</ol>`;
  const related = [...new Set(conflicts.map(conflict => conflict.reviewId))];
  const overlap = blocked ? `<div class="banner"><p><strong>Approval blocked</strong> · ${conflicts.length} overlapping change ${conflicts.length === 1 ? 'pair' : 'pairs'}.</p><ul>${related.map(id => {
    const other = state.reviews.find(review => review.id === id);
    return `<li><a href="/?review=${encodeURIComponent(id)}" data-conflict="${esc(id)}">${esc(other?.title ?? id.slice(0, 8))}</a>${other ? ` · ${esc(other.status)}` : ''}</li>`;
  }).join('')}</ul></div>` : '';
  const stopped = retry ? '<div class="banner"><strong>Admission stopped.</strong> Check Paper for changes from the failed call before resuming.</div>' : '';
  const tabs = [['all', 'All changes', ops.length], ['nodes', 'Nodes', nodes.length],
    ['tokens', 'Tokens', tokens.length], ['calls', 'Tool calls', groups.length]];
  const content = tab === 'calls'
    ? groups.map(renderGroup).join('')
    : filtered.map(renderOp).join('');
  host.innerHTML = `
    <div class="detail-head">
      <div class="detail-meta"><span>${esc(r.id.slice(0, 8))}</span>${badge(r.status)}</div>
      <h2>${esc(r.title)}</h2>
      <div class="detail-sub">${esc(r.agent)} · ${groups.length} tool ${groups.length === 1 ? 'call' : 'calls'} · ${nodes.length} node / ${tokens.length} token changes</div>
      <div class="detail-actions">
        ${stageReady ? `<a class="button" href="/merge-state/?review=${encodeURIComponent(r.id)}">Open in Merge State ↗</a>` : ''}
        ${canEdit ? '<button class="button" id="stage">＋ Record draft call</button>' : ''}
        ${canApprove && !canAdmit ? `<button class="button approve" id="approve">✓ ${reviewed ? 'Resolve again' : 'Resolve diff'}</button>` : ''}
        ${canAdmit ? `<button class="button primary" id="admit">${retry ? 'Resume Merge' : 'Commit to canvas'} ↗</button>` : ''}
        ${canEdit || retry ? `<button class="button danger" id="reject">${retry ? 'Close partial review' : 'Reject'}</button>` : ''}
      </div>
    </div>
    ${lifecycle}${stopped}${overlap}
    <div class="tabs" role="group" aria-label="Change views">
      ${tabs.map(([key, label, count]) => `<button class="tab ${tab === key ? 'active' : ''}" aria-pressed="${tab === key}" data-tab="${key}">${label} <span>${count}</span></button>`).join('')}
    </div>
    <div class="ops">${content || '<div class="empty"><h3>No changes in this view</h3><p>Stage a tool call or select another view.</p></div>'}</div>
    <div class="review-bottom">
      <span>BASE ${esc(r.base_hash.slice(0, 10))} / DIFF ${esc(diffHash.slice(0, 10))}</span>
      <span>${blocked ? 'Conflicts detected' : 'No review conflicts'} · Non-atomic replay</span>
    </div>`;
  if (focusId) {
    const next = document.getElementById(focusId) ??
      (focusId === 'approve' ? $('#admit') : null);
    next?.focus({preventScroll:true});
  }
  if (focusTab) host.querySelector(`[data-tab="${CSS.escape(focusTab)}"]`)?.focus({preventScroll:true});
  host.querySelector('.ops').scrollTop = scroll;
  host.querySelectorAll('[data-conflict]').forEach(link => link.onclick = run(event => {
    event.preventDefault();
    return selectReview(link.dataset.conflict);
  }));
  host.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
    tab = button.dataset.tab;
    renderDetail();
    host.querySelector('.ops').scrollTop = 0;
  });
  if ($('#stage')) $('#stage').onclick = stageModal;
  if ($('#approve'))
    $('#approve').onclick = run(async () => {
      const approval = await api('approve', { reviewId: r.id, diffHash });
      approvals.set(r.id, approval);
      toast('Diff resolved. Commit when ready.');
      await refresh();
      if (selected === r.id) renderDetail();
    });
  if ($('#admit')) $('#admit').onclick = () => admitModal(r);
  if ($('#reject'))
    $('#reject').onclick = () => {
      modal(
        r.status === 'partial' ? 'Close partial review?' : 'Reject this review?',
        `<p class="modal-copy">${r.status === 'partial' ? 'Inspect Paper first. Closing ends retries and clears review conflicts. Any changes already applied in Paper remain.' : `Close “${esc(r.title)}” without replaying its recorded calls.`}</p><div class="modal-actions"><button class="button danger" id="confirm-reject">${r.status === 'partial' ? 'Close draft' : 'Discard draft'}</button></div>`,
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
    '<p class="modal-copy">Start with a snapshot of the current canvas and its global tokens.</p><form id="open-form"><label class="form-field">Draft title<input id="title" placeholder="What are you working on?" required maxlength="160" autofocus></label><div class="modal-actions"><button class="button primary">Open draft ↗</button></div></form>',
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
  const reviewId = selected;
  const writes = state.schemas.tools.filter((t) => state.classes[t.name] === 'write');
  modal(
    'Stage a tool call',
    `<p class="modal-copy">This call stays in the draft. Arguments are validated against the ${state.mode === 'mock' ? 'mock-only fixture' : 'discovered live contract'}.</p><form id="stage-form"><label class="form-field">Discovered tool<select id="tool">${writes.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></label><label class="form-field">Arguments · JSON<textarea id="args" spellcheck="false">{}</textarea></label><details><summary class="modal-copy">Inspect runtime input schema</summary><pre class="value" id="input-schema"></pre></details><div class="modal-actions"><button class="button primary" ${writes.length ? '' : 'disabled'}>Record draft call ↗</button></div></form>`,
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
    let args;
    try {
      args = JSON.parse($('#args').value);
    } catch {
      throw new Error('Enter valid JSON for the tool arguments.');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    const staged = await api('stage', {
      reviewId,
      tool: $('#tool').value,
      arguments: args,
    });
    if (!staged.noOp) approvals.delete(reviewId);
    $('#modal').close();
    await refresh();
    toast(staged.noOp ? 'This call made no changes to the proposal.' : 'Call staged for review.');
  });
}
function admitModal(r) {
  modal(
    r.status === 'partial' ? 'Resume Merge?' : 'Commit to canvas?',
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
