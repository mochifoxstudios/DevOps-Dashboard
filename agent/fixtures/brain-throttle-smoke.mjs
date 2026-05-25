/* ResourceThrottle smoke test.
   Strategy:
     - Boot the agent with BRAIN_THROTTLE_SAMPLE_MS=300 (fast sampling for the
       test) so we don't wait 15 s for the default 3-sample breach threshold.
     - Initially: throttled=false.
     - Set cpuCeiling = 0.01% so even idle CPU exceeds it. After 3 samples
       (~1 s) the brain should flip to throttled=true and emit a `throttle`
       event with active=true.
     - Verify LogWatchdog respects the flag: write a FATAL line to a watched
       file → no draft should appear (throttled).
     - Set cpuCeiling = 99% → flips back to throttled=false within a couple of
       samples (hysteresis). FATAL on a NEW line should then produce a draft. */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const PORT = 3746;
const BASE = 'http://localhost:' + PORT;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-throttle-'));
const logFile = path.join(ws, 'app.log');
fs.writeFileSync(logFile, 'startup\n');
console.log('workspace:', ws);

const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: ws,
  PORT: String(PORT),
  REGISTRY_LOOKUP_ENABLED: 'false',
  BRAIN_THROTTLE_SAMPLE_MS: '300'   // fast sampling for the test
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out: ' + label);
}

await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

// ---- 1. Sentinel registered, initial throttled=false ----
const s0 = await get('/api/agent/status');
const rt = s0.sentinels.find((x) => x.name === 'resource-throttle');
console.log('initial throttle sentinel:', rt);
if (rt.state !== 'sampling') throw new Error(`expected throttle state=sampling, got ${rt.state}`);
if (s0.throttled !== false)  throw new Error('expected throttled=false at start');

// Wait one sample so cpuPercent updates from 0
await waitFor(async () => (await get('/api/agent/status')).cpuPercent !== undefined, 2000, 'first cpu sample');

// ---- 2. Configure: watch the log file, ridiculously low CPU ceiling ----
await post('/api/agent/settings', {
  watchedLogPaths: ['app.log'],
  errorPatterns:   ['FATAL'],
  cpuCeiling:      0     // ANY non-zero CPU usage exceeds this → throttled
});
await waitFor(async () => {
  const s = await get('/api/agent/status');
  const w = s.sentinels.find((x) => x.name === 'log-watchdog');
  return w.state === 'watching';
}, 4000, 'watchdog watching');
await new Promise((r) => setTimeout(r, 400));

// Generate steady agent-side CPU by hammering the status endpoint while we
// wait. Without this the agent can sample 0% CPU for several windows in a row
// on a quiet machine, and never breach even a 0% ceiling.
let stopHammer = false;
const hammer = (async () => {
  while (!stopHammer) {
    try { await Promise.all([get('/api/agent/status'), get('/api/agent/events?limit=1')]); } catch (_) {}
  }
})();

// ---- 3. Wait for throttled to flip true (3 samples × 300 ms + slack) ----
await waitFor(async () => (await get('/api/agent/status')).throttled === true, 8000, 'throttled to flip true');
stopHammer = true;
await hammer;
const s1 = await get('/api/agent/status');
console.log('after low ceiling: throttled =', s1.throttled, '· cpu =', s1.cpuPercent + '%' + ' · ceiling =', s1.settings.cpuCeiling + '%');

const evts1 = await get('/api/agent/events?limit=200');
const throttleOn = evts1.events.find((e) => e.source === 'resource-throttle' && /throttling/.test(e.message));
console.log('throttle-on event:', !!throttleOn, '·', throttleOn && throttleOn.message);
if (!throttleOn) throw new Error('expected a throttle-on log entry');

// ---- 4. While throttled: FATAL line should NOT produce a draft ----
const draftsBefore = (await get('/api/agent/drafts')).count;
fs.appendFileSync(logFile, '2026-05-16T11:00:00Z FATAL Throttled-time error · should not pin\n');
await new Promise((r) => setTimeout(r, 1000));
const draftsAfter = (await get('/api/agent/drafts')).count;
if (draftsAfter !== draftsBefore) {
  throw new Error(`throttle did not suppress watchdog pinning: ${draftsBefore} → ${draftsAfter}`);
}
console.log('throttled · FATAL did not pin (drafts:', draftsBefore + ') ✓');

// ---- 5. Raise ceiling → throttled flips back to false ----
// Stop hammering so the next sample window has near-zero CPU; with hysteresis
// at 80% × 99% = 79.2%, even normal HTTP traffic falls below that.
await post('/api/agent/settings', { cpuCeiling: 99 });
await waitFor(async () => (await get('/api/agent/status')).throttled === false, 6000, 'throttled to clear');
const s2 = await get('/api/agent/status');
console.log('after high ceiling: throttled =', s2.throttled, '· cpu =', s2.cpuPercent + '%');

// ---- 6. Now a FATAL should pin again ----
fs.appendFileSync(logFile, '2026-05-16T11:00:05Z FATAL Resumed error · should pin now\n');
await waitFor(async () => (await get('/api/agent/drafts')).count > draftsAfter, 4000, 'draft after resume');
const draftsFinal = (await get('/api/agent/drafts')).count;
console.log('un-throttled · FATAL pinned again ✓ · drafts:', draftsFinal);

agent.kill('SIGINT');
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
console.log('\n=== ResourceThrottle: ALL CHECKS PASSED ===');
process.exit(0);
