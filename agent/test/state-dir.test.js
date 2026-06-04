const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveStateDir, stateDir, AGENT_ROOT } = require('../lib/state-dir');

test('honours AGENT_STATE_DIR and creates it', () => {
  const tmp = path.join(os.tmpdir(), 'agent-state-' + process.pid);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const got = resolveStateDir(tmp);
  assert.equal(got, path.resolve(tmp));
  assert.ok(fs.existsSync(got), 'state dir should be created');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('defaults to the agent root when unset', () => {
  assert.equal(resolveStateDir(''), AGENT_ROOT);
  assert.equal(resolveStateDir(undefined === undefined ? '' : undefined), AGENT_ROOT);
});

test('stateDir joins a filename onto the resolved dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  assert.equal(stateDir('.brain-state.json', tmp), path.join(path.resolve(tmp), '.brain-state.json'));
});

test('state files never land inside the source tree when AGENT_STATE_DIR is set', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  const p = stateDir('.ai-keys.json', tmp);
  assert.ok(p.startsWith(path.resolve(tmp)), 'must be under the configured dir');
  assert.ok(!p.includes(path.sep + 'lib' + path.sep), 'must not be written next to source');
  assert.ok(!p.startsWith(AGENT_ROOT + path.sep), 'must be outside the agent source root');
});
