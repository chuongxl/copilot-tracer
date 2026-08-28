# Tasks: Claude Code Support

**Input**: Design documents from `/specs/001-support-claude-code/`

**Prerequisites**: plan.md and spec.md

## Phase 1: Foundational integration

- [X] T001 [P] Define typed OTLP log payload and Claude Code log/span attribute helpers in `src/otlpReceiver.ts`
- [X] T002 [P] Add documented Claude Code telemetry, logs, beta traces, protocol, and endpoint constants in `src/setup.ts`

## Phase 2: User Story 1 - Configure Claude Code telemetry (Priority: P1)

**Goal**: Setup enables Claude Code and remains idempotent.

**Independent Test**: Run setup against a temporary shell profile three times
and verify one block with the selected endpoint and Claude Code variables.

- [X] T003 [US1] Extend the shell environment block and current-process setup in `src/setup.ts`
- [X] T004 [US1] Update setup status text and README setup instructions for Claude Code
- [X] T005 [US1] Verify repeated setup updates one block and preserves existing Copilot/VS Code variables

## Phase 3: User Story 2 - Ingest Claude Code activity (Priority: P1)

**Goal**: Valid Claude Code OTLP logs become project-scoped trace entries.

**Independent Test**: Post representative OTLP log JSON to `/v1/logs`, query
the dashboard, and verify event content and project/session attribution.

- [X] T006 [US2] Implement OTLP log resource/scope/log-record traversal in `src/otlpReceiver.ts`
- [X] T007 [US2] Map supported Claude Code events plus `claude_code.interaction` and `claude_code.llm_request` spans to `TraceEntry` in `src/otlpReceiver.ts`
- [X] T008 [US2] Add explicit malformed-payload handling and bounded duplicate protection in `src/otlpReceiver.ts`
- [X] T009 [US2] Verify `/v1/logs`, project attribution, missing optional fields, and malformed payload behavior

## Phase 4: User Story 3 - Preserve existing Copilot behavior (Priority: P2)

**Goal**: Existing Copilot ingestion and setup remain compatible.

- [X] T010 [US3] Run existing seed and daemon/API workflow and verify Copilot trace output
- [X] T011 [US3] Run `npx tsc --noEmit` and review changed public behavior against the constitution

## Dependencies & Execution Order

- T001 and T002 can run in parallel.
- T003-T005 depend on T002.
- T006-T009 depend on T001 and may proceed independently of T003-T005.
- T010-T011 depend on all implementation tasks.
