import { loadReview, ready } from './app.js';
import { sample } from './fixture.js';

const results = document.createElement('section');
results.className = 'test-results';
results.setAttribute('aria-label', 'Browser test results');
document.querySelector('footer').before(results);
const output = document.createElement('pre');
results.append(output);
let failures = 0;
const fail = message => { throw new Error(message); };
function assert(condition, message) { if (!condition) fail(message); }
function test(name, run) {
  try { run(); output.textContent += 'PASS  ' + name + '\n'; }
  catch (error) { failures++; output.textContent += 'FAIL  ' + name + ' · ' + error.message + '\n'; }
}
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function scrub(value) {
  const range = document.getElementById('scrubber');
  range.value = value;
  range.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}
function snapshot() {
  return document.querySelector('#proposed iframe').contentDocument.getElementById('snapshot');
}
function geometry() {
  const { x, y, width, height } = snapshot().querySelector('[data-merge-state-id="mast"]').getBoundingClientRect();
  return [x, y, width, height];
}
try {
  await ready;
  await loadReview(sample);
  await scrub(0);
  const beforeGeometry = geometry();
  await scrub(100);
  test('100% is structurally identical to the proposed DOM', () => {
    const expected = document.createElement('template');
    expected.innerHTML = sample.proposed.html;
    const actual = snapshot().innerHTML;
    const target = expected.innerHTML;
    const offset = [...target].findIndex((character, index) => character !== actual[index]);
    assert(actual === target, 'Mismatch near ' + offset + ' · expected ' +
      target.slice(Math.max(0, offset - 12), offset + 65) + ' · got ' +
      actual.slice(Math.max(0, offset - 12), offset + 65));
  });
  test('Unchanged mast geometry is identical at 0% and 100%', () => {
    assert(geometry().every((n, i) => n === beforeGeometry[i]), 'Unchanged geometry drifted.');
  });
  test('A changed border radius triggers a labeled fallback', () => {
    const row = document.querySelector('[data-change-id="tag"]');
    assert(row.textContent.includes('Approximated · Crossfade'), 'Fallback label is missing.');
    assert(!document.querySelector('[data-change-id="route"]').textContent.includes('Approximated'),
      'Supported route should interpolate.');
  });
  test('Keyboard Space emits one approval even on repeated presses', () => {
    const surface = document.getElementById('merge-state');
    const events = [];
    surface.addEventListener('merge-state:decision', event => events.push(event.detail.decision));
    const range = document.getElementById('scrubber');
    range.focus({ preventScroll: true });
    const press = (repeat = false) => range.dispatchEvent(new KeyboardEvent('keydown',
      { key: ' ', repeat, bubbles: true, cancelable: true }));
    press(); press(true); press();
    assert(events.length === 1 && events[0] === 'approve', 'Expected exactly one approval.');
  });
} catch (error) {
  failures++;
  output.textContent += 'FAIL  Browser setup · ' + error.message + '\n';
}
results.dataset.result = failures ? 'failed' : 'passed';
output.textContent += failures ? failures + ' failed\n' : '4 passed\n';
