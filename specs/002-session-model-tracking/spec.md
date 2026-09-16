# Spec: Collect and display the model(s) used in a session

## Problem

Every ingestion path (`src/proxy.ts` Copilot ACP handling, `src/otlpReceiver.ts` OTLP spans,
`src/claudeSession.ts` Claude hook enrichment) already parses the LLM model name per turn, but only
uses it transiently to select a pricing-table row (`CREDITS_PER_1K` / `ANTHROPIC_USD_PER_1K`), then
discards it. The model is never persisted to a `TraceEntry`, never stored in SQLite, and never
shown in either UI (web dashboard or console).

## Goal

Persist the model used per trace, and surface it:
- Per-turn, in the trace list (web + console UI).
- Per-session, as the distinct set of models used across all turns in that session (web + console
  UI summary).

## Non-goals

- No new pricing logic — the pricing tables already key off `model`; this only adds
  persistence/display of the value they already use.
- No backfill of historical rows — existing traces without a model show as unknown (`—`).
- No new dependencies.

## Functional Requirements

- **FR-1**: `TraceEntry` gains an optional `model: string` field.
- **FR-2**: `SessionSummary` gains a `models: string[]` field — the distinct, sorted list of
  non-empty models used by traces in that session (or project, for the project-level summary).
- **FR-3**: The `traces` SQLite table gains a `model TEXT` column, added both to the `CREATE TABLE`
  statement (new databases) and via an `ALTER TABLE ... ADD COLUMN` migration guard (existing
  databases), matching the existing migration pattern in `src/db.ts`.
- **FR-4**: `upsertTrace` persists `entry.model` (nullable); `rowToEntry` reads it back.
- **FR-5**: `getSessionSummary` and `getProjectSessionSummary` each compute `models` via a
  `SELECT DISTINCT model ... WHERE model IS NOT NULL AND model != ''` query scoped the same way as
  their existing aggregate query (by `session_id` / by `project_id` join).
- **FR-6**: `entry.model` is populated at each existing point where `model` is already computed:
  - `src/proxy.ts`: the `usage_update`/`token_usage` branch of `handleAcpMessage`.
  - `src/otlpReceiver.ts`: the `claude_code.interaction` entry construction, the
    `claude_code.llm_request` enrichment of an existing entry, and both branches of the
    `chat <model>` span handler (in-flight parent entry and standalone entry).
  - `src/claudeSession.ts`: `addUsage`, alongside the existing `ctx.model = delta.model` write.
- **FR-7**: `web/index.html` shows a "Model" column in the live trace table (per-turn) and a
  "Model" stat in the summary bar showing the session's distinct models, comma-separated (or `—`
  if none recorded). Both the initial `/api/summary` load path and the live
  `updateSummaryFromTraces()` (Socket.io) path compute this consistently.
- **FR-8**: `src/consoleUi.ts` shows a "Model" column per data row in `renderConsoleTable`, and the
  TOTALS row shows the joined `summary.models` list.
- **FR-9**: Traces/sessions with no recorded model display `—`, not an error or blank cell.

## Non-Functional Requirements

- **NFR-1**: No new npm dependencies.
- **NFR-2**: `npx tsc --noEmit` passes with no new errors.
- **NFR-3**: Diff stays confined to `src/types.ts`, `src/db.ts`, `src/proxy.ts`,
  `src/otlpReceiver.ts`, `src/claudeSession.ts`, `web/index.html`, `src/consoleUi.ts`.

## Acceptance Criteria

- A Copilot CLI trace (via `proxy.ts`) records its model and it appears in both the web trace row
  and the console row.
- A Claude Code trace (hook-tracked, via `claudeSession.ts` + OTLP enrichment) records its model.
- A Claude Code trace (OTLP-only fallback path, via `otlpReceiver.ts`) records its model.
- A session summary (`/api/summary`, console TOTALS row) lists every distinct model used across
  that session's traces, comma-separated, sorted.
- A pre-existing trace row with no `model` column value renders `—` everywhere, without breaking
  the summary aggregation.
