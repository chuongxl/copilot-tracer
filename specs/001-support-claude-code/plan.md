# Implementation Plan: Claude Code Support

**Branch**: `001-support-claude-code` | **Date**: 2026-08-20 | **Spec**: [spec.md](spec.md)

## Summary

Extend the existing local OTLP setup and receiver so Claude Code can emit
standard OTLP logs/events and optional enhanced beta traces to the daemon.
Supported user/assistant activity will use the existing trace-entry model.
Keep Copilot span processing unchanged, centralize environment settings, and
document the setup path.

## Technical Context

**Language/Version**: TypeScript on Node.js 18+

**Primary Dependencies**: Express, better-sqlite3, Commander, existing OTLP JSON
receiver and trace model

**Storage**: Existing SQLite database at `~/.copilot-tracer/traces.db`

**Testing**: `npx tsc --noEmit`, targeted Node payload checks, and documented
manual daemon/API verification; no test runner exists

**Target Platform**: macOS and Linux shells running the local daemon

**Project Type**: Single-package CLI and local web service

**Performance Goals**: A valid event or span is visible within 2 seconds in the
local daemon workflow; receiver work remains bounded per request

**Constraints**: Preserve `/v1/traces` behavior, keep telemetry local by
default, avoid new dependencies, and keep setup idempotent

**Scale/Scope**: One local daemon receiving telemetry from multiple projects

## Constitution Check

- Observable Data Integrity: PASS — preserve source event content and metadata;
  do not fabricate missing optional values.
- Safe, Persistent Storage: PASS — reuse the existing parameterized trace
  persistence and Project → Session → Trace hierarchy.
- Explicit Interfaces and Compatibility: PASS — add `/v1/logs` without changing
  existing `/v1/traces` or dashboard response shapes.
- Verification Before Delivery: PASS — type-check and manual OTLP/API checks
  are included in tasks.
- Minimal, Observable Operations: PASS — no dependency or schema changes;
  explicit receiver errors and setup status remain visible.

## Project Structure

```text
src/
├── setup.ts          # shared environment configuration and idempotent patching
└── otlpReceiver.ts   # OTLP traces/logs parsing and persistence
README.md             # Claude Code setup and support documentation
specs/001-support-claude-code/
├── spec.md
├── plan.md
├── checklist.md
└── tasks.md
```

**Structure Decision**: Extend the two existing integration boundaries rather
than add a parallel Claude-specific service or storage model.

## Design Notes

Claude Code configuration will use the documented telemetry enablement,
logs/events exporter, enhanced beta traces exporter, protocol, and endpoint
variables in the same idempotent shell block as the existing tracer settings.
The receiver will parse standard OTLP logs and Claude Code's documented
interaction/LLM spans, recognize supported event and span attributes, and map
each usable record to the existing trace-entry shape. Unknown records will be
acknowledged without persistence; malformed JSON or structurally invalid
required fields will return a client error.
