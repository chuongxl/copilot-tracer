# Implementation Plan: Codex CLI Trace Support

**Branch**: `002-codex-cli-support` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-codex-cli-support/spec.md`

## Summary

Add OpenAI Codex CLI as a third traced tool alongside GitHub Copilot CLI, by parsing the
`codex.*` OTLP log events Codex's own `codex-otel` telemetry crate emits (`codex.user_prompt`,
`codex.tool_decision`, `codex.turn_cost`, `codex.conversation_starts`, token usage on
`codex.sse_event`) into the existing `Project → Session → Trace` model, wiring a new `/v1/logs`
OTLP route in the daemon, and extending `--setup` to write/detect the `[otel]` OTLP-exporter block
Codex requires in `~/.codex/config.toml` (Codex ignores the `OTEL_EXPORTER_OTLP_*` env vars other
tools use). Cost uses a new OpenAI per-model rate table mirroring the existing rate-table pattern.

**Base-branch note**: this feature branches from `develop`, whose `src/otlpReceiver.ts` currently
has no `/v1/logs` route and no Claude Code parsing path yet (that work lives only on an
unmerged branch). Codex support is therefore implemented as its own self-contained ingestion path
— the general shape (log-record event dispatch, source-tagged trace ids, per-tool pricing module)
follows the pattern used by the project's existing Copilot span parser, not a not-yet-present
Claude code path.

## Technical Context

**Language/Version**: TypeScript 5.4, Node.js 18+ (ESM, `"type": "module"`)

**Primary Dependencies**: Express (existing OTLP HTTP routes), better-sqlite3 (existing storage),
Socket.io (existing live updates) — no new runtime dependency required.

**Storage**: SQLite at `~/.copilot-tracer/traces.db` via existing `src/db.ts` helpers; no schema
change (Codex traces reuse the existing `TraceEntry`/`Session`/`Project` tables, distinguished by
an id-namespace convention, matching how other non-Copilot sources are kept distinguishable).

**Testing**: No test framework in this repo. Manual verification via a new `test-codex-otlp.mjs`
script (modeled on `test-claude-hooks.mjs`'s self-contained daemon+HTTP approach) plus
`test-seed.mjs` regression check and `curl` against `/api/dashboard` / `/api/traces`.

**Target Platform**: Same as existing project — local developer machine, macOS/Linux, Node.js CLI
+ local web dashboard.

**Project Type**: Single project (existing `src/` CLI + daemon + web UI structure).

**Performance Goals**: Matches existing OTLP ingestion — synchronous per-batch parsing of small
JSON payloads (well under existing dashboard query bounds); no new perf target introduced.

**Constraints**: Must not regress existing Copilot CLI OTLP parsing (`processSpans`) or the
`/v1/traces` route; must not crash the daemon on an unrecognized Codex event/attribute (FR-010);
`--setup`'s TOML edit must be text-surgical (add/detect a single `[otel]` block) without a new
TOML-parsing dependency, mirroring the existing shell-profile sentinel-comment-block approach.

**Scale/Scope**: One new OTLP log-event source, one new pricing module, one new setup step; no UI
changes required (existing dashboard/trace views are tool-agnostic).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Observable Data Integrity** — PASS. Codex parser retains prompt/response text, token
  usage, tool calls, timestamps, and project identity when present in Codex's OTLP payload;
  unrecognized events are skipped, never replaced with fabricated data (FR-010).
- **II. Safe, Persistent Storage** — PASS. Reuses existing `Project → Session → Trace` tables
  and parameterized `better-sqlite3` statements in `db.ts`; no schema migration needed.
- **III. Explicit Interfaces and Compatibility** — PASS. Adds a new `/v1/logs` OTLP route
  (additive) and does not change `/v1/traces` behavior for existing Copilot payloads; new
  `--setup` behavior is additive and skippable when Codex isn't installed.
- **IV. Verification Before Delivery** — PASS. Plan requires `npx tsc --noEmit`, `test-seed.mjs`
  regression, and a new manual Codex OTLP verification script before delivery.
- **V. Minimal, Observable Operations** — PASS. Scope stays within tracing/setup; no new runtime
  dependency; ingestion stays synchronous and bounded like the existing paths; errors surface via
  existing `console.error`/HTTP 400 pattern in `otlpReceiver.ts`.
- **Data locality constraint** — PASS. Codex's OTLP payload is received locally by the existing
  daemon exactly like Copilot's; nothing is sent externally; no new telemetry is added to the
  product itself.

No violations. Complexity Tracking table is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-codex-cli-support/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/            # Phase 1 output (OTLP event contract + config.toml contract)
└── tasks.md              # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
src/
├── otlpReceiver.ts     # + processCodexLogs/processCodexLogRecord, /v1/logs route wiring,
│                         detectToolType extension for Codex tool names, workingDir detection
│                         extension for Codex's working-directory attribute
├── codexPricing.ts     # NEW — OpenAI per-model USD/1K-token rate table + calcCodexCredits(),
│                         mirrors the existing claudePricing.ts module shape
├── setup.ts            # + detectCodexCli(), Codex config.toml [otel] block detection/patch
├── types.ts            # unchanged (Codex traces reuse existing TraceEntry/ToolCall shapes)
└── db.ts               # unchanged (no schema change)

test-codex-otlp.mjs      # NEW — manual verification script (self-contained daemon + OTLP POSTs)
AGENTS.md / CLAUDE.md     # + Codex ingestion path documented alongside Copilot/Claude paths
```

**Structure Decision**: Single-project layout (matches existing repo). All new code lives beside
its closest existing analog: OTLP parsing in `otlpReceiver.ts`, pricing in a new sibling module to
`claudePricing.ts`, and setup detection/patching alongside the existing `detectCopilotCli`/
`patchShellProfile` functions in `setup.ts`. No `workspace` partitioning needed — this is a
single-repo project (`repo_map: { ".": "root", "inferred": true }`, no `architecture.md` present).

## Complexity Tracking

*No violations — table omitted.*
