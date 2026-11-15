import { sample } from './fixture.js';
import { fromAirlock } from './bridge.js';

const $ = id => document.getElementById(id);
const surface = $('pressure');
const colors = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];
const boxes = ['box', 'width', 'height', 'left', 'right', 'top', 'bottom', 'x', 'y'];
const computable = new Set([...colors, ...boxes, 'opacity', 'transform']);
const scrollLayers = [$('before'), $('proposed')];
const duration = 1000;
let review, frames, generation = 0, observer, rows = [], selected = 0, decision = '';
let tracks = [], overlay, reduced = false, reductionTimer = 0, wanted = 1, raf = 0;
let rendered = -1, renderedReduced = false;
let scrollAt = 0, maxScroll = 0;

// Fixed ring and histogram. Bins are 0.25 ms wide with an overflow bin.
const ring = new Uint16Array(1024);
const deltas = new Float64Array(1024);
const bucketSamples = new Float64Array(1024);
const stamps = new Float64Array(1024);
const histogram = new Uint16Array(1024);
let count = 0, head = 0, last = 0, sampledSince = 0, highSince = 0, activeUntil = 0, measured = 0;
function resetTiming() {
  histogram.fill(0);
  count = head = last = sampledSince = highSince = 0;
}
function measureFrame(now) {
  if (last) {
    const delta = now - last;
    const slot = delta <= 8.33 ? Math.min(33, Math.ceil(delta * 4)) : Math.max(34, Math.min(1023, Math.ceil(delta * 4)));
    while (count && (now - stamps[head] > 500 || count === 1024)) {
      histogram[ring[head]]--;
      head = (head + 1) & 1023;
      count--;
    }
    const tail = (head + count) & 1023;
    ring[tail] = slot;
    deltas[tail] = delta;
    stamps[tail] = now;
    histogram[slot]++;
    count++;
    const rank = Math.ceil(count * .95);
    let sum = 0, bin = 0;
    while (sum < rank) sum += histogram[bin++];
    const target = bin - 1;
    let size = 0;
    for (let i = 0; i < count; i++) {
      const entry = (head + i) & 1023;
      if (ring[entry] !== target) continue;
      const value = deltas[entry];
      let j = size++;
      while (j && bucketSamples[j - 1] > value) {
        bucketSamples[j] = bucketSamples[j - 1];
        j--;
      }
      bucketSamples[j] = value;
    }
    measured = bucketSamples[rank - (sum - histogram[target]) - 1];
    if (measured > 8.33) {
      if (!highSince) highSince = last;
      if (now - sampledSince >= 500 && now - highSince >= 500) {
        reduced = true;
        reductionTimer = setTimeout(showReduction, 0);
      }
    } else highSince = 0;
  } else sampledSince = now;
  last = now;
}
function showReduction() {
  $('reduced').textContent = 'DETAIL REDUCED · Frame time p95 ' + measured.toFixed(2) + ' ms · Crossfade active';
  $('reduced').hidden = false;
  renderInspector();
  select(selected);
}

function frame(now) {
  raf = 0;
  if (!reduced && now <= activeUntil) measureFrame(now);
  if (wanted !== rendered || reduced !== renderedReduced) {
    const time = wanted * duration;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const fade = reduced || track.fallback;
      if (track.morph) track.morph.currentTime = fade ? duration : time;
      if (track.enter) track.enter.currentTime = fade ? time : duration;
      if (track.exit) track.exit.currentTime = fade ? time : duration;
    }
    rendered = wanted;
    renderedReduced = reduced;
  }
  if (!reduced && now < activeUntil) raf = requestAnimationFrame(frame);
  else last = 0;
}
function setScrub(value, active = false) {
  wanted = Math.max(0, Math.min(1, value));
  $('scrubber').value = wanted * 100;
  $('percent').value = Number((wanted * 100).toFixed(1)) + '%';
  $('preview-label').textContent = wanted === 1 ? 'PROPOSED SNAPSHOT' : 'SCRUB PREVIEW';
  if (active) {
    const now = performance.now();
    if (now > activeUntil) resetTiming();
    activeUntil = now + 620;
  }
  if (!raf) raf = requestAnimationFrame(frame);
}
function setScroll(value) {
  scrollAt = Math.min(maxScroll, Math.max(0, value));
  const offset = 'translate3d(0,' + (-scrollAt) + 'px,0)';
  for (const layer of scrollLayers) layer.style.transform = offset;
  $('scroll').value = maxScroll ? scrollAt / maxScroll * 1000 : 0;
}
function paused(node, keyframes) {
  const animation = node.animate(keyframes, { duration, fill: 'both' });
  animation.pause();
  animation.currentTime = duration;
  return animation;
}
function positions(element) {
  if (!element) return null;
  // Called only while preparing the review. Measure the box before transforms.
  const sheet = element.ownerDocument.createElement('style');
  sheet.textContent = '#snapshot [data-pressure-id="' +
    CSS.escape(element.dataset.pressureId) +
    '"]{transform:none!important;translate:none!important;scale:none!important;rotate:none!important}';
  element.ownerDocument.head.append(sheet);
  const rect = element.getBoundingClientRect();
  sheet.remove();
  return rect;
}
function visualStyle(node) {
  const computed = node.ownerDocument.defaultView.getComputedStyle(node);
  const values = { opacity: computed.opacity, transform: computed.transform, transformOrigin: computed.transformOrigin,
    translate: computed.translate, rotate: computed.rotate, scale: computed.scale };
  for (const name of colors) values[name] = computed.getPropertyValue(name);
  return values;
}
function frameStyle(style, properties) {
  const output = { opacity: style.opacity };
  for (const { name } of properties) {
    if (colors.includes(name)) {
      const camel = name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      output[camel] = style[name];
    }
  }
  return output;
}
function transformAt(style, dx, dy, sx, sy) {
  const [x, y] = style.transformOrigin.split(' ').map(Number.parseFloat);
  const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
  return new DOMMatrix().translate(dx, dy).scale(sx, sy).translate(x, y)
    .multiply(matrix).translate(-x, -y).toString();
}
function duplicateForFade(source, rect, style) {
  const clone = overlay.ownerDocument.importNode(source, true);
  const originals = [source, ...source.querySelectorAll('*')];
  const duplicates = [clone, ...clone.querySelectorAll('*')];
  for (let i = 0; i < originals.length; i++) {
    const computed = source.ownerDocument.defaultView.getComputedStyle(originals[i]);
    for (const property of computed) duplicates[i].style.setProperty(property, computed.getPropertyValue(property));
    duplicates[i].removeAttribute('id');
    duplicates[i].removeAttribute('data-pressure-id');
  }
  Object.assign(clone.style, {
    position: 'absolute', margin: '0', inset: 'auto', left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px', boxSizing: 'border-box', opacity: style.opacity,
  });
  overlay.append(clone);
  return paused(clone, [{ opacity: style.opacity, visibility: 'visible' }, { opacity: 0, visibility: 'hidden' }]);
}
function snapshotMap(doc) {
  return new Map([...doc.querySelectorAll('#snapshot [data-pressure-id]')].map(node => [node.dataset.pressureId, node]));
}
function compileTracks() {
  if (!frames) return;
  for (const track of tracks) {
    track.morph?.cancel();
    track.enter?.cancel();
    track.exit?.cancel();
  }
  overlay.replaceChildren();
  for (const iframe of frames) {
    iframe.style.height = '1px';
    iframe.style.height = Math.max(iframe.parentElement.parentElement.clientHeight, iframe.contentDocument.body.scrollHeight) + 'px';
  }
  maxScroll = Math.max(...frames.map(iframe => iframe.offsetHeight - iframe.parentElement.parentElement.clientHeight));
  setScroll(scrollAt);
  const before = snapshotMap(frames[0].contentDocument);
  const proposed = snapshotMap(frames[1].contentDocument);
  const owned = new Set();
  tracks = [];
  // Ancestor transitions own their descendants. Overlapping transitions would
  // compound transforms and double-paint the affected subtree.
  const ordered = [...review.changes].sort((a, b) => {
    const depth = n => { let d = 0; while (n?.parentElement) { d++; n = n.parentElement; } return d; };
    return depth(proposed.get(a.id) ?? before.get(a.id)) - depth(proposed.get(b.id) ?? before.get(b.id));
  });
  for (const change of ordered) {
    const a = before.get(change.id), b = proposed.get(change.id);
    const covered = [...owned].some(id => (a && before.get(id)?.contains(a)) || (b && proposed.get(id)?.contains(b)));
    const empty = !a && !b;
    const from = a && visualStyle(a), to = b && visualStyle(b);
    const fromBox = positions(a), toBox = positions(b);
    const sameLeaf = a && b && a.tagName === b.tagName && a.textContent === b.textContent &&
      a.childElementCount === 0 && b.childElementCount === 0;
    const morphable = sameLeaf && !change.structural && toBox.width && toBox.height &&
      fromBox.width && fromBox.height &&
      [from, to].every(style => style.translate === 'none' && style.rotate === 'none' && style.scale === 'none' &&
        (!style.transform.startsWith('matrix3d') && style.transformOrigin.split(' ').length === 2)) &&
      change.properties.every(property => computable.has(property.name));
    const track = { id: change.id, fallback: !morphable || covered, morph: null, enter: null, exit: null,
      reason: empty ? 'Node unavailable' : covered ? 'Ancestor crossfade' : '' };
    if (!covered && !empty) {
      owned.add(change.id);
      if (morphable) {
        const start = frameStyle(from, change.properties);
        const end = frameStyle(to, change.properties);
        start.transformOrigin = end.transformOrigin = '0px 0px';
        start.transform = transformAt(from, fromBox.left - toBox.left, fromBox.top - toBox.top,
          fromBox.width / toBox.width, fromBox.height / toBox.height);
        end.transform = transformAt(to, 0, 0, 1, 1);
        track.morph = paused(b, [start, end]);
      }
      if (a && fromBox.width && fromBox.height) track.exit = duplicateForFade(a, fromBox, from);
      if (b) track.enter = paused(b, [{ opacity: 0, visibility: 'hidden' }, { opacity: to.opacity, visibility: 'visible' }]);
      // A morph and fade may both animate opacity. Replace composition takes
      // the newest effect, so the fade is removed from the effect stack in morph mode.
      if (track.morph && track.enter) track.enter.effect.updateTiming({ fill: 'none' });
    }
    tracks.push(track);
  }
  renderInspector();
  select(selected);
  rendered = -1;
  setScrub(wanted);
}

const forbidden = 'script,iframe,frame,frameset,object,embed,portal,base,meta,link,form,video,audio,source,track';
function safeSnapshot(snapshot) {
  const template = document.createElement('template');
  template.innerHTML = snapshot.html;
  template.content.querySelectorAll(forbidden).forEach(node => node.remove());
  for (const node of template.content.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      if (/^(on|srcset$|srcdoc$|autofocus$|action$|formaction$|ping$|target$|is$)/i.test(attr.name) ||
        ((/^(src|href|xlink:href)$/i.test(attr.name)) && !/^(#|data:image\/(png|webp|gif|jpeg);base64,)/i.test(attr.value))) {
        node.removeAttribute(attr.name);
      }
    }
  }
  const css = String(snapshot.css ?? '').replace(/</g, '\\3c ');
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" ' +
    'content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">' +
    '<style>html,body{margin:0;overflow:hidden}#pressure-overlay{position:absolute;inset:0;z-index:2147483647;pointer-events:none}</style>' +
    '<style>' + css + '</style><main id="snapshot">' + template.innerHTML +
    '</main><div id="pressure-overlay" aria-hidden="true"></div>';
}
function mount(layer, snapshot, label) {
  return new Promise(resolve => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('tabindex', '-1');
    iframe.inert = true;
    iframe.title = label;
    iframe.addEventListener('load', () => resolve(iframe), { once: true });
    iframe.srcdoc = safeSnapshot(snapshot);
    layer.replaceChildren(iframe);
  });
}
function validate(input) {
  if (typeof input?.before?.html !== 'string' || typeof input.proposed?.html !== 'string' ||
    !Array.isArray(input.changes) || input.changes.some(change => typeof change?.id !== 'string' ||
      !Array.isArray(change.properties) || change.properties.some(property => typeof property?.name !== 'string')) ||
    new Set(input.changes.map(change => change.id)).size !== input.changes.length) {
    throw new Error('A review needs before and proposed HTML plus uniquely identified changes and their property lists.');
  }
  return input;
}
export async function loadReview(input) {
  review = validate(input);
  const version = ++generation;
  observer?.disconnect();
  clearTimeout(reductionTimer);
  cancelAnimationFrame(raf);
  raf = 0;
  resetTiming();
  activeUntil = 0;
  frames = null;
  tracks = [];
  reduced = false;
  decision = '';
  selected = 0;
  wanted = 1;
  rendered = -1;
  scrollAt = 0;
  $('error').hidden = $('reduced').hidden = true;
  $('review-title').textContent = review.title ?? 'Canvas review';
  $('review-id').textContent = review.id ?? 'Untitled';
  $('source').textContent = (review.source ?? 'Imported review').toUpperCase();
  $('summary').textContent = review.note ?? 'Compare both snapshots, scrub the transition, and inspect the cascade.';
  $('status').textContent = 'Loading snapshots…';
  decisionButtons(false);
  const pair = await Promise.all([
    mount(scrollLayers[0], review.before, 'Before DOM snapshot'),
    mount(scrollLayers[1], review.proposed, 'Proposed DOM snapshot'),
  ]);
  if (version !== generation) return;
  frames = pair;
  overlay = frames[1].contentDocument.getElementById('pressure-overlay');
  compileTracks();
  observer = new ResizeObserver(compileTracks);
  for (const viewport of document.querySelectorAll('.viewport')) observer.observe(viewport);
  decisionButtons(true);
  $('status').textContent = 'Review ready';
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function renderInspector() {
  const focused = document.activeElement?.dataset.changeId;
  rows = review.changes.map((change, index) => {
    const track = tracks.find(track => track.id === change.id);
    const approximated = reduced || track?.fallback;
    const button = element('button', null, 'node');
    button.dataset.changeId = change.id;
    button.setAttribute('aria-pressed', 'false');
    button.append(element('span', String(index + 1).padStart(2, '0'), 'node-index'),
      element('strong', change.label ?? change.id),
      element('span', approximated ? 'Approximated · ' + (track?.reason || 'Crossfade') :
        change.properties.length + ' computed changes', 'node-meta' + (approximated ? ' approx' : '')));
    button.addEventListener('click', () => select(index));
    return button;
  });
  $('nodes').replaceChildren(...rows);
  $('node-count').textContent = String(rows.length).padStart(2, '0');
  if (!rows.length) $('nodes').append(element('p', 'No changed nodes.'));
  if (focused) rows.find(row => row.dataset.changeId === focused)?.focus({ preventScroll: true });
}
function select(index, focus = false) {
  selected = rows.length ? (index + rows.length) % rows.length : 0;
  rows.forEach((row, i) => {
    row.setAttribute('aria-selected', String(i === selected));
    row.setAttribute('aria-pressed', String(i === selected));
    row.tabIndex = i === selected ? 0 : -1;
  });
  if (focus && rows[selected]) {
    rows[selected].focus({ preventScroll: true });
    const list = $('nodes');
    const row = rows[selected];
    const y = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (y < list.scrollTop) list.scrollTop = y;
    else if (y + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = y + row.offsetHeight - list.clientHeight;
  }
  const rules = $('rules');
  rules.replaceChildren();
  const change = review.changes[selected];
  if (!change?.properties.length) rules.append(element('p', 'No computed rule data supplied.', 'muted'));
  for (const property of change?.properties ?? []) {
    const section = element('section', null, 'rule');
    section.append(element('strong', property.name),
      element('p', (property.before ?? '—') + ' → ' + (property.after ?? '—')),
      element('span', 'Previous winning rule'), element('pre', property.previousRule ?? 'Unavailable'),
      element('span', 'Winning rule'), element('pre', property.rule ?? 'Unavailable'));
    rules.append(section);
  }
}
function decisionButtons(enabled) {
  for (const id of ['approve', 'reject', 'abort']) $(id).setAttribute('aria-disabled', String(!enabled));
}
function decide(value) {
  if (!frames || decision) return;
  decision = value;
  decisionButtons(false);
  $('status').textContent = value === 'abort' ? 'Review aborted' : (value === 'approve' ? 'Approval' : 'Rejection') + ' decision emitted';
  surface.dispatchEvent(new CustomEvent('pressure:decision', {
    bubbles: true, detail: { decision: value, reviewId: review.id, mutationId: review.mutationId, diffHash: review.diffHash },
  }));
}
function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
}
surface.addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    const stops = [...surface.querySelectorAll('a[href],button,input,summary,[tabindex="0"]')].filter(
      node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length,
    );
    const at = stops.indexOf(document.activeElement);
    if (at < 0 || (!event.shiftKey && at === stops.length - 1) || (event.shiftKey && at === 0)) {
      event.preventDefault();
      (event.shiftKey ? stops.at(-1) : stops[0])?.focus({ preventScroll: true });
    }
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (!['j', 'k', ' ', 'x', 'escape'].includes(key)) return;
  event.preventDefault();
  if (key === 'j' || key === 'k') { select(selected + (key === 'j' ? 1 : -1), true); return; }
  if (!event.repeat) decide(key === ' ' ? 'approve' : key === 'x' ? 'reject' : 'abort');
});
document.addEventListener('focusin', event => {
  if (!surface.contains(event.target)) surface.focus({ preventScroll: true });
});
for (const id of ['approve', 'reject', 'abort']) $(id).addEventListener('click', () => decide(id));
$('scrubber').addEventListener('input', event => setScrub(event.target.valueAsNumber / 100, event.isTrusted));
$('scroll').addEventListener('input', event => setScroll(maxScroll * event.target.valueAsNumber / 1000));
for (const pane of document.querySelectorAll('.viewport')) {
  pane.addEventListener('wheel', event => {
    if (event.ctrlKey) return;
    event.preventDefault();
    setScroll(scrollAt + event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 320 : 1));
  }, { passive: false });
  let touchY;
  pane.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY; }, { passive: true });
  pane.addEventListener('touchmove', event => {
    if (touchY == null || event.touches.length !== 1) return;
    event.preventDefault();
    const y = event.touches[0].clientY;
    setScroll(scrollAt + touchY - y);
    touchY = y;
  }, { passive: false });
  pane.addEventListener('keydown', event => {
    const delta = { ArrowDown: 36, ArrowUp: -36, PageDown: 260, PageUp: -260, Home: -maxScroll, End: maxScroll }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    setScroll(scrollAt + delta);
  });
}
$('import').addEventListener('change', async event => {
  try {
    const file = event.target.files[0];
    if (file) await loadReview(JSON.parse(await file.text()));
  } catch (error) { showError(error); }
  finally { event.target.value = ''; }
});
surface.addEventListener('pressure:load', event => loadReview(event.detail).catch(showError));
export const ready = (async () => {
  const id = new URLSearchParams(location.search).get('review');
  try {
    if (id) {
      const response = await fetch('/api/reviews/' + encodeURIComponent(id));
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error?.message ?? 'Unable to load Airlock review.');
      await loadReview(fromAirlock(result));
    } else await loadReview(sample);
  } catch (error) { showError(error); }
})();
if (new URLSearchParams(location.search).has('test')) import('./tests.js');
