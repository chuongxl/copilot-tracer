# Work Items and Engineering Productivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trustworthy work-item layer that extracts ticket references from traces, lets engineers group prompts under project work items, and provides a foundation for later requirement summaries and productivity views.

**Architecture:** Keep telemetry ingestion synchronous and unchanged at the boundary. Persist deterministic extraction results after each trace is stored, then expose work items through explicit database and HTTP APIs. Use a many-to-many trace link so one prompt can support multiple tasks. Add AI enrichment only after the deterministic model and manual correction flow are proven.

**Tech Stack:** TypeScript, better-sqlite3, Express, vanilla HTML/CSS/JavaScript, Node.js manual verification scripts, SQLite migrations through existing startup schema initialization.

**Spec:** `docs/work-items-productivity-design.md`

## Global Constraints

- Raw prompts and responses remain unchanged.
- Telemetry ingestion must not wait on external network calls or model inference.
- Ticket identity is deterministic evidence. AI summaries are advisory and editable.
- Work-item links require confidence and source metadata.
- One trace may link to multiple work items.
- Existing project, session, trace, dashboard, and live-tracer behavior must remain available.
- Every feature change uses a dedicated branch and pull request.
- Every task ends with a focused check and a commit.
- No hosted AI dependency is added before enrichment is explicitly enabled and privacy handling is implemented.

---

## File and responsibility map

### Existing files to modify

- `src/types.ts` owns public TypeScript interfaces for work items, references, links, and extraction results.
- `src/db.ts` owns SQLite schema initialization, persistence, and query functions.
- `src/otlpReceiver.ts` owns the post-persistence extraction trigger and project/session context.
- `src/webServer.ts` owns work-item and extraction HTTP endpoints.
- `web/index.html` owns the dashboard and project workspace UI.
- `README.md` documents user-visible commands and dashboard behavior.

### New files to create

- `src/workItemExtraction.ts` owns deterministic ticket-reference parsing and work-kind classification.
- `src/workItemService.ts` owns idempotent extraction persistence, candidate matching, and manual grouping operations.
- `scripts/verify-work-items.mjs` drives an isolated daemon and asserts the real HTTP behavior.
- `docs/work-items-productivity-design.md` owns product and architecture decisions.
- `docs/superpowers/plans/2026-09-24-work-items-productivity.md` owns the task sequence.

### Tests

There is no configured test framework. Each task uses a focused Node script or existing manual command. Do not add a test framework for the first phase.

## Dependency graph

```text
Task 1 -> Task 2 -> Task 3 -> Task 4 -> Task 5
                         \-> Task 6
Task 5 -> Task 7
Task 6 -> Task 7
Task 7 -> Task 8
```

## Throughput checkpoint

- Blocking first steps: branch setup, schema design, and deterministic parser contracts must pass before fan-out.
- Independent workstreams: parser implementation and schema/API implementation can proceed after the contracts are fixed.
- Shared mutable state: `src/db.ts`, `src/types.ts`, and `web/index.html` are shared targets. Serialize edits to each file.
- Smallest safe decomposition: use one owner for the first vertical slice, then split parser and UI work only after persisted work items are available.

### Task 1: Create the feature branch and baseline verifier

**Files:**
- Create: `scripts/verify-work-items.mjs`
- Modify: `.gitignore` only if the verifier produces a named ignored scratch directory

**Interfaces:**
- Produces a verifier that starts a daemon with an isolated `COPILOT_TRACER_HOME`, posts a trace payload, and reads work-item API responses.

- [ ] **Step 1: Create the branch**

```bash
git switch main
git pull --ff-only
git switch -c feature/work-items-productivity
```

- [ ] **Step 2: Write the baseline verifier**

The script must:

1. Create a temporary home directory.
2. Start `node dist/cli.js --daemon --port <free-port>`.
3. Wait for `GET /api/dashboard` to return `200`.
4. Post one OTLP span containing the prompt `Implement ABC-123 and open a PR`.
5. Assert the server stays responsive.
6. Stop only the child PID and remove the temporary home.

- [ ] **Step 3: Run the baseline verifier**

Run:

```bash
npm run build
node scripts/verify-work-items.mjs
```

Expected: the daemon starts, accepts the trace, and exits with code `0`. The work-item assertions remain absent until Task 2.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-work-items.mjs
git commit -m "test: add work item verification harness"
```

### Task 2: Define deterministic extraction contracts

**Files:**
- Create: `src/workItemExtraction.ts`
- Modify: `src/types.ts`
- Create: `scripts/test-work-item-extraction.mjs`

**Interfaces:**
- Produces `extractWorkItemEvidence(prompt: string): WorkItemEvidence`.
- `WorkItemEvidence` contains `references`, `kind`, `signals`, and `confidence`.
- Each reference contains `type`, `key`, `url`, `sourceText`, and `confidence`.
- `kind` is one of the controlled work-item kinds from the design document.

- [ ] **Step 1: Write failing extraction cases**

The script must assert:

```js
extract("Fix ABC-123. See https://github.com/acme/app/issues/42")
  .references === [
    { type: "jira", key: "ABC-123" },
    { type: "github_issue", key: "acme/app#42", url: "https://github.com/acme/app/issues/42" }
  ];

extract("Add project filtering to the dashboard").kind === "feature";
extract("Why is telemetry missing from VS Code?").kind === "investigation";
extract("dashboard API").kind === "unknown";
```

- [ ] **Step 2: Run the extraction script**

Run:

```bash
node scripts/test-work-item-extraction.mjs
```

Expected: FAIL because `src/workItemExtraction.ts` does not exist.

- [ ] **Step 3: Implement the parser**

Use anchored regular expressions and normalization:

```ts
export type WorkItemKind =
  | 'feature' | 'bug' | 'task' | 'refactor'
  | 'investigation' | 'documentation' | 'operations' | 'unknown';

export interface WorkItemEvidence {
  references: TicketReference[];
  kind: WorkItemKind;
  signals: string[];
  confidence: number;
}

export function extractWorkItemEvidence(prompt: string): WorkItemEvidence;
```

Deduplicate references by normalized type and key. Return `unknown` when no classifier has enough evidence.

- [ ] **Step 4: Run the extraction script**

Run:

```bash
node scripts/test-work-item-extraction.mjs
```

Expected: PASS for Jira keys, GitHub issues, GitHub PRs, Azure URLs, work-kind classification, deduplication, and unknown fallback.

- [ ] **Step 5: Type-check**

Run:

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/workItemExtraction.ts scripts/test-work-item-extraction.mjs
git commit -m "feat: detect work item evidence from prompts"
```

### Task 3: Add SQLite work-item schema and persistence

**Files:**
- Modify: `src/db.ts`
- Modify: `src/types.ts`
- Create: `src/workItemService.ts`
- Modify: `scripts/test-work-item-extraction.mjs` to cover persistence through the service

**Interfaces:**
- `createWorkItem(input: CreateWorkItemInput): WorkItem`.
- `getWorkItems(projectId: string, status?: WorkItemStatus): WorkItem[]`.
- `getWorkItem(id: string): WorkItem | null`.
- `linkTraceToWorkItem(input: WorkItemTraceLinkInput): void`.
- `saveTicketReference(input: TicketReferenceInput): void`.
- `persistWorkItemEvidence(trace: TraceEntry, projectId: string): WorkItemEvidenceResult`.

- [ ] **Step 1: Extend schema initialization**

Add these tables in the existing database initialization path:

```sql
CREATE TABLE IF NOT EXISTS work_items (...);
CREATE TABLE IF NOT EXISTS work_item_traces (...);
CREATE TABLE IF NOT EXISTS work_item_references (...);
```

Use foreign keys where the current schema supports them. Add unique constraints for `(work_item_id, trace_id)` and `(work_item_id, reference_type, reference_key)`.

- [ ] **Step 2: Write persistence assertions**

Assert that:

1. Persisting the same trace twice does not create duplicate work items or links.
2. A second prompt containing `ABC-123` joins the existing project work item.
3. A prompt containing a different ticket creates a separate detected item.
4. One trace can link to two work items.

- [ ] **Step 3: Implement service functions**

Use exact ticket references as the first matching key. Generate a deterministic title such as `ABC-123` when no summary exists. Store `source`, `confidence`, and extractor version with generated metadata.

- [ ] **Step 4: Run persistence assertions**

Run:

```bash
npm run build
node scripts/test-work-item-extraction.mjs
```

Expected: PASS with an isolated database.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/types.ts src/workItemService.ts scripts/test-work-item-extraction.mjs
git commit -m "feat: persist project work items and trace links"
```

### Task 4: Trigger extraction after trace persistence

**Files:**
- Modify: `src/otlpReceiver.ts`
- Modify: `src/claudeSession.ts`
- Modify: `src/workItemService.ts`
- Modify: `scripts/verify-work-items.mjs`

**Interfaces:**
- Consumes `TraceEntry` and resolved `projectId`.
- Produces persisted work-item evidence without delaying the ingestion response.

- [ ] **Step 1: Add a failing end-to-end assertion**

After posting a prompt containing `ABC-123`, the verifier must assert:

```js
const items = await getJson(`${base}/api/projects/${projectId}/work-items`);
assert.equal(items[0].ticketKey, "ABC-123");
assert.equal(items[0].traceCount, 1);
```

- [ ] **Step 2: Add the post-persistence hook**

Call `persistWorkItemEvidence(entry, resolvedProjectId)` immediately after `upsertTrace(entry)` in each trace-producing path. The service must be idempotent and must not call external services.

- [ ] **Step 3: Run the verifier**

Run:

```bash
npm run build
node scripts/verify-work-items.mjs
```

Expected: PASS and the OTLP response remains successful.

- [ ] **Step 4: Commit**

```bash
git add src/otlpReceiver.ts src/claudeSession.ts src/workItemService.ts scripts/verify-work-items.mjs
git commit -m "feat: extract work items from captured traces"
```

### Task 5: Add read and manual-grouping APIs

**Files:**
- Modify: `src/webServer.ts`
- Modify: `src/workItemService.ts`
- Modify: `scripts/verify-work-items.mjs`

**Interfaces:**
- `GET /api/projects/:id/work-items`
- `GET /api/work-items/:id`
- `POST /api/work-items`
- `PATCH /api/work-items/:id`
- `POST /api/work-items/:id/traces`
- `DELETE /api/work-items/:id/traces/:traceId`

- [ ] **Step 1: Write API assertions**

Cover:

1. List work items for a project.
2. Fetch one work item with references and linked traces.
3. Edit title, summary, kind, and status.
4. Attach an unlinked trace.
5. Detach a trace.
6. Reject an unknown project or work item with `404`.
7. Reject invalid kind and status with `400`.

- [ ] **Step 2: Implement route validation**

Validate all IDs and enum fields at the HTTP boundary. Return explicit JSON errors. Do not silently ignore invalid links.

- [ ] **Step 3: Run the API verifier**

Run:

```bash
npm run build
node scripts/verify-work-items.mjs
```

Expected: PASS for all API assertions.

- [ ] **Step 4: Commit**

```bash
git add src/webServer.ts src/workItemService.ts scripts/verify-work-items.mjs
git commit -m "feat: expose work item management APIs"
```

### Task 6: Add project workspace and uncategorized inbox UI

**Files:**
- Modify: `web/index.html`
- Modify: `src/webServer.ts` only if the UI needs a summary endpoint
- Modify: `scripts/verify-work-items.mjs`

**Interfaces:**
- The project card opens `#/project?project=<id>`.
- The workspace loads `/api/projects/:id/work-items`.
- The inbox loads unlinked traces for the project.

- [ ] **Step 1: Write browser assertions**

The real browser verifier must assert:

1. Dashboard project card opens the project workspace.
2. Work items tab shows `ABC-123`.
3. Work item detail shows linked prompt count and ticket reference.
4. Editing the title updates the visible title after reload.
5. Inbox shows an unlinked trace.
6. Attach and unlink actions update the visible state.

- [ ] **Step 2: Implement the project workspace**

Add Overview, Work Items, Sessions, and Traces tabs. Keep the existing live tracer route intact. Use accessible labels and stable IDs for controls.

- [ ] **Step 3: Implement the inbox**

Show only traces with no work-item link. Provide explicit `Create work item`, `Attach`, `Ignore`, and `Mark unrelated` actions.

- [ ] **Step 4: Run browser verification**

Run:

```bash
npm run build
node scripts/verify-work-items.mjs --browser
```

Expected: PASS with retained screenshots and accessibility snapshots.

- [ ] **Step 5: Commit**

```bash
git add web/index.html scripts/verify-work-items.mjs
git commit -m "feat: add project work item workspace"
```

### Task 7: Add editable summaries and deterministic classification

**Files:**
- Modify: `src/workItemExtraction.ts`
- Modify: `src/workItemService.ts`
- Modify: `src/webServer.ts`
- Modify: `web/index.html`
- Modify: `scripts/verify-work-items.mjs`

**Interfaces:**
- `generateWorkItemDraft(traces: TraceEntry[]): WorkItemDraft`.
- `POST /api/work-items/:id/draft`.
- `PATCH /api/work-items/:id` accepts manually edited summary and acceptance criteria.

- [ ] **Step 1: Write draft-generation assertions**

Given prompts containing an objective and explicit criteria, assert the draft title, summary, and criteria are deterministic and marked as generated.

- [ ] **Step 2: Implement local draft generation**

Use prompt structure and deterministic sentence extraction first. Do not add a hosted model. Store `source = 'prompt'` and a generator version.

- [ ] **Step 3: Add editable UI**

Render generated fields with an `AI-generated` or `Generated from prompts` label and editable controls. Preserve manual edits on subsequent extraction runs.

- [ ] **Step 4: Run verification**

Run:

```bash
npm run build
node scripts/verify-work-items.mjs --browser
```

Expected: generated drafts appear, manual edits persist, and raw prompts remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/workItemExtraction.ts src/workItemService.ts src/webServer.ts web/index.html scripts/verify-work-items.mjs
git commit -m "feat: add editable work item summaries"
```

### Task 8: Add Git and PR evidence before productivity metrics

**Files:**
- Create: `src/workItemGitEvidence.ts`
- Modify: `src/workItemService.ts`
- Modify: `src/webServer.ts`
- Modify: `web/index.html`
- Modify: `README.md`
- Modify: `scripts/verify-work-items.mjs`

**Interfaces:**
- `collectGitEvidence(projectPath: string): GitEvidence`.
- `POST /api/work-items/:id/refresh-evidence`.

- [ ] **Step 1: Write evidence assertions**

Verify that a local commit, branch, or PR reference is shown as evidence and never automatically marks a work item completed without the configured completion rule.

- [ ] **Step 2: Implement local Git evidence**

Read branch name, recent commits, and configured remote URL with bounded commands. Treat command failures as explicit evidence errors.

- [ ] **Step 3: Add completion controls**

Show evidence on the work-item detail page. Require manual confirmation before changing status to `completed`.

- [ ] **Step 4: Run verification**

Run:

```bash
npm run build
node scripts/verify-work-items.mjs --browser
```

Expected: evidence appears and status changes only through explicit confirmation.

- [ ] **Step 5: Commit**

```bash
git add src/workItemGitEvidence.ts src/workItemService.ts src/webServer.ts web/index.html README.md scripts/verify-work-items.mjs
git commit -m "feat: add git evidence to work items"
```

### Task 9: Measure grouping quality before adding similarity or AI enrichment

**Files:**
- Create: `scripts/evaluate-work-item-grouping.mjs`
- Modify: `README.md`
- Create: `docs/work-items-evaluation.md`

**Interfaces:**
- The evaluator consumes a fixed prompt fixture set and reports precision, recall, auto-link acceptance, correction rate, and unlinked rate.

- [ ] **Step 1: Build a fixture set**

Include at least:

1. Exact Jira keys.
2. GitHub issue URLs.
3. Multiple tickets in one prompt.
4. Similar wording for different tasks.
5. Follow-up prompts with no ticket key.
6. Unrelated prompts sharing broad nouns.
7. Prompts containing sensitive-looking values that must remain local.

- [ ] **Step 2: Implement the evaluator**

Emit JSON and a human-readable table. Fail if deterministic extraction precision is below the threshold recorded in `docs/work-items-evaluation.md`.

- [ ] **Step 3: Record baseline results**

Run:

```bash
node scripts/evaluate-work-item-grouping.mjs
```

Expected: a versioned baseline that states where automatic grouping is safe and where suggestions are required.

- [ ] **Step 4: Decide whether similarity or AI enrichment earns its place**

Add no enrichment implementation unless the baseline shows a measurable gap that the proposed technique can address without violating the privacy constraints.

- [ ] **Step 5: Commit**

```bash
git add scripts/evaluate-work-item-grouping.mjs docs/work-items-evaluation.md README.md
git commit -m "test: measure work item grouping quality"
```

## Verification checklist

Before opening each pull request:

- [ ] Dedicated feature branch is used.
- [ ] `npx tsc --noEmit` passes.
- [ ] `git diff --check` passes.
- [ ] Isolated verifier passes.
- [ ] Existing dashboard and live-tracer routes still load.
- [ ] Raw trace payloads remain unchanged.
- [ ] Duplicate extraction is idempotent.
- [ ] Invalid API input returns explicit errors.
- [ ] Browser evidence includes the user action and resulting state.
- [ ] No generated artifacts or local databases are committed.

## First recommended slice

Implement Tasks 1 through 5 first. Stop and demo the result before building the workspace UI. That slice delivers reliable ticket detection, durable work items, trace grouping, manual correction, and APIs without introducing model cost or privacy risk.
