import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.env.AIRLOCK_VISUAL_SOURCE ?? '/source';
const sizes = [
  ['mobile', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1440, 900],
];
const assets = {
  '/': ['compiler.html', 'text/html; charset=utf-8'],
  '/compiler.css': ['compiler.css', 'text/css; charset=utf-8'],
  '/compiler.js': ['compiler.js', 'text/javascript; charset=utf-8'],
};
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/state') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mode: 'mock', reviews: [] }));
      return;
    }
    const asset = req.method === 'GET' && Object.hasOwn(assets, req.url) && assets[req.url];
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    const file = join(root, asset[0]);
    if (!(await lstat(file)).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', asset[1]);
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'");
    res.end(await readFile(file));
  } catch {
    res.writeHead(500).end();
  }
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const shots = [];
  for (const [key, width, height] of sizes) {
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1,
      timezoneId: 'UTC', locale: 'en-US', reducedMotion: 'reduce',
      colorScheme: 'light', serviceWorkers: 'block',
    });
    try {
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      await page.goto(origin, { waitUntil: 'load' });
      await page.locator('#environment').getByText('Mock canvas', { exact: true }).waitFor({ state: 'attached' });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const footer = page.locator('body > footer');
      await footer.waitFor();
      const element = await page.evaluate(() => {
        const button = document.querySelector('#compile');
        if (!(button instanceof HTMLButtonElement)) return { exists: false, text: '', clipped: false };
        const label = button.querySelector('#compile-label');
        const text = (label?.textContent ?? [...button.childNodes]
          .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(''))
          .trim().replace(/\s+/g, ' ').slice(0, 150);
        const rect = button.getBoundingClientRect();
        const content = document.createRange();
        content.selectNodeContents(label ?? button);
        const textRect = content.getBoundingClientRect();
        const gutter = 2;
        return {
          exists: true,
          text,
          clipped: rect.left < -gutter || rect.right > innerWidth + gutter ||
            button.scrollWidth > button.clientWidth + gutter || button.scrollHeight > button.clientHeight + gutter ||
            textRect.left < rect.left - gutter || textRect.right > rect.right + gutter,
        };
      });
      // Capture the viewport's footer band, even if a regression makes the footer overflow.
      const bounds = await footer.boundingBox();
      const top = Math.max(0, Math.floor(bounds.y));
      const shot = await page.screenshot({
        animations: 'disabled', caret: 'hide',
        clip: { x: 0, y: top, width, height: Math.max(1, height - top) },
      });
      shots.push({ key, width, element, png: shot.toString('base64') });
    } finally {
      await context.close();
    }
  }
  process.stdout.write(gzipSync(JSON.stringify(shots)).toString('base64') + '\n');
} finally {
  await browser?.close();
  server.close();
}
