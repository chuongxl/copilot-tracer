# copilot-tracer

Real-time tracing and monitoring tool for **GitHub Copilot CLI** and **VS Code Copilot extension**.

Captures every prompt, response, token usage, AI credits, tool calls, skill invocations and duration — all in one place. Works via native **OpenTelemetry (OTLP)** integration built into GitHub Copilot. No wrapper, no binary replacement, no ACP proxy needed.

---

## Features

- **Zero-intrusion capture** — uses Copilot's built-in OTel support. Set 2 env vars, done.
- **Works everywhere** — captures both Copilot CLI (`copilot -p "..."`) and VS Code Copilot Chat
- **Real-time web UI** — live dashboard at `http://localhost:4747` with dark theme
- **Full prompt & response** — see exactly what you sent and what Copilot replied
- **Token breakdown** — input, output, cached, reasoning, written tokens per request
- **AI Credits tracking** — matches exactly what Copilot terminal reports (e.g. `2.59 cr`)
- **Tool call visibility** — see every tool/skill/MCP invoked during a session
- **Persistent storage** — SQLite at `~/.copilot-tracer/traces.db`, survives restarts
- **Console + Web UI** — CLI table view or browser dashboard, your choice

---

## Prerequisites

- Node.js v18+ (tested on v24)
- GitHub Copilot CLI (`copilot` command available in terminal)
- VS Code 1.99+ with built-in Copilot (no extension install needed)

---

## Install

```bash
git clone <repo> /Users/chuongnd/copilot-tracer
cd /Users/chuongnd/copilot-tracer
npm install
npx tsc          # compile TypeScript → dist/
```

---

## Setup (one-time)

Run the auto-setup command. It detects your Copilot CLI and VS Code installation and injects the required config automatically:

```bash
node dist/cli.js --setup
```

What it does:
- Detects `copilot` CLI path and version
- Detects VS Code version and confirms built-in Copilot
- Patches `~/.zshrc` (or `~/.bashrc`) with OTEL env vars
- Patches VS Code `settings.json` with `terminal.integrated.env.osx` block

Example output:
```
✅ GitHub Copilot CLI detected — /usr/bin/copilot v1.0.77
✅ Visual Studio Code detected — 1.131.0 (Built-in Copilot)
✅ Shell profile patched: .zshrc
✅ VS Code settings patched
```

Then apply the env vars:

```bash
source ~/.zshrc
```

Restart VS Code completely (Cmd+Q, then reopen).

---

## Manual Setup (alternative)

If you prefer to configure manually, add these to `~/.zshrc`:

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

## Start Tracer

```bash
cd /Users/chuongnd/copilot-tracer
node dist/cli.js --ui web --port 4747 --no-proxy
```

Open **http://localhost:4747** — shows "waiting for copilot CLI activity".

---

## Use Copilot Normally

No change to how you use Copilot. Just run as usual:

```bash
# Copilot CLI
copilot -p "how to convert microservice to modular" --allow-all-tools

# Or use Copilot Chat in VS Code
```

Traces appear instantly in the web UI as each request completes.

---

## How It Works

```
copilot CLI  /  VS Code Copilot Chat
         |
         |  reads OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4747
         |
         ↓  POST /v1/traces  (OpenTelemetry OTLP JSON)
  copilot-tracer OTLP receiver
         |
         ↓
  Parse spans → extract prompt, response, tokens, credits, tool calls
         |
         ↓
  SQLite DB  (~/.copilot-tracer/traces.db)
         |
         ↓
  Web UI (Socket.io real-time)  +  Console table
```

Copilot has built-in OpenTelemetry instrumentation. When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, it pushes all trace data to that endpoint automatically — both CLI and VS Code extension.

---

## Web UI

Open http://localhost:4747 after starting the tracer.

**Table columns:**
| Date/Time | Prompt | AI Credits | Duration | Cached | Written | Reasoning | Skills | Agents | MCPs |

**Interactive features:**
- Click any row → detail panel: full prompt, full response, reasoning text, call graph
- Click AI Credits → cost breakdown per token type
- Click Reasoning count → full reasoning text
- Click Skills / Agents / MCPs pill → filtered call list with input/output/duration
- Real-time updates via Socket.io — no page refresh needed
- Dark theme

---

## Console UI

```bash
node dist/cli.js --ui console --no-proxy
```

Live updating table in terminal. Same columns as web UI. TOTALS row pinned at top.

---

## CLI Flags

| Flag | Description |
|------|-------------|
| `--ui web` | Start web UI (default) |
| `--ui console` | Start console table UI |
| `--ui both` | Both web + console |
| `--port 4747` | Web UI port (default: 4747) |
| `--no-proxy` | Web/console only, no ACP proxy |
| `--session <id>` | Custom session ID |
| `--setup` | Auto-detect and configure env vars |
| `--debug` | Verbose logging |

---

## Storage

Traces persist to `~/.copilot-tracer/traces.db` (SQLite). Safe to keep across sessions.

To test the web UI without running a live Copilot session:

```bash
node test-seed.mjs   # seeds 4 sample traces
node dist/cli.js --ui web --no-proxy --session test-session-001
```

---

## Build

```bash
npm install
npx tsc          # compile to dist/
```
