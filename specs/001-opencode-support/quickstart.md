# Quickstart: Validating OpenCode Host Support

Manual validation guide (this repo has no automated test runner — constitution Principle IV).
Run these steps after implementation to confirm the feature end-to-end.

## Prerequisites

- `npm install && npx tsc` (or `npm run dev` for unbuilt runs)
- OpenCode installed locally (`opencode --version`) — optional; steps 1–2 work without it using a
  simulated hook POST, step 3 requires a real OpenCode install

## 1. Start the daemon

```bash
npm run dev -- --daemon --port 4747
```

## 2. Simulate an OpenCode session without installing OpenCode

Confirm the endpoint and ingestion path work in isolation:

```bash
SID="test-opencode-session-1"
MID="msg-1"

curl -s -X POST http://localhost:4747/opencode/hook -H 'Content-Type: application/json' -d '{
  "event": "session.created", "session_id": "'"$SID"'", "directory": "'"$(pwd)"'"
}'

curl -s -X POST http://localhost:4747/opencode/hook -H 'Content-Type: application/json' -d '{
  "event": "message.updated", "session_id": "'"$SID"'", "message_id": "'"$MID"'",
  "prompt": "Explain the auth flow", "response": "The auth flow works by...",
  "usage": {"input": 120, "output": 340, "model": "claude-sonnet-4-6"}
}'

curl -s -X POST http://localhost:4747/opencode/hook -H 'Content-Type: application/json' -d '{
  "event": "tool.execute.before", "session_id": "'"$SID"'", "message_id": "'"$MID"'",
  "tool_call_id": "tc-1", "tool_name": "bash", "tool_input": {"command": "ls"}
}'

curl -s -X POST http://localhost:4747/opencode/hook -H 'Content-Type: application/json' -d '{
  "event": "tool.execute.after", "session_id": "'"$SID"'", "message_id": "'"$MID"'",
  "tool_call_id": "tc-1", "tool_name": "bash", "tool_output": "index.html\nsrc\n"
}'

curl -s -X POST http://localhost:4747/opencode/hook -H 'Content-Type: application/json' -d '{
  "event": "session.idle", "session_id": "'"$SID"'"
}'
```

Every call above **must** return HTTP 204 with no body (`curl -i` to confirm the status line if
needed) — this is the safety contract, not just a happy-path detail.

## 3. Verify ingestion

```bash
curl -s "http://localhost:4747/api/dashboard" | grep -o "\"sessionCount\":[0-9]*" | head -1
curl -s "http://localhost:4747/api/traces?sessionId=test-opencode-session-1"
curl -s "http://localhost:4747/api/summary?sessionId=test-opencode-session-1"
```

**Expected outcomes**:
- The dashboard's project/session count reflects the new session.
- `/api/traces` returns one trace entry with `prompt`, `response`, `status: "done"`, non-zero
  `tokens.input`/`tokens.output`, a computed `aiCredits` value (see
  [research.md](./research.md#r7-how-is-token-usage-priced-for-opencode-sessions)), and one
  `toolCalls` entry named `bash` with `type: "builtin"` (see
  [data-model.md](./data-model.md#opencode-tool-call--toolcall)).
- `/api/summary` totals include this session's tokens/credits.

## 4. Verify idempotency (re-send is a no-op, not a duplicate)

Re-run the `message.updated` and `tool.execute.after` curl calls from step 2 unchanged, then
re-check `/api/traces?sessionId=test-opencode-session-1` — the trace/tool-call count MUST be
unchanged (one trace, one tool call), confirming the `(session_id, message_id)` /
`(message_id, tool_call_id)` idempotency keys from
[data-model.md](./data-model.md#new-in-memory-state-not-persisted-as-new-tables) work.

## 5. Verify real OpenCode `--setup` integration (requires OpenCode installed)

```bash
npm run dev -- --setup --daemon --port 4747
```

**Expected outcome**: setup output includes an "OpenCode plugin installed" confirmation (or a
clear skip message if OpenCode isn't detected on `PATH`, per FR-006), and
`~/.config/opencode/plugins/copilot-tracer.js` exists afterward. Then run a real, short OpenCode
session (`opencode run "list the files in this repo"` or an interactive prompt) and confirm:

```bash
curl -s "http://localhost:4747/opencode/hook/health"
```

shows `received > 0` and the new session/trace appears in the dashboard within a few seconds,
without a page refresh (Socket.io live update, FR-005/SC-001).

## 6. Regression check for existing tools

Re-run the existing seed/manual checks for Copilot CLI and Claude Code (`node test-seed.mjs`,
`node test-claude-hooks.mjs`) and confirm both still pass unchanged, satisfying SC-004 (zero
regression on existing ingestion paths).
