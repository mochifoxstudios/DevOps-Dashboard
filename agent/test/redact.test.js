const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, makeRedactor } = require('../lib/llm/redact');

test('scrubs default secret patterns', () => {
  const out = redact('NODE_ENV=production STRIPE_API_KEY=sk_live_abc123');
  assert.ok(!out.text.includes('sk_live_abc123'));
  assert.equal(out.summary.secretsFound, 1);
});

test('scrubs IPv4 addresses', () => {
  const out = redact('connection from 10.0.0.5 failed (gateway 192.168.1.1)');
  assert.ok(!out.text.includes('10.0.0.5'));
  assert.ok(!out.text.includes('192.168.1.1'));
  assert.equal(out.summary.ipsScrubbed, 2);
});

test('scrubs home paths', () => {
  const home = require('node:os').homedir();
  const out = redact(`opened ${home}/code/proj/app.js`);
  assert.ok(!out.text.includes(home));
  assert.ok(out.text.includes('~/code/proj/app.js'));
});

test('makeRedactor accepts extra patterns', () => {
  const r = makeRedactor(['acme-internal-\\d+', 'customer-id:\\s*\\S+']);
  const out = r('acme-internal-4421 / customer-id: foo-bar / NODE_ENV=dev');
  assert.ok(!out.text.includes('acme-internal-4421'));
  assert.ok(!out.text.includes('customer-id: foo-bar'));
});

test('returns counts even when nothing matches', () => {
  const out = redact('plain log line with nothing sensitive');
  assert.equal(out.summary.secretsFound, 0);
  assert.equal(out.summary.ipsScrubbed, 0);
});
