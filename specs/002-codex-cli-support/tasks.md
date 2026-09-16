# Tasks: Codex CLI Trace Support

**Input**: Design documents from `/specs/002-codex-cli-support/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: No test framework exists in this repo (per constitution/AGENTS.md); verification is via
manual scripts (`test-codex-otlp.mjs`, `test-seed.mjs`, `curl`), included as tasks below rather
than as a separate "Tests" subsection.

**Organization**: Tasks are grouped by user story (US1/US2/US3 from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Single project layout — all paths are relative to the repository root.

---

## Phase 1: Setup

**Purpose**: Scaffold the new files this feature adds, before any behavior is implemented.

- [ ] T001 [P] Create `src/codexPricing.ts` with the module header comment only (mirrors
      `src/claudePricing.ts`'s header), no rate table yet — placeholder for Phase 5 (US3).
- [ ] T002 [P] Create `test-codex-otlp.mjs` at the repo root with a self-contained daemon-bootstrap
      harness modeled on `test-claude-hooks.mjs` (spawn/point at a throwaway
      `COPILOT_TRACER_HOME`, start `--daemon`, expose a small `POST` helper) but no payload
      assertions yet — placeholder for Phase 3 (US1).

**Checkpoint**: New files exist; nothing else changes yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared parsing/detection helpers that every later phase's Codex handling depends on.

**⚠️ CRITICAL**: Complete before starting any user story phase.

- [ ] T003 Extend `detectWorkingDir()` in `src/otlpReceiver.ts` to also recognize Codex's
      working-directory resource attribute key (per data-model.md Project mapping), alongside the
      existing `process.working_directory` / `github.copilot.working_dir` /
      `claude_code.working_dir` keys.
- [ ] T004 Extend `detectToolType()` in `src/otlpReceiver.ts` with Codex-specific tool-name
      heuristics (e.g. `apply_patch`, `shell`/`exec`-style builtins vs. any MCP-style Codex tool
      name) per data-model.md's ToolCall mapping, without changing existing Copilot/Claude
      classification outcomes.
- [ ] T005 Add a `POST /v1/logs` route registration inside `registerOtlpRoutes()` in
      `src/otlpReceiver.ts` (the route does not exist yet on this branch) that will dispatch to
      `processCodexLogs()`, returning `200 { partialSuccess: {} }` on a parseable batch and
      `400 { error: "invalid payload" }` only when the top-level payload isn't parseable, per
      `contracts/otlp-logs-codex.md`. Stub `processCodexLogs()` as a no-op for now.

**Checkpoint**: Shared helpers and the `/v1/logs` route exist; ready for US1 to fill in real
Codex event handling.

---

## Phase 3: User Story 1 - See Codex sessions in the dashboard (Priority: P1) 🎯 MVP

**Goal**: A Codex session (prompt + at least one tool call) sent over `/v1/logs` produces a
Project/Session/Trace visible via `/api/dashboard` and `/api/traces`.

**Independent Test**: Run `quickstart.md` steps 1–3 — POST a synthetic Codex OTLP log batch and
confirm the project/session/trace appear with correct tool calls and token usage.

### Implementation for User Story 1

- [ ] T006 [US1] Implement `codexEventId(record, attrs, eventName)` in `src/otlpReceiver.ts`
      (mirrors `claudeEventId()`'s shape) to derive a `codex:`-namespaced trace/entry id from the
      event's prompt/turn/tool identifier attributes.
- [ ] T007 [US1] Implement `processCodexLogRecord(record, resourceAttrs, sessionId, projectId,
      workingDir)` in `src/otlpReceiver.ts` handling `codex.conversation_starts` (ensure
      Session/Project via `ensureSession`/`resolveProjectId`) and `codex.user_prompt` (open a
      running `TraceEntry` per data-model.md's TraceEntry mapping).
- [ ] T008 [US1] Extend `processCodexLogRecord()` to handle `codex.tool_decision`, appending a
      `ToolCall` (using `detectToolType()` from T004) to the current turn's `TraceEntry`.
- [ ] T009 [US1] Extend `processCodexLogRecord()` to handle `codex.turn_cost` and
      `codex.sse_event`, attaching token usage to the `TraceEntry` and closing the turn
      (`status: 'done'`), per data-model.md's TokenUsage mapping. Leave `aiCredits` computation as
      a `0`/placeholder call site for Phase 5 (US3) to fill in.
- [ ] T010 [US1] Implement `processCodexLogs(payload, defaultSessionId, projectId)` in
      `src/otlpReceiver.ts` (mirrors `processClaudeLogs()`'s shape): iterate `resourceLogs` →
      `scopeLogs` → `logRecords`, resolve `sessionId`/`workingDir` from resource attributes, and
      call `processCodexLogRecord()` per record. Wire this into the `/v1/logs` route from T005
      (replacing its no-op stub). Each state-changing branch in T007–T009 MUST call
      `traceEvents.emit('trace:update', entry)` (and `'trace:done'` on completion), the same
      existing pattern used by `processClaudeLogRecord`, so the live dashboard/session view
      updates in real time for Codex traces (FR-007).
- [ ] T011 [US1] In `processCodexLogRecord()`, return early (no-op, no throw) for any
      `event.name` that isn't a recognized `codex.*` event, satisfying FR-010/SC-005.
- [ ] T012 [US1] Fill in `test-codex-otlp.mjs` (from T002) with a synthetic `resourceLogs` batch
      (`codex.conversation_starts` → `codex.user_prompt` → `codex.tool_decision` →
      `codex.turn_cost`, one session id + working-dir attribute) and assertions per
      `quickstart.md` steps 2–3 (project/session/trace/tool-call/token checks).
- [ ] T013 [US1] Update `AGENTS.md` and `CLAUDE.md` architecture sections to document the new
      Codex OTLP ingestion path (`processCodexLogs`/`processCodexLogRecord`, `/v1/logs` route)
      alongside the existing Copilot CLI description.

**Checkpoint**: User Story 1 is independently functional — Codex sessions appear in the dashboard.

---

## Phase 4: User Story 2 - One-command setup for Codex telemetry (Priority: P2)

**Goal**: `--setup` detects Codex CLI and configures `~/.codex/config.toml`'s `[otel]` block
without disturbing unrelated content, per `contracts/codex-config-toml.md`.

**Independent Test**: Run `quickstart.md` step 6 against a local Codex CLI install (or a stubbed
`~/.codex/config.toml`) and confirm each of the five documented file states behaves as specified.

### Implementation for User Story 2

- [ ] T014 [P] [US2] Implement `detectCodexCli()` in `src/setup.ts` (mirrors
      `detectCopilotCli()`'s `which`/`--version` shape).
- [ ] T015 [US2] Implement `codexConfigPath()` and a read helper for `~/.codex/config.toml` in
      `src/setup.ts`, creating the `~/.codex/` directory/file when absent.
- [ ] T016 [US2] Implement `patchCodexConfig(configPath, port)` in `src/setup.ts` following the
      sentinel-comment-block detect/append/update-port logic already used by
      `patchShellProfile()`, plus the non-sentinel-`[otel]`-table conflict check (warn, don't
      overwrite) required by FR-009 / `contracts/codex-config-toml.md`.
- [ ] T017 [US2] Wire `detectCodexCli()` + `patchCodexConfig()` into `runSetup()` in
      `src/setup.ts`, printing a status line for each of the five documented states (skip when not
      installed; added/updated/already-set/warn-on-conflict when installed), consistent with the
      existing Copilot/VS Code status output style.
- [ ] T018 [US2] Manually verify (quickstart.md step 6): run `--setup` against each of the five
      `~/.codex/config.toml` states from `contracts/codex-config-toml.md` and confirm the correct
      outcome and console message for each.

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 - Accurate Codex cost estimates (Priority: P3)

**Goal**: Codex trace `aiCredits` reflect real OpenAI/Codex per-model token pricing, with a
documented default for unrecognized models.

**Independent Test**: Run `quickstart.md` step 3 assertions plus a rate-table cross-check —
compute the expected cost by hand for a known model/token count and confirm the displayed
`aiCredits` is within 1% (SC-003).

### Implementation for User Story 3

- [ ] T019 [P] [US3] Fill in `src/codexPricing.ts` (from T001) with an OpenAI/Codex per-model
      USD-per-1K-token rate table (`Record<string, {input; output}>`) including a `default` entry,
      mirroring `claudePricing.ts`'s table shape.
- [ ] T020 [US3] Implement `calcCodexCredits(tokens, model)` in `src/codexPricing.ts` (mirrors
      `calcClaudeCredits()`'s USD→credits conversion), matching on model-name substring with
      fallback to `default` (depends on T019).
- [ ] T021 [US3] Wire `calcCodexCredits()` into the `codex.turn_cost` handling added in T009 of
      `processCodexLogRecord()` (`src/otlpReceiver.ts`), replacing the placeholder `aiCredits`
      value (depends on T009, T020).
- [ ] T022 [US3] Extend `test-codex-otlp.mjs`'s assertions (from T012) to check the returned
      `aiCredits` for the synthetic payload's model/token counts matches a hand-computed value
      within 1% (SC-003).

**Checkpoint**: All three user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Verification and documentation required by the constitution's quality gates before
delivery.

- [ ] T023 Run `npx tsc --noEmit` from the repository root and fix any type errors introduced by
      T001–T022.
- [ ] T024 Run `node test-seed.mjs` then start the daemon and `curl http://localhost:4747/api/dashboard`
      to confirm existing (pre-Codex) Copilot CLI traces and totals are unchanged (SC-004).
- [ ] T025 [P] Run `quickstart.md` step 5 (unknown-event resilience check): send a batch containing
      one unrecognized `codex.*` event alongside a recognized one and confirm the daemon keeps
      responding and the recognized event is still recorded (SC-005).
- [ ] T026 [P] Update `README.md`'s CLI flags/architecture section (if it documents the OTLP
      receiver or `--setup` behavior) to mention Codex CLI as a supported tool.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (T003–T005 touch the same
  shared functions/route that every story's tasks build on).
- **User Stories (Phase 3+)**: All depend on Foundational (Phase 2) completion.
  - US1 (Phase 3) has no dependency on US2/US3.
  - US2 (Phase 4) has no dependency on US1/US3 (setup detection/patching is independent of
    ingestion logic).
  - US3 (Phase 5) depends on US1's T009 (the `codex.turn_cost` handler it wires into) but not on
    US2.
- **Polish (Phase 6)**: Depends on all desired user stories being complete (T024 specifically
  needs US1's ingestion path to exist to be a meaningful regression check).

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational — no dependency on US2/US3.
- **User Story 2 (P2)**: Can start after Foundational — independently testable without US1/US3.
- **User Story 3 (P3)**: Can start after Foundational, but its T021 requires US1's T009 to exist
  first (same file/function); otherwise independent of US2.

### Within Each User Story

- Shared/detection tasks before record-handling tasks before batch-dispatcher tasks.
- Verification task last within each story.

### Parallel Opportunities

- T001 and T002 (Phase 1) run in parallel.
- T014 (Phase 4) can start in parallel with any Phase 3 (US1) task once Foundational is done — it
  touches only `src/setup.ts`.
- T019 (Phase 5) can start in parallel with Phase 3/4 work — it touches only the new
  `src/codexPricing.ts` file — but T021 must wait for T009 and T020.
- T025 and T026 (Phase 6) run in parallel with each other (different concerns, no shared files).

---

## Parallel Example: Foundational + early User Story work

```bash
# After Phase 2 completes, these can run in parallel (different files):
Task: "Implement detectCodexCli() in src/setup.ts"                          # T014 (US2)
Task: "Fill in src/codexPricing.ts with the OpenAI/Codex rate table"        # T019 (US3)
Task: "Implement codexEventId() in src/otlpReceiver.ts"                     # T006 (US1)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002).
2. Complete Phase 2: Foundational (T003–T005) — CRITICAL, blocks all stories.
3. Complete Phase 3: User Story 1 (T006–T013).
4. **STOP and VALIDATE**: run `quickstart.md` steps 1–3 independently.
5. Codex sessions now appear in the dashboard with `aiCredits: 0` (T009's placeholder) until US3
   lands — acceptable as an MVP increment since cost accuracy is P3, not P1.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add User Story 1 → validate via `quickstart.md` steps 1–3 → Codex sessions visible (MVP).
3. Add User Story 2 → validate via `quickstart.md` step 6 → one-command Codex setup works.
4. Add User Story 3 → validate via `quickstart.md` step 3's cost assertion → accurate cost shown.
5. Phase 6 polish → `npx tsc --noEmit`, regression check, resilience check, docs.

---

## Notes

- [P] tasks touch different files or independent parts of the same file with no shared state.
- [Story] labels map every user-story-phase task to US1/US2/US3 for traceability back to spec.md.
- No test framework exists in this repo; "tests" here are the manual scripts/`curl` checks the
  constitution requires (`test-codex-otlp.mjs`, `test-seed.mjs` regression, `quickstart.md`).
- Commit after each task or logical group.
- Stop at any checkpoint to validate a story independently before continuing.
