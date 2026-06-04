// Boots the agent on 127.0.0.1:3748 against a temp workspace and checks that
// CORS allows localhost origins but denies remote ones. Run from agent/:
//   node fixtures/bind-cors-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const ws = mkdtempSync(join(tmpdir(), 'bindcors-'));
const PORT = 3748;
const agent = spawn(process.execPath, [resolve('server.js')], {
  cwd: resolve('.'),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WORKSPACE_ROOT: ws },
  stdio: 'inherit'
});

const base = `http://127.0.0.1:${PORT}`;
async function waitHealth(n = 50) {
  for (let i = 0; i < n; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('agent did not start');
}

let code = 0;
try {
  await waitHealth();

  const evil = await fetch(base + '/api/health', { headers: { Origin: 'http://evil.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'remote origin must not be allowed');

  const local = await fetch(base + '/api/health', { headers: { Origin: 'http://localhost:8765' } });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:8765', 'localhost origin must be allowed');

  console.log('bind-cors-smoke: PASS');
} catch (e) {
  code = 1;
  console.error('bind-cors-smoke: FAIL —', e.message);
} finally {
  agent.kill('SIGINT');
  setTimeout(() => process.exit(code), 300);
}
