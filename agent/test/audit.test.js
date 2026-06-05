const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Audit } = require('../lib/audit');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

test('append + read round-trip', () => {
  const dir = tmpDir();
  const a = new Audit({ dir, maxBytes: 10 * 1024 * 1024, keep: 10 });
  const id1 = a.append({ kind: 'llm-call', feature: 'x', outcome: 'ok' });
  const id2 = a.append({ kind: 'llm-call', feature: 'y', outcome: 'ok' });
  assert.ok(id1.startsWith('aud-'));
  assert.notEqual(id1, id2);
  const list = a.read({ limit: 10 });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, id2);  // newest first
});

test('hash chain verifies', () => {
  const dir = tmpDir();
  const a = new Audit({ dir });
  for (let i = 0; i < 20; i++) a.append({ kind: 'llm-call', feature: 'f', outcome: 'ok', n: i });
  const v = a.verify();
  assert.equal(v.ok, true);
  assert.equal(v.recordsVerified, 20);
});

test('tampering breaks verify', () => {
  const dir = tmpDir();
  const a = new Audit({ dir });
  for (let i = 0; i < 5; i++) a.append({ kind: 'llm-call', feature: 'f', outcome: 'ok', n: i });
  const file = path.join(dir, '.audit.log');
  let lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[2]); rec.feature = 'TAMPERED';
  lines[2] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const v = a.verify();
  assert.equal(v.ok, false);
  assert.ok(v.brokenAt);
});

test('records are Ed25519-signed; verify reports signed:true + exports a public key', () => {
  const dir = tmpDir();
  const a = new Audit({ dir });
  a.append({ kind: 'k', feature: 'f', outcome: 'ok' });
  assert.ok(fs.existsSync(path.join(dir, '.audit-pubkey.pem')));
  const list = a.read();
  assert.ok(typeof list[0].sig === 'string' && list[0].sig.length > 0);
  const v = a.verify();
  assert.equal(v.ok, true);
  assert.equal(v.signed, true);
  assert.ok(a.publicKeyPem().includes('PUBLIC KEY'));
});

test('signature catches tampering the LAST record (hash chain alone would miss it)', () => {
  const dir = tmpDir();
  const a = new Audit({ dir });
  for (let i = 0; i < 3; i++) a.append({ kind: 'k', feature: 'f', outcome: 'ok', n: i });
  const file = path.join(dir, '.audit.log');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  last.feature = 'TAMPERED'; // prevHash + sig left intact → chain check passes, signature won't
  lines[lines.length - 1] = JSON.stringify(last);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const v = a.verify();
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'signature');
});

test('rotation at maxBytes', () => {
  const dir = tmpDir();
  const a = new Audit({ dir, maxBytes: 800, keep: 5 });
  for (let i = 0; i < 30; i++) a.append({ kind: 'llm-call', feature: 'longish-feature-name', outcome: 'ok', n: i });
  const files = fs.readdirSync(dir).filter(f => f.startsWith('.audit'));
  assert.ok(files.includes('.audit.log'));
  assert.ok(files.some(f => /^\.audit-\d+\.log$/.test(f)));
  const v = a.verify();
  assert.equal(v.ok, true);
});
