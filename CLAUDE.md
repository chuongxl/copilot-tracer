# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`copilot-tracer` is a CLI + local web dashboard that captures OpenTelemetry traces from GitHub Copilot CLI, Claude Code, and the VS Code Copilot extension, storing them in SQLite and displaying token usage, AI credits, tool/skill/agent calls, and prompt/response content.

## Commands

```bash
npm install              # installs deps + runs tsc via the `prepare` script
npx tsc                  # compile src/ → dist/
npx tsc --noEmit         # type-check only — run before publishing
npm run dev              # tsx src/cli.ts (no build needed)
npm run dev -- --daemon --port 4747   # run daemon mode from source
npm run web              # web UI only (tsx src/cli.ts --ui web)
npm run console          # console UI only
npm start                # run compiled dist/cli.js
```

No test framework or lint/format tooling is configured. Manual verification only:

```bash
node test-claude-hooks.mjs                          # end-to-end Claude hook+OTLP checks (self-contained)
node test-seed.mjs                                  # seeds 4 sample traces into ~/.copilot-tracer/traces.db
npm run dev -- --daemon --port 4747                  # or: node dist/cli.js --ui web --no-proxy --session test-session-001
curl "http://localhost:4747/api/dashboard"
curl "http://localhost:4747/api/traces?sessionId=<id>"
curl "http://localhost:4747/api/traces/<id>"
curl "http://localhost:4747/api/summary?sessionId=<id>"
```

Publishing (`bash scripts/publish.sh [minor|major] [--tag beta --pre beta]`) requires `npm login` and a clean git tree; it type-checks, builds, verifies `better-sqlite3` loads, publishes, commits the version bump, and tags. Push after with `git push && git push origin v<version>`.

## Architecture

Two independent data-ingestion paths feed the same SQLite store and web UI, selected by CLI mode:

1. **Daemon mode** (`--daemon`, primary/recommended): `src/webServer.ts` registers OTLP HTTP routes (`src/otlpReceiver.ts`) that receive `POST /v1/traces` and `/v1/logs` from any tool exporting standard OpenTelemetry (Copilot CLI, Claude Code, VS Code). It parses spans/log records into `TraceEntry` rows, auto-detects the project from span/attribute data (`github.copilot.git.repository`, or Claude Code's working-directory attributes), and auto-creates a `Project` per repo. Always-on, collects from every project at once.
2. **Normal/legacy mode**: `src/cli.ts` spawns the real `copilot` CLI as a child process (`copilot --acp --stdio`) and pipes stdin/stdout through readline, feeding each JSON-RPC line to `src/proxy.ts` (`handleAcpMessage`), which tracks ACP request/response pairs (`conversation/turn`, `tools/call`, `conversation/turn/complete`) into `TraceEntry` objects and computes credits inline. Scoped to one session/project at a time; `--no-proxy` runs the UI against the DB without wrapping a live CLI.

Data model (`src/types.ts`, tables in `src/db.ts`): `Project → Session → Trace`, where each `TraceEntry` embeds token usage (`TokenUsage`), computed `aiCredits`, and a `ToolCall[]` tree (each call tagged `mcp | skill | agent | builtin` via `detectToolType` — implemented separately in `proxy.ts` and `otlpReceiver.ts` since they parse different wire formats, plus `detectClaudeToolType` in `claudeSession.ts` for Claude's own tool vocabulary where `Task` means subagent and `Skill` means skill). Copilot credit calculation (rate tables per token type/model) lives in `src/proxy.ts`; Anthropic rates live in `src/claudePricing.ts`, shared by `otlpReceiver.ts` and `claudeSession.ts`. Keep the Copilot and Anthropic tables in sync when adjusting pricing.

**Claude Code uses a third, hybrid path.** OTLP alone can't reconstruct a multi-prompt Claude session — its log events correlate on `prompt.id` while its spans correlate on OTLP `traceId`, and neither key is always present, so turns end up with no token usage and stuck at `status: 'running'`. So Claude Code also posts its lifecycle to `POST /claude/hook` (`src/claudeHooks.ts`) as a native `type: "http"` hook. `src/claudeSession.ts` owns the resulting state: **hooks own the turn/tool lifecycle, OTLP enriches those turns with tokens/model/cost**, joined on `prompt_id` (documented to equal the OTLP `prompt.id` attribute). `isHookTracked(sessionId)` gates this — when a session has produced hook events the OTLP handlers stop claiming the lifecycle and only enrich; otherwise the original OTLP-only path runs unchanged as a fallback. The hook receiver always answers `204 No Content` ("no decision") so it can never block a tool call or stop a turn.


The web UI (`src/webServer.ts` + `web/index.html`) is a single vanilla-JS file with a Socket.io client — no frontend build step. It serves the dashboard (`/api/dashboard`, all projects), the live per-project/session tracer (`/api/traces`, `/api/traces/:id`, `/api/summary`), and a prompt-refinement endpoint (`/api/refine`). Socket.io pushes `trace:update`/`trace:done` events emitted from `traceEvents` (an `EventEmitter` shared between `proxy.ts`/`otlpReceiver.ts` and the console UI/web server) for real-time updates without polling.

`src/setup.ts` (`--setup`) auto-detects the Copilot CLI and VS Code, then patches `~/.zshrc` and VS Code's `settings.json` with the OTEL env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `CLAUDE_CODE_ENABLE_TELEMETRY`, etc.) needed to point those tools' OTLP exporters at the local daemon.

## Gotchas

- ESM project (`"type": "module"`) — imports must use `.js` extensions even for `.ts` source files.
- `better-sqlite3` is a native addon; if it fails to load, `npm install better-sqlite3@latest && npx tsc` (upgrade, not just rebuild).
- Session `INSERT` must be `INSERT OR REPLACE` — re-running with the same session ID otherwise hits `SQLITE_CONSTRAINT_PRIMARYKEY`.
- Commander's method is `.allowUnknownOption()` (singular).
- ACP message shapes vary by Copilot CLI version; use `--debug` to dump raw stdio traffic (also logged to `/tmp/copilot-tracer-<session>.ndjson`) if traces come up empty.
- OTLP span/attribute names are dot-separated (e.g. `gen_ai.usage.cache_read.input_tokens`); Claude Code and Copilot CLI don't use identical attribute names, so `otlpReceiver.ts` has separate parsing paths for each (`processClaudeLogRecord`/`processClaudeLogs` vs `processSpans`).
- `src/setup.ts` merges its Claude hooks into `~/.claude/settings.json` rather than replacing the `hooks` block — users and plugins register their own handlers on the same events (this repo's own `.claude/settings.json` has graft hooks on four of them). Never rewrite that key wholesale.
- `COPILOT_TRACER_HOME` overrides the SQLite directory; `test-claude-hooks.mjs` uses it to run the real daemon against a throwaway DB.
- The web server's per-session endpoint is `/api/summary` (not `/api/session`), filtered via `?sessionId=`.

## Spec-driven workflow

This repo uses GitHub Spec Kit (`.specify/`, `.speckit/`, `.github/skills/speckit-*`). Feature work is tracked under `specs/<feature-slug>/` (`spec.md`, `plan.md`, `tasks.md`, `analyze.md`, `checklists/`) before/alongside implementation — check there for the intent behind a change before assuming behavior is undocumented.
