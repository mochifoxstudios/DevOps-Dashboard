import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3762;
const STUB_PORT = 3763;
const BASE = 'http://localhost:' + AGENT_PORT;

// Ollama stub that returns valid JSON enrichment
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub', eval_count: 50, prompt_eval_count: 200,
      message: { content: JSON.stringify({
        summary: 'Database connection lost',
        likely_cause: 'Postgres handshake failed after key rotation — credentials likely stale.',
        confidence: 'high',
        next_steps: ['Check DATABASE_URL', 'Restart pgbouncer', 'Verify password rotation'],
        related_signals: ['postgres', 'DATABASE_URL']
      }) }
    }));
  });
}).listen(STUB_PORT);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-smoke-'));
const log = path.join(ws, 'app.log');
fs.writeFileSync(log, '');

try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch {}

const env = Object.assign({}, process.env, { WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false' });
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let alog = ''; agent.stdout.on('data', (d) => alog += d); agent.stderr.on('data', (d) => alog += d);
agent.on('exit', (code) => { if (code) console.log('[agent exited]', code, '\n' + alog); });

async function get(p) { return (await fetch(BASE + p)).json(); }
async function post(p, body) {
  return (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
}
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

await post('/api/agent/settings', {
  watchedLogPaths: ['app.log'], errorPatterns: ['FATAL'], aiEnrichDrafts: true,
  llmProvider: 'ollama', llmModel: 'stub', llmEndpoint: 'http://localhost:' + STUB_PORT
});
await waitFor(async () => {
  const s = await get('/api/agent/status');
  return s.sentinels.find((x) => x.name === 'log-watchdog').state === 'watching';
}, 4000, 'watchdog watching');
await new Promise((r) => setTimeout(r, 500));

fs.appendFileSync(log, '2026-05-17T10:00:00Z FATAL Database connection lost\n');

// 1. Bare draft appears almost immediately
await waitFor(async () => (await get('/api/agent/drafts')).count >= 1, 3000, 'bare draft');
const drafts1 = await get('/api/agent/drafts');
const bare = drafts1.drafts[0];
console.log('bare draft enriched:', !!bare.enriched);

// 2. Enrichment lands within 5s
await waitFor(async () => {
  const d = (await get('/api/agent/drafts')).drafts[0];
  return d && d.enriched === true;
}, 6000, 'enriched draft');
const drafts2 = await get('/api/agent/drafts');
const enr = drafts2.drafts[0];
console.log('enriched draft confidence:', enr.confidence);
if (enr.confidence !== 'high') throw new Error('expected confidence=high, got ' + enr.confidence);
if (!enr.content.includes('Likely cause')) throw new Error('missing Likely cause section');
if (!enr.content.includes('Suggested next steps')) throw new Error('missing Suggested next steps');

// 3. Audit log has an llm-call record
const audit = await get('/api/agent/audit');
console.log('audit records:', audit.records.length);
const llmRec = audit.records.find((r) => r.kind === 'llm-call' && r.feature === 'log-watchdog-enrich');
if (!llmRec) throw new Error('expected an llm-call audit record');
if (llmRec.outcome !== 'ok') throw new Error('expected outcome=ok, got ' + llmRec.outcome);

agent.kill('SIGINT'); stub.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== log enrich smoke: PASSED ===');
process.exit(0);
