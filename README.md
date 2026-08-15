# copilot-tracer

Real-time tracing and prompt-refinement companion for **GitHub Copilot CLI** and **VS Code Copilot extension**.

Captures every prompt, response, token usage, AI credits, tool calls, and duration — all in one place. Runs as a background daemon that collects data from all your projects automatically. Includes a web dashboard with project overview and per-project live tracing.

---

## Features

- **Daemon mode** — install once, run forever. Collects traces from all projects automatically
- **Auto project detection** — detects project from `github.copilot.git.repository` in OTLP spans
- **Zero-intrusion capture** — uses Copilot's built-in OTel support. Set env vars, done.
- **Works everywhere** — captures both Copilot CLI and VS Code Copilot Chat
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
4. Start the daemon on port 4747

Then apply env vars in your current shell:

```bash
source ~/.zshrc
```

Restart VS Code once. After that, the daemon collects traces from all your Copilot sessions automatically.

Open **http://localhost:4747** to see the dashboard.

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  copilot-tracer --daemon (runs once, stays running)      │
│                                                          │
│  OTLP Receiver ← Copilot CLI + VS Code                   │
│  (auto-detects project from github.copilot.git.repository)│
│                                                          │
│  SQLite DB → Dashboard + Live Tracer (Socket.io)         │
└─────────────────────────────────────────────────────────┘

Copilot CLI / VS Code Copilot Chat
         │
         │  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4747
         ↓
   POST /v1/traces (OpenTelemetry OTLP JSON)
         │
         ↓
   copilot-tracer parses spans → tokens, credits, tool calls
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
- **Click a project** → opens live tracer filtered to that project

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
```

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
