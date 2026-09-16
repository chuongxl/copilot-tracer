# Phase 1 Data Model: Codex CLI Trace Support

No new tables or columns. Codex traces are stored through the **existing** entities in
`src/types.ts` / `src/db.ts`; this document describes how Codex's OTLP data populates them.

## Existing Entities Reused

### Project (`src/types.ts` `Project`)

- Unchanged. `resolveProjectId` picks a project the same way for Codex as for other tools:
  repo-URL attribute → working-directory attribute → default CLI project → none (falls into the
  "unknown project" bucket already handled by the dashboard for other tools with missing repo
  data).

### Session (`sessions` table via `createSession`)

- Unchanged shape. `id` = Codex's own session/conversation identifier (from an OTLP resource or
  event attribute); `project_id` = resolved Project id or null.
- Multiple tools can create sessions with different ids inside the same project without
  collision — satisfies FR-011 (segregation) since ids are tool-owned identifiers, never merged.

### TraceEntry (`src/types.ts` `TraceEntry`)

One `TraceEntry` per Codex turn (one user prompt → one completion cycle), same invariant as other
tools:

| Field | Source (Codex OTLP) | Notes |
|---|---|---|
| `id` | Derived, namespaced `codex:<promptId or traceId>:<phase>` | Mirrors the existing per-tool id-namespacing convention (e.g. `claude:...`) so ids never collide across tools sharing a session/project. |
| `sessionId` | Codex session/conversation id | Same id Session row uses. |
| `dateTime` | Event timestamp attribute, else record time | Existing `nanoToIso` helper reused. |
| `prompt` | `codex.user_prompt` event text | Falls back to a placeholder string (e.g. `[Codex prompt]`) if content capture is disabled/absent, matching existing tools' fallback pattern. |
| `response` | Completion-event text, when Codex reports it | Optional — omitted if Codex doesn't surface response text for a turn. |
| `tokens` | `codex.turn_cost` / usage on `codex.sse_event` | Maps input/output/cached; `reasoning`/`written` default to `0` when Codex doesn't report them (existing `TokenUsage` shape already treats these as optional-in-spirit fields defaulted to 0 elsewhere). |
| `aiCredits` | `calcCodexCredits(tokens, model)` | New pricing module (see research.md Decision 6). |
| `durationMs` | Turn duration attribute when present | `0` if unavailable, matching existing fallback behavior. |
| `toolCalls` | `codex.tool_decision` events for the turn | See ToolCall mapping below. |
| `skillCount` / `agentCount` / `mcpCount` | Derived by `detectToolType` over `toolCalls` | Reuses existing counters/derivation already computed for other tools. |
| `status` | `running` until a completion/turn_cost event closes it, then `done`; `error` if Codex reports a failed turn | Same three-state lifecycle as existing entries. |

### ToolCall (`src/types.ts` `ToolCall`)

| Field | Source | Notes |
|---|---|---|
| `id` | Tool invocation id from `codex.tool_decision`, else generated | Existing `randomUUID()` fallback pattern reused. |
| `name` | Tool/command name Codex reports | e.g. shell command name, patch tool, etc. |
| `type` | `detectToolType(name)`, extended with Codex-specific naming heuristics (e.g. Codex's `apply_patch`/`shell` builtins vs. any MCP-style tool names) | Falls back to `'builtin'` like the existing default. |
| `input` | Tool arguments if Codex's event carries them, else `{}` | Matches existing tools' conservative default when args aren't captured. |
| `startedAt` / `endedAt` / `durationMs` | Event timestamp(s) | `endedAt`/`durationMs` may be `0`/absent if Codex only reports one instant for the decision. |
| `error` | Populated if Codex marks the tool result as failed | Optional, mirrors existing shape. |

## No Schema Migration

Because Codex reuses `projects`/`sessions`/`traces` tables as-is with no new columns, there is no
migration to write, and existing rows for Copilot (and, once merged, Claude) sessions are
unaffected — satisfies Constitution Principle II and SC-004 (no regression to existing tools).
