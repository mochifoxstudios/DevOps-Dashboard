const test = require('node:test');
const assert = require('node:assert/strict');
const { scrape } = require('../lib/scraper');

// Fake fetch: maps url -> { status, headers, body }
function fakeFetchFactory(routes) {
  return async (url) => {
    const r = routes[url];
    if (!r) throw new Error('unexpected fetch ' + url);
    return {
      status: r.status, ok: r.status >= 200 && r.status < 300, url,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null },
      body: {
        getReader() {
          let done = false;
          return {
            read() {
              if (done) return Promise.resolve({ done: true });
              done = true;
              return Promise.resolve({ value: Buffer.from(r.body || ''), done: false });
            },
            cancel() {}
          };
        }
      }
    };
  };
}
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '169.254.169.254', family: 4 }];

test('refuses a redirect to a private IP', async () => {
  const _fetch = fakeFetchFactory({
    'https://docs.example.com/': { status: 302, headers: { location: 'http://metadata.evil/' } }
  });
  const lookups = { 'docs.example.com': publicLookup, 'metadata.evil': privateLookup };
  await assert.rejects(
    scrape('https://docs.example.com/', { allowAny: true, _fetch, _lookup: (h) => lookups[h](h) }),
    /private|internal/i
  );
});

test('refuses a redirect off the allowlist', async () => {
  const _fetch = fakeFetchFactory({
    'https://docs.example.com/': { status: 302, headers: { location: 'https://evil.com/' } }
  });
  await assert.rejects(
    scrape('https://docs.example.com/', { allowedHosts: 'docs.example.com', _fetch, _lookup: publicLookup }),
    /allowlist/i
  );
});

test('follows an allowed multi-hop redirect to success', async () => {
  const _fetch = fakeFetchFactory({
    'https://docs.example.com/': { status: 301, headers: { location: 'https://docs.example.com/v2' } },
    'https://docs.example.com/v2': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello' }
  });
  const out = await scrape('https://docs.example.com/', { allowedHosts: 'docs.example.com', _fetch, _lookup: publicLookup });
  assert.equal(out.status, 200);
  assert.equal(out.body, 'hello');
});
