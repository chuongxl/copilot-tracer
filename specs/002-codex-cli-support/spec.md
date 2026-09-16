# Feature Specification: Codex CLI Trace Support

**Feature Branch**: `002-codex-cli-support`

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: "Add support for tracing OpenAI Codex CLI sessions in copilot-tracer, the same way GitHub Copilot CLI and Claude Code sessions are already traced, so users running Codex alongside those tools get unified project/session/token/cost visibility in the dashboard. Codex CLI has no hooks-based lifecycle API; it exposes session and turn events (prompts, tool decisions, token usage, turn cost) only through its own OpenTelemetry (OTLP) log/trace exporter, configured via a `[otel]` block in `~/.codex/config.toml` (not environment variables alone)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See Codex sessions in the dashboard (Priority: P1)

A developer who uses OpenAI Codex CLI for coding tasks wants their Codex sessions to show up in
the copilot-tracer dashboard next to their Copilot CLI and Claude Code sessions, with project,
session, and per-turn trace records populated automatically once Codex is pointed at the tracer.

**Why this priority**: Without this, Codex usage is invisible in the tool the user already relies
on for tracking every other assistant, defeating the "unified visibility" purpose of the product.

**Independent Test**: Configure Codex CLI's `[otel]` block to point at the running tracer daemon,
run a Codex session that issues at least one prompt and one tool call, then confirm a new project
(auto-detected from the working directory), a session, and trace entries appear via
`/api/dashboard` and `/api/traces`.

**Acceptance Scenarios**:

1. **Given** the tracer daemon is running and Codex CLI's OTLP exporter is configured to send to
   it, **When** the user starts a Codex session and sends a prompt, **Then** a session appears in
   the dashboard tagged with a Codex-identifying source and the correct project.
2. **Given** a Codex session is in progress, **When** Codex executes a tool/command as part of a
   turn, **Then** the resulting trace entry includes that tool call in its tool-call tree.
3. **Given** a Codex turn completes, **When** token usage is reported by Codex's OTLP events,
   **Then** the trace entry shows non-zero input/output token counts and a computed AI credit
   value for that turn.

---

### User Story 2 - One-command setup for Codex telemetry (Priority: P2)

A developer running `--setup` wants copilot-tracer to detect Codex CLI and configure it to export
telemetry to the local daemon, without hand-editing TOML files.

**Why this priority**: Codex requires editing a config file (not just environment variables), which
is a materially different and more error-prone setup step than the other supported tools; automating
it removes the main adoption barrier.

**Independent Test**: Run `--setup` on a machine with Codex CLI installed but not yet configured for
telemetry, then verify `~/.codex/config.toml` contains a valid `[otel]` block pointing at the tracer
daemon's OTLP endpoint, without disturbing any of the user's other existing config entries.

**Acceptance Scenarios**:

1. **Given** Codex CLI is installed and `~/.codex/config.toml` has no `[otel]` block, **When** the
   user runs `--setup`, **Then** an `[otel]` block is added pointing at the local daemon and the
   rest of the file is left unchanged.
2. **Given** `~/.codex/config.toml` already has an `[otel]` block pointing elsewhere, **When** the
   user runs `--setup`, **Then** the tool warns about the existing configuration and does not
   silently overwrite it.
3. **Given** Codex CLI is not installed on the machine, **When** the user runs `--setup`, **Then**
   the Codex step is skipped without error, exactly as unrelated optional integrations are skipped
   today.

---

### User Story 3 - Accurate Codex cost estimates (Priority: P3)

A developer wants the AI credits/cost shown for Codex sessions to reflect actual OpenAI model
pricing for the models Codex used, consistent with how Copilot and Claude costs are computed.

**Why this priority**: Session totals and dashboard cost rollups are only trustworthy if every
tracked tool's cost math is accurate; this is lower priority than getting Codex sessions visible
at all (P1) and easy to configure (P2).

**Independent Test**: Run a Codex session using a known model, capture its reported token usage,
and confirm the displayed AI credit/cost for that trace matches the expected value for that
model's published per-token rate.

**Acceptance Scenarios**:

1. **Given** a completed Codex turn with known input/output/cached token counts and a known model
   name, **When** the trace is computed, **Then** the displayed cost matches that model's rate
   table within rounding tolerance.
2. **Given** a Codex turn reports a model not present in the rate table, **When** the trace is
   computed, **Then** the system falls back to the rate table's documented `default` entry
   (the current-generation flagship Codex/GPT model rate at time of implementation) rather than
   showing a zero or missing cost.

### Edge Cases

- What happens when Codex's OTLP events arrive out of order relative to its own turn boundaries
  (e.g., a tool-decision event for a turn arrives before that turn's start event)?
- How does the system handle a Codex session whose OTLP payload is missing the working-directory
  attribute needed for project auto-detection? (Falls back to an "Unknown project" bucket, matching
  existing behavior for other tools with missing repo attributes.)
- What happens when Codex and another supported tool (e.g., Claude Code) are both used in the same
  working directory in the same time window? (Sessions must remain segregated by tool/session id,
  never merged into one session.)
- How does the system behave if Codex's OTLP schema changes across a Codex CLI version upgrade
  (e.g., an event name or attribute is renamed)? (Unrecognized events are ignored rather than
  crashing the receiver; existing sessions keep working.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST recognize OTLP trace/log payloads originating from Codex CLI as
  distinct from Copilot CLI and Claude Code payloads, without misclassifying either existing
  source.
- **FR-002**: System MUST create/update a Project, Session, and per-turn Trace record from
  Codex's session-start, user-prompt, tool-decision, and turn-completion events.
- **FR-003**: System MUST auto-detect the project for a Codex session from the working-directory
  information present in Codex's OTLP payload, consistent with how other tools are auto-detected.
- **FR-004**: System MUST attach tool/command invocations reported by Codex to the correct trace's
  tool-call tree, tagged with the appropriate tool-call type.
- **FR-005**: System MUST extract token usage (input, output, cached where available) from
  Codex's turn/usage events and store it on the corresponding trace entry.
- **FR-006**: System MUST compute an AI credit/cost value for each Codex trace entry using a
  Codex/OpenAI model rate table, following the same computation approach used for other tools,
  with an explicit `default` rate entry used whenever a reported model has no specific match.
- **FR-007**: System MUST continue to update the dashboard and live session view in real time for
  Codex sessions, the same way it does for existing tools.
- **FR-008**: The `--setup` flow MUST detect a local Codex CLI installation and configure its
  telemetry export (via its config file, since Codex does not honor OTLP environment variables
  alone) to point at the local daemon, without overwriting unrelated existing configuration.
- **FR-009**: The `--setup` flow MUST leave an existing Codex telemetry configuration that already
  points elsewhere untouched, only warning the user rather than silently replacing it.
- **FR-010**: System MUST NOT fail or crash when it receives a Codex OTLP event it does not
  recognize (unknown event name/attribute); it MUST ignore the unrecognized event and continue
  processing subsequent events.
- **FR-011**: System MUST keep Codex sessions segregated from other tools' sessions even when they
  occur in the same project/working directory at overlapping times.

### Key Entities

- **Codex Session**: A single run of Codex CLI, correlated across its OTLP events by Codex's own
  session/conversation identifier; maps to the existing Session entity.
- **Codex Turn**: One user-prompt-to-completion cycle within a Codex session, including any tool
  calls and the token usage/cost for that cycle; maps to the existing Trace entity.
- **Codex Tool Call**: A single command/tool invocation Codex performed during a turn; maps to the
  existing ToolCall entity, tagged with a Codex-specific tool-type classification.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from "Codex CLI installed, not yet configured" to "seeing a completed
  Codex session with correct token counts in the dashboard" using only the existing `--setup`
  command and one Codex session, with no manual file editing.
- **SC-002**: 100% of tool calls made during a traced Codex turn appear in that turn's trace detail
  view, matching what Codex itself reported executing.
- **SC-003**: Displayed AI credit/cost for a Codex trace is within 1% of the cost computed from
  the model's published per-token rate, for every model in the rate table.
- **SC-004**: Existing Copilot CLI and Claude Code tracing continues to work with no regressions
  after Codex support is added (verified via existing manual test scripts).
- **SC-005**: An unrecognized/future Codex event shape never crashes the daemon or blocks ingestion
  of subsequent, recognized events from the same or other sessions — observable as: the daemon's
  dashboard endpoint keeps responding successfully, and a recognized event sent in the same or a
  later batch is still recorded, after an unrecognized event is received.

## Assumptions

- Codex CLI's OTLP exporter, once configured, sends the same categories of session/turn/tool/
  token-usage information observed in its current public source (event names such as
  `codex.conversation_starts`, `codex.user_prompt`, `codex.tool_decision`, `codex.turn_cost`, and
  usage data attached to `codex.sse_event`/response spans); exact attribute names are confirmed
  during implementation against the installed Codex CLI version.
- Codex CLI must be configured with an `[otel]` OTLP exporter block in `~/.codex/config.toml`
  pointing at the tracer daemon; there is no supported hooks-based lifecycle API for Codex
  equivalent to Claude Code's, so no hook-based ingestion path is built for it.
- Codex/OpenAI per-model token pricing is sourced from OpenAI's published API pricing and
  maintained in a rate table analogous to the existing Anthropic pricing table; new/unknown models
  use a documented default rate rather than blocking cost display.
- "Working-directory information" in Codex's OTLP payload is assumed sufficient for project
  auto-detection, mirroring the existing fallback-to-"Unknown project" behavior when it is absent.
- This feature targets the existing daemon/OTLP ingestion path only; no change to the legacy
  ACP-proxy (`--no-proxy`) session mode is in scope, since Codex is not an ACP-driven CLI.
