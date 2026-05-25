/* DevOps Local Agent — Express server.
   Phase 1: Context-Snap. Phases 2 (log streaming) and 3 (deps + scraper proxy)
   slot in here as future routers.

   Security model:
   - WORKSPACE_ROOT bounds every file/git operation (lib/safety.js).
   - ALLOW_DESTRUCTIVE=false by default; mutating endpoints reject without it
     AND without an explicit X-Confirm-Destructive: yes header.
   - Env vars matching the secret patterns in lib/context-snap.js are redacted
     before they ever leave the process. */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');

const { resolveWorkspaceRoot, withinWorkspace } = require('./lib/safety');
const ctx = require('./lib/context-snap');
const logTail = require('./lib/log-tail');
const depRegistry = require('./lib/dep-registry');
const scraper = require('./lib/scraper');
const { Brain, GitSentinel, LogWatchdog, Scheduler, ResourceThrottle } = require('./lib/brain');
const { LLMProvider } = require('./lib/llm');
const { Audit } = require('./lib/audit');
const { Keystore } = require('./lib/keystore');
const { diffSnapshots } = require('./lib/snapshot-diff');
const { GitHub } = require('./lib/github');

const PORT = parseInt(process.env.PORT || '3737', 10);
const ALLOW_DESTRUCTIVE = process.env.ALLOW_DESTRUCTIVE === 'true';
const EXTRA_REDACT = process.env.EXTRA_REDACT_PATTERNS || '';
const SCRAPER_ALLOWED_HOSTS = process.env.SCRAPER_ALLOWED_HOSTS || '';
const SCRAPER_ALLOW_ANY = process.env.SCRAPER_ALLOW_ANY === 'true';
const REGISTRY_LOOKUP_ENABLED = process.env.REGISTRY_LOOKUP_ENABLED !== 'false';

let WORKSPACE_ROOT;
try {
  WORKSPACE_ROOT = resolveWorkspaceRoot(process.env.WORKSPACE_ROOT);
} catch (e) {
  console.error('[agent] FATAL: ' + e.message);
  process.exit(1);
}

const STATIC_ROOT = path.resolve(__dirname, '..');
const VERSION = '1.0.0';
const STARTED_AT = new Date().toISOString();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '256kb' }));

// Lightweight request log — one line per request.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

// Centralised error wrapper so handlers can throw.
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    const status = err.statusCode || 500;
    console.error(`[agent] ${req.path} failed:`, err.message);
    res.status(status).json({ error: err.message });
  });

// ---- Health + workspace info ----
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    name: 'devops-local-agent',
    version: VERSION,
    startedAt: STARTED_AT,
    uptimeSec: Math.round(process.uptime()),
    workspaceRoot: WORKSPACE_ROOT,
    workspaceName: path.basename(WORKSPACE_ROOT),
    platform: process.platform,
    nodeVersion: process.version,
    allowDestructive: ALLOW_DESTRUCTIVE
  });
});

app.get('/api/workspace', (req, res) => {
  res.json({
    root: WORKSPACE_ROOT,
    name: path.basename(WORKSPACE_ROOT)
  });
});

// ---- Context-Snap routes ----
app.get('/api/context-snap/env', wrap(async (req, res) => {
  const includeFull = req.query.full === '1';
  res.json(await ctx.getEnv({ extraRedact: EXTRA_REDACT, includeFull }));
}));

app.get('/api/context-snap/processes', wrap(async (req, res) => {
  res.json(await ctx.getProcesses());
}));

app.get('/api/context-snap/git', wrap(async (req, res) => {
  res.json(await ctx.getGitInfo(WORKSPACE_ROOT));
}));

app.get('/api/context-snap/ports', wrap(async (req, res) => {
  res.json(await ctx.getPorts());
}));

app.post('/api/context-snap/capture', wrap(async (req, res) => {
  const includes = (req.body && req.body.includes) || {};
  res.json(await ctx.captureAll(WORKSPACE_ROOT, includes, EXTRA_REDACT));
}));

// ---- Log-Tail routes ----
// GET /api/log-tail/find — list candidate log files in the workspace.
app.get('/api/log-tail/find', wrap(async (req, res) => {
  const results = await logTail.findLogFiles(WORKSPACE_ROOT, {
    exts: req.query.exts ? req.query.exts.split(',') : undefined,
    maxResults: parseInt(req.query.max, 10) || undefined
  });
  res.json({ workspaceRoot: WORKSPACE_ROOT, results });
}));

// GET /api/log-tail/file?path=...&bytes=65536 — initial backfill (last N bytes).
app.get('/api/log-tail/file', wrap(async (req, res) => {
  const resolved = withinWorkspace(WORKSPACE_ROOT, req.query.path || '');
  const bytes = parseInt(req.query.bytes, 10) || 64 * 1024;
  const result = await logTail.readLastBytes(resolved, bytes);
  res.json({ path: resolved, ...result });
}));

// GET /api/log-tail/stream?path=... — SSE stream of new lines.
// Native EventSource API on the browser side. No polyfill, no extension.
app.get('/api/log-tail/stream', (req, res) => {
  let resolved;
  try {
    resolved = withinWorkspace(WORKSPACE_ROOT, req.query.path || '');
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  // SSE handshake — flush headers immediately so the client confirms the connection.
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'  // disable nginx-style proxy buffering if present
  });
  res.flushHeaders();

  const stream = new logTail.LogStream(resolved);
  const writeEvent = (evt) => {
    if (res.writableEnded) return;
    res.write('event: ' + evt.type + '\n');
    res.write('data: ' + JSON.stringify(evt) + '\n\n');
  };
  const unsubscribe = stream.subscribe(writeEvent);

  // Heartbeat every 25s to keep idle proxies/firewalls from killing the socket.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': heartbeat ' + new Date().toISOString() + '\n\n');
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    stream.close();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);

  stream.start().catch((err) => {
    writeEvent({ type: 'error', message: err.message });
    cleanup();
    if (!res.writableEnded) res.end();
  });
});

// ---- Dep Map registry lookup ----
// POST /api/dep-map/lookup
// Body: { ecosystem: 'npm'|'pip'|'cargo'|'go'|'gem', packages: ['name', ...], timeoutMs?: 5000 }
app.post('/api/dep-map/lookup', wrap(async (req, res) => {
  if (!REGISTRY_LOOKUP_ENABLED) {
    return res.status(503).json({ error: 'Registry lookups disabled (REGISTRY_LOOKUP_ENABLED=false)' });
  }
  const body = req.body || {};
  const ecosystem = String(body.ecosystem || '').toLowerCase();
  const packages = Array.isArray(body.packages) ? body.packages.filter((s) => typeof s === 'string' && s.length).slice(0, 500) : [];
  if (!ecosystem) return res.status(400).json({ error: 'ecosystem required' });
  if (!packages.length) return res.json({ ecosystem, results: [] });
  const results = await depRegistry.lookupBatch(ecosystem, packages, {
    timeoutMs: Math.min(parseInt(body.timeoutMs, 10) || 5000, 15000),
    concurrency: Math.min(parseInt(body.concurrency, 10) || 6, 12)
  });
  res.json({ ecosystem, count: results.length, results });
}));

app.get('/api/dep-map/cache', (req, res) => {
  res.json({ enabled: REGISTRY_LOOKUP_ENABLED, ...depRegistry.cacheStats() });
});

app.delete('/api/dep-map/cache', (req, res) => {
  depRegistry.clearCache();
  res.json({ cleared: true });
});

// ---- Docs Scraper proxy ----
// POST /api/scraper/fetch
// Body: { url: 'https://...', as?: 'markdown'|'html'|'auto', timeoutMs?, maxBytes? }
app.post('/api/scraper/fetch', wrap(async (req, res) => {
  const body = req.body || {};
  const url = String(body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  const result = await scraper.scrape(url, {
    allowedHosts: SCRAPER_ALLOWED_HOSTS,
    allowAny: SCRAPER_ALLOW_ANY,
    timeoutMs: Math.min(parseInt(body.timeoutMs, 10) || 8000, 20000),
    maxBytes: Math.min(parseInt(body.maxBytes, 10) || 2 * 1024 * 1024, 8 * 1024 * 1024)
  });
  // Trim body if caller only wants the markdown.
  if (body.as === 'markdown' && result.markdown) {
    res.json({ url: result.url, finalUrl: result.finalUrl, status: result.status, contentType: result.contentType, bytes: result.bytes, markdown: result.markdown });
  } else {
    res.json(result);
  }
}));

app.get('/api/scraper/config', (req, res) => {
  res.json({
    allowAny: SCRAPER_ALLOW_ANY,
    allowedHosts: scraper.parsePatterns(SCRAPER_ALLOWED_HOSTS),
    maxBytesDefault: 2 * 1024 * 1024,
    timeoutMsDefault: 8000
  });
});

// ---- Phase 5: LLM + Audit + Keystore ----
const AGENT_STATE_DIR = path.resolve(__dirname);
const audit = new Audit({ dir: AGENT_STATE_DIR, keep: parseInt(process.env.AUDIT_KEEP || '10', 10) });
const keystore = new Keystore({ dir: AGENT_STATE_DIR, workspaceRoot: WORKSPACE_ROOT });

// ---- Phase 4: Autonomous Brain ----
const brain = new Brain({ workspaceRoot: WORKSPACE_ROOT, extraRedact: EXTRA_REDACT });
brain.addSentinel(new GitSentinel(brain,      { workspaceRoot: WORKSPACE_ROOT }));
brain.addSentinel(new LogWatchdog(brain,      { workspaceRoot: WORKSPACE_ROOT }));
brain.addSentinel(new Scheduler(brain,        { workspaceRoot: WORKSPACE_ROOT }));
brain.addSentinel(new ResourceThrottle(brain, {}));

// Wire the LLM provider into the LogWatchdog so it can enrich drafts.
brain.setEnricher((args) => buildProvider().complete(args));

// GitHub adapter — issue filing + retry queue.
const github = new GitHub({
  keystore, audit,
  queuePath: path.join(AGENT_STATE_DIR, '.github-queue.json'),
  endpoint: process.env.GITHUB_ENDPOINT || 'https://api.github.com'
});

// Auto-file hook — fires from LogWatchdog._enrichOne when confidence: high.
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

// LLM factory — built per-request from current brain settings.
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

// GET /api/agent/status — Brain + every sentinel's current state.
app.get('/api/agent/status', (req, res) => {
  res.json(brain.status());
});

// GET /api/agent/events?limit=100 — recent activity log (newest at the end).
app.get('/api/agent/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json({ count: brain.events.length, events: brain.events.slice(-limit) });
});

// GET /api/agent/snapshots — brain-generated snapshots (for UI catch-up after reload).
app.get('/api/agent/snapshots', (req, res) => {
  const since = req.query.since ? new Date(req.query.since).getTime() : 0;
  const list = since
    ? brain.recentSnapshots.filter((s) => new Date(s.timestamp).getTime() > since)
    : brain.recentSnapshots;
  res.json({ count: list.length, snapshots: list });
});

// GET /api/agent/drafts — auto-pinned issue drafts (LogWatchdog).
app.get('/api/agent/drafts', (req, res) => {
  const since = req.query.since ? new Date(req.query.since).getTime() : 0;
  const list = since
    ? brain.recentDrafts.filter((d) => new Date(d.when).getTime() > since)
    : brain.recentDrafts;
  res.json({ count: list.length, drafts: list });
});

// GET /api/agent/scans — last 20 scheduled-scan results.
app.get('/api/agent/scans', (req, res) => {
  res.json({ count: brain.recentScans.length, scans: brain.recentScans });
});

// POST /api/agent/snapshot-diff — compute structured diff between two snapshots,
// optionally also produce an LLM-narrated paragraph.
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

// POST /api/agent/enrich-draft — manually queue enrichment for a bare draft.
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

// POST /api/agent/scan — trigger the scheduled scan immediately (bypasses cron).
// Useful for the UI "Scan now" button and for smoke tests.
app.post('/api/agent/scan', wrap(async (req, res) => {
  const scheduler = brain.sentinels.find((s) => s.name === 'scheduler');
  if (!scheduler) return res.status(503).json({ error: 'Scheduler sentinel not registered' });
  try {
    const result = await scheduler.runScan('manual');
    res.json(result);
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
}));

// POST /api/agent/settings — push runtime toggles (master switch, per-sentinel,
// scheduled-scan time, watched log paths, etc.). Unknown keys are ignored.
app.post('/api/agent/settings', wrap(async (req, res) => {
  const updated = brain.updateSettings(req.body || {});
  res.json({ settings: updated });
}));

// GET /api/agent/events/stream — SSE bus for the dashboard's Live Activity feed.
// On connect: emits `status` once, then the last 20 log events, then live updates.
app.get('/api/agent/events/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const writeEvent = (type, data) => {
    if (res.writableEnded) return;
    res.write('event: ' + type + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  };

  writeEvent('status', brain.status());
  for (const evt of brain.events.slice(-20)) writeEvent('log', evt);

  // Brain broadcasts:
  //   { type: 'log', event } for activity log entries
  //   { type: 'snapshot'|'draft'|'scan'|'notification'|'throttle', payload, ts }
  const unsub = brain.subscribe((msg) => {
    if (msg.type === 'log') writeEvent('log', msg.event);
    else writeEvent(msg.type, msg.payload);
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat ' + new Date().toISOString() + '\n\n');
  }, 25000);

  const cleanup = () => { clearInterval(heartbeat); unsub(); };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

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

// ---- Phase 5: GitHub routes ----
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

// ---- Static frontend ----
// The agent serves the dashboard from the parent directory. This means a single
// `npm start` inside agent/ gives you both the API and the UI on the same port.
app.use(express.static(STATIC_ROOT, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    // Discourage caching of HTML/JS during development so script edits show up
    // immediately when the agent serves the frontend.
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// 404 for unknown /api/* — never fall through to static.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown endpoint: ' + req.path });
});

const server = app.listen(PORT, () => {
  const banner =
`────────────────────────────────────────────────────────────────
 DevOps Local Agent v${VERSION}
 Listening on http://localhost:${PORT}
 Workspace:   ${WORKSPACE_ROOT}
 Destructive: ${ALLOW_DESTRUCTIVE ? 'ALLOWED (with X-Confirm-Destructive: yes)' : 'BLOCKED'}
 Frontend:    http://localhost:${PORT}/
 Health:      http://localhost:${PORT}/api/health
 Brain:       http://localhost:${PORT}/api/agent/status
────────────────────────────────────────────────────────────────`;
  console.log(banner);

  // Start the Brain after the HTTP server is listening so a slow sentinel
  // startup doesn't block requests.
  brain.start().catch((err) => console.error('[brain] startup failed:', err.message));
});

// Graceful shutdown — stop sentinels first so chokidar watchers release files.
async function shutdown(signal) {
  console.log('[agent] shutdown via', signal);
  try { await brain.stop(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
