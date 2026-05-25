/* Docs Scraper proxy + HTML→Markdown normalization.
   - SSRF protection: hostname is DNS-resolved, the resulting IP must be public.
   - Host allowlist: empty by default (deny-all). Opt-in via SCRAPER_ALLOWED_HOSTS.
   - Request headers from the browser are NOT forwarded; we set our own.
   - Response size cap (default 2 MB).
   - Turndown normalizes text/html → Markdown server-side.

   This module never reads disk and never executes a child process. */

const dns = require('node:dns').promises;
const TurndownService = require('turndown');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_USER_AGENT = 'DevOps-Local-Scraper/1.0 (+local-agent)';

function parsePatterns(csv) {
  return (csv || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatchesAllowlist(host, patterns) {
  if (!patterns.length) return false;
  host = host.toLowerCase();
  for (const p of patterns) {
    if (p === host) return true;
    if (p.startsWith('*.') && host.endsWith(p.slice(1))) return true;
  }
  return false;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10 (CGNAT)
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
function isPrivateIPv6(ip) {
  ip = ip.toLowerCase();
  if (ip === '::1' || ip === '::') return true;
  // Unique-local fc00::/7 and link-local fe80::/10
  if (/^f[cd]/.test(ip)) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  // IPv4-mapped IPv6: ::ffff:127.0.0.1 etc.
  const m = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateIPv4(m[1]);
  return false;
}

async function assertPublicHost(host) {
  // Resolve all A and AAAA records — if any one is private, refuse.
  let records = [];
  try {
    records = await dns.lookup(host, { all: true, family: 0 });
  } catch (e) {
    const err = new Error('DNS lookup failed for ' + host + ': ' + e.message);
    err.statusCode = 502;
    throw err;
  }
  for (const r of records) {
    const isPriv = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
    if (isPriv) {
      const err = new Error('Refusing to fetch private/internal address: ' + r.address + ' (host ' + host + ')');
      err.statusCode = 403;
      throw err;
    }
  }
}

function buildTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_'
  });
  // Strip elements that almost never carry useful content for docs.
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg']);
  return td;
}

let _td = null;
function turndown() { return (_td = _td || buildTurndown()); }

/* Scrape `url`:
   - Validate scheme http(s)
   - Match host against allowlist (or allowAny override)
   - DNS-check that the host doesn't resolve to a private IP
   - Stream the response with a byte cap
   - If text/html, convert to Markdown via turndown
   - Return { url, finalUrl, status, contentType, bytes, body, markdown? } */
async function scrape(url, opts = {}) {
  const allowed = parsePatterns(opts.allowedHosts);
  const allowAny = !!opts.allowAny;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;

  let u;
  try { u = new URL(url); }
  catch (_) { throw Object.assign(new Error('Invalid URL'), { statusCode: 400 }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('Only http(s) URLs allowed'), { statusCode: 400 });
  }
  if (!allowAny && !hostMatchesAllowlist(u.hostname, allowed)) {
    throw Object.assign(
      new Error(
        'Host not in allowlist: ' + u.hostname +
        '. Add it to SCRAPER_ALLOWED_HOSTS or set SCRAPER_ALLOW_ANY=true.'
      ),
      { statusCode: 403 }
    );
  }
  await assertPublicHost(u.hostname);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(u.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': opts.userAgent || DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
  } finally {
    clearTimeout(t);
  }

  // After redirects, re-validate the final URL's host.
  const finalUrl = res.url || u.toString();
  let finalHost;
  try { finalHost = new URL(finalUrl).hostname; } catch (_) { finalHost = u.hostname; }
  if (finalHost !== u.hostname) {
    if (!allowAny && !hostMatchesAllowlist(finalHost, allowed)) {
      throw Object.assign(
        new Error('Redirect destination not in allowlist: ' + finalHost),
        { statusCode: 403 }
      );
    }
    await assertPublicHost(finalHost);
  }

  if (!res.ok) {
    throw Object.assign(new Error('Upstream HTTP ' + res.status), { statusCode: 502 });
  }

  // Read with a byte cap so a 1 GB response can't OOM the agent.
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { reader.cancel(); } catch (_) {}
      throw Object.assign(new Error('Response exceeds ' + maxBytes + ' bytes'), { statusCode: 413 });
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  // Best-effort decode (Buffer.toString handles UTF-8 well; charset detection beyond that
  // is out of scope for v1 — docs pages are overwhelmingly UTF-8).
  const body = buf.toString('utf8');

  const out = {
    url: u.toString(),
    finalUrl,
    status: res.status,
    contentType,
    bytes: total,
    body
  };

  if (contentType.startsWith('text/html')) {
    try { out.markdown = turndown().turndown(body); }
    catch (e) { out.markdownError = e.message; }
  } else if (contentType.startsWith('text/markdown') || contentType.startsWith('text/plain')) {
    out.markdown = body;
  }

  return out;
}

module.exports = { scrape, hostMatchesAllowlist, isPrivateIPv4, isPrivateIPv6, parsePatterns, assertPublicHost };
