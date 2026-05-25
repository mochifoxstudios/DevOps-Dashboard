import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3768;
const STUB_LLM = 3769;
const STUB_GH  = 3770;
const BASE = 'http://localhost:' + AGENT_PORT;

const llmStub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub', eval_count: 50, prompt_eval_count: 200,
      message: { content: JSON.stringify({
        summary: 'Connection lost', likely_cause: 'Network blip during deploy.',
        confidence: 'high', next_steps: ['retry', 'check uptime', 'review CDN'],
        related_signals: []
      }) }
    }));
  });
}).listen(STUB_LLM);

let issueNum = 500;
const ghStub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url.endsWith('/issues') && req.method === 'POST') {
      const n = issueNum++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ number: n, html_url: 'https://github.com/acme/test/issues/' + n }));
    } else { res.writeHead(404); res.end(); }
  });
}).listen(STUB_GH);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-smoke-'));
const log = path.join(ws, 'app.log'); fs.writeFileSync(log, '');
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.github-queue.json')); } catch {}

const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false',
  GITHUB_ENDPOINT: 'http://localhost:' + STUB_GH
});
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let alog = ''; agent.stdout.on('data', (d) => alog += d); agent.stderr.on('data', (d) => alog += d);
agent.on('exit', (code) => { if (code) console.log('[agent exited]', code, '\n' + alog); });

async function get(p) { return (await fetch(BASE + p)).json(); }
async function post(p, body) { return (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json(); }
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

await post('/api/github/pat', { token: 'ghp_stub' });
await post('/api/agent/settings', {
  watchedLogPaths: ['app.log'], errorPatterns: ['FATAL'],
  aiEnrichDrafts: true, autoFileGitHub: true,
  defaultRepoOwner: 'acme', defaultRepoName: 'test',
  llmProvider: 'ollama', llmModel: 'stub', llmEndpoint: 'http://localhost:' + STUB_LLM
});
await waitFor(async () => {
  const s = await get('/api/agent/status');
  return s.sentinels.find((x) => x.name === 'log-watchdog').state === 'watching';
}, 4000, 'watchdog');
await new Promise((r) => setTimeout(r, 400));

fs.appendFileSync(log, '2026-05-17T11:00:00Z FATAL connection lost\n');

// Wait for: bare draft → enriched → filed
await waitFor(async () => {
  const ds = await get('/api/agent/drafts');
  if (!ds.drafts.length) return false;
  return ds.drafts[0].enriched && ds.drafts[0].filedAs && ds.drafts[0].filedAs.provider === 'github';
}, 15000, 'full closed loop');

const finalDraft = (await get('/api/agent/drafts')).drafts[0];
console.log('final draft enriched:', finalDraft.enriched, '· confidence:', finalDraft.confidence, '· filedAs:', finalDraft.filedAs);

const audit = await get('/api/agent/audit');
const llmRec = audit.records.find((r) => r.kind === 'llm-call');
const ghRec  = audit.records.find((r) => r.kind === 'github-file');
console.log('llm audit record:', !!llmRec, '· github audit record:', !!ghRec);
if (!llmRec || !ghRec) throw new Error('missing audit records');

const ver = await get('/api/agent/audit/verify');
console.log('chain verifies:', ver.ok);
if (!ver.ok) throw new Error('audit chain broken');

agent.kill('SIGINT'); llmStub.close(); ghStub.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== brain-loop e2e: PASSED ===');
process.exit(0);
