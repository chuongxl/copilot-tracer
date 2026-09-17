# Phase 0 Research: Codex CLI Trace Support

## Decision 1: Ingestion transport

**Decision**: Ingest Codex telemetry over the same OTLP HTTP endpoints the daemon already exposes
(`POST /v1/logs`), adding that route since it does not exist yet on this branch, rather than
building a hooks-based path.

**Rationale**: Codex CLI's `codex-otel` crate (`codex-rs/otel`) emits its session/turn/tool
business events (`codex.conversation_starts`, `codex.user_prompt`, `codex.tool_decision`,
`codex.turn_cost`, token usage on `codex.sse_event`) as `tracing` events bridged through an OTLP
log exporter, configured via an `[otel]` block in `config.toml` with `exporter`/`trace_exporter`
set to `otlp-http` or `otlp-grpc`. Codex has no documented hooks-based lifecycle API analogous to
Claude Code's `type: "http"` hooks, so a hook path is not viable.

**Alternatives considered**:
- *Wait for/depend on Claude's hook path*: rejected — that code does not exist on this branch, and
  Codex has no hook API to reuse it against anyway.
- *Parse Codex's local session JSONL rollout files directly*: rejected — undocumented, versioned
  per Codex release, and outside this project's existing "receive telemetry over HTTP" pattern;
  would require filesystem watching not used anywhere else in this codebase.

## Decision 2: Event parsing shape

**Decision**: Add `processCodexLogs(payload, defaultSessionId, projectId)` and
`processCodexLogRecord(record, resourceAttrs, sessionId, projectId, workingDir)` in
`otlpReceiver.ts`, dispatched by an `event.name` (or log body) prefix of `codex.`, mirroring the
existing `event.name` + prefix-check pattern already used for Claude Code
(`processClaudeLogRecord`'s `startsWith('claude_code.')` check) as prior art — reimplemented fresh
here since that function is not present on this base branch.

**Rationale**: Reusing the same dispatch shape keeps `otlpReceiver.ts` internally consistent and
sets up a low-friction merge once/if the Claude hook branch lands, without taking a dependency on
code that doesn't exist yet.

**Alternatives considered**: A single generic "log event router" keyed off a `source` field derived
from resource attributes, dispatching to per-tool handler modules. Rejected for this change as
premature abstraction (Minimal, Observable Operations principle) — revisit only if a third
log-based tool is added after this one.

## Decision 3: Event → Trace field mapping

**Decision**: Map Codex OTLP events as follows (exact attribute keys confirmed/adjusted against
the installed Codex CLI version during implementation, since `codex-otel`'s attribute names are
sourced from its Rust source rather than a stable published schema):

| Codex event | Trace effect |
|---|---|
| `codex.conversation_starts` | ensure Session (+ Project via working-directory attribute) |
| `codex.user_prompt` | open/create a running `TraceEntry` with prompt text |
| `codex.tool_decision` | append a `ToolCall` to the current turn's trace entry |
| `codex.turn_cost` | attach token usage + finalize cost on the trace entry |
| `codex.sse_event` (`kind: "response.completed"` style payload) | backfill token usage when
  `turn_cost` is unavailable/incomplete for a turn |

**Rationale**: This mirrors the "session-start / prompt / tool / completion" shape already used
for the other supported tools' traces, keeping `TraceEntry.status` transitions
(`running` → `done`/`error`) consistent across all three tools.

**Alternatives considered**: Treating every Codex event as a new trace row and reconciling later.
Rejected — breaks the existing one-`TraceEntry`-per-turn invariant the dashboard and session
summary queries depend on.

## Decision 4: Project/session id correlation

**Decision**: Use Codex's own conversation/session identifier (present as a resource or event
attribute) as the tracer `sessionId`; resolve the Project the same way as other tools —
repo URL attribute first, else a working-directory attribute, else the CLI's default project —
via the existing `resolveProjectId`/`detectWorkingDir` helpers, extended with Codex's attribute
key names.

**Rationale**: Matches `FR-003` and `FR-011` (segregating tools' sessions) without inventing a new
correlation mechanism.

**Alternatives considered**: None — this is a direct application of the existing pattern.

## Decision 5: Config setup mechanism

**Decision**: `--setup` detects a local Codex CLI install (`which codex`), then reads
`~/.codex/config.toml` (creating the file/directory if absent) and adds a sentinel-commented
`[otel]` block (`# >>> copilot-tracer OTLP config (auto-added) >>>` ... `# <<< copilot-tracer <<<`)
pointing `exporter`/`trace_exporter` at `otlp-http://localhost:<port>`, using plain text
line-splicing — the same sentinel-comment-block technique `patchShellProfile` already uses for
shell profiles — rather than a TOML parser dependency.

**Rationale**: TOML supports `#` line comments, so the existing sentinel-block-replace approach
(detect block → already-set / update port → replace block; else append) works unmodified for a
`.toml` file. Adding a TOML parsing/serialization dependency for one additive block would violate
the "avoid speculative dependencies" constraint.

**Alternatives considered**: Full TOML parse + re-serialize (e.g., via a `@iarna/toml`-style
library) to safely merge into arbitrary existing structure. Rejected for v1 — higher risk of
reformatting/reordering a user's hand-edited file, and unnecessary for adding one clearly-delimited
block; revisit only if user reports show frequent conflicts with hand-authored `[otel]` sections.

**Conflict handling**: If a non-sentinel `[otel]` table already exists in the file (i.e., the user
has their own `[otel]` config, e.g. pointing at Statsig or another collector), `--setup` MUST NOT
edit the file — it prints a warning naming the existing block and instructs the user to add the
tracer's OTLP endpoint manually, satisfying FR-009.

## Decision 6: Cost/pricing

**Decision**: New `src/codexPricing.ts` module exporting `calcCodexCredits(tokens, model)`, with a
`Record<string, {input; output}>` USD-per-1K-token table keyed by OpenAI/Codex model name
substrings, mirroring `claudePricing.ts`'s shape, falling back to a `default` rate for
unrecognized models (satisfies `FR-006`, `SC-003`, and the US3 edge case).

**Rationale**: Consistent with the existing per-tool pricing module pattern; keeps tool-specific
rate tables independently maintainable, as `claudePricing.ts`'s own module comment already
documents as the reason it's split out from `otlpReceiver.ts`.

**Alternatives considered**: A single shared generic pricing module keyed by provider. Rejected —
`claudePricing.ts` already established the "one small pricing module per tool" convention; matching
it is the smaller, more consistent change.

## Decision 7: Failure isolation

**Decision**: `processCodexLogRecord` ignores (returns early on) any record whose `event.name` does
not start with `codex.`, and wraps attribute extraction in the same defensive `getStringAttr`/
`getAttr` helpers already used elsewhere, so a missing/renamed attribute yields `undefined` rather
than throwing. The `/v1/logs` route already wraps its handler in try/catch and responds `400` on
parse failure without crashing the process (existing behavior, confirmed reused, not modified).

**Rationale**: Directly satisfies FR-010 and SC-005 using the existing error-handling shape,
consistent with the constitution's "failures MUST be surfaced ... broad catches and success-shaped
silent fallbacks are prohibited" (surfacing here means: log and 400 the malformed batch, not
silently pretend a Codex event succeeded when its data was missing).
