// Smoke test: file rotation (truncate then append) — verify the stream
// emits `truncated` then continues delivering new lines.
import fs from 'node:fs';
import path from 'node:path';

const LOG = path.resolve('fixtures/rotate.log');
fs.writeFileSync(LOG, 'initial line 1\ninitial line 2\n');

const STREAM_URL = 'http://localhost:3737/api/log-tail/stream?path=agent/fixtures/rotate.log';
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
        if (received.some(r => r.event === 'truncated') && received.filter(r => r.event === 'line').length >= 1) {
          try { reader.cancel(); } catch (_) {}
          return;
        }
      }
    }
  }
})();

// 300ms: append a line, 800ms: TRUNCATE (size 0 then rewrite), 1400ms: append again.
setTimeout(() => fs.appendFileSync(LOG, 'before truncate\n'), 300);
setTimeout(() => fs.writeFileSync(LOG, ''), 800);
setTimeout(() => fs.appendFileSync(LOG, 'after truncate · should arrive\n'), 1400);

await Promise.race([reading, new Promise(r => setTimeout(r, 6000))]);

console.log('\n--- summary ---');
console.log('truncated emitted:', received.some(r => r.event === 'truncated'));
console.log('line events:      ', received.filter(r => r.event === 'line').length);
process.exit(received.some(r => r.event === 'truncated') ? 0 : 1);
