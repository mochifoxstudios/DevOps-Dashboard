/* LogWatchdog smoke test.
   1. Boot a fresh agent against a temp workspace.
   2. Create a log file inside the workspace.
   3. POST /api/agent/settings to add it to watchedLogPaths.
   4. Append a benign line → no draft.
   5. Append a FATAL line → draft appears in /api/agent/drafts, contains
      preceding 20 lines as Context, error line as Observed.
   6. Append a second FATAL within the cooldown → no second draft.
   7. POST settings to disable watchdog → next FATAL produces no draft. */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const PORT = 3744;
const BASE = 'http://localhost:' + PORT;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-logwatch-'));
const logFile = path.join(ws, 'app.log');
fs.writeFileSync(logFile, '');

console.log('workspace:', ws);
console.log('log file: ', logFile);

const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: ws,
  PORT: String(PORT),
  REGISTRY_LOOKUP_ENABLED: 'false',
  SCRAPER_ALLOWED_HOSTS: '',
  SCRAPER_ALLOW_ANY: 'false'
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

// ---- 1. Initial: watchdog idle (no paths configured) ----
const s0 = await get('/api/agent/status');
const wd0 = s0.sentinels.find((x) => x.name === 'log-watchdog');
console.log('initial watchdog:', wd0);
if (wd0.state !== 'idle') throw new Error(`expected watchdog state=idle, got ${wd0.state}`);

// ---- 2. Configure watched path + a custom pattern ----
await post('/api/agent/settings', {
  watchedLogPaths: ['app.log'],
  errorPatterns:   ['FATAL', '\\bpanic\\b', 'CRITICAL']
});
await waitFor(async () => {
  const s = await get('/api/agent/status');
  const w = s.sentinels.find((x) => x.name === 'log-watchdog');
  return w.state === 'watching' && (w.info.watching || []).length === 1;
}, 4000, 'watchdog to start watching app.log');

const s1 = await get('/api/agent/status');
const wd1 = s1.sentinels.find((x) => x.name === 'log-watchdog');
console.log('after configure:', wd1);

// Give the LogStream's chokidar a moment to anchor on the file's end-offset.
await new Promise((r) => setTimeout(r, 600));

// ---- 3. Write benign lines → no draft ----
fs.appendFileSync(logFile, [
  '2026-05-16T10:00:00Z INFO Server starting',
  '2026-05-16T10:00:01Z INFO Connected to postgres',
  '2026-05-16T10:00:02Z INFO Listening on :3000',
  '2026-05-16T10:00:03Z DEBUG Cache warm-up',
  '2026-05-16T10:00:04Z INFO Ready'
].join('\n') + '\n');
await new Promise((r) => setTimeout(r, 800));

const d1 = await get('/api/agent/drafts');
if (d1.count !== 0) throw new Error('benign lines should not have produced a draft; got ' + d1.count);
console.log('benign lines · no drafts ✓');

// ---- 4. Append a FATAL line → draft appears ----
fs.appendFileSync(logFile, '2026-05-16T10:00:05Z FATAL Database connection lost · postgres handshake failed\n');

await waitFor(async () => (await get('/api/agent/drafts')).count >= 1, 4000, 'draft after FATAL');
const d2 = await get('/api/agent/drafts');
const draft = d2.drafts[0];
console.log('\n--- draft ---');
console.log('name:    ', draft.name);
console.log('title:   ', draft.title);
console.log('source:  ', draft.source);
console.log('reason:  ', draft.reason);
console.log('meta:    ', draft.meta);
console.log('content lines:', draft.content.split('\n').length);

if (!draft.content.includes('Database connection lost')) throw new Error('draft missing the matching line');
if (!draft.content.includes('Listening on :3000'))       throw new Error('draft missing context lines');
if (!draft.content.includes('## Context'))               throw new Error('draft missing Context section');
if (draft.meta.pattern !== 'FATAL')                      throw new Error(`expected pattern=FATAL, got ${draft.meta.pattern}`);
if (draft.meta.filePath !== 'app.log')                   throw new Error(`expected filePath=app.log, got ${draft.meta.filePath}`);

// ---- 5. Cooldown: second FATAL within 60s shouldn't create another draft ----
fs.appendFileSync(logFile, '2026-05-16T10:00:06Z FATAL Database connection still lost\n');
await new Promise((r) => setTimeout(r, 800));
const d3 = await get('/api/agent/drafts');
if (d3.count !== 1) throw new Error(`cooldown failed — got ${d3.count} drafts, expected 1`);
console.log('cooldown · second FATAL suppressed ✓');

// ---- 6. A different pattern should still fire (independent cooldown) ----
fs.appendFileSync(logFile, '2026-05-16T10:00:07Z CRITICAL Disk full on /var/log\n');
await waitFor(async () => (await get('/api/agent/drafts')).count >= 2, 4000, 'second draft from different pattern');
const d4 = await get('/api/agent/drafts');
console.log('CRITICAL → second draft fired (independent cooldown) ✓ · total drafts:', d4.count);
if (d4.drafts[0].meta.pattern !== 'CRITICAL') throw new Error('expected newest draft pattern=CRITICAL');

// ---- 7. Disable the watchdog ----
await post('/api/agent/settings', { logWatchdog: false });
await waitFor(async () => {
  const s = await get('/api/agent/status');
  const w = s.sentinels.find((x) => x.name === 'log-watchdog');
  return (w.info.watching || []).length === 0;
}, 4000, 'watchdog to stop watching');

fs.appendFileSync(logFile, '2026-05-16T10:00:08Z panic in user-service\n');
await new Promise((r) => setTimeout(r, 800));
const d5 = await get('/api/agent/drafts');
if (d5.count !== d4.count) throw new Error(`disabled watchdog still fired — ${d5.count} drafts, expected ${d4.count}`);
console.log('disabled watchdog · no new draft ✓');

agent.kill('SIGINT');
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
console.log('\n=== LogWatchdog: ALL CHECKS PASSED ===');
process.exit(0);
