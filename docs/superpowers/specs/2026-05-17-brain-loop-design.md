# Brain Loop — Quarterly Design

| Field | Value |
|---|---|
| **Date** | 2026-05-17 |
| **Status** | Draft, awaiting user review |
| **Scope** | One quarter (~3 months), 5 features |
| **Target customer** | Enterprise + mid-size (10–100 engineers); solo + small team also benefit |
| **Deployment** | Hybrid: per-user local agent (current model) + optional Org Hub deferred to next quarter |
| **AI residency** | Pluggable: on-device (Ollama) OR cloud (OpenAI / Anthropic / Bedrock), org chooses |
| **Tracker** | GitHub Issues (GitHub App primary, PAT fallback). Jira / Linear deferred. |

## 1 — Commercial pitch

Bundle name: **Brain Loop**. The pitch line for a CTO:

> *"Errors in your logs now auto-detect, get a root-cause hypothesis from your own LLM, and arrive in your GitHub issue tracker as an enriched ticket — without leaving the developer's machine unless you choose to."*

Closes the loop from `LogWatchdog detects` → `LLM analyzes` → `enriched draft` → `filed GitHub issue`. Every cloud-routed LLM call passes through an audit log that lets a compliance reviewer verify exactly what was sent, when, and to whom, without reading the prompts themselves.

## 2 — The five features

### 2.1 Pluggable LLM Provider (foundation)

A single seam at `agent/lib/llm/index.js` that exposes:

```js
LLMProvider.complete({ template, input, maxTokens, temperature })
  → Promise<{ text, model, usage: { prompt, completion, totalTokens }, costCents }>
```

Four adapters ship in this quarter, all in `agent/lib/llm/`:

| Adapter | File | Auth | Endpoint | New deps |
|---|---|---|---|---|
| Ollama | `ollama.js` | none | `http://localhost:11434` (override-able) | none — native `fetch` |
| OpenAI | `openai.js` | `OPENAI_API_KEY` | `https://api.openai.com/v1/chat/completions` | none — native `fetch` |
| Anthropic | `anthropic.js` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` | none — native `fetch` |
| AWS Bedrock | `bedrock.js` | IAM credentials | `bedrock-runtime.<region>.amazonaws.com` | `@aws-sdk/client-bedrock-runtime` (only new dep, conditional) |

The Bedrock SDK is loaded with `require('@aws-sdk/client-bedrock-runtime')` only when the provider is actively selected. Installs that never use Bedrock don't pay the size cost.

**Default adapter on first launch: Ollama.** First-launch posture is local-only. Customers opt into cloud explicitly via Settings → AI.

**Templates** live in `agent/lib/llm/templates.js` and are versioned (`log-triage-v1`, `diff-narrator-v1`). Each template is `{ system, userTemplate, output: 'json'|'text', expectedSchema? }`. When `output: 'json'` and `expectedSchema` is set, the response is validated against the schema; a mismatch produces `outcome: 'bad-response'` and triggers exactly one repair retry (a second call with the original response appended and "Please return valid JSON matching the schema." prepended). Versioning lets us A/B prompts and run an eval suite later without breaking running deployments.

**Redaction.** Every prompt is passed through `agent/lib/llm/redact.js` before the adapter sees it. The scrubber removes:
- Anything matching the existing env-var redaction patterns (SECRET, TOKEN, KEY, PASSWORD, PASSPHRASE, AUTH, CREDENTIAL, COOKIE, SESSION, BEARER, API_KEY, PRIVATE)
- Any additional patterns from `settings.extraRedactPatterns` (user-provided regex list)
- Bare IPv4/IPv6 addresses (replaced with `<ip>`)
- Anything that looks like a path containing the user's home directory (replaced with `~`)

The audit record stores a `redactionSummary` (counts, not the redacted values) so reviewers can verify scrubbing happened without seeing the originals.

### 2.2 AI-Enriched LogWatchdog Drafts (priority)

The closed loop's first half. Modifies `agent/lib/brain.js`'s `LogWatchdog._pin()` call site.

**Flow:**

1. Existing `LogWatchdog` detects an error matching `settings.errorPatterns` in a watched file.
2. Existing `_pin()` builds a draft (title + matched line + 20-line context).
3. **Draft is saved immediately to `brain.recentDrafts` and an `draft` SSE event fires** — no LLM dependency for the bare draft.
4. **New:** `brain.scheduleEnrichment(draft)` queues an LLM call. The queue is sequential per agent (no concurrent enrichments) so a burst of errors doesn't fan-out cost.
5. **New:** worker takes the queued draft, calls `llm.complete({ template: 'log-triage-v1', input: { matchedLine, context, workspace, branch }, maxTokens: 400, temperature: 0.2 })`. JSON-mode where supported.
6. LLM returns `{ summary, likely_cause, confidence: 'low'|'medium'|'high', next_steps: [string,…], related_signals: [string,…] }`. One repair retry if the JSON is malformed.
7. The draft is updated in place with `enrichedAt`, `enrichmentAuditId`, `confidence`, and Markdown gains two new sections (`## Likely cause`, `## Suggested next steps`) and a provenance footer.
8. **New:** `draft-enriched` SSE event fires. Frontend's `brain-client.js` receives it, updates the local draft entry by id, toasts.

**Fallback order:**

1. Provider returns 5xx / times out at 15s → keep the unenriched draft, log `warn`, expose a "✨ Enrich" button on the draft for manual retry.
2. Provider returns malformed JSON twice → same fallback.
3. Provider is `Off` in settings → skip silently, no warn.
4. Provider returns success but `confidence: low` → still attach, but UI shows a muted "low confidence" pill.
5. Daily cap reached → queue beyond cap is deferred to next day's reset; first match per pattern still attempts.

**Settings → AI → "Auto-enrich LogWatchdog drafts"** toggle. Default is **OFF when provider = `Off`**, **ON when any other provider is selected** (the user can toggle it back off explicitly). No magic auto-flips on test-connection — the toggle is bound to the provider selection only, and is overridable.

### 2.3 Context-Snap AI Diff Narrator (on-demand)

Adds a "Compare" button to the Context-Snap toolbar. User picks two snapshots (current vs. saved, or two saved). Output is a structured diff PLUS an LLM-narrated paragraph.

**Diff computation:** local, deterministic, no LLM. Produces:

```js
DiffReport = {
  env:   { added: [string], removed: [string], changed: [{ key, before, after }] },
  pids:  { gained: number, lost: number },
  git:   { branchChanged?: { from, to }, shaChanged: boolean, dirtyDelta: number },
  ports: { opened: [number], closed: [number] }
}
```

**Narration:** the DiffReport (small, already redacted) is sent to `llm.complete({ template: 'diff-narrator-v1', input: diffReport, maxTokens: 250 })`. Output is a 2–3 sentence paragraph rendered above the structured diff.

**On-demand only.** Auto would mean every Brain snapshot triggers an LLM call — expensive on busy git histories. Confirmed off by design.

**Fallback:** if LLM unavailable, the structured diff renders alone with a muted "narration unavailable" line. The diff itself never fails — pure local computation.

Counts against the same daily LLM cap as enrichment.

### 2.4 GitHub Issues Integration (closed loop's second half)

**Auth — primary: GitHub App.** Org admin installs the app on selected repos. Agent exchanges the installation token. No per-user PAT; scoped to selected repos only; revocable from GitHub Settings.

**Auth — fallback: Personal Access Token.** For solo users and non-org repos. Gated by an explicit Settings → AI → "Use PAT instead" opt-in with an inline warning. PAT stored encrypted in `agent/.ai-keys.json` (mode `0600`).

**Implementation:** `agent/lib/github.js`, ~150 lines. Uses native `fetch` against `api.github.com/graphql` for issue creation (one round-trip vs. REST's two). No `octokit` dep.

**UI surface:** "File on GitHub" button on every Issue Filler draft (enriched or bare). Opens a small modal:

| Field | Source |
|---|---|
| Repo | Dropdown populated from the GitHub App's accessible installations, OR from a configured PAT's repo list |
| Title | Pre-filled from draft `title`, editable |
| Body | Draft Markdown, editable in a textarea |
| Labels | Auto-mapped from severity: `warn` → `bug`; `error` → `bug,priority-high`; user can edit |
| Assignee | Auto-pulled from workspace's owner mapping if set (new optional field on workspace) |

**Submit:** POSTs the GraphQL `createIssue` mutation. On success, the modal becomes a confirmation linking to the new issue URL. The draft gets:

```js
draft.filedAs = { provider: 'github', url, issueNumber, filedAt: iso }
```

The drafts list shows a "✓ Filed" pill on filed drafts.

**Auto-file mode.** Settings → AI → "Auto-file high-severity enriched drafts to GitHub" toggle (default OFF). When ON, fires only when:
- the draft has `enriched: true`
- `confidence: 'high'`
- `severity >= 'error'` (computed from the original log line's level)

Every auto-file emits a `notification` SSE event so the user sees it happen.

**Failure handling:**
- GitHub 4xx / 5xx → toast + leave draft un-filed + show retry button.
- Network failure → queued in `agent/.github-queue.json` (JSON array). Drained on a 60-second backoff timer. Each queue entry has its own retry count; after 24 h it's dropped with a final warn-level audit record.

### 2.5 AI Audit Log

Append-only NDJSON at `agent/.audit.log`. Rotated to `.audit-1.log`, `.audit-2.log`, … at 10 MB each. Keep the last 10 rotations (configurable via `AUDIT_KEEP=N`).

**Hash-chained.** Each record includes `prevHash`, the SHA-256 of the previous record's serialized form. Tampering — editing or deleting any record — invalidates the chain from that point forward. The chain head's current hash is also mirrored to `agent/.audit-tip` for quick checks.

**Record schemas.** Two record kinds:

```jsonc
// kind: "llm-call"
{
  "ts": "2026-05-17T10:23:14.582Z",
  "id": "aud-…",
  "kind": "llm-call",
  "feature": "log-watchdog-enrich",   // or "diff-narrator", "manual-enrich"
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "template": "log-triage-v1",
  "promptHash": "sha256:…",
  "promptBytes": 1842,
  "redactionSummary": { "envVarsScrubbed": 0, "secretsFound": 2, "ipsScrubbed": 1 },
  "responseBytes": 412,
  "tokens": { "prompt": 460, "completion": 102, "total": 562 },
  "costCents": 0.34,
  "outcome": "ok",                    // ok | timeout | bad-response | provider-error
  "prevHash": "sha256:…"
}

// kind: "github-file"
{
  "ts": "2026-05-17T10:23:18.014Z",
  "id": "aud-…",
  "kind": "github-file",
  "feature": "auto-file" | "manual-file",
  "repo": "acme/api",
  "issueNumber": 1842,
  "labels": ["bug","priority-high"],
  "draftId": "draft-brain-…",
  "outcome": "ok",                    // ok | rate-limited | unauthorized | network-error
  "prevHash": "sha256:…"
}
```

**API:**

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/agent/audit?limit=200&since=<iso>` | JSON list, newest first |
| `GET` | `/api/agent/audit/export?format=csv\|jsonl` | Full export for SIEM ingest. Streamed. |
| `GET` | `/api/agent/audit/verify` | Walks the chain across all rotated files; returns `{ ok: true, recordsVerified: N }` or `{ ok: false, brokenAt: id }` |

**Dashboard surface:** Settings → AI → "Audit log" row with three buttons: **View** (paginated table modal), **Export** (downloads `.jsonl` or `.csv`), **Verify chain** (runs `/verify`, toasts the result).

**Redaction proof:** because we store `promptHash` (not plaintext), a customer can ask "show me what you sent to OpenAI about user X" and the answer is: *"We don't store prompts. Here is the hash and the redaction summary; the prompt has been overwritten on disk."*

## 3 — Architecture

### 3.1 New code layout

```
agent/lib/llm/
  index.js            // factory: picks adapter from settings + caches the instance
  ollama.js           // HTTP to localhost:11434
  openai.js           // native fetch to api.openai.com
  anthropic.js        // native fetch to api.anthropic.com
  bedrock.js          // @aws-sdk/client-bedrock-runtime (only conditional dep)
  templates.js        // versioned prompts + expected schemas
  redact.js           // scrub secrets / IPs / home paths before send
agent/lib/audit.js    // NDJSON append, rotation, hash chain, verify
agent/lib/github.js   // GitHub App + PAT, GraphQL createIssue, queue
agent/lib/brain.js    // extended: LogWatchdog.scheduleEnrichment + worker
agent/server.js       // extended: /api/llm/*, /api/agent/audit/*, /api/github/*
js/brain-client.js    // extended: handles 'draft-enriched' SSE, "File on GitHub" UI
js/features.js        // extended: Context-Snap Compare button + diff narrator UI
```

### 3.2 Data flow — closed-loop priority feature

```
fs.watch  →  LogWatchdog (existing)  →  LLMProvider.complete  →  EnrichedDraft (SSE)  →  GitHub.fileIssue
            regex match                  redaction + provider      draft-enriched         GraphQL mutation
                                         ↓                          event                  ↓
                                         audit.append (llm-call)                           audit.append (github-file)
```

Audit hook fires at the LLM call AND the GitHub call. Both records are hash-chained into the same NDJSON file.

### 3.3 Key architectural decisions

| Decision | Rationale |
|---|---|
| **Default adapter is Ollama** | First-launch posture is local-only. Customer opts into cloud explicitly. Aligns with offline-first identity. |
| **Adapters use native `fetch`** for 3 of 4 providers | Zero new deps for the common case. We control the wire format for redaction. |
| **Bedrock SDK loaded conditionally** | Don't pay the size cost (~5 MB) for installs that never use AWS. |
| **Templates versioned** (`-v1` suffix) | Enables A/B prompts and eval suite without breaking deployments. |
| **Audit log is append-only NDJSON** | Easy to ship to SIEM, easy to grep, no schema migrations. |
| **Hash-chained audit log** | Tamper detection that doesn't require a separate service. SHA-256 chain is cheap. |
| **GitHub adapter parallel to LLM adapters** | Adding Jira/Linear next quarter is one new file, not a rewrite of `brain.js`. |
| **Bare draft saves before enrichment** | LLM unavailability never blocks the existing Brain feature. |
| **Enrichment queue is sequential per agent** | Burst of errors → single-file LLM serialization → predictable cost. |
| **Provider keys never reach the browser** | Reduces credential exposure. Test-key endpoint returns boolean only. |

## 4 — Settings UI (`s-ai` section)

Slots into Settings between `s-watchers` and `s-resources`. Three sub-groups:

**Provider:** segmented control (Ollama / OpenAI / Anthropic / Bedrock / Off) · model dropdown (populated from active provider) · endpoint override input · Test connection button (round-trip latency badge).

**Per-feature toggles:** Auto-enrich LogWatchdog drafts (default ON when provider ≠ Off, overridable) · Snapshot diff narrator (default ON when provider ≠ Off, overridable) · Auto-file high-severity enriched drafts to GitHub (default OFF — always opt-in).

**Cost & safety:** Daily LLM call cap slider (0–1000, default 100) · Extra redaction patterns textarea (regex, one per line) · Audit log row with View / Export / Verify chain buttons.

All settings persist via the existing `persist.js` auto-walker — no per-control glue needed. The provider, endpoint, model, and feature toggles also POST to `/api/agent/settings` via the existing `brain-client.js` bridge (mapping table extended).

## 5 — Persistence

### 5.1 New on-disk artifacts (agent)

| File | Format | Rotation | Mode | Purpose |
|---|---|---|---|---|
| `agent/.audit.log` | NDJSON, hash-chained | 10 MB → `.audit-N.log`, keep last 10 | `0644` | LLM calls + GitHub filings |
| `agent/.audit-tip` | Plain text (current chain head hash) | rewritten on each append | `0644` | Quick chain-tip check |
| `agent/.ai-keys.json` | JSON | none | `0600` | Provider API keys + GitHub PAT, encrypted at rest (see §6 for derivation) |
| `agent/.salt` | Binary, 16 bytes | none | `0600` | Per-install salt for the at-rest key derivation. Auto-generated. |
| `agent/.github-queue.json` | JSON array | rewritten on each retry sweep | `0644` | Pending GitHub filings during outages |

All five are added to `agent/.gitignore`.

### 5.2 Settings additions

New `localStorage` settings entries (via the existing `k:s-ai::*` auto-walker):

- `k:s-ai::LLM provider` → one of `Ollama|OpenAI|Anthropic|Bedrock|Off`
- `k:s-ai::Model` → string
- `k:s-ai::Endpoint` → URL string
- `k:s-ai::Auto-enrich LogWatchdog drafts` → boolean
- `k:s-ai::Snapshot diff narrator` → boolean
- `k:s-ai::Auto-file high-severity enriched drafts to GitHub` → boolean
- `k:s-ai::Daily LLM call cap` → number (0–1000)
- `k:s-ai::Extra redaction patterns` → string (newline-separated)

One new derived key:
- `devops:audit-summary` → `{ size, tipHash, lastCheckedAt }` for the audit pill in the brand area

### 5.3 Schema extensions to existing entities

| Entity | Existing | Added (optional) |
|---|---|---|
| Draft (`devops:issue-drafts`) | `id, name, title, content, when, source, reason, meta` | `enrichedAt, enrichmentAuditId, confidence, filedAs` |
| Snapshot (`devops:snapshots`) | unchanged | (no change — Diff is on demand) |
| Workspace (`devops:workspaces`) | `id, name, path, initials, colorStart, colorEnd, addedAt` | `githubRepo?, defaultAssignee?` |

## 6 — Security model

- **Keys never reach the browser.** `POST /api/agent/ai/test-key` validates the key against the provider; dashboard only sees `{ok: true|false, latencyMs, model}`. Actual key lives in `agent/.ai-keys.json` (mode `0600`, encrypted at rest). The encryption key is derived via `scryptSync(WORKSPACE_ROOT + os.hostname() + os.userInfo().username, salt, 32)` using a fixed per-install salt stored in `agent/.salt` (chmod `0600`, auto-generated on first run). This binds the keys to the install — copying the JSON file to another machine yields garbage.
- **Redaction is mandatory and verifiable.** Every prompt routes through `lib/llm/redact.js` before any adapter sees it. The audit record stores `redactionSummary` so reviewers can confirm scrubbing without seeing originals.
- **Workspace boundary stays intact.** No new path-handling endpoints. LogWatchdog already validates paths through `withinWorkspace()`; enrichment receives already-validated lines.
- **GitHub App is the secure-by-default path.** Org-scoped, revocable, narrow repo set. PAT path is gated behind an explicit opt-in with a warning.
- **Outbound LLM endpoint allowlist.** New env var `LLM_ENDPOINT_ALLOWLIST` defaults to `api.openai.com,api.anthropic.com,bedrock-runtime.*.amazonaws.com,localhost,127.0.0.1`. Customers can tighten or expand. Outside-allowlist hostnames are refused before the adapter dials.
- **No prompt plaintexts persisted.** Only `promptHash` + `redactionSummary` + `promptBytes`. Recovering a prompt requires the live process memory.
- **Hash-chained audit log** detects tampering. `GET /api/agent/audit/verify` walks the chain across rotated files; returns the first id where the chain breaks if any.

## 7 — Testing strategy

Six new smoke fixtures in `agent/fixtures/`, each spinning up a fresh agent against a temp workspace (matching the Phase 4 pattern). All run cross-platform.

| Fixture | Asserts |
|---|---|
| `llm-provider-smoke.mjs` | Factory loads Ollama by default · switching providers via `POST /api/agent/settings` updates the active adapter · `POST /api/llm/test` round-trips through each adapter with a tiny prompt · bad endpoint returns a clean error |
| `log-enrich-smoke.mjs` | Brain pins an error → bare draft saves immediately → enriched draft replaces it within 15 s → `draft-enriched` SSE fires → confidence + likely_cause + next_steps present → fallback path triggers when provider returns 5xx (draft retains, no second SSE) |
| `diff-narrator-smoke.mjs` | DiffReport computed correctly from two known snapshots · on-demand narration call returns paragraph · cap-reached state returns a toast-shaped error |
| `github-file-smoke.mjs` | Against a local express stub posing as `api.github.com`: PAT auth round-trips · failure queues · queue drains on next sweep · draft gets `filedAs` field · auto-file mode fires only on `confidence: high` + `severity >= error` |
| `audit-chain-smoke.mjs` | 50 records written → chain verifies · corrupting any record fails verification at exactly that id · rotation kicks in at 10 MB · old records still verifiable across rotated files · export endpoints stream correctly |
| `brain-loop-e2e-smoke.mjs` | Full closed loop with all features enabled: FATAL appears in watched log → enrichment runs → high confidence → auto-file fires → GitHub stub receives the issue → audit log shows both records chained correctly |

**Regression policy:** the 11 existing Phase 4 fixtures (plus the four Phase 1–3 ones) must stay green. CI runs all 17+6 = 23 fixtures before merge.

**Manual eval suite** (not automated): a small set of curated "golden" log → expected-summary pairs in `agent/fixtures/eval/log-triage/` for human review of prompt quality across providers. Run with `node fixtures/eval/run.mjs --provider <name>`. Used during prompt-template iteration, not gating CI.

## 8 — Out of scope this quarter

Explicitly deferred to a future quarter, not forgotten:

- **Org Hub central server.** Each agent runs standalone with its own audit log this quarter. Hub gives org-wide audit aggregation, central license management, SSO, shared workspace configs. Not blocking the closed-loop pitch.
- **SSO** (SAML / OIDC). Comes with the Org Hub.
- **Jira and Linear adapters.** GitHub Issues ships first. The adapter-factory pattern in `agent/lib/github.js` is structured so subsequent trackers are one new file each.
- **Custom-trained model.** Pluggable abstraction supports dropping in a fine-tuned model later as a new adapter; not building one this quarter.
- **AI-Summarize for Docs Scraper, AI-Dep-Risk for Dep Map.** Considered for "AI everywhere" but cut to keep this quarter focused on the closed-loop story.
- **Prompt template eval suite** as part of CI. Manual eval only this quarter (see §7).
- **Anonymized telemetry capture** for future fine-tuning. Possible without the Org Hub but adds privacy surface area; defer.

## 9 — Decisions log

The non-obvious calls made during brainstorming, captured for future-us:

1. **Target = Enterprise + mid-size first** (eventually all). Drives feature priorities toward audit/compliance and away from "individual developer delight" features.
2. **Deployment = hybrid local + optional sync hub** (not strictly local, not central server). Preserves offline-first promise; defers hub to next quarter.
3. **Time horizon = next quarter, 3–5 features.** One coordinated bundle, not a single feature, not a year-long roadmap.
4. **Value vectors = AI + deeper tools + light integration.** Not Org Hub, not more sentinels.
5. **AI residency = pluggable on-device OR cloud.** Largest customer base. ~1.5× the code of single-mode.
6. **Approach = "Deep AI in the Brain Loop"** (over "AI Across the Board" or "AI Sandbox / Custom Model Foundation"). Closed-loop story is the easiest single thing to sell.
7. **First tracker = GitHub Issues** (over Jira / Linear / no built-in). GitHub App is enterprise-secure; PAT is the solo-dev escape hatch.
8. **Bare draft saves before enrichment.** LLM unavailability never blocks the existing Brain.
9. **JSON-mode LLM output, not free-form Markdown.** Predictable parsing; one repair retry on bad JSON.
10. **Per-day cost cap (default 100/day).** Enterprise procurement won't sign off on uncapped LLM bills.
11. **Auto-file default OFF.** Risk of noise — opt-in is the right default. Can market the "fully automated triage" pitch once customers turn it on.
12. **Hash-chained audit log.** Worth the small complexity (sha256 per record) for tamper detection without a separate service.
13. **Diff Narrator on-demand only.** Auto would burn LLM calls on every snapshot.

## 10 — Acceptance criteria

A successful quarterly delivery means:

- All 6 new smoke fixtures pass on Windows + macOS + Linux (CI).
- All 17 existing Phase 1–4 fixtures stay green (no regression).
- Manual eval suite produces coherent results for the 4 providers using `llama3.1:8b` (Ollama), `gpt-4o-mini` (OpenAI), `claude-sonnet-4-6` (Anthropic), and `anthropic.claude-sonnet-4-6-v1:0` (Bedrock).
- README updated with new Mode 3 features, new Settings → AI section, new `LLM_ENDPOINT_ALLOWLIST` env var, new audit log location.
- Agent README updated with the new endpoints, new sentinels behavior, and an "AI security model" sub-section.
- Demo recording: `git checkout broken-branch` → toast appears → enriched draft visible with cause + next steps → "File on GitHub" → issue created in a real (test) repo → audit log shows two chained records.

---

*End of design. Implementation plan to follow via the writing-plans skill.*
