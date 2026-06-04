# DevOps Local — V1.00.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. TDD throughout. Steps use `- [ ]` checkboxes. Branch: `v1.00.1`. Ship each task as its own commit and push.

**Goal:** Ship V1.00.1 — a point release that hardens quality, stands up the first frontend tests, makes the advertised-but-broken headline features real, and leans into the tamper-evident-audit / air-gapped compliance moat. No ground-up rewrite, no 6th tool.

**Architecture:** Static frontend (vanilla JS IIFEs, no build step) + Node/Express `agent/`. New shared pure logic ships as **dual-mode modules** (`module.exports` when `typeof module!=='undefined'`, else attach to `window.DevOps`) so the same file runs as a browser `<script>` AND is `require()`-able by `node --test`. This is how we get frontend tests with no bundler.

**Source of scope:** 6-agent research workflow (`wmgfemnbb`, 2026-06-03). Synthesis recommended 14 items (below) and deferred 6 to the next release.

---

## Sequencing (deliberate — implement in this order)

**Foundation →** 1 agent-startup-hardening · 2 frontend-smoke-tests · 3 agent-robustness-hardening
**Headline fix →** 4 log-tail-filter-real · 5 log-tail-export-clear
**Commercial spine →** 6 audit-ui · 7 reposition-compliance-docs · 8 airgap-mode-preset
**Daily-use features →** 9 export-import-bundle · 10 saved-list-search · 11 compare-view-rich · 12 palette-real-actions · 13 empty-state-ctas
**Polish →** 14 a11y-core-pass
**Release →** 15 version bump to 1.00.1 · 16 verify + merge + tag + push

---

### Task 1 — agent-startup-hardening (high / M)

**Why:** `server.js` `app.listen(PORT, HOST)` has no `error` handler → silent crash when 3737 is taken (common on 2nd launch). Lib modules hardcode state paths via `__dirname` (`keystore.js` `.ai-keys.json`/`.salt`, `audit.js` `.audit.log`, `brain.js` `.brain-state.json`, `github.js` `.github-queue.json`) → throws under a read-only install and blocks the deferred Electron build.

**Files:** `agent/lib/state-dir.js` (create), `agent/server.js`, `agent/test/state-dir.test.js` (create).

**Approach:**
- New `lib/state-dir.js`: `resolveStateDir()` returns `process.env.AGENT_STATE_DIR` (resolved, mkdir -p) or `__dirname`'s parent (the agent dir) as today. Export `stateDir(filename)` joining them.
- `server.js`: build `AGENT_STATE_DIR` once via the helper; pass it to `Audit`, `Keystore`, `GitHub`, and Brain state. (Constructors already take `{ dir }`/paths — thread the resolved dir through.)
- `server.js`: add `server.on('error', e => { if (e.code==='EADDRINUSE'){ console.error(...); retry on port 0 } else throw })` — on EADDRINUSE, `app.listen(0, HOST)` and log the chosen port.

**Tests:** `state-dir.test.js` — (a) honours `AGENT_STATE_DIR`; (b) defaults to agent dir; (c) `stateDir('x')` never resolves inside a path containing `lib` (asserts state isn't written next to source when `AGENT_STATE_DIR` set to a temp dir).

**Acceptance:** `npm test` green; manual `PORT=<busy>` boot falls back to an ephemeral port instead of crashing.

**Commit:** `fix(agent): EADDRINUSE fallback + centralize state paths via AGENT_STATE_DIR`

---

### Task 2 — frontend-smoke-tests (high / M)

**Why:** ~5k LOC frontend + 2600-line index.html have zero tests. A release adding frontend behavior needs a net.

**Files:** root `package.json` (create), `js/log-engine.js` (create — dual-mode), `tests/log-engine.test.js` (create), `tests/dep-parsers.test.js` (create), `tests/README.md` (create).

**Approach:**
- Root `package.json`: `{ "scripts": { "test": "node --test tests/*.test.js && cd agent && node --test test/*.test.js" } }` (run both suites). No deps — pure `node --test`.
- Create `js/log-engine.js` (dual-mode) housing the **pure** log logic extracted from `features.js`: `parseLine(line)` (ts + level classification) and the NEW `lineMatches(line, {text, level, useRegex})` filter predicate (Task 4 consumes it). Wire `features.js` to use `D.logEngine.parseLine` / `D.logEngine.lineMatches` instead of its inline copies (delete the dupes at features.js:960-972 & :1003-1013).
- `tests/log-engine.test.js`: level classification (error/warn/ok/info), timestamp extraction, and filter predicate (substring, case-insensitive, regex, level filter, combined).
- `tests/dep-parsers.test.js`: round-trip parse of a sample `package.json` / `requirements.txt` / `Cargo.toml` / `go.mod` against `agent/lib/dep-parsers.js` (already importable).

**Acceptance:** `npm test` at repo root runs frontend + agent suites, all green.

**Commit:** `test: stand up root test harness + dual-mode log-engine with first frontend tests`

---

### Task 3 — agent-robustness-hardening (medium / M)

**Why:** Cluster of verified backend gaps.

**Files:** `agent/lib/brain.js`, `agent/server.js`, `agent/lib/log-tail.js`, `agent/test/robustness.test.js` (create).

**Approach (surgical guards):**
- `brain.js` LogWatchdog `enrichQueue.push` → cap at 50, drop-oldest + one warning log.
- `server.js` `/api/log-tail/stream` → idle TTL: `setTimeout` (e.g. 30 min) that force-closes the SSE + cleans up; reset on activity is unnecessary (hard cap is fine).
- `server.js` `/api/agent/snapshot-diff` → validate `snapA`/`snapB` are objects with a `capture` key; 400 otherwise.
- `server.js` settings POST path / `brain.updateSettings` → coerce `cpuCeiling` to a finite number, drop empty `watchedLogPaths` entries.
- statusCode propagation: ensure re-thrown errors keep `statusCode` (audit log-tail.js ENOENT path).

**Tests:** `robustness.test.js` — enrichQueue cap drops oldest at 51; snapshot-diff validator rejects `{}`; settings coercion turns `"abc"` cpuCeiling into the default and filters `""` paths.

**Acceptance:** `npm test` green.

**Commit:** `fix(agent): robustness bundle — queue cap, SSE TTL, diff validation, settings coercion`

---

### Task 4 — log-tail-filter-real (high / M)  ⚠ coordinate with Task 13 + tools.js

**Why (headline bug):** `tools.js:96-98` toggles `display` on `.term-line` nodes, but `features.js renderLines()` rewrites `terminal.innerHTML` on every appended line — so the filter is wiped instantly on any live/loaded log, and the level `<select>` (index.html:776) is never wired.

**Files:** `js/features.js` (logTail engine), `js/tools.js` (neutralize old handlers), `js/log-engine.js` (predicate from Task 2), `tests/log-engine.test.js` (predicate tests already added).

**Approach:**
- Add `filterText`, `filterLevel`, `filterRegex` state to the logTail engine. `renderLines(buffer)` filters via `D.logEngine.lineMatches` before rendering; keep the full `buffer[]` intact (filter is view-only).
- Wire the filter `<input>` (live) and the level `<select>` to update state + re-render.
- Neutralize `tools.js` Log-Tail filter/level handlers (the engine now owns them) to avoid double-binding — mark the controls `data-wired`.

**Tests:** covered by `log-engine.test.js` predicate tests (the render path is thin).

**Acceptance:** filter + level select actually narrow a live/loaded log; clearing restores; `npm test` green.

**Commit:** `fix(log-tail): real engine-level filtering + working level selector`

---

### Task 5 — log-tail-export-clear (medium / S)

**Why:** "Export filtered" is a fake toast (`tools.js:90`); Clear hides static mock nodes.

**Files:** `js/features.js`, `js/tools.js`.

**Approach:** Export → `downloadFile('log-filtered-<ts>.txt', 'text/plain', <post-filter visible lines>.join('\n'))`. Clear → `resetBuffer([])` (exists) + confirm. Remove the conflicting tools.js handlers.

**Acceptance:** Export downloads the actually-filtered lines; Clear empties the real buffer.

**Commit:** `fix(log-tail): wire Export-filtered and Clear to the real engine buffer`

---

### Task 6 — audit-ui (high / M)  — the commercial differentiator, made demoable

**Why:** The hash-chained AI audit log is reachable only via 3 hidden data-attr buttons; CSV export isn't surfaced. This is the headline compliance feature.

**Files:** `index.html` (new Audit card in a sensible home — Settings → a new "Audit Log" group, or the notifications area), `js/brain-client.js` (or a new `js/audit-ui.js` loaded after brain-client), `css/styles.css` (table styles if needed).

**Approach:** A filterable record table (time / kind / feature / outcome / cost) from `GET /api/agent/audit`; a prominent **Verify chain** badge from `GET /api/agent/audit/verify` (green "chain intact @ N records" / red "broken at id X"); **Export JSONL** and **Export CSV** buttons hitting `/api/agent/audit/export?format=`. Must gate cleanly offline (Modes 1-2): show a "start the agent to view the audit log" empty state.

**Acceptance:** With the agent running, the audit view lists records, verify badge shows status, both exports download. Offline → clean empty state, no errors.

**Commit:** `feat(audit): first-class filterable Audit Log view with verify badge + JSONL/CSV export`

---

### Task 7 — reposition-compliance-docs (high / S)

**Why:** README leads with "Five tools" (commoditized); the real moat (autonomous Brain → tamper-evident local ledger, no cloud) is buried.

**Files:** `README.md`, `agent/README.md`.

**Approach:** Rewrite the README opening to lead with the local tamper-evident AI ledger + air-gapped operation; add a short "Compliance evidence" subsection framing it as *"produces audit evidence to support EU AI Act Article 12 record-keeping / ISO 42001"* — **never** "certified/compliant." Note Article 12 enforcement begins 2026-08-02. Keep the tools as supporting capability, not the lead.

**Acceptance:** README leads with the differentiator; language is evidence-framed, not certification claims.

**Commit:** `docs: lead with the tamper-evident AI ledger + compliance-evidence framing`

---

### Task 8 — airgap-mode-preset (high / S)

**Why:** Air-gapped AI is the exact target buyer; every capability exists but is scattered.

**Files:** `agent/server.js` (or `agent/lib/airgap.js`), `agent/.env.example`, `agent/README.md`, `agent/test/airgap.test.js` (create).

**Approach:** `AIRGAP=true` preset that forces: `REGISTRY_LOOKUP_ENABLED=false`, scraper deny-all (`SCRAPER_ALLOW_ANY=false`, empty allowlist), `LLM_ENDPOINT_ALLOWLIST` limited to localhost. Add a `GET /api/airgap/selftest` that asserts the effective config makes zero non-localhost egress possible and returns `{ airgap:true, egressBlocked:true, checks:[...] }`. Surface a banner line in the startup banner when AIRGAP is on.

**Tests:** `airgap.test.js` — with `AIRGAP=true`, registry endpoint returns 503, scraper refuses a public host, selftest reports `egressBlocked:true`.

**Acceptance:** `npm test` green; the mode is a single switch with a defensible self-test.

**Commit:** `feat(agent): first-class Air-Gapped Mode preset + zero-egress self-test`

---

### Task 9 — export-import-bundle (high / M)

**Why:** No whole-dashboard backup/migrate today (snapshots export one-at-a-time, newest only). Air-gapped/regulated teams need a one-file bundle.

**Files:** `js/persist.js` (Settings → Storage), `index.html` (two buttons in Storage group), `js/bundle.js` (create — dual-mode pure shape-validate + serialize), `tests/bundle.test.js` (create).

**Approach:** Export → gather all `devops:*` keys into `{ format:'dvops-bundle', version:1, exportedAt, data:{...} }`, `downloadFile('devops-backup-<ts>.dvops.json', ...)`. Import → drop/pick a `.dvops.json`, **validate shape via `D.bundle.validate()`**, show a confirm dialog ("overwrite N keys?"), then write. Also fix Context-Snap Export-all (ship the whole snapshots list, not `list[0]`).

**Tests:** `bundle.test.js` — `validate()` accepts a good bundle, rejects wrong format / missing data; round-trip serialize→parse preserves keys.

**Acceptance:** export → import on a fresh profile restores everything after confirm; bad file → clean rejection.

**Commit:** `feat(persist): universal .dvops.json export/import bundle (validated, confirm-before-overwrite)`

---

### Task 10 — saved-list-search (medium / S)

**Files:** `js/features.js` (restore-snapshot modal, drafts inbox), `js/persist.js`/`features.js` (docs tree filter input at index.html:437).

**Approach:** Add a live substring filter to the Restore-snapshot modal list, the Drafts Inbox, and wire the existing (dead) Docs "Filter…" input to filter the cache tree. All client-side over in-memory arrays.

**Acceptance:** typing filters each list live.

**Commit:** `feat(frontend): live search/filter for snapshots, drafts, and the docs cache`

---

### Task 11 — compare-view-rich (medium / S)

**Why:** `renderDiff` (features.js:464) prints only comma-joined key names, discarding the before→after env values `diffSnapshots` already computes.

**Files:** `js/features.js` (renderDiff).

**Approach:** Render changed env as `key: old → new` rows; group sections; add **Copy as Markdown** that feeds the Issue Filler. Structured-only (no LLM) so it helps Mode-3 users without a provider.

**Acceptance:** Compare shows real value deltas; Copy-as-Markdown populates a draft.

**Commit:** `feat(context-snap): richer Compare view with env value deltas + Copy as Markdown`

---

### Task 12 — palette-real-actions (medium / S)

**Why:** Palette entries are stubs that only toast (`ui.js:420` "Capture snapshot now" never calls capture; "Pause log tail"/"Pause agent" no-op). Also: `D.state.shortcutsEnabled` is never enforced (ui.js:514).

**Files:** `js/ui.js`.

**Approach:** Point `command.run` at the real `D.features.*` / `D.brain.*` functions; add commands (Re-scan deps, Export/Compare snapshot, File issue, Run scheduled scan, Export/Verify audit). Enforce `D.state.shortcutsEnabled` in the global keydown handler.

**Acceptance:** palette actions actually act; disabling shortcuts in Settings disables them.

**Commit:** `fix(ui): wire command-palette to real engines + honor shortcuts toggle`

---

### Task 13 — empty-state-ctas (medium / M)  ⚠ coordinate with Task 4 (shared mock DOM)

**Why:** New users hit placeholder data (mock Log-Tail terminal index.html:808-822) instead of a next step.

**Files:** `index.html` (remove mock terminal lines), `js/persist.js` (empty-state strippers already exist — `applyEmptyStates`), `js/features.js`.

**Approach:** One primary CTA per empty state wired to the real engine ("Capture first snapshot" → `contextSnap.capture()`, "Choose a manifest…", "Load a .log file…", "Fetch a doc…"). Replace the fake Log-Tail terminal so a fresh tool looks empty (matches README "ships empty"). Also fix the unescaped draft URL (features.js:1328) and the 5s `setInterval` (drafts inbox) → event-driven only, while here.

**Acceptance:** fresh dashboard shows actionable empty states, no mock data.

**Commit:** `feat(frontend): real empty-state CTAs + remove mock Log-Tail terminal`

---

### Task 14 — a11y-core-pass (medium / M)

**Files:** `css/styles.css`, `index.html`, `js/persist.js` (runtime modals), `js/core.js` (`confirmAction` modal).

**Approach (high-impact subset):** global `:focus-visible` ring; modal focus-trap + Escape for runtime-created modals (`confirmAction`, snapshot/compare/workspace modals); convert `.field-label` `<p>` → real `<label for>` (WCAG 1.3.1 A); accessible names on icon buttons (`aria-label`); contrast fixes for meta/placeholder text to ≥4.5:1. Defer deep ARIA widget rework.

**Acceptance:** keyboard can reach + escape every modal; focus is visible; labels associated.

**Commit:** `fix(a11y): focus-visible, modal focus-trap+Escape, real labels, icon names, contrast`

---

### Task 15 — version bump to 1.00.1

**Files:** `js/core.js` (`D.version='1.00.1'`), `agent/package.json` (`"version":"1.00.1"`), `agent/server.js` (`VERSION='1.00.1'`), `README.md` banner, `js/persist.js:798` (fix version-pill regex to match `\d+\.\d+(\.\d+)*`).

**Commit:** `chore: bump version to 1.00.1`

---

### Task 16 — verify + release

- [ ] Root `npm test` (frontend + agent) all green; `cd agent && npm audit --omit=dev` → 0 vulns.
- [ ] Boot agent; manual smoke of audit-ui, log filter, airgap selftest, export/import.
- [ ] `git checkout main && git merge v1.00.1 && npm test` (verify on merged main).
- [ ] `git tag -a v1.00.1` ; `git push origin main --follow-tags`.
- [ ] Update changelog/README "Origin" with a V1.00.1 entry.

---

## Deferred to the NEXT release (with reasons)

- **electron-desktop-app** (L) — biggest distribution unlock; prerequisites (EADDRINUSE + AGENT_STATE_DIR) land now via Task 1.
- **signed-audit-ed25519** (M) — externally-verifiable signing; format-compat/key-mgmt risk; own cycle.
- **win-code-signing + electron-updater** (M) — downstream of Electron + Azure enrollment lead time (start enrollment out-of-band now).
- **lockfile-manifest-parsers** (M) — 4 fiddly formats × 2 codebases; regression risk. (If one is pulled forward, `package-lock.json` packages-map.)
- **manifest-change-watch + surface /api/system,/api/toolchain,/github/queue** (M) — new-sentinel half is medium-risk/off-story.
- **local-usage-counters** (S) — low value, telemetry-positioning footgun; never default-on.

## Standing guardrails
Don't add a 6th tool or polish the 5 commoditized tools. Compliance language = "produces audit evidence to support Article 12 / ISO 42001," never "certified." Import must validate + confirm before overwrite. audit-ui & airgap must gate cleanly offline. agent-startup-hardening must prove no state write lands in the source/app dir. Tauri is a no (Electron reuses the Node backend).
