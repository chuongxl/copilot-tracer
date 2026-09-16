---
description: "Task list template for feature implementation"
---

# Tasks: OpenCode Host Support

**Input**: Design documents from `/specs/001-opencode-support/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/opencode-hook.md,
quickstart.md

**Tests**: Not included as separate tasks — this repo has no test framework (constitution
Principle IV); manual verification is done via `quickstart.md` at the end of each story, and
`npx tsc --noEmit` gates every task that touches TypeScript.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- File paths are relative to the repository root (this worktree)

## Path Conventions

Single project (existing layout): `src/` at repository root, no `tests/` (no test runner). New
files land as siblings of the existing `claudeHooks.ts` / `claudeSession.ts` / `claudePricing.ts`
trio, per plan.md's Project Structure section.

---

## Phase 1: Setup

- [X] T001 Confirm `npx tsc --noEmit` passes on the current worktree before any change (baseline
  check; repo root `/Users/chuongnd/github-me/copilot-tracer/.worktrees/001-opencode-support`).

---

## Phase 2: Foundational (blocking prerequisites)

No cross-story blocking infrastructure beyond the repo's existing `db.ts` (`ensureProject`,
session/trace persistence) and `types.ts` (`TraceEntry`, `ToolCall`, `TokenUsage`), which already
exist and require no changes (data-model.md). Proceed directly to User Story 1.

---

## Phase 3: User Story 1 - See OpenCode sessions in the dashboard (Priority: P1) 🎯 MVP

**Goal**: OpenCode session/turn/tool-call activity is ingested into the existing
Project → Session → Trace model and appears live in the dashboard.

**Independent Test**: Follow quickstart.md steps 1–4 (simulate an OpenCode session via curl,
verify `/api/traces`, `/api/summary`, and dashboard counts update, and that a re-sent event does
not duplicate the trace/tool call).

- [X] T002 [P] [US1] Add `detectOpenCodeToolType(name: string): ToolCall['type']` in
  `src/openCodeSession.ts` per research.md R6 (builtin/mcp/agent classification for OpenCode's
  tool vocabulary; no new enum value).
- [X] T003 [US1] Implement the `OpenCodeTurnContext` in-memory tracker in
  `src/openCodeSession.ts` (mirrors `ClaudeTurnContext` in `src/claudeSession.ts`): `startTurn`,
  `finishTurn`, `startToolCall`, `finishToolCall`, `registerSession`, `endSession`, keyed on
  `(sessionId, messageId)` for turns and `(messageId, toolCallId)` for tool calls per
  data-model.md, with redelivery treated as an upsert (FR-009).
- [X] T004 [US1] Implement stale-turn expiry in `src/openCodeSession.ts`: a turn with no terminal
  signal (`session.idle`/`session.error`) beyond the existing expiry window used by
  `claudeSession.ts`'s pending-usage cleanup is marked `error` with a timeout reason (FR-011,
  spec Edge Cases).
- [X] T005 [US1] Wire `src/openCodeSession.ts` persistence to the existing `traceEvents`
  `EventEmitter` (imported the same way `proxy.ts`/`otlpReceiver.ts` do) so every turn update
  emits `trace:update`/`trace:done` for the existing Socket.io live-update path (FR-005, research
  R9) — no `web/index.html` changes needed.
- [X] T006 [US1] Resolve project association in `src/openCodeSession.ts`/`src/openCodeHooks.ts`
  via `ensureProject(directory)` from `src/db.ts` (same call `claudeHooks.ts`'s
  `resolveProject()` makes), falling back to the existing fallback/ungrouped project behavior
  when no repository is detected (FR-002, FR-010).
- [X] T007 [US1] Create `src/openCodeHooks.ts` exposing `handleOpenCodeHook(payload)` and
  `registerOpenCodeHookRoutes(app)`, mirroring `src/claudeHooks.ts`: parse the event payload
  shape from contracts/opencode-hook.md, dispatch `session.created` → `registerSession`,
  `message.updated` → `startTurn`/`finishTurn` (with usage forwarded), `tool.execute.before` →
  `startToolCall`, `tool.execute.after` → `finishToolCall`, `session.idle` → `finishTurn`
  (success), `session.error` → `finishTurn` (error); unknown events are ignored (FR-009).
- [X] T008 [US1] In `src/openCodeHooks.ts`, register `POST /opencode/hook` to always respond `204
  No Content` and never throw (catch-and-log per `COPILOT_TRACER_DEBUG`), plus `GET
  /opencode/hook/health` returning hook-delivery diagnostics, matching `/claude/hook`'s exact
  safety contract (contracts/opencode-hook.md); add the malformed-body error-handling middleware
  scoped to `/opencode/hook` the same way `claudeHooks.ts` does for `/claude/hook`.
- [X] T009 [US1] Register `registerOpenCodeHookRoutes(app)` in `src/webServer.ts` alongside the
  existing `registerClaudeHookRoutes(app)` call.
- [X] T010 [US1] Run `npx tsc --noEmit` and fix any type errors introduced by T002–T009.
- [X] T011 [US1] Manually verify per quickstart.md steps 1–4 (simulated OpenCode session via
  curl): dashboard/session counts update, `/api/traces` shows the turn with its `bash` tool call
  classified `builtin`, and a duplicate `message.updated`/`tool.execute.after` resend does not
  create a second trace or tool call.

**Checkpoint**: User Story 1 is independently functional — OpenCode traces are visible and live
in the dashboard without setup automation or accurate pricing yet.

---

## Phase 4: User Story 2 - One-command setup for OpenCode (Priority: P2)

**Goal**: `--setup` detects OpenCode and installs the tracer's plugin automatically, additive to
any existing OpenCode configuration.

**Independent Test**: Follow quickstart.md step 5 — run `--setup --daemon`, confirm the plugin
file is installed (or a clear skip message when OpenCode isn't detected), then run a real
OpenCode session and confirm `/opencode/hook/health` shows received events.

- [X] T012 [P] [US2] Create the plugin template asset at
  `assets/opencode-plugin/copilot-tracer.js`: a JS module exporting a plugin function that
  subscribes to the events in research.md R2 (`session.created`, `message.updated`,
  `tool.execute.before`, `tool.execute.after`, `session.idle`, `session.error`) and POSTs each as
  JSON to `http://localhost:<port>/opencode/hook`, per contracts/opencode-hook.md's request body
  shape; network/POST failures are caught and swallowed so a stopped daemon never affects the
  OpenCode session (spec Edge Cases).
- [X] T013 [US2] In `src/setup.ts`, add OpenCode detection (check for the `opencode` binary on
  `PATH`, same style as the existing Copilot CLI detection) per research.md R8.
- [X] T014 [US2] In `src/setup.ts`, when OpenCode is detected, write
  `assets/opencode-plugin/copilot-tracer.js` (with `<port>` substituted) to
  `~/.config/opencode/plugins/copilot-tracer.js`, creating the directory if absent; never modify
  any other file in that directory or `opencode.json` (FR-007). On a write/permission failure,
  print the specific error and continue the rest of setup rather than aborting (FR-006).
- [X] T015 [US2] In `src/setup.ts`, when OpenCode is not detected, print a clear skip message
  (matching the tone of the existing Claude Code hooks summary) and continue setup without error
  (FR-006).
- [X] T016 [US2] Run `npx tsc --noEmit` and fix any type errors introduced by T013–T015.
- [X] T017 [US2] Manually verify per quickstart.md step 5: run `--setup --daemon`, confirm the
  plugin file exists at `~/.config/opencode/plugins/copilot-tracer.js`, run a real OpenCode
  session, and confirm `/opencode/hook/health` reports `received > 0` and the session appears in
  the dashboard live.

**Checkpoint**: User Story 2 is independently functional — setup is one command, additive, and
safe when OpenCode is absent or its plugin directory is unwritable.

---

## Phase 5: User Story 3 - Accurate cost and credit accounting for OpenCode (Priority: P3)

**Goal**: OpenCode token usage is converted to the same credit/cost figures shown for other
tools, with a safe fallback for unpriced models.

**Independent Test**: Follow quickstart.md step 3 — confirm `/api/traces` for a simulated session
using a known model (e.g. `claude-sonnet-4-6`) reports `aiCredits` matching that model's rate
applied to the reported token counts, and that an unknown model still shows token counts with
zero/unavailable cost.

- [X] T018 [P] [US3] Create `src/openCodePricing.ts` per research.md R7: a per-model USD-per-1K-
  token rate table (reusing/sharing lookups with `src/claudePricing.ts` for Anthropic models,
  plus common OpenAI model rates) and `calcOpenCodeCredits(tokens, model?)`, falling back to zero
  cost for an unrecognized model id (FR-004).
- [X] T019 [US3] Wire `calcOpenCodeCredits` into `src/openCodeSession.ts`'s turn-finalization path
  (`finishTurn`/persist) so every persisted `TraceEntry.aiCredits` for an OpenCode turn reflects
  the reported `usage.model` and token counts (FR-004).
- [X] T020 [US3] Run `npx tsc --noEmit` and fix any type errors introduced by T018–T019.
- [X] T021 [US3] Manually verify per quickstart.md step 3: a simulated turn with a priced model
  shows the expected `aiCredits`, and a turn with an unpriced model id shows token counts with
  zero cost and no error.

**Checkpoint**: All three user stories are independently functional and deliverable.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T022 Run the full regression check from quickstart.md step 6 (`node test-seed.mjs`, `node
  test-claude-hooks.mjs`) and confirm both still pass unchanged (SC-004 — zero regression on
  existing Copilot CLI / Claude Code ingestion).
  > **Note**: `develop` (this feature's base branch) does not yet include the Claude Code hooks
  > integration (`claudeHooks.ts`/`claudeSession.ts`/`claudePricing.ts` — merged separately on
  > `main` via `feature/claude-session-tracing`), so `test-claude-hooks.mjs` does not exist here.
  > Ran `node test-seed.mjs` instead (passed, 4 traces seeded) plus the manual OpenCode
  > verification in quickstart.md steps 1–4. `openCodePricing.ts` and the `openCodeHooks.ts`
  > doc comments were written self-contained (no import from the not-yet-present Claude
  > modules) for this reason.
- [X] T023 Update `AGENTS.md`/`CLAUDE.md`/README references to the supported hosts (Copilot CLI,
  Claude Code) to also mention OpenCode, and document the new `/opencode/hook` and
  `/opencode/hook/health` endpoints alongside the existing Claude hook documentation, per the
  constitution's requirement that documentation accompany new operator-visible endpoints.
- [X] T024 Final `npx tsc --noEmit` clean run across the whole worktree.

---

## Dependencies & Execution Order

- **Setup (Phase 1)** → **Foundational (Phase 2, no-op here)** → **User Story 1 (Phase 3)** →
  **User Story 2 (Phase 4)** and **User Story 3 (Phase 5)** can each start once Phase 3 is done;
  US2 and US3 do not depend on each other and may proceed in parallel.
- Within US1: T002 [P] is independent of T003–T009; T003 must precede T004–T009 (they build on
  the tracker it defines); T007–T008 must precede T009 (route must exist before registering it);
  T010 (typecheck) and T011 (manual verify) come last.
- Within US2: T012 [P] is independent of T013–T015; T013 must precede T014–T015; T016/T017 last.
- Within US3: T018 [P] is independent of T003–T009 (US1) but T019 depends on both T003 (tracker
  exists) and T018 (pricing function exists); T020/T021 last.
- Polish (Phase 6) runs after all selected user stories are complete.

## Parallel Execution Examples

- **Within US1**: T002 (`detectOpenCodeToolType`) can be written in parallel with the start of
  T003, since they touch logically separate functions in the same new file — coordinate merge
  order to avoid file conflicts, or do T002 first as a small independent commit.
- **Across stories once US1 is done**: T012 (plugin asset) and T018 (pricing table) touch
  different new files (`assets/opencode-plugin/copilot-tracer.js` vs `src/openCodePricing.ts`)
  and have no dependency on each other — safe to implement in parallel.

## Implementation Strategy

**MVP first**: Complete Phase 3 (User Story 1) alone and stop there is a legitimate, demoable
increment — OpenCode traces appear in the dashboard (simulated via curl per quickstart.md, or via
a manually-configured plugin) even before `--setup` automation or accurate pricing exist.

**Incremental delivery**: Phase 3 → Phase 4 (setup automation) → Phase 5 (pricing accuracy) →
Phase 6 (polish/regression). Each phase's checkpoint is independently shippable and testable per
its Independent Test above.
