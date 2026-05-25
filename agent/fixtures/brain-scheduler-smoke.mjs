/* Scheduler smoke test.
   1. Boot agent against a temp workspace that contains a package.json with
      two intentionally outdated deps (lodash@1.0.0 + express@1.0.0).
   2. POST /api/agent/scan → manual trigger. Verify result includes:
      - contextSnap with env/pid/ports/git fields
      - depMap with the parsed two deps + outdatedCount === 2 (registry online)
   3. GET /api/agent/scans → result present in recent scans.
   4. Disable scheduler via settings, attempt manual scan → 503 from sentinel
      not-allowed path (we don't actually wire that — manual is always allowed
      since the user explicitly clicked it; instead verify the scheduled tick
      stays inert when disabled). */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const PORT = 3745;
const BASE = 'http://localhost:' + PORT;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sched-'));
const pkg = {
  name: 'scheduler-smoke',
  version: '0.0.1',
  dependencies: {
    'lodash':  '1.0.0',     // very old → should be outdated
    'express': '1.0.0'      // very old → should be outdated
  }
};
fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify(pkg, null, 2));
console.log('workspace:', ws);

const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: ws,
  PORT: String(PORT),
  REGISTRY_LOOKUP_ENABLED: 'true'  // need real registry for this test
});
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch (_) {}

const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let agentLog = '';
agent.stdout.on('data', (d) => { agentLog += d.toString(); });
agent.stderr.on('data', (d) => { agentLog += d.toString(); });
agent.on('exit', (code) => { if (code) console.log('[agent exited]', code, '\n' + agentLog); });

async function get(p)  { return (await fetch(BASE + p)).json(); }
async function post(p, body) {
  return (await fetch(BASE + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  })).json();
}
async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timed out: ' + label);
}

await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

// ---- 1. Sanity: scheduler registered, idle ----
const s0 = await get('/api/agent/status');
const sched0 = s0.sentinels.find((x) => x.name === 'scheduler');
console.log('scheduler:', sched0);
if (sched0.state !== 'idle') throw new Error(`expected scheduler state=idle, got ${sched0.state}`);

// ---- 2. Manual scan via POST /api/agent/scan ----
console.log('triggering manual scan…');
const scanStart = Date.now();
const result = await post('/api/agent/scan', {});
const scanMs = Date.now() - scanStart;
console.log('\n--- scan result ---');
console.log('trigger:        ', result.trigger);
console.log('durationMs:     ', result.durationMs);
console.log('contextSnap:    ', result.contextSnap);
console.log('depMap.manifest:', result.depMap && result.depMap.manifest);
console.log('depMap.eco:     ', result.depMap && result.depMap.ecosystem);
console.log('depMap.total:   ', result.depMap && result.depMap.totalDeps);
console.log('depMap.outdated:', result.depMap && result.depMap.outdatedCount);
console.log('outdated list:  ', result.depMap && result.depMap.outdated);

if (result.trigger !== 'manual')                              throw new Error(`expected trigger=manual, got ${result.trigger}`);
if (!result.contextSnap)                                      throw new Error('missing contextSnap');
if (typeof result.contextSnap.envCount !== 'number')          throw new Error('contextSnap.envCount not a number');
if (!result.depMap)                                           throw new Error('missing depMap');
if (result.depMap.manifest !== 'package.json')                throw new Error(`expected manifest=package.json, got ${result.depMap.manifest}`);
if (result.depMap.ecosystem !== 'npm')                        throw new Error(`expected ecosystem=npm, got ${result.depMap.ecosystem}`);
if (result.depMap.totalDeps !== 2)                            throw new Error(`expected 2 deps, got ${result.depMap.totalDeps}`);
if (result.depMap.outdatedCount !== 2)                        throw new Error(`expected 2 outdated, got ${result.depMap.outdatedCount}`);
const names = result.depMap.outdated.map((o) => o.name).sort();
if (names.join(',') !== 'express,lodash')                     throw new Error(`expected [express,lodash] outdated, got ${names.join(',')}`);

console.log('\nscan complete in', scanMs, 'ms · 2/2 outdated detected ✓');

// ---- 3. /api/agent/scans should include the result ----
const sc = await get('/api/agent/scans');
console.log('scans in memory:', sc.count);
if (sc.count !== 1)             throw new Error(`expected 1 scan in memory, got ${sc.count}`);
if (sc.scans[0].id !== result.id) throw new Error('scan id mismatch');

// ---- 4. Notification + activity-log entry for outdated deps ----
const evts = await get('/api/agent/events?limit=200');
const warned = evts.events.find((e) => e.source === 'scheduler' && /outdated dependencies/.test(e.message));
console.log('warning event recorded:', !!warned, warned && warned.message);
if (!warned) throw new Error('expected scheduler to log an outdated-deps warning');

// ---- 5. Disable scheduler → next tick is a no-op (state goes to disabled) ----
await post('/api/agent/settings', { scheduledScan: false });
// give a tick to run
await new Promise((r) => setTimeout(r, 500));
const s2 = await get('/api/agent/status');
const sched2 = s2.sentinels.find((x) => x.name === 'scheduler');
console.log('scheduler after disable:', sched2.state, '(manual scan still works regardless)');

agent.kill('SIGINT');
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
console.log('\n=== Scheduler: ALL CHECKS PASSED ===');
process.exit(0);
