const test = require('node:test');
const assert = require('node:assert/strict');
const { airgapConfig, selfTest, isLocalEndpoint } = require('../lib/airgap');

test('airgapConfig locks down egress toggles when AIRGAP=true', () => {
  const cfg = airgapConfig({ AIRGAP: 'true', REGISTRY_LOOKUP_ENABLED: 'true', SCRAPER_ALLOW_ANY: 'true', SCRAPER_ALLOWED_HOSTS: 'evil.com' });
  assert.equal(cfg.airgap, true);
  assert.equal(cfg.registryLookupEnabled, false);
  assert.equal(cfg.scraperAllowAny, false);
  assert.equal(cfg.scraperAllowedHosts, '');
});

test('airgapConfig leaves config alone when AIRGAP unset', () => {
  const cfg = airgapConfig({ REGISTRY_LOOKUP_ENABLED: 'true', SCRAPER_ALLOWED_HOSTS: 'docs.example.com' });
  assert.equal(cfg.airgap, false);
  assert.equal(cfg.registryLookupEnabled, true);
  assert.equal(cfg.scraperAllowedHosts, 'docs.example.com');
});

test('isLocalEndpoint recognizes loopback only', () => {
  assert.equal(isLocalEndpoint('http://127.0.0.1:11434'), true);
  assert.equal(isLocalEndpoint('http://localhost:11434'), true);
  assert.equal(isLocalEndpoint('https://api.openai.com'), false);
  assert.equal(isLocalEndpoint(''), false);
});

test('selfTest reports egressBlocked for a proper airgap config', () => {
  const r = selfTest({ airgap: true, registryLookupEnabled: false, scraperAllowAny: false, scraperAllowedHosts: '', llmProvider: 'ollama', llmEndpoint: '' });
  assert.equal(r.egressBlocked, true);
  assert.ok(r.checks.every((c) => c.pass));
});

test('selfTest catches a leak (remote LLM or registry on)', () => {
  assert.equal(selfTest({ airgap: true, registryLookupEnabled: true, scraperAllowAny: false, scraperAllowedHosts: '', llmProvider: 'ollama', llmEndpoint: '' }).egressBlocked, false);
  assert.equal(selfTest({ airgap: true, registryLookupEnabled: false, scraperAllowAny: false, scraperAllowedHosts: '', llmProvider: 'openai', llmEndpoint: 'https://api.openai.com' }).egressBlocked, false);
});
