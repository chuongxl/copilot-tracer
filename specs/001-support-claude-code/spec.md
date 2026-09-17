# Feature Specification: Claude Code Support

**Feature Branch**: `001-support-claude-code`

**Created**: 2026-08-20

**Status**: Completed

**Input**: User description: "support claude code"

## User Scenarios & Testing

### User Story 1 - Configure Claude Code telemetry (Priority: P1)

As a Claude Code user, I want the tracer setup command to configure Claude Code
OTLP logs/events and optional beta traces for the local tracer so that my
Claude Code activity is collected without manually editing environment
settings.

**Why this priority**: Configuration is the minimum required path to make the
feature usable for new users.

**Independent Test**: Run setup against an isolated shell profile, inspect the
resulting environment block, and verify that it contains the Claude Code
telemetry enablement and OTLP endpoint settings without duplicate blocks.

**Acceptance Scenarios**:

1. **Given** a shell profile without tracer settings, **When** setup runs,
   **Then** it adds one clearly delimited configuration block enabling Claude
   Code telemetry, OTLP logs, and beta traces, pointing them to the selected
   local port.
2. **Given** a shell profile already configured for the tracer, **When** setup
   runs again, **Then** it updates the existing block in place and does not
   create duplicate settings.
3. **Given** a user starts the daemon with setup enabled, **When** setup
   completes,    **Then** the current process has the Claude Code telemetry, logs exporter,
   traces exporter, protocol, and endpoint variables available immediately.

### User Story 2 - Ingest Claude Code activity (Priority: P1)

As a tracer user, I want Claude Code telemetry received by the daemon to appear
as project-scoped trace entries so that Claude Code and Copilot activity can be
reviewed in one dashboard.

**Why this priority**: Collection and visibility are the product value after
configuration.

**Independent Test**: Post a representative Claude Code OTLP log payload to the
local receiver and verify that a trace entry is persisted with prompt/event
content, session identity, working directory, timing, and a completed status.

**Acceptance Scenarios**:

1. **Given** a valid Claude Code OTLP log batch with a user event, **When** the
   daemon receives it, **Then** it acknowledges the batch and creates a trace
   entry associated with the event's session and project context.
2. **Given** a Claude Code event without optional token or response fields,
   **When** it is received, **Then** the entry remains visible with zero or
   absent optional values rather than causing the whole batch to fail.
3. **Given** malformed or unsupported telemetry, **When** it is received,
   **Then** the receiver returns an explicit client error and does not persist a
   fabricated successful entry.

### User Story 3 - Preserve existing Copilot behavior (Priority: P2)

As an existing Copilot tracer user, I want the Claude Code support changes to
leave current Copilot setup and trace ingestion working as before.

**Why this priority**: Backward compatibility prevents the new integration from
regressing the primary existing use case.

**Independent Test**: Run the existing seed and daemon/API workflow, then post
the existing Copilot trace payload shape and verify its dashboard output remains
unchanged.

**Acceptance Scenarios**:

1. **Given** an existing Copilot OTLP trace payload, **When** it is posted after
   the change, **Then** it is parsed and stored with its existing token, credit,
   tool-call, and project attribution behavior.
2. **Given** setup is run on a system that has no Claude Code installation,
   **When** setup completes, **Then** it still configures the local receiver and
   reports actionable status without failing Copilot or VS Code setup.

### Edge Cases

- A log batch may contain multiple resource groups, scopes, or events; each
  supported event must be processed without dropping unrelated groups.
- Claude Code may send telemetry using an OTLP path with a trailing `/v1/logs`
  endpoint; setup must produce a compatible base endpoint and the receiver must
  accept the standard route.
- Missing session or working-directory attributes must use the receiver's
  existing default session/project behavior.
- Repeated delivery of the same event must not create an unbounded number of
  duplicate entries when a stable event or span identifier is available.

## Requirements

### Functional Requirements

- **FR-001**: Setup MUST enable Claude Code telemetry, OTLP logs/events, and
  enhanced beta traces, configuring delivery to the tracer's selected local
  port using a supported OTLP protocol.
- **FR-002**: Setup MUST update an existing tracer configuration block in place
  and MUST NOT append duplicate Claude Code settings on repeated runs.
- **FR-003**: The receiver MUST accept standard OTLP JSON log batches at
  `/v1/logs` and Claude Code beta trace spans at `/v1/traces`, in addition to
  the existing Copilot behavior.
- **FR-004**: The receiver MUST extract supported Claude Code user/assistant
  activity, session identity, working directory, timestamps, and available
  usage values from logs or spans into the existing trace-entry model.
- **FR-005**: The receiver MUST resolve project attribution from telemetry
  working-directory or repository context using the existing project hierarchy.
- **FR-006**: Missing optional Claude Code fields MUST not reject an otherwise
  valid event; malformed required payload structure MUST return an explicit
  client error.
- **FR-007**: Existing Copilot `/v1/traces` parsing, setup behavior, and public
  dashboard responses MUST remain compatible.
- **FR-008**: Documentation MUST describe the supported Claude Code setup,
  required restart/source steps, and the receiver behavior.

### Key Entities

- **Claude Code telemetry event**: A user or assistant activity record with
  event name, attributes, timestamp, and optional session/project metadata.
- **Trace entry**: The existing persisted activity record displayed in the
  dashboard, including prompt/response, usage, duration, status, and tool data.
- **Telemetry configuration block**: The idempotent shell or process environment
  settings that enable Claude Code and target the local OTLP receiver.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A new user can run setup once and have all required Claude Code
  telemetry variables configured without manual file editing.
- **SC-002**: At least 95% of valid representative Claude Code event payloads
  produce a visible trace entry within 2 seconds of receipt during manual
  verification.
- **SC-003**: Re-running setup three times leaves exactly one tracer
  configuration block in the target shell profile.
- **SC-004**: Existing Copilot trace ingestion and dashboard manual checks
  complete with no regressions.

## Assumptions

- Claude Code uses standard OTLP logs/events and optionally beta traces. The
  supported configuration includes `CLAUDE_CODE_ENABLE_TELEMETRY`,
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `OTEL_LOGS_EXPORTER`,
  `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, and endpoint
  variables. Source: Anthropic Claude Code Monitoring documentation,
  https://code.claude.com/docs/en/monitoring-usage.
- The existing trace-entry schema is sufficient; no new persistent tables are
  required for the first release.
- Localhost collection remains the default and no external telemetry relay is
  introduced.
- A test framework is not available, so targeted payload fixtures and the
  repository's documented manual daemon/API workflow are the acceptance method.
