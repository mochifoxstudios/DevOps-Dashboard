import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3766;
const GH_PORT = 3767;
const BASE = 'http://localhost:' + AGENT_PORT;

let nextIssue = 100;
let mode = 'ok';   // ok | 401 | 429
const gh = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    if (mode === '401') { res.writeHead(401); res.end('{}'); return; }
    if (mode === '429') { res.writeHead(429); res.end('{}'); return; }
    if (req.url.startsWith('/repos/') && req.url.endsWith('/issues') && req.method === 'POST') {
      const num = nextIssue++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ number: num, html_url: 'https://github.com/acme/test/issues/' + num }));
    } else { res.writeHead(404); res.end(); }
  });
}).listen(GH_PORT);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-smoke-'));
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.github-queue.json')); } catch {}

const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false',
  GITHUB_ENDPOINT: 'http://localhost:' + GH_PORT
});
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let alog = ''; agent.stdout.on('data', (d) => alog += d); agent.stderr.on('data', (d) => alog += d);
agent.on('exit', (code) => { if (code) console.log('[agent exited]', code, '\n' + alog); });

async function get(p) { return (await fetch(BASE + p)).json(); }
async function post(p, body) { return await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

// Set the PAT
const ptResp = await post('/api/github/pat', { token: 'ghp_stub' });
console.log('pat set status:', ptResp.status);

// Create a draft via watchdog
await post('/api/agent/settings', { watchedLogPaths: ['x.log'], errorPatterns: ['FATAL'] });
fs.writeFileSync(path.join(ws, 'x.log'), '');
await waitFor(async () => {
  const s = await get('/api/agent/status');
  return s.sentinels.find((x) => x.name === 'log-watchdog').state === 'watching';
}, 4000, 'watchdog');
await new Promise((r) => setTimeout(r, 400));
fs.appendFileSync(path.join(ws, 'x.log'), 'FATAL test error\n');
await waitFor(async () => (await get('/api/agent/drafts')).count >= 1, 3000, 'draft created');
const draft = (await get('/api/agent/drafts')).drafts[0];

// File it (ok mode)
mode = 'ok';
const fileResp = await post('/api/github/file-issue', {
  owner: 'acme', repo: 'test', title: draft.title || draft.name, body: draft.content, labels: ['bug'], draftId: draft.id
});
const fileBody = await fileResp.json();
console.log('filed:', fileBody);
if (!fileBody.url) throw new Error('expected url in response');

const drafts2 = await get('/api/agent/drafts');
const d2 = drafts2.drafts.find((x) => x.id === draft.id);
if (!d2.filedAs || d2.filedAs.provider !== 'github') throw new Error('filedAs not set on draft');

// Test the queue: force 429, expect 202 + queue entry
mode = '429';
const queueResp = await post('/api/github/file-issue', {
  owner: 'acme', repo: 'test', title: 'will queue', body: 'body', labels: [], draftId: 'queued-draft-id'
});
console.log('queue status:', queueResp.status);
if (queueResp.status !== 202) throw new Error('expected 202 for rate-limited');

const q = await get('/api/github/queue');
console.log('queue:', q.queue.length, 'entries');
if (q.queue.length !== 1) throw new Error('expected 1 queued entry');

// Audit log records
const audit = await get('/api/agent/audit');
const ghRecs = audit.records.filter((r) => r.kind === 'github-file');
console.log('github audit records:', ghRecs.length, '· outcomes:', ghRecs.map((r) => r.outcome).join(','));
if (ghRecs.length < 2) throw new Error('expected at least 2 github audit records');

agent.kill('SIGINT'); gh.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== github smoke: PASSED ===');
process.exit(0);
