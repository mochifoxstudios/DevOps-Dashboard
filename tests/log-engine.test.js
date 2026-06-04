const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, lineMatches, classifyLevel } = require('../js/log-engine');

test('classifies levels', () => {
  assert.equal(classifyLevel('2026 ERROR boom'), 'err');
  assert.equal(classifyLevel('FATAL crash'), 'err');
  assert.equal(classifyLevel('warning: low disk'), 'warn');
  assert.equal(classifyLevel('server listening on 3000'), 'ok');
  assert.equal(classifyLevel('just a line'), 'info');
});

test('parseLine extracts ISO timestamp + level', () => {
  const p = parseLine('2026-06-04T02:15:45Z ERROR boom');
  assert.equal(p.level, 'err');
  assert.equal(p.ts, '2026-06-04T02:15:45Z');
  assert.equal(p.raw, '2026-06-04T02:15:45Z ERROR boom');
});

test('lineMatches substring is case-insensitive', () => {
  const p = parseLine('Connection refused to DB');
  assert.equal(lineMatches(p, { text: 'refused' }), true);
  assert.equal(lineMatches(p, { text: 'REFUSED' }), true);
  assert.equal(lineMatches(p, { text: 'accepted' }), false);
  assert.equal(lineMatches(p, { text: '' }), true); // empty filter passes everything
});

test('lineMatches level filter', () => {
  const err = parseLine('ERROR boom');
  const info = parseLine('hello world');
  assert.equal(lineMatches(err, { level: 'err' }), true);
  assert.equal(lineMatches(info, { level: 'err' }), false);
  assert.equal(lineMatches(info, { level: 'all' }), true);
});

test('lineMatches regex with graceful fallback on invalid pattern', () => {
  const p = parseLine('GET /api/users 200');
  assert.equal(lineMatches(p, { text: '\\d{3}', useRegex: true }), true);
  // invalid regex → falls back to substring search of the literal text
  assert.equal(lineMatches(p, { text: '[invalid(', useRegex: true }), false);
});

test('lineMatches combines text + level (AND)', () => {
  const err = parseLine('ERROR disk full');
  assert.equal(lineMatches(err, { text: 'disk', level: 'err' }), true);
  assert.equal(lineMatches(err, { text: 'disk', level: 'warn' }), false);
});
