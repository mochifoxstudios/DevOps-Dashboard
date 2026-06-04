const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withinWorkspace } = require('../lib/safety');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')); }

test('allows a normal path inside the workspace', () => {
  const root = fs.realpathSync(tmp());
  const p = withinWorkspace(root, 'logs/app.log');
  assert.ok(p.startsWith(root));
});

test('rejects ../ escape', () => {
  const root = fs.realpathSync(tmp());
  assert.throws(() => withinWorkspace(root, '../outside.txt'), /escapes workspace/);
});

test('rejects a symlink that points outside the workspace', () => {
  const root = fs.realpathSync(tmp());
  const outside = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') { return; } // unprivileged env — skip
    throw e;
  }
  assert.throws(() => withinWorkspace(root, 'link/secret.txt'), /escapes workspace/);
});
