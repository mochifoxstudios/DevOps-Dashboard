import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3764;
const STUB_PORT = 3765;
const BASE = 'http://localhost:' + AGENT_PORT;

const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub', eval_count: 30, prompt_eval_count: 40,
      message: { content: 'Between A and B, NODE_ENV flipped from production to staging and 2 ports opened. Likely a config rollback.' }
    }));
  });
}).listen(STUB_PORT);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-smoke-'));
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch {}

const env = Object.assign({}, process.env, { WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false' });
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let alog = ''; agent.stdout.on('data', (d) => alog += d); agent.stderr.on('data', (d) => alog += d);
agent.on('exit', (code) => { if (code) console.log('[agent exited]', code, '\n' + alog); });

async function post(p, body) { return (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

await post('/api/agent/settings', { llmProvider: 'ollama', llmModel: 'stub', llmEndpoint: 'http://localhost:' + STUB_PORT });

const snapA = { id: 'a', capture: { env: { sample: ['NODE_ENV=production'] }, git: { branch: 'main', sha: 'a' }, pids: { count: 5 }, ports: [3000] } };
const snapB = { id: 'b', capture: { env: { sample: ['NODE_ENV=staging'] }, git: { branch: 'main', sha: 'b' }, pids: { count: 5 }, ports: [3000, 4000, 5000] } };

const r1 = await post('/api/agent/snapshot-diff', { snapA, snapB, narrate: false });
console.log('diff env.changed:', r1.diff.env.changed);
if (r1.narration) throw new Error('expected no narration when narrate=false');

const r2 = await post('/api/agent/snapshot-diff', { snapA, snapB, narrate: true });
console.log('narration:', r2.narration);
if (!r2.narration || !r2.narration.includes('production to staging')) throw new Error('expected narration to mention env change');

agent.kill('SIGINT'); stub.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== diff narrator smoke: PASSED ===');
process.exit(0);
