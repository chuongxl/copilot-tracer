# AGENTS.md

## Build & Dev

- `npm install` — installs deps + runs `tsc` via `prepare` script
- `npx tsc` — compile `src/` → `dist/`
- `npm run dev` — run dev mode via `tsx src/cli.ts` (no build needed)
- `npm run web` — web UI only
- `npm run console` — console UI only
- `npm start` — run compiled version

## Type-check

- `npx tsc --noEmit` — type-check only (no output). Run before publishing.

## Verification scripts

There is no test framework. Verification runs through plain Node scripts:
- `npm run test:work-items` runs work-item extraction and persistence checks against a throwaway DB
- `npm run verify:work-items` boots a real daemon on a free port, feeds it OTLP spans, and exercises the work-item HTTP API
- `node test-claude-hooks.mjs` runs end-to-end Claude hook + OTLP checks against a throwaway DB
- `node test-seed.mjs` seeds 4 sample traces to SQLite
- Then `npm run dev -- --daemon --port 4747`
- Verify via `curl http://localhost:4747/api/dashboard`

## No linter/formatter

No ESLint, Prettier, or other lint/format tools are configured. Follow existing code style.

## Architecture

- **ESM project** (`"type": "module"` in package.json). Use `.js` extensions in imports.
- **SQLite** via `better-sqlite3` (native module). DB at `~/.copilot-tracer/traces.db`.
- **Daemon mode** (`--daemon`) — always-on OTLP receiver, collects all traces.
- **Normal mode** — per-session with optional ACP proxy for live CLI tracing.
- **Web UI** is a single vanilla JS file at `web/index.html` with Socket.io client. No build step for frontend.
- **OTLP receiver** (`src/otlpReceiver.ts`) — parses OpenTelemetry spans from Copilot. Extracts `github.copilot.git.repository` for auto project detection.
- **Claude Code hooks** (`src/claudeHooks.ts` → `src/claudeSession.ts`) — `POST /claude/hook` receives Claude's turn/tool lifecycle. Hooks own the lifecycle, OTLP enriches it with tokens/model/cost, joined on `prompt_id` = OTLP `prompt.id`. Falls back to OTLP-only when hooks aren't configured. The endpoint must always return `204` so it never blocks a Claude session.
- **Credit calculation** lives in `src/proxy.ts` with model-specific rate tables.
- **Data model**: `Project → Session → Trace` hierarchy. Projects auto-created from repo URL.
- **Work items** (`src/workItemExtraction.ts`, `src/workItemService.ts`) — traces are grouped by ticket reference. Extraction is pure and deterministic; `upsertTrace` fires a single registered listener (`setTracePersistedListener`) so every ingestion path is covered without patching each call site. `installWorkItemExtraction()` runs once in `startWebServer`.

## Key CLI Flags

| Flag | Description |
|------|-------------|
| `--daemon` | Run as background daemon (always-on OTLP receiver) |
| `--setup` | Auto-detect copilot CLI + VS Code, patch env vars |
| `--setup --daemon` | First-time setup + start daemon in one command |
| `--project-path <path>` | Project source path (normal mode) |
| `--port <port>` | Web UI port (default: 4747) |

## Publishing

- `bash scripts/publish.sh` — patch bump, type-check, build, verify native module, publish to npm, git tag
- Requires `npm login` first and clean git working tree
- After publish: `git push && git push origin v<version>`

## Gotchas

- `better-sqlite3` is a native C++ addon — if it fails to load, run `npm install better-sqlite3@latest && npx tsc`
- OTLP span attribute names from Copilot are dot-separated (e.g. `gen_ai.usage.cache_read.input_tokens`)
- The `prepare` script runs `tsc` on every `npm install` — if build fails, install fails
- `github.copilot.git.repository` is a span attribute on `invoke_agent` spans, used for auto project detection
- The `.gitignore` has a formatting issue (backslashes instead of newlines), but git still works correctly
