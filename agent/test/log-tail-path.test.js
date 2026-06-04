const test = require('node:test');
const assert = require('node:assert/strict');
const { isLogPath } = require('../lib/log-tail');

test('accepts log-shaped extensions', () => {
  assert.equal(isLogPath('/ws/logs/app.log'), true);
  assert.equal(isLogPath('/ws/out.txt'), true);
  assert.equal(isLogPath('/ws/server.OUT'), true);
});

test('rejects secrets and source', () => {
  assert.equal(isLogPath('/ws/agent/.ai-keys.json'), false);
  assert.equal(isLogPath('/ws/agent/.env'), false);
  assert.equal(isLogPath('/ws/agent/.salt'), false);
  assert.equal(isLogPath('/ws/agent/server.js'), false);
});

test('honours a custom extension list', () => {
  assert.equal(isLogPath('/ws/a.ndjson', ['.ndjson']), true);
  assert.equal(isLogPath('/ws/a.log', ['.ndjson']), false);
});
