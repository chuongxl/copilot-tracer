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

## No test suite

There is no test framework or test script. Manual testing only:
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
- **OpenCode hook receiver** (`src/openCodeHooks.ts` → `src/openCodeSession.ts`) — `POST /opencode/hook` receives lifecycle events (`session.created`, `message.updated`, `tool.execute.before/after`, `session.idle`, `session.error`) from the OpenCode plugin at `assets/opencode-plugin/copilot-tracer.js`. OpenCode has no OTLP export, so this hook is the single source of truth for a turn's lifecycle, content, and usage — unlike the OTLP path there's no separate enrichment step. Idempotency key: `(session_id, message_id)` for turns, `(message_id, tool_call_id)` for tool calls. Turns with no completion signal for 30 min are auto-closed as errored. The endpoint must always return `204` so it never blocks an OpenCode session.
- **Credit calculation** lives in `src/proxy.ts` with model-specific rate tables (Copilot), and `src/openCodePricing.ts` (OpenCode's provider-agnostic model table; unknown models fall back to zero cost).
- **Data model**: `Project → Session → Trace` hierarchy. Projects auto-created from repo URL.

## Key CLI Flags

| Flag | Description |
|------|-------------|
| `--daemon` | Run as background daemon (always-on OTLP receiver) |
| `--setup` | Auto-detect copilot CLI + VS Code + OpenCode, patch env vars / install OpenCode plugin |
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
- OpenCode's plugin event field names come from `@opencode-ai/plugin` (session/message/tool payload shapes), not from any spec doc — verify against that package's types if events stop mapping cleanly
- `COPILOT_TRACER_OPENCODE_URL` overrides the OpenCode plugin's target URL (defaults to `http://localhost:<port>/opencode/hook`), for pointing a globally-installed plugin at a non-default port
