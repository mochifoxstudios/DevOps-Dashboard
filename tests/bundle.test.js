const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBundle, validate, parse, FORMAT } = require('../js/bundle');

test('buildBundle wraps data with format + version', () => {
  const b = buildBundle({ 'devops:profile': '{}' }, '2026-06-04T00:00:00Z');
  assert.equal(b.format, FORMAT);
  assert.equal(b.version, 1);
  assert.equal(b.exportedAt, '2026-06-04T00:00:00Z');
  assert.deepEqual(b.data, { 'devops:profile': '{}' });
});

test('validate accepts a good bundle', () => {
  const v = validate(buildBundle({ 'devops:settings': '{}', 'devops:snapshots': '[]' }));
  assert.equal(v.ok, true);
  assert.equal(v.keyCount, 2);
});

test('validate rejects malformed bundles', () => {
  assert.equal(validate(null).ok, false);
  assert.equal(validate({}).ok, false);
  assert.equal(validate({ format: 'other', version: 1, data: {} }).ok, false);
  assert.equal(validate({ format: FORMAT, version: 1 }).ok, false);          // no data
  assert.equal(validate({ format: FORMAT, version: 1, data: {} }).ok, false); // no devops:* keys
  assert.equal(validate({ format: FORMAT, version: 1, data: { foo: 1 } }).ok, false);
});

test('parse round-trips and rejects bad JSON / wrong format', () => {
  const text = JSON.stringify(buildBundle({ 'devops:workspaces': '[]' }));
  const r = parse(text);
  assert.equal(r.ok, true);
  assert.equal(r.keyCount, 1);
  assert.equal(parse('{not json').ok, false);
  assert.equal(parse(JSON.stringify({ format: 'nope' })).ok, false);
});
