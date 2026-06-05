/* Manifest-change watcher smoke test.
   1. Boot the agent against a temp workspace with a package.json.
   2. Verify the manifest-sentinel registered and is watching package.json.
   3. Modify package.json → expect a scan with trigger 'manifest-change' to appear
      in /api/agent/scans (the sentinel debounces and calls the Scheduler's scan).
   Run: node fixtures/brain-manifest-smoke.mjs */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const PORT = 3747;
const BASE = 'http://localhost:' + PORT;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-manifest-'));
fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'manifest-smoke', version: '0.0.1', dependencies: { lodash: '1.0.0' } }, null, 2));
console.log('workspace:', ws);

const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: ws, PORT: String(PORT),
  AGENT_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-state-')),
  REGISTRY_LOOKUP_ENABLED: 'true'
});

const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let agentLog = '';
agent.stdout.on('data', (d) => { agentLog += d.toString(); });
agent.stderr.on('data', (d) => { agentLog += d.toString(); });
agent.on('exit', (code) => { if (code) console.log('[agent exited]', code, '\n' + agentLog); });

async function get(p) { return (await fetch(BASE + p)).json(); }
async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Timed out: ' + label);
}

let code = 0;
try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

  // 1. manifest-sentinel watching package.json
  await waitFor(async () => {
    const s = await get('/api/agent/status');
    const ms = s.sentinels.find((x) => x.name === 'manifest-sentinel');
    return ms && ms.state === 'watching';
  }, 8000, 'manifest-sentinel watching');
  const st = await get('/api/agent/status');
  const ms = st.sentinels.find((x) => x.name === 'manifest-sentinel');
  console.log('manifest-sentinel:', ms.state, '·', JSON.stringify(ms.info));
  if (ms.info.watching !== 'package.json') throw new Error('expected to watch package.json, got ' + ms.info.watching);

  // 2. modify the manifest → expect a manifest-change scan
  console.log('modifying package.json…');
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'manifest-smoke', version: '0.0.1', dependencies: { lodash: '1.0.0', express: '1.0.0' } }, null, 2));

  await waitFor(async () => {
    const sc = await get('/api/agent/scans');
    return sc.scans.some((s) => s.trigger === 'manifest-change');
  }, 20000, 'manifest-change scan');

  const sc = await get('/api/agent/scans');
  const scan = sc.scans.find((s) => s.trigger === 'manifest-change');
  console.log('scan trigger:', scan.trigger, '· manifest:', scan.depMap && scan.depMap.manifest, '· outdated:', scan.depMap && scan.depMap.outdatedCount);
  if (!scan.depMap || scan.depMap.manifest !== 'package.json') throw new Error('manifest-change scan missing depMap/manifest');

  console.log('\n=== ManifestSentinel: ALL CHECKS PASSED ===');
} catch (e) {
  code = 1;
  console.error('ManifestSentinel: FAIL —', e.message);
} finally {
  agent.kill('SIGINT');
  await new Promise((r) => setTimeout(r, 600));
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}
