# DevOps Local — Operations Dashboard

A self-contained developer console you run on your own machine. Five tools (Context-Snap, Quick-Docs Scraper, Dependency Map, Log-Tail Filter, Issue Template Filler) for the small, recurring tasks that interrupt a developer's flow. No cloud account, no telemetry, no build step — just static files plus an optional Node "agent" process that adds live system access and a background **Autonomous Brain**.

---

## Table of contents

- [Quick start (60 seconds)](#quick-start-60-seconds)
- [What this is, and the problem it solves](#what-this-is-and-the-problem-it-solves)
- [Three ways to run — and what each unlocks](#three-ways-to-run--and-what-each-unlocks)
- [Prerequisites](#prerequisites)
- [Detailed setup](#detailed-setup)
  - [Mode 1: open `index.html` directly](#mode-1-open-indexhtml-directly)
  - [Mode 2: serve with Python's HTTP server](#mode-2-serve-with-pythons-http-server)
  - [Mode 3: run the local agent (recommended)](#mode-3-run-the-local-agent-recommended)
- [Verifying it works](#verifying-it-works)
- [Your first 10 minutes — a walkthrough](#your-first-10-minutes--a-walkthrough)
- [The five tools](#the-five-tools)
- [The Autonomous Brain (Mode 3 only)](#the-autonomous-brain-mode-3-only)
- [Workspaces, profile, settings](#workspaces-profile-settings)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Where your data lives](#where-your-data-lives)
- [Troubleshooting](#troubleshooting)
- [Factory reset](#factory-reset)
- [Folder layout](#folder-layout)
- [Customising](#customising)
- [Security model in one paragraph](#security-model-in-one-paragraph)
- [Origin & further reading](#origin--further-reading)

---

## Quick start (60 seconds)

```sh
git clone <https://github.com/mochifoxstudios/DevOps-Dashboard> devops-local
cd devops-local
```

You have **three modes**. Pick one. Each mode unlocks more features than the last.

```sh
# Mode 1 — Zero-install. Browser only. ~5 seconds.
#   Double-click index.html.

# Mode 2 — Same as Mode 1 but served over HTTP (better clipboard support).
py -3 -m http.server 8765
#   Then open http://localhost:8765/

# Mode 3 — Recommended. Adds backend + Autonomous Brain. Requires Node 18+.
cd agent
npm install                              # one-time, ~10 seconds
cp .env.example .env                     # then edit WORKSPACE_ROOT inside .env
npm start
#   Then open http://localhost:3737/
```

The dashboard always works. Modes 1 and 2 just gracefully skip backend-only features. The brand pill in the sidebar tells you which mode you're in:

- 🟢 **OFFLINE LOCAL MODE** — Modes 1 or 2
- 🟢 **AGENT ONLINE · LOCAL** — Mode 3, backend reachable
- 🟢 **BRAIN ACTIVE** — Mode 3, Autonomous Brain running
- 🟡 **BRAIN THROTTLED** — Mode 3, the ResourceThrottle paused non-essential work

**Phase 5 (Brain Loop) adds**, on top of Mode 3: pluggable LLM provider (Ollama / OpenAI / Anthropic / Bedrock), automatic enrichment of LogWatchdog drafts with root-cause analysis, Context-Snap "Compare" with AI-narrated diffs, one-click "File on GitHub" with auto-file mode, and a hash-chained AI audit log for compliance. All configured under Settings → AI &amp; closed loop. See [`agent/README.md`](agent/README.md) for the full security model.

---

## What this is, and the problem it solves

Small developer-ops tasks break flow. You're mid-feature and you need to remember exactly what your env looked like before you started, or you need to skim a doc page that's CORS-blocked, or you want to know which `package.json` dependency just went out of date. Existing tools either require cloud accounts (you don't want to upload `process.env`) or are CLI utilities scattered across half a dozen man pages.

This dashboard puts those tasks behind one local UI. **Everything stays on your machine** — there is no remote service, no API key, no telemetry. The optional Node agent runs as a single process bound to one workspace root, with strict path validation and a "destructive operations disabled by default" posture.

The dashboard ships **empty** on first launch: zero snapshots, zero workspaces, zero saved data, no profile. Every number on screen represents something you actually did. There is no demo data baked in.

---

## Three ways to run — and what each unlocks

| Mode | Command | URL | What you get | What's missing |
|---|---|---|---|---|
| **1. Static file** | (none — double-click `index.html`) | `file://…/index.html` | All 5 tools in browser-only mode. Drop files, parse manifests, render markdown, persist to localStorage, all chrome (settings, profile, palette, popovers). | No real env / processes / git / ports. No live log tailing. No proxy for CORS-blocked docs. No registry "latest version" lookups. No Brain. Clipboard `Copy` falls back to download on `file://`. |
| **2. Static + Python server** | `py -3 -m http.server 8765` | <http://localhost:8765/> | Same as Mode 1, plus clipboard write works (browsers require a secure context like `localhost` or `https://`). | Same as Mode 1. |
| **3. Local agent** *(recommended)* | `cd agent && npm install && npm start` | <http://localhost:3737/> | **Everything.** Mode 2 features, plus: live Context-Snap from real env / processes / git / netstat. Live log streaming via Server-Sent Events. Dependency registry lookups (npm, PyPI, crates.io, etc.). Scraper proxy with Turndown HTML→Markdown. The four-sentinel Autonomous Brain (auto-snapshot on branch switch, error pinning, scheduled audits, CPU-based throttling). | Nothing — Mode 3 is the full experience. |

You can hop between modes freely. Your `localStorage` data survives. The agent's data lives in a separate state file (`agent/.brain-state.json`) so toggling Mode 3 on/off never disturbs your dashboard data.

---

## Prerequisites

| What you need | Mode 1 | Mode 2 | Mode 3 |
|---|---|---|---|
| A modern browser (Chrome 100+ / Firefox 100+ / Safari 15+ / Edge 100+) | ✅ | ✅ | ✅ |
| Python 3.x in `PATH` | — | ✅ | — |
| Node.js 18 or later, with `npm` | — | — | ✅ |
| `git` in `PATH` (optional but recommended) | — | — | for GitSentinel |
| Internet access | — | — | only when running scraper / registry lookups |

**Verify your installs:**

```sh
node --version    # should print v18.x.x or higher
npm --version     # should print 9.x or higher
git --version     # any modern git
py -3 --version   # Python 3.x (Mode 2)
```

Disk footprint of the whole thing: ~5 MB without `node_modules`, ~25 MB with it. Zero native binaries — `npm install` works on Windows, macOS, and Linux identically.

---

## Detailed setup

### Mode 1: open `index.html` directly

Best for: trying the dashboard with literally zero install, or running on a locked-down machine where you can't run Python or Node.

1. Open this folder in your file manager.
2. Double-click `index.html`. Your default browser opens it as `file://…/index.html`.
3. The dashboard loads. The brand pill says **OFFLINE LOCAL MODE**.
4. You can immediately start using:
   - Drag-drop a `package.json` onto the **Dependency Map** view to parse it.
   - Drag-drop a `.log` file onto the **Log-Tail Filter** to inspect it.
   - Click **Context-Snap → Capture context** to record a (synthetic) snapshot of your form selections.
   - Type a doc URL into **Quick-Docs Scraper**, click Fetch — works if the host allows CORS, fails gracefully otherwise.
   - Fill the **Issue Template Filler** form, watch the markdown render live.

**Caveats:**
- On `file://`, the browser blocks `navigator.clipboard.writeText`. The Issue Filler's "Copy" button auto-falls-back to downloading the markdown as a `.md` file.
- The Docs Scraper can fetch URLs but most public docs sites send a `Access-Control-Allow-Origin` header that excludes `file://`, so external fetches usually fail with a CORS error. Drop a local `.md` file instead, or switch to Mode 3 which proxies through the agent.

### Mode 2: serve with Python's HTTP server

Best for: most of the convenience of Mode 3 with no Node install. You get clipboard support and slightly nicer URLs.

```sh
# From the repo root
py -3 -m http.server 8765      # Windows
python3 -m http.server 8765    # macOS / Linux
```

Then open <http://localhost:8765/>. Stop the server with `Ctrl+C`.

All the Mode 1 caveats about external fetches still apply — Python's HTTP server doesn't proxy, it just serves static files. If you want a different port, change `8765` to anything free.

### Mode 3: run the local agent (recommended)

Best for: actual day-to-day use. The agent does the things the browser fundamentally can't.

#### 3a. One-time setup

```sh
cd agent

npm install
# Installs express, cors, dotenv, chokidar, turndown — about 73 transitive
# packages, no native bindings, no internet needed after this completes.
# Takes ~10 seconds on a fresh checkout.

cp .env.example .env
# .env is your local config (gitignored). Open it in your editor and set:
#
#   WORKSPACE_ROOT=D:/Path/To/My/Project
#     The single directory the agent is allowed to inspect. All file
#     operations and git commands are anchored here. A request that
#     resolves outside this root is rejected with HTTP 403.
#
#   Optional:
#   PORT=3737                       — what port to listen on
#   REGISTRY_LOOKUP_ENABLED=true    — set false for fully air-gapped operation
#   SCRAPER_ALLOWED_HOSTS=          — comma-separated, e.g. "docs.stripe.com,*.mdn.com"
#   ALLOW_DESTRUCTIVE=false         — leave false unless you really need it
```

#### 3b. Start it

```sh
npm start
```

You'll see a startup banner:

```
────────────────────────────────────────────────────────────────
 DevOps Local Agent v1.0.0
 Listening on http://localhost:3737
 Workspace:   D:/Path/To/My/Project
 Destructive: BLOCKED
 Frontend:    http://localhost:3737/
 Health:      http://localhost:3737/api/health
 Brain:       http://localhost:3737/api/agent/status
────────────────────────────────────────────────────────────────
```

Open <http://localhost:3737/> in your browser.

#### 3c. What the agent does on startup

1. Resolves `WORKSPACE_ROOT` and asserts it's an existing directory.
2. Initializes the four Brain sentinels:
   - **GitSentinel** starts polling `<workspace>/.git/HEAD` for branch changes.
   - **LogWatchdog** boots into "idle" — it has no watched paths until you configure some.
   - **Scheduler** schedules a daily scan at the configured time (default `03:00`).
   - **ResourceThrottle** begins sampling this Node process's CPU usage every 5 seconds.
3. Loads any saved Brain state from `agent/.brain-state.json` (settings, sequence counters, recent snapshots).
4. Begins accepting API requests at `/api/*` and serves the dashboard at `/`.

If `WORKSPACE_ROOT` isn't a git repo, the GitSentinel sits idle (no error) — it'll log "No .git/HEAD — sentinel idle".

#### 3d. Stop it

`Ctrl+C` in the terminal. The agent traps `SIGINT` / `SIGTERM`, gracefully stops all sentinels (so chokidar watchers release file handles), then exits.

#### 3e. Auto-reload during development (optional)

If you're hacking on the agent itself:

```sh
npm run dev
# Uses node --watch to restart on every .js change in agent/
```

---

## Verifying it works

After starting in any mode, do this 30-second check:

1. **Browser tab shows the dashboard** — sidebar on the left, "No workspace · click to add one" pill at top.
2. **Brand pill** tells you the mode (see the legend above).
3. **Open the command palette with ⌘K** (Mac) or **Ctrl+K** (Windows/Linux). You should see 18 commands. Esc closes it.
4. **For Mode 3 only**, in a separate terminal:
   ```sh
   curl http://localhost:3737/api/health
   # Should print JSON with ok:true, your workspaceRoot, platform, nodeVersion.

   curl http://localhost:3737/api/agent/status
   # Should print Brain status with 4 sentinels (git-sentinel, log-watchdog,
   # scheduler, resource-throttle), settings, cpuPercent, throttled flag.
   ```

If those four checks pass, everything's wired correctly.

---

## Your first 10 minutes — a walkthrough

Assuming Mode 3. The same flow works in Modes 1/2 with backend features falling back to browser-only.

### Minute 1 — Add a workspace

Click the workspace pill in the header (currently says "No workspace · click to add one"). A popover opens. Click **Add workspace…**. Fill in:

- **Name:** e.g. `acme-api`
- **Local path:** e.g. `~/code/work/acme-api`
- **Initials:** 2–3 letters, e.g. `AA`
- **Glyph color:** pick anything

Click **Add workspace**. The header pill updates immediately and your workspace is saved.

### Minute 2 — Save your profile

Click the sidebar identity row (bottom-left, currently says "Sign in to get started"). The profile modal opens. Fill display name and email. Optional: click **Upload photo** to set an avatar.

Click **Save Changes**. The sidebar handle and avatar update on the spot.

### Minute 3 — Capture your first context snapshot

Press **⌘1** to jump to Context-Snap. Click **Capture context**.

- In Modes 1/2: a synthetic snapshot named `snapshot-01` appears in the captured-environment pane.
- In Mode 3: the agent fetches your real `process.env`, real git branch + SHA, real listening ports, and the snapshot reflects them. Secrets like `*_TOKEN`, `*_KEY`, `*_PASSWORD` are redacted with `***[redacted]***` before they leave the agent process.

Click **Export** — your browser downloads `snapshot-01.snap.json` for later restore. Drag that file back onto the view to import it.

### Minute 4 — Parse a dependency manifest

Press **⌘3** to jump to Dependency Map. Drag your project's `package.json` (or `requirements.txt`, `Cargo.toml`, `go.mod`, `Gemfile.lock`, `Pipfile`) onto the dropzone.

The table populates with every dependency. The **Status** column says `runtime` or `dev` (for npm) or the equivalent.

In Mode 3, after a couple of seconds the **Latest** column fills in from the public registry (registry.npmjs.org, pypi.org, etc.). Outdated rows light up amber with a `outdated` badge. The stats row shows how many are behind.

Click **Re-scan** to refresh, or type in the **Filter** field to narrow the table.

### Minute 5 — Tail a log file

Press **⌘4** for Log-Tail. Drag any `.log` file onto the terminal area. Lines parse with auto-detected timestamps and level colours (red for errors, amber for warnings).

In Mode 3, type a path inside your workspace into the path field and click **Tail live**. The agent opens a server-side `chokidar` watcher and streams new lines via SSE — append to the file from your shell and lines appear in real time.

Type into the **Filter** field to live-filter. Click **Pause tail** to stop appending (lines keep buffering).

### Minute 6 — Fetch a doc

Press **⌘2** for Docs Scraper. Type a URL like `https://example.com` and click **Fetch Document**.

- If the host allows CORS, the browser fetches it directly.
- In Mode 3, if CORS blocks the fetch and the host is on your `SCRAPER_ALLOWED_HOSTS` list, the agent fetches it server-side, runs `turndown` to convert HTML to Markdown, and returns it.
- Otherwise you get a clear error toast explaining what to do (drop a `.md` file or add the host to the allowlist).

Drag a local `.md` or `.html` file onto the view to add it without any network call. Cached docs appear in the tree on the left.

### Minute 7 — Draft an issue

Press **⌘5** for Issue Template Filler. Type into the **Summary** field. As you type, the Markdown preview on the right updates live with title, severity, current workspace, current branch, date, and your filled sections.

Click **Copy** to put the markdown on your clipboard (or get a `.md` download if clipboard isn't available). Click **File issue** to save the markdown to your drafts list AND download it as a timestamped file.

### Minute 8 — Watch the Brain (Mode 3 only)

In your shell, `cd` to the workspace folder and run:

```sh
git checkout -b experiment
```

In the dashboard, a toast pops: **"Brain snapshot · auto-branch-switch-…"**. The Context-Snap stat increments. The bell icon's notifications popover now shows a live activity feed.

Switch back: `git checkout main`. Another auto-snapshot.

### Minute 9 — Configure a watched log

Press **⌘,** to open Settings. Find **Watchers & Triggers → Watched log paths**. Type a path relative to your workspace, like `logs/app.log`.

Now `echo "FATAL boom" >> logs/app.log` in your shell. The dashboard pops a toast: **"Brain pinned error · FATAL boom"** and a draft is automatically added to Issue Filler with the 20 preceding lines as context.

### Minute 10 — Run a manual scan

Click the bell icon (notifications popover). Click **Run scheduled scan now**. The agent runs a full Context-Snap audit, parses any manifest in your workspace root, looks up "latest" versions from registries, and reports outdated dependencies via a toast.

You've now exercised every feature.

---

## The five tools

Each tool has at least three activation paths: sidebar nav (or ⌘1–5), primary button in the view, command palette (⌘K), and drag-drop where applicable.

### 1. Context-Snap — `⌘1`

**What it does:** captures a reproducible snapshot of your local environment — env vars, processes, git branch + SHA, listening ports, working-tree diff. Save them, restore them, export them as JSON.

| Action | How |
|---|---|
| Capture | **Capture context** button, or palette → `Capture snapshot now` |
| Restore | **Restore snapshot** button → modal lists every saved snapshot, click to load |
| Export | **Export** button → downloads `<name>.snap.json` |
| Import | Drag-drop a `.snap.json` (or any matching `.json`) onto the view |
| Drop unwanted captures | Settings → Storage & Retention → Erase, or Context-Snap → Restore modal → Clear all |

**Mode 1/2 behaviour:** captures are synthetic — they reflect your form choices and current workspace label, with placeholder env/pid/port content.

**Mode 3 behaviour:** the agent fetches your real `process.env` (with secrets redacted), real `tasklist`/`ps` output, real `git branch --show-current` + `git rev-parse HEAD`, real `netstat` listening ports. The right pane re-renders with actual numbers.

**Data lives in:** `localStorage["devops:snapshots"]`, capped at 50 entries (newest first). The stat counter shows the current count, starting at 0.

### 2. Quick-Docs Scraper — `⌘2`

**What it does:** fetches a URL or loads a local `.md`/`.txt`/`.html` file and renders it as Markdown.

| Action | How |
|---|---|
| Fetch a URL | Type the URL → **Fetch Document** |
| Load local doc | Drag-drop a `.md`, `.txt`, or `.html` file anywhere on the view |
| Browse cache | **Browse cache** button shows count |
| Read cached doc | Click any item in the left tree |

**Mode 1/2:** uses the browser's `fetch(url, { mode: 'cors' })`. If the remote server blocks CORS (most public docs sites do), you get a clear error toast suggesting drag-drop.

**Mode 3:** on CORS failure, the dashboard automatically falls back to `POST /api/scraper/fetch` against the agent. The agent has no CORS layer (Node `fetch` is unrestricted), runs SSRF protection (refuses private/internal IPs even on redirects), checks the host against `SCRAPER_ALLOWED_HOSTS`, then returns the response. If the response is HTML, it runs through `turndown` to produce clean Markdown.

**Data lives in:** `localStorage["devops:doc-cache"]`, capped at 30 docs. Each entry: `{ id, title, body, host, when }`.

### 3. Dependency Map — `⌘3`

**What it does:** drop a manifest, get a real parse with names + versions + status badges. In Mode 3, also gets live "latest version" from public registries.

| Action | How |
|---|---|
| Pick file | Click the dropzone → native file picker |
| Drag-drop | Drop on the dropzone or anywhere in the view |
| Re-scan | **Re-scan** button — re-parses the currently loaded manifest |
| Filter | Type into the Filter field (live, case-insensitive substring) |

**Supported manifests** (auto-detected by filename + content sniff):

| Format | Files | What's parsed |
|---|---|---|
| npm | `package.json` | `dependencies` + `devDependencies` + `peerDependencies` (status: `runtime` / `dev`) |
| pip | `requirements.txt`, `Pipfile` | `name [op] version` per line, comments skipped |
| Cargo | `Cargo.toml` | `[dependencies]` table, both inline and table-form |
| Go modules | `go.mod` | `require` blocks and single-line require statements |
| Ruby Bundler | `Gemfile.lock` | `specs:` section, `name (ver)` lines |

**Mode 3 extras:** the dashboard calls `POST /api/dep-map/lookup` with the parsed package names. The agent hits the right registry (`registry.npmjs.org`, `pypi.org`, `crates.io`, `proxy.golang.org`, `rubygems.org`) with a 15-minute in-memory cache and 6-way concurrency. Outdated packages flip to an amber `outdated` badge.

**Data lives in:** `localStorage["devops:active-manifest"]` (last loaded manifest, so a refresh restores the table).

### 4. Log-Tail Filter — `⌘4`

**What it does:** load a log file and filter it line-by-line. Errors auto-highlighted red, warnings amber, success green. In Mode 3, also tails a file live via SSE.

| Action | How |
|---|---|
| Load file (one-shot) | **Load…** button next to the path field, or drag-drop a `.log`/`.txt`/`.out`/`.err` |
| **Tail live** (Mode 3 only) | Type a workspace-relative path → **Tail live** button. Status pill shows "live · &lt;file&gt;" |
| Browse workspace logs (Mode 3) | Folder icon next to Tail live — popover lists `.log` files under your workspace, click any to start tailing |
| Filter | Type into the Filter field (live regex-ish substring) |
| Pause / Resume | **Pause tail** toggles — buffer keeps growing, rendering pauses |
| Wrap lines | Wrap icon in the terminal card header |
| Clear view | Clear icon → confirms, then hides all buffered lines |

**Level detection patterns** (case-insensitive):
- `error|err|fatal|critical|exception` → red row
- `warn|warning` → amber
- `ok|success|done|started|listening` → green
- everything else → blue

**Mode 3 streaming details:** the agent uses `chokidar` polling (250 ms) on the file. Reads only new bytes since the last offset. Handles file truncation and rotation (emits `truncated` and `rotated` events). SSE auto-reconnects on network blips. Display cap is 2000 lines (older lines stay in memory for the filter).

### 5. Issue Template Filler — `⌘5`

**What it does:** fill a form on the left, get live-rendered Markdown on the right. Copy or download.

| Action | How |
|---|---|
| Live preview | Type into any input/textarea/select — preview re-renders on every keystroke |
| Copy Markdown | **Copy** → clipboard (or downloads as `.md` if clipboard isn't available) |
| File issue | **File issue** → downloads `<ts>-<slug>.md` and saves to drafts |
| Switch template | **Switch template** cycles through Bug / Feature / RFC / Performance |
| Step navigation | Continue / Back, or click any wizard step directly |

**The generated markdown includes:**
- Title from Summary
- Severity, template kind (from selects)
- Current workspace name + branch (auto-filled)
- Date
- Context, Observed, Steps to reproduce, Expected, Notes — only sections you filled appear

**Data lives in:** `localStorage["devops:issue-drafts"]`, capped at 30.

---

## The Autonomous Brain (Mode 3 only)

Once the agent is running, it boots a background "Brain" that watches for triggers and acts proactively. Four sentinels:

### GitSentinel — reactive trigger

Watches `<WORKSPACE_ROOT>/.git/HEAD` (uses polling for cross-platform reliability). On branch switch:

1. Reads the new branch name.
2. Calls `ctx.captureAll()` with env + git includes.
3. Names the snapshot `auto-branch-switch-<iso-timestamp>`.
4. Pushes onto the agent's `recentSnapshots` list **and** emits an SSE `snapshot` event.
5. The dashboard receives the event, merges the snapshot into `localStorage["devops:snapshots"]`, and toasts.

**Disable via:** Settings → Watchers & Triggers → "Auto-snapshot on branch switch" toggle (off). The Brain still tracks the current branch but won't capture.

### LogWatchdog — proactive error pinning

For each path in **Settings → Watched log paths**, opens a live log stream. Keeps a rolling 20-line buffer. When a line matches one of your **error patterns** (default: `CRITICAL`, `FATAL`, `\bpanic\b`, `unhandledRejection`, `segfault`):

1. Builds a Markdown draft with the previous 20 lines as `## Context` and the matching line as `## Observed`.
2. Pushes onto the agent's drafts list and emits an SSE `draft` event.
3. Dashboard receives it, merges into `localStorage["devops:issue-drafts"]`, toasts you.

Per-pattern, per-file cooldown of 60 seconds so a burst of identical errors doesn't spam drafts.

### Scheduler — Cron-lite

Every minute, checks if the current `HH:MM` matches **Settings → Scheduled scan** (default `03:00`). If yes and we haven't already run for that day-minute:

1. Runs `ctx.captureAll()` with all four collectors (env + processes + git + ports).
2. Finds a top-level manifest in your workspace (`package.json`, etc.).
3. Looks up "latest" versions via the existing registry endpoints.
4. Emits a `scan` SSE event and a `notification` event if any dependency is behind.

**Manual trigger:** click the bell icon in the dashboard and choose **"Run scheduled scan now"**. Or `curl -X POST http://localhost:3737/api/agent/scan`.

### ResourceThrottle — adaptive backoff

Samples this Node process's CPU every 5 seconds (`process.cpuUsage()` — no native deps). If `cpuPercent > cpuCeiling` for 3 consecutive samples, flips `brain.throttled = true` and emits a `throttle` event. The brand pill turns amber. LogWatchdog stops processing (still buffers), Scheduler skips its tick. Hysteresis at 80% of the ceiling cleanly releases the throttle.

**Configure ceiling:** Settings → Resource Limits → CPU ceiling slider. A literal `0` is honored (means "any CPU triggers throttle").

### How the dashboard surfaces all this

- **Brand pill** flips between BRAIN ACTIVE (emerald) and BRAIN THROTTLED (amber).
- **Notifications popover** (bell icon) shows live activity log with per-source colors and a "Run scheduled scan now" button.
- **Toasts** for snapshots, drafts, notifications, and throttle transitions.
- **Auto-merge into localStorage** so brain snapshots appear in Context-Snap's history and brain drafts appear in Issue Filler.

The full sentinel docs (state machine, persistence, security model) live in [`agent/README.md`](agent/README.md).

---

## Workspaces, profile, settings

### Workspaces

First-class concept. Everything (header pill, snapshot scope, login recents) derives from your saved workspaces.

| Action | How |
|---|---|
| Add | Header pill → **Add workspace…** |
| Switch | Header pill → click any workspace |
| Manage / remove | Header pill → **Manage workspaces…** → Remove per row |
| Pick from recents | Login screen lists up to 4 most-recent |

Stored at `localStorage["devops:workspaces"]`. Active workspace ID lives in `localStorage["devops:session"]`.

### Profile

Click the sidebar identity row.

- **Display name** → derives the sidebar handle (`first.last`)
- **Email** → shows as the host line below the handle
- **Role** and **Shell** → free-form selects, persisted
- **2FA toggle** → decorative (no real auth); persisted
- **Avatar** → "Upload photo" reads any image, stores as a data URL, renders in sidebar and modal. "Remove" clears it.

Stored at `localStorage["devops:profile"]`.

### Settings

Press `⌘,` (or sidebar → Settings). Every switch, slider, select, and text input writes to `localStorage["devops:settings"]` on change and restores on reload.

**Sections:**

- **Autonomous Agent** — boot launch, battery policy, idle-only execution, notification level. Selected toggles also push to the Brain via `POST /api/agent/settings` (Mode 3).
- **Watchers & Triggers** — Auto-snapshot on branch switch, manifest-change scans, error pinning, watched paths, scheduled scan time. These directly drive Brain sentinels.
- **Resource Limits** — CPU %, memory ceiling, concurrency, low-power mode. CPU ceiling drives the Brain's ResourceThrottle.
- **Storage & Retention** — data dir, disk budget, snapshot/doc retention, auto-prune, **Erase…** nukes ALL `devops:*` keys after a confirm + reloads.
- **Network Isolation** — air-gap mode, allowlist, telemetry shown as blocked by design.
- **Local Security** — auto-lock, encryption, secret-mask patterns, passphrase confirm, key rotation.
- **Local Toolchain** — git/node/python/cargo path overrides.
- **Appearance** — theme (Light/Dark/System), density (Compact/Cozy/Spacious), accent color (live), monospace font.
- **Keyboard** — leader key, shortcuts on/off.
- **About** — version, real diagnostics. The "Copy diagnostics" button generates a full runtime + session + storage report.

---

## Keyboard shortcuts

| Keys | What it does |
|---|---|
| `⌘1`–`⌘5` | Jump to the corresponding tool view |
| `⌘,` | Open Settings |
| `⌘K` | Open the command palette (18 commands) |
| `⌘⇧L` | Sign out / lock workspace |
| `?` (outside an input) | Open Help & Shortcuts |
| `Esc` | Close the modal / palette / popover in focus |
| Arrow keys + Enter (in palette) | Navigate / run a command |

The command palette is the fastest way to do anything — search by name (`Capture`, `Fetch`, `Re-scan`, `Pause`, `File issue`, `Settings → Network Isolation`, etc.).

---

## Where your data lives

**Frontend (browser):**

| `localStorage` key | Owner module | Contents |
|---|---|---|
| `devops:initialized` | `persist.js` | First-run sentinel (boolean) |
| `devops:profile` | `persist.js` | Display name, email, role, shell, 2FA, avatar data URL |
| `devops:session` | `persist.js` | Active workspace ID, signedIn flag, keepSignedIn flag |
| `devops:workspaces` | `persist.js` | Array of `{ id, name, path, initials, colorStart, colorEnd, addedAt }` |
| `devops:settings` | `persist.js` | Map of `k:<group-id>::<row-label>` → value |
| `devops:accent` | `persist.js` | Active accent color hex |
| `devops:mono` | `persist.js` | Active monospace font name |
| `devops:snapshots` | `features.js` | Context-Snap snapshots (newest first, capped at 50) |
| `devops:doc-cache` | `features.js` | Docs Scraper cached documents (capped at 30) |
| `devops:active-manifest` | `features.js` | Last-loaded Dep Map manifest |
| `devops:issue-drafts` | `features.js` | Issue Filler markdown drafts (capped at 30) |

Inspect or clear from your browser's DevTools → Application → Local Storage. Or use `DevOps.store.nuke()` from the console, which fires the same code path as Settings → Erase.

**Backend (Mode 3):**

| File | Contents |
|---|---|
| `agent/.brain-state.json` | Brain settings + snapshot seq + draft seq + last 50 snapshots + last 30 drafts. Survives agent restarts. Gitignored. |
| `agent/.env` | Local config: `WORKSPACE_ROOT`, `PORT`, `SCRAPER_ALLOWED_HOSTS`, `REGISTRY_LOOKUP_ENABLED`, etc. Gitignored. |
| (in-memory only) | Activity log (last 500 events), recent scheduled-scan results (last 20), dep-registry cache (15-min TTL). All lost on agent restart. |

Use `DevOps.store.get(key, fallback)` / `DevOps.store.set(key, val)` from any frontend code. Never poke `localStorage` directly.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Brand pill stays "OFFLINE LOCAL MODE" even with agent running | Wrong URL — you opened `file://…/index.html` instead of `http://localhost:3737/` | Open the agent's URL: <http://localhost:3737/> |
| Brand pill says "OFFLINE LOCAL MODE" and agent terminal shows no requests | Different port? Check the agent banner. Or browser is on `http://localhost:8765/` (Python server) while agent is on 3737 | Open the agent's port |
| Issue Filler "Copy" button downloads instead of copying | You're on `file://` — browsers block clipboard write on insecure origins | Use Mode 2 or 3 |
| Docs Scraper says "Fetch failed: CORS blocked" | Mode 1 or 2 can't bypass CORS. Mode 3 can if the host is allowlisted | Mode 3 + add host to `SCRAPER_ALLOWED_HOSTS` in `agent/.env` |
| Docs Scraper (Mode 3) says "Host not in allowlist" | Default allowlist is empty (deny-all) | Edit `agent/.env`, add `SCRAPER_ALLOWED_HOSTS=docs.example.com,*.mdn.com`, restart `npm start` |
| Dep Map "Latest" column stays "—" | No internet, or `REGISTRY_LOOKUP_ENABLED=false`, or the agent is offline | Mode 3 + internet, or accept that offline shows no latest |
| `npm install` in `agent/` fails | Wrong Node version | Verify `node --version` is 18+ |
| Agent crashes immediately on `npm start` | `WORKSPACE_ROOT` in `.env` doesn't exist or isn't a directory | Edit `.env` and point at an existing folder |
| Brain toasts on every commit, you don't want them | Disable Auto-snapshot on branch switch in Settings | Or wholesale disable the Brain: Settings → Autonomous Agent → off |
| LogWatchdog drafts not appearing | Watched path doesn't exist or escapes the workspace | Use a relative path inside `WORKSPACE_ROOT`. Check `curl http://localhost:3737/api/agent/status` — the log-watchdog `info.watching` field tells you what's actually being watched |
| ResourceThrottle stays on (amber pill) | Your CPU ceiling is too low or another process is hammering CPU | Settings → Resource Limits → raise CPU ceiling. Or close the noisy process |
| Settings reverts after reload | Cleared browser data, or in private/incognito mode | Use a regular window. localStorage is per-origin so keep using the same URL |
| Workspace switcher shows "No workspaces yet" after I added some | Different browser, or different URL (`file://` vs `localhost`) | localStorage is per-origin. Always use the same URL |

For more agent-side debugging: `curl http://localhost:3737/api/agent/events?limit=200` returns the last 200 brain-log entries with timestamps + sources.

---

## Factory reset

**Frontend only** (keeps the agent's state):

```js
// In your browser's DevTools console:
DevOps.store.nuke()
location.reload()
```

Or via the UI: Settings → Storage & Retention → **Erase…** → confirm. Same code path, plus a confirm dialog.

**Backend only** (keeps your dashboard data):

```sh
# Stop the agent first (Ctrl+C), then from the repo root:
rm agent/.brain-state.json
# Then restart: cd agent && npm start
```

**Everything:**

```sh
# Stop the agent first.
rm agent/.brain-state.json
# In the browser console:
DevOps.store.nuke(); location.reload()
```

---

## Folder layout

```
DevOps/
├── README.md                      This file. The user-facing guide.
├── index.html                     Page structure only — no inline styles or scripts.
├── css/
│   └── styles.css                 All visual styles, light theme, density modes.
├── js/                            Frontend modules — load order matters:
│   ├── core.js                    DevOps namespace · state · store API · toast · confirm
│   │                              · bindByText · version. ALWAYS LOADS FIRST.
│   ├── agent-client.js            Detects whether the agent is reachable. Exposes
│   │                              D.agent.captureSnapshot/getEnv/etc/openLogStream/
│   │                              scrapeUrl/lookupDeps. Auto-detects on load.
│   ├── ui.js                      Shell: views, settings rail, accent/theme/density,
│   │                              sliders, help search, profile modal, login screen,
│   │                              popovers, command palette, global keyboard shortcuts.
│   ├── persist.js                 First-run cleanup · empty-state rendering · workspace
│   │                              CRUD · profile + avatar persistence · all-Settings
│   │                              persistence · About diagnostics · real Erase.
│   ├── features.js                Real engines for the 5 tools (capture / fetch / parse /
│   │                              tail / generate). All file handling lives here.
│   ├── tools.js                   Remaining UI feedback (Settings/Help fallbacks) plus
│   │                              catch-all toast for any button without a real handler.
│   └── brain-client.js            Phase 4 integration. Detects the Brain, syncs
│                                  snapshots/drafts on load, opens SSE stream, dispatches
│                                  live events to UI. Brand pill / notifications popover /
│                                  settings → agent push.
├── agent/                         The Node backend (Mode 3 only).
│   ├── server.js                  Express app, request logging, error wrapper.
│   ├── package.json               Deps: express, cors, dotenv, chokidar, turndown.
│   ├── .env.example               Template. Copy to .env and edit WORKSPACE_ROOT.
│   ├── .env                       Your local config (gitignored).
│   ├── .brain-state.json          Brain state file (gitignored, auto-generated).
│   ├── .gitignore                 Excludes the above.
│   ├── README.md                  Agent-side technical doc: security model, every
│   │                              endpoint, the four-sentinel Brain in depth.
│   ├── lib/
│   │   ├── safety.js              Workspace boundary helpers (withinWorkspace, etc.).
│   │   ├── context-snap.js        Env / processes / git / ports collectors (cross-platform).
│   │   ├── log-tail.js            LogStream class (chokidar) + readLastBytes + findLogFiles.
│   │   ├── dep-registry.js        npm/PyPI/crates.io/go/gem latest-version lookups
│   │                              with TTL cache + worker pool.
│   │   ├── dep-parsers.js         Server-side manifest parsing (mirrors features.js).
│   │   ├── scraper.js             URL proxy with SSRF guard + allowlist + turndown.
│   │   └── brain.js               Brain + 4 sentinel classes (GitSentinel, LogWatchdog,
│   │                              Scheduler, ResourceThrottle).
│   └── fixtures/                  Smoke tests (run with `node fixtures/<name>.mjs`).
│       ├── sse-smoke.mjs              Log-tail SSE streaming
│       ├── sse-rotate.mjs             Log rotation handling
│       ├── brain-git-smoke.mjs        GitSentinel
│       ├── brain-logwatch-smoke.mjs   LogWatchdog
│       ├── brain-scheduler-smoke.mjs  Scheduler
│       ├── brain-throttle-smoke.mjs   ResourceThrottle
│       └── brain-client-smoke.mjs     End-to-end brain-client.js + Brain
└── docs/
    ├── original-handoff-README.md  The README that shipped with the design handoff.
    └── design-chat.md              Full chat transcript with the design assistant.
```

**Frontend script load order is fixed** in `index.html`:

```
core.js → agent-client.js → ui.js → persist.js → features.js → tools.js → brain-client.js
```

Earlier scripts expose APIs on `window.DevOps`; later scripts consume them. Don't reorder without reading what each one does.

---

## Customising

| To do this | Edit this |
|---|---|
| Rebrand the app | `D.brandName` and `D.version` in `js/core.js`; `<title>` and brand text in `index.html` |
| Add a command palette entry | Push to the `commands` array in `js/ui.js`. Each entry: `{ id, title, cat, keys?, icon, run }` |
| Add a new view | `<button class="nav-item" data-view="myview">` in sidebar + `<div class="view" id="view-myview">` in main + entry in `D.labels` (`js/core.js`). Empty state via `persist.js`'s `emptyHTML(opts)` |
| Add a new feature engine | Extend `js/features.js` with a new IIFE. Use `claim(scope, text, handler)` to override an existing button (sets `data-wired`, so the catch-all toast skips it) |
| Add a new persisted setting | Drop the input/switch/select inside any `<div class="settings-group" id="s-...">`. Persistence is automatic via `persist.js`'s control walker — no per-control glue |
| Sync a new setting to the Brain | Add a row to the `SETTINGS_MAP` array in `js/brain-client.js`: `{ selector, rowTitle, brainKey, type }` |
| Add a new Brain sentinel | Add a class to `agent/lib/brain.js` with `{ name, state, info, start(), stop() }`. Register in `agent/server.js` via `brain.addSentinel(new MySentinel(brain, opts))` |
| Add a new API endpoint | Add to `agent/server.js`. Use `wrap(async (req, res) => {...})` for error handling. Use `withinWorkspace(...)` for any path parameter |
| Add a new manifest format to Dep Map | Extend `agent/lib/dep-parsers.js` (server-side) and `js/features.js` Dep Map section (frontend) |
| Customize redaction patterns | Set `EXTRA_REDACT_PATTERNS=PATTERN1,PATTERN2` in `agent/.env` |

---

## Security model in one paragraph

**Frontend:** runs entirely in your browser. Reads/writes `localStorage` (per-origin). No network calls except to the agent (when present) and direct browser fetches you initiate from the Docs Scraper.

**Agent (Mode 3):** every file/git operation routes through `withinWorkspace()` — paths that escape `WORKSPACE_ROOT` are refused with HTTP 403. Env vars matching `SECRET|TOKEN|KEY|PASSWORD|PASSPHRASE|AUTH|CREDENTIAL|COOKIE|SESSION|BEARER|API_KEY|PRIVATE` are redacted before they leave the process. The scraper has a default-deny hostname allowlist and SSRF protection (refuses DNS resolutions to private/internal IPs, even on redirects). Destructive operations are disabled by default (`ALLOW_DESTRUCTIVE=false`) and require both that flag AND a `X-Confirm-Destructive: yes` request header. Only five hardcoded hostnames are ever contacted for registry lookups. See [`agent/README.md`](agent/README.md) for the full model.

---

## Origin & further reading

This dashboard was generated by Claude Design from a single multi-turn chat (`docs/design-chat.md`), then hardened in five passes:

1. **Bug fix** — patched a hoisting bug that silently killed every handler below `profileSaveBtn`.
2. **Modularisation** — split the monolithic HTML into shell (`ui.js`), engines (`features.js`), and fallback (`tools.js`) layers; extracted styles to `css/styles.css`.
3. **Persistence & empty states** — added `persist.js`, made every Settings control real, made workspaces / profile / appearance survive reloads, replaced design-mock content with empty-state cards.
4. **Local agent (Phases 1–3)** — built `agent/` as a Node backend: Context-Snap collectors, log-tail SSE streaming, dependency registry lookups, scraper proxy with Turndown.
5. **Autonomous Brain (Phase 4)** — added four background sentinels (GitSentinel, LogWatchdog, Scheduler, ResourceThrottle) and the frontend integration (`brain-client.js`) so the UI reflects everything the Brain does.

For technical depth on the agent (every endpoint, security model, smoke tests, settings model, sentinel lifecycles), see [`agent/README.md`](agent/README.md). The original handoff README is preserved at `docs/original-handoff-README.md`.
