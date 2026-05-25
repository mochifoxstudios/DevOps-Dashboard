import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { Audit } = require_('../lib/audit');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-chain-'));
const a = new Audit({ dir, maxBytes: 1000, keep: 5 });
for (let i = 0; i < 80; i++) a.append({ kind: 'llm-call', feature: 'f', outcome: 'ok', n: i, payload: 'x'.repeat(40) });

const v1 = a.verify();
console.log('after 80 records:', v1);
if (!v1.ok) throw new Error('chain broken when it should not be');

const files = fs.readdirSync(dir).filter(f => f.startsWith('.audit') && f !== '.audit-tip');
console.log('files:', files.sort());
if (!files.some(f => /^\.audit-\d+\.log$/.test(f))) throw new Error('rotation did not happen');

// Corrupt one record in a retained rotated file
const target = path.join(dir, '.audit-1.log');
let lines = fs.readFileSync(target, 'utf8').trim().split('\n');
if (lines.length >= 2) {
  const rec = JSON.parse(lines[1]); rec.payload = 'TAMPERED';
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(target, lines.join('\n') + '\n');
}

const v2 = a.verify();
console.log('after tamper:', v2);
if (v2.ok) throw new Error('chain should be broken');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n=== audit chain smoke: PASSED ===');
