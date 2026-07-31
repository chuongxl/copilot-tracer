/**
 * OTLP HTTP receiver — accepts traces pushed by GitHub Copilot CLI
 *
 * REAL attribute names (verified from live traffic Jul 31 2026):
 *   invoke_agent span attrs:
 *     gen_ai.input.messages          — user prompt (JSON string)
 *     gen_ai.output.messages         — assistant response (JSON string)
 *     gen_ai.usage.input_tokens
 *     gen_ai.usage.output_tokens
 *     gen_ai.usage.cache_read.input_tokens   (NOT cache_read_input_tokens)
 *     github.copilot.cost            — AI credits (NOT github.copilot.ai_credits)
 *     gen_ai.request.model
 *     github.copilot.context.skills
 *   chat <model> span attrs: same as above
 *   User message event: github.copilot.user.message
 */

import type { Express } from 'express';
import { randomUUID } from 'crypto';
import type { TraceEntry, ToolCall } from './types.js';
import { upsertTrace, createSession, getTraces, deleteTrace } from './db.js';
import { traceEvents } from './proxy.js';

// ── Types for OTLP JSON format ────────────────────────────────────────────────
interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; intValue?: number | string; doubleValue?: number; boolValue?: boolean; kvlistValue?: { values: OtlpKeyValue[] } };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpKeyValue[];
  status?: { code?: number; message?: string };
  events?: Array<{ name: string; timeUnixNano: string; attributes?: OtlpKeyValue[] }>;
}

interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: Array<{
    scope?: { name?: string };
    spans?: OtlpSpan[];
  }>;
}

interface OtlpTracesPayload {
  resourceSpans?: OtlpResourceSpans[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getAttr(attrs: OtlpKeyValue[] | undefined, key: string): string | number | undefined {
  const kv = attrs?.find(a => a.key === key);
  if (!kv) return undefined;
  const v = kv.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === 'string' ? parseInt(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  return undefined;
}

function nanoToMs(nano: string | number): number {
  return Math.round(Number(BigInt(nano) / 1_000_000n));
}

function nanoToIso(nano: string | number): string {
  return new Date(nanoToMs(nano)).toISOString();
}

// ── State: in-flight agent invocations keyed by traceId ──────────────────────
interface InFlight {
  entry: TraceEntry;
  toolCalls: Map<string, ToolCall>;  // spanId → ToolCall
  agentSpanId: string;
}

const inFlight = new Map<string, InFlight>();  // traceId → InFlight

// Sessions we've created in DB (avoid duplicate createSession calls)
const knownSessions = new Set<string>();

function ensureSession(sessionId: string) {
  if (!knownSessions.has(sessionId)) {
    createSession(sessionId);
    knownSessions.add(sessionId);
  }
}

// ── Process one batch of spans ────────────────────────────────────────────────
// Track standalone chat entries so invoke_agent can replace them (multiple chat spans per traceId)
const pendingChatIds = new Map<string, string[]>(); // `chat:${traceId}` → list of entryIds
// Buffer tool calls that arrive before invoke_agent
const pendingToolCalls = new Map<string, ToolCall[]>(); // traceId → tool calls

function processSpans(spans: OtlpSpan[], sessionId: string) {
  for (const span of spans) {
    // DEBUG — log raw span to stderr when COPILOT_TRACER_DEBUG=1
    if (process.env.COPILOT_TRACER_DEBUG === '1') {
      process.stderr.write('[SPAN] ' + JSON.stringify({ name: span.name, attrs: span.attributes?.map(a => a.key), events: span.events?.map(e => ({ name: e.name, attrKeys: e.attributes?.map(a => a.key) })) }) + '\n');
    }
    const attrs = span.attributes ?? [];
    const spanName = span.name;
    const traceId = span.traceId;
    const spanId = span.spanId;

    // ── invoke_agent span = top-level agent turn ──────────────────────────
    if (spanName === 'invoke_agent') {
      const startMs = nanoToMs(span.startTimeUnixNano);
      const endMs   = nanoToMs(span.endTimeUnixNano);
      const durationMs = endMs - startMs;

      // Extract prompt from gen_ai.input.messages (real attr name from copilot)
      let promptText = '';
      let responseText = '';
      for (const ev of span.events ?? []) {
        if (ev.name === 'gen_ai.content.prompt') {
          const msg = getAttr(ev.attributes, 'gen_ai.prompt');
          if (msg) promptText = String(msg);
        }
        if (ev.name === 'gen_ai.content.completion') {
          const msg = getAttr(ev.attributes, 'gen_ai.completion');
          if (msg) responseText = String(msg);
        }
        // Real copilot event for user message
        if (ev.name === 'github.copilot.user.message') {
          const msg = getAttr(ev.attributes, 'github.copilot.user.message.text')
            ?? getAttr(ev.attributes, 'gen_ai.prompt');
          if (msg) promptText = String(msg);
        }
      }
      // Real attribute names from live copilot traffic
      if (!promptText) {
        const raw = getAttr(attrs, 'gen_ai.input.messages');
        if (raw) {
          try {
            const msgs = JSON.parse(String(raw));
            // Copilot format: [{role, parts:[{type, content}]}]
            const userMsg = Array.isArray(msgs)
              ? msgs.find((m: { role?: string }) => m.role === 'user')
              : null;
            if (userMsg?.parts) {
              promptText = userMsg.parts
                .filter((p: { type?: string }) => p.type === 'text')
                .map((p: { content?: string }) => {
                  // Strip system injections like <current_datetime>...</current_datetime>\n\n
                  let text = p.content ?? '';
                  text = text.replace(/<current_datetime>[\s\S]*?<\/current_datetime>\s*/g, '');
                  text = text.replace(/<system_reminder>[\s\S]*?<\/system_reminder>\s*/g, '');
                  return text.trim();
                })
                .join(' ')
                .trim()
                .slice(0, 300);
            } else {
              promptText = (userMsg?.content ?? String(raw)).slice(0, 300);
            }
          } catch {
            promptText = String(raw).slice(0, 300);
          }
        }
      }
      if (!responseText) {
        const raw = getAttr(attrs, 'gen_ai.output.messages');
        if (raw) {
          try {
            const msgs = JSON.parse(String(raw));
            const assistantMsg = Array.isArray(msgs)
              ? msgs.find((m: { role?: string }) => m.role === 'assistant')
              : null;
            if (assistantMsg?.parts) {
              responseText = assistantMsg.parts
                .filter((p: { type?: string }) => p.type === 'text')
                .map((p: { content?: string }) => p.content ?? '')
                .join(' ')
                .slice(0, 1000);
            } else {
              responseText = (assistantMsg?.content ?? String(raw)).slice(0, 1000);
            }
          } catch {
            responseText = String(raw).slice(0, 1000);
          }
        }
      }

      // Real credit attrs (verified Jul 31 2026):
      //   github.copilot.nano_aiu  — divide by 1e9 to get credits (matches copilot terminal output)
      //   github.copilot.cost      — raw cost value (different unit, do NOT use directly)
      const rawCost = getAttr(attrs, 'github.copilot.cost');
      const rawNanoAiu = getAttr(attrs, 'github.copilot.nano_aiu');
      if (process.env.COPILOT_TRACER_DEBUG === '1') {
        process.stderr.write(`[CREDITS] cost=${rawCost} nano_aiu=${rawNanoAiu}\n`);
      }
      // nano_aiu / 1e9 = credits (e.g. 2289375000 / 1e9 = 2.29 credits)
      const credits = rawNanoAiu !== undefined
        ? Number(rawNanoAiu) / 1e9
        : rawCost !== undefined
          ? Number(rawCost)
          : 0;
      const inputTokens  = Number(getAttr(attrs, 'gen_ai.usage.input_tokens')  ?? 0);
      const outputTokens = Number(getAttr(attrs, 'gen_ai.usage.output_tokens') ?? 0);
      // Real cached token attr: gen_ai.usage.cache_read.input_tokens (with dot, not underscore)
      const cachedTokens = Number(
        getAttr(attrs, 'gen_ai.usage.cache_read.input_tokens')
        ?? getAttr(attrs, 'gen_ai.usage.cache_read_input_tokens')
        ?? 0
      );
      // Skills from context
      const skillsRaw = getAttr(attrs, 'github.copilot.context.skills');
      const skillCount = skillsRaw ? String(skillsRaw).split(',').filter(Boolean).length : 0;

      const isError = (span.status?.code ?? 0) === 2;  // OTEL status ERROR = 2

      const entry: TraceEntry = {
        id: spanId,
        sessionId,
        dateTime: nanoToIso(span.startTimeUnixNano),
        prompt: promptText || `[agent turn ${spanId.slice(0, 8)}]`,
        response: responseText || undefined,
        tokens: {
          input: inputTokens,
          output: outputTokens,
          cached: cachedTokens,
          reasoning: 0,
          written: outputTokens,
          total: inputTokens + outputTokens,
        },
        aiCredits: credits,
        durationMs,
        toolCalls: [],
        skillCount,
        agentCount: 0,
        mcpCount: 0,
        status: isError ? 'error' : 'done',
        error: isError ? (span.status?.message ?? 'error') : undefined,
      };

      inFlight.set(traceId, { entry, toolCalls: new Map(), agentSpanId: spanId });

      // Flush any tool calls that arrived before invoke_agent
      const buffered = pendingToolCalls.get(traceId) ?? [];
      if (buffered.length > 0) {
        const inf = inFlight.get(traceId)!;
        for (const tc of buffered) {
          inf.entry.toolCalls.push(tc);
          inf.toolCalls.set(tc.id, tc);
        }
        let skills = 0, agents = 0, mcps = 0;
        for (const c of inf.entry.toolCalls) {
          if (c.type === 'skill') skills++;
          else if (c.type === 'agent') agents++;
          else if (c.type === 'mcp') mcps++;
        }
        inf.entry.skillCount = skills;
        inf.entry.agentCount = agents;
        inf.entry.mcpCount = mcps;
        pendingToolCalls.delete(traceId);
      }

      ensureSession(sessionId);
      upsertTrace(entry);
      traceEvents.emit('trace:update', entry);
      traceEvents.emit('trace:done', entry);

      // Clean up ALL standalone chat entries for this traceId (invoke_agent replaces them all)
      const chatKey = `chat:${traceId}`;
      const staleIds = pendingChatIds.get(chatKey) ?? [];
      for (const staleId of staleIds) {
        if (staleId !== entry.id) deleteTrace(staleId);
      }
      pendingChatIds.delete(chatKey);
      continue;
    }

    // ── chat span = LLM call — extract token usage + prompt/response ──────
    if (spanName.startsWith('chat ') || spanName === 'chat') {
      const model = String(getAttr(attrs, 'gen_ai.request.model') ?? spanName.replace('chat ', ''));
      const inputTokens  = Number(getAttr(attrs, 'gen_ai.usage.input_tokens')  ?? 0);
      const outputTokens = Number(getAttr(attrs, 'gen_ai.usage.output_tokens') ?? 0);
      const cachedTokens = Number(getAttr(attrs, 'gen_ai.usage.cache_read_input_tokens') ?? 0);
      const credits = getAttr(attrs, 'github.copilot.ai_credits');

      // Extract prompt/response from events
      let promptText = '';
      let responseText = '';
      for (const ev of span.events ?? []) {
        if (ev.name === 'gen_ai.content.prompt') {
          promptText = String(getAttr(ev.attributes, 'gen_ai.prompt') ?? '');
        }
        if (ev.name === 'gen_ai.content.completion') {
          responseText = String(getAttr(ev.attributes, 'gen_ai.completion') ?? '');
        }
      }

      const inf = inFlight.get(traceId);
      if (inf) {
        // Update parent invoke_agent entry with richer data
        if (!inf.entry.prompt && promptText) inf.entry.prompt = promptText;
        if (!inf.entry.response && responseText) inf.entry.response = responseText;
        if (inf.entry.tokens.total === 0 && inputTokens + outputTokens > 0) {
          inf.entry.tokens = { input: inputTokens, output: outputTokens, cached: cachedTokens, reasoning: 0, written: outputTokens, total: inputTokens + outputTokens };
        }
        if (!inf.entry.aiCredits && credits) inf.entry.aiCredits = Number(credits);
        upsertTrace(inf.entry);
        traceEvents.emit('trace:update', inf.entry);
      } else {
        // Standalone chat span (no parent invoke_agent) — create its own entry
        const durationMs = nanoToMs(span.endTimeUnixNano) - nanoToMs(span.startTimeUnixNano);
        const entry: TraceEntry = {
          id: spanId,
          sessionId,
          dateTime: nanoToIso(span.startTimeUnixNano),
          prompt: promptText || `[LLM call: ${model}]`,
          response: responseText || undefined,
          tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens, reasoning: 0, written: outputTokens, total: inputTokens + outputTokens },
          aiCredits: credits ? Number(credits) : 0,
          durationMs,
          toolCalls: [],
          skillCount: 0, agentCount: 0, mcpCount: 0,
          status: 'done',
        };
        ensureSession(sessionId);
        upsertTrace(entry);
        const chatKey = `chat:${traceId}`;
        const existing = pendingChatIds.get(chatKey) ?? [];
        existing.push(entry.id);
        pendingChatIds.set(chatKey, existing);
        traceEvents.emit('trace:update', entry);
        traceEvents.emit('trace:done', entry);
      }
      continue;
    }

    // ── execute_tool span = tool call ─────────────────────────────────────
    if (spanName.startsWith('execute_tool') || spanName === 'execute_tool') {
      const toolName = String(getAttr(attrs, 'gen_ai.tool.name') ?? getAttr(attrs, 'tool.name') ?? spanName.replace('execute_tool ', '').replace('execute_tool', 'unknown'));
      const toolType = detectToolType(toolName);
      const durationMs = nanoToMs(span.endTimeUnixNano) - nanoToMs(span.startTimeUnixNano);
      const isError = (span.status?.code ?? 0) === 2;

      const call: ToolCall = {
        id: spanId,
        name: toolName,
        type: toolType,
        input: {},
        startedAt: nanoToMs(span.startTimeUnixNano),
        endedAt: nanoToMs(span.endTimeUnixNano),
        durationMs,
        error: isError ? (span.status?.message ?? 'error') : undefined,
      };

      // Extract tool input from span attrs (real copilot attr names from debug)
      // gen_ai.tool.call.arguments — JSON string of args
      // github.copilot.tool.parameters.* — individual params (e.g. github.copilot.tool.parameters.command)
      // gen_ai.tool.call.result — tool output
      const argsRaw = getAttr(attrs, 'gen_ai.tool.call.arguments');
      const resultRaw = getAttr(attrs, 'gen_ai.tool.call.result');
      if (argsRaw) {
        try { call.input = JSON.parse(String(argsRaw)); } catch { call.input = { args: String(argsRaw) }; }
      }
      // Supplement with individual tool params (e.g. command for bash)
      const toolParams: Record<string, unknown> = {};
      for (const attr of attrs) {
        if (attr.key?.startsWith('github.copilot.tool.parameters.')) {
          const paramName = attr.key.replace('github.copilot.tool.parameters.', '');
          toolParams[paramName] = attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.boolValue;
        }
      }
      if (Object.keys(toolParams).length > 0) call.input = { ...call.input as object, ...toolParams };
      if (resultRaw) call.output = String(resultRaw).slice(0, 500);

      // Also check events as fallback
      for (const ev of span.events ?? []) {
        if (ev.name === 'gen_ai.content.prompt' && !argsRaw) {
          call.input = { args: getAttr(ev.attributes, 'gen_ai.prompt') };
        }
        if (ev.name === 'gen_ai.content.completion' && !resultRaw) {
          call.output = String(getAttr(ev.attributes, 'gen_ai.completion') ?? '').slice(0, 500);
        }
      }

      const inf = inFlight.get(traceId);
      if (inf) {
        inf.entry.toolCalls.push(call);
        inf.toolCalls.set(spanId, call);
        // Recount
        let skills = 0, agents = 0, mcps = 0;
        for (const c of inf.entry.toolCalls) {
          if (c.type === 'skill') skills++;
          else if (c.type === 'agent') agents++;
          else if (c.type === 'mcp') mcps++;
        }
        inf.entry.skillCount = skills;
        inf.entry.agentCount = agents;
        inf.entry.mcpCount = mcps;
        upsertTrace(inf.entry);
        traceEvents.emit('trace:update', inf.entry);
      } else {
        // Buffer tool call — invoke_agent hasn't arrived yet
        const buf = pendingToolCalls.get(traceId) ?? [];
        buf.push(call);
        pendingToolCalls.set(traceId, buf);
      }
      continue;
    }
  }
}

function detectToolType(name: string): ToolCall['type'] {
  const n = name.toLowerCase();
  // MCP — either mcp_ prefix, slash-separated server/tool, or gh CLI (copilot uses gh over MCP)
  if (n.startsWith('mcp_') || n.includes('/') || n === 'gh' || n.startsWith('gh_')) return 'mcp';
  // Agent — sub-agent delegation
  if (n.includes('agent') || n.includes('delegate') || n.includes('spawn')) return 'agent';
  // Skill — named capability loaded from skills context
  if (n.includes('skill') || n.includes('hermes') || n === 'copilot-tracer') return 'skill';
  // Builtin — shell, file, search, etc
  return 'builtin';
}

// ── Register OTLP HTTP routes on the Express app ──────────────────────────────
export function registerOtlpRoutes(app: Express, defaultSessionId: string): void {
  // OTLP traces — copilot sends JSON (http/json protocol)
  // body already parsed by express.json() middleware registered before this call
  app.post('/v1/traces', (req, res) => {
    try {
      const payload: OtlpTracesPayload = req.body as OtlpTracesPayload;
      const resourceSpans = payload.resourceSpans ?? [];

      for (const rs of resourceSpans) {
        const resAttrs = rs.resource?.attributes ?? [];
        const sessionFromOtel = getAttr(resAttrs, 'github.copilot.session_id')
          ?? getAttr(resAttrs, 'session.id')
          ?? getAttr(resAttrs, 'github.copilot.conversation_id');
        const sessionId = String(sessionFromOtel ?? defaultSessionId);

        for (const ss of rs.scopeSpans ?? []) {
          processSpans(ss.spans ?? [], sessionId);
        }
      }

      res.status(200).json({ partialSuccess: {} });
    } catch (e) {
      console.error('[OTLP] parse error:', e);
      res.status(400).json({ error: 'invalid payload' });
    }
  });

  // Metrics + logs — accept and ignore
  app.post('/v1/metrics', (_req, res) => res.status(200).json({ partialSuccess: {} }));
  app.post('/v1/logs',    (_req, res) => res.status(200).json({ partialSuccess: {} }));

  console.log('  📡 OTLP receiver ready on /v1/traces');
}
