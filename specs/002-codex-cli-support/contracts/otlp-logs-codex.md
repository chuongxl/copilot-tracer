# Contract: Codex OTLP Log Events (`POST /v1/logs`)

This describes the inbound contract the daemon accepts from Codex CLI, and the outbound HTTP
response shape — the same route already used (once added) for any OTLP-logs-emitting client, kept
byte-compatible with the OTLP logs JSON schema Codex sends.

## Request

`POST /v1/logs` — standard OTLP `ExportLogsServiceRequest` JSON body (same shape already typed as
`OtlpLogsPayload` in `otlpReceiver.ts`):

```jsonc
{
  "resourceLogs": [
    {
      "resource": { "attributes": [ /* e.g. session.id, working-dir attribute */ ] },
      "scopeLogs": [
        {
          "logRecords": [
            {
              "timeUnixNano": "...",
              "attributes": [
                { "key": "event.name", "value": { "stringValue": "codex.user_prompt" } }
                // ... event-specific attributes
              ],
              "body": { "stringValue": "..." }
            }
          ]
        }
      ]
    }
  ]
}
```

## Recognized event names (v1 scope)

| `event.name` | Required for | Effect |
|---|---|---|
| `codex.conversation_starts` | Session/project bootstrap | Ensures Session (+ Project) exist |
| `codex.user_prompt` | Turn start | Opens a running `TraceEntry` |
| `codex.tool_decision` | Tool visibility | Appends a `ToolCall` |
| `codex.turn_cost` | Cost/usage | Attaches token usage + credits, may close the turn |
| `codex.sse_event` | Usage backfill | Backfills token usage if `turn_cost` was incomplete |

Any other `event.name` (including any not starting with `codex.`) is ignored by the Codex handler
— it does not error, and does not affect other tools' events processed from the same or a
different batch (FR-010).

## Response

- `200 { "partialSuccess": {} }` on any batch that was structurally parseable, even if individual
  unrecognized records inside it were skipped (matches OTLP's partial-success semantics already
  used for the existing routes).
- `400 { "error": "invalid payload" }` only if the top-level payload isn't parseable as an OTLP
  logs export request at all (matches existing `/v1/logs`-style error handling already used for
  Claude Code payloads in `otlpReceiver.ts`'s established pattern, reapplied here since that route
  is being added by this feature).

## Non-goals

- No new response codes, headers, or top-level payload shape beyond the existing OTLP contract —
  Codex is expected to send standard OTLP, not a Codex-specific wire format.
- No breaking change to `/v1/traces` or its existing Copilot-CLI request/response contract.
