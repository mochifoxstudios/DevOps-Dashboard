const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Brain, LogWatchdog } = require('../lib/brain');
const { isValidSnapshot } = require('../lib/snapshot-diff');
const { readLastBytes } = require('../lib/log-tail');

function freshBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rob-'));
  return new Brain({ workspaceRoot: dir, stateDir: dir });
}

test('updateSettings coerces cpuCeiling and filters empty watched paths', () => {
  const b = freshBrain();
  const s = b.updateSettings({ cpuCeiling: 'not-a-number', watchedLogPaths: ['logs/a.log', '', '   ', 'b.log'] });
  assert.equal(typeof s.cpuCeiling, 'number');
  assert.ok(Number.isFinite(s.cpuCeiling));
  assert.deepEqual(s.watchedLogPaths, ['logs/a.log', 'b.log']);
});

test('LogWatchdog enrich queue caps at 50 (drop-oldest)', () => {
  const b = freshBrain();
  const w = new LogWatchdog(b, { workspaceRoot: b.workspaceRoot });
  for (let i = 0; i < 60; i++) w._enqueueEnrich({ id: 'd' + i });
  assert.equal(w.enrichQueue.length, 50);
  assert.equal(w.enrichQueue[0].id, 'd10'); // oldest 10 dropped
  assert.equal(w.enrichQueue[49].id, 'd59');
});

test('isValidSnapshot rejects malformed input', () => {
  assert.equal(isValidSnapshot({ capture: {} }), true);
  assert.equal(isValidSnapshot({}), false);
  assert.equal(isValidSnapshot(null), false);
  assert.equal(isValidSnapshot('nope'), false);
});

test('readLastBytes rejects a missing file with statusCode 404', async () => {
  const missing = path.join(os.tmpdir(), 'definitely-missing-' + process.pid + '.log');
  await assert.rejects(
    () => readLastBytes(missing, 1024),
    (err) => err.statusCode === 404
  );
});
