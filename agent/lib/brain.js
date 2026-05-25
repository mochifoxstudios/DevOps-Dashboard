/* The Autonomous Brain.
   Long-running background service that observes the workspace and acts
   proactively. Composes a set of "Sentinel" objects; each sentinel has its own
   lifecycle, watches one signal, and posts events back to the Brain.

   Initial scope (Phase 4 slice):
     - Brain: shared event log + settings + on-disk state + pub/sub
     - GitSentinel: chokidar-backed watcher on .git/HEAD that auto-captures a
       Context-Snap whenever the branch changes

   Future sentinels (LogWatchdog, Scheduler, ResourceThrottle) plug in via
   `brain.addSentinel(s)` — each is just an object with start() / stop() and a
   `name` / `state` it reports for /api/agent/status. */

const fs = require('node:fs');
const path = require('node:path');
const chokidar = require('chokidar');
const ctx = require('./context-snap');
const logTail = require('./log-tail');
const { withinWorkspace } = require('./safety');
const depParsers = require('./dep-parsers');
const depRegistry = require('./dep-registry');

const STATE_FILE = path.resolve(__dirname, '..', '.brain-state.json');
const MAX_EVENTS = 500;        // ring-buffer cap for the activity log
const MAX_SNAPSHOTS = 50;      // brain-generated snapshots we keep around for UI catch-up
const MAX_DRAFTS = 30;         // matches devops:issue-drafts cap in the frontend
const MAX_SCANS = 20;          // scheduled-scan results retained in memory

class Brain {
  constructor(opts = {}) {
    this.workspaceRoot = opts.workspaceRoot;
    this.extraRedact = opts.extraRedact || '';
    this.startedAt = new Date().toISOString();
    this.events = [];
    this.recentSnapshots = [];
    this.recentDrafts = [];
    this.recentScans = [];
    this.snapshotSeq = 0;
    this.draftSeq = 0;
    this.sentinels = [];
    this._listeners = new Set();
    this._settingsListeners = new Set();
    this._stopped = false;

    // Live resource state — populated by ResourceThrottle.
    this.cpuPercent = 0;
    this.throttled = false;

    this.settings = this._defaultSettings();
    this._loadState();
  }

  _defaultSettings() {
    return {
      // Master switch — when false, every sentinel reports idle and no action runs.
      agentEnabled: true,
      // Per-sentinel toggles.
      gitSentinel: true,
      logWatchdog: true,
      scheduledScan: true,
      // Scheduled-scan time of day (24h HH:MM, local time).
      scheduledScanTime: '03:00',
      // CPU ceiling for throttling (percent). When exceeded, non-essential sentinels pause.
      cpuCeiling: 75,
      // Comma-separated list of file paths the LogWatchdog should monitor.
      watchedLogPaths: [],
      // Regex source strings; each is compiled with /…/i and OR'd in the watchdog.
      errorPatterns: ['CRITICAL', 'FATAL', '\\bpanic\\b', 'unhandledRejection', 'segfault'],
      // Phase 5: LLM + closed-loop settings.
      aiEnrichDrafts: true,
      autoFileGitHub: false,
      llmProvider: 'ollama',
      llmModel: 'llama3.1:8b',
      llmEndpoint: '',
      llmRegion: 'us-east-1',
      extraRedactPatterns: '',
      dailyLLMCap: 100,
      defaultRepoOwner: '',
      defaultRepoName: ''
    };
  }

  /* Is `sentinelKey` (e.g. 'gitSentinel') allowed to run right now? Master switch
     short-circuits everything; per-sentinel toggle is the secondary gate. */
  isEnabled(sentinelKey) {
    if (!this.settings.agentEnabled) return false;
    if (sentinelKey && this.settings[sentinelKey] === false) return false;
    return true;
  }

  /* Replace any of the known keys; ignore unknown keys to keep the surface clean.
     Fires onSettingsChange listeners so live sentinels (LogWatchdog) can re-sync. */
  updateSettings(partial) {
    if (!partial || typeof partial !== 'object') return this.settings;
    const validKeys = Object.keys(this._defaultSettings());
    const accepted = {};
    for (const k of validKeys) {
      if (Object.prototype.hasOwnProperty.call(partial, k)) accepted[k] = partial[k];
    }
    const previous = Object.assign({}, this.settings);
    Object.assign(this.settings, accepted);
    this.log('info', 'brain', `Settings updated: ${Object.keys(accepted).join(', ') || '(none)'}`, accepted);
    this._saveState();
    for (const fn of this._settingsListeners) {
      try { fn(this.settings, previous); } catch (_) { /* swallow */ }
    }
    return this.settings;
  }

  onSettingsChange(fn) {
    this._settingsListeners.add(fn);
    return () => this._settingsListeners.delete(fn);
  }

  addSentinel(sentinel) {
    this.sentinels.push(sentinel);
  }

  // Phase 5: wire an LLM enricher / GitHub auto-filer into the LogWatchdog.
  setEnricher(fn) {
    for (const s of this.sentinels) { if (s.name === 'log-watchdog') s.enrich = fn; }
  }
  setAutoFiler(fn) {
    for (const s of this.sentinels) { if (s.name === 'log-watchdog') s.autoFileFn = fn; }
  }

  log(level, source, message, data) {
    const evt = { ts: new Date().toISOString(), level, source, message };
    if (data !== undefined) evt.data = data;
    this.events.push(evt);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this._broadcast({ type: 'log', event: evt });
  }

  /* Emit a structured event (e.g. snapshot, scan-complete) to the SSE bus. */
  emit(type, payload) {
    this._broadcast({ type, payload, ts: new Date().toISOString() });
  }

  appendSnapshot(snap) {
    this.recentSnapshots.unshift(snap);
    if (this.recentSnapshots.length > MAX_SNAPSHOTS) this.recentSnapshots.length = MAX_SNAPSHOTS;
    this._saveState();
    this.emit('snapshot', snap);
  }

  appendDraft(draft) {
    this.recentDrafts.unshift(draft);
    if (this.recentDrafts.length > MAX_DRAFTS) this.recentDrafts.length = MAX_DRAFTS;
    this._saveState();
    this.emit('draft', draft);
  }

  appendScanResult(result) {
    this.recentScans.unshift(result);
    if (this.recentScans.length > MAX_SCANS) this.recentScans.length = MAX_SCANS;
    this.emit('scan', result);
  }

  nextSnapshotSeq() { return ++this.snapshotSeq; }
  nextDraftSeq() { return ++this.draftSeq; }

  /* SSE subscribers. Returns an unsubscribe function. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _broadcast(msg) {
    for (const fn of this._listeners) {
      try { fn(msg); } catch (_) { /* swallow subscriber errors */ }
    }
  }

  status() {
    return {
      startedAt: this.startedAt,
      workspaceRoot: this.workspaceRoot,
      enabled: this.settings.agentEnabled,
      throttled: this.throttled,
      cpuPercent: this.cpuPercent,
      settings: this.settings,
      sentinels: this.sentinels.map((s) => ({ name: s.name, state: s.state, info: s.info || null })),
      events:    { count: this.events.length,          max: MAX_EVENTS },
      snapshots: { count: this.recentSnapshots.length, max: MAX_SNAPSHOTS, lastSeq: this.snapshotSeq },
      drafts:    { count: this.recentDrafts.length,    max: MAX_DRAFTS,    lastSeq: this.draftSeq },
      scans:     { count: this.recentScans.length,     max: MAX_SCANS }
    };
  }

  async start() {
    this.log('ok', 'brain', `Brain starting. Workspace: ${this.workspaceRoot}`);
    for (const sentinel of this.sentinels) {
      try { await sentinel.start(); }
      catch (e) { this.log('error', sentinel.name || 'sentinel', `Start failed: ${e.message}`); }
    }
    this.log('ok', 'brain', `Brain running with ${this.sentinels.length} sentinel(s)`);
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    for (const sentinel of this.sentinels) {
      try { await sentinel.stop(); } catch (_) {}
    }
    this.log('info', 'brain', 'Brain stopped');
    this._listeners.clear();
  }

  _loadState() {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(raw);
      if (state.settings) Object.assign(this.settings, state.settings);
      this.snapshotSeq = state.snapshotSeq || 0;
      this.draftSeq = state.draftSeq || 0;
      this.recentSnapshots = Array.isArray(state.recentSnapshots) ? state.recentSnapshots : [];
      this.recentDrafts    = Array.isArray(state.recentDrafts)    ? state.recentDrafts    : [];
    } catch (e) {
      // No prior state — first run, or file removed. Fine.
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        settings: this.settings,
        snapshotSeq: this.snapshotSeq,
        draftSeq: this.draftSeq,
        recentSnapshots: this.recentSnapshots,
        recentDrafts: this.recentDrafts,
        savedAt: new Date().toISOString()
      }, null, 2));
    } catch (e) {
      // Disk full or read-only — non-fatal. Don't log on every save attempt.
    }
  }
}

/* GitSentinel — reactive trigger.

   Watches `.git/HEAD` for changes. On change:
     1. Re-read the file, parse the branch name (or detached SHA).
     2. If the branch changed AND the settings allow it, run ctx.captureAll()
        with env + git includes, build a snapshot record named
        `auto-branch-switch-<iso-slug>`, and push it onto the brain's
        recentSnapshots + emit an SSE 'snapshot' event so the UI updates live.

   Robustness:
     - 2-second cooldown coalesces git's multiple writes during a single
       checkout (lock file dance + actual HEAD rewrite).
     - chokidar's awaitWriteFinish + atomic options handle editors/tools that
       rename-on-save.
     - If `.git/HEAD` doesn't exist (not a repo, or worktree), the sentinel
       reports state='idle' and never fires. */
class GitSentinel {
  constructor(brain, opts = {}) {
    this.brain = brain;
    this.name = 'git-sentinel';
    this.state = 'idle';                       // idle | watching | stopped | error
    this.info = { branch: null, headPath: null };
    this.workspaceRoot = opts.workspaceRoot || brain.workspaceRoot;
    this.headPath = path.join(this.workspaceRoot, '.git', 'HEAD');
    this.watcher = null;
    this.lastBranch = null;
    this._inflight = false;
    this._pending = false;
  }

  async start() {
    let stat;
    try { stat = await fs.promises.stat(this.headPath); }
    catch (_) {
      this.state = 'idle';
      this.info = { branch: null, headPath: this.headPath, reason: 'no .git/HEAD' };
      this.brain.log('info', this.name, `No .git/HEAD at ${this.headPath} — sentinel idle`);
      return;
    }
    if (!stat.isFile()) {
      this.state = 'idle';
      this.info = { branch: null, headPath: this.headPath, reason: '.git/HEAD is not a regular file' };
      this.brain.log('info', this.name, '.git/HEAD is not a regular file — sentinel idle');
      return;
    }

    this.lastBranch = await this._readBranch();
    // Polling watch for .git/HEAD: git rewrites this file via lock+rename, and
    // non-polling chokidar on Windows can lose track of the inode after the
    // first rewrite (subsequent rewrites are silently missed). A 250 ms poll
    // on one file is negligible CPU and reliable across Win/macOS/Linux.
    this.watcher = chokidar.watch(this.headPath, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 250,
      binaryInterval: 250
    });
    this.watcher.on('change', () => this._onChange());
    this.watcher.on('add',    () => this._onChange());  // covers atomic replace
    this.watcher.on('error', (e) => this.brain.log('error', this.name, `Watcher error: ${e.message}`));

    await new Promise((resolve) => this.watcher.on('ready', resolve));

    this.state = 'watching';
    this.info = { branch: this.lastBranch, headPath: this.headPath };
    this.brain.log('ok', this.name, `Watching ${this.headPath} — currently on '${this.lastBranch || 'detached'}'`);
  }

  async stop() {
    if (this.watcher) {
      try { await this.watcher.close(); } catch (_) {}
      this.watcher = null;
    }
    this.state = 'stopped';
  }

  async _readBranch() {
    try {
      const content = await fs.promises.readFile(this.headPath, 'utf8');
      const refMatch = content.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m);
      if (refMatch) return refMatch[1];
      const sha = content.trim();
      return sha ? 'detached@' + sha.slice(0, 7) : null;
    } catch (_) { return null; }
  }

  /* Serialized handler — at most one in flight; if a new event arrives while
     we're working, run once more after we finish. Polling deduplicates rapid
     identical writes, so we don't need an additional time-based cooldown. */
  async _onChange() {
    if (this._inflight) { this._pending = true; return; }
    this._inflight = true;
    try {
      // Always read + track the current branch, even when disabled. Otherwise
      // disabling → switching → re-enabling would leave lastBranch stale, and
      // the next checkout back to the original branch would look like "no
      // change" and skip the capture.
      const newBranch = await this._readBranch();
      if (newBranch === this.lastBranch) return;

      const fromBranch = this.lastBranch;
      this.lastBranch = newBranch;
      this.info = { branch: newBranch, headPath: this.headPath };

      if (!this.brain.isEnabled('gitSentinel')) {
        this.brain.log('info', this.name,
          `Branch change observed but sentinel disabled in settings — tracking only (${fromBranch || '?'} → ${newBranch || '?'})`,
          { from: fromBranch, to: newBranch, skipped: true });
        return;
      }

      this.brain.log('info', this.name,
        `Branch switch: ${fromBranch || '(unknown)'} → ${newBranch || '(unknown)'}`,
        { from: fromBranch, to: newBranch });

      try {
        const snap = await this._captureAutoSnapshot(fromBranch, newBranch);
        this.brain.log('ok', this.name, `Auto-snapshot captured: ${snap.name}`, { snapshotId: snap.id, seq: snap.seq });
      } catch (e) {
        this.brain.log('error', this.name, `Auto-snapshot failed: ${e.message}`);
      }
    } finally {
      this._inflight = false;
      if (this._pending) { this._pending = false; setImmediate(() => this._onChange()); }
    }
  }

  async _captureAutoSnapshot(fromBranch, toBranch) {
    const result = await ctx.captureAll(
      this.workspaceRoot,
      { env: true, processes: false, git: true, ports: false },
      this.brain.extraRedact
    );
    const tsRaw = new Date();
    const tsSlug = tsRaw.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const seq = this.brain.nextSnapshotSeq();
    const snap = {
      id: 'snap-brain-' + tsRaw.getTime(),
      seq,
      name: `auto-branch-switch-${tsSlug}`,
      timestamp: tsRaw.toISOString(),
      workspace: path.basename(this.workspaceRoot),
      branch: toBranch || 'unknown',
      notes: `Auto-captured by Brain on branch switch ${fromBranch || '(unknown)'} → ${toBranch || '(unknown)'}`,
      source: 'brain',
      reason: 'branch-switch',
      meta: { from: fromBranch, to: toBranch },
      includes: {
        'Environment variables':     { checked: true,  meta: '' },
        'Active processes (PIDs)':   { checked: false, meta: '' },
        'Git branch & commit SHA':   { checked: true,  meta: '' },
        'Open network ports':        { checked: false, meta: '' },
        'Working tree diff':         { checked: false, meta: '' }
      },
      capture: {
        env:  result.env  ? { count: result.env.count, redactedCount: result.env.redactedCount, sample: result.env.sample } : null,
        pids: null,
        git:  result.git  ? { branch: result.git.branch, sha: result.git.shortSha || (result.git.sha && result.git.sha.slice(0, 7)), dirty: result.git.dirty, dirtyFiles: result.git.dirtyFiles, remote: result.git.remote } : null,
        ports: null,
        diff: null
      }
    };

    this.brain.appendSnapshot(snap);
    return snap;
  }
}

/* ============================================================
   LogWatchdog — proactive error pinning + auto-issue drafts.

   For each path in settings.watchedLogPaths, opens a LogStream (the same
   chokidar-backed tailer used by Phase 2's /api/log-tail/stream) and keeps a
   rolling buffer of the last 20 lines. When an incoming line matches any
   compiled errorPattern, it:
     1. Builds a Markdown draft with the 20 preceding lines as the Context
        section and the matching line as Observed.
     2. Pushes the draft onto brain.recentDrafts (cap 30) — exposed via
        /api/agent/drafts so the dashboard can pull them into devops:issue-drafts.
     3. Emits a `draft` SSE event.

   Re-syncs automatically when settings.watchedLogPaths or .errorPatterns
   change. Stops processing (but keeps watching) when brain.throttled is true. */
class LogWatchdog {
  constructor(brain, opts = {}) {
    this.brain = brain;
    this.name = 'log-watchdog';
    this.state = 'idle';
    this.info = { watching: [] };
    this.workspaceRoot = opts.workspaceRoot || brain.workspaceRoot;
    this.bufferSize = opts.bufferSize || 20;
    this.pinCooldownMs = opts.pinCooldownMs || 60 * 1000;
    this.streams = new Map();        // path → { stream, buffer, lastPinAt }
    this.patterns = [];
    this._unsubSettings = null;
    // Phase 5: enrichment + auto-file.
    this.enrichQueue = [];
    this.enrichInflight = false;
    this.enrich = null;              // set by Brain.setEnricher
    this.autoFileFn = null;          // set by Brain.setAutoFiler
  }

  async start() {
    this._compilePatterns();
    await this._rebuild();
    this._unsubSettings = this.brain.onSettingsChange((next, prev) => {
      const changed =
        JSON.stringify(next.watchedLogPaths || []) !== JSON.stringify(prev.watchedLogPaths || []) ||
        JSON.stringify(next.errorPatterns   || []) !== JSON.stringify(prev.errorPatterns   || []) ||
        next.logWatchdog !== prev.logWatchdog ||
        next.agentEnabled !== prev.agentEnabled;
      if (changed) {
        this._compilePatterns();
        this._rebuild().catch((e) => this.brain.log('error', this.name, 'Rebuild failed: ' + e.message));
      }
    });
  }

  async stop() {
    if (this._unsubSettings) this._unsubSettings();
    this._unsubSettings = null;
    for (const [, entry] of this.streams) {
      try { await entry.stream.close(); } catch (_) {}
    }
    this.streams.clear();
    this.state = 'stopped';
  }

  _compilePatterns() {
    this.patterns = [];
    for (const src of (this.brain.settings.errorPatterns || [])) {
      try { this.patterns.push(new RegExp(src, 'i')); }
      catch (e) { this.brain.log('warn', this.name, `Invalid error pattern '${src}': ${e.message}`); }
    }
  }

  async _rebuild() {
    const enabled = this.brain.isEnabled('logWatchdog');
    const requested = enabled ? (this.brain.settings.watchedLogPaths || []) : [];
    // Stop streams for paths no longer requested.
    for (const [p, entry] of Array.from(this.streams.entries())) {
      if (!requested.includes(p)) {
        try { await entry.stream.close(); } catch (_) {}
        this.streams.delete(p);
      }
    }
    // Start streams for newly requested paths.
    for (const p of requested) {
      if (this.streams.has(p)) continue;
      let resolved;
      try { resolved = withinWorkspace(this.workspaceRoot, p); }
      catch (e) {
        this.brain.log('warn', this.name, `Skipping watched path '${p}': ${e.message}`);
        continue;
      }
      const entry = {
        relPath: p,
        absolute: resolved,
        stream: new logTail.LogStream(resolved),
        buffer: [],
        lastPinAt: new Map()
      };
      this.streams.set(p, entry);
      entry.stream.subscribe((evt) => this._handleEvent(entry, evt));
      try {
        await entry.stream.start();
        this.brain.log('ok', this.name, `Watching ${p} for ${this.patterns.length} pattern(s)`);
      } catch (e) {
        this.brain.log('error', this.name, `Failed to watch ${p}: ${e.message}`);
        this.streams.delete(p);
      }
    }
    this.state = this.streams.size ? 'watching' : (enabled ? 'idle' : 'disabled');
    this.info = { watching: Array.from(this.streams.keys()), patterns: this.patterns.map((r) => r.source) };
  }

  _handleEvent(entry, evt) {
    if (evt.type !== 'line') return;
    if (!this.brain.isEnabled('logWatchdog')) return;
    // Always update buffer so a freshly-fired pattern has context, but skip the
    // pattern check itself when the agent is being throttled.
    entry.buffer.push(evt.line);
    if (entry.buffer.length > this.bufferSize) entry.buffer.shift();
    if (this.brain.throttled) return;

    for (const re of this.patterns) {
      if (!re.test(evt.line)) continue;
      const cooldownKey = re.source;
      const last = entry.lastPinAt.get(cooldownKey) || 0;
      if (Date.now() - last < this.pinCooldownMs) return;
      entry.lastPinAt.set(cooldownKey, Date.now());
      this._pin(entry, evt.line, re);
      return; // only one pattern per line; first match wins
    }
  }

  _pin(entry, line, pattern) {
    const draft = this._buildDraft(entry, line, pattern);
    this.brain.appendDraft(draft);
    this.brain.log('warn', this.name,
      `Error pinned in ${entry.relPath}: ${line.slice(0, 80)}${line.length > 80 ? '…' : ''}`,
      { filePath: entry.relPath, pattern: pattern.source, draftId: draft.id });
    this.brain.emit('notification', {
      severity: 'warn',
      title: `Error in ${entry.relPath}`,
      body: line.slice(0, 200),
      draftId: draft.id
    });
    // Phase 5: queue async enrichment if LLM is wired AND user has it on.
    if (this.enrich && this.brain.isEnabled('aiEnrichDrafts')) {
      this.enrichQueue.push(draft);
      this._drainQueue();
    }
  }

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
        context:     draft.meta && draft.meta.context     ? draft.meta.context     : [],
        workspace:   draft.workspace || this.brain.workspaceRoot,
        branch:      draft.branch || null
      },
      feature: 'log-watchdog-enrich',
      maxTokens: 400,
      temperature: 0.2
    });
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch {}
    if (!parsed) return;
    draft.enriched = true;
    draft.enrichedAt = new Date().toISOString();
    draft.confidence = parsed.confidence;
    draft.content = draft.content +
      '\n\n## Likely cause' +
      '\n\n_' + parsed.confidence + ' confidence_\n\n' + parsed.likely_cause +
      '\n\n## Suggested next steps\n\n' + (parsed.next_steps || []).map((s) => '- ' + s).join('\n') +
      '\n\n_Enriched by ' + r.model + ' · ' + ((r.usage && r.usage.totalTokens) || 0) + ' tokens_';
    const idx = this.brain.recentDrafts.findIndex((d) => d.id === draft.id);
    if (idx >= 0) this.brain.recentDrafts[idx] = draft;
    this.brain._saveState();
    this.brain.emit('draft-enriched', draft);
    this.brain.log('ok', this.name, 'enriched draft ' + draft.id, { confidence: parsed.confidence });
    // Auto-file gate (Task 21 wires the actual filer)
    if (this.brain.isEnabled('autoFileGitHub') && parsed.confidence === 'high' && this.autoFileFn) {
      try { await this.autoFileFn(draft); }
      catch (e) { this.brain.log('warn', this.name, 'auto-file failed: ' + e.message); }
    }
  }

  _buildDraft(entry, line, pattern) {
    const ts = new Date();
    const tsSlug = ts.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const seq = this.brain.nextDraftSeq();
    const context = entry.buffer.slice(0, -1); // everything before the matching line
    const summary = line.slice(0, 80).replace(/\s+/g, ' ');
    const md = [
      `# Auto-pinned error: ${summary}`,
      '',
      `- **Detected:** ${ts.toISOString()}`,
      `- **File:** \`${entry.relPath}\``,
      `- **Pattern:** \`/${pattern.source}/i\``,
      `- **Source:** Brain · LogWatchdog`,
      `- **Context lines:** ${context.length} / ${this.bufferSize}`,
      '',
      '## Context',
      '',
      '```',
      ...context,
      '>>> ' + line,
      '```',
      '',
      '## Observed',
      '',
      line,
      '',
      '## Steps to reproduce',
      '',
      '_(fill in)_',
      '',
      '## Notes',
      '',
      '_Auto-drafted by the Brain. Review, edit, and file before closing._'
    ].join('\n');

    return {
      id: 'draft-brain-' + ts.getTime(),
      seq,
      name: `auto-error-${tsSlug}`,
      title: summary,
      content: md,
      when: ts.toISOString(),
      source: 'brain',
      reason: 'error-pinned',
      meta: { filePath: entry.relPath, pattern: pattern.source, contextLines: context.length, matchedLine: line, context }
    };
  }
}

/* ============================================================
   Scheduler — Cron-lite.

   Wakes once per minute. If now's HH:MM matches settings.scheduledScanTime
   AND we haven't already run for that day's HH:MM AND the agent isn't
   throttled, runs:
     - ctx.captureAll() — auditing env / processes / git / ports
     - findTopLevelManifest() → parse → depRegistry.lookupBatch()
   Then appends a scan result and emits a `notification` if any dependency is
   outdated relative to its public-registry "latest". */
class Scheduler {
  constructor(brain, opts = {}) {
    this.brain = brain;
    this.name = 'scheduler';
    this.state = 'idle';
    this.info = { nextCheckAt: null, lastRunKey: null };
    this.workspaceRoot = opts.workspaceRoot || brain.workspaceRoot;
    this.tickInterval = opts.tickInterval || 60 * 1000;
    this.timer = null;
    this.lastRunKey = null;
    this.inFlight = false;
  }

  async start() {
    this.state = 'idle';
    this.timer = setInterval(() => this._tick(), this.tickInterval);
    this._tick(); // immediate check so a tight scheduledScanTime isn't missed
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'stopped';
  }

  _tick() {
    if (!this.brain.isEnabled('scheduledScan')) {
      this.state = 'disabled';
      return;
    }
    if (this.inFlight) return;
    const now = new Date();
    const hhmm = now.toTimeString().slice(0, 5); // HH:MM local time
    const dateKey = now.toISOString().slice(0, 10) + ' ' + hhmm;
    this.info = { nextCheckAt: new Date(now.getTime() + this.tickInterval).toISOString(), lastRunKey: this.lastRunKey, scheduledAt: this.brain.settings.scheduledScanTime };

    if (hhmm !== (this.brain.settings.scheduledScanTime || '03:00')) return;
    if (dateKey === this.lastRunKey) return;

    if (this.brain.throttled) {
      this.brain.log('info', this.name, 'Scheduled tick skipped: agent throttled');
      return;
    }

    this.lastRunKey = dateKey;
    this.runScan('schedule').catch((e) => this.brain.log('error', this.name, `Scheduled scan failed: ${e.message}`));
  }

  /* Runs the full scheduled scan. `trigger` is 'schedule' for the cron tick
     or 'manual' when invoked via POST /api/agent/scan. */
  async runScan(trigger = 'manual') {
    if (this.inFlight) throw new Error('Scan already in progress');
    this.inFlight = true;
    this.state = 'running';
    const startedAt = new Date();
    this.brain.log('ok', this.name, `Scheduled scan starting (trigger=${trigger})`);

    const result = {
      id: 'scan-' + startedAt.getTime(),
      trigger,
      startedAt: startedAt.toISOString(),
      contextSnap: null,
      depMap: null,
      outdatedCount: 0,
      errors: []
    };

    // ---- Context-Snap audit ----
    try {
      const audit = await ctx.captureAll(
        this.workspaceRoot,
        { env: true, processes: true, git: true, ports: true },
        this.brain.extraRedact
      );
      result.contextSnap = {
        envCount:   audit.env && audit.env.count,
        pidCount:   audit.processes && audit.processes.count,
        branch:     audit.git && audit.git.branch,
        sha:        audit.git && audit.git.shortSha,
        dirty:      audit.git && audit.git.dirty,
        portsCount: audit.ports && audit.ports.count
      };
    } catch (e) {
      result.errors.push({ stage: 'context-snap', message: e.message });
    }

    // ---- Dep Map scan ----
    try {
      const manifest = await depParsers.findTopLevelManifest(this.workspaceRoot);
      if (manifest) {
        const parsed = depParsers.parse(manifest.format, manifest.content);
        const ecosystem = depParsers.FORMAT_TO_ECOSYSTEM[manifest.format];
        let lookups = [];
        let outdated = [];
        if (ecosystem && parsed.length && process.env.REGISTRY_LOOKUP_ENABLED !== 'false') {
          const names = parsed.map((p) => p.name);
          lookups = await depRegistry.lookupBatch(ecosystem, names);
          const byName = {};
          lookups.forEach((l) => { byName[l.name.toLowerCase()] = l; });
          for (const dep of parsed) {
            const hit = byName[dep.name.toLowerCase()];
            if (!hit || hit.error || !hit.latest) continue;
            if (depParsers.compareVersions(dep.current, hit.latest) < 0) {
              outdated.push({ name: dep.name, current: dep.current, latest: hit.latest });
            }
          }
        }
        result.depMap = {
          manifest: manifest.relative,
          ecosystem,
          totalDeps: parsed.length,
          outdatedCount: outdated.length,
          outdated
        };
        result.outdatedCount = outdated.length;
      } else {
        result.depMap = { manifest: null, totalDeps: 0, outdatedCount: 0, outdated: [] };
      }
    } catch (e) {
      result.errors.push({ stage: 'dep-map', message: e.message });
    }

    result.completedAt = new Date().toISOString();
    result.durationMs = Date.now() - startedAt.getTime();

    this.brain.appendScanResult(result);

    if (result.outdatedCount > 0) {
      this.brain.log('warn', this.name,
        `Scan complete in ${result.durationMs} ms — ${result.outdatedCount} outdated dependencies`,
        { trigger, outdated: result.outdatedCount });
      this.brain.emit('notification', {
        severity: 'warn',
        title: `${result.outdatedCount} outdated dependencies`,
        body: `Scheduled scan of ${result.depMap.manifest} found ${result.outdatedCount} package(s) behind their public-registry latest.`,
        scanId: result.id
      });
    } else {
      this.brain.log('ok', this.name,
        `Scan complete in ${result.durationMs} ms — no issues`,
        { trigger });
    }

    this.state = 'idle';
    this.inFlight = false;
    return result;
  }
}

/* ============================================================
   ResourceThrottle — samples this Node process's CPU every few seconds via
   process.cpuUsage(). When the rolling sample exceeds settings.cpuCeiling for
   `breachThreshold` consecutive samples, sets brain.throttled = true. Other
   sentinels (LogWatchdog, Scheduler) check the flag before doing expensive
   work. Hysteresis at 80% of the ceiling avoids oscillation.

   process.cpuUsage() is built into Node — no native deps, cross-platform. */
class ResourceThrottle {
  constructor(brain, opts = {}) {
    this.brain = brain;
    this.name = 'resource-throttle';
    this.state = 'idle';
    this.info = { cpuPercent: 0, ceiling: null };
    this.sampleInterval = parseInt(process.env.BRAIN_THROTTLE_SAMPLE_MS, 10) || opts.sampleInterval || 5000;
    this.breachThreshold = opts.breachThreshold || 3;
    this.consecutiveBreaches = 0;
    this.timer = null;
    this.lastSample = null;
  }

  async start() {
    this.lastSample = { cpu: process.cpuUsage(), at: Date.now() };
    this.timer = setInterval(() => this._sample(), this.sampleInterval);
    this.state = 'sampling';
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.brain.throttled) {
      this.brain.throttled = false;
      this.brain.emit('throttle', { active: false, reason: 'sentinel-stopped' });
    }
    this.state = 'stopped';
  }

  _sample() {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const elapsedMs = Math.max(1, now - this.lastSample.at);
    const usedMicroseconds = (cpu.user - this.lastSample.cpu.user) + (cpu.system - this.lastSample.cpu.system);
    let cpuPercent = (usedMicroseconds / 1000) / elapsedMs * 100;
    if (!Number.isFinite(cpuPercent)) cpuPercent = 0;
    cpuPercent = Math.max(0, Math.min(100, cpuPercent));
    this.lastSample = { cpu, at: now };

    this.brain.cpuPercent = Math.round(cpuPercent * 10) / 10;
    // Use nullish coalescing rather than ||, so an explicit ceiling of 0 (meaning
    // "throttle on any CPU at all", useful for testing or paranoid air-gapped
    // deploys) is honored rather than silently replaced by the 75% fallback.
    const rawCeiling = this.brain.settings.cpuCeiling;
    const ceiling = Number.isFinite(Number(rawCeiling)) ? Number(rawCeiling) : 75;
    this.info = { cpuPercent: this.brain.cpuPercent, ceiling };

    if (cpuPercent > ceiling) {
      this.consecutiveBreaches++;
      if (this.consecutiveBreaches >= this.breachThreshold && !this.brain.throttled) {
        this.brain.throttled = true;
        this.brain.log('warn', this.name,
          `CPU ${cpuPercent.toFixed(1)}% > ceiling ${ceiling}% for ${this.consecutiveBreaches} samples — throttling`,
          { cpuPercent: this.brain.cpuPercent, ceiling });
        this.brain.emit('throttle', { active: true, cpuPercent: this.brain.cpuPercent, ceiling });
      }
    } else if (cpuPercent < ceiling * 0.8) {
      this.consecutiveBreaches = 0;
      if (this.brain.throttled) {
        this.brain.throttled = false;
        this.brain.log('ok', this.name,
          `CPU ${cpuPercent.toFixed(1)}% below ${(ceiling * 0.8).toFixed(1)}% — resuming`,
          { cpuPercent: this.brain.cpuPercent, ceiling });
        this.brain.emit('throttle', { active: false, cpuPercent: this.brain.cpuPercent, ceiling });
      }
    }
  }
}

module.exports = { Brain, GitSentinel, LogWatchdog, Scheduler, ResourceThrottle };
