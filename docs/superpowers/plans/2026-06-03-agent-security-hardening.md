# Agent Security Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every gap surfaced in the 2026-06-02 audit of `DevOps/`, with tests, then push to `mochifoxstudios/DevOps-Dashboard`.

**Architecture:** All fixes live in the Node agent (`agent/`). Each fix is a small, testable change behind a focused helper, validated by `node --test` unit tests plus one integration smoke fixture for the network-binding change. No frontend changes are required — the dashboard is served same-origin in Mode 3 and from `localhost` in Mode 2, both of which the tightened CORS still allows. Documentation is updated to match the new, truthful defaults.

**Tech Stack:** Node 18+ / Express 4, `node:test`, `node:crypto`, `chokidar`, `turndown`, `cors`, `dotenv`.

**Branch:** `harden-audit-findings` (created off `main` before Task 1).

---

## Audit findings → task map

| # | Finding (severity) | Task |
|---|---|---|
| 6,7 | `qs` advisory; no `npm test` script (low) | Task 1 |
| 8 | `redact.js` `envVarsScrubbed` counter always 0 (low) | Task 2 |
| 3 | `withinWorkspace` doesn't resolve symlinks despite comment (med) | Task 3 |
| 1b,2 | log-tail endpoints read *any* workspace file, not just logs (high) | Task 4 |
| 4 | scraper follows redirects to internal IPs before validating (med) | Task 5 |
| 1a | binds `0.0.0.0` + open CORS, no auth (high) | Task 6 |
| 5,doc | keystore/Windows-perms honesty; all doc claims | Task 7 |
| — | full verification + push + PR | Task 8 |

---

### Task 1: Test script + dependency hygiene

**Files:**
- Modify: `agent/package.json` (scripts block)
- Modify: `agent/package-lock.json` (via `npm audit fix`)

- [ ] **Step 1: Add the test script.** In `agent/package.json` `scripts`, add `"test": "node --test test/*.test.js"`.

- [ ] **Step 2: Run the existing suite via the new script.**
  Run: `npm test` (in `agent/`)
  Expected: 19 tests pass (audit, keystore, redact, snapshot-diff).

- [ ] **Step 3: Fix the qs advisory.**
  Run: `npm audit fix` then `npm audit --omit=dev`
  Expected: "found 0 vulnerabilities" (qs bumped past 6.15.1).

- [ ] **Step 4: Re-run tests to confirm the bump didn't break anything.**
  Run: `npm test`
  Expected: 19 pass.

- [ ] **Step 5: Commit.**
  `git add agent/package.json agent/package-lock.json`
  `git commit -m "chore(agent): add npm test script and clear qs advisory"`

---

### Task 2: Correct redaction summary counters

`redact.js` initialises `envVarsScrubbed` but never increments it; the `NAME=value` regex wrongly bumps `secretsFound`. Split the two: env-var-shaped matches → `envVarsScrubbed`; known token formats (`sk-`, `ghp_`, `xoxb-`, `AKIA`) → `secretsFound`.

**Files:**
- Modify: `agent/lib/llm/redact.js:21-23`
- Test: `agent/test/redact.test.js`

- [ ] **Step 1: Update/extend the test.** Replace the `scrubs default secret patterns` assertion and add a token test:
```js
test('counts env-var-shaped secrets under envVarsScrubbed', () => {
  const out = redact('NODE_ENV=production STRIPE_API_KEY=sk_live_abc123');
  assert.ok(!out.text.includes('sk_live_abc123'));
  assert.equal(out.summary.envVarsScrubbed, 1);
  assert.equal(out.summary.secretsFound, 0);
});

test('counts known token formats under secretsFound', () => {
  const out = redact('token ghp_0123456789abcdefABCD and key AKIAIOSFODNN7EXAMPLE');
  assert.ok(!out.text.includes('ghp_0123456789abcdefABCD'));
  assert.ok(!out.text.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.equal(out.summary.secretsFound, 2);
});
```

- [ ] **Step 2: Run, expect failure.**
  Run: `node --test test/redact.test.js`
  Expected: FAIL — `envVarsScrubbed` is 0.

- [ ] **Step 3: Implement.** In `redact.js`, change the first loop to increment `envVarsScrubbed` and keep the second loop on `secretsFound`:
```js
out = out.replace(DEFAULT_SECRET_RES[0], () => { envVarsScrubbed++; return '<redacted-secret>'; });
out = out.replace(DEFAULT_SECRET_RES[1], () => { secretsFound++;   return '<redacted-secret>'; });
```
(Replace the existing `for (const re of DEFAULT_SECRET_RES)` loop.)

- [ ] **Step 4: Run, expect pass.**
  Run: `node --test test/redact.test.js`
  Expected: PASS (all redact tests).

- [ ] **Step 5: Commit.**
  `git commit -am "fix(agent): correct redaction counters (envVarsScrubbed was always 0)"`

---

### Task 3: Resolve symlinks in `withinWorkspace`

`safety.js` claims it throws on symlink escape but only does a lexical prefix check. Resolve the realpath of the nearest existing ancestor and re-check containment, so a symlink inside the workspace pointing outward is rejected. Files that don't exist yet (SSE stream target, watched paths) must still be allowed, so we realpath the deepest *existing* ancestor and re-append the missing tail.

**Files:**
- Modify: `agent/lib/safety.js:21-33`
- Test: `agent/test/safety.test.js` (create)

- [ ] **Step 1: Write the failing test** (`agent/test/safety.test.js`):
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withinWorkspace } = require('../lib/safety');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')); }

test('allows a normal path inside the workspace', () => {
  const root = fs.realpathSync(tmp());
  const p = withinWorkspace(root, 'logs/app.log');
  assert.ok(p.startsWith(root));
});

test('rejects ../ escape', () => {
  const root = fs.realpathSync(tmp());
  assert.throws(() => withinWorkspace(root, '../outside.txt'), /escapes workspace/);
});

test('rejects a symlink that points outside the workspace', () => {
  const root = fs.realpathSync(tmp());
  const outside = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') { return; } // unprivileged env — skip
    throw e;
  }
  assert.throws(() => withinWorkspace(root, 'link/secret.txt'), /escapes workspace/);
});
```

- [ ] **Step 2: Run, expect the symlink test to fail.**
  Run: `node --test test/safety.test.js`
  Expected: FAIL on the symlink case (no throw).

- [ ] **Step 3: Implement.** Replace the body of `withinWorkspace` so it does the lexical check, then realpaths the nearest existing ancestor:
```js
function withinWorkspace(workspaceRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate.length) {
    throw new Error('Path is required');
  }
  const resolved = path.resolve(workspaceRoot, candidate);
  const sep = path.sep;
  const lexRoot = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep;
  if (resolved !== workspaceRoot && !resolved.startsWith(lexRoot)) {
    throw Object.assign(new Error(`Path escapes workspace: ${candidate}`), { statusCode: 403 });
  }
  // Resolve symlinks: realpath the deepest existing ancestor, re-append the missing tail.
  const realRoot = fs.realpathSync(workspaceRoot);
  let existing = resolved;
  const tail = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const finalResolved = tail.length ? path.join(realExisting, ...tail) : realExisting;
  const realRootSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (finalResolved !== realRoot && !finalResolved.startsWith(realRootSep)) {
    throw Object.assign(new Error(`Path escapes workspace: ${candidate}`), { statusCode: 403 });
  }
  return finalResolved;
}
```

- [ ] **Step 4: Run, expect pass.**
  Run: `node --test test/safety.test.js`
  Expected: PASS (3 tests, symlink one may self-skip on unprivileged Windows).

- [ ] **Step 5: Run full suite — withinWorkspace is widely used.**
  Run: `npm test`
  Expected: all pass.

- [ ] **Step 6: Commit.**
  `git add agent/lib/safety.js agent/test/safety.test.js`
  `git commit -m "fix(agent): resolve symlinks in withinWorkspace to stop boundary escape"`

---

### Task 4: Restrict log-tail endpoints to log-shaped files

`/api/log-tail/file` and `/api/log-tail/stream` validate the workspace boundary but accept any extension, so they can read `.env`, `.ai-keys.json`, `.salt`, source, etc. Add an extension gate (default `.log,.txt,.out,.err`, overridable via `LOG_TAIL_EXTENSIONS`).

**Files:**
- Modify: `agent/lib/log-tail.js` (add + export `isLogPath`)
- Modify: `agent/server.js:131-136` and `:140-147`
- Test: `agent/test/log-tail-path.test.js` (create)

- [ ] **Step 1: Write the failing test** (`agent/test/log-tail-path.test.js`):
```js
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
```

- [ ] **Step 2: Run, expect failure (import error).**
  Run: `node --test test/log-tail-path.test.js`
  Expected: FAIL — `isLogPath` is not exported.

- [ ] **Step 3: Implement in `log-tail.js`.** Add near the top and to `module.exports`:
```js
const DEFAULT_LOG_EXTS = ['.log', '.txt', '.out', '.err'];
function isLogPath(filePath, exts) {
  const allowed = (exts && exts.length ? exts : DEFAULT_LOG_EXTS).map((e) => e.toLowerCase());
  const lower = String(filePath).toLowerCase();
  return allowed.some((e) => lower.endsWith(e));
}
```
Export: `module.exports = { LogStream, readLastBytes, findLogFiles, isLogPath, DEFAULT_LOG_EXTS };`

- [ ] **Step 4: Enforce in `server.js`.** Add near the other config constants:
```js
const LOG_TAIL_EXTS = (process.env.LOG_TAIL_EXTENSIONS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
```
In the `/api/log-tail/file` handler, after `withinWorkspace(...)`:
```js
if (!logTail.isLogPath(resolved, LOG_TAIL_EXTS)) {
  return res.status(403).json({ error: 'Only log-shaped files (.log/.txt/.out/.err) may be read' });
}
```
In the `/api/log-tail/stream` handler, after the `withinWorkspace` try/catch resolves `resolved`:
```js
if (!logTail.isLogPath(resolved, LOG_TAIL_EXTS)) {
  return res.status(403).json({ error: 'Only log-shaped files (.log/.txt/.out/.err) may be streamed' });
}
```

- [ ] **Step 5: Run, expect pass.**
  Run: `node --test test/log-tail-path.test.js` then `npm test`
  Expected: PASS.

- [ ] **Step 6: Commit.**
  `git add agent/lib/log-tail.js agent/server.js agent/test/log-tail-path.test.js`
  `git commit -m "fix(agent): restrict log-tail file/stream endpoints to log-shaped extensions"`

---

### Task 5: Validate every redirect hop in the scraper

`scrape()` uses `redirect: 'follow'`, so Node fetches redirect targets (including internal IPs) before the code re-checks the final host. Switch to `redirect: 'manual'` and validate scheme + allowlist + SSRF on **each** hop. Make `fetch`/`dns.lookup` injectable so the logic is hermetically testable.

**Files:**
- Modify: `agent/lib/scraper.js` (`assertPublicHost`, `scrape`)
- Test: `agent/test/scraper.test.js` (create)

- [ ] **Step 1: Write the failing test** (`agent/test/scraper.test.js`):
```js
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
      body: { getReader() { let done = false; return { read() { if (done) return Promise.resolve({ done: true }); done = true; return Promise.resolve({ value: Buffer.from(r.body || ''), done: false }); }, cancel() {} }; } }
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
```

- [ ] **Step 2: Run, expect failure.**
  Run: `node --test test/scraper.test.js`
  Expected: FAIL (current code follows redirects internally / ignores `_fetch`).

- [ ] **Step 3: Implement.** In `scraper.js`:
  (a) Make `assertPublicHost` accept an injected lookup:
```js
async function assertPublicHost(host, lookup) {
  const doLookup = lookup || ((h) => dns.lookup(h, { all: true, family: 0 }));
  let records = [];
  try { records = await doLookup(host); }
  catch (e) { throw Object.assign(new Error('DNS lookup failed for ' + host + ': ' + e.message), { statusCode: 502 }); }
  for (const r of records) {
    const isPriv = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
    if (isPriv) throw Object.assign(new Error('Refusing to fetch private/internal address: ' + r.address + ' (host ' + host + ')'), { statusCode: 403 });
  }
}
```
  (b) Rewrite the request section of `scrape` to a manual redirect loop (replace from the `const ctrl = ...` block through the redirect re-validation):
```js
  const _fetch = opts._fetch || fetch;
  const _lookup = opts._lookup;
  const validateHop = async (urlStr) => {
    const h = new URL(urlStr);
    if (h.protocol !== 'http:' && h.protocol !== 'https:') throw Object.assign(new Error('Only http(s) URLs allowed'), { statusCode: 400 });
    if (!allowAny && !hostMatchesAllowlist(h.hostname, allowed)) throw Object.assign(new Error('Host not in allowlist: ' + h.hostname), { statusCode: 403 });
    await assertPublicHost(h.hostname, _lookup);
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, currentUrl = u.toString(), hops = 0;
  try {
    while (true) {
      await validateHop(currentUrl);
      res = await _fetch(currentUrl, {
        method: 'GET', redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': opts.userAgent || DEFAULT_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' }
      });
      const loc = res.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
        if (++hops > 5) throw Object.assign(new Error('Too many redirects'), { statusCode: 508 });
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }
      break;
    }
  } finally {
    clearTimeout(t);
  }
  const finalUrl = currentUrl;
```
  Delete the old post-fetch "re-validate the final URL's host" block (validation now happens per hop before each fetch). Keep `if (u.protocol...)` early scheme check, the body-reading loop, and the markdown conversion. Remove the now-unused early `await assertPublicHost(u.hostname);` line (the loop's first `validateHop` covers it) and the early allowlist `if (!allowAny && !hostMatchesAllowlist(...))` block (also covered) — OR keep them as a fast pre-check; if kept, they must pass `_lookup`. Simplest: delete both early checks and rely on the loop.

- [ ] **Step 4: Run, expect pass.**
  Run: `node --test test/scraper.test.js`
  Expected: PASS (3 tests).

- [ ] **Step 5: Full suite.**
  Run: `npm test`
  Expected: all pass.

- [ ] **Step 6: Commit.**
  `git add agent/lib/scraper.js agent/test/scraper.test.js`
  `git commit -m "fix(agent): validate every redirect hop to close scraper SSRF gap"`

---

### Task 6: Bind loopback by default + restrict CORS

Default the listen host to `127.0.0.1` (override via `HOST`), and replace `cors({ origin: true, credentials: true })` with a localhost-only allowlist (override via `CORS_ALLOWED_ORIGINS`). Add a startup warning if the agent's own directory sits inside `WORKSPACE_ROOT`.

**Files:**
- Modify: `agent/server.js` (config, `cors(...)`, `app.listen(...)`, banner, startup warning)
- Test: `agent/fixtures/bind-cors-smoke.mjs` (create — integration smoke)

- [ ] **Step 1: Write the smoke fixture** (`agent/fixtures/bind-cors-smoke.mjs`):
```js
// Boots the agent on 127.0.0.1:3748 against a temp workspace and checks CORS.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const ws = mkdtempSync(join(tmpdir(), 'bindcors-'));
const PORT = 3748;
const agent = spawn(process.execPath, [resolve('server.js')], {
  cwd: resolve('.'), env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WORKSPACE_ROOT: ws }, stdio: 'inherit'
});
const base = `http://127.0.0.1:${PORT}`;
async function waitHealth(n = 50) {
  for (let i = 0; i < n; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('agent did not start');
}
try {
  await waitHealth();
  const evil = await fetch(base + '/api/health', { headers: { Origin: 'http://evil.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'evil origin must not be allowed');
  const local = await fetch(base + '/api/health', { headers: { Origin: 'http://localhost:8765' } });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:8765', 'localhost origin must be allowed');
  console.log('bind-cors-smoke: PASS');
} finally {
  agent.kill('SIGINT');
}
```

- [ ] **Step 2: Run, expect failure.**
  Run: `node fixtures/bind-cors-smoke.mjs` (in `agent/`)
  Expected: FAIL — evil origin currently gets `access-control-allow-origin: http://evil.com`.

- [ ] **Step 3: Implement in `server.js`.**
  Add config near the other constants:
```js
const HOST = process.env.HOST || '127.0.0.1';
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const isLocalhostOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o);
```
  Replace `app.use(cors({ origin: true, credentials: true }));` with:
```js
app.use(cors({
  origin(origin, cb) {
    // No Origin header => same-origin / curl / EventSource => allow.
    if (!origin) return cb(null, true);
    if (isLocalhostOrigin(origin) || CORS_ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); // not allowed => no ACAO header => browser blocks
  }
}));
```
  Change `app.listen(PORT, () => {` to `app.listen(PORT, HOST, () => {` and add a `Bind:` line to the banner showing `${HOST}:${PORT}`.
  After `WORKSPACE_ROOT` is resolved, add the warning:
```js
if ((__dirname + path.sep).startsWith(WORKSPACE_ROOT + path.sep) || __dirname === WORKSPACE_ROOT) {
  console.warn('[agent] WARNING: the agent directory is inside WORKSPACE_ROOT — its state files are within the readable workspace. Point WORKSPACE_ROOT at your project instead.');
}
```

- [ ] **Step 4: Run, expect pass.**
  Run: `node fixtures/bind-cors-smoke.mjs`
  Expected: `bind-cors-smoke: PASS`.

- [ ] **Step 5: Confirm unit suite still green.**
  Run: `npm test`
  Expected: all pass.

- [ ] **Step 6: Commit.**
  `git add agent/server.js agent/fixtures/bind-cors-smoke.mjs`
  `git commit -m "fix(agent): bind 127.0.0.1 by default and restrict CORS to localhost origins"`

---

### Task 7: Align documentation + config template with reality

**Files:**
- Modify: `agent/README.md` (Security model bullet on bind; scraper redirect row; add log-tail extension + CORS notes; keystore honesty)
- Modify: `agent/.env.example` (add `HOST`, `LOG_TAIL_EXTENSIONS`, `CORS_ALLOWED_ORIGINS`)
- Modify: `README.md` (Security model paragraph)

- [ ] **Step 1: `agent/.env.example`** — add:
```
# Network binding. Loopback by default; set 0.0.0.0 only if you intentionally
# need LAN/WSL/docker access (understand the exposure first).
HOST=127.0.0.1

# Extra browser origins allowed to call the agent cross-origin (comma-separated).
# localhost / 127.0.0.1 on any port are always allowed. Remote origins are denied.
CORS_ALLOWED_ORIGINS=

# Override which extensions the log-tail endpoints may read (comma-separated).
# Default: .log,.txt,.out,.err
LOG_TAIL_EXTENSIONS=
```

- [ ] **Step 2: `agent/README.md`** — in the Security model section change the bind bullet to state loopback-by-default with `HOST` override; update the scraper "Redirect re-validation" row to "every hop (scheme + allowlist + SSRF) is validated before it is followed (`redirect: 'manual'`)"; add a row noting log-tail endpoints are extension-restricted; add a CORS bullet (localhost-only). In the AI security model, soften the keystore claim to: encryption defends against the keys file leaking *alone*; the salt sits beside it, and `0o600` is a no-op on Windows (NTFS ACLs), so it is not a defense against local read.

- [ ] **Step 3: `README.md`** — in "Security model in one paragraph", change "every file/git operation routes through `withinWorkspace()`" to also mention symlink resolution, replace any 0.0.0.0 implication with loopback default, and note the scraper validates each redirect hop.

- [ ] **Step 4: Commit.**
  `git add agent/README.md agent/.env.example README.md`
  `git commit -m "docs: align security docs and env template with hardened defaults"`

---

### Task 8: Full verification + push + PR

- [ ] **Step 1: Run the complete unit suite.**
  Run: `npm test` (in `agent/`) — expect all green (19 original + redact additions + safety + log-tail-path + scraper).

- [ ] **Step 2: Run the security-relevant smoke fixtures.**
  Run: `node fixtures/bind-cors-smoke.mjs`; then a representative existing one, `node fixtures/brain-git-smoke.mjs`, to confirm no regression in agent boot.

- [ ] **Step 3: Confirm clean audit.**
  Run: `npm audit --omit=dev` — expect 0 vulnerabilities.

- [ ] **Step 4: Review the diff.**
  Run: `git log --oneline main..HEAD` and `git diff --stat main..HEAD`.

- [ ] **Step 5: Push the branch.**
  Run: `git push -u origin harden-audit-findings`
  If auth fails: surface to the user (needs `gh auth login` or `GH_TOKEN`); stop short of inventing credentials.

- [ ] **Step 6: Open a PR.**
  If `gh` is authed: `gh pr create --fill --base main --head harden-audit-findings`.
  Else: print the compare URL `https://github.com/mochifoxstudios/DevOps-Dashboard/compare/main...harden-audit-findings?expand=1` for the user.

---

## Self-review

- **Spec coverage:** every audit finding (#1a, #1b/#2, #3, #4, #5 + keystore honesty, #6, #7, #8) maps to a task above. ✅
- **Placeholder scan:** no TBD/TODO; all code shown. ✅
- **Type/name consistency:** `isLogPath(filePath, exts)`, `assertPublicHost(host, lookup)`, `withinWorkspace(workspaceRoot, candidate)`, `isLocalhostOrigin(o)`, env keys `HOST` / `CORS_ALLOWED_ORIGINS` / `LOG_TAIL_EXTENSIONS` used identically across tasks. ✅
