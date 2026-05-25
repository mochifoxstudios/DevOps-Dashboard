/* End-to-end smoke test for js/brain-client.js.
   Boots an agent against a real git workspace, then drives brain-client.js
   directly inside a Node host that polyfills the browser bits it depends on
   (window, document, fetch, EventSource, localStorage, performance APIs).

   Asserts:
     1. brain-client.detect() flips D.brain.online = true
     2. syncBacklog() pulls 0 snapshots/drafts initially
     3. After git checkout, the SSE 'snapshot' event arrives, mergeOneSnapshot
        adds it to localStorage["devops:snapshots"]
     4. After appending FATAL to a watched log, an SSE 'draft' event arrives,
        mergeOneDraft adds it to localStorage["devops:issue-drafts"]
     5. pushSettings({ gitSentinel: false }) round-trips and the brain's
        status reflects it. */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const FRONTEND_DIR = path.resolve(AGENT_DIR, '..');
const PORT = 3747;
const BASE = 'http://localhost:' + PORT;

// ---- 1. Throwaway git repo + log file ----
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-client-'));
function git(...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.stderr}`);
  return r.stdout.trim();
}
git('init', '-q', '--initial-branch=main');
git('config', 'user.email', 'smoke@local');
git('config', 'user.name',  'Smoke');
fs.writeFileSync(path.join(repo, 'README'), 'hi\n');
git('add', '.'); git('commit', '-q', '-m', 'init');
git('branch', 'feature/x');
const logFile = path.join(repo, 'app.log');
fs.writeFileSync(logFile, '');

// ---- 2. Boot the agent ----
const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: repo,
  PORT: String(PORT),
  REGISTRY_LOOKUP_ENABLED: 'false'
});
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
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('Timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

// ---- 3. Browser-bit polyfills for brain-client.js ----
const localStorageBacking = new Map();
globalThis.localStorage = {
  getItem(k)   { return localStorageBacking.has(k) ? localStorageBacking.get(k) : null; },
  setItem(k,v) { localStorageBacking.set(k, String(v)); },
  removeItem(k){ localStorageBacking.delete(k); },
  get length() { return localStorageBacking.size; },
  key(i)       { return Array.from(localStorageBacking.keys())[i]; }
};
globalThis.document = {
  readyState: 'complete',
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { addEventListener() {}, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; }, style: {}, classList: { add(){}, remove(){}, toggle(){}, contains() { return false; } } }; }
};
globalThis.window = globalThis;
globalThis.location = { hash: '', href: BASE + '/' };
globalThis.CustomEvent = class { constructor(t, o){ this.type = t; this.detail = o && o.detail; } };
// EventSource polyfill — Node 22+ has native, older needs shim. Try native, fall back.
if (typeof EventSource === 'undefined') {
  const { EventSource: ES } = await import('eventsource').catch(() => ({}));
  if (ES) globalThis.EventSource = ES;
  else {
    // Minimal manual EventSource using fetch streaming
    globalThis.EventSource = class {
      constructor(url) {
        this.url = url; this.listeners = new Map(); this._closed = false;
        this._start();
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      close() { this._closed = true; if (this._reader) try { this._reader.cancel(); } catch(_){} }
      async _start() {
        try {
          const res = await fetch(this.url);
          this._reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (!this._closed) {
            const { value, done } = await this._reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
              const ev = {};
              chunk.split('\n').forEach((line) => {
                if (line.startsWith('event:')) ev.type = line.slice(6).trim();
                else if (line.startsWith('data:')) ev.data = (ev.data || '') + line.slice(5).trim();
              });
              if (ev.type && this.listeners.has(ev.type)) {
                for (const fn of this.listeners.get(ev.type)) { try { fn(ev); } catch(_){} }
              }
            }
          }
        } catch (e) { if (this.onerror) try { this.onerror(e); } catch(_){} }
      }
      set onerror(fn) { this._onerror = fn; }
      get onerror() { return this._onerror; }
    };
  }
}

// ---- 4. Boot up the frontend stack the way the browser would ----
// We need core.js (for window.DevOps + D.store) and agent-client.js (for
// D.agent + .online + .base) and brain-client.js. The other frontend modules
// touch the DOM heavily so we skip them.
const FRONTEND_JS = path.resolve(FRONTEND_DIR, 'js');
const evalFile = (rel) => {
  const code = fs.readFileSync(path.join(FRONTEND_JS, rel), 'utf8');
  // Wrap in a function so 'this' is window, eval directly
  new Function('window', 'document', 'localStorage', 'fetch', 'EventSource', 'CustomEvent', code)
    (globalThis, globalThis.document, globalThis.localStorage, fetch, globalThis.EventSource, globalThis.CustomEvent);
};
evalFile('core.js');
// agent-client expects fetch + window.DevOps. Point its base at our agent port.
evalFile('agent-client.js');
window.DevOps.agent.setBase(BASE);

evalFile('brain-client.js');
const D = window.DevOps;

console.log('initial: D.agent =', typeof D.agent, '· D.brain =', typeof D.brain);

// ---- 5. Detect agent + brain ----
await D.agent.detect();
console.log('agent.online:', D.agent.online, '· version:', D.agent.info && D.agent.info.version);
if (!D.agent.online) throw new Error('agent-client.detect failed');

await D.brain.detect();
console.log('brain.online:', D.brain.online, '· sentinels:', D.brain.status.sentinels.map(s => s.name + ':' + s.state).join(', '));
if (!D.brain.online) throw new Error('brain.detect failed');

// ---- 6. syncBacklog initial ----
const initialSync = await D.brain.syncBacklog();
console.log('initial syncBacklog:', initialSync);
if (initialSync.snapshots !== 0) throw new Error('expected 0 initial snapshots');
if (initialSync.drafts !== 0)    throw new Error('expected 0 initial drafts');

// ---- 7. Open the SSE stream ----
D.brain.openStream();
await new Promise((r) => setTimeout(r, 300));

// ---- 8. Trigger a brain snapshot via git checkout ----
console.log('\nswitching git branch to trigger snapshot…');
git('checkout', '-q', 'feature/x');
await waitFor(() => (D.store.get('devops:snapshots', []).length >= 1), 8000, 'snapshot to land in localStorage via SSE');
const localSnaps = D.store.get('devops:snapshots', []);
console.log('snapshots in localStorage:', localSnaps.length, '· source:', localSnaps[0].source, '· name:', localSnaps[0].name);
if (localSnaps[0].source !== 'brain') throw new Error('expected source=brain on synced snapshot');
if (!localSnaps[0].name.startsWith('auto-branch-switch-')) throw new Error('expected auto-branch-switch name');

// ---- 9. Trigger a brain draft via watched log + FATAL ----
console.log('\nconfiguring LogWatchdog…');
await D.brain.pushSettings({ watchedLogPaths: ['app.log'], errorPatterns: ['FATAL'] });
await waitFor(async () => {
  await D.brain.refreshStatus();
  const w = D.brain.status.sentinels.find((s) => s.name === 'log-watchdog');
  return w && w.state === 'watching';
}, 4000, 'log-watchdog watching');
await new Promise((r) => setTimeout(r, 500));

fs.appendFileSync(logFile, '2026-05-16T11:00:00Z FATAL Database connection lost · postgres handshake failed\n');
await waitFor(() => (D.store.get('devops:issue-drafts', []).length >= 1), 6000, 'draft to land in localStorage via SSE');
const localDrafts = D.store.get('devops:issue-drafts', []);
console.log('drafts in localStorage:', localDrafts.length, '· source:', localDrafts[0].source, '· title:', localDrafts[0].title.slice(0, 60));
if (localDrafts[0].source !== 'brain') throw new Error('expected source=brain on synced draft');
if (!localDrafts[0].content.includes('FATAL'))   throw new Error('draft content missing FATAL');
if (!localDrafts[0].content.includes('Context')) throw new Error('draft content missing Context section');

// ---- 10. pushSettings round-trip ----
const settingsResp = await D.brain.pushSettings({ gitSentinel: false, cpuCeiling: 90 });
console.log('\nsettings round-trip:', { gitSentinel: settingsResp.settings.gitSentinel, cpuCeiling: settingsResp.settings.cpuCeiling });
if (settingsResp.settings.gitSentinel !== false) throw new Error('gitSentinel did not flip via pushSettings');
if (settingsResp.settings.cpuCeiling !== 90)    throw new Error('cpuCeiling did not update via pushSettings');

// ---- 11. Now confirm the brain respects the new toggle ----
console.log('switching back to main (gitSentinel disabled) …');
git('checkout', '-q', 'main');
await new Promise((r) => setTimeout(r, 2500));
const localSnapsAfter = D.store.get('devops:snapshots', []);
if (localSnapsAfter.length !== localSnaps.length) {
  throw new Error(`expected snapshot count unchanged (${localSnaps.length}); got ${localSnapsAfter.length}`);
}
console.log('no new snapshot fired ✓ · final count:', localSnapsAfter.length);

// ---- Teardown ----
D.brain.closeStream();
agent.kill('SIGINT');
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
console.log('\n=== brain-client end-to-end: ALL CHECKS PASSED ===');
process.exit(0);
