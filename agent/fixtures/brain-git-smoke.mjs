/* Brain + GitSentinel smoke test.
   Spins up a real git repo in a temp dir, starts a fresh agent pointed at it,
   switches branches, asserts that the auto-snapshot appears in
   /api/agent/snapshots and the activity log contains the switch event. */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const PORT = 3743;             // distinct from the regular 3737 so we don't collide
const BASE = 'http://localhost:' + PORT;

// ---- 1. Build a throwaway repo with two branches ----
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-smoke-'));
function git(...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
git('init', '-q', '--initial-branch=main');
git('config', 'user.email', 'smoke@local');
git('config', 'user.name',  'Smoke');
fs.writeFileSync(path.join(repo, 'README'), 'hello\n');
git('add', '.');
git('commit', '-q', '-m', 'initial');
git('branch', 'feature/foo');
console.log('repo at', repo, '— branches: main, feature/foo · currently on', git('rev-parse', '--abbrev-ref', 'HEAD'));

// ---- 2. Boot a fresh agent pointed at that repo ----
const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: repo,
  PORT: String(PORT),
  REGISTRY_LOOKUP_ENABLED: 'false',  // no internet needed for this smoke
  SCRAPER_ALLOWED_HOSTS: '',
  SCRAPER_ALLOW_ANY: 'false'
});
// Reset any prior brain-state so we don't inherit snapshots from previous runs.
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch (_) {}

const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let agentLog = '';
agent.stdout.on('data', (d) => { agentLog += d.toString(); });
agent.stderr.on('data', (d) => { agentLog += d.toString(); });
agent.on('exit', (code) => { if (code) console.log('[agent exited]', code, '\n' + agentLog); });

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timed out: ' + label);
}
async function get(p) {
  const r = await fetch(BASE + p);
  return r.json();
}

await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

// ---- 3. Initial state checks ----
const status1 = await get('/api/agent/status');
console.log('initial sentinels:', status1.sentinels);
if (status1.sentinels[0].name !== 'git-sentinel') throw new Error('GitSentinel not registered');
if (status1.sentinels[0].state !== 'watching') throw new Error('Expected sentinel state=watching, got ' + status1.sentinels[0].state);
if (status1.sentinels[0].info.branch !== 'main') throw new Error('Expected branch=main, got ' + status1.sentinels[0].info.branch);

const snaps1 = await get('/api/agent/snapshots');
if (snaps1.count !== 0) throw new Error('Expected 0 snapshots at start, got ' + snaps1.count);

// ---- 4. Switch branches and wait for the auto-snapshot ----
console.log('switching to feature/foo…');
git('checkout', '-q', 'feature/foo');

await waitFor(async () => {
  const s = await get('/api/agent/snapshots');
  return s.count >= 1;
}, 10000, 'auto-snapshot to appear');

const snaps2 = await get('/api/agent/snapshots');
const snap = snaps2.snapshots[0];
console.log('\n--- auto-snapshot ---');
console.log('name:    ', snap.name);
console.log('source:  ', snap.source);
console.log('reason:  ', snap.reason);
console.log('from→to: ', snap.meta);
console.log('branch:  ', snap.branch);
console.log('git.sha: ', snap.capture.git && snap.capture.git.sha);
console.log('env.count:', snap.capture.env && snap.capture.env.count);

// ---- 5. Activity log should record the switch + capture ----
const evts = await get('/api/agent/events?limit=200');
const branchSwitchEvts = evts.events.filter((e) => /Branch switch/.test(e.message));
const captureEvts = evts.events.filter((e) => /Auto-snapshot captured/.test(e.message));
console.log('\nbranch-switch events:', branchSwitchEvts.length);
console.log('capture events:     ', captureEvts.length);
if (!branchSwitchEvts.length) throw new Error('No branch-switch event recorded');
if (!captureEvts.length)      throw new Error('No capture event recorded');

// ---- 6. Settings toggle off — second switch should NOT produce a snapshot ----
console.log('\ndisabling gitSentinel via /api/agent/settings…');
await fetch(BASE + '/api/agent/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ gitSentinel: false })
});
git('checkout', '-q', 'main');
await new Promise((r) => setTimeout(r, 2500));
const snaps3 = await get('/api/agent/snapshots');
if (snaps3.count !== snaps2.count) {
  throw new Error(`Expected snapshot count unchanged (${snaps2.count}), got ${snaps3.count}`);
}
console.log('after disable, snapshot count still', snaps3.count, '✓ (no new snapshot when toggle is off)');

// ---- 7. Re-enable + flip back — should fire ----
await fetch(BASE + '/api/agent/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ gitSentinel: true })
});
git('checkout', '-q', 'feature/foo');
await waitFor(async () => (await get('/api/agent/snapshots')).count > snaps2.count, 6000, 're-enabled snapshot');
const snaps4 = await get('/api/agent/snapshots');
console.log('after re-enable + switch, snapshot count =', snaps4.count, '✓ (fired again)');

// ---- 8. Clean teardown ----
agent.kill('SIGINT');
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
console.log('\n=== ALL CHECKS PASSED ===');
process.exit(0);
