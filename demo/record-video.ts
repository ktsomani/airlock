import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator } from 'playwright';

const size = { width: 1280, height: 800 };
const recordings = fileURLToPath(new URL('./recordings/', import.meta.url));
const url = process.env.AIRLOCK_VIDEO_URL ?? 'http://localhost:3000';
const duration = 30_000;

async function record() {
  await mkdir(recordings, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.AIRLOCK_VIDEO_CHANNEL });
  try {
    const context = await browser.newContext({
      viewport: size,
      recordVideo: { dir: recordings, size },
      bypassCSP: true,
    });
    const start = performance.now();
    const page = await context.newPage();
    const video = page.video();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Stable base', exact: true }).waitFor();
      await page.addStyleTag({
        content: `
          html *, html *::before, html *::after { cursor: none !important; }
          #recording-cursor, .recording-ripple {
            position: fixed; top: 0; left: 0; pointer-events: none;
            z-index: 2147483647;
          }
          #recording-cursor {
            width: 25px; height: 32px; filter: drop-shadow(0 2px 2px #0008);
          }
          .recording-ripple {
            width: 38px; height: 38px; margin: -19px;
            border: 2px solid #56df8d; border-radius: 50%;
            animation: recording-click 420ms ease-out forwards;
          }
          @keyframes recording-click {
            from { scale: .35; opacity: 1; }
            to { scale: 1.65; opacity: 0; }
          }
        `,
      });
      await page.evaluate(() => {
        const ns = 'http://www.w3.org/2000/svg';
        const cursor = document.createElementNS(ns, 'svg');
        cursor.id = 'recording-cursor';
        cursor.setAttribute('viewBox', '0 0 25 32');
        cursor.setAttribute('aria-hidden', 'true');
        cursor.style.visibility = 'hidden';
        const arrow = document.createElementNS(ns, 'path');
        arrow.setAttribute('d', 'M2 2v22l6-5 5 10 4-2-5-10 8-1z');
        arrow.setAttribute('fill', '#111');
        arrow.setAttribute('stroke', '#fff');
        arrow.setAttribute('stroke-width', '1.75');
        arrow.setAttribute('stroke-linejoin', 'round');
        cursor.append(arrow);
        document.body.append(cursor);

        window.addEventListener(
          'pointermove',
          ({ clientX, clientY }) => {
            cursor.style.visibility = 'visible';
            cursor.style.transform = `translate(${clientX}px,${clientY}px)`;
          },
          { passive: true },
        );
        window.addEventListener(
          'pointerdown',
          ({ clientX, clientY }) => {
            const ripple = document.createElement('span');
            ripple.className = 'recording-ripple';
            ripple.style.transform = `translate(${clientX}px,${clientY}px)`;
            ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
            document.body.append(ripple);
          },
          { passive: true },
        );
      });
      const moveTo = async (target: Locator) => {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        if (!box) throw new Error('The next demo control is outside the recording viewport.');
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(point.x, point.y, { steps: 22 });
        return point;
      };

      const conflict = page.locator('#conflicts .conflict').filter({ hasText: '--color-text' });
      const swatch = conflict.getByRole('button', { name: '#ffffff', exact: true });
      const load = page.getByRole('button', { name: 'Load demo drafts', exact: true });
      const initialControl = await Promise.race([
        swatch.waitFor({ timeout: 10_000 }).then(() => 'swatch'),
        load.waitFor({ timeout: 10_000 }).then(() => 'demo'),
      ]).catch(() => {
        throw new Error(
          'No contrast conflict is visible. Select both demo drafts or use a fresh mock workspace.',
        );
      });
      if (initialControl === 'demo') {
        const point = await moveTo(load);
        await page.mouse.click(point.x, point.y);
      }

      await swatch.waitFor();
      await page.mouse.move(125, 134);
      await page.waitForTimeout(1000);

      await moveTo(conflict.locator('strong'));
      await page.waitForTimeout(1500);

      const white = await moveTo(swatch);
      await page.mouse.click(white.x, white.y);
      await page.waitForTimeout(1500);

      const merge = page.getByRole('button', { name: 'Compile & Merge Drafts' });
      const button = await moveTo(merge);
      await page.waitForTimeout(1000);
      await page.mouse.click(button.x, button.y);
      await page.waitForTimeout(2000);

      const ledger = page.getByRole('heading', { name: 'MergeLedger', exact: true });
      await ledger.waitFor();
      await page.locator('#status').getByText('Merge complete.', { exact: true }).waitFor();
      await page.locator('#ledger').scrollIntoViewIfNeeded();
      await page.waitForTimeout(Math.max(0, duration - (performance.now() - start)));
    } finally {
      await context.close();
    }
    if (!video) throw new Error('Playwright did not create a video.');
    console.log(await video.path());
  } finally {
    await browser.close();
  }
}

record().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
