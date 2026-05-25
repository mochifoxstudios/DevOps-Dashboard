const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Keystore } = require('../lib/keystore');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-test-')); }

test('round-trip set + get', () => {
  const dir = tmpDir();
  const ks = new Keystore({ dir, workspaceRoot: '/path/to/ws' });
  ks.set('openai_api_key', 'sk-secret-1234');
  ks.set('github_pat', 'ghp_abcdef');
  assert.equal(ks.get('openai_api_key'), 'sk-secret-1234');
  assert.equal(ks.get('github_pat'), 'ghp_abcdef');
});

test('values are encrypted on disk', () => {
  const dir = tmpDir();
  const ks = new Keystore({ dir, workspaceRoot: '/x' });
  ks.set('k', 'PLAINTEXT_NEVER_ON_DISK');
  const raw = fs.readFileSync(path.join(dir, '.ai-keys.json'), 'utf8');
  assert.ok(!raw.includes('PLAINTEXT_NEVER_ON_DISK'));
});

test('different workspaceRoot cannot read same file', () => {
  const dir = tmpDir();
  const ks1 = new Keystore({ dir, workspaceRoot: '/ws-a' });
  ks1.set('k', 'v');
  const ks2 = new Keystore({ dir, workspaceRoot: '/ws-b' });
  assert.equal(ks2.get('k'), null);  // wrong key → cannot decrypt → null
});

test('missing key returns null', () => {
  const dir = tmpDir();
  const ks = new Keystore({ dir, workspaceRoot: '/x' });
  assert.equal(ks.get('absent'), null);
});

test('list returns key names only, never values', () => {
  const dir = tmpDir();
  const ks = new Keystore({ dir, workspaceRoot: '/x' });
  ks.set('a', '1'); ks.set('b', '2');
  const names = ks.list();
  assert.deepEqual(names.sort(), ['a', 'b']);
});
