// Exercise the exact Render start command, not just JavaScript syntax.
// This test does not need Google credentials; /api/health may return 500 in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function poll(url, child, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error('yarn start exited before HTTP readiness');
    try {
      return await fetch(url, { signal: AbortSignal.timeout(1500) });
    } catch (_) {
      await new Promise(r => setTimeout(r, 120));
    }
  }
  throw Error('yarn start did not listen on PORT in time');
}

test('Render yarn start boots, serves frontend and API without leaking private files', async () => {
  const port = await availablePort();
  const cmd = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
  const child = spawn(cmd, ['start'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  try {
    const root = await poll('http://127.0.0.1:' + port + '/', child);
    assert.equal(root.status, 200, output);
    const html = await root.text();
    assert.match(html, /EXPECTED_ENGINE_VERSION = '2026-09-23-gsheet-dual-v12'/);
    assert.match(html, /FULL_SCOPE_WAIT_MS = 200/);
    assert.match(html, /MAX_NORMAL_QUOTA_RETRIES = 1/);
    assert.match(html, /FULL_SCOPE_SESSION_MS = 175000/);
    assert.match(html, /Normal check not completed\. Retrying the same input in/);
    assert.match(html, /if \(res\.status !== 429\)/);
    const health = await fetch('http://127.0.0.1:' + port + '/api/health');
    const body = await health.json();
    assert.equal(body.engine_version, '2026-09-23-gsheet-dual-v12');
    assert.equal(body.ok, false, 'CI must not have production OAuth credentials');
    const privateFile = await fetch('http://127.0.0.1:' + port + '/.env');
    assert.equal(privateFile.status, 404);
    const info = await fetch('http://127.0.0.1:' + port + '/api');
    assert.equal(info.status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
});
