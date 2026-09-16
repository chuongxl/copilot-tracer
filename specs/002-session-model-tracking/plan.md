# Session Model Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the LLM model name already computed per trace, and surface it per-turn and per-session in the web dashboard and console UI.

**Architecture:** The model string is already extracted at every ingestion point (`proxy.ts`, `otlpReceiver.ts`, `claudeSession.ts`) solely to pick a pricing-table row, then discarded. This plan adds one field to the `TraceEntry`/`SessionSummary` types, one SQLite column with a migration guard, one extra assignment at each existing extraction point, and a display cell/stat in each UI. No new subsystems, no new dependencies.

**Tech Stack:** TypeScript (ESM), better-sqlite3, Express, vanilla JS + Socket.io (web/index.html), chalk + cli-table3 (console UI). No test framework configured — verification is `npx tsc --noEmit`, the repo's existing `test-claude-hooks.mjs` (extended with model assertions), `test-seed.mjs`, and manual curl/UI checks.

**Spec:** [specs/002-session-model-tracking/spec.md](./spec.md)

## Global Constraints

- No new npm dependencies (NFR-1).
- `npx tsc --noEmit` passes with no new errors (NFR-2).
- Diff confined to `src/types.ts`, `src/db.ts`, `src/proxy.ts`, `src/otlpReceiver.ts`, `src/claudeSession.ts`, `web/index.html`, `src/consoleUi.ts` (NFR-3).
- ESM project — no `.js`-extension import changes needed here (no new imports across modules), but any new import must use a `.js` extension per project convention.
- Traces/sessions with no recorded model display `—`, never an error or blank cell (FR-9).
- Single workspace: every task below is `workspace: "."` (this is a single-repo project, no monorepo).

---

### Task 1: Add `model` to the data model

**Files:**
- Modify: `src/types.ts:23-39` (`TraceEntry`), `src/types.ts:41-51` (`SessionSummary`)

**Interfaces:**
- Consumes: nothing (leaf types file).
- Produces: `TraceEntry.model?: string` and `SessionSummary.models: string[]`, consumed by every later task.

- [ ] **Step 1: Add the field to `TraceEntry`**

In `src/types.ts`, add `model?: string;` to the `TraceEntry` interface, directly after `reasoning?: string;`:

```typescript
export interface TraceEntry {
  id: string;
  sessionId: string;
  dateTime: string;
  prompt: string;
  response?: string;
  reasoning?: string;
  model?: string;
  tokens: TokenUsage;
  aiCredits: number;
  durationMs: number;
  toolCalls: ToolCall[];
  skillCount: number;
  agentCount: number;
  mcpCount: number;
  status: 'running' | 'done' | 'error';
  error?: string;
}
```

- [ ] **Step 2: Add the field to `SessionSummary`**

In the same file, add `models: string[];` at the end of the `SessionSummary` interface:

```typescript
export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  totalEntries: number;
  totalTokens: TokenUsage;
  totalCredits: number;
  totalDurationMs: number;
  totalSkillCalls: number;
  totalAgentCalls: number;
  totalMcpCalls: number;
  models: string[];
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: fails — `db.ts` and other files construct `SessionSummary` object literals that are now missing the required `models` field. This confirms the type change took effect; the failures are expected and resolved by Task 2.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add model field to TraceEntry and SessionSummary types"
```

---

### Task 2: Persist `model` in SQLite

**Files:**
- Modify: `src/db.ts:34-57` (schema), `src/db.ts:59-63` (migration block), `src/db.ts:182-217` (`upsertTrace`), `src/db.ts:231-272` (`getSessionSummary`), `src/db.ts:274-299` (`rowToEntry`), `src/db.ts:316-354` (`getProjectSessionSummary`)

**Interfaces:**
- Consumes: `TraceEntry.model?: string`, `SessionSummary.models: string[]` (Task 1).
- Produces: `upsertTrace(entry)` now persists `entry.model`; `getTrace`/`getTraces` (via `rowToEntry`) now return `model`; `getSessionSummary(sessionId)` and `getProjectSessionSummary(projectId)` now return `models: string[]`.

- [ ] **Step 1: Add the column to the `CREATE TABLE` statement**

In `src/db.ts`, inside the `traces` table definition, add `model TEXT,` right after `reasoning TEXT,`:

```typescript
  CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    date_time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    response TEXT,
    reasoning TEXT,
    model TEXT,
    tokens_input INTEGER DEFAULT 0,
```

- [ ] **Step 2: Add the migration guard for existing databases**

Directly after the existing `sessions.project_id` migration line, add:

```typescript
try { db.prepare('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)').run(); } catch {}
try { db.prepare('ALTER TABLE traces ADD COLUMN model TEXT').run(); } catch {}
```

- [ ] **Step 3: Persist `model` in `upsertTrace`**

Add `model` to the column list, the `VALUES` placeholders, and the bound params object:

```typescript
export function upsertTrace(entry: TraceEntry): void {
  db.prepare(`
    INSERT OR REPLACE INTO traces (
      id, session_id, date_time, prompt, response, reasoning, model,
      tokens_input, tokens_output, tokens_cached, tokens_reasoning, tokens_written, tokens_total,
      ai_credits, duration_ms, tool_calls,
      skill_count, agent_count, mcp_count, status, error
    ) VALUES (
      @id, @sessionId, @dateTime, @prompt, @response, @reasoning, @model,
      @tokensInput, @tokensOutput, @tokensCached, @tokensReasoning, @tokensWritten, @tokensTotal,
      @aiCredits, @durationMs, @toolCalls,
      @skillCount, @agentCount, @mcpCount, @status, @error
    )
  `).run({
    id: entry.id,
    sessionId: entry.sessionId,
    dateTime: entry.dateTime,
    prompt: entry.prompt,
    response: entry.response ?? null,
    reasoning: entry.reasoning ?? null,
    model: entry.model ?? null,
    tokensInput: entry.tokens.input,
    tokensOutput: entry.tokens.output,
    tokensCached: entry.tokens.cached,
    tokensReasoning: entry.tokens.reasoning,
    tokensWritten: entry.tokens.written,
    tokensTotal: entry.tokens.total,
    aiCredits: entry.aiCredits,
    durationMs: entry.durationMs,
    toolCalls: JSON.stringify(entry.toolCalls),
    skillCount: entry.skillCount,
    agentCount: entry.agentCount,
    mcpCount: entry.mcpCount,
    status: entry.status,
    error: entry.error ?? null,
  });
}
```

- [ ] **Step 4: Read `model` back in `rowToEntry`**

Add `model: (row.model as string | null) ?? undefined,` right after `reasoning`:

```typescript
function rowToEntry(row: Record<string, unknown>): TraceEntry {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    dateTime: row.date_time as string,
    prompt: row.prompt as string,
    response: row.response as string | undefined,
    reasoning: row.reasoning as string | undefined,
    model: (row.model as string | null) ?? undefined,
    tokens: {
```

- [ ] **Step 5: Add distinct-models query to `getSessionSummary`**

Right after the existing `stats` query/`.get(sessionId)` call, add:

```typescript
  const models = (db.prepare(
    `SELECT DISTINCT model FROM traces WHERE session_id = ? AND model IS NOT NULL AND model != '' ORDER BY model`
  ).all(sessionId) as { model: string }[]).map(r => r.model);
```

Then add `models,` to the object returned at the end of the function (after `totalMcpCalls: stats.mcps || 0,`).

- [ ] **Step 6: Add distinct-models query to `getProjectSessionSummary`**

Right after that function's `stats` query, add:

```typescript
  const models = (db.prepare(
    `SELECT DISTINCT t.model FROM traces t JOIN sessions s ON s.id = t.session_id
     WHERE s.project_id = ? AND t.model IS NOT NULL AND t.model != '' ORDER BY t.model`
  ).all(projectId) as { model: string }[]).map(r => r.model);
```

Then add `models,` to that function's returned object (after `totalMcpCalls: stats.mcps || 0,`).

- [ ] **Step 7: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no errors) — Task 1's type errors are now resolved.

- [ ] **Step 8: Manual smoke check against a throwaway DB**

Run:
```bash
rm -rf /tmp/ct-model-check && mkdir -p /tmp/ct-model-check
COPILOT_TRACER_HOME=/tmp/ct-model-check node --experimental-vm-modules -e "
import('./dist/db.js').then(async (db) => {
  db.createSession('s1');
  db.upsertTrace({ id: 't1', sessionId: 's1', dateTime: new Date().toISOString(), prompt: 'hi', model: 'claude-opus-5', tokens: {input:1,output:1,cached:0,reasoning:0,written:1,total:2}, aiCredits: 0, durationMs: 1, toolCalls: [], skillCount:0, agentCount:0, mcpCount:0, status: 'done' });
  console.log(JSON.stringify(db.getTrace('t1')));
  console.log(JSON.stringify(db.getSessionSummary('s1')));
});
" 2>&1 | tail -5
```
(Run `npx tsc` first if `dist/` is stale.) Expected: the printed trace includes `"model":"claude-opus-5"`, and the summary includes `"models":["claude-opus-5"]`.

- [ ] **Step 9: Commit**

```bash
git add src/db.ts
git commit -m "feat: persist and query trace model in SQLite"
```

---

### Task 3: Capture model in the Copilot ACP proxy path

**Files:**
- Modify: `src/proxy.ts:159-177` (`handleAcpMessage`, `usage_update`/`token_usage` branch)

**Interfaces:**
- Consumes: `TraceEntry.model?: string` (Task 1), `active.entry: TraceEntry` (existing).
- Produces: `active.entry.model` set whenever a `usage_update`/`token_usage` session/update notification carries a model.

- [ ] **Step 1: Set `active.entry.model` next to the existing `model` computation**

In `src/proxy.ts`, inside the `usage_update`/`token_usage` branch, right after `const model = String(update.model ?? update.modelId ?? 'default');`, add:

```typescript
        const model = String(update.model ?? update.modelId ?? 'default');
        active.entry.model = model;
        active.entry.tokens = {
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Manual check via the existing seed/daemon flow**

Run:
```bash
npx tsc
npm run dev -- --daemon --port 4747 &
sleep 1
# Replay a minimal ACP usage_update-shaped session/update over the daemon's normal flow is out of scope
# for a quick manual check (proxy.ts is driven by spawning the real `copilot` CLI, not HTTP) — instead,
# confirm the code path compiles and the field assignment is present:
grep -n "active.entry.model = model" src/proxy.ts
kill %1
```
Expected: the grep prints the added line, confirming the assignment landed at the right spot. (Full end-to-end exercise of the Copilot CLI proxy path requires the real `copilot` binary and is out of scope for this task's verification — Task 6 covers automated end-to-end verification for the Claude/OTLP paths, which `test-claude-hooks.mjs` already drives.)

- [ ] **Step 4: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: capture model on Copilot ACP trace entries"
```

---

### Task 4: Capture model in the OTLP receiver

**Files:**
- Modify: `src/otlpReceiver.ts:347-362` (`claude_code.interaction` entry construction), `src/otlpReceiver.ts:413-425` (`claude_code.llm_request` enrichment of an existing entry), `src/otlpReceiver.ts:629-655` (`chat <model>` span handler — both in-flight and standalone branches)

**Interfaces:**
- Consumes: `TraceEntry.model?: string` (Task 1).
- Produces: `entry.model` / `inf.entry.model` populated on every OTLP-derived `TraceEntry`.

- [ ] **Step 1: Set `model` on the `claude_code.interaction` entry literal**

In `src/otlpReceiver.ts`, in the non-hook-tracked branch that builds the `entry: TraceEntry` object literal for `claude_code.interaction`, add a `model,` property (the `model` variable is already computed above via `getStringAttr(attrs, 'model', 'gen_ai.request.model')`):

```typescript
      const entry: TraceEntry = {
        id: spanId,
        sessionId: claudeSessionId,
        dateTime: nanoToIso(span.startTimeUnixNano),
        prompt: getStringAttr(attrs, 'user_prompt') ?? '[Claude Code interaction]',
        model,
        tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens, reasoning: 0, written: outputTokens, total: inputTokens + outputTokens },
```

- [ ] **Step 2: Set `model` when `claude_code.llm_request` enriches an existing entry**

In the same file, in the `claude_code.llm_request` handler's non-hook-tracked branch (`const entry = claudeInteractionEntries.get(traceId); if (entry) { ... }`), add a guarded assignment before the token update:

```typescript
      const entry = claudeInteractionEntries.get(traceId);
      if (entry) {
        if (model) entry.model = model;
        entry.tokens = {
```

- [ ] **Step 3: Set `model` on the in-flight parent entry in the `chat <model>` span handler**

In the `chat <model>` / `chat` span block, in the `if (inf) { ... }` branch, add a guarded assignment alongside the existing prompt/response backfill:

```typescript
      const inf = inFlight.get(traceId);
      if (inf) {
        // Update parent invoke_agent entry with richer data
        if (!inf.entry.prompt && promptText) inf.entry.prompt = promptText;
        if (!inf.entry.response && responseText) inf.entry.response = responseText;
        if (!inf.entry.model && model) inf.entry.model = model;
```

- [ ] **Step 4: Set `model` on the standalone chat entry literal**

In the `else` branch of the same handler (no parent `invoke_agent`), add `model,` to the `entry: TraceEntry` object literal:

```typescript
        const entry: TraceEntry = {
          id: spanId,
          sessionId,
          dateTime: nanoToIso(span.startTimeUnixNano),
          prompt: promptText || `[LLM call: ${model}]`,
          response: responseText || undefined,
          model,
          tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens, reasoning: 0, written: outputTokens, total: inputTokens + outputTokens },
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/otlpReceiver.ts
git commit -m "feat: capture model on OTLP-derived trace entries"
```

---

### Task 5: Capture model in the Claude hook-tracked session path

**Files:**
- Modify: `src/claudeSession.ts:170-184` (`addUsage`)

**Interfaces:**
- Consumes: `TraceEntry.model?: string` (Task 1), `ClaudeUsageDelta.model?: string` (existing), `ClaudeTurnContext.entry: TraceEntry` / `.model?: string` (existing).
- Produces: `ctx.entry.model` kept in sync with `ctx.model` whenever a usage delta carries a model — this is the field `upsertTrace` (called from `persist()`) will write to SQLite for hook-tracked turns.

- [ ] **Step 1: Set `ctx.entry.model` alongside the existing `ctx.model` assignment**

In `src/claudeSession.ts`, in `addUsage`, change:

```typescript
  if (delta.model) ctx.model = delta.model;
```

to:

```typescript
  if (delta.model) { ctx.model = delta.model; ctx.entry.model = delta.model; }
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/claudeSession.ts
git commit -m "feat: capture model on hook-tracked Claude trace entries"
```

---

### Task 6: Extend the end-to-end verification script with model assertions

**Files:**
- Modify: `test-claude-hooks.mjs` (the `llmRequest` helper already sends a `model` param at line 117-147; the `main()` function's assertions block, and the OTLP-only legacy-session check)

**Interfaces:**
- Consumes: `/api/traces?sessionId=` response shape (existing), now including `model` per FR-4/FR-6.
- Produces: automated confirmation that both the hook-tracked path (Tasks 1, 2, 5) and the OTLP-only fallback path (Tasks 1, 2, 4) persist and return `model`, and that `/api/summary` returns `models`.

- [ ] **Step 1: Read the current script's structure**

Run: `grep -n "function llmRequest\|function check\|async function main" test-claude-hooks.mjs`
Confirm `llmRequest(promptId, input, output, model = 'claude-opus-5', sessionId = SESSION)` already passes `model` in its span attrs (it does, per `attr('model', model)` at line 135) — no change needed there.

- [ ] **Step 2: Add a model assertion after the existing turn-1 checks**

In `main()`, in the block that already runs `check('turn 1 summed both model iterations ...', ...)`, add directly after it:

```javascript
    check('turn 1 recorded the model', t1?.model === 'claude-opus-5', t1?.model);
```

- [ ] **Step 3: Add a model assertion for the legacy OTLP-only session**

In the "Regression guard" section (`legacySession`), after its existing checks against `/api/traces?sessionId=...`, add a fetch + assertion for the model field. Locate the block that posts the legacy span (it already sends `attr('model', 'claude-opus-5')`) and, after the existing legacy assertions, add:

```javascript
    const legacyRes = await fetch(`${BASE}/api/traces?sessionId=${encodeURIComponent(legacySession)}`);
    const legacyTraces = await legacyRes.json();
    check('legacy OTLP-only trace recorded the model', legacyTraces[0]?.model === 'claude-opus-5', legacyTraces[0]?.model);
```

- [ ] **Step 4: Add a summary `models` assertion**

After the existing per-trace checks, add a call against `/api/summary`:

```javascript
    const summaryRes = await fetch(`${BASE}/api/summary?sessionId=${encodeURIComponent(SESSION)}`);
    const summary = await summaryRes.json();
    check('session summary lists the model used', Array.isArray(summary.models) && summary.models.includes('claude-opus-5'), summary.models);
```

- [ ] **Step 5: Run the script and verify all checks pass**

Run: `node test-claude-hooks.mjs`
Expected: every `check(...)` line prints as passing (script convention: exits non-zero and logs a failure marker if any `check` fails — read the existing `check()` helper's output format if unclear, and confirm no new failures appear versus a baseline run before this task's edits).

- [ ] **Step 6: Commit**

```bash
git add test-claude-hooks.mjs
git commit -m "test: assert model is captured across hook and OTLP-only paths"
```

---

### Task 7: Display model in the web dashboard

**Files:**
- Modify: `web/index.html` (stats bar markup, table header markup, `updateSummaryFromTraces()`, `render()` — see exact anchors below)

**Interfaces:**
- Consumes: `TraceEntry.model` and `SessionSummary.models` (Tasks 1-6, already flowing through `/api/traces`, `/api/traces/:id`, `/api/summary`, and Socket.io `trace:update`/`trace:done` payloads — no API changes needed since these endpoints already serialize whatever `TraceEntry`/`SessionSummary` contain).
- Produces: a visible "Model" stat and a "Model" table column.

- [ ] **Step 1: Add a Model stat to the stats bar**

Find the stats bar block (search for `id="s-prompts"`). Add a new stat immediately before it:

```html
      <div class="stat"><span class="stat-label">Model</span><span class="stat-value" id="s-models">—</span></div>
      <div class="stat"><span class="stat-label">Total Prompts</span><span class="stat-value" id="s-prompts">0</span></div>
```

- [ ] **Step 2: Add a Model column header to the trace table**

Find the `<thead>` block (search for `<th>Date / Time</th>`). Add a new header cell after `<th>Prompt</th>`:

```html
              <th>Date / Time</th>
              <th>Prompt</th>
              <th>Model</th>
              <th>Est Cost</th>
```

- [ ] **Step 3: Populate `models` in the live (Socket.io) summary computation**

Find `updateSummaryFromTraces()` (search for `function updateSummaryFromTraces`). Add a `models` field computed from the in-memory `traces` map:

```javascript
  function updateSummaryFromTraces() {
    const arr = Object.values(traces);
    const modelSet = new Set(arr.map(t => t.model).filter(Boolean));
    summary = {
      totalEntries: arr.length,
      totalCredits: arr.reduce((s, t) => s + (t.aiCredits || 0), 0),
      totalTokens: {
        total: arr.reduce((s, t) => s + (t.tokens?.total || 0), 0),
        cached: arr.reduce((s, t) => s + (t.tokens?.cached || 0), 0),
        reasoning: arr.reduce((s, t) => s + (t.tokens?.reasoning || 0), 0),
      },
      totalSkillCalls: arr.reduce((s, t) => s + (t.skillCount || 0), 0),
      totalAgentCalls: arr.reduce((s, t) => s + (t.agentCount || 0), 0),
      totalMcpCalls: arr.reduce((s, t) => s + (t.mcpCount || 0), 0),
      totalDurationMs: arr.reduce((s, t) => s + (t.durationMs || 0), 0),
      models: [...modelSet].sort(),
    };
  }
```

- [ ] **Step 4: Render the Model stat in `render()`**

Find the block that sets `s-prompts`/`s-credits`/etc. text content inside `render()`. Add, right before the `s-prompts` line:

```javascript
      document.getElementById('s-models').textContent = (summary.models && summary.models.length) ? summary.models.join(', ') : '—';
      document.getElementById('s-prompts').textContent = summary.totalEntries;
```

- [ ] **Step 5: Render the Model column in each trace row**

Find the `tbody.innerHTML = arr.map(t => ...)` template. Add a new `<td>` after the prompt cell:

```javascript
        <td class="td-prompt" title="${(t.prompt||'').replace(/"/g,'&quot;')}">${escHtml(truncate(t.prompt||'', 60))}</td>
        <td class="td-model">${escHtml(t.model || '—')}</td>
        <td class="td-credits" onclick="event.stopPropagation(); showCreditDetail('${t.id}')">${fmtCredits(t.aiCredits)}</td>
```

- [ ] **Step 6: Update the empty-state colspan**

Find `tbody.innerHTML = '<tr><td colspan="10" class="empty">...` and bump the colspan by 1 (one new header column added in Step 2):

```javascript
      tbody.innerHTML = '<tr><td colspan="11" class="empty">Waiting for Copilot CLI activity...</td></tr>';
```

- [ ] **Step 7: Manual verification against a seeded DB**

Run:
```bash
npx tsc
node test-seed.mjs
npm run dev -- --ui web --no-proxy --session test-session-001 &
sleep 1
curl -s "http://localhost:4747/api/traces?sessionId=test-session-001" | head -c 500
curl -s "http://localhost:4747/api/summary?sessionId=test-session-001"
kill %1
```
Then open `http://localhost:4747` in a browser (or note that `test-seed.mjs`'s seeded rows predate the `model` column and will show `—`, which is expected per FR-9) and confirm: the "Model" stat and column render without layout breakage, showing `—` for the pre-existing seeded rows.

- [ ] **Step 8: Commit**

```bash
git add web/index.html
git commit -m "feat: show model per-trace and per-session in the web dashboard"
```

---

### Task 8: Display model in the console UI

**Files:**
- Modify: `src/consoleUi.ts:25-83` (`renderConsoleTable`)

**Interfaces:**
- Consumes: `TraceEntry.model` and `SessionSummary.models` (Tasks 1-6).
- Produces: a "Model" column in the console table, populated for both the TOTALS row and each data row.

- [ ] **Step 1: Add a Model column header**

In `renderConsoleTable`, add `chalk.cyan('Model')` to the `head` array (after `'Prompt'`) and a matching width to `colWidths` (e.g. `14`, after the `40` for Prompt):

```typescript
    head: [
      chalk.cyan('Date / Time'),
      chalk.cyan('Prompt'),
      chalk.cyan('Model'),
      chalk.cyan('Est Cost'),
      chalk.cyan('Duration'),
      chalk.cyan('Tokens\nCached|Written|Reason'),
      chalk.cyan('Skills'),
      chalk.cyan('Agents'),
      chalk.cyan('MCPs'),
    ],
    colWidths: [20, 40, 14, 12, 10, 26, 8, 8, 8],
```

- [ ] **Step 2: Show the joined model list in the TOTALS row**

In the `if (summary)` block, insert a new cell (after the prompts-count cell) showing the joined `summary.models`, and update the divider's `colSpan` from `8` to `9`:

```typescript
    table.push([
      chalk.bold.white('TOTALS'),
      chalk.bold.white(`${summary.totalEntries} prompts`),
      chalk.bold.white(summary.models.length ? summary.models.join(', ') : '—'),
      chalk.bold.yellow(fmtCredits(summary.totalCredits)),
      chalk.bold.white(fmtDuration(summary.totalDurationMs)),
      chalk.bold.white(`${t.cached} | ${t.written} | ${t.reasoning}`),
      chalk.bold.magenta(String(summary.totalSkillCalls)),
      chalk.bold.blue(String(summary.totalAgentCalls)),
      chalk.bold.cyan(String(summary.totalMcpCalls)),
    ]);

    // divider
    table.push([{ colSpan: 9, content: chalk.grey('─'.repeat(130)) }]);
```

- [ ] **Step 3: Show the model on each data row**

In the data-row loop, insert a new cell (after the truncated prompt cell):

```typescript
    table.push([
      statusColor(e.status, dt),
      truncate(e.prompt, 38),
      truncate(e.model || '—', 12),
      chalk.yellow(fmtCredits(e.aiCredits)),
      fmtDuration(e.durationMs),
      tokenStr + (tools ? chalk.grey(`\n[${truncate(tools, 22)}]`) : ''),
      chalk.magenta(String(e.skillCount)),
      chalk.blue(String(e.agentCount)),
      chalk.cyan(String(e.mcpCount)),
    ]);
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Manual verification against a seeded DB**

Run:
```bash
npx tsc
node test-seed.mjs
npm run console
```
Confirm the console table renders a "Model" column without breaking layout, showing `—` for the seeded (pre-model) rows. Press Ctrl+C to exit.

- [ ] **Step 6: Commit**

```bash
git add src/consoleUi.ts
git commit -m "feat: show model per-trace and per-session in the console UI"
```

---

### Task 9: Full verification pass

**Files:** none (verification only)

**Interfaces:**
- Consumes: the complete feature from Tasks 1-8.
- Produces: confirmation the feature meets every acceptance criterion in the spec.

- [ ] **Step 1: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Build**

Run: `npx tsc`
Expected: PASS, `dist/` updated

- [ ] **Step 3: Run the end-to-end hook+OTLP verification script**

Run: `node test-claude-hooks.mjs`
Expected: PASS, including the Task 6 model assertions (hook-tracked path, OTLP-only legacy path, and session summary).

- [ ] **Step 4: Re-check each acceptance criterion from the spec**

Walk `specs/002-session-model-tracking/spec.md`'s "Acceptance Criteria" section line by line against the completed tasks:
- Copilot ACP trace records model → Task 3.
- Hook-tracked Claude trace records model → Task 5.
- OTLP-only Claude trace records model → Task 4.
- Session summary lists distinct models, comma-separated, sorted → Task 2 (Step 5) + Task 7 (Step 3) + Task 8 (Step 2).
- Pre-existing trace with no model renders `—` everywhere without breaking aggregation → Task 2 (Step 4, `?? undefined`; Step 5/6, `WHERE model IS NOT NULL`), Task 7 (Step 5), Task 8 (Step 3).

- [ ] **Step 5: Confirm working tree is clean aside from the feature commits**

Run: `git status --porcelain`
Expected: empty (everything committed in Tasks 1-8).
