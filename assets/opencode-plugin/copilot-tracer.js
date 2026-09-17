/**
 * copilot-tracer OpenCode plugin.
 *
 * Installed by `copilot-tracer --setup` to `~/.config/opencode/plugins/copilot-tracer.js`
 * (or committed to a project's `.opencode/plugins/` directory). OpenCode loads every file
 * in that directory automatically — no config changes required beyond this file existing.
 *
 * OpenCode has no OTLP export, so this plugin is the tracer's only way to see a session:
 * it forwards the lifecycle events below, verbatim, to the local tracer daemon's
 * `/opencode/hook` endpoint. See specs/001-opencode-support/contracts/opencode-hook.md.
 *
 * Safety: every send is fire-and-forget with its own try/catch. A daemon that is offline,
 * slow, or returns an error must never slow down or break the developer's OpenCode session
 * (FR-006, FR-011).
 */

const TRACER_URL = process.env.COPILOT_TRACER_OPENCODE_URL || 'http://localhost:__PORT__/opencode/hook';

function send(body) {
  try {
    fetch(TRACER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    // Never let a tracer send failure affect the OpenCode session.
  }
}

/** @type {import('@opencode-ai/plugin').Plugin} */
export const CopilotTracerPlugin = async ({ directory }) => {
  return {
    event: async ({ event }) => {
      switch (event.type) {
        case 'session.created':
          send({ event: 'session.created', session_id: event.properties?.info?.id, directory });
          break;

        case 'session.idle':
          send({ event: 'session.idle', session_id: event.properties?.sessionID, directory });
          break;

        case 'session.error':
          send({
            event: 'session.error',
            session_id: event.properties?.sessionID,
            directory,
            error: event.properties?.error,
          });
          break;

        case 'session.deleted':
          send({ event: 'session.deleted', session_id: event.properties?.info?.id, directory });
          break;

        case 'message.updated': {
          const info = event.properties?.info;
          if (!info) break;
          send({
            event: 'message.updated',
            session_id: info.sessionID,
            message_id: info.id,
            directory,
            prompt: info.role === 'user' ? extractText(info) : undefined,
            response: info.role === 'assistant' ? extractText(info) : undefined,
            usage: info.tokens
              ? {
                  input: info.tokens.input,
                  output: info.tokens.output,
                  cache_read: info.tokens.cache?.read,
                  cache_write: info.tokens.cache?.write,
                  model: info.modelID,
                }
              : undefined,
          });
          break;
        }

        default:
          // Not one of the events the tracer subscribes to (file/LSP/permission/TUI/shell,
          // etc.) — ignore it.
          break;
      }
    },

    'tool.execute.before': async (input) => {
      send({
        event: 'tool.execute.before',
        session_id: input.sessionID,
        message_id: input.messageID,
        directory,
        tool_call_id: input.callID,
        tool_name: input.tool,
        tool_input: input.args,
      });
    },

    'tool.execute.after': async (input, output) => {
      send({
        event: 'tool.execute.after',
        session_id: input.sessionID,
        message_id: input.messageID,
        directory,
        tool_call_id: input.callID,
        tool_name: input.tool,
        tool_input: input.args,
        tool_output: output?.output,
        tool_error: output?.metadata?.error,
      });
    },
  };
};

function extractText(info) {
  const parts = info.parts;
  if (!Array.isArray(parts)) return undefined;
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n') || undefined;
}

export default CopilotTracerPlugin;
