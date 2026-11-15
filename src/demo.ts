import type { Engine } from './engine.js';
export async function demo(engine: Engine) {
  const r = await engine.open('A calmer welcome, a clearer next step', 'Cursor');
  await engine.stage(r.review.id, 'write_html', {
    targetNodeId: 'welcome',
    html: '<main id="welcome" class="onboarding" style="background: var(--surface); color: var(--ink); padding: 48px"><span id="eyebrow">YOUR NEXT CHAPTER</span><h1 id="headline">Make room for good work.</h1><p id="description">A little clarity goes a long way. Set up your workspace and find your flow.</p><button id="cta" style="background: var(--accent); border-radius: 12px">Create your workspace</button></main>',
  });
  await engine.stage(r.review.id, 'set_tokens', {
    tokens: { '--accent': '#b8ef72', '--surface': '#f6f7f3', '--ink': '#20271f' },
  });
  return engine.diff(r.review.id);
}
