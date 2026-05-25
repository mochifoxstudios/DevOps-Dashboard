# DevOps Local Agent

The local backend for the DevOps Local dashboard. Without it, the dashboard runs in pure browser-only mode (drop-files-only). With it, the five tools call out to a real local process that can read your environment, list processes, run `git`, and (in later phases) tail logs and proxy doc fetches.

## Why a backend at all?

The browser sandbox can't:

- Read `process.env` of the shell that launched it
- Run `ps`, `tasklist`, `netstat`, `git`, etc.
- `tail -f` a file that's still being written to
- Make cross-origin requests to docs sites that lack CORS headers

The agent is a **local-only** process that does these things on the user's behalf. It refuses everything outside a single `WORKSPACE_ROOT`, redacts secret-looking env vars before sending them to the browser, and disables every destructive operation by default.

## Run it

```sh
cd agent
npm install
cp .env.example .env       # then edit .env to set WORKSPACE_ROOT
npm start
```

Then open <http://localhost:3737/> — the agent serves the dashboard from `..` so the frontend and API share one origin.

For auto-reload while developing the agent itself:

```sh
npm run dev
```

## Configuration

`.env` keys (see [.env.example](.env.example)):

| Key | Default | Purpose |
|---|---|---|
| `PORT` | `3737` | Port the agent listens on |
| `WORKSPACE_ROOT` | cwd | Single directory the agent is allowed to inspect (file ops + `git`) |
| `ALLOW_DESTRUCTIVE` | `false` | When true, mutating endpoints are accepted *with* the `X-Confirm-Destructive: yes` header |
| `EXTRA_REDACT_PATTERNS` | empty | Comma-separated regex patterns added to the env-var redaction list |

Default redaction patterns (always on): `SECRET`, `TOKEN`, `KEY`, `PASSWORD`, `PASSPHRASE`, `AUTH`, `CREDENTIAL`, `COOKIE`, `SESSION`, `BEARER`, `API_KEY`, `PRIVATE`. Matching env vars are replaced with `***[redacted]***` before they leave the process.

## Security model

- **Workspace boundary**: `lib/safety.js#withinWorkspace` resolves any incoming path against `WORKSPACE_ROOT` and throws if the result escapes via `..` or absolute paths. Every file-touching endpoint must route through it.
- **Destructive gate**: `lib/safety.js#requireDestructiveAllowed` is middleware that returns 403 unless `ALLOW_DESTRUCTIVE=true` AND the client sends `X-Confirm-Destructive: yes`.
- **System commands**: only specific allowlisted commands are run via `child_process.exec` — `ps`, `tasklist`, `netstat`, `ss`, `git branch --show-current`, `git rev-parse HEAD`, `git status --porcelain`, `git config --get remote.origin.url`. No user input is concatenated into shell strings.
- **Output caps**: each command has a `maxBuffer` and `timeout`. Process and port lists are truncated to 100 entries.
- **Bind address**: Express defaults to `0.0.0.0`. If you want loopback-only, pass `app.listen(PORT, '127.0.0.1', …)` — the default is permissive because docker-desktop / WSL / VS Code Forwarded Ports often need 0.0.0.0.

## API (Phase 1)

All responses are JSON. Errors return `{ "error": "<message>" }` with a 4xx/5xx status.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/health` | Server identity, uptime, workspace root, `allowDestructive` |
| `GET`  | `/api/workspace` | `{ root, name }` |
| `GET`  | `/api/context-snap/env` | Env vars (counts + sample, redacted). `?full=1` includes the full map. |
| `GET`  | `/api/context-snap/processes` | PID + command list (capped at 100) |
| `GET`  | `/api/context-snap/git` | `branch`, `sha`, `shortSha`, `dirty`, `dirtyFiles`, `remote` |
| `GET`  | `/api/context-snap/ports` | Listening ports observed by `netstat` (capped at 100) |
| `POST` | `/api/context-snap/capture` | One call: runs all four collectors. Body: `{ includes: { env, processes, git, ports } }` (each defaults to true) |

## API (Phase 2 — Log-Tail)

All paths are validated against `WORKSPACE_ROOT` via `lib/safety.js#withinWorkspace`. Paths that resolve outside the root return HTTP 403.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/log-tail/find?exts=.log,.txt&max=50` | Recursive workspace walk for log-shaped files. Skips `node_modules`, `.git`, etc. Sorted by mtime desc. Returns `{ workspaceRoot, results: [{ path, absolute, size, mtimeMs }] }`. |
| `GET` | `/api/log-tail/file?path=<rel-or-abs>&bytes=65536` | Initial backfill: returns the last `bytes` of the file (default 64 KB, max 4 MB) with the first partial line trimmed. Useful for showing existing content before opening a stream. |
| `GET` | `/api/log-tail/stream?path=<rel-or-abs>` | **Server-Sent Events** stream. Emits `event: open` once, then `event: line` per new line as the file grows, plus `rotated` / `truncated` / `unlink` / `error` on file lifecycle. Heartbeats every 25s. Closes when the client disconnects (which releases the chokidar watcher). |

### Streaming details

- **SSE, not WebSocket** — logs are server-to-client only, and `EventSource` reconnects automatically on drop. No extra library on the browser side.
- **File watching via `chokidar`** — wraps `fs.watch` with smarter handling of editors that atomically rename-on-save, file rotation, and platform differences (ReadDirectoryChangesW / FSEvents / inotify).
- **Tail from the current end** — when the stream opens, only NEW bytes appended after that moment are delivered. Use `/api/log-tail/file` first if you want historical lines.
- **Rotation handling** — file truncated → emit `truncated`, reset offset to 0, continue. File deleted then recreated → emit `unlink` then `rotated`, reset offset, continue.
- **Output cap** — each read chunk is capped at 1 MB; bursts beyond that are spread across multiple reads so a giant write doesn't block the event loop.
- **Concurrency** — each SSE connection gets its own LogStream + watcher. Two clients tailing the same file get independent offsets. The OS handles concurrent reads.

## API (Phase 3 — Dependency registry + Docs Scraper proxy)

Both Phase 3 features are **optional** — disable them with env flags for fully air-gapped operation. The dashboard still works (parsing, file drops, browser-side fetch) when these endpoints are unreachable.

### Dep-Map registry lookups

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/dep-map/lookup` | Batched "latest version" lookup for one ecosystem. Body: `{ ecosystem: "npm"\|"pip"\|"cargo"\|"go"\|"gem", packages: ["name", ...], timeoutMs?: 5000, concurrency?: 6 }`. Returns `{ ecosystem, count, results: [{ name, latest?, error?, extras?, source }] }`. |
| `GET`  | `/api/dep-map/cache` | Cache stats: `{ enabled, total, live, errors, expired }`. |
| `DELETE` | `/api/dep-map/cache` | Clears the in-memory cache. |

Behaviour:

- **Only five hard-coded hosts** are ever contacted: `registry.npmjs.org`, `pypi.org`, `crates.io`, `proxy.golang.org`, `rubygems.org`. An attacker who manages to inject an alternative URL can't redirect the lookup elsewhere.
- **15-minute in-memory cache** keyed by `ecosystem:name` so a manifest with 200 packages is not re-hammered on re-scans.
- **Per-request timeout** (default 5 s, max 15 s) via `AbortController`.
- **Pool of 6 parallel requests** (max 12). A 200-package npm manifest finishes in ~3–5 s on a typical home connection.
- Disable entirely with `REGISTRY_LOOKUP_ENABLED=false`. The endpoint returns HTTP 503; the dashboard's Dep Map keeps parsing manifests and just shows "—" in the Latest column.

### Docs Scraper proxy

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/scraper/config` | Returns the active allowlist and limits — useful for debugging from the dashboard. |
| `POST` | `/api/scraper/fetch` | Fetches a URL server-side. Body: `{ url, as?: "markdown"\|"html"\|"auto", timeoutMs?, maxBytes? }`. Returns `{ url, finalUrl, status, contentType, bytes, body, markdown? }`. |

Security model:

| Defense | Mechanism |
|---|---|
| **Host allowlist** | `SCRAPER_ALLOWED_HOSTS` is a comma-separated list. Exact match (`docs.stripe.com`) or subdomain wildcard (`*.stripe.com`). Default empty → deny all. |
| **Allow-any override** | `SCRAPER_ALLOW_ANY=true` bypasses the allowlist (SSRF check still applies). Off by default. |
| **SSRF block** | Hostname is DNS-resolved (`dns.lookup({ all: true })`); request is refused if **any** resolved IP is in a private range: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0.0.0.0/8, IPv6 ::1, fc00::/7, fe80::/10, IPv4-mapped IPv6. |
| **Redirect re-validation** | After redirects, the final URL's host is re-checked against allowlist + SSRF rules. A whitelisted host can't redirect into a private IP. |
| **Header sanitization** | Incoming request headers are not forwarded. Agent sets its own `User-Agent`, `Accept`, `Accept-Language`. Response `Set-Cookie` / `Authorization` headers are never exposed to the browser (we return body as JSON, not pass-through). |
| **Schema restriction** | Only `http:` / `https:` URLs accepted. No `file://`, `data:`, `gopher://`, etc. |
| **Size cap** | Default 2 MB (max 8 MB) — read with a byte counter and a streaming abort. |
| **Markdown normalization** | If the response is `text/html`, [`turndown`](https://github.com/mixmark-io/turndown) converts it to clean Markdown server-side. `<script>`, `<style>`, `<noscript>`, `<iframe>`, `<svg>` are stripped before conversion. |

### Offline operation

| Feature | Offline behaviour |
|---|---|
| Context-Snap (Phase 1) | Fully offline — env / processes / git / netstat are all local. |
| Log-Tail (Phase 2) | Fully offline — `chokidar` watches local files only. |
| Dep parsing | Fully offline — `package.json`/`requirements.txt`/etc. are parsed locally. |
| Dep "latest version" | Requires internet. Set `REGISTRY_LOOKUP_ENABLED=false` to skip; table shows "—". |
| Docs Scraper (URL fetch) | Requires internet IF the URL is external. Same-origin URLs work offline. Drag-drop of `.md`/`.txt`/`.html` files works offline. |

The dashboard's brand pill says **AGENT ONLINE · LOCAL** when the agent is reachable, regardless of whether the agent itself can reach the internet. Internet failures surface as feature-level toasts, not whole-app failures.

## API (Phase 4 — Autonomous Brain)

The Brain is a long-running background service inside the agent that observes the workspace and acts proactively. It composes a set of Sentinels (one per signal) that share a settings store, an event log, and an on-disk state file at `agent/.brain-state.json`.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/agent/status` | Brain identity + every sentinel's `state` + live `throttled` flag + `cpuPercent` + settings snapshot. |
| `GET`  | `/api/agent/events?limit=100` | Recent activity log (ring buffer of 500). Each event: `{ ts, level, source, message, data? }`. |
| `GET`  | `/api/agent/events/stream` | **SSE bus**. On connect emits `status` + last 20 `log` events; then streams live `log`, `snapshot`, `draft`, `scan`, `notification`, and `throttle` events. Heartbeats every 25 s. |
| `GET`  | `/api/agent/snapshots?since=<iso>` | Brain-generated snapshots (newest first, max 50). |
| `GET`  | `/api/agent/drafts?since=<iso>` | Auto-pinned issue drafts (newest first, max 30) — produced by the **LogWatchdog**. |
| `GET`  | `/api/agent/scans` | Last 20 scheduled-scan results — produced by the **Scheduler**. |
| `POST` | `/api/agent/scan` | Trigger the scheduled scan immediately. Returns the full result. |
| `POST` | `/api/agent/settings` | Runtime toggles. Unknown keys ignored. Body keys: `agentEnabled`, `gitSentinel`, `logWatchdog`, `scheduledScan`, `scheduledScanTime`, `cpuCeiling`, `watchedLogPaths`, `errorPatterns`. |

### GitSentinel — reactive trigger

Watches `.git/HEAD` in the workspace via chokidar with `usePolling: true, interval: 250` (file polling is the only reliable approach on Windows for git's lock-and-rename HEAD rewrites). When the branch changes:

1. Read the new branch name from HEAD (or `detached@<shortsha>` if HEAD is detached).
2. Call `ctx.captureAll(workspaceRoot, { env: true, processes: false, git: true, ports: false })` — uses the existing Context-Snap engine, no code duplication.
3. Build a snapshot record named `auto-branch-switch-<iso-slug>` with `source: 'brain'`, `reason: 'branch-switch'`, and `meta: { from, to }`.
4. Push onto the brain's recent-snapshots list and emit a `snapshot` SSE event so the dashboard updates instantly.

The handler is serialized (`_inflight` lock) so rapid writes don't stack. It always tracks `lastBranch` even when the sentinel is disabled in settings — otherwise toggling off → switching → toggling on would leave the tracker stale and miss the next real change. When the workspace isn't a git repo, the sentinel boots into `state: 'idle'` and never fires.

### LogWatchdog — proactive error pinning

For each path in `settings.watchedLogPaths`, opens a `LogStream` (the same chokidar-backed tailer Phase 2 uses for `/api/log-tail/stream`) and keeps a rolling buffer of the last 20 lines. Every incoming line is tested against each compiled `errorPattern`. On match:

1. Build a Markdown draft with the 20 preceding lines as a `## Context` block (with `>>>` marking the matched line) and the matched line as `## Observed`.
2. Push the draft onto `brain.recentDrafts` (cap 30) — exposed via `/api/agent/drafts`. The UI merges these into its `devops:issue-drafts` list.
3. Emit a `draft` SSE event AND a `notification` event with severity `warn`.

**Cooldown:** the same pattern can pin at most once per minute per file (`pinCooldownMs = 60_000`). Different patterns on the same file are independent.

**Path security:** every entry in `watchedLogPaths` is resolved through `withinWorkspace()` from `lib/safety.js`. Paths escaping the workspace are logged and skipped, never watched.

**Re-syncs automatically** when any of `watchedLogPaths`, `errorPatterns`, `logWatchdog`, or `agentEnabled` change via `POST /api/agent/settings`. Closes old streams, starts new ones, recompiles regexes.

**Respects throttle:** when `brain.throttled === true`, lines are still buffered (so re-enable has fresh context) but pattern checks are skipped. No drafts are produced under throttle.

### Scheduler — Cron-lite

A `setInterval(60_000)` tick checks the current local `HH:MM` against `settings.scheduledScanTime` (default `03:00`). When they match and we haven't already run for that day-minute combo, runs:

1. `ctx.captureAll()` with all four collectors (env + processes + git + ports).
2. `depParsers.findTopLevelManifest()` → `depParsers.parse()` → `depRegistry.lookupBatch()` to find outdated dependencies vs. public-registry latest.

Outputs a `scan` result like:

```json
{
  "id": "scan-…",
  "trigger": "schedule",
  "startedAt": "…",
  "completedAt": "…",
  "durationMs": 1720,
  "contextSnap": { "envCount": 88, "pidCount": 404, "branch": "main", "sha": "ffde795", "dirty": false, "portsCount": 605 },
  "depMap": {
    "manifest": "package.json",
    "ecosystem": "npm",
    "totalDeps": 2,
    "outdatedCount": 2,
    "outdated": [
      { "name": "lodash",  "current": "1.0.0", "latest": "4.18.1" },
      { "name": "express", "current": "1.0.0", "latest": "5.2.1" }
    ]
  },
  "outdatedCount": 2,
  "errors": []
}
```

If `outdatedCount > 0`, a `warn`-severity `notification` event fires with title `"<n> outdated dependencies"`.

**Manual trigger:** `POST /api/agent/scan` runs the same logic immediately. Body is empty. Returns the result synchronously. Useful for a UI "Scan now" button.

**Respects throttle:** scheduled ticks are skipped when `brain.throttled === true`. Manual triggers via the API always run — the user explicitly clicked.

**Disable cleanly:** `POST /api/agent/settings { scheduledScan: false }` → next tick reports `state: 'disabled'` and does nothing; manual `/scan` still works.

### ResourceThrottle — Adaptive backoff

Samples this Node process's CPU every `BRAIN_THROTTLE_SAMPLE_MS` ms (default 5000) using `process.cpuUsage()` — built into Node, no native deps, cross-platform.

State machine:
- Each sample computes `cpuPercent = (Δuser + Δsystem) / Δelapsed × 100`.
- If `cpuPercent > cpuCeiling` for `breachThreshold` consecutive samples (default 3 → 15 s at default interval), flip `brain.throttled = true` and emit `throttle { active: true, cpuPercent, ceiling }`.
- If `cpuPercent < 0.8 × cpuCeiling` (hysteresis to avoid oscillation), reset breach counter; if currently throttled, flip back to `false` and emit `throttle { active: false }`.

Other sentinels poll `brain.throttled` before doing expensive work:
- **LogWatchdog** skips pattern checks (but keeps buffering).
- **Scheduler** skips scheduled ticks; manual scans still run.
- **GitSentinel** is unaffected (reactive, microsecond-cost).

Configuration:
- `settings.cpuCeiling` (percent, default 75). A literal `0` is honored — means "any CPU triggers throttle".
- `BRAIN_THROTTLE_SAMPLE_MS` env var overrides the 5 s default sample interval (useful for testing).

### Settings model

```json
{
  "agentEnabled":       true,                  // Master switch. False ⇒ every sentinel idles.
  "gitSentinel":        true,                  // Auto-snapshot on branch switch.
  "logWatchdog":        true,                  // (Phase 4 follow-up)
  "scheduledScan":      true,                  // (Phase 4 follow-up)
  "scheduledScanTime":  "03:00",
  "cpuCeiling":         75,
  "watchedLogPaths":    [],
  "errorPatterns":      ["CRITICAL", "FATAL", "\\bpanic\\b", "unhandledRejection", "segfault"]
}
```

Settings live in `agent/.brain-state.json` (gitignored). They merge with defaults on load and are persisted on every `POST /api/agent/settings`. The dashboard's persist.js can post a subset whenever the user toggles the matching UI switches — wiring that comes next.

### Sentinel lifecycle

Each sentinel exposes `{ name, state, info, start(), stop() }`. The Brain starts them in sequence after the HTTP server is listening (so a slow `chokidar.ready` doesn't block requests) and stops them on `SIGINT` / `SIGTERM`. Sentinel failures are caught and logged — one bad sentinel does not bring down the Brain or the agent.

### Smoke tests

Four smoke fixtures in `agent/fixtures/`. Each one spins up a throwaway workspace in `os.tmpdir()`, boots a fresh agent on a private port (3743–3746), exercises the sentinel end-to-end, and tears everything down.

| Fixture | Port | Scenario |
|---|---|---|
| `brain-git-smoke.mjs`       | 3743 | Real git repo. Verifies GitSentinel registration, branch-switch detection, snapshot persistence, settings-toggle gating, and re-enable resumption. **8 assertions.** |
| `brain-logwatch-smoke.mjs`  | 3744 | Watches a log file. Verifies benign lines don't pin, FATAL pins with 20-line context, per-pattern cooldown suppresses dupes, different patterns fire independently, disabling stops new drafts. **5 assertions.** |
| `brain-scheduler-smoke.mjs` | 3745 | Workspace with `package.json` containing outdated `lodash@1.0.0` + `express@1.0.0`. Verifies `POST /api/agent/scan` returns full Context-Snap + Dep Map results, real npm registry lookup detects both outdated, warning event recorded, scan listed in `/api/agent/scans`. **6 assertions.** |
| `brain-throttle-smoke.mjs`  | 3746 | Loads agent with rapid HTTP requests, ceiling=0. Verifies throttle flips true after 3 samples, LogWatchdog drops a FATAL while throttled, raising ceiling restores throttle to false, a fresh FATAL then pins. **6 assertions.** |

All four pass on Windows · Node 24 · git 2.x.

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

### Smoke tests (Phase 5)

| Fixture | Port | Scenario |
|---|---|---|
| `llm-provider-smoke.mjs` | 3760 | Stub Ollama; verify provider switching, listModels, testKey round-trip. |
| `log-enrich-smoke.mjs` | 3762 | Stub Ollama returns valid JSON; verify bare → enriched draft via SSE, content includes Likely cause + Suggested next steps, audit record present. |
| `diff-narrator-smoke.mjs` | 3764 | Two synthetic snapshots; verify structured diff + narration round-trip. |
| `github-file-smoke.mjs` | 3766 | Stub GitHub at port 3767; verify PAT auth, successful file, 429-queued behavior, audit records. |
| `audit-chain-smoke.mjs` | n/a | Direct module test: 80 records → rotation → tamper-detection across rotated files. |
| `brain-loop-e2e-smoke.mjs` | 3768 | Full closed loop: FATAL → enrichment → high confidence → auto-file → audit chain verifies. |

## Frontend integration

The dashboard's [js/agent-client.js](../js/agent-client.js) probes `/api/health` on load and switches the brand status pill to **AGENT ONLINE · LOCAL** when the agent is reachable. [js/brain-client.js](../js/brain-client.js) (Phase 4) subscribes to the SSE bus and merges brain-generated snapshots + drafts into localStorage. [js/features.js](../js/features.js) adds a Context-Snap "Compare" button (Phase 5) and a Drafts Inbox at the bottom of Issue Filler with ✨ Enrich + File-on-GitHub buttons.
