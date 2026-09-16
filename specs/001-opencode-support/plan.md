# Implementation Plan: OpenCode Host Support

**Branch**: `001-opencode-support` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-opencode-support/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add OpenCode as a third traced host alongside Copilot CLI and Claude Code. OpenCode has no native
OTLP export, so the tracer adds a small OpenCode plugin (installed via `--setup`) that posts
session/message/tool lifecycle events to a new `POST /opencode/hook` endpoint on the existing
Express daemon. A new `openCodeSession.ts` module (mirroring `claudeSession.ts`) tracks turns and
tool calls in-memory, persists them through the existing `Project → Session → Trace` SQLite model,
computes credits via a new `openCodePricing.ts` table, and emits on the existing `traceEvents` bus
so the dashboard updates live with no client-side changes.

## Technical Context

**Language/Version**: TypeScript (Node.js ESM), Node.js >=18

**Primary Dependencies**: Express (HTTP routes), better-sqlite3 (persistence), Socket.io (live
updates via existing `traceEvents` bus) — no new runtime dependencies required

**Storage**: SQLite at `~/.copilot-tracer/traces.db`, existing `Project → Session → Trace` schema
(no schema changes required; OpenCode sessions reuse existing tables)

**Testing**: No test framework in this repo (constitution Principle IV); manual verification via
`node test-seed.mjs`-style seeding plus `npm run dev -- --daemon --port 4747` and `curl` against
`/opencode/hook` and `/api/dashboard`, per quickstart.md

**Target Platform**: Local developer machine (macOS/Linux/Windows), daemon mode (`--daemon`)

**Project Type**: Single Node.js CLI + local web dashboard (existing `src/` layout; no
frontend/backend split)

**Performance Goals**: Hook handling must not add perceptible latency to the developer's OpenCode
session (matches Claude hook's fire-and-forget, always-`204` contract); dashboard update within a
few seconds of a turn completing (SC-001)

**Constraints**: Hook receiver MUST always respond `204 No Content` and MUST NOT throw
uncaught, mirroring `/claude/hook`'s safety contract, so a malformed OpenCode payload can never
block or alter the user's OpenCode session

**Scale/Scope**: Single-user, single-machine, local-only telemetry; no multi-tenant or remote
ingestion (out of scope per spec Assumptions)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Observable Data Integrity | New OpenCode ingestion path retains prompt/response content, token usage, tool calls, durations, project identity, timestamps; credits computed via documented rate table, never fabricated (R7, FR-004) | PASS |
| II. Safe, Persistent Storage | Reuses existing SQLite `Project → Session → Trace` schema and `ensureProject`/session APIs; no new tables, no unsafe interpolation, no migration needed | PASS |
| III. Explicit Interfaces and Compatibility | Adds one new HTTP route (`POST /opencode/hook`) and one setup step; does not change any existing CLI flag, route, JSON shape, Socket.io event, or exported type; reuses the existing `ToolCall['type']` enum (R6) rather than adding a new category | PASS |
| IV. Verification Before Delivery | `npx tsc --noEmit` required before delivery; manual verification path defined in quickstart.md (seed-equivalent script + daemon + curl) since no test runner exists | PASS |
| V. Minimal, Observable Operations | Reuses existing daemon/Express/Socket.io/better-sqlite3 conventions; no new dependency; hook receiver bounded and always-204, matching the existing Claude hook pattern; feature is purely additive when OpenCode is absent (FR-008) | PASS |

No violations identified; Complexity Tracking table is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-opencode-support/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── opencode-hook.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
# Single project (existing layout — this feature extends it, no new top-level dirs)
src/
├── openCodeHooks.ts      # NEW — POST /opencode/hook route + registerOpenCodeHookRoutes(app), mirrors claudeHooks.ts
├── openCodeSession.ts    # NEW — in-memory turn/tool-call tracker + persistence, mirrors claudeSession.ts
├── openCodePricing.ts    # NEW — per-model USD/1K-token rate table + calcOpenCodeCredits(), mirrors claudePricing.ts
├── setup.ts              # MODIFIED — detect `opencode` binary, install global plugin file, print setup summary
├── webServer.ts           # MODIFIED — call registerOpenCodeHookRoutes(app) alongside registerClaudeHookRoutes(app)
├── db.ts                  # UNCHANGED — ensureProject/session/trace persistence reused as-is
├── types.ts                # UNCHANGED — existing TraceEntry/ToolCall/TokenUsage types reused as-is
└── proxy.ts, otlpReceiver.ts, claudeHooks.ts, claudeSession.ts, claudePricing.ts, cli.ts,
    consoleUi.ts  # UNCHANGED

assets/ (new, written by setup, not compiled)
└── opencode-plugin/copilot-tracer.js   # NEW — the plugin file template setup.ts copies to
                                          # ~/.config/opencode/plugins/copilot-tracer.js

web/index.html            # UNCHANGED — existing tool-agnostic trace rendering already handles
                            # any TraceEntry regardless of source tool
```

**Structure Decision**: Single-project Node.js layout (matches the existing repo — there is no
frontend/backend split to choose between). New capability is added as three new sibling modules
under `src/` that mirror the existing Claude Code hook/session/pricing trio module-for-module,
plus one new static plugin-template asset that `setup.ts` installs on the developer's machine.
No existing file is restructured; `setup.ts` and `webServer.ts` gain small, additive call sites.

## Complexity Tracking

> Not applicable — no Constitution Check violations.
