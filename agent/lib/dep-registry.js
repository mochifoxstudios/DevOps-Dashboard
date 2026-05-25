/* Dep-Map registry lookups — multi-ecosystem latest-version lookup with
   an in-memory TTL cache and a small worker pool. Each lookup hits a
   well-known public registry over HTTPS with a per-request timeout.

   This module never reads disk, never reads env, and never accepts an
   arbitrary URL — only one of five hard-coded registry hosts is contacted. */

const ECOSYSTEMS = {
  npm: {
    url:    (name) => 'https://registry.npmjs.org/' + encodeURIComponent(name),
    parse:  (j)    => j && j['dist-tags'] && j['dist-tags'].latest,
    extras: (j) => ({
      deprecated: j && j.versions && j['dist-tags'] && j['dist-tags'].latest && j.versions[j['dist-tags'].latest] && !!j.versions[j['dist-tags'].latest].deprecated,
      homepage:   j && j.homepage,
      license:    j && j.license
    })
  },
  pip: {
    url:    (name) => 'https://pypi.org/pypi/' + encodeURIComponent(name) + '/json',
    parse:  (j)    => j && j.info && j.info.version,
    extras: (j)    => ({ homepage: j && j.info && (j.info.home_page || j.info.project_url), license: j && j.info && j.info.license })
  },
  cargo: {
    url:    (name) => 'https://crates.io/api/v1/crates/' + encodeURIComponent(name),
    parse:  (j)    => j && j.crate && (j.crate.max_stable_version || j.crate.newest_version),
    extras: (j)    => ({ homepage: j && j.crate && j.crate.homepage })
  },
  go: {
    url:    (mod) => 'https://proxy.golang.org/' + mod.toLowerCase().split('/').map(encodeURIComponent).join('/') + '/@latest',
    parse:  (j)   => j && j.Version,
    extras: ()    => ({})
  },
  gem: {
    url:    (name) => 'https://rubygems.org/api/v1/gems/' + encodeURIComponent(name) + '.json',
    parse:  (j)    => j && j.version,
    extras: (j)    => ({ homepage: j && j.homepage_uri, license: j && j.licenses && j.licenses[0] })
  }
};

// Allowed registry hostnames — the lookup endpoint refuses to send a request
// to anything outside this set even if an attacker tries to inject a URL.
const REGISTRY_HOSTS = new Set([
  'registry.npmjs.org',
  'pypi.org',
  'crates.io',
  'proxy.golang.org',
  'rubygems.org'
]);

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 6;
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map(); // key: `${ecosystem}:${name}` → { value, expiresAt }

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { cache.delete(key); return null; }
  return hit.value;
}
function setCached(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + (ttlMs || CACHE_TTL_MS) });
  // soft cap
  if (cache.size > 5000) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const u = new URL(url);
    if (!REGISTRY_HOSTS.has(u.hostname)) {
      throw new Error('Registry host not allowed: ' + u.hostname);
    }
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'DevOps-Local-Agent/1.0 (dep-registry)',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function lookupOne(ecosystem, name, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const spec = ECOSYSTEMS[ecosystem];
  if (!spec) throw new Error('Unknown ecosystem: ' + ecosystem);
  const key = ecosystem + ':' + name.toLowerCase();
  const cached = getCached(key);
  if (cached) return Object.assign({ name, source: 'cache' }, cached);

  try {
    const json = await fetchWithTimeout(spec.url(name), timeoutMs);
    const latest = spec.parse(json);
    if (!latest) throw new Error('Could not parse latest version');
    const extras = (spec.extras && spec.extras(json)) || {};
    const out = { latest, extras };
    setCached(key, out);
    return Object.assign({ name, source: 'live' }, out);
  } catch (e) {
    // Cache failures briefly so a manifest with 200 deps doesn't re-hammer the
    // registry on repeated re-scans during the same minute.
    const out = { error: e.message || String(e) };
    setCached(key, out, 60 * 1000);
    return Object.assign({ name, source: 'error' }, out);
  }
}

/* Lookup an array of package names against one ecosystem. Runs `concurrency`
   requests in parallel; returns once all are settled (success or error). */
async function lookupBatch(ecosystem, names, opts = {}) {
  if (!Array.isArray(names) || !names.length) return [];
  const concurrency = Math.max(1, Math.min(opts.concurrency || DEFAULT_CONCURRENCY, 12));
  const results = new Array(names.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= names.length) break;
      results[i] = await lookupOne(ecosystem, names[i], opts);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function clearCache() { cache.clear(); }
function cacheStats() {
  const now = Date.now();
  let live = 0, errors = 0, expired = 0;
  for (const [, v] of cache) {
    if (v.expiresAt < now) expired++;
    else if (v.value.error) errors++;
    else live++;
  }
  return { total: cache.size, live, errors, expired };
}

module.exports = { lookupOne, lookupBatch, clearCache, cacheStats, ECOSYSTEMS: Object.keys(ECOSYSTEMS) };
