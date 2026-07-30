# copilot-tracer

Real-time monitor and tracing tool for GitHub Copilot CLI.
Tracks every prompt, token usage, AI credits, MCP/skill/agent calls — with console UI and web UI.

## Install

```bash
cd /Users/chuongnd/copilot-tracer
npm install
npm run build
npm link   # makes `copilot-tracer` available globally
```

## Usage

### Wrap Copilot CLI (ACP proxy mode)

```bash
# Instead of: copilot --acp --stdio
copilot-tracer --ui both
```

This starts the tracer proxy, console UI and web UI at http://localhost:4747.
All Copilot CLI traffic is intercepted, stored and displayed in real time.

### Web UI only (read from DB)
```bash
copilot-tracer --ui web --no-proxy
```

### Console UI only
```bash
copilot-tracer --ui console
```

### Custom port
```bash
copilot-tracer --port 8080
```

## How it works

```
You (stdin)
    ↓
copilot-tracer (ACP proxy)  ←→  SQLite DB (~/.copilot-tracer/traces.db)
    ↓                                      ↓
copilot --acp --stdio              Console UI + Web UI (Socket.io)
    ↓
GitHub Copilot (stdout)
```

## Console UI Columns

| Date/Time | Prompt | AI Credits | Duration | Cached | Written | Reasoning | Skills | Agents | MCPs |

- TOTALS row always shown at top
- Color coded: green=done, yellow=running, red=error

## Web UI Features

- Live table with same columns as console
- Click any row → detail panel (prompt, reasoning, response, call graph)
- Click Reasoning tokens → drill into reasoning text + full call graph
- Click AI Credits → cost breakdown per token type
- Click Skills/Agents/MCPs pill → filtered call list with input/output
- Real-time updates via Socket.io (no refresh needed)
- Dark theme, mobile-friendly

## Data stored

~/.copilot-tracer/traces.db — SQLite, persists across sessions.
