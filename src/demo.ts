import type { Engine } from './engine.js';
import { fail } from './core.js';
import { mockAdapter } from './paper.js';

export async function demo(engine: Engine, previewOnly = false) {
  if (engine.adapter !== mockAdapter) fail('mock_only');
  const initial = await mockAdapter.capture(engine.paper);
  if (Object.keys(initial.canvas).length || Object.keys(initial.tokens).length)
    fail('demo_requires_empty_canvas', 'Use a fresh mock AIRLOCK_DATA_DIR for the merge demo.');
  const seeded = await engine.paper.callTool('set_tokens', {
    tokens: { '--color-bg': '#f5f6f0', '--color-text': '#202521' },
  });
  if (seeded.isError) fail('demo_seed_failed');
  const heading = await engine.paper.callTool('write_html', {
    targetNodeId: 'masthead',
    html: '<header id="masthead"><strong>STUDIO</strong></header>',
  });
  if (heading.isError) fail('demo_seed_failed');
  const a = await engine.open('Hero · black canvas', 'Agent A');
  const b = await engine.open('Navbar · graphite text', 'Agent B');
  await engine.stage(a.review.id, 'write_html', {
    targetNodeId: 'hero',
    html: '<section id="hero"><p>INTRODUCING STUDIO</p><h1>Make room for good work.</h1></section>',
  });
  await engine.stage(a.review.id, 'set_tokens', { tokens: { '--color-bg': '#000000' } });
  await engine.stage(b.review.id, 'write_html', {
    targetNodeId: 'navbar',
    html: '<nav id="navbar" style="color: var(--color-text)">Studio / Work / About</nav>',
  });
  await engine.stage(b.review.id, 'set_tokens', { tokens: { '--color-text': '#242424' } });
  const draftIds = [a.review.id, b.review.id];
  const intent = engine.previewMerge(draftIds);
  if (previewOnly) return { draftIds, intent };
  const compiled = await engine.compile(draftIds, { '--color-text': '#ffffff' }, intent.intentHash);
  const resolved = await engine.approve(compiled.review.id, compiled.diffHash);
  const ledger = await engine.admit(compiled.review.id, resolved.approvalToken);
  return {
    story: [
      'Start on a light canvas.',
      'Agent A adds the Hero and turns the background black.',
      'Agent B adds the Navbar and chooses dark gray text.',
      'Both trees merge. The contrast check flags the Navbar.',
      'Resolve with white text and replay the compiled draft.',
    ],
    MergeLedger: ledger,
  };
}
