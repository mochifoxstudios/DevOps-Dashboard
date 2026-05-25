import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3760;
const STUB_PORT = 3761;
const BASE = 'http://localhost:' + AGENT_PORT;

// Spin up a tiny stub that pretends to be Ollama
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'stub', message: { content: 'ok' }, eval_count: 2, prompt_eval_count: 5 }));
    } else if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'stub-a' }, { name: 'stub-b' }] }));
    } else { res.writeHead(404); res.end(); }
  });
}).listen(STUB_PORT);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-smoke-'));
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch (_) {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch (_) {}

const env = Object.assign({}, process.env, { WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false' });
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; agent.stdout.on('data', (d) => log += d); agent.stderr.on('data', (d) => log += d);
agent.on('exit', (code) => { if (code) console.log('[agent exited]', code, '\n' + log); });

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

const provs = await get('/api/llm/providers');
console.log('providers:', provs.providers.join(', '));
if (provs.providers.length !== 4) throw new Error('expected 4 providers');

// Point Ollama at our stub
await post('/api/agent/settings', { llmProvider: 'ollama', llmModel: 'stub-a', llmEndpoint: 'http://localhost:' + STUB_PORT });

const models = await get('/api/llm/models');
console.log('ollama models:', models.models);
if (!models.models.includes('stub-a')) throw new Error('listModels failed');

const test = await post('/api/llm/test', {});
console.log('test:', test);
if (!test.ok) throw new Error('test-key failed: ' + JSON.stringify(test));

const audit = await get('/api/agent/audit');
console.log('audit records:', audit.records.length, '(expected 0 — testKey skips audit)');

agent.kill('SIGINT');
stub.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== LLM provider smoke: PASSED ===');
process.exit(0);
