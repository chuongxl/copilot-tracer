# copilot-tracer

Real-time tracing and prompt-refinement companion for **GitHub Copilot CLI**, **Claude Code**, and **VS Code Copilot extension**.

Captures every prompt, response, token usage, AI credits, tool calls, and duration — all in one place. Runs as a background daemon that collects data from all your projects automatically. Includes a web dashboard with project overview and per-project live tracing.

---

## Features

- **Daemon mode** — install once, run forever. Collects traces from all projects automatically
- **Auto project detection** — detects project from `github.copilot.git.repository` in OTLP spans
- **Zero-intrusion capture** — uses Copilot's built-in OTel support. Set env vars, done.
- **Works everywhere** — captures GitHub Copilot CLI, Claude Code, and VS Code Copilot Chat
- **Dashboard** — overview of all projects with token usage, credits, and session counts
- **Live tracer** — real-time trace table per project with detail panel
- **Prompt refinement** — rewrites prompts with stronger instructions and less noise
- **AI Credits tracking** — matches exactly what Copilot terminal reports (e.g. `2.59 cr`)
- **Persistent storage** — SQLite at `~/.copilot-tracer/traces.db`, survives restarts

---

## Quick Start (one-time setup)

```bash
npm install -g copilot-tracer
copilot-tracer --setup --daemon
```

This will:
1. Detect your Copilot CLI and VS Code installation
2. Patch `~/.zshrc` with OTEL env vars
3. Patch VS Code `settings.json` with terminal env vars
4. Enable Claude Code OTLP logs/events and enhanced beta traces
5. Install Claude Code hooks into `~/.claude/settings.json` (merged with any hooks you
   already have — nothing is overwritten)
6. Start the daemon on port 4747

Then apply env vars in your current shell:

```bash
source ~/.zshrc
```

Restart VS Code once, and restart Claude Code to pick up the hooks. After that, the
daemon collects traces from all your Copilot and Claude Code sessions automatically.
Claude Code content flags are enabled by setup so prompts and responses can be
displayed in the local dashboard.

Open **http://localhost:4747** to see the dashboard.

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  copilot-tracer --daemon (runs once, stays running)      │
│                                                          │
│  OTLP Receiver ← Copilot CLI + Claude Code + VS Code                   │
│  (auto-detects project from github.copilot.git.repository)│
│                                                          │
│  SQLite DB → Dashboard + Live Tracer (Socket.io)         │
└─────────────────────────────────────────────────────────┘

Copilot CLI / Claude Code / VS Code Copilot Chat
         │
         │  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4747
         ↓
   POST /v1/traces and /v1/logs (OpenTelemetry OTLP JSON)
         │
         ↓
   copilot-tracer parses spans and events → tokens, credits, tool calls
         │
         ↓
   SQLite DB (~/.copilot-tracer/traces.db)
         │
         ├→ Dashboard: all projects overview
         └→ Live Tracer: real-time per-project view
```

---

## Usage

### Daemon mode (recommended)

```bash
# First time: setup + start daemon
copilot-tracer --setup --daemon

# Subsequent starts
copilot-tracer --daemon

# Custom port
copilot-tracer --daemon --port 8080
```

### Normal mode (legacy)

Per-session mode with optional ACP proxy for live CLI tracing:

```bash
# Web UI only (read from DB)
copilot-tracer --ui web --no-proxy

# With project path
copilot-tracer --ui web --no-proxy --project-path /path/to/repo

# With ACP proxy (wraps copilot CLI)
copilot-tracer --ui web
```

### Setup only

```bash
# Just patch env vars without starting
copilot-tracer --setup
```

---

## Dashboard

Open http://localhost:4747 after starting the daemon.

- **Summary cards** — total projects, sessions, tokens, credits
- **Project cards** — each project shows path, session count, tokens, credits, last active
- **Project filter** — search projects by path, local path, or repository URL
- **Click a project** → opens live tracer filtered to that project
<img width="737" height="410" alt="image" src="https://github.com/user-attachments/assets/dc20653b-8774-46b3-9a42-6e7bb934aded" />

---

## Live Tracer

Real-time trace table for a specific project.

**Table columns:**
| Date/Time | Prompt | AI Credits | Duration | Cached | Written | Reasoning | Skills | Agents | MCPs |

**Interactive features:**
- Click any row → detail panel: full prompt, response, reasoning, call graph
- Click AI Credits → cost breakdown per token type
- Click Reasoning → full reasoning text
- Click Skills / Agents / MCPs → filtered call list
- Real-time updates via Socket.io

<img width="1504" height="742" alt="image" src="https://github.com/user-attachments/assets/f334108f-c587-4228-8120-7dac2f85f90b" />

<img width="1061" height="696" alt="image" src="https://github.com/user-attachments/assets/1555d5a2-dbca-4f1d-b102-3d2865dcee68" />

---

## Prompt Refinement

The web UI includes a prompt optimizer. Click "Refine Prompt" in the trace detail panel.

Techniques applied:
- Role grounding, imperative clarity, output format, chain-of-thought
- Noise removal, constraint injection, redundancy cleanup

---

## CLI Flags

| Flag | Description |
|------|-------------|
| `--daemon` | Run as background daemon (always-on OTLP receiver) |
| `--setup` | Auto-detect and configure env vars |
| `--port <port>` | Web UI port (default: 4747) |
| `--ui <mode>` | UI mode: console \| web \| both (normal mode only) |
| `--no-proxy` | Web/console only, no ACP proxy (normal mode only) |
| `--project-path <path>` | Project source path (normal mode only) |
| `--session <id>` | Custom session ID (normal mode only) |
| `--debug` | Verbose logging |

---

## Manual Setup (alternative)

Add to `~/.zshrc`:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4747
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
export COPILOT_OTEL_ENABLED=true

# Claude Code telemetry
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_ASSISTANT_RESPONSES=1
```

Claude Code exports standard OTLP logs/events and optional beta traces. See
[Anthropic's monitoring documentation](https://code.claude.com/docs/en/monitoring-usage)
for protocol and content controls.

### Claude Code hooks (required for full session capture)

Telemetry alone can't reconstruct a multi-prompt Claude session: its log events are
correlated by `prompt.id` while its spans are correlated by OTLP `traceId`, and neither
key is always present. The result is turns with no token usage that never leave the
`running` state.

So the tracer also registers [hooks](https://code.claude.com/docs/en/hooks), which give
it an ordered, complete lifecycle — every prompt, every tool call, every turn boundary.
The two halves join on `prompt_id`, which Claude documents as matching the OTLP
`prompt.id` attribute:

- **Hooks** own the turn and tool lifecycle.
- **OTLP** enriches those turns with tokens, model and cost.

`copilot-tracer --setup` writes this for you. To add it by hand, merge the following into
`~/.claude/settings.json` (keep any hooks you already have — Claude runs all of them):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "http", "url": "http://localhost:4747/claude/hook", "timeout": 5 }] }
    ]
  }
}
```

Setup subscribes to `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `StopFailure` and `SessionEnd` using the same handler.

The receiver always answers `204 No Content`, which the hooks spec defines as "no
decision", so it can never block a tool call, deny a permission, or stop a turn. If the
daemon isn't running, Claude treats the connection failure as a non-blocking error and
your session continues normally.

If hooks are unavailable (older Claude Code, `disableAllHooks`, remote sessions), the
tracer falls back to its original OTLP-only handling.

For VS Code, add to `~/Library/Application Support/Code/User/settings.json`:

```json
"terminal.integrated.env.osx": {
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4747",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "true",
  "COPILOT_OTEL_ENABLED": "true"
}
```

---

## Storage

Traces persist to `~/.copilot-tracer/traces.db` (SQLite). Safe to keep across sessions.

---

## Build & Publish

```bash
npm install
npx tsc          # compile to dist/
```

To publish a new release to npm:

```bash
# Login first
npm login

# Patch version (1.0.4 → 1.0.5)
bash scripts/publish.sh

# Minor version
bash scripts/publish.sh minor

# Major version
bash scripts/publish.sh major

# Beta pre-release
bash scripts/publish.sh --tag beta --pre beta
```

The script will:
1. Check npm authentication
2. Verify git working tree is clean
3. Type-check + build
4. Verify `better-sqlite3` native module loads
5. Show files that will be published (dry-run preview)
6. Prompt for confirmation
7. `npm publish`, commit the version bump, and create a git tag

After publishing:

```bash
git push && git push origin v<new-version>
```
