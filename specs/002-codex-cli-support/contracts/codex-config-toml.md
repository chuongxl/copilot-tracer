# Contract: Codex `config.toml` `[otel]` Block (written by `--setup`)

## File

`~/.codex/config.toml` (created if the `~/.codex/` directory/file does not yet exist).

## Block format

```toml
# >>> copilot-tracer OTLP config (auto-added) >>>
[otel]
exporter = { otlp-http = { endpoint = "http://localhost:<port>", protocol = "binary" } }
trace_exporter = { otlp-http = { endpoint = "http://localhost:<port>", protocol = "binary" } }
# <<< copilot-tracer <<<
```

`<port>` is the daemon's configured port (same value used for the other tools' env-var blocks).

## Behavior contract

| Existing file state | `--setup` behavior |
|---|---|
| No `~/.codex/config.toml` | Create the file and directory, write the sentinel block. |
| File exists, no `[otel]` table at all | Append the sentinel block; leave the rest of the file byte-for-byte unchanged (FR-008). |
| File exists, sentinel block present, port matches | No-op — report "already configured". |
| File exists, sentinel block present, port differs | Replace only the sentinel block with the new port; rest of file untouched. |
| File exists, a **non-sentinel** `[otel]` table is present | Do not modify the file; print a warning identifying the existing `[otel]` table and instruct the user to add the endpoint manually (FR-009). |
| Codex CLI not detected on the machine (`which codex` fails) | Skip this step entirely, no file touched, no error raised (mirrors existing optional-integration skip behavior). |

## Detection

Codex CLI presence is detected the same way as the existing `detectCopilotCli()` — via `which
codex` (+ best-effort `codex --version`) — before any file is read or written.
