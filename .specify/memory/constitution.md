<!--
Sync Impact Report
- Version change: 0.0.0 → 0.1.0
- Modified principles: None; all principles are newly defined from the scaffold.
- Added sections: Additional Constraints; Development Workflow, Review Process, and Quality Gates.
- Removed sections: None.
- Follow-up TODOs: TODO(RATIFICATION_DATE) remains because the original adoption date is unknown.
-->

# copilot-tracer Constitution

## Core Principles

### I. Observable Data Integrity
The application MUST preserve the fidelity and traceability of captured Copilot
telemetry. Parsers MUST retain prompt/response content, token usage, tool calls,
durations, project identity, and timestamps when those values are present.
Derived values such as AI credits MUST use the documented model-rate logic and
MUST NOT silently replace malformed or unavailable source data with fabricated
success values. This protects the product's purpose as a trustworthy tracing
companion.

### II. Safe, Persistent Storage
All captured traces MUST be stored through the SQLite data model and MUST retain
the Project → Session → Trace relationships. Schema or migration changes MUST
preserve existing user data or provide an explicit migration path. Database
operations MUST use parameterized statements, and filesystem paths, repository
URLs, and user content MUST be handled without unsafe interpolation. Persistence
across daemon restarts is a required behavior.

### III. Explicit Interfaces and Compatibility
CLI flags, HTTP/OTLP routes, JSON responses, Socket.io events, and exported
TypeScript types are public interfaces within this project. Changes to these
interfaces MUST preserve existing behavior unless a breaking change is
documented in the README and reflected in the package version. New behavior MUST
use the existing ESM, TypeScript, Express, Socket.io, and better-sqlite3
conventions rather than introducing an unnecessary parallel abstraction.

### IV. Verification Before Delivery
Every code change MUST pass `npx tsc --noEmit` before delivery. Changes affecting
trace ingestion, database behavior, or HTTP APIs MUST include targeted manual
verification using the existing seed script and daemon/API workflow, or an
equivalent documented check when the script does not cover the behavior.
Failures MUST be surfaced to the caller or operator; broad catches and
success-shaped silent fallbacks are prohibited. This project has no test runner,
so reproducible manual checks are the required quality gate.

### V. Minimal, Observable Operations
Features MUST remain focused on tracing, prompt refinement, inspection, and
operator setup. Implementations MUST prefer the smallest clear change that
meets the requirement, avoid speculative dependencies, and preserve daemon
reliability. Operationally significant events and errors MUST be visible through
the existing debug/logging paths or HTTP responses. Performance-sensitive
ingestion and dashboard queries MUST be bounded and MUST NOT load unbounded trace
data by default.

## Additional Constraints

The project MUST remain an ESM Node.js package supporting Node.js 18 or newer.
Runtime dependencies and native modules MUST be justified by the feature that
requires them. SQLite remains the persistent store at
`~/.copilot-tracer/traces.db`; changes to its location or format require an
explicit migration plan. The web UI remains a vanilla static interface with no
frontend build step unless the constitution is amended.

Captured telemetry can contain sensitive prompts and responses. The application
MUST keep that data local by default, MUST NOT add external telemetry or data
export without explicit product requirements, and MUST avoid logging raw prompt
content in debug output unless the operator explicitly requests it.

## Development Workflow, Review Process, and Quality Gates

Work MUST begin with a clear requirement and a scoped change. Implementation
changes MUST be reviewed against the relevant Core Principles, README behavior,
and public interface contracts. Before delivery, contributors MUST run
`npx tsc --noEmit`; for ingestion, storage, or API changes they MUST also run
`node test-seed.mjs`, start the daemon with `npm run dev -- --daemon --port
4747`, and verify the relevant endpoint with `curl` where feasible. Published
changes MUST use the existing versioning and publishing workflow. Documentation
updates MUST accompany changes to CLI flags, setup behavior, storage semantics,
public endpoints, or operator-visible workflows.

## Governance

This constitution is the governing document for project design and delivery
decisions. When a practice conflicts with it, the conflict MUST be resolved in
favor of this constitution or recorded as part of an approved amendment.

Amendments MUST describe the motivation, affected principles, compatibility
impact, migration or rollout requirements, and required documentation updates.
The amendment MUST update the Sync Impact Report, version, and last-amended date.
Contributors reviewing a change MUST check compliance with this constitution,
and release or publish work MUST NOT proceed while a known constitutional
violation remains unaddressed or explicitly waived.

Constitution versions follow semantic versioning: MAJOR for incompatible
principle removals or redefinitions, MINOR for new principles or materially
expanded governance, and PATCH for clarifications or non-semantic wording
changes. The constitution version is independent from the application package
version.

**Version**: 0.1.0 | **Ratified**: TODO(RATIFICATION_DATE): original adoption date unknown | **Last Amended**: 2026-08-20
