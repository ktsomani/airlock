import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { errorJSON, fail } from './core.js';
import type { Engine } from './engine.js';
import type { Config } from './config.js';
import { classify } from './paper.js';
export async function serveWeb(engine: Engine, cfg: Config) {
  const csrf = randomBytes(32).toString('hex');
  async function body(req: IncomingMessage) {
    let data = '';
    for await (const part of req) {
      data += part;
      if (Buffer.byteLength(data) > 1024 * 1024) fail('body_too_large');
    }
    return JSON.parse(data || '{}');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const host = req.headers.host ?? '';
      if (![`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`].includes(host)) fail('invalid_host');
      const path = new URL(req.url ?? '/', `http://${host}`).pathname;
      if (req.headers.origin && req.headers.origin !== `http://${host}`) fail('invalid_origin');
      if (req.headers['sec-fetch-site'] === 'cross-site') fail('invalid_origin');
      let result: unknown;
      const pressureAsset = /^\/pressure\/(?:index\.html|style\.css|(?:app|fixture|bridge|tests)\.js)?$/.test(path);
      if (req.method === 'GET' && (['/', '/app.js', '/style.css'].includes(path) || pressureAsset)) {
        const file = path.endsWith('/') ? path.slice(1) + 'index.html' : path.slice(1);
        if (pressureAsset && file.endsWith('.html')) {
          res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' about:; img-src data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        }
        res.setHeader(
          'Content-Type',
          file.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : file.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'text/css; charset=utf-8',
        );
        res.end(await readFile(fileURLToPath(new URL('../public/' + file, import.meta.url))));
        return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        const schemas = await engine.schemas.fresh();
        result = {
          csrf,
          mode: cfg.mode,
          schemas,
          classes: Object.fromEntries(
            schemas.tools.map((t) => [t.name, classify(t.name, engine.adapter)]),
          ),
          reviews: engine.list(),
        };
      } else if (req.method === 'GET' && path.startsWith('/api/reviews/'))
        result = engine.diff(decodeURIComponent(path.slice('/api/reviews/'.length)));
      else if (req.method === 'POST') {
        const supplied = Buffer.from(String(req.headers['x-airlock-csrf'] ?? ''));
        if (supplied.length !== csrf.length || !timingSafeEqual(supplied, Buffer.from(csrf)))
          fail('invalid_csrf');
        if (!req.headers['content-type']?.startsWith('application/json'))
          fail('invalid_content_type');
        const b = await body(req);
        if (path === '/api/approve') {
          if (typeof b.diffHash !== 'string' || !b.diffHash) fail('diff_hash_required');
          result = await engine.approve(b.reviewId, b.diffHash);
        } else if (path === '/api/admit')
          result = await engine.admit(b.reviewId, b.approvalToken, b.resume === true);
        else if (path === '/api/reject') result = await engine.reject(b.reviewId);
        else if (path === '/api/open')
          result = await engine.open(String(b.title ?? 'Untitled review'), 'human');
        else if (path === '/api/stage')
          result = await engine.stage(b.reviewId, b.tool, b.arguments);
        else if (path === '/api/schema/refresh') result = await engine.schemas.refresh(false);
        else if (path === '/api/schema/accept') result = engine.schemas.acceptDrift();
        else fail('not_found');
      } else fail('not_found');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: errorJSON(e) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', resolve);
  });
  return server;
}
