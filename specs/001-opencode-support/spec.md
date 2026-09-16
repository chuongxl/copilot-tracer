# Feature Specification: OpenCode Host Support

**Feature Branch**: `001-opencode-support`

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: "research a solution to add support opencode for this project."

## Clarifications

### Session 2026-09-16 (autonomous, YOLO mode)

- Q: What identifies an OpenCode session/turn/tool-call as unique for idempotent ingestion,
  preventing duplicate or out-of-order events (per FR-009) from creating duplicate records? → A:
  OpenCode's own session ID plus its per-message ID (analogous to how Claude Code hooks are joined
  on `prompt_id`); a turn is keyed on `(opencode_session_id, message_id)` and a tool call on
  `(message_id, tool_call_id)`, so redelivery of the same event is a safe no-op upsert rather than
  a new record.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See OpenCode sessions in the dashboard (Priority: P1)

A developer who uses the OpenCode terminal agent wants their OpenCode sessions to show up in
copilot-tracer's dashboard alongside their Copilot CLI and Claude Code sessions, with the same
token usage, cost, and tool-call visibility they already get for those tools.

**Why this priority**: Without ingestion, OpenCode usage is invisible to the tracer — this is the
foundational capability the rest of the feature depends on.

**Independent Test**: Run an OpenCode session in a project with the integration configured, then
confirm a new session with turns, token usage, and cost appears under that project in the
dashboard within a few seconds of each OpenCode reply.

**Acceptance Scenarios**:

1. **Given** a project has never been traced before, **When** a developer runs an OpenCode session
   in it with the integration installed, **Then** a new project and session appear in the
   dashboard automatically, without manual project creation.
2. **Given** an OpenCode session is in progress, **When** the agent completes a turn (a prompt/
   response exchange), **Then** the trace list updates with that turn's token usage and elapsed
   time within a few seconds, without requiring a page refresh.
3. **Given** an OpenCode turn included tool calls (e.g. file edits, shell commands, sub-agent
   invocations), **When** the trace is viewed, **Then** each tool call is listed with its type
   (built-in tool, MCP tool, or sub-agent) and name.

### User Story 2 - One-command setup for OpenCode (Priority: P2)

A developer who already uses copilot-tracer's `--setup` flow for other tools wants a similarly
simple way to wire OpenCode into the tracer, without hand-editing config files.

**Why this priority**: Manual configuration is error-prone and raises the adoption barrier; this
mirrors the existing setup experience for Copilot CLI/VS Code and Claude Code hooks.

**Independent Test**: Run the tracer's setup command with OpenCode detected on the machine, then
start an OpenCode session and confirm traces arrive without any manual config edits.

**Acceptance Scenarios**:

1. **Given** OpenCode is installed on the developer's machine, **When** the developer runs the
   tracer's setup flow, **Then** the tracer detects OpenCode and installs its integration
   automatically (equivalent in effect to how Claude Code hooks are installed today).
2. **Given** OpenCode is not installed, **When** the developer runs the tracer's setup flow,
   **Then** the OpenCode step is skipped with a clear message, and no error is raised.
3. **Given** the developer already has other project-level or global OpenCode plugins configured,
   **When** the tracer's integration is installed, **Then** the developer's existing plugins keep
   working (the tracer's integration is additive, never a wholesale replacement).

### User Story 3 - Accurate cost and credit accounting for OpenCode (Priority: P3)

A developer wants OpenCode's token usage translated into the same credit/cost figures shown for
other tools, so they can compare spend across all their AI coding tools in one place.

**Why this priority**: Cost visibility is a secondary but expected payoff once ingestion works;
it depends on User Story 1 being in place first.

**Independent Test**: Run an OpenCode session using a known model, then confirm the dashboard's
reported cost matches the same model's published rate applied to the reported token counts.

**Acceptance Scenarios**:

1. **Given** an OpenCode session used a model with a known rate in the tracer's pricing tables,
   **When** the session's trace is viewed, **Then** the displayed cost/credits reflect that
   model's rate applied to the input, output, and cache token counts reported for the session.
2. **Given** an OpenCode session used a model that has no entry in the tracer's pricing tables,
   **When** the session's trace is viewed, **Then** token usage is still displayed and cost is
   shown as unavailable/zero rather than causing an error or blocking the rest of the trace.

### Edge Cases

- What happens when OpenCode is used outside of any git repository (no project to associate the
  session with)? The tracer should still record the session under a fallback/ungrouped project
  rather than dropping the data.
- How does the system handle an OpenCode session that never reaches a terminal turn state (e.g.
  the developer kills the process mid-turn)? The partial trace should remain visible rather than
  hanging indefinitely as "running"; a turn with no terminal signal for longer than the existing
  stale-turn expiry window already used for other tools' in-memory trackers is marked `error`
  with a timeout reason, matching that existing behavior rather than introducing a new one.
- What happens if the same OpenCode session sends duplicate or out-of-order events (e.g. a retry
  after a network blip)? Duplicate events must not create duplicate sessions/turns: ingestion is
  keyed on OpenCode's own session ID plus per-message ID (see Clarifications), so redelivery is a
  no-op.
- How does the system behave if OpenCode's integration point emits data in a format the tracer
  does not recognize (e.g. after an OpenCode update changes event shapes)? The tracer should
  ignore/log the unrecognized event without crashing ingestion for other sessions.
- What happens if the tracer daemon is not running when OpenCode tries to deliver an event? The
  plugin's delivery attempt MUST fail silently from OpenCode's perspective (it never blocks or
  errors the developer's OpenCode session); the event is simply not recorded, with no retry
  buffering required for this feature's scope.
- What happens if two OpenCode sessions run concurrently in the same project directory (e.g. two
  terminals)? Each is tracked as an independent session by its own OpenCode session ID; both
  appear under the same auto-detected project without interfering with each other's turns or tool
  calls.
- What happens if the developer's machine cannot write to OpenCode's global plugin directory
  during setup (e.g. a permissions error)? Setup MUST report the specific failure clearly and
  continue completing the rest of setup, consistent with how a missing OpenCode installation is
  handled (this step never fails the whole setup run).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST ingest OpenCode session activity (session start, prompt/response
  turns, tool calls, and completion) into the existing Project → Session → Trace data model, the
  same one used for Copilot CLI and Claude Code.
- **FR-002**: The system MUST auto-detect and auto-create the Project for an OpenCode session from
  the working directory's repository information, consistent with how other tools' sessions are
  associated with projects today.
- **FR-003**: The system MUST classify each OpenCode tool call into the existing tool-type
  vocabulary (built-in, MCP, sub-agent/task, or skill), mirroring the per-tool classification
  already done for Copilot CLI and Claude Code.
- **FR-004**: The system MUST compute token usage (input, output, cache read/write where reported)
  and a corresponding credit/cost figure for each OpenCode turn, using a per-model rate table
  consistent in structure with the existing Copilot/Anthropic rate tables.
- **FR-005**: The system MUST update the web dashboard in real time as OpenCode trace data arrives,
  using the existing live-update mechanism (no polling required from the browser).
- **FR-006**: The setup flow MUST detect whether OpenCode is installed on the developer's machine
  and, when present, install the integration automatically; when absent, it MUST skip this step
  without failing the rest of setup. If installation itself fails (e.g. the plugin directory is
  not writable), setup MUST report that specific failure clearly and still continue completing
  the rest of setup rather than aborting.
- **FR-007**: Installing the OpenCode integration MUST be additive to any existing OpenCode plugin
  or config the developer already has, never overwriting or disabling it.
- **FR-008**: The system MUST continue operating normally (existing Copilot CLI / Claude Code
  ingestion, dashboard, and API) when OpenCode is not installed or not configured — this is an
  additive capability, not a required dependency.
- **FR-009**: The system MUST tolerate and safely ignore malformed, unrecognized, or duplicate
  OpenCode events without interrupting ingestion of other sessions, using OpenCode's own session
  ID and per-message ID as the idempotency key for turns (and message ID + tool-call ID for tool
  calls) so redelivered events upsert rather than duplicate.
- **FR-010**: An OpenCode session started outside a recognizable git repository MUST still be
  recorded, associated with a fallback/ungrouped project rather than being dropped.
- **FR-011**: A turn that never receives a terminal completion or error signal MUST NOT remain
  "running" indefinitely; it MUST be marked as failed after the same stale-entry expiry already
  used for other in-progress trace tracking in the system.
- **FR-012**: The system MUST track concurrent OpenCode sessions in the same project directory as
  independent sessions, without one session's turns or tool calls being attributed to another.


### Key Entities

- **OpenCode Session**: A single run of the OpenCode agent tied to a working directory; maps to
  the tracer's existing `Session` entity, gaining a way to identify it as originating from
  OpenCode (analogous to how Claude Code sessions are distinguished today).
- **OpenCode Turn**: One prompt/response exchange within an OpenCode session, including token
  usage and any tool calls made during it; maps to the tracer's existing `Trace` entity.
- **OpenCode Tool Call**: An individual action taken during a turn (file edit, shell command,
  sub-agent invocation, MCP tool use); maps to the existing `ToolCall` entity, tagged with the
  appropriate type.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer who installs the OpenCode integration sees their first OpenCode trace
  appear in the dashboard within 10 seconds of completing an OpenCode turn, with no manual steps
  beyond the one-time setup.
- **SC-002**: 100% of OpenCode tool calls in a traced session are shown with a correctly
  classified type (built-in, MCP, sub-agent, or skill) rather than "unknown".
- **SC-003**: Reported token usage for an OpenCode session with a priced model matches the
  provider's reported usage figures with zero discrepancy, and cost is computed without manual
  intervention.
- **SC-004**: Enabling OpenCode support causes zero regressions in existing Copilot CLI / Claude
  Code ingestion, verified by existing traces continuing to appear and update correctly after the
  change.
- **SC-005**: Setup for OpenCode requires a single command with no manual file edits, matching the
  effort already required for Claude Code hook setup.

## Assumptions

- OpenCode does not natively export OpenTelemetry (OTLP) traces at this time; the integration
  point is OpenCode's plugin/event-hook system, which can observe session, message, and tool
  events and forward them to the tracer over HTTP — architecturally analogous to the existing
  Claude Code hooks path (hooks own the lifecycle) rather than the OTLP receiver path.
- OpenCode plugins run as local JavaScript/TypeScript modules loaded from a project- or
  user-level plugin directory (or an npm package); "installing the integration" means writing such
  a plugin file/package reference, not modifying OpenCode's own source.
- Session/turn/tool-call correlation will reuse an identifier already present in OpenCode's event
  payloads (its own session and message IDs), the same way Claude Code hooks are joined to OTLP
  data on `prompt_id` today; the exact field will be confirmed during planning.
- Pricing for OpenCode-supported models will be added to the existing per-provider rate table
  structure; models without a known rate are out of scope for precise cost and will show token
  counts only, per FR-004/Edge Cases.
- This feature covers ingestion, project/session mapping, credit calculation, dashboard display,
  and setup automation for OpenCode. It does not cover proxying/wrapping the OpenCode CLI process
  itself (the "normal mode" ACP-proxy path used for Copilot CLI is out of scope for OpenCode).
- Multi-user/team dashboards, historical data migration, and non-local (e.g. cloud-hosted)
  OpenCode usage are out of scope for this feature.
