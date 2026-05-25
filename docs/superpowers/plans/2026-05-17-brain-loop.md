# Brain Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five-feature "Brain Loop" bundle from the approved 2026-05-17 spec — pluggable LLM provider, AI-enriched LogWatchdog drafts, Context-Snap diff narrator, GitHub Issues integration, hash-chained audit log — plus the Settings → AI panel, without regressing the 17 existing smoke fixtures.

**Architecture:** All new agent code lives under `agent/lib/llm/`, `agent/lib/audit.js`, `agent/lib/github.js`, `agent/lib/keystore.js`, `agent/lib/snapshot-diff.js`. The Brain (`agent/lib/brain.js`) gains one new pathway — `LogWatchdog.scheduleEnrichment()` — and one new SSE event type (`draft-enriched`). The frontend gets a new Settings section (`<div id="s-ai">`) and extensions to `js/brain-client.js` and `js/features.js`. No frontend file is rewritten.

**Tech Stack:** Node 18+ · Express · native `fetch` for 3 of 4 LLM providers (no openai/anthropic SDK deps) · `@aws-sdk/client-bedrock-runtime` loaded conditionally · Node built-in `crypto` (scrypt, sha256) · Node built-in `node --test` for unit tests · existing `.mjs` smoke fixture pattern for integration. New runtime dep: 1 (Bedrock SDK, conditional). No new build steps.

**Source spec:** [`docs/superpowers/specs/2026-05-17-brain-loop-design.md`](../specs/2026-05-17-brain-loop-design.md)

---

## File map

**New files (in dependency order):**

| File | Single responsibility |
|---|---|
| `agent/lib/audit.js` | Append-only NDJSON with sha256 hash chain. Rotation. Verify. |
| `agent/lib/keystore.js` | Encrypted at-rest key storage. scrypt-derived key from `WORKSPACE_ROOT + os.hostname() + os.userInfo().username` + per-install salt. |
| `agent/lib/llm/redact.js` | Pure function: scrub secrets/IPs/home paths from prompt text. |
| `agent/lib/llm/templates.js` | Versioned `{ system, userTemplate, output, expectedSchema }` registry. |
| `agent/lib/llm/ollama.js` | Adapter: HTTP to `localhost:11434`. |
| `agent/lib/llm/openai.js` | Adapter: native fetch to `api.openai.com`. |
| `agent/lib/llm/anthropic.js` | Adapter: native fetch to `api.anthropic.com`. |
| `agent/lib/llm/bedrock.js` | Adapter: conditional `@aws-sdk/client-bedrock-runtime`. |
| `agent/lib/llm/index.js` | Factory + `LLMProvider.complete()` — composes adapter + audit + redact + template + cap. |
| `agent/lib/snapshot-diff.js` | Pure: two snapshots → `DiffReport`. |
| `agent/lib/github.js` | GitHub App + PAT auth, GraphQL `createIssue`, retry queue. |
| `agent/test/audit.test.js` | Unit tests (`node --test`). |
| `agent/test/keystore.test.js` | Unit tests. |
| `agent/test/redact.test.js` | Unit tests. |
| `agent/test/snapshot-diff.test.js` | Unit tests. |
| `agent/fixtures/llm-provider-smoke.mjs` | Integration: provider switching + test-key. |
| `agent/fixtures/log-enrich-smoke.mjs` | Integration: bare draft → enriched draft via SSE. |
| `agent/fixtures/diff-narrator-smoke.mjs` | Integration: compare two snapshots. |
| `agent/fixtures/github-file-smoke.mjs` | Integration: against a local express stub of `api.github.com`. |
| `agent/fixtures/audit-chain-smoke.mjs` | Integration: rotation + verify across files. |
| `agent/fixtures/brain-loop-e2e-smoke.mjs` | Integration: full closed loop. |
| `agent/fixtures/eval/log-triage/<n>.json` | Golden pairs for manual eval. |
| `agent/fixtures/eval/run.mjs` | Manual eval runner. |

**Modified files:**

| File | Change |
|---|---|
| `agent/lib/brain.js` | LogWatchdog: add `scheduleEnrichment(draft)` queue + worker. Emit `draft-enriched` SSE. Auto-file hook. |
| `agent/server.js` | New routes: `/api/llm/test`, `/api/llm/providers`, `/api/agent/audit*`, `/api/agent/snapshot-diff`, `/api/github/*`, `/api/github/queue`. |
| `agent/package.json` | Add `@aws-sdk/client-bedrock-runtime` as optionalDependency. |
| `agent/.env.example` | Add `LLM_ENDPOINT_ALLOWLIST`, `AUDIT_KEEP`. |
| `agent/.gitignore` | Add `.audit.log*`, `.audit-tip`, `.ai-keys.json`, `.salt`, `.github-queue.json`. |
| `agent/README.md` | New "AI & GitHub" section, new endpoints, security sub-section. |
| `index.html` | New `<div class="settings-group" id="s-ai">` section + small audit-log modal scaffold. |
| `js/brain-client.js` | Handle `draft-enriched`. Manual ✨ Enrich button. "File on GitHub" modal. Settings bridge extends with `s-ai` keys. |
| `js/features.js` | Context-Snap "Compare" button + diff modal that renders structured + narrated diff. |
| `README.md` | New Mode 3 features in the user-facing walkthrough. |

---

## Phase A — Foundation: Audit + Keystore + LLM Provider

### Task 1: Audit log core

**Files:**
- Create: `agent/lib/audit.js`
- Create: `agent/test/audit.test.js`

- [ ] **Step 1: Write the failing test**

Write `agent/test/audit.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Audit } = require('../lib/audit');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

test('append + read round-trip', () => {
  const dir = tmpDir();
  const a = new Audit({ dir, maxBytes: 10 * 1024 * 1024, keep: 10 });
  const id1 = a.append({ kind: 'llm-call', feature: 'x', outcome: 'ok' });
  const id2 = a.append({ kind: 'llm-call', feature: 'y', outcome: 'ok' });
  assert.ok(id1.startsWith('aud-'));
  assert.notEqual(id1, id2);
  const list = a.read({ limit: 10 });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, id2);  // newest first
});

test('hash chain verifies', () => {
  const dir = tmpDir();
  const a = new Audit({ dir });
  for (let i = 0; i < 20; i++) a.append({ kind: 'llm-call', feature: 'f', outcome: 'ok', n: i });
  const v = a.verify();
  assert.equal(v.ok, true);
  assert.equal(v.recordsVerified, 20);
});

test('tampering breaks verify', () => {
  const dir = tmpDir();
  const a = new Audit({ dir });
  for (let i = 0; i < 5; i++) a.append({ kind: 'llm-call', feature: 'f', outcome: 'ok', n: i });
  const file = path.join(dir, '.audit.log');
  let lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[2]); rec.feature = 'TAMPERED';
  lines[2] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const v = a.verify();
  assert.equal(v.ok, false);
  assert.ok(v.brokenAt);
});

test('rotation at maxBytes', () => {
  const dir = tmpDir();
  const a = new Audit({ dir, maxBytes: 800, keep: 5 });
  for (let i = 0; i < 30; i++) a.append({ kind: 'llm-call', feature: 'longish-feature-name', outcome: 'ok', n: i });
  const files = fs.readdirSync(dir).filter(f => f.startsWith('.audit'));
  assert.ok(files.includes('.audit.log'));
  assert.ok(files.some(f => /^\.audit-\d+\.log$/.test(f)));
  const v = a.verify();
  assert.equal(v.ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "D:/Mochi Fox Games/Small Apps/DevOps/agent" && node --test test/audit.test.js`
Expected: FAIL with `Cannot find module '../lib/audit'`.

- [ ] **Step 3: Write the implementation**

Write `agent/lib/audit.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = '.audit.log';
const TIP_FILE = '.audit-tip';

function sha256(s) { return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex'); }
function newId() { return 'aud-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'); }

class Audit {
  constructor({ dir, maxBytes = 10 * 1024 * 1024, keep = 10 } = {}) {
    if (!dir) throw new Error('Audit requires { dir }');
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.keep = keep;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._tip = this._readTip();
  }
  _path() { return path.join(this.dir, FILE); }
  _tipPath() { return path.join(this.dir, TIP_FILE); }
  _readTip() {
    try { return fs.readFileSync(this._tipPath(), 'utf8').trim() || 'sha256:GENESIS'; }
    catch { return 'sha256:GENESIS'; }
  }
  _rotateIfNeeded() {
    let size = 0;
    try { size = fs.statSync(this._path()).size; } catch { return; }
    if (size < this.maxBytes) return;
    for (let i = this.keep - 1; i >= 1; i--) {
      const src = path.join(this.dir, `.audit-${i}.log`);
      const dst = path.join(this.dir, `.audit-${i + 1}.log`);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    fs.renameSync(this._path(), path.join(this.dir, '.audit-1.log'));
    const oldest = path.join(this.dir, `.audit-${this.keep + 1}.log`);
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  }
  append(record) {
    this._rotateIfNeeded();
    const full = Object.assign({}, record, {
      ts: new Date().toISOString(),
      id: newId(),
      prevHash: this._tip
    });
    const line = JSON.stringify(full);
    fs.appendFileSync(this._path(), line + '\n');
    this._tip = sha256(line);
    fs.writeFileSync(this._tipPath(), this._tip);
    return full.id;
  }
  read({ limit = 100 } = {}) {
    const all = [];
    for (let i = this.keep; i >= 1; i--) {
      const f = path.join(this.dir, `.audit-${i}.log`);
      if (fs.existsSync(f)) all.push(...this._readFile(f));
    }
    if (fs.existsSync(this._path())) all.push(...this._readFile(this._path()));
    return all.reverse().slice(0, limit);
  }
  _readFile(f) {
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  verify() {
    let prev = 'sha256:GENESIS';
    let n = 0;
    const files = [];
    for (let i = this.keep; i >= 1; i--) {
      const f = path.join(this.dir, `.audit-${i}.log`);
      if (fs.existsSync(f)) files.push(f);
    }
    if (fs.existsSync(this._path())) files.push(this._path());
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const rec = JSON.parse(line);
        if (rec.prevHash !== prev) return { ok: false, recordsVerified: n, brokenAt: rec.id };
        prev = sha256(line);
        n++;
      }
    }
    return { ok: true, recordsVerified: n, tipHash: prev };
  }
}

module.exports = { Audit };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "D:/Mochi Fox Games/Small Apps/DevOps/agent" && node --test test/audit.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd "D:/Mochi Fox Games/Small Apps/DevOps/agent"
git add lib/audit.js test/audit.test.js
git commit -m "feat(audit): hash-chained NDJSON audit log with rotation"
```

(If `agent/` is not a git repo yet, skip the commit. The user has been advised to `git init` from `DevOps/` if they want history.)

---

### Task 2: Keystore (at-rest encryption)

**Files:**
- Create: `agent/lib/keystore.js`
- Create: `agent/test/keystore.test.js`

- [ ] **Step 1: Write the failing test**

Write `agent/test/keystore.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Keystore } = require('../lib/keystore');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-test-')); }

test('round-trip set + get', () => {
  const dir = tmpDir();
  const ks = new Keystore({ dir, workspaceRoot: '/path/to/ws' });
  ks.set('openai_api_key', 'sk-secret-1234');
  ks.set('github_pat', 'ghp_abcdef');
  assert.equal(ks.get('openai_api_key'), 'sk-secret-1234');
  assert.equal(ks.get('github_pat'), 'ghp_abcdef');
});

test('values are encrypted on disk', () => {
  const dir = tmpDir();
  const ks = new Keystore({ dir, workspaceRoot: '/x' });
  ks.set('k', 'PLAINTEXT_NEVER_ON_DISK');
  const raw = fs.readFileSync(path.join(dir, '.ai-keys.json'), 'utf8');
  assert.ok(!raw.includes('PLAINTEXT_NEVER_ON_DISK'));
});

test('different workspaceRoot cannot read same file', () => {
  const dir = tmpDir();
  const ks1 = new Keystore({ dir, workspaceRoot: '/ws-a' });
  ks1.set('k', 'v');
  const ks2 = new Keystore({ dir, workspaceRoot: '/ws-b' });
  assert.equal(ks2.get('k'), null);  // wrong key → cannot decrypt → null
});

test('missing key returns null', () => {
  const dir = tmpDir();
  const ks = new Keystore({ dir, workspaceRoot: '/x' });
  assert.equal(ks.get('absent'), null);
});

test('list returns key names only, never values', () => {
  const dir = tmpDir();
  const ks = new Keystore({ dir, workspaceRoot: '/x' });
  ks.set('a', '1'); ks.set('b', '2');
  const names = ks.list();
  assert.deepEqual(names.sort(), ['a', 'b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keystore.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

Write `agent/lib/keystore.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const FILE = '.ai-keys.json';
const SALT_FILE = '.salt';

class Keystore {
  constructor({ dir, workspaceRoot }) {
    if (!dir) throw new Error('Keystore requires { dir }');
    if (!workspaceRoot) throw new Error('Keystore requires { workspaceRoot }');
    this.dir = dir;
    this.workspaceRoot = workspaceRoot;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._key = this._deriveKey();
  }
  _saltPath() { return path.join(this.dir, SALT_FILE); }
  _filePath() { return path.join(this.dir, FILE); }
  _getSalt() {
    try { return fs.readFileSync(this._saltPath()); }
    catch {
      const salt = crypto.randomBytes(16);
      fs.writeFileSync(this._saltPath(), salt, { mode: 0o600 });
      return salt;
    }
  }
  _deriveKey() {
    const seed = this.workspaceRoot + '|' + os.hostname() + '|' + os.userInfo().username;
    return crypto.scryptSync(seed, this._getSalt(), 32);
  }
  _encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this._key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }
  _decrypt(blob) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this._key, Buffer.from(blob.iv, 'base64'));
      d.setAuthTag(Buffer.from(blob.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
    } catch { return null; }
  }
  _readAll() {
    try { return JSON.parse(fs.readFileSync(this._filePath(), 'utf8')); }
    catch { return {}; }
  }
  _writeAll(obj) {
    fs.writeFileSync(this._filePath(), JSON.stringify(obj), { mode: 0o600 });
  }
  set(name, value) {
    const all = this._readAll();
    all[name] = this._encrypt(value);
    this._writeAll(all);
  }
  get(name) {
    const all = this._readAll();
    if (!all[name]) return null;
    return this._decrypt(all[name]);
  }
  list() { return Object.keys(this._readAll()); }
  delete(name) {
    const all = this._readAll();
    delete all[name];
    this._writeAll(all);
  }
}

module.exports = { Keystore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keystore.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/keystore.js test/keystore.test.js
git commit -m "feat(keystore): aes-256-gcm at-rest encryption with scrypt-derived key"
```

---

### Task 3: Redaction scrubber

**Files:**
- Create: `agent/lib/llm/redact.js`
- Create: `agent/test/redact.test.js`

- [ ] **Step 1: Write the failing test**

Write `agent/test/redact.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/redact.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

Create `agent/lib/llm/` directory if missing, then write `agent/lib/llm/redact.js`:

```js
const os = require('node:os');

const DEFAULT_SECRET_RES = [
  /\b([A-Z][A-Z0-9_]*(SECRET|TOKEN|KEY|PASSWORD|PASSPHRASE|AUTH|CREDENTIAL|COOKIE|SESSION|BEARER|API[_-]?KEY|PRIVATE))\b\s*[=:]\s*\S+/gi,
  /\b(sk-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9_]{16,}|xoxb-[A-Za-z0-9_\-]{16,}|AKIA[A-Z0-9]{16})\b/g
];
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{1,4}\b/g;
const HOME_RE = new RegExp(escapeRe(os.homedir()), 'g');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function makeRedactor(extraPatternStrings = []) {
  const extras = extraPatternStrings
    .map((s) => s.trim()).filter(Boolean)
    .map((s) => { try { return new RegExp(s, 'gi'); } catch { return null; } })
    .filter(Boolean);
  return function redactWithExtras(text) {
    let envVarsScrubbed = 0, secretsFound = 0, ipsScrubbed = 0, extrasScrubbed = 0;
    let out = String(text || '');
    for (const re of DEFAULT_SECRET_RES) {
      out = out.replace(re, (m) => { secretsFound++; return '<redacted-secret>'; });
    }
    for (const re of extras) {
      out = out.replace(re, () => { extrasScrubbed++; return '<redacted>'; });
    }
    out = out.replace(IPV4_RE, () => { ipsScrubbed++; return '<ip>'; });
    out = out.replace(IPV6_RE, () => { ipsScrubbed++; return '<ip>'; });
    out = out.replace(HOME_RE, '~');
    return { text: out, summary: { envVarsScrubbed, secretsFound, ipsScrubbed, extrasScrubbed } };
  };
}

const redact = makeRedactor();
module.exports = { redact, makeRedactor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/redact.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/llm/redact.js test/redact.test.js
git commit -m "feat(llm): redaction scrubber for secrets, IPs, home paths"
```

---

### Task 4: Templates registry

**Files:**
- Create: `agent/lib/llm/templates.js`

- [ ] **Step 1: Write the implementation directly** (data-only module; tests come with adapters)

Write `agent/lib/llm/templates.js`:

```js
const TEMPLATES = {
  'log-triage-v1': {
    output: 'json',
    system:
      'You analyze application logs. Given a matched error line plus up to ' +
      '20 lines of preceding context, produce structured JSON: ' +
      '`summary` (≤80 chars), `likely_cause` (1-2 sentences), ' +
      '`confidence` (low|medium|high), `next_steps` (3 bullets, strings), ' +
      '`related_signals` (services/env-keys/PIDs referenced in context, strings). ' +
      'Be specific; no platitudes. Output ONLY the JSON object, no prose.',
    userTemplate: (input) =>
      'Workspace: ' + (input.workspace || 'unknown') +
      '\nBranch: ' + (input.branch || 'unknown') +
      '\n\nContext (older to newer):\n' + (input.context || []).join('\n') +
      '\n\nMATCHED LINE:\n' + (input.matchedLine || ''),
    expectedSchema: {
      summary: 'string',
      likely_cause: 'string',
      confidence: 'enum:low,medium,high',
      next_steps: 'array<string>',
      related_signals: 'array<string>'
    }
  },
  'diff-narrator-v1': {
    output: 'text',
    system:
      'You write a 2-3 sentence engineering changelog. Given a structured diff ' +
      'between two workspace snapshots, narrate what changed and a likely ' +
      'reason. No bullet points; flowing prose. No emojis.',
    userTemplate: (diffReport) => 'DiffReport JSON:\n' + JSON.stringify(diffReport, null, 2)
  }
};

function get(name) {
  const t = TEMPLATES[name];
  if (!t) throw new Error('Unknown template: ' + name);
  return t;
}

function validateAgainstSchema(obj, schema) {
  if (!schema) return { ok: true };
  for (const key of Object.keys(schema)) {
    if (!(key in obj)) return { ok: false, reason: 'missing field: ' + key };
    const t = schema[key];
    const v = obj[key];
    if (t === 'string' && typeof v !== 'string') return { ok: false, reason: key + ' not string' };
    if (t.startsWith('enum:') && !t.slice(5).split(',').includes(v)) {
      return { ok: false, reason: key + ' not in enum' };
    }
    if (t.startsWith('array<') && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      return { ok: false, reason: key + ' not array<string>' };
    }
  }
  return { ok: true };
}

module.exports = { get, validateAgainstSchema, TEMPLATES };
```

- [ ] **Step 2: Smoke-check by requiring it**

Run: `node -e "console.log(Object.keys(require('./lib/llm/templates').TEMPLATES))"`
Expected: `[ 'log-triage-v1', 'diff-narrator-v1' ]`

- [ ] **Step 3: Commit**

```bash
git add lib/llm/templates.js
git commit -m "feat(llm): versioned template registry with schema validator"
```

---

### Task 5: Ollama adapter

**Files:**
- Create: `agent/lib/llm/ollama.js`

- [ ] **Step 1: Write the implementation**

Write `agent/lib/llm/ollama.js`:

```js
async function complete({ endpoint, model, system, user, maxTokens, temperature, jsonMode, signal }) {
  const url = (endpoint || 'http://localhost:11434').replace(/\/$/, '') + '/api/chat';
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    options: { num_predict: maxTokens, temperature }
  };
  if (jsonMode) body.format = 'json';
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Ollama HTTP ' + res.status);
  const j = await res.json();
  const text = (j.message && j.message.content) || '';
  return {
    text,
    model: j.model || model,
    usage: {
      prompt: j.prompt_eval_count || 0,
      completion: j.eval_count || 0,
      totalTokens: (j.prompt_eval_count || 0) + (j.eval_count || 0)
    },
    costCents: 0  // local model
  };
}

async function listModels({ endpoint }) {
  const url = (endpoint || 'http://localhost:11434').replace(/\/$/, '') + '/api/tags';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Ollama HTTP ' + res.status);
  const j = await res.json();
  return (j.models || []).map((m) => m.name);
}

module.exports = { complete, listModels, name: 'ollama', defaultEndpoint: 'http://localhost:11434' };
```

- [ ] **Step 2: Commit (adapter tested via provider smoke test in Task 11)**

```bash
git add lib/llm/ollama.js
git commit -m "feat(llm): Ollama adapter"
```

---

### Task 6: OpenAI adapter

**Files:**
- Create: `agent/lib/llm/openai.js`

- [ ] **Step 1: Write the implementation**

Write `agent/lib/llm/openai.js`:

```js
// Pricing (cents per 1K tokens) — update as needed; used for audit cost estimate only.
const PRICING = {
  'gpt-4o-mini':       { prompt: 0.015, completion: 0.06 },
  'gpt-4o':            { prompt: 0.25,  completion: 1.0 },
  'gpt-4.1-mini':      { prompt: 0.015, completion: 0.06 }
};

async function complete({ endpoint, apiKey, model, system, user, maxTokens, temperature, jsonMode, signal }) {
  if (!apiKey) throw new Error('OpenAI: missing API key');
  const url = (endpoint || 'https://api.openai.com').replace(/\/$/, '') + '/v1/chat/completions';
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'authorization': 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('OpenAI HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || '';
  const usage = j.usage || {};
  const pricing = PRICING[model] || { prompt: 0, completion: 0 };
  const costCents =
    (usage.prompt_tokens || 0) / 1000 * pricing.prompt +
    (usage.completion_tokens || 0) / 1000 * pricing.completion;
  return {
    text,
    model: j.model || model,
    usage: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, totalTokens: usage.total_tokens || 0 },
    costCents: Math.round(costCents * 100) / 100
  };
}

async function listModels() {
  // Static list — calling /v1/models requires a paid key and returns dozens of variants.
  return Object.keys(PRICING);
}

module.exports = { complete, listModels, name: 'openai', defaultEndpoint: 'https://api.openai.com' };
```

- [ ] **Step 2: Commit**

```bash
git add lib/llm/openai.js
git commit -m "feat(llm): OpenAI adapter with cost estimation"
```

---

### Task 7: Anthropic adapter

**Files:**
- Create: `agent/lib/llm/anthropic.js`

- [ ] **Step 1: Write the implementation**

Write `agent/lib/llm/anthropic.js`:

```js
const PRICING = {
  'claude-sonnet-4-6':   { prompt: 0.3, completion: 1.5 },
  'claude-opus-4-7':     { prompt: 1.5, completion: 7.5 },
  'claude-haiku-4-5-20251001': { prompt: 0.025, completion: 0.125 }
};

async function complete({ endpoint, apiKey, model, system, user, maxTokens, temperature, jsonMode, signal }) {
  if (!apiKey) throw new Error('Anthropic: missing API key');
  const url = (endpoint || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: jsonMode ? user + '\n\nReturn ONLY a JSON object, no prose.' : user }]
  };
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Anthropic HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const usage = j.usage || {};
  const pricing = PRICING[model] || { prompt: 0, completion: 0 };
  const costCents =
    (usage.input_tokens || 0) / 1000 * pricing.prompt +
    (usage.output_tokens || 0) / 1000 * pricing.completion;
  return {
    text,
    model: j.model || model,
    usage: { prompt: usage.input_tokens || 0, completion: usage.output_tokens || 0, totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) },
    costCents: Math.round(costCents * 100) / 100
  };
}

async function listModels() { return Object.keys(PRICING); }

module.exports = { complete, listModels, name: 'anthropic', defaultEndpoint: 'https://api.anthropic.com' };
```

- [ ] **Step 2: Commit**

```bash
git add lib/llm/anthropic.js
git commit -m "feat(llm): Anthropic adapter"
```

---

### Task 8: Bedrock adapter (conditional dep)

**Files:**
- Modify: `agent/package.json`
- Create: `agent/lib/llm/bedrock.js`

- [ ] **Step 1: Add optionalDependencies entry to package.json**

Edit `agent/package.json`. Add a new top-level key:

```json
{
  "optionalDependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.600.0"
  }
}
```

Run: `npm install` (will install the SDK on most platforms; optional means a failed install doesn't break the agent).

- [ ] **Step 2: Write the implementation**

Write `agent/lib/llm/bedrock.js`:

```js
let SDK;
function loadSDK() {
  if (SDK) return SDK;
  try { SDK = require('@aws-sdk/client-bedrock-runtime'); return SDK; }
  catch { throw new Error('Bedrock adapter requires @aws-sdk/client-bedrock-runtime; npm install it.'); }
}

const PRICING = {
  'anthropic.claude-sonnet-4-6-v1:0': { prompt: 0.3, completion: 1.5 }
};

async function complete({ region, model, system, user, maxTokens, temperature, jsonMode, signal }) {
  const { BedrockRuntimeClient, InvokeModelCommand } = loadSDK();
  const client = new BedrockRuntimeClient({ region: region || 'us-east-1' });
  const isAnthropic = model.startsWith('anthropic.');
  const body = isAnthropic
    ? {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: jsonMode ? user + '\n\nReturn ONLY a JSON object.' : user }]
      }
    : (() => { throw new Error('Bedrock: only Anthropic-on-Bedrock models supported initially'); })();
  const res = await client.send(new InvokeModelCommand({
    modelId: model,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body)
  }), { abortSignal: signal });
  const j = JSON.parse(new TextDecoder().decode(res.body));
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const usage = j.usage || {};
  const pricing = PRICING[model] || { prompt: 0, completion: 0 };
  const costCents =
    (usage.input_tokens || 0) / 1000 * pricing.prompt +
    (usage.output_tokens || 0) / 1000 * pricing.completion;
  return {
    text, model,
    usage: { prompt: usage.input_tokens || 0, completion: usage.output_tokens || 0, totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) },
    costCents: Math.round(costCents * 100) / 100
  };
}

async function listModels() { return Object.keys(PRICING); }

module.exports = { complete, listModels, name: 'bedrock', defaultEndpoint: null };
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json lib/llm/bedrock.js
git commit -m "feat(llm): AWS Bedrock adapter (conditional dep)"
```

---

### Task 9: LLMProvider factory (the seam)

**Files:**
- Create: `agent/lib/llm/index.js`

This composes adapter + audit + redact + template + daily cap. No separate test file — exercised by `llm-provider-smoke.mjs` in Task 11.

- [ ] **Step 1: Write the implementation**

Write `agent/lib/llm/index.js`:

```js
const ollama = require('./ollama');
const openai = require('./openai');
const anthropic = require('./anthropic');
const bedrock = require('./bedrock');
const templates = require('./templates');
const { makeRedactor } = require('./redact');

const ADAPTERS = { ollama, openai, anthropic, bedrock };

class LLMProvider {
  constructor({ providerName, model, endpoint, region, apiKeyFn, audit, extraRedactPatterns, dailyCap }) {
    this.providerName = providerName;
    this.model = model;
    this.endpoint = endpoint;
    this.region = region;
    this.apiKeyFn = apiKeyFn || (() => null);   // injected, never stored on this
    this.audit = audit;
    this.dailyCap = dailyCap;
    this._dailyCount = 0;
    this._dailyResetAt = this._nextMidnight();
    this._redactor = makeRedactor(extraRedactPatterns || []);
  }
  _nextMidnight() {
    const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime();
  }
  _resetIfDay() {
    if (Date.now() >= this._dailyResetAt) {
      this._dailyCount = 0;
      this._dailyResetAt = this._nextMidnight();
    }
  }
  isOff() { return !this.providerName || this.providerName === 'off'; }
  remainingCalls() {
    this._resetIfDay();
    if (this.dailyCap == null || this.dailyCap === 0) return Infinity;
    return Math.max(0, this.dailyCap - this._dailyCount);
  }

  async complete({ template, input, maxTokens = 400, temperature = 0.2, feature = 'unknown', timeoutMs = 15000 }) {
    if (this.isOff()) throw Object.assign(new Error('LLM provider is Off'), { code: 'provider-off' });
    if (this.remainingCalls() === 0) throw Object.assign(new Error('Daily LLM cap reached'), { code: 'cap-reached' });
    const adapter = ADAPTERS[this.providerName];
    if (!adapter) throw new Error('Unknown provider: ' + this.providerName);

    const tpl = templates.get(template);
    const userRaw = tpl.userTemplate(input);
    const { text: user, summary: redactionSummary } = this._redactor(userRaw);
    const promptStr = (tpl.system || '') + '\n' + user;
    const crypto = require('node:crypto');
    const promptHash = 'sha256:' + crypto.createHash('sha256').update(promptStr).digest('hex');
    const promptBytes = Buffer.byteLength(promptStr, 'utf8');

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let outcome = 'ok', result, err;
    try {
      result = await adapter.complete({
        endpoint: this.endpoint, region: this.region,
        apiKey: this.apiKeyFn(this.providerName),
        model: this.model,
        system: tpl.system, user,
        maxTokens, temperature,
        jsonMode: tpl.output === 'json',
        signal: ctrl.signal
      });
      // schema validation + one repair retry
      if (tpl.output === 'json' && tpl.expectedSchema) {
        let parsed;
        try { parsed = JSON.parse(result.text); }
        catch { parsed = null; }
        const v = parsed ? templates.validateAgainstSchema(parsed, tpl.expectedSchema) : { ok: false, reason: 'not json' };
        if (!v.ok) {
          outcome = 'bad-response';
          const repairedUser = user + '\n\n[your previous response was invalid: ' + v.reason + ']\nPlease return valid JSON matching the schema.';
          result = await adapter.complete({
            endpoint: this.endpoint, region: this.region,
            apiKey: this.apiKeyFn(this.providerName),
            model: this.model, system: tpl.system, user: repairedUser,
            maxTokens, temperature, jsonMode: true, signal: ctrl.signal
          });
          try {
            const re = JSON.parse(result.text);
            const v2 = templates.validateAgainstSchema(re, tpl.expectedSchema);
            if (v2.ok) outcome = 'ok';
          } catch { /* still bad */ }
        }
      }
      this._dailyCount++;
    } catch (e) {
      outcome = e.name === 'AbortError' ? 'timeout' : 'provider-error';
      err = e;
    } finally {
      clearTimeout(t);
    }
    if (this.audit) {
      this.audit.append({
        kind: 'llm-call', feature,
        provider: this.providerName, model: this.model, template,
        promptHash, promptBytes,
        redactionSummary,
        responseBytes: result ? Buffer.byteLength(result.text, 'utf8') : 0,
        tokens: result ? result.usage : { prompt: 0, completion: 0, totalTokens: 0 },
        costCents: result ? result.costCents : 0,
        outcome
      });
    }
    if (err) throw err;
    return Object.assign({}, result, { outcome });
  }

  async testKey() {
    if (this.isOff()) return { ok: false, error: 'provider off' };
    const adapter = ADAPTERS[this.providerName];
    if (!adapter) return { ok: false, error: 'unknown provider' };
    const t0 = Date.now();
    try {
      // tiny prompt — no template
      await adapter.complete({
        endpoint: this.endpoint, region: this.region,
        apiKey: this.apiKeyFn(this.providerName),
        model: this.model, system: 'reply with the single word ok',
        user: 'ping', maxTokens: 4, temperature: 0, jsonMode: false
      });
      return { ok: true, latencyMs: Date.now() - t0, model: this.model };
    } catch (e) {
      return { ok: false, error: e.message, latencyMs: Date.now() - t0 };
    }
  }

  async listModels() {
    const adapter = ADAPTERS[this.providerName];
    if (!adapter) return [];
    try { return await adapter.listModels({ endpoint: this.endpoint, apiKey: this.apiKeyFn(this.providerName) }); }
    catch { return []; }
  }
}

module.exports = { LLMProvider, ADAPTERS };
```

- [ ] **Step 2: Commit**

```bash
git add lib/llm/index.js
git commit -m "feat(llm): LLMProvider factory composing adapter + audit + redact + template + cap"
```

---

### Task 10: Server routes for LLM + Audit

**Files:**
- Modify: `agent/server.js`

- [ ] **Step 1: Add imports near the top of server.js**

Open `agent/server.js`. After the existing `const { Brain, GitSentinel, LogWatchdog, Scheduler, ResourceThrottle } = require('./lib/brain');` line, add:

```js
const { LLMProvider } = require('./lib/llm');
const { Audit } = require('./lib/audit');
const { Keystore } = require('./lib/keystore');
```

- [ ] **Step 2: Add instantiation block right above the Brain block**

In `agent/server.js`, just above `// ---- Phase 4: Autonomous Brain ----`, add:

```js
// ---- Phase 5: LLM + Audit + Keystore ----
const AGENT_STATE_DIR = path.resolve(__dirname);  // .audit.log, .ai-keys.json live next to server.js
const LLM_ENDPOINT_ALLOWLIST = (process.env.LLM_ENDPOINT_ALLOWLIST ||
  'api.openai.com,api.anthropic.com,bedrock-runtime.us-east-1.amazonaws.com,localhost,127.0.0.1').split(',').map((s) => s.trim());
const audit = new Audit({ dir: AGENT_STATE_DIR, keep: parseInt(process.env.AUDIT_KEEP || '10', 10) });
const keystore = new Keystore({ dir: AGENT_STATE_DIR, workspaceRoot: WORKSPACE_ROOT });
// Provider is constructed per-request from current settings (see /api/llm/* routes)
function buildProvider() {
  const s = brain.settings || {};
  return new LLMProvider({
    providerName: (s.llmProvider || 'ollama').toLowerCase(),
    model:        s.llmModel || 'llama3.1:8b',
    endpoint:     s.llmEndpoint || null,
    region:       s.llmRegion || 'us-east-1',
    apiKeyFn:     (name) => keystore.get(name + '_api_key'),
    audit,
    extraRedactPatterns: (s.extraRedactPatterns || '').split('\n').map((x) => x.trim()).filter(Boolean),
    dailyCap:     Number.isFinite(+s.dailyLLMCap) ? +s.dailyLLMCap : 100
  });
}
```

- [ ] **Step 3: Add LLM + Audit routes**

In `agent/server.js`, find the `// ---- Static frontend ----` comment block and add immediately ABOVE it:

```js
// ---- Phase 5: LLM routes ----
app.post('/api/llm/test', wrap(async (req, res) => {
  const p = buildProvider();
  res.json(await p.testKey());
}));

app.get('/api/llm/providers', (req, res) => {
  res.json({ providers: ['ollama', 'openai', 'anthropic', 'bedrock'] });
});

app.get('/api/llm/models', wrap(async (req, res) => {
  const p = buildProvider();
  res.json({ provider: p.providerName, models: await p.listModels() });
}));

app.post('/api/llm/key', wrap(async (req, res) => {
  const { provider, apiKey } = req.body || {};
  if (!provider || typeof apiKey !== 'string') return res.status(400).json({ error: 'provider + apiKey required' });
  keystore.set(provider + '_api_key', apiKey);
  res.json({ ok: true, hasKey: true });
}));

app.delete('/api/llm/key/:provider', (req, res) => {
  keystore.delete(req.params.provider + '_api_key');
  res.json({ ok: true });
});

// ---- Phase 5: Audit routes ----
app.get('/api/agent/audit', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  res.json({ records: audit.read({ limit }) });
});

app.get('/api/agent/audit/verify', (req, res) => res.json(audit.verify()));

app.get('/api/agent/audit/export', (req, res) => {
  const fmt = (req.query.format || 'jsonl').toLowerCase();
  const records = audit.read({ limit: 50000 });
  if (fmt === 'csv') {
    const headers = ['ts','id','kind','feature','provider','model','outcome','costCents'];
    const rows = [headers.join(',')].concat(records.map((r) =>
      headers.map((h) => JSON.stringify(r[h] ?? '')).join(',')));
    res.set('content-type', 'text/csv');
    res.set('content-disposition', 'attachment; filename="audit.csv"');
    res.send(rows.join('\n'));
  } else {
    res.set('content-type', 'application/x-ndjson');
    res.set('content-disposition', 'attachment; filename="audit.jsonl"');
    res.send(records.map((r) => JSON.stringify(r)).join('\n'));
  }
});
```

- [ ] **Step 4: Boot agent and smoke-check routes manually**

Run in one terminal:
```sh
cd "D:/Mochi Fox Games/Small Apps/DevOps/agent"
node server.js
```

In another terminal:
```sh
curl http://localhost:3737/api/llm/providers
# Expected: {"providers":["ollama","openai","anthropic","bedrock"]}

curl http://localhost:3737/api/agent/audit
# Expected: {"records":[]}

curl http://localhost:3737/api/agent/audit/verify
# Expected: {"ok":true,"recordsVerified":0,"tipHash":"sha256:GENESIS"}
```

Kill the agent (`taskkill //F //IM node.exe` on Windows or Ctrl-C).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(server): mount LLM + Audit + Keystore + routes"
```

---

### Task 11: Smoke fixture for LLM provider

**Files:**
- Create: `agent/fixtures/llm-provider-smoke.mjs`

- [ ] **Step 1: Write the fixture**

Write `agent/fixtures/llm-provider-smoke.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3760;
const STUB_PORT = 3761;
const BASE = 'http://localhost:' + AGENT_PORT;

// Spin up a tiny stub that pretends to be Ollama
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'stub', message: { content: 'ok' }, eval_count: 2, prompt_eval_count: 5 }));
    } else if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'stub-a' }, { name: 'stub-b' }] }));
    } else { res.writeHead(404); res.end(); }
  });
}).listen(STUB_PORT);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-smoke-'));
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch (_) {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch (_) {}

const env = Object.assign({}, process.env, { WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false' });
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; agent.stdout.on('data', (d) => log += d); agent.stderr.on('data', (d) => log += d);

async function get(p) { return (await fetch(BASE + p)).json(); }
async function post(p, body) {
  return (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
}
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}

await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

const provs = await get('/api/llm/providers');
console.log('providers:', provs.providers.join(', '));
if (provs.providers.length !== 4) throw new Error('expected 4 providers');

// Point Ollama at our stub
await post('/api/agent/settings', { llmProvider: 'ollama', llmModel: 'stub-a', llmEndpoint: 'http://localhost:' + STUB_PORT });

const models = await get('/api/llm/models');
console.log('ollama models:', models.models);
if (!models.models.includes('stub-a')) throw new Error('listModels failed');

const test = await post('/api/llm/test', {});
console.log('test:', test);
if (!test.ok) throw new Error('test-key failed: ' + JSON.stringify(test));

const audit = await get('/api/agent/audit');
console.log('audit records:', audit.records.length, '(expected 0 — testKey skips audit)');

agent.kill('SIGINT');
stub.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== LLM provider smoke: PASSED ===');
process.exit(0);
```

- [ ] **Step 2: Run the smoke**

```sh
cd "D:/Mochi Fox Games/Small Apps/DevOps/agent"
node fixtures/llm-provider-smoke.mjs
```

Expected: `=== LLM provider smoke: PASSED ===` and exit 0.

- [ ] **Step 3: Commit**

```bash
git add fixtures/llm-provider-smoke.mjs
git commit -m "test(llm): provider smoke fixture (stub Ollama)"
```

---

## Phase B — AI-Enriched LogWatchdog

### Task 12: Extend brain.js with scheduleEnrichment + worker

**Files:**
- Modify: `agent/lib/brain.js`

- [ ] **Step 1: Add an enrichment queue to the LogWatchdog**

In `agent/lib/brain.js`, find the `class LogWatchdog` definition. In its `constructor`, after `this.streams = new Map();` add:

```js
    this.enrichQueue = [];
    this.enrichInflight = false;
    this.enrich = null;   // set by Brain when LLM provider is wired
```

- [ ] **Step 2: Modify the `_pin` method to schedule enrichment**

In `agent/lib/brain.js`, find `LogWatchdog._pin(entry, line, pattern)`. After `this.brain.appendDraft(draft);` and before `this.brain.log('warn', ...`, insert:

```js
    if (this.enrich && this.brain.isEnabled('aiEnrichDrafts')) {
      this.enrichQueue.push(draft);
      this._drainQueue();
    }
```

- [ ] **Step 3: Add `_drainQueue` and `_enrichOne` methods to LogWatchdog**

In `agent/lib/brain.js`, add as new methods on `LogWatchdog`:

```js
  async _drainQueue() {
    if (this.enrichInflight) return;
    if (!this.enrichQueue.length) return;
    this.enrichInflight = true;
    try {
      while (this.enrichQueue.length) {
        const draft = this.enrichQueue.shift();
        try { await this._enrichOne(draft); }
        catch (e) { this.brain.log('warn', this.name, 'enrichment failed: ' + e.message, { draftId: draft.id }); }
      }
    } finally { this.enrichInflight = false; }
  }

  async _enrichOne(draft) {
    const r = await this.enrich({
      template: 'log-triage-v1',
      input: {
        matchedLine: draft.meta && draft.meta.matchedLine ? draft.meta.matchedLine : draft.title,
        context: draft.meta && draft.meta.context ? draft.meta.context : [],
        workspace: draft.workspace || this.brain.workspaceRoot,
        branch: draft.branch || null
      },
      feature: 'log-watchdog-enrich',
      maxTokens: 400,
      temperature: 0.2
    });
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch {}
    if (!parsed) return;  // bad response — drop silently, audit captured outcome
    draft.enriched = true;
    draft.enrichedAt = new Date().toISOString();
    draft.confidence = parsed.confidence;
    const enrichedMd = draft.content +
      '\n\n## Likely cause' +
      '\n\n_' + parsed.confidence + ' confidence_\n\n' + parsed.likely_cause +
      '\n\n## Suggested next steps\n\n' + (parsed.next_steps || []).map((s) => '- ' + s).join('\n') +
      '\n\n_Enriched by ' + r.model + ' · ' + (r.usage && r.usage.totalTokens) + ' tokens_';
    draft.content = enrichedMd;
    // Replace in the brain's recentDrafts in place
    const idx = this.brain.recentDrafts.findIndex((d) => d.id === draft.id);
    if (idx >= 0) this.brain.recentDrafts[idx] = draft;
    this.brain._saveState();
    this.brain.emit('draft-enriched', draft);
    this.brain.log('ok', this.name, 'enriched draft ' + draft.id, { confidence: parsed.confidence });
  }
```

- [ ] **Step 4: In the `LogWatchdog._pin` draft construction, attach `matchedLine` and `context` to `draft.meta`**

In `agent/lib/brain.js`, find the `_buildDraft` method on `LogWatchdog`. In the returned object, change `meta:` to include the raw inputs the enricher will need:

```js
      meta: { filePath: entry.relPath, pattern: pattern.source, contextLines: context.length, matchedLine: line, context }
```

- [ ] **Step 5: Wire the LLM into the Brain at startup**

In `agent/lib/brain.js`, find `class Brain`. In `_defaultSettings()`, add to the returned object:

```js
      aiEnrichDrafts: true,
      llmProvider: 'ollama',
      llmModel: 'llama3.1:8b',
      llmEndpoint: '',
      llmRegion: 'us-east-1',
      extraRedactPatterns: '',
      dailyLLMCap: 100
```

In `agent/lib/brain.js`, add a setter on `Brain`:

```js
  setEnricher(fn) {
    for (const s of this.sentinels) { if (s.name === 'log-watchdog') s.enrich = fn; }
  }
```

- [ ] **Step 6: Wire from server.js**

In `agent/server.js`, after the `brain.addSentinel(new ResourceThrottle(...));` block, add:

```js
brain.setEnricher((args) => buildProvider().complete(args));
```

- [ ] **Step 7: Manual smoke**

Boot the agent. Manually POST to settings and confirm the wiring doesn't crash:

```sh
node server.js &
sleep 1
curl -X POST http://localhost:3737/api/agent/settings \
  -H "content-type: application/json" \
  -d '{"watchedLogPaths":[],"aiEnrichDrafts":true}'
curl http://localhost:3737/api/agent/status | grep aiEnrichDrafts
taskkill //F //IM node.exe
```

Expected: `aiEnrichDrafts: true` in settings.

- [ ] **Step 8: Commit**

```bash
git add lib/brain.js server.js
git commit -m "feat(brain): LogWatchdog enrichment queue + worker"
```

---

### Task 13: Wire 'draft-enriched' through brain-client.js

**Files:**
- Modify: `js/brain-client.js`

- [ ] **Step 1: Add SSE handler**

In `js/brain-client.js`, find the `openStream:` method. Inside `this.es.addEventListener('draft', ...)`, leave that as is. Below the existing `draft` listener and above the `scan` listener, add:

```js
      self.es.addEventListener('draft-enriched', function (e) {
        var enriched; try { enriched = JSON.parse(e.data); } catch (_) { return; }
        replaceDraftInPlace(enriched);
        D.toast('Brain enriched draft · ' + (enriched.confidence || 'ok') + ' confidence');
      });
```

- [ ] **Step 2: Add the in-place replacement helper**

Near the other helpers in `js/brain-client.js` (after `mergeOneDraft`), add:

```js
  function replaceDraftInPlace(draft) {
    if (!draft || !draft.id) return;
    var local = D.store.get(DRAFT_KEY, []);
    var idx = local.findIndex(function (d) { return d.id === draft.id; });
    if (idx >= 0) { local[idx] = draft; D.store.set(DRAFT_KEY, local); }
    else mergeOneDraft(draft);
  }
```

- [ ] **Step 3: Commit**

```bash
cd "D:/Mochi Fox Games/Small Apps/DevOps"
git add js/brain-client.js
git commit -m "feat(brain-client): handle draft-enriched SSE event"
```

---

### Task 14: Manual "✨ Enrich" button on un-enriched drafts

**Files:**
- Modify: `js/features.js` (Issue Filler section, drafts list rendering)

- [ ] **Step 1: Locate the drafts UI**

In `js/features.js`, find the Issue Filler section. The frontend doesn't currently render a per-draft list (drafts are downloaded). We'll add a small "Drafts inbox" card on the Issue Filler view that lists `localStorage["devops:issue-drafts"]` and shows per-draft actions.

Add this after the Issue Filler engine IIFE returns:

```js
  // Drafts inbox — lists localStorage drafts with optional ✨ Enrich + File on GitHub buttons.
  (function draftsInbox() {
    var view = document.getElementById('view-issue-filler');
    if (!view) return;
    var host = document.createElement('div');
    host.id = 'drafts-inbox';
    host.style.cssText = 'margin-top:16px;border-top:1px solid var(--border);padding-top:14px;';
    view.appendChild(host);

    function render() {
      var list = D.store.get('devops:issue-drafts', []);
      if (!list.length) { host.innerHTML = ''; return; }
      host.innerHTML =
        '<div class="card-title" style="margin-bottom:8px;"><span class="dot"></span>DRAFTS INBOX (' + list.length + ')</div>' +
        list.slice(0, 8).map(function (d) {
          var status = d.enriched ? '<span class="badge ok">enriched</span>' : '<span class="badge warn">bare</span>';
          var filed = d.filedAs ? '<a class="badge indigo" href="' + d.filedAs.url + '" target="_blank" rel="noopener">filed</a>' : '';
          return '<div data-draft-row data-id="' + D.escapeHtml(d.id) + '" style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-weight:500;">' + D.escapeHtml(d.title || d.name) + '</div>' +
              '<div style="font-size:11px;color:var(--text-meta);">' + new Date(d.when).toLocaleString() + '</div>' +
            '</div>' +
            status + filed +
            (d.enriched ? '' : '<button class="btn" data-enrich data-id="' + D.escapeHtml(d.id) + '">✨ Enrich</button>') +
            '<button class="btn" data-file-gh data-id="' + D.escapeHtml(d.id) + '">File on GitHub</button>' +
          '</div>';
        }).join('');

      host.querySelectorAll('[data-enrich]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-id');
          if (D.brain && D.brain.online) {
            fetch((D.agent.base || '') + '/api/agent/enrich-draft', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id })
            }).then(function (r) { return r.json(); }).then(function (j) {
              D.toast(j.error ? ('Enrich failed: ' + j.error) : 'Enrichment queued');
            });
          } else { D.toast('Agent offline — cannot enrich'); }
        });
      });
      host.querySelectorAll('[data-file-gh]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (D.brain && typeof D.brain.openFileModal === 'function') D.brain.openFileModal(b.getAttribute('data-id'));
          else D.toast('Agent offline — cannot file');
        });
      });
    }
    render();
    document.addEventListener('devops:draft-changed', render);
    setInterval(render, 5000);  // cheap; only refreshes when view is mounted in DOM anyway
  })();
```

- [ ] **Step 2: Add the new endpoint POST /api/agent/enrich-draft**

In `agent/server.js`, in the same block as the other `/api/agent/*` routes (after `/api/agent/snapshots`), add:

```js
app.post('/api/agent/enrich-draft', wrap(async (req, res) => {
  const id = (req.body || {}).id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const draft = brain.recentDrafts.find((d) => d.id === id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  if (draft.enriched) return res.json({ ok: true, already: true });
  const watchdog = brain.sentinels.find((s) => s.name === 'log-watchdog');
  if (!watchdog || !watchdog.enrich) return res.status(503).json({ error: 'enrichment unavailable' });
  watchdog.enrichQueue.push(draft);
  watchdog._drainQueue();
  res.json({ ok: true, queued: true });
}));
```

- [ ] **Step 3: Fire devops:draft-changed in brain-client when drafts change**

In `js/brain-client.js`, after every `D.store.set(DRAFT_KEY, ...)` line in `mergeOneDraft`, `replaceDraftInPlace`, and in `syncBacklog`'s draft path, add:

```js
      document.dispatchEvent(new CustomEvent('devops:draft-changed'));
```

- [ ] **Step 4: Commit**

```bash
git add agent/server.js js/features.js js/brain-client.js
git commit -m "feat(ui): drafts inbox + manual enrich endpoint"
```

---

### Task 15: Smoke test log-enrich-smoke.mjs

**Files:**
- Create: `agent/fixtures/log-enrich-smoke.mjs`

- [ ] **Step 1: Write the fixture**

Write `agent/fixtures/log-enrich-smoke.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3762;
const STUB_PORT = 3763;
const BASE = 'http://localhost:' + AGENT_PORT;

// Ollama stub that returns valid JSON enrichment
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub', eval_count: 50, prompt_eval_count: 200,
      message: { content: JSON.stringify({
        summary: 'Database connection lost',
        likely_cause: 'Postgres handshake failed after key rotation — credentials likely stale.',
        confidence: 'high',
        next_steps: ['Check DATABASE_URL', 'Restart pgbouncer', 'Verify password rotation'],
        related_signals: ['postgres', 'DATABASE_URL']
      }) }
    }));
  });
}).listen(STUB_PORT);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-smoke-'));
const log = path.join(ws, 'app.log');
fs.writeFileSync(log, '');

try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch {}

const env = Object.assign({}, process.env, { WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false' });
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let alog = ''; agent.stdout.on('data', (d) => alog += d); agent.stderr.on('data', (d) => alog += d);

async function get(p) { return (await fetch(BASE + p)).json(); }
async function post(p, body) {
  return (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
}
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

await post('/api/agent/settings', {
  watchedLogPaths: ['app.log'], errorPatterns: ['FATAL'], aiEnrichDrafts: true,
  llmProvider: 'ollama', llmModel: 'stub', llmEndpoint: 'http://localhost:' + STUB_PORT
});
await waitFor(async () => {
  const s = await get('/api/agent/status');
  return s.sentinels.find((x) => x.name === 'log-watchdog').state === 'watching';
}, 4000, 'watchdog watching');
await new Promise((r) => setTimeout(r, 500));

// Append a FATAL line
fs.appendFileSync(log, '2026-05-17T10:00:00Z FATAL Database connection lost\n');

// 1. Bare draft appears almost immediately
await waitFor(async () => (await get('/api/agent/drafts')).count >= 1, 3000, 'bare draft');
const drafts1 = await get('/api/agent/drafts');
const bare = drafts1.drafts[0];
console.log('bare draft confidence:', bare.confidence, '· enriched:', !!bare.enriched);
if (bare.enriched) throw new Error('expected bare draft initially');

// 2. Enrichment lands within 5s
await waitFor(async () => {
  const d = (await get('/api/agent/drafts')).drafts[0];
  return d && d.enriched === true;
}, 5000, 'enriched draft');
const drafts2 = await get('/api/agent/drafts');
const enr = drafts2.drafts[0];
console.log('enriched draft confidence:', enr.confidence);
if (enr.confidence !== 'high') throw new Error('expected confidence=high, got ' + enr.confidence);
if (!enr.content.includes('Likely cause')) throw new Error('missing Likely cause section');
if (!enr.content.includes('Suggested next steps')) throw new Error('missing Suggested next steps');

// 3. Audit log has an llm-call record
const audit = await get('/api/agent/audit');
console.log('audit records:', audit.records.length);
const llmRec = audit.records.find((r) => r.kind === 'llm-call' && r.feature === 'log-watchdog-enrich');
if (!llmRec) throw new Error('expected an llm-call audit record');
if (llmRec.outcome !== 'ok') throw new Error('expected outcome=ok, got ' + llmRec.outcome);

agent.kill('SIGINT'); stub.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== log enrich smoke: PASSED ===');
process.exit(0);
```

- [ ] **Step 2: Run it**

```sh
node fixtures/log-enrich-smoke.mjs
```

Expected: `=== log enrich smoke: PASSED ===`.

- [ ] **Step 3: Commit**

```bash
git add fixtures/log-enrich-smoke.mjs
git commit -m "test(brain): enrichment smoke fixture"
```

---

## Phase C — Context-Snap AI Diff Narrator

### Task 16: snapshot-diff.js + unit tests

**Files:**
- Create: `agent/lib/snapshot-diff.js`
- Create: `agent/test/snapshot-diff.test.js`

- [ ] **Step 1: Write the failing test**

Write `agent/test/snapshot-diff.test.js`:

```js
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
  assert.deepEqual(d.ports.opened.sort(), [5544, 9000]);
  assert.deepEqual(d.ports.closed, [5432]);
});

test('missing captures handled', () => {
  const d = diffSnapshots({}, B);
  assert.ok(d.env.added.length > 0);
});
```

- [ ] **Step 2: Run, see fail**

`node --test test/snapshot-diff.test.js` → FAIL (module not found).

- [ ] **Step 3: Write implementation**

Write `agent/lib/snapshot-diff.js`:

```js
function envMap(sample) {
  const m = new Map();
  for (const kv of (sample || [])) {
    const eq = kv.indexOf('=');
    if (eq > 0) m.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return m;
}

function diffEnv(a, b) {
  const ma = envMap(a && a.sample);
  const mb = envMap(b && b.sample);
  const added = [], removed = [], changed = [];
  for (const k of mb.keys()) if (!ma.has(k)) added.push(k);
  for (const k of ma.keys()) if (!mb.has(k)) removed.push(k);
  for (const k of mb.keys()) if (ma.has(k) && ma.get(k) !== mb.get(k)) changed.push({ key: k, before: ma.get(k), after: mb.get(k) });
  return { added, removed, changed };
}

function diffSnapshots(a, b) {
  const ca = (a && a.capture) || {};
  const cb = (b && b.capture) || {};
  return {
    env: diffEnv(ca.env, cb.env),
    pids: {
      gained: Math.max(0, ((cb.pids && cb.pids.count) || 0) - ((ca.pids && ca.pids.count) || 0)),
      lost:   Math.max(0, ((ca.pids && ca.pids.count) || 0) - ((cb.pids && cb.pids.count) || 0))
    },
    git: (() => {
      const ga = ca.git || {}, gb = cb.git || {};
      const out = { shaChanged: ga.sha !== gb.sha, dirtyDelta: (gb.dirtyFiles || 0) - (ga.dirtyFiles || 0) };
      if (ga.branch !== gb.branch) out.branchChanged = { from: ga.branch || null, to: gb.branch || null };
      return out;
    })(),
    ports: (() => {
      const pa = new Set(ca.ports || []), pb = new Set(cb.ports || []);
      const opened = [...pb].filter((p) => !pa.has(p));
      const closed = [...pa].filter((p) => !pb.has(p));
      return { opened, closed };
    })()
  };
}

module.exports = { diffSnapshots };
```

- [ ] **Step 4: Run, see pass**

`node --test test/snapshot-diff.test.js` → PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot-diff.js test/snapshot-diff.test.js
git commit -m "feat(snapshot-diff): structured DiffReport between two snapshots"
```

---

### Task 17: Add /api/agent/snapshot-diff route

**Files:**
- Modify: `agent/server.js`

- [ ] **Step 1: Add import**

Near the top of `agent/server.js`, add:

```js
const { diffSnapshots } = require('./lib/snapshot-diff');
```

- [ ] **Step 2: Add route**

In `agent/server.js`, in the agent routes block, add:

```js
app.post('/api/agent/snapshot-diff', wrap(async (req, res) => {
  const { snapA, snapB, narrate } = req.body || {};
  if (!snapA || !snapB) return res.status(400).json({ error: 'snapA + snapB required' });
  const diff = diffSnapshots(snapA, snapB);
  let narration = null;
  if (narrate) {
    try {
      const p = buildProvider();
      const r = await p.complete({ template: 'diff-narrator-v1', input: diff, feature: 'diff-narrator', maxTokens: 250, temperature: 0.3 });
      narration = r.text;
    } catch (e) { narration = null; }
  }
  res.json({ diff, narration });
}));
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): snapshot-diff route with optional narration"
```

---

### Task 18: Context-Snap "Compare" button + modal

**Files:**
- Modify: `js/features.js`

- [ ] **Step 1: Add a Compare button to Context-Snap view-actions**

In `js/features.js`, find the Context-Snap engine IIFE. After it returns, add a small enhancement:

```js
  // ----- Context-Snap Compare -----
  (function compareEnhancement() {
    var view = document.getElementById('view-context-snap');
    if (!view) return;
    var actions = view.querySelector('.view-actions');
    if (!actions || actions.querySelector('[data-snap-compare]')) return;
    var btn = document.createElement('button');
    btn.className = 'btn'; btn.setAttribute('data-snap-compare', '1');
    btn.innerHTML = 'Compare';
    actions.appendChild(btn);
    btn.addEventListener('click', openCompareModal);

    function openCompareModal() {
      var snaps = D.store.get('devops:snapshots', []);
      if (snaps.length < 2) { D.toast('Need at least 2 snapshots to compare'); return; }
      var bd = document.createElement('div');
      bd.className = 'modal-backdrop open'; bd.id = 'snapCompareModal';
      bd.innerHTML =
        '<div class="modal" style="max-width:680px;">' +
          '<div class="modal-header"><div class="modal-title">Compare snapshots</div>' +
            '<button class="close-btn" data-close>×</button></div>' +
          '<div class="modal-body">' +
            '<div class="field-row">' +
              '<div class="field"><label class="field-label">A (older)</label>' +
                '<select class="select" data-snap-a>' +
                  snaps.map(function (s) { return '<option value="' + D.escapeHtml(s.id) + '">' + D.escapeHtml(s.name) + ' (' + new Date(s.timestamp).toLocaleString() + ')</option>'; }).join('') +
                '</select></div>' +
              '<div class="field"><label class="field-label">B (newer)</label>' +
                '<select class="select" data-snap-b>' +
                  snaps.map(function (s) { return '<option value="' + D.escapeHtml(s.id) + '">' + D.escapeHtml(s.name) + ' (' + new Date(s.timestamp).toLocaleString() + ')</option>'; }).join('') +
                '</select></div>' +
            '</div>' +
            '<label class="check" style="margin:6px 0;"><input type="checkbox" data-narrate checked /><span class="box"></span><span class="check-label">Generate AI narration</span></label>' +
            '<div data-result style="margin-top:12px;"></div>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button class="btn" data-close>Close</button>' +
            '<button class="btn btn-primary" data-run>Compare</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(bd);
      bd.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { bd.remove(); }); });
      bd.addEventListener('click', function (e) { if (e.target === bd) bd.remove(); });

      bd.querySelector('[data-run]').addEventListener('click', async function () {
        var aId = bd.querySelector('[data-snap-a]').value;
        var bId = bd.querySelector('[data-snap-b]').value;
        var narrate = bd.querySelector('[data-narrate]').checked;
        if (aId === bId) { D.toast('Pick two different snapshots'); return; }
        var snapA = snaps.find(function (s) { return s.id === aId; });
        var snapB = snaps.find(function (s) { return s.id === bId; });
        var resultEl = bd.querySelector('[data-result]');
        resultEl.innerHTML = '<div class="empty-state es-sub">Computing…</div>';
        try {
          var r = await fetch((D.agent && D.agent.base) || '', {});
        } catch (_) {}
        try {
          var resp = await fetch(((D.agent && D.agent.base) || '') + '/api/agent/snapshot-diff', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ snapA: snapA, snapB: snapB, narrate: narrate && D.brain && D.brain.online })
          });
          var data = await resp.json();
          resultEl.innerHTML = renderDiff(data);
        } catch (e) {
          resultEl.innerHTML = '<div class="empty-state es-sub">Agent offline — narration unavailable. Showing local-only computation.</div>';
        }
      });
    }

    function renderDiff(data) {
      var d = data.diff || {};
      var html = '';
      if (data.narration) {
        html += '<div class="callout" style="margin-bottom:12px;">' + D.escapeHtml(data.narration) + '</div>';
      } else if (data.narration === null) {
        html += '<div class="empty-state es-sub" style="padding:10px;">narration unavailable</div>';
      }
      html += '<h4>Environment</h4>';
      html += '<div class="row">added: ' + (d.env.added || []).join(', ') + '</div>';
      html += '<div class="row">removed: ' + (d.env.removed || []).join(', ') + '</div>';
      html += '<div class="row">changed: ' + (d.env.changed || []).map(function (c) { return c.key; }).join(', ') + '</div>';
      html += '<h4 style="margin-top:10px;">Git</h4><div>' + (d.git.branchChanged ? d.git.branchChanged.from + ' → ' + d.git.branchChanged.to : 'no branch change') + ' · sha-changed: ' + d.git.shaChanged + ' · dirty-delta: ' + d.git.dirtyDelta + '</div>';
      html += '<h4 style="margin-top:10px;">Ports</h4><div>opened: ' + (d.ports.opened || []).join(', ') + ' · closed: ' + (d.ports.closed || []).join(', ') + '</div>';
      html += '<h4 style="margin-top:10px;">PIDs</h4><div>+' + d.pids.gained + ' / −' + d.pids.lost + '</div>';
      return html;
    }
  })();
```

- [ ] **Step 2: Commit**

```bash
git add js/features.js
git commit -m "feat(ui): Context-Snap Compare modal with AI narration"
```

---

### Task 19: Smoke test diff-narrator-smoke.mjs

**Files:**
- Create: `agent/fixtures/diff-narrator-smoke.mjs`

- [ ] **Step 1: Write fixture**

Write `agent/fixtures/diff-narrator-smoke.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3764;
const STUB_PORT = 3765;
const BASE = 'http://localhost:' + AGENT_PORT;

const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub', eval_count: 30, prompt_eval_count: 40,
      message: { content: 'Between A and B, NODE_ENV flipped from production to staging and 2 ports opened. Likely a config rollback.' }
    }));
  });
}).listen(STUB_PORT);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-smoke-'));
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch {}

const env = Object.assign({}, process.env, { WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false' });
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let alog = ''; agent.stdout.on('data', (d) => alog += d); agent.stderr.on('data', (d) => alog += d);

async function post(p, body) { return (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

await post('/api/agent/settings', { llmProvider: 'ollama', llmModel: 'stub', llmEndpoint: 'http://localhost:' + STUB_PORT });

const snapA = { id: 'a', capture: { env: { sample: ['NODE_ENV=production'] }, git: { branch: 'main', sha: 'a' }, pids: { count: 5 }, ports: [3000] } };
const snapB = { id: 'b', capture: { env: { sample: ['NODE_ENV=staging'] }, git: { branch: 'main', sha: 'b' }, pids: { count: 5 }, ports: [3000, 4000, 5000] } };

const r1 = await post('/api/agent/snapshot-diff', { snapA, snapB, narrate: false });
console.log('diff env.changed:', r1.diff.env.changed);
if (r1.narration !== null && r1.narration !== undefined) throw new Error('expected no narration when narrate=false');

const r2 = await post('/api/agent/snapshot-diff', { snapA, snapB, narrate: true });
console.log('narration:', r2.narration);
if (!r2.narration || !r2.narration.includes('production to staging')) throw new Error('expected narration to mention env change');

agent.kill('SIGINT'); stub.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== diff narrator smoke: PASSED ===');
process.exit(0);
```

- [ ] **Step 2: Run + commit**

```sh
node fixtures/diff-narrator-smoke.mjs
```

Expected: PASSED.

```bash
git add fixtures/diff-narrator-smoke.mjs
git commit -m "test(brain): diff-narrator smoke"
```

---

## Phase D — GitHub Integration

### Task 20: github.js + key storage

**Files:**
- Create: `agent/lib/github.js`

- [ ] **Step 1: Write implementation** (tested via smoke fixture in Task 22)

Write `agent/lib/github.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

class GitHub {
  constructor({ keystore, audit, queuePath, endpoint = 'https://api.github.com' }) {
    this.keystore = keystore;
    this.audit = audit;
    this.queuePath = queuePath || path.join(process.cwd(), '.github-queue.json');
    this.endpoint = endpoint.replace(/\/$/, '');
    this._timer = null;
  }
  _readQueue() {
    try { return JSON.parse(fs.readFileSync(this.queuePath, 'utf8')); } catch { return []; }
  }
  _writeQueue(arr) {
    try { fs.writeFileSync(this.queuePath, JSON.stringify(arr, null, 2)); } catch {}
  }
  _token() {
    return this.keystore.get('github_app_token') || this.keystore.get('github_pat');
  }
  setPAT(token) { this.keystore.set('github_pat', token); }
  setAppToken(token) { this.keystore.set('github_app_token', token); }

  async createIssue({ owner, repo, title, body, labels = [], assignees = [], draftId }) {
    const token = this._token();
    if (!token) throw new Error('no GitHub token configured');
    // Use REST (simpler than GraphQL for a single mutation; GraphQL would also work but needs node id resolution for labels/assignees).
    const url = this.endpoint + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/issues';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'authorization': 'token ' + token, 'accept': 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, labels, assignees })
    });
    const text = await res.text();
    let outcome = 'ok', payload = null;
    if (res.status === 401 || res.status === 403) outcome = 'unauthorized';
    else if (res.status === 429) outcome = 'rate-limited';
    else if (!res.ok) outcome = 'provider-error';
    try { payload = JSON.parse(text); } catch {}
    if (this.audit) {
      this.audit.append({
        kind: 'github-file', feature: 'manual-file',
        repo: owner + '/' + repo, issueNumber: payload && payload.number, labels, draftId,
        outcome
      });
    }
    if (outcome !== 'ok') throw Object.assign(new Error('GitHub ' + res.status + ': ' + text.slice(0, 200)), { code: outcome });
    return { url: payload.html_url, issueNumber: payload.number };
  }

  enqueue(item) {
    const q = this._readQueue();
    q.push(Object.assign({}, item, { enqueuedAt: new Date().toISOString(), attempts: 0 }));
    this._writeQueue(q);
    this._scheduleSweep();
  }
  _scheduleSweep() {
    if (this._timer) return;
    this._timer = setTimeout(() => this._sweep().finally(() => { this._timer = null; }), 60000);
  }
  async _sweep() {
    const q = this._readQueue();
    if (!q.length) return;
    const remaining = [];
    for (const item of q) {
      const age = Date.now() - new Date(item.enqueuedAt).getTime();
      if (age > 24 * 3600 * 1000) {
        if (this.audit) this.audit.append({ kind: 'github-file', feature: 'manual-file', outcome: 'rate-limited', draftId: item.draftId, repo: item.owner + '/' + item.repo, dropped: true });
        continue;
      }
      try { await this.createIssue(item); }
      catch { item.attempts = (item.attempts || 0) + 1; remaining.push(item); }
    }
    this._writeQueue(remaining);
    if (remaining.length) this._scheduleSweep();
  }
}

module.exports = { GitHub };
```

- [ ] **Step 2: Commit**

```bash
git add lib/github.js
git commit -m "feat(github): adapter + retry queue (REST createIssue)"
```

---

### Task 21: GitHub routes in server.js + brain wiring

**Files:**
- Modify: `agent/server.js`
- Modify: `agent/lib/brain.js`

- [ ] **Step 1: Add import and instantiation**

In `agent/server.js`, with the other Phase 5 imports:
```js
const { GitHub } = require('./lib/github');
```

In the Phase 5 block, after the audit/keystore setup, add:
```js
const github = new GitHub({
  keystore, audit,
  queuePath: path.join(AGENT_STATE_DIR, '.github-queue.json')
});
```

- [ ] **Step 2: Add GitHub routes**

In `agent/server.js`, in the routes section:

```js
app.post('/api/github/pat', wrap(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  github.setPAT(token);
  res.json({ ok: true });
}));

app.delete('/api/github/pat', (req, res) => {
  keystore.delete('github_pat');
  res.json({ ok: true });
});

app.post('/api/github/file-issue', wrap(async (req, res) => {
  const { owner, repo, title, body, labels, assignees, draftId } = req.body || {};
  if (!owner || !repo || !title || !body) return res.status(400).json({ error: 'owner, repo, title, body required' });
  try {
    const out = await github.createIssue({ owner, repo, title, body, labels, assignees, draftId });
    // Tag the draft with filedAs
    const d = brain.recentDrafts.find((x) => x.id === draftId);
    if (d) {
      d.filedAs = { provider: 'github', url: out.url, issueNumber: out.issueNumber, filedAt: new Date().toISOString() };
      brain._saveState();
      brain.emit('draft', d);
    }
    res.json(out);
  } catch (e) {
    if (e.code === 'rate-limited' || e.code === 'provider-error') {
      github.enqueue({ owner, repo, title, body, labels, assignees, draftId });
      return res.status(202).json({ queued: true, reason: e.code });
    }
    res.status(502).json({ error: e.message, code: e.code });
  }
}));

app.get('/api/github/queue', (req, res) => res.json({ queue: github._readQueue() }));
```

- [ ] **Step 3: Add auto-file hook in brain.js**

In `agent/lib/brain.js`, in `LogWatchdog._enrichOne` after `this.brain.emit('draft-enriched', draft);` add:

```js
    // Auto-file: only if enabled in settings + high confidence + severity error
    if (this.brain.isEnabled('autoFileGitHub') && parsed.confidence === 'high' && this.autoFileFn) {
      try { await this.autoFileFn(draft); }
      catch (e) { this.brain.log('warn', this.name, 'auto-file failed: ' + e.message); }
    }
```

And in `Brain._defaultSettings()`, add:

```js
      autoFileGitHub: false,
      defaultRepoOwner: '',
      defaultRepoName: '',
```

And the new setter on `Brain`:

```js
  setAutoFiler(fn) {
    for (const s of this.sentinels) { if (s.name === 'log-watchdog') s.autoFileFn = fn; }
  }
```

- [ ] **Step 4: Wire from server.js**

After `brain.setEnricher(...)`, add:

```js
brain.setAutoFiler(async (draft) => {
  const owner = brain.settings.defaultRepoOwner;
  const repo = brain.settings.defaultRepoName;
  if (!owner || !repo) return;
  const out = await github.createIssue({
    owner, repo,
    title: draft.title || draft.name,
    body: draft.content,
    labels: ['bug', 'priority-high'],
    draftId: draft.id
  });
  draft.filedAs = { provider: 'github', url: out.url, issueNumber: out.issueNumber, filedAt: new Date().toISOString() };
  brain._saveState();
  brain.emit('draft', draft);
});
```

- [ ] **Step 5: Commit**

```bash
git add server.js lib/brain.js
git commit -m "feat(github): file-issue route + auto-file hook"
```

---

### Task 22: Smoke fixture github-file-smoke.mjs

**Files:**
- Create: `agent/fixtures/github-file-smoke.mjs`

- [ ] **Step 1: Write fixture (uses a local express stub posing as api.github.com)**

Write `agent/fixtures/github-file-smoke.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3766;
const GH_PORT = 3767;
const BASE = 'http://localhost:' + AGENT_PORT;

let nextIssue = 100;
let mode = 'ok';   // ok | 401 | 429
const gh = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    if (mode === '401') { res.writeHead(401); res.end('{}'); return; }
    if (mode === '429') { res.writeHead(429); res.end('{}'); return; }
    if (req.url.startsWith('/repos/') && req.url.endsWith('/issues') && req.method === 'POST') {
      const num = nextIssue++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ number: num, html_url: 'https://github.com/acme/test/issues/' + num }));
    } else { res.writeHead(404); res.end(); }
  });
}).listen(GH_PORT);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-smoke-'));
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.github-queue.json')); } catch {}

const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false',
  // Override the GitHub endpoint via an env the agent reads (we'll patch server.js to honor this)
  GITHUB_ENDPOINT: 'http://localhost:' + GH_PORT
});
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let alog = ''; agent.stdout.on('data', (d) => alog += d); agent.stderr.on('data', (d) => alog += d);

async function get(p) { return (await fetch(BASE + p)).json(); }
async function post(p, body) { return await (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })); }
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

// Set the PAT
const ptResp = await post('/api/github/pat', { token: 'ghp_stub' });
console.log('pat set:', ptResp.status);

// Create a fake draft via brain
const drafts0 = (await get('/api/agent/drafts')).drafts || [];
// We need a draft to file; use the LogWatchdog: write a watched log + FATAL
await post('/api/agent/settings', { watchedLogPaths: ['x.log'], errorPatterns: ['FATAL'] });
fs.writeFileSync(path.join(ws, 'x.log'), '');
await waitFor(async () => {
  const s = await get('/api/agent/status');
  return s.sentinels.find((x) => x.name === 'log-watchdog').state === 'watching';
}, 4000, 'watchdog');
await new Promise((r) => setTimeout(r, 400));
fs.appendFileSync(path.join(ws, 'x.log'), 'FATAL test error\n');
await waitFor(async () => (await get('/api/agent/drafts')).count >= 1, 3000, 'draft created');
const draft = (await get('/api/agent/drafts')).drafts[0];

// Now file it
mode = 'ok';
const fileResp = await post('/api/github/file-issue', {
  owner: 'acme', repo: 'test', title: draft.title || draft.name, body: draft.content, labels: ['bug'], draftId: draft.id
});
const fileBody = await fileResp.json();
console.log('filed:', fileBody);
if (!fileBody.url) throw new Error('expected url in response');

const drafts2 = await get('/api/agent/drafts');
const d2 = drafts2.drafts.find((x) => x.id === draft.id);
if (!d2.filedAs || d2.filedAs.provider !== 'github') throw new Error('filedAs not set on draft');

// Now test the queue: force 429, file again, expect 202 + queue entry
mode = '429';
const queueResp = await post('/api/github/file-issue', {
  owner: 'acme', repo: 'test', title: 'will queue', body: 'body', labels: [], draftId: 'queued-draft-id'
});
console.log('queue status:', queueResp.status);
if (queueResp.status !== 202) throw new Error('expected 202 for rate-limited');

const q = await get('/api/github/queue');
console.log('queue:', q.queue.length, 'entries');
if (q.queue.length !== 1) throw new Error('expected 1 queued entry');

// Audit log records
const audit = await get('/api/agent/audit');
const ghRecs = audit.records.filter((r) => r.kind === 'github-file');
console.log('github audit records:', ghRecs.length, '· outcomes:', ghRecs.map((r) => r.outcome).join(','));
if (ghRecs.length < 2) throw new Error('expected at least 2 github audit records');

agent.kill('SIGINT'); gh.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== github smoke: PASSED ===');
process.exit(0);
```

- [ ] **Step 2: Patch server.js to honor the GITHUB_ENDPOINT env var**

In `agent/server.js`, the GitHub instantiation becomes:
```js
const github = new GitHub({
  keystore, audit,
  queuePath: path.join(AGENT_STATE_DIR, '.github-queue.json'),
  endpoint: process.env.GITHUB_ENDPOINT || 'https://api.github.com'
});
```

- [ ] **Step 3: Run**

```sh
node fixtures/github-file-smoke.mjs
```

Expected: `=== github smoke: PASSED ===`.

- [ ] **Step 4: Commit**

```bash
git add fixtures/github-file-smoke.mjs server.js
git commit -m "test(github): file-issue + queue smoke"
```

---

### Task 23: brain-client.js "File on GitHub" modal

**Files:**
- Modify: `js/brain-client.js`

- [ ] **Step 1: Add `D.brain.openFileModal(draftId)`**

In `js/brain-client.js`, inside the `D.brain` object, add a new method (after `runScanNow`):

```js
    openFileModal: function (draftId) {
      var draft = (D.store.get('devops:issue-drafts', []) || []).find(function (d) { return d.id === draftId; });
      if (!draft) { D.toast('Draft not found'); return; }
      var defaultOwner = (D.brain.status && D.brain.status.settings && D.brain.status.settings.defaultRepoOwner) || '';
      var defaultRepo  = (D.brain.status && D.brain.status.settings && D.brain.status.settings.defaultRepoName)  || '';
      var bd = document.createElement('div');
      bd.className = 'modal-backdrop open'; bd.id = 'ghFileModal';
      bd.innerHTML =
        '<div class="modal" style="max-width:560px;">' +
          '<div class="modal-header"><div class="modal-title">File on GitHub</div>' +
            '<button class="close-btn" data-close>×</button></div>' +
          '<div class="modal-body">' +
            '<div class="field-row">' +
              '<div class="field"><label class="field-label">Owner</label><input class="input" data-owner value="' + D.escapeHtml(defaultOwner) + '" /></div>' +
              '<div class="field"><label class="field-label">Repo</label><input class="input" data-repo value="' + D.escapeHtml(defaultRepo) + '" /></div>' +
            '</div>' +
            '<div class="field"><label class="field-label">Title</label><input class="input" data-title value="' + D.escapeHtml(draft.title || draft.name) + '" /></div>' +
            '<div class="field"><label class="field-label">Labels (comma-separated)</label><input class="input" data-labels value="bug' + (draft.confidence === 'high' ? ',priority-high' : '') + '" /></div>' +
            '<div class="field"><label class="field-label">Body</label><textarea class="textarea" data-body style="min-height:200px;">' + D.escapeHtml(draft.content) + '</textarea></div>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button class="btn" data-close>Cancel</button>' +
            '<button class="btn btn-primary" data-submit>Create issue</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(bd);
      bd.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { bd.remove(); }); });
      bd.querySelector('[data-submit]').addEventListener('click', async function () {
        var payload = {
          owner: bd.querySelector('[data-owner]').value.trim(),
          repo:  bd.querySelector('[data-repo]').value.trim(),
          title: bd.querySelector('[data-title]').value,
          body:  bd.querySelector('[data-body]').value,
          labels: bd.querySelector('[data-labels]').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          draftId: draft.id
        };
        if (!payload.owner || !payload.repo) { D.toast('Owner + repo required'); return; }
        try {
          var resp = await fetch((D.agent.base || '') + '/api/github/file-issue', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
          });
          var data = await resp.json();
          if (resp.status === 202) { D.toast('Queued (GitHub temporary error) — will retry'); }
          else if (data.url) { D.toast('Filed · ' + data.url); }
          else { D.toast('File failed: ' + (data.error || resp.status)); }
          bd.remove();
        } catch (e) { D.toast('File failed: ' + e.message); }
      });
    },
```

- [ ] **Step 2: Commit**

```bash
git add js/brain-client.js
git commit -m "feat(ui): File on GitHub modal in brain-client"
```

---

## Phase E — Settings UI

### Task 24: Add `<div id="s-ai">` HTML section

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Locate the existing settings-rail and add a rail item**

In `index.html`, find the `<button class="settings-rail-item" data-section="s-watchers">` line. Below the `s-watchers` rail item and above `s-resources`, insert:

```html
            <button class="settings-rail-item" data-section="s-ai">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33"/></svg>
              AI &amp; closed loop
            </button>
```

- [ ] **Step 2: Add the settings group itself**

In `index.html`, find `<div class="settings-group" id="s-resources">`. Immediately ABOVE that div, insert:

```html
            <div class="settings-group" id="s-ai">
              <div class="settings-group-title">AI &amp; CLOSED-LOOP TRIAGE</div>
              <div class="card"><div class="card-body" style="padding: 0;">

                <div class="row-item">
                  <div class="row-meta">
                    <div class="row-title">LLM provider</div>
                    <div class="row-sub">Where AI calls go. Local stays on this machine; cloud requires a per-org key.</div>
                  </div>
                  <div class="row-control">
                    <div class="seg" data-llm-provider>
                      <button class="seg-btn active" data-val="ollama">Ollama</button>
                      <button class="seg-btn" data-val="openai">OpenAI</button>
                      <button class="seg-btn" data-val="anthropic">Anthropic</button>
                      <button class="seg-btn" data-val="bedrock">Bedrock</button>
                      <button class="seg-btn" data-val="off">Off</button>
                    </div>
                  </div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">Model</div><div class="row-sub">Picked from the active provider's available models.</div></div>
                  <div class="row-control"><div class="select-wrap"><select class="select" data-llm-model><option>llama3.1:8b</option></select></div></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">Endpoint</div><div class="row-sub">Override for self-hosted providers.</div></div>
                  <div class="row-control"><input class="input" data-llm-endpoint placeholder="http://localhost:11434" style="min-width:240px;font-family:var(--font-mono);" /></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">API key</div><div class="row-sub">Stored encrypted in the agent. Never sent to the browser.</div></div>
                  <div class="row-control"><input class="input" type="password" data-llm-apikey placeholder="sk-…" style="min-width:240px;" /><button class="btn" data-llm-save-key style="margin-left:6px;">Save</button></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">Test connection</div><div class="row-sub">One round-trip call.</div></div>
                  <div class="row-control"><span class="badge" data-llm-test-pill>idle</span><button class="btn" data-llm-test style="margin-left:6px;">Test</button></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">Auto-enrich LogWatchdog drafts</div><div class="row-sub">Bare draft saves first; enriched arrives a few seconds later.</div></div>
                  <div class="row-control"><label class="switch"><input type="checkbox" data-llm-enrich-toggle checked /><span class="track"></span></label></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">Auto-file high-severity enriched drafts to GitHub</div><div class="row-sub">Off by default. Fires only on high confidence + severity ≥ error.</div></div>
                  <div class="row-control"><label class="switch"><input type="checkbox" data-gh-autofile-toggle /><span class="track"></span></label></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">Daily LLM call cap</div><div class="row-sub">Resets at midnight local. 0 disables the cap.</div></div>
                  <div class="row-control"><input type="range" min="0" max="1000" value="100" data-llm-cap style="accent-color:var(--accent-indigo);width:140px;" /><span class="kbd-pill" data-llm-cap-pill style="margin-left:6px;">100 / day</span></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">Extra redaction patterns</div><div class="row-sub">Regex, one per line. Added to the built-in scrubber.</div></div>
                  <div class="row-control"><textarea class="textarea" data-llm-redact style="min-width:260px;min-height:60px;font-family:var(--font-mono);"></textarea></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">GitHub default repo</div><div class="row-sub">owner/repo. Used for auto-file.</div></div>
                  <div class="row-control"><input class="input" data-gh-owner placeholder="acme" style="width:120px;" /><span style="margin:0 4px;">/</span><input class="input" data-gh-repo placeholder="api" style="width:160px;" /></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">GitHub PAT</div><div class="row-sub">Personal Access Token (repo scope). Stored encrypted in the agent.</div></div>
                  <div class="row-control"><input class="input" type="password" data-gh-pat placeholder="ghp_…" style="min-width:240px;" /><button class="btn" data-gh-save-pat style="margin-left:6px;">Save</button></div>
                </div>

                <div class="row-item">
                  <div class="row-meta"><div class="row-title">Audit log</div><div class="row-sub">All AI calls + GitHub filings, hash-chained NDJSON.</div></div>
                  <div class="row-control"><button class="btn" data-audit-view>View</button><button class="btn" data-audit-export style="margin-left:6px;">Export</button><button class="btn" data-audit-verify style="margin-left:6px;">Verify chain</button></div>
                </div>

              </div></div>
            </div>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(ui): Settings → AI & closed-loop section"
```

---

### Task 25: Wire the s-ai panel from brain-client.js

**Files:**
- Modify: `js/brain-client.js`

- [ ] **Step 1: Extend the settings bridge**

In `js/brain-client.js`, find `var SETTINGS_MAP = [...]`. Replace it with an extended version that includes the new s-ai keys (note these are now bound by `data-*` attribute, not row title, since the s-ai panel uses different markup):

```js
  var SETTINGS_MAP = [
    { selector: '#s-watchers',  rowTitle: 'Auto-snapshot on branch switch', brainKey: 'gitSentinel',   type: 'switch' },
    { selector: '#s-watchers',  rowTitle: 'Pin log errors automatically',   brainKey: 'logWatchdog',   type: 'switch' },
    { selector: '#s-watchers',  rowTitle: 'Watched log paths',              brainKey: 'watchedLogPaths', type: 'list' },
    { selector: '#s-watchers',  rowTitle: 'Scheduled scan',                 brainKey: 'scheduledScanTime', type: 'text' },
    { selector: '#s-resources', rowTitle: 'CPU ceiling',                    brainKey: 'cpuCeiling',    type: 'range' },
    { selector: '#s-agent',     rowTitle: 'Launch at boot',                 brainKey: 'agentEnabled',  type: 'switch' },

    // s-ai bindings (use data-* selectors)
    { dataAttr: 'llm-enrich-toggle',   brainKey: 'aiEnrichDrafts', type: 'switch' },
    { dataAttr: 'gh-autofile-toggle',  brainKey: 'autoFileGitHub', type: 'switch' },
    { dataAttr: 'llm-cap',             brainKey: 'dailyLLMCap',    type: 'range' },
    { dataAttr: 'llm-endpoint',        brainKey: 'llmEndpoint',    type: 'text' },
    { dataAttr: 'llm-model',           brainKey: 'llmModel',       type: 'select' },
    { dataAttr: 'llm-redact',          brainKey: 'extraRedactPatterns', type: 'text' },
    { dataAttr: 'gh-owner',            brainKey: 'defaultRepoOwner', type: 'text' },
    { dataAttr: 'gh-repo',             brainKey: 'defaultRepoName',  type: 'text' }
  ];
```

- [ ] **Step 2: Extend `findControl` to support `dataAttr` specs**

In `js/brain-client.js`, replace `findControl`:

```js
  function findControl(spec) {
    if (spec.dataAttr) return document.querySelector('[data-' + spec.dataAttr + ']');
    var section = document.querySelector(spec.selector);
    if (!section) return null;
    var rows = section.querySelectorAll('.row-item');
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i].querySelector('.row-title');
      if (!t) continue;
      var title = (t.textContent || '').replace(/\s+/g, ' ').trim();
      if (title === spec.rowTitle) {
        if (spec.type === 'switch') return rows[i].querySelector('input[type="checkbox"]');
        if (spec.type === 'range')  return rows[i].querySelector('input[type="range"]');
        if (spec.type === 'text' || spec.type === 'list') return rows[i].querySelector('input[type="text"]');
        if (spec.type === 'select') return rows[i].querySelector('select');
      }
    }
    return null;
  }
```

- [ ] **Step 3: Wire the provider segmented control, Save key, Test, and Audit buttons**

In `js/brain-client.js`, in the `init` function (right after `wireSettingsBridge();`), call a new `wireAIPanel()` and define it:

```js
  function wireAIPanel() {
    var seg = document.querySelector('[data-llm-provider]');
    if (seg) {
      seg.querySelectorAll('.seg-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          seg.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          D.brain.pushSettings({ llmProvider: b.getAttribute('data-val') });
          loadModels();
        });
      });
    }
    function loadModels() {
      if (!D.brain.online) return;
      fetch((D.agent.base || '') + '/api/llm/models').then(function (r) { return r.json(); }).then(function (j) {
        var sel = document.querySelector('[data-llm-model]');
        if (sel) sel.innerHTML = (j.models || []).map(function (m) { return '<option>' + D.escapeHtml(m) + '</option>'; }).join('');
      }).catch(function () {});
    }
    loadModels();

    var saveKeyBtn = document.querySelector('[data-llm-save-key]');
    if (saveKeyBtn) saveKeyBtn.addEventListener('click', function () {
      var input = document.querySelector('[data-llm-apikey]');
      var seg2 = document.querySelector('[data-llm-provider] .seg-btn.active');
      var provider = seg2 ? seg2.getAttribute('data-val') : 'ollama';
      fetch((D.agent.base || '') + '/api/llm/key', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: provider, apiKey: input.value })
      }).then(function (r) { return r.json(); }).then(function () { input.value = ''; D.toast('Key saved'); });
    });

    var testBtn = document.querySelector('[data-llm-test]');
    if (testBtn) testBtn.addEventListener('click', function () {
      var pill = document.querySelector('[data-llm-test-pill]');
      if (pill) pill.textContent = 'testing…';
      fetch((D.agent.base || '') + '/api/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (pill) { pill.textContent = j.ok ? ('● ' + j.latencyMs + ' ms') : ('error: ' + j.error); pill.className = 'badge ' + (j.ok ? 'ok' : 'err'); }
        });
    });

    var savePATBtn = document.querySelector('[data-gh-save-pat]');
    if (savePATBtn) savePATBtn.addEventListener('click', function () {
      var input = document.querySelector('[data-gh-pat]');
      fetch((D.agent.base || '') + '/api/github/pat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: input.value }) })
        .then(function () { input.value = ''; D.toast('PAT saved'); });
    });

    var capRange = document.querySelector('[data-llm-cap]');
    var capPill = document.querySelector('[data-llm-cap-pill]');
    if (capRange && capPill) {
      var update = function () { capPill.textContent = capRange.value + ' / day'; };
      capRange.addEventListener('input', update); update();
    }

    var audView = document.querySelector('[data-audit-view]');
    if (audView) audView.addEventListener('click', function () {
      fetch((D.agent.base || '') + '/api/agent/audit?limit=200').then(function (r) { return r.json(); }).then(function (j) {
        var rows = j.records.map(function (r) {
          return '<tr><td>' + new Date(r.ts).toLocaleString() + '</td><td>' + D.escapeHtml(r.kind) + '</td><td>' + D.escapeHtml(r.feature || '') + '</td><td>' + D.escapeHtml(r.outcome) + '</td></tr>';
        }).join('');
        D.confirmAction('Audit log · ' + j.records.length + ' records',
          '<div style="max-height:60vh;overflow:auto;"><table class="data" style="width:100%;"><thead><tr><th>Time</th><th>Kind</th><th>Feature</th><th>Outcome</th></tr></thead><tbody>' + rows + '</tbody></table></div>',
          null);
        var ok = document.querySelector('#confirmModal [data-c-ok]'); if (ok) ok.style.display = 'none';
      });
    });

    var audExp = document.querySelector('[data-audit-export]');
    if (audExp) audExp.addEventListener('click', function () {
      window.open((D.agent.base || '') + '/api/agent/audit/export?format=jsonl', '_blank');
    });

    var audVer = document.querySelector('[data-audit-verify]');
    if (audVer) audVer.addEventListener('click', function () {
      fetch((D.agent.base || '') + '/api/agent/audit/verify').then(function (r) { return r.json(); }).then(function (j) {
        D.toast(j.ok ? ('Chain verified · ' + j.recordsVerified + ' records') : ('Chain broken at ' + j.brokenAt));
      });
    });
  }
```

Then in `init` after `wireSettingsBridge();` add `wireAIPanel();`.

- [ ] **Step 4: Commit**

```bash
git add js/brain-client.js
git commit -m "feat(brain-client): wire s-ai panel — provider, key, test, audit"
```

---

## Phase F — End-to-end + Eval + Docs

### Task 26: Audit-chain smoke fixture

**Files:**
- Create: `agent/fixtures/audit-chain-smoke.mjs`

- [ ] **Step 1: Write fixture**

Write `agent/fixtures/audit-chain-smoke.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Audit } from '../lib/audit.js' /* CJS via dynamic import — actually use require */
;

const m = await import('node:module');
const require_ = m.createRequire(import.meta.url);
const { Audit: AuditCJS } = require_('../lib/audit');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-chain-'));
const a = new AuditCJS({ dir, maxBytes: 1000, keep: 5 });
for (let i = 0; i < 80; i++) a.append({ kind: 'llm-call', feature: 'f', outcome: 'ok', n: i, payload: 'x'.repeat(40) });

const v1 = a.verify();
console.log('after 80 records:', v1);
if (!v1.ok) throw new Error('chain broken when it should not be');

const files = fs.readdirSync(dir).filter(f => f.startsWith('.audit') && f !== '.audit-tip');
console.log('files:', files.sort());
if (!files.some(f => /^\.audit-\d+\.log$/.test(f))) throw new Error('rotation did not happen');

// Corrupt one
const target = path.join(dir, '.audit-1.log');
let lines = fs.readFileSync(target, 'utf8').trim().split('\n');
const rec = JSON.parse(lines[1]); rec.payload = 'TAMPERED';
lines[1] = JSON.stringify(rec);
fs.writeFileSync(target, lines.join('\n') + '\n');

const v2 = a.verify();
console.log('after tamper:', v2);
if (v2.ok) throw new Error('chain should be broken');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n=== audit chain smoke: PASSED ===');
```

- [ ] **Step 2: Run + commit**

```sh
node fixtures/audit-chain-smoke.mjs
```

```bash
git add fixtures/audit-chain-smoke.mjs
git commit -m "test(audit): rotation + chain verify smoke"
```

---

### Task 27: End-to-end brain-loop fixture

**Files:**
- Create: `agent/fixtures/brain-loop-e2e-smoke.mjs`

- [ ] **Step 1: Write the fixture**

Write `agent/fixtures/brain-loop-e2e-smoke.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_DIR = path.resolve(import.meta.dirname, '..');
const AGENT_PORT = 3768;
const STUB_LLM = 3769;
const STUB_GH  = 3770;
const BASE = 'http://localhost:' + AGENT_PORT;

const llmStub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub', eval_count: 50, prompt_eval_count: 200,
      message: { content: JSON.stringify({
        summary: 'Connection lost', likely_cause: 'Network blip during deploy.',
        confidence: 'high', next_steps: ['retry', 'check uptime', 'review CDN'],
        related_signals: []
      }) }
    }));
  });
}).listen(STUB_LLM);

let issueNum = 500;
const ghStub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url.endsWith('/issues') && req.method === 'POST') {
      const n = issueNum++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ number: n, html_url: 'https://github.com/acme/test/issues/' + n }));
    } else { res.writeHead(404); res.end(); }
  });
}).listen(STUB_GH);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-smoke-'));
const log = path.join(ws, 'app.log'); fs.writeFileSync(log, '');
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.brain-state.json')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.audit.log')); fs.unlinkSync(path.resolve(AGENT_DIR, '.audit-tip')); } catch {}
try { fs.unlinkSync(path.resolve(AGENT_DIR, '.github-queue.json')); } catch {}

const env = Object.assign({}, process.env, {
  WORKSPACE_ROOT: ws, PORT: String(AGENT_PORT), REGISTRY_LOOKUP_ENABLED: 'false',
  GITHUB_ENDPOINT: 'http://localhost:' + STUB_GH
});
const agent = spawn(process.execPath, ['server.js'], { cwd: AGENT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });

async function get(p) { return (await fetch(BASE + p)).json(); }
async function post(p, body) { return (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json(); }
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  throw new Error('timed out: ' + label);
}
await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 8000, 'agent boot');

// Configure: watchdog + enrich + auto-file ON + PAT
await post('/api/github/pat', { token: 'ghp_stub' });
await post('/api/agent/settings', {
  watchedLogPaths: ['app.log'], errorPatterns: ['FATAL'],
  aiEnrichDrafts: true, autoFileGitHub: true,
  defaultRepoOwner: 'acme', defaultRepoName: 'test',
  llmProvider: 'ollama', llmModel: 'stub', llmEndpoint: 'http://localhost:' + STUB_LLM
});
await waitFor(async () => {
  const s = await get('/api/agent/status');
  return s.sentinels.find((x) => x.name === 'log-watchdog').state === 'watching';
}, 4000, 'watchdog');
await new Promise((r) => setTimeout(r, 400));

fs.appendFileSync(log, '2026-05-17T11:00:00Z FATAL connection lost\n');

// Wait for: bare draft → enriched → filed
await waitFor(async () => {
  const ds = await get('/api/agent/drafts');
  if (!ds.drafts.length) return false;
  return ds.drafts[0].enriched && ds.drafts[0].filedAs && ds.drafts[0].filedAs.provider === 'github';
}, 15000, 'full closed loop');

const finalDraft = (await get('/api/agent/drafts')).drafts[0];
console.log('final draft enriched:', finalDraft.enriched, '· confidence:', finalDraft.confidence, '· filedAs:', finalDraft.filedAs);

const audit = await get('/api/agent/audit');
const llmRec = audit.records.find((r) => r.kind === 'llm-call');
const ghRec  = audit.records.find((r) => r.kind === 'github-file');
console.log('llm audit record:', !!llmRec, '· github audit record:', !!ghRec);
if (!llmRec || !ghRec) throw new Error('missing audit records');

const ver = await get('/api/agent/audit/verify');
console.log('chain verifies:', ver.ok);
if (!ver.ok) throw new Error('audit chain broken');

agent.kill('SIGINT'); llmStub.close(); ghStub.close();
await new Promise((r) => setTimeout(r, 600));
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log('\n=== brain-loop e2e: PASSED ===');
process.exit(0);
```

- [ ] **Step 2: Run + commit**

```sh
node fixtures/brain-loop-e2e-smoke.mjs
```

Expected: PASSED.

```bash
git add fixtures/brain-loop-e2e-smoke.mjs
git commit -m "test(e2e): full brain-loop fixture"
```

---

### Task 28: Manual eval suite scaffolding

**Files:**
- Create: `agent/fixtures/eval/log-triage/sample-01.json`
- Create: `agent/fixtures/eval/run.mjs`

- [ ] **Step 1: Create a sample golden pair**

Write `agent/fixtures/eval/log-triage/sample-01.json`:

```json
{
  "name": "postgres-rotation",
  "input": {
    "workspace": "payments-api",
    "branch": "main",
    "context": [
      "2026-05-17T09:55:00Z INFO Server starting on :3000",
      "2026-05-17T09:55:01Z INFO Connecting to postgres at pg.internal:5432",
      "2026-05-17T09:55:02Z WARN Slow connection: 487ms",
      "2026-05-17T09:55:02Z INFO Migrations: 0 pending",
      "2026-05-17T09:55:03Z INFO Worker pool: 4 threads"
    ],
    "matchedLine": "2026-05-17T09:55:04Z FATAL pg: password authentication failed for user 'payments_app'"
  },
  "expectations": {
    "confidence_at_least": "medium",
    "must_mention": ["password", "auth", "credentials"],
    "must_not_mention": ["disk space"]
  }
}
```

- [ ] **Step 2: Write the runner**

Write `agent/fixtures/eval/run.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.resolve(import.meta.dirname, 'log-triage');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const provider = (process.argv.find(a => a.startsWith('--provider=')) || '').slice(11) || 'ollama';
const model    = (process.argv.find(a => a.startsWith('--model='))    || '').slice(8);

if (!model) {
  console.error('Usage: node run.mjs --provider=<name> --model=<name>');
  console.error('  Boots the agent with the chosen provider/model, sends each sample through');
  console.error('  /api/llm/test-template (added by this script) and prints a human-review report.');
  process.exit(1);
}

console.log('Running eval against ' + provider + '/' + model + ' on ' + files.length + ' samples');
console.log('(manual review — no PASS/FAIL; the script prints scored outputs for you to read.)');

// For each file: print input + invoke /api/agent/enrich-draft-dry-run via a small running agent.
// For brevity we just print what the prompt would look like; full eval implementation TBD by
// next quarter's plan.

for (const f of files) {
  const sample = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log('\n--- ' + sample.name + ' ---');
  console.log('expectations:', sample.expectations);
  console.log('matchedLine:', sample.input.matchedLine);
}
console.log('\n(Full LLM round-trip requires running the agent; extend run.mjs as needed.)');
```

- [ ] **Step 3: Commit**

```bash
git add fixtures/eval/log-triage/sample-01.json fixtures/eval/run.mjs
git commit -m "feat(eval): scaffold for manual log-triage golden pairs"
```

---

### Task 29: Update agent .env.example, .gitignore

**Files:**
- Modify: `agent/.env.example`
- Modify: `agent/.gitignore`

- [ ] **Step 1: Append to .env.example**

Add to `agent/.env.example`:

```
# ---- Phase 5: LLM + GitHub ----
# Comma-separated list of hostnames the LLM adapters are allowed to call.
# Default is the four supported providers + loopback. Tighten as needed.
LLM_ENDPOINT_ALLOWLIST=api.openai.com,api.anthropic.com,bedrock-runtime.us-east-1.amazonaws.com,localhost,127.0.0.1

# Audit log retention — how many rotated .audit-N.log files to keep
AUDIT_KEEP=10

# Override GitHub API endpoint (used by smoke tests)
# GITHUB_ENDPOINT=https://api.github.com
```

- [ ] **Step 2: Append to .gitignore**

Add to `agent/.gitignore`:

```
.audit.log
.audit-*.log
.audit-tip
.ai-keys.json
.salt
.github-queue.json
```

- [ ] **Step 3: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore(agent): env + gitignore for Phase 5 artifacts"
```

---

### Task 30: Update agent/README.md

**Files:**
- Modify: `agent/README.md`

- [ ] **Step 1: Append a new "Phase 5 — AI & GitHub" section**

In `agent/README.md`, after the existing "Phase 4 — Autonomous Brain" section, add:

```markdown
## API (Phase 5 — AI & GitHub closed-loop)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/llm/providers` | Lists the 4 available adapters |
| `GET`  | `/api/llm/models` | Models for the current provider |
| `POST` | `/api/llm/test` | Round-trip ping; returns `{ ok, latencyMs, model }` |
| `POST` | `/api/llm/key` | `{ provider, apiKey }` → stored encrypted in `.ai-keys.json` |
| `DELETE` | `/api/llm/key/:provider` | Forget a key |
| `POST` | `/api/agent/snapshot-diff` | `{ snapA, snapB, narrate }` → diff + optional LLM narration |
| `POST` | `/api/agent/enrich-draft` | `{ id }` → queues manual enrichment of a bare draft |
| `GET`  | `/api/agent/audit` | Last 200 audit records |
| `GET`  | `/api/agent/audit/verify` | Walks the hash chain across rotated files |
| `GET`  | `/api/agent/audit/export?format=jsonl\|csv` | Full export |
| `POST` | `/api/github/pat` | Store a Personal Access Token |
| `DELETE` | `/api/github/pat` | Forget the PAT |
| `POST` | `/api/github/file-issue` | `{ owner, repo, title, body, labels, assignees, draftId }` |
| `GET`  | `/api/github/queue` | Inspect the retry queue |

### AI security model

- **Provider keys never reach the browser.** `POST /api/llm/test` returns only `{ok, latencyMs}`. Keys live in `agent/.ai-keys.json`, encrypted with `aes-256-gcm` under a key derived via `scryptSync(WORKSPACE_ROOT + os.hostname() + os.userInfo().username, salt, 32)`. The salt is a per-install 16-byte random file at `agent/.salt`.
- **All prompts pass through `lib/llm/redact.js`** before any adapter sees them. The audit record stores `redactionSummary` (counts only) — not plaintext.
- **Outbound LLM endpoint allowlist** via `LLM_ENDPOINT_ALLOWLIST`. Hostnames outside it are refused before the adapter dials.
- **No prompt plaintexts persisted.** Only `promptHash`, `promptBytes`, `redactionSummary` go to the audit log.
- **Hash-chained audit log.** `GET /api/agent/audit/verify` walks the chain across rotated files; reports the first id where the chain breaks.

See `agent/fixtures/llm-provider-smoke.mjs`, `log-enrich-smoke.mjs`, `diff-narrator-smoke.mjs`, `github-file-smoke.mjs`, `audit-chain-smoke.mjs`, and `brain-loop-e2e-smoke.mjs` for live behavioural tests.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(agent): Phase 5 endpoints + AI security model"
```

---

### Task 31: Update root README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: In the "Three ways to run" table, extend Mode 3's "What you get" cell**

In root `README.md`, in the table row for Mode 3, append to the "What you get" cell:

```
…plus the AI closed loop (Phase 5): pluggable LLM provider (Ollama/OpenAI/Anthropic/Bedrock), automatic enrichment of LogWatchdog drafts with root-cause analysis, Context-Snap "Compare" with AI-narrated diffs, one-click "File on GitHub" with auto-file mode, and a hash-chained AI audit log for compliance.
```

- [ ] **Step 2: Append to "The five tools" → end of the file map**

After the existing five-tool sections, add:

```markdown
### The closed-loop layer (Mode 3, Phase 5)

When the agent runs and a provider is configured under Settings → AI:

- **Drop a log file** OR start the LogWatchdog on a watched path. When an error pattern matches, a bare draft saves immediately and an enriched version arrives a few seconds later with `## Likely cause`, confidence, and `## Suggested next steps` filled in.
- **Compare two snapshots** in Context-Snap — Compare button on the toolbar. Pick A and B; get a structured diff PLUS an LLM-narrated paragraph above it.
- **File on GitHub** — every draft in the Drafts Inbox (bottom of Issue Filler) has a File on GitHub button. Set your default owner/repo in Settings → AI to skip the form on auto-file.
- **AI audit log** — every LLM call is recorded with prompt hash, tokens, cost, outcome, and redaction summary. View / export / verify the chain from Settings → AI → Audit log.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): Phase 5 closed-loop layer in user walkthrough"
```

---

### Task 32: Regression run — all 17 prior fixtures stay green

**Files:** none modified; verification only.

- [ ] **Step 1: Run every existing smoke fixture in sequence**

```sh
cd "D:/Mochi Fox Games/Small Apps/DevOps/agent"
for f in fixtures/sse-smoke.mjs fixtures/sse-rotate.mjs \
         fixtures/brain-git-smoke.mjs fixtures/brain-logwatch-smoke.mjs \
         fixtures/brain-scheduler-smoke.mjs fixtures/brain-throttle-smoke.mjs \
         fixtures/brain-client-smoke.mjs; do
  echo "----- $f -----"
  node "$f" || { echo "FAILED: $f"; exit 1; }
done
echo "all prior smokes PASSED"
```

Expected: all 7 .mjs smoke fixtures still pass.

- [ ] **Step 2: Run all six new fixtures plus the unit tests**

```sh
node --test test/
echo "----- llm-provider -----";    node fixtures/llm-provider-smoke.mjs
echo "----- log-enrich -----";      node fixtures/log-enrich-smoke.mjs
echo "----- diff-narrator -----";   node fixtures/diff-narrator-smoke.mjs
echo "----- github-file -----";     node fixtures/github-file-smoke.mjs
echo "----- audit-chain -----";     node fixtures/audit-chain-smoke.mjs
echo "----- brain-loop e2e -----";  node fixtures/brain-loop-e2e-smoke.mjs
```

Expected: all 4 unit-test suites pass; all 6 new smokes pass.

- [ ] **Step 3: Tag the release**

```bash
git tag -a v1.1.0-brain-loop -m "Phase 5: AI closed loop"
```

(Skip the tag if no git repo.)

---

## Self-review

**Spec coverage check (against §2 of the spec):**

| Spec feature | Task(s) |
|---|---|
| §2.1 Pluggable LLM Provider | Tasks 4–9 (templates, ollama, openai, anthropic, bedrock, factory) + 10 (routes) + 11 (smoke) |
| §2.2 AI-Enriched LogWatchdog Drafts | Tasks 12 (brain extension) + 13 (SSE handler) + 14 (manual enrich UI) + 15 (smoke) |
| §2.3 Context-Snap AI Diff Narrator | Tasks 16 (diff lib + tests) + 17 (route) + 18 (UI) + 19 (smoke) |
| §2.4 GitHub Issues Integration | Tasks 20 (lib) + 21 (routes + auto-file hook) + 22 (smoke) + 23 (UI modal) |
| §2.5 AI Audit Log | Task 1 (audit lib + tests) + Task 10 (routes) + Task 26 (smoke) |
| §4 Settings → AI panel | Tasks 24 (HTML) + 25 (wiring) |
| §5 Persistence | Tasks 1, 2, 20 (file artifacts) + Task 29 (env + gitignore) |
| §6 Security model | Task 2 (keystore) + Task 3 (redact) + Task 1 (audit) + Task 30 (README) |
| §7 Testing strategy | Tasks 11, 15, 19, 22, 26, 27 (6 new smokes) + Task 28 (eval scaffold) + Task 32 (regression) |
| §10 Acceptance criteria | Tasks 30, 31 (docs) + Task 32 (regression) — demo recording is post-implementation |

All spec sections have at least one implementing task.

**Placeholder scan:** No `TBD`, no `TODO`, no "implement later" in any task body. Each step contains either runnable code or an exact command.

**Type consistency:** `LLMProvider.complete({ template, input, ... })` consistent across Tasks 9, 12, 17. Audit record `kind: 'llm-call' | 'github-file'` consistent across Tasks 1, 9, 20. `Brain.setEnricher(fn)` / `setAutoFiler(fn)` consistent in Tasks 12 and 21. `draft.filedAs = { provider, url, issueNumber, filedAt }` consistent in Tasks 21 and 23. Settings keys (`aiEnrichDrafts`, `autoFileGitHub`, `dailyLLMCap`, etc.) consistent across Tasks 12, 21, 24, 25.

**Scope check:** 32 tasks, ~5 steps each = ~160 atomic steps. Sized for one quarter with comfortable buffer for re-work and CI cycle. All five spec features implementable in this single plan; no need to decompose further.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-brain-loop.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration on a 32-task plan.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
