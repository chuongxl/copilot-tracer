---
name: copilot-tracer
description: "Node.js ACP proxy tool that intercepts GitHub Copilot CLI traffic and displays real-time token usage, AI credits, MCP/skill/agent call tracing in console + web UI."
version: 1.0.0
author: CLV
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [copilot, debug, tracing, observability, ACP, nodejs, tokens, MCP]
---

# Copilot Tracer

Real-time monitor and tracing tool for GitHub Copilot CLI.
Intercepts ACP (Agent Client Protocol) stdio traffic, stores to SQLite, and renders a console table + web dashboard.

## Location

/Users/chuongnd/copilot-tracer

## Tech Stack

- ACP proxy: Node.js readline intercepting copilot --acp --stdio
- Storage: better-sqlite3 (~/.copilot-tracer/traces.db)
- Console UI: cli-table3 + chalk — refreshes on every trace event
- Web UI: Express + Socket.io + vanilla JS — real-time push, dark theme
- Language: TypeScript (ESM), built to dist/

## How It Works

```
stdin → copilot-tracer (ACP proxy) → copilot --acp --stdio → stdout
                    ↓
              SQLite DB + EventEmitter
                    ↓
         Console table + Web UI (Socket.io)
```

Intercepts three ACP event types:
- conversation/turn — new prompt (start trace)
- tools/call — MCP/skill/agent invocation
- conversation/turn/complete — tokens, reasoning, response

## Usage

```bash
cd /Users/chuongnd/copilot-tracer
npm link
copilot-tracer               # proxy + console + web (default)
copilot-tracer --ui web      # web only
copilot-tracer --ui console  # console only
copilot-tracer --no-proxy    # read from DB, no proxy
copilot-tracer --port 8080   # custom port (default 4747)
```

Web UI: http://localhost:4747

## Console Table Columns

Date/Time | Prompt | AI Credits | Duration | Cached | Written | Reasoning | Skills | Agents | MCPs

- TOTALS row pinned at top (session totals)
- Color coded: green=done, yellow=running, red=error

## Web UI Features

- Live table with same columns as console
- Click row → detail panel: prompt, reasoning, response, call graph
- Click Reasoning tokens → full reasoning text + expandable call graph
- Click AI Credits → cost breakdown per token type
- Click Skills/Agents/MCPs pill → filtered call list with input/output/duration
- Real-time updates via Socket.io (no page refresh needed)

## AI Credit Calculation

- Input: $0.003 per 1k tokens
- Written (output): $0.006 per 1k tokens
- Reasoning: $0.009 per 1k tokens

## Tool Type Detection

Tool names auto-classified:
- starts with mcp_ or contains / → MCP
- contains skill or hermes → Skill
- contains agent or delegate → Agent
- else → Builtin

## Pitfalls

- better-sqlite3 native build fails on Node 24 with gyp error. Fix: `npm install better-sqlite3@latest` (upgrade, do NOT just --ignore-scripts + rebuild — rebuild will also fail). Verify with: `node -e "require('better-sqlite3')"` → exit 0.
- Session INSERT must use `INSERT OR REPLACE` not `INSERT` — re-running with same session ID will crash with SQLITE_CONSTRAINT_PRIMARYKEY otherwise.
- commander method is `.allowUnknownOption()` (singular), NOT `.allowUnknownOptions()` — TypeScript will catch this but easy to miss.
- ACP message shape varies by Copilot CLI version. The proxy handles conversation/turn and tools/call but Copilot may use different method names. Check raw stdio output if traces are empty.
- TypeScript build: npx tsc --noEmit to check errors first, then npx tsc to emit to dist/.
- Web server endpoint for session summary is `/api/summary`, not `/api/session`. Pass `?sessionId=<id>` query param.

## Test Data Seeding

To test the web UI without a live Copilot session:

```bash
node test-seed.mjs   # seeds 4 sample traces to ~/.copilot-tracer/traces.db
node dist/cli.js --ui web --no-proxy --session test-session-001
# then open http://localhost:4747
```

Verify all endpoints:
```bash
curl "http://localhost:4747/api/traces?sessionId=test-session-001"
curl "http://localhost:4747/api/traces/<id>"
curl "http://localhost:4747/api/summary?sessionId=test-session-001"
```

## Build Commands

```bash
npm install
npx tsc          # compile to dist/
npm link         # register global command
```
