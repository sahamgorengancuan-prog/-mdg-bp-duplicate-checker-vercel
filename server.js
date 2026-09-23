// Standalone Node entry point for Render; Vercel uses api/*.js.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { handleCheck, handleHealth, handleOptions, json, snapshotEngine } from './_lib/duplicate.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 65536;
async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
export async function respond(req, res) {
  try {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'OPTIONS' && path.startsWith('/api/'))
      return send(res, handleOptions());
    if (path === '/api/health' && req.method === 'GET')
      return send(res, await handleHealth({ env: process.env }));
    if (path === '/api/check' && req.method === 'POST') {
      let total = 0;
      const parts = [];
      for await (const chunk of req) {
        total += chunk.length;
        if (total > BODY_LIMIT) {
          return send(res, json({ ok: false, error: 'Request body too large' }, 413));
        }
        parts.push(chunk);
      }
      const request = new Request('http://localhost/api/check', {
        method: 'POST',
        headers: req.headers,
        body: Buffer.concat(parts)
      });
      return send(res, await handleCheck({ request, env: process.env }));
    }
    if (path === '/api' && req.method === 'GET')
      return send(res, json({ ok: true, endpoints: ['/api/health', '/api/check'] }));
    if (path.startsWith('/api/'))
      return send(res, json({ ok: false, error: 'Not found or unsupported method' }, 404));
    if ((req.method !== 'GET' && req.method !== 'HEAD') || (path !== '/' && path !== '/index.html')) {
      res.writeHead(404, { 'cache-control': 'no-store' });
      return res.end('Not found');
    }
    // Never serve private files, .env, OAuth secrets, or source code.
    const body = await readFile(join(ROOT, 'public', 'index.html'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (_error) {
    return send(res, json({ ok: false, error: 'Unexpected server error' }, 500));
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createServer(respond).listen(Number(process.env.PORT || 3000), '0.0.0.0', () =>
    console.log('BP Duplicate Checker Node service ready'));
  // Dual mode: load the committed BP generation into RAM at boot and follow
  // CONTROL in the background, so /api/check never waits on Google Sheets.
  if (String(process.env.GSHEET_SNAPSHOT_MODE || '').toLowerCase() === 'dual' &&
      snapshotEngine(process.env) === 'memory' && process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    import('./_lib/memory-engine.js')
      .then(memory => memory.startSnapshotRefresher(process.env))
      .catch(error => console.error('[memory-engine] refresher failed to start:', error?.message));
  }
}
