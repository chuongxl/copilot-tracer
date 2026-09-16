# Quickstart: Verifying Codex CLI Trace Support

## Prerequisites

- Repo built: `npx tsc` (or run from source via `npm run dev`).
- No real Codex CLI install required for this check — the OTLP contract is verified by POSTing a
  synthetic payload shaped like Codex's real output (same approach `test-claude-hooks.mjs` uses
  for Claude Code).

## 1. Start the daemon against a throwaway DB

```bash
COPILOT_TRACER_HOME=/tmp/copilot-tracer-codex-test npm run dev -- --daemon --port 4747
```

## 2. Send a synthetic Codex OTLP log batch

```bash
node test-codex-otlp.mjs
```

This script (added by this feature, modeled on `test-claude-hooks.mjs`) POSTs a small
`resourceLogs` batch to `http://localhost:4747/v1/logs` containing, in order:
`codex.conversation_starts` → `codex.user_prompt` → `codex.tool_decision` → `codex.turn_cost`,
all sharing one Codex session id and a working-directory resource attribute.

## 3. Verify ingestion

```bash
curl -s "http://localhost:4747/api/dashboard" | jq '.projects[] | select(.path | contains("codex-test"))'
curl -s "http://localhost:4747/api/traces?sessionId=<the-test-session-id>" | jq .
```

Expected:
- A project is present for the test working directory.
- One trace entry with `status: "done"`, a non-empty `toolCalls` array, and non-zero
  `tokens.input`/`tokens.output`.
- `aiCredits` is a positive number computed via `calcCodexCredits`.

## 4. Confirm no regression to existing tools

```bash
node test-seed.mjs
curl -s "http://localhost:4747/api/dashboard" | jq '.totals'
```

Expected: the existing seeded Copilot CLI traces still appear with unchanged totals — Codex
ingestion must not alter unrelated projects/sessions (SC-004).

## 5. Unknown-event resilience check

Extend `test-codex-otlp.mjs`'s payload with one extra log record whose `event.name` is
`codex.some_future_event` (not in the recognized table) in the same batch as a recognized event,
and confirm:
- The daemon does not crash (`curl http://localhost:4747/api/dashboard` still responds `200`).
- The recognized event in the same batch is still processed (SC-005).

## 6. `--setup` Codex config check (manual, requires local Codex CLI)

```bash
copilot-tracer --setup --daemon --port 4747
cat ~/.codex/config.toml
```

Expected: an `[otel]` sentinel block pointing at `http://localhost:4747`, with any pre-existing
content in the file left untouched.
