# Contract: `POST /opencode/hook`

Local-only HTTP endpoint the tracer daemon exposes for the OpenCode plugin to call. Mirrors the
existing `POST /claude/hook` contract in `src/claudeHooks.ts` exactly, so this document only
states where OpenCode's event vocabulary differs.

## Endpoint

```
POST http://localhost:<port>/opencode/hook
Content-Type: application/json
```

## Safety Contract (mandatory, non-negotiable)

- **Always responds `204 No Content`**, regardless of payload validity, to guarantee the hook can
  never block, delay, or alter the developer's OpenCode session (a 2xx with empty body is a
  documented "no decision" outcome). No other response code is emitted for this specific route.
- **Never throws uncaught.** Any parsing/processing error is caught, logged (respecting
  `COPILOT_TRACER_DEBUG`), and the request still gets a `204`.
- **No blocking work.** Handling is in-memory bookkeeping plus a single SQLite upsert, matching
  `/claude/hook`'s existing performance envelope.

## Request Body

```jsonc
{
  "event": "session.created | message.updated | tool.execute.before | tool.execute.after | session.idle | session.error",
  "session_id": "string, OpenCode's session id (required to process the event)",
  "message_id": "string, OpenCode's message id (required for message/tool events)",
  "directory": "string, absolute path OpenCode is running in (used for project resolution)",
  "prompt": "string, present on the message that started the turn",
  "response": "string, present on message.updated when assistant content is available",
  "tool_call_id": "string, present on tool.execute.before/after",
  "tool_name": "string, present on tool.execute.before/after",
  "tool_input": "object, present on tool.execute.before",
  "tool_output": "any, present on tool.execute.after",
  "tool_error": "string | object, present on a failed tool.execute.after",
  "usage": {
    "input": "number, optional — present when OpenCode reports it for this message",
    "output": "number, optional",
    "cache_read": "number, optional",
    "cache_write": "number, optional",
    "model": "string, optional — model id used for this message, for pricing lookup"
  },
  "error": "string | object, present on session.error"
}
```

Unknown/extra fields are ignored, not rejected — an OpenCode plugin/version update that adds new
fields must never break ingestion (FR-009).

## Response

```
204 No Content
```

Always, for every request to this path — including malformed JSON (handled by an error-handling
middleware scoped to `/opencode/hook`, matching the existing pattern for `/claude/hook`).

## Diagnostics Endpoint

```
GET /opencode/hook/health
```

Returns the same shape as `/claude/hook/health` (`{ ok, receiver: 'opencode-hooks', received,
byEvent, sessionCount, sessions, firstAt, lastAt, lastPayload }`), so `--setup` and users can
confirm the OpenCode plugin is actually delivering events, the same way Claude hook health is
checked today.

## Idempotency

Events for the same `(session_id, message_id)` (turn-level) or `(message_id, tool_call_id)`
(tool-call-level) are upserts, not inserts — a redelivered event never creates a duplicate
`TraceEntry` or `ToolCall` (FR-009, spec Clarifications).
