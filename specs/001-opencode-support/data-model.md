# Data Model: OpenCode Host Support

No new database tables or columns are introduced. OpenCode sessions are represented entirely
through the existing `Project → Session → Trace` SQLite schema (`src/db.ts`) and the existing
TypeScript shapes in `src/types.ts`. This document describes how OpenCode's own concepts map onto
those existing entities, plus the small amount of new in-memory state needed to track an
in-progress OpenCode turn before it is persisted (mirroring `claudeSession.ts`'s
`ClaudeTurnContext`).

## Entity Mapping

### OpenCode Session → `Project` + session id

- **Source**: OpenCode plugin's `session.created` event (`session.id`) plus the plugin context's
  `directory`/`worktree`.
- **Maps to**: the existing `Session` grouping key already used by every trace (see
  `SessionSummary.sessionId` in `types.ts`) and a `Project` row resolved via `ensureProject(cwd)`
  (`src/db.ts`), the same function Claude Code hooks call.
- **New field**: none on the schema; the OpenCode session id is used directly as the tracer's
  `sessionId` value, the same convention Claude Code hooks already follow with Claude's own
  session id.
- **Identity/uniqueness**: `session.id` from OpenCode is assumed globally unique per session
  (OpenCode-generated); no additional uniqueness logic needed beyond SQLite's existing primary
  key on `sessionId`.

### OpenCode Turn → `TraceEntry`

- **Source**: one `message.updated` event carrying an assistant response (plus any usage data),
  bounded by the surrounding `session.idle` (success) or `session.error` (failure) signal.
- **Maps to**: one `TraceEntry` row (`prompt`, `response`, `tokens`, `aiCredits`, `durationMs`,
  `toolCalls`, `status`, `error` — all existing fields, no new ones required).
- **Identity/uniqueness (idempotency key, per spec Clarifications)**: `(opencode_session_id,
  message_id)`. A turn is looked up/created by this composite key; a redelivered event for the
  same key updates the existing in-memory/persisted row rather than creating a new one.
- **Lifecycle/state transitions**:
  `running` (turn opened on first `message.updated`/tool activity for a new message id) →
  `done` (on `session.idle` with no error) | `error` (on `session.error` for that message, or a
  hook-side failure to parse the payload safely).
- **Validation rules**: `prompt`/`response` retained verbatim when present (Principle I); `tokens`
  defaults to a zeroed `TokenUsage` if OpenCode's payload omits usage data for that message (R2
  follow-up), never fabricated.

### OpenCode Tool Call → `ToolCall`

- **Source**: `tool.execute.before` (start: tool name, args) and `tool.execute.after` (finish:
  result or error) events, correlated by the tool invocation's own identifier.
- **Maps to**: one `ToolCall` entry (existing shape: `id`, `name`, `type`, `input`, `output`,
  `error`, `startedAt`, `endedAt`, `durationMs`) nested under its parent `TraceEntry.toolCalls`.
- **Identity/uniqueness**: `(message_id, tool_call_id)` — a tool call belongs to exactly one turn
  and is keyed within it the same way Claude's `toolKey(toolUseId, name, input)` disambiguates
  concurrent/duplicate tool events (`claudeSession.ts`).
- **Type classification**: `type` set via `detectOpenCodeToolType(name)` (R6) using the existing
  `'mcp' | 'skill' | 'agent' | 'builtin'` enum from `types.ts` — no new enum value.

## New In-Memory State (not persisted as new tables)

### `OpenCodeTurnContext` (mirrors `ClaudeTurnContext` in `claudeSession.ts`)

In-memory record tracked per `(sessionId, messageId)` while a turn is open, holding:

- `sessionId`, `messageId` (the idempotency key components)
- `projectId` (resolved once via `ensureProject`)
- accumulated `tokens: TokenUsage`
- accumulated `toolCalls: ToolCall[]`
- `startedAt` timestamp for `durationMs` computation
- current `status`

Flushed to the existing `TraceEntry` persistence path (`db.ts`) on every update (matching
`claudeSession.ts`'s `persist()` pattern) so a crash mid-turn still leaves the latest known state
visible in the dashboard, addressing the spec's "partial trace should remain visible" edge case.

## Relationships

```text
Project (existing) 1 ── * Session (existing, keyed by OpenCode session.id)
Session            1 ── * TraceEntry (existing, keyed by (session.id, message.id))
TraceEntry         1 ── * ToolCall  (existing, keyed by (message.id, tool_call_id))
```

No relationship changes: OpenCode traces live alongside Copilot CLI and Claude Code traces under
the same three-level hierarchy, distinguishable only by the tool-agnostic data already present
(no new "source tool" column is required for this feature's scope — traces are visually
indistinguishable by host tool in the dashboard today, consistent with existing Claude Code
traces, and this feature does not change that).
