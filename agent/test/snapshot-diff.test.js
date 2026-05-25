const test = require('node:test');
const assert = require('node:assert/strict');
const { diffSnapshots } = require('../lib/snapshot-diff');

const A = {
  capture: {
    env:   { sample: ['NODE_ENV=production', 'A=1'] },
    git:   { branch: 'main', sha: 'abc1234', dirty: false, dirtyFiles: 0 },
    pids:  { count: 10 },
    ports: [3000, 5432]
  }
};
const B = {
  capture: {
    env:   { sample: ['NODE_ENV=staging', 'A=1', 'NEW=2'] },
    git:   { branch: 'feature/x', sha: 'def5678', dirty: true, dirtyFiles: 3 },
    pids:  { count: 12 },
    ports: [3000, 5544, 9000]
  }
};

test('env diff: added, removed, changed', () => {
  const d = diffSnapshots(A, B);
  assert.deepEqual(d.env.added.sort(), ['NEW']);
  assert.deepEqual(d.env.removed, []);
  assert.equal(d.env.changed.length, 1);
  assert.equal(d.env.changed[0].key, 'NODE_ENV');
});

test('git diff: branch + sha + dirty', () => {
  const d = diffSnapshots(A, B);
  assert.deepEqual(d.git.branchChanged, { from: 'main', to: 'feature/x' });
  assert.equal(d.git.shaChanged, true);
  assert.equal(d.git.dirtyDelta, 3);
});

test('pids gained/lost', () => {
  const d = diffSnapshots(A, B);
  assert.equal(d.pids.gained, 2);
  assert.equal(d.pids.lost, 0);
});

test('ports opened/closed', () => {
  const d = diffSnapshots(A, B);
  assert.deepEqual(d.ports.opened.sort((x, y) => x - y), [5544, 9000]);
  assert.deepEqual(d.ports.closed, [5432]);
});

test('missing captures handled', () => {
  const d = diffSnapshots({}, B);
  assert.ok(d.env.added.length > 0);
});
