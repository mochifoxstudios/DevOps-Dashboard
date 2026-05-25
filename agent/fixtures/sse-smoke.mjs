// SSE smoke test — connects to the running agent, appends lines to the log,
// asserts that the agent streams them back over the open connection.
// Run: node fixtures/sse-smoke.mjs

import fs from 'node:fs';
import path from 'node:path';

const LOG = path.resolve('fixtures/smoke.log');
const STREAM_URL = 'http://localhost:3737/api/log-tail/stream?path=agent/fixtures/smoke.log';

const res = await fetch(STREAM_URL);
if (!res.ok) { console.log('HTTP', res.status); process.exit(1); }

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const received = [];

const reading = (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = {};
      chunk.split('\n').forEach(line => {
        if (line.startsWith('event:')) ev.event = line.slice(6).trim();
        else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
      });
      if (ev.event) {
        received.push(ev);
        console.log('  →', ev.event, ev.data ? ev.data.slice(0, 80) : '');
        if (ev.event === 'line' && received.filter(r => r.event === 'line').length >= 3) {
          try { reader.cancel(); } catch (_) {}
          return;
        }
      }
    }
  }
})();

// Append 3 lines while the stream is open
setTimeout(() => fs.appendFileSync(LOG, '2026-05-15T10:01:00Z INFO First new line\n'), 250);
setTimeout(() => fs.appendFileSync(LOG, '2026-05-15T10:01:01Z ERROR Boom\n'), 700);
setTimeout(() => fs.appendFileSync(LOG, '2026-05-15T10:01:02Z INFO Recovered\n'), 1150);

await Promise.race([reading, new Promise(r => setTimeout(r, 8000))]);

const lineEvents = received.filter(r => r.event === 'line').map(r => JSON.parse(r.data).line);
console.log('\n--- summary ---');
console.log('open received: ', received.some(r => r.event === 'open'));
console.log('lines received:', lineEvents.length);
console.log('content:      ', JSON.stringify(lineEvents));
process.exit(lineEvents.length >= 3 ? 0 : 1);
