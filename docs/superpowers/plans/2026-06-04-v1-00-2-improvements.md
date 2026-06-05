# DevOps Local — V1.00.2 Implementation Plan

> Execute on branch `v1.00.2`, TDD, one PR → CI → merge → tag → Release.

**Goal:** A substantive improvement release that deepens the compliance moat, replaces the last mock data with real diagnostics, broadens the Dependency Map to real-world lockfiles, finishes the advertised manifest watcher, and makes the desktop app produce a downloadable installer.

**Source:** the deferred backlog from the V1.00.1 6-agent research + codebase knowledge from the V1.00.1/desktop work. Guardrail still applies: invest in the audit/compliance + real-data differentiators, not a 6th tool.

---

### Task 1 — Lockfile manifest parsers (dep-map)
**Why:** Real npm/JS projects pin via lockfiles; `package-lock.json` currently mis-sniffs as `package.json` and reads the wrong shape.
**Files:** `agent/lib/dep-parsers.js`, `js/features.js` (mirror), `tests/dep-parsers.test.js`.
**Approach:** Add parsers for `package-lock.json` (v2/v3 `packages` map, skip root `""`), `yarn.lock` (`name@range:` → `version`), `pnpm-lock.yaml` (`packages:` keys). Fix detection so a lockfile isn't treated as its manifest. Defensive: bad input → `[]`.
**Tests:** round-trip each format; detection picks the lockfile parser.
**Commit:** `feat(dep-map): parse package-lock.json / yarn.lock / pnpm-lock.yaml`

### Task 2 — Real system/toolchain diagnostics in the UI
**Why:** Settings → About still shows mock `macOS 14.4 · 4 cores · 16 GB`; the agent already exposes real `/api/system` + `/api/toolchain` (tested) that the UI never displays.
**Files:** `js/persist.js` (About panel), maybe `js/agent-client.js`, `index.html` (About markup).
**Approach:** When the agent is online, fetch `/api/system` + `/api/toolchain` and replace the System row with real OS/arch/cores/RAM/free + node/git/python/cargo versions; gate to a sensible offline string. Fold into `buildDiagnostics()` too.
**Acceptance (live):** About shows real host data with the agent running.
**Commit:** `feat(settings): show real system + toolchain info (replaces mock About data)`

### Task 3 — Externally-verifiable signed audit log (Ed25519)
**Why:** The hash chain proves internal consistency, not authenticity — anyone who can read `agent/` can recompute it. Ed25519 signing makes it externally verifiable (the compliance headline).
**Files:** `agent/lib/audit.js`, `agent/server.js` (pubkey route), `agent/test/audit.test.js`.
**Approach:** On first append, generate an Ed25519 keypair (`crypto.generateKeyPairSync('ed25519')`); store the private key in the keystore (encrypted), write the public key to `agent/.audit-pubkey.pem` (gitignored). Sign each record line; `verify()` also checks signatures (legacy unsigned → `chain-verified, unsigned`). Add `GET /api/agent/audit/pubkey`.
**Tests:** signed record verifies; tampering breaks verify; legacy records still chain-verify.
**Commit:** `feat(audit): Ed25519-signed records + public-key verification`

### Task 4 — Manifest-change watcher + surface GitHub queue
**Why:** Settings advertises "manifest-change scans" but no sentinel implements it; `/api/github/queue` is exposed but never shown.
**Files:** `agent/lib/brain.js` (new `ManifestSentinel`), `agent/server.js` (register), `agent/fixtures/brain-manifest-smoke.mjs`, `js/audit-ui.js` or a small UI surface for the queue.
**Approach:** chokidar-watch the top-level manifest; on change, run a dep scan and emit a `notification` if newly outdated. Add a `manifestWatch` setting. Smoke fixture mirrors `brain-git-smoke`.
**Commit:** `feat(brain): manifest-change watcher sentinel + GitHub queue surface`

### Task 5 — Desktop: app icons + CI build job
**Why:** Make the desktop app produce a real, downloadable (unsigned) installer; the scaffold currently has no icon and no automated build.
**Files:** `desktop/build/` (icons), `desktop/package.json` (icon paths), `.github/workflows/desktop-build.yml`.
**Approach:** Generate `icon.{ico,icns,png}` from a source PNG. Add a tag-triggered (`v*`) matrix workflow (win/mac/linux) that installs agent + desktop and runs `electron-builder`, uploading artifacts. (Signing/auto-update deferred — needs Azure enrollment.)
**Commit:** `feat(desktop): app icons + CI installer build on tags`

### Task 6 — Version bump + release
**Files:** `js/core.js`, `agent/package.json`, `agent/server.js`, `index.html` version pill, README banner + changelog (add pass 9), `desktop/package.json`.
- Bump to `1.00.2`. Run full suite + audit + smokes. PR → CI → squash-merge. Tag `v1.00.2`, `gh release create`.

---

## Sequencing
1 (lockfiles) → 2 (real diagnostics) → 3 (Ed25519 audit) → 4 (manifest watcher) → 5 (desktop icons/CI) → 6 (release). Ship what completes; each is independently valuable.
