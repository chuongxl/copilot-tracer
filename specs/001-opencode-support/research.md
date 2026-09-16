# Research: OpenCode Host Support

## R1. What is OpenCode and what integration surface does it expose?

- **Decision**: OpenCode (`sst`/`anomalyco` "opencode", a terminal-based open-source AI coding
  agent) does **not** emit OpenTelemetry (OTLP) traces. Its supported extension surface is a
  **plugin system**: local JS/TS modules (project `.opencode/plugins/`, global
  `~/.config/opencode/plugins/`) or npm packages referenced in `opencode.json`'s `plugin` array.
  A plugin exports one or more functions that receive `{ project, client, $, directory, worktree }`
  and return an object of event-hook callbacks.
- **Rationale**: This is architecturally identical in shape to the existing Claude Code hooks
  path — an external process posts lifecycle events to the tracer rather than the tracer parsing
  OTLP spans. Reusing that "hooks own the lifecycle" pattern (vs. building a new OTLP parser) is
  the smallest change consistent with `otlpReceiver.ts`'s existing per-tool parsing split and the
  constitution's Principle V (minimal, observable operations; prefer smallest clear change).
- **Alternatives considered**:
  - *Wait for/require native OTLP export*: rejected — not available upstream today; would block
    the feature indefinitely and isn't the tracer's decision to make.
  - *Wrap/proxy the `opencode` CLI process (ACP-style, like `src/proxy.ts` does for Copilot CLI)*:
    rejected — OpenCode has no ACP/stdio JSON-RPC protocol to proxy; the plugin system is the only
    documented, stable public integration point.

## R2. Which OpenCode plugin events map to a Session → Trace → ToolCall lifecycle?

- **Decision**: Subscribe to `session.created` (session start / project association),
  `message.updated` (turn/response content and, when present, token usage per message),
  `session.idle` (turn/session completion signal), `tool.execute.before` /
  `tool.execute.after` (tool call start/finish, arguments, and result), and `session.error`
  (turn failure). This mirrors the Claude hook event set (`SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`) one-for-one in intent even though the event
  names differ.
- **Rationale**: These are the only documented events that touch session/message/tool
  boundaries; every other listed event (file, LSP, permission, TUI, shell) is unrelated to the
  trace lifecycle this feature needs.
- **Alternatives considered**: Polling the plugin's `client` SDK for session state on a timer —
  rejected as unnecessary complexity and latency versus event-driven push, and inconsistent with
  the "real-time, no polling" requirement (FR-005) already established for the dashboard.
- **Follow-up for implementation**: The exact field names / nesting of token usage inside
  `message.updated`'s payload (input/output/cache token counts, model id) are defined by the
  `@opencode-ai/plugin` TypeScript package and must be confirmed against its shipped type
  definitions at implementation time; if a field the design expects isn't present, the tracer
  MUST still record the turn (per FR-009 tolerance) with whatever subset of usage data is
  available rather than fail closed.

## R3. How should the tracer receive the plugin's events?

- **Decision**: Add a new local HTTP endpoint `POST /opencode/hook` on the existing Express app
  (`src/webServer.ts`), following the exact contract already used for `/claude/hook`: always
  respond `204 No Content` so a malformed payload or slow handler can never block the user's
  OpenCode session; never throw out of the route handler.
- **Rationale**: Reuses the existing daemon's always-on HTTP server (no new port, no new
  process) and an already-proven "hook receiver never blocks the host tool" contract (Principle
  III: explicit interfaces; Principle V: minimal operations).
- **Alternatives considered**: A dedicated OTLP-style ingestion path — rejected; there is no
  OTLP data to parse for OpenCode, so this would just be an unnecessary abstraction over the same
  HTTP POST.

## R4. How is idempotent, ordered ingestion achieved?

- **Decision** (carried from spec Clarifications): key a turn on
  `(opencode_session_id, message_id)` and a tool call on `(message_id, tool_call_id)`. Duplicate
  or replayed events upsert the same row instead of creating a new one, mirroring how
  `claudeSession.ts` keys in-memory turn state on `(sessionId, promptId)` before it is persisted.
- **Rationale**: Directly satisfies FR-009 and the spec's duplicate-event edge case with a
  pattern already proven in this codebase, avoiding a new de-duplication design.
- **Alternatives considered**: Timestamp-based "latest wins" de-duplication — rejected; message/
  tool IDs are already unique and stable per OpenCode's plugin event payloads, making ID-based
  keys strictly more correct.

## R5. How is the OpenCode session associated with a Project?

- **Decision**: Use the plugin context's `directory`/`worktree` (the project working directory
  OpenCode passes to every plugin invocation) as input to the existing `ensureProject()`
  (`src/db.ts`), the same function `resolveProject()` in `claudeHooks.ts` calls with Claude's
  `cwd`. When no git remote can be resolved from that path, the session still records under
  `ensureProject`'s existing fallback/ungrouped behavior (already relied on for Claude, so no new
  fallback logic is needed) — this covers FR-002 and FR-010.
- **Rationale**: Reuses an existing, already-tested code path instead of adding a second project-
  resolution mechanism.
- **Alternatives considered**: Deriving project identity from OpenCode's own `project` object —
  rejected as a parallel identity source that could diverge from the git-remote-based identity
  already used for every other tool in the dashboard.

## R6. How is tool-call classification (`mcp | skill | agent | builtin`) determined for OpenCode?

- **Decision**: Add a `detectOpenCodeToolType(name: string)` analogous to
  `detectClaudeToolType` in `claudeSession.ts`. OpenCode's own tool vocabulary: built-in tools
  (`bash`, `read`, `edit`, `write`, `grep`, `glob`, etc.) → `builtin`; tools whose name matches an
  MCP server's configured tool naming convention → `mcp`; OpenCode's custom/plugin-defined tools
  (via the `tool()` helper) → treated as `builtin` unless their name signals otherwise, since
  OpenCode has no distinct "skill" primitive; OpenCode's sub-agent/task-delegation tool (if
  present under the active OpenCode version) → `agent`.
- **Rationale**: Matches the constitution's requirement (Principle I: parsers must retain tool
  call type fidelity) and the existing per-tool `type` enum in `types.ts`, without inventing a new
  enum value — FR-003 requires reuse of the existing vocabulary.
- **Alternatives considered**: Adding a new `type` value for OpenCode-specific tool categories —
  rejected; would break the existing `ToolCall['type']` contract (Principle III: explicit
  interfaces and compatibility) for no clear benefit, since the four existing categories already
  cover OpenCode's tool taxonomy.

## R7. How is token usage priced for OpenCode sessions?

- **Decision**: Add `src/openCodePricing.ts`, structured identically to `src/claudePricing.ts`
  (a per-model USD-per-1K-token table converted to credit units), seeded with the same
  provider/model rates already used for Anthropic models (OpenCode sessions using Anthropic
  models reuse `claudePricing.ts`'s table via a shared lookup) plus commonly used OpenAI model
  rates. A model id absent from every table falls back to token-counts-only display with zero
  cost, per FR-004 and the spec's edge case for unpriced models.
- **Rationale**: Keeps pricing logic colocated by provider (existing pattern: Copilot rates in
  `proxy.ts`, Anthropic rates in `claudePricing.ts`), avoiding a monolithic cross-provider file
  while still giving OpenCode sessions real cost figures for the models it's most commonly used
  with.
- **Alternatives considered**: A single universal per-model table shared by all three tools —
  rejected; the constitution's note to keep the Copilot and Anthropic tables in sync when
  adjusting pricing implies provider-scoped tables are the established convention, and a merged
  table would blur that boundary.

## R8. How is the OpenCode plugin distributed and installed during `--setup`?

- **Decision**: Extend `src/setup.ts` to (a) detect OpenCode by checking for the `opencode`
  binary on `PATH` (same detection style already used for the Copilot CLI check), and (b) when
  found, write a small tracer-authored plugin file to the **global** plugin directory
  (`~/.config/opencode/plugins/copilot-tracer.js`) that POSTs the events from R2 to
  `http://localhost:<port>/opencode/hook`. Writing only this one dedicated file (never touching
  `opencode.json` or other plugin files) satisfies the "additive, never overwrite existing
  plugins" requirement (FR-007) — OpenCode loads all plugin-directory files independently, so
  no merge logic is required (unlike Claude's single shared `settings.json`, which needed the
  existing merge-if-owner logic in `patchClaudeSettings`).
- **Rationale**: Matches the existing `--setup` UX (auto-detect + auto-install + clear skip
  message when absent, FR-006) and is the least invasive placement given OpenCode's own
  documented plugin load order (global config → project config → global plugin dir → project
  plugin dir).
- **Alternatives considered**: Requiring the developer to hand-edit `opencode.json`'s `plugin`
  array — rejected; contradicts FR-006's one-command setup requirement.

## R9. Real-time dashboard delivery

- **Decision**: Reuse the existing `traceEvents` `EventEmitter` (shared by `proxy.ts`/
  `otlpReceiver.ts` and the web server for `trace:update`/`trace:done` Socket.io pushes); the new
  `openCodeSession.ts` module emits on the same bus so the existing web UI code needs no changes
  to display OpenCode traces live.
- **Rationale**: Directly satisfies FR-005 with zero new client-side code, consistent with
  Principle III (no unnecessary parallel abstraction).
- **Alternatives considered**: A separate Socket.io namespace for OpenCode — rejected as
  unnecessary given the existing bus is tool-agnostic by design (`TraceEntry` already has no
  tool-specific fields beyond the data already modeled).

## Outstanding items carried into implementation (not spec blockers)

- Exact `message.updated` payload field names for token usage — confirm against
  `@opencode-ai/plugin` types at implementation time (R2 follow-up).
- Whether OpenCode's plugin `client` SDK exposes a synchronous "final usage for this session" call
  usable as a fallback if per-message usage is ever absent — evaluate during implementation; falls
  back to token-counts-only display (FR-004) if unavailable, which is an acceptable degraded mode
  per the spec's edge cases.
