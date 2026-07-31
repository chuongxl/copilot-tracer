import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { TraceEntry, ToolCall, TokenUsage } from './types.js';
import { upsertTrace } from './db.js';

// ACP message types from Copilot CLI stdio stream
interface AcpMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ActiveTrace {
  entry: TraceEntry;
  startMs: number;
  toolCallStack: ToolCall[];
}

export const traceEvents = new EventEmitter();

const activeTraces = new Map<string, ActiveTrace>();

// GitHub AI Credits: 1 credit = $0.01 USD
// Credits = token_cost_in_dollars / 0.01
// Rates based on official Copilot model pricing (credits per 1k tokens)
// See: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
const CREDITS_PER_1K: Record<string, { input: number; output: number; reasoning: number }> = {
  'claude-sonnet-4.6':   { input: 0.3,   output: 1.5,  reasoning: 3.75 }, // $3/$15/$37.5 per 1M
  'claude-sonnet-4':     { input: 0.3,   output: 1.5,  reasoning: 3.75 },
  'claude-opus-4':       { input: 1.5,   output: 7.5,  reasoning: 7.5  }, // $15/$75 per 1M
  'gpt-4.1':             { input: 0.2,   output: 0.8,  reasoning: 0.8  }, // $2/$8 per 1M
  'gpt-4o':              { input: 0.25,  output: 1.0,  reasoning: 1.0  }, // $2.5/$10 per 1M
  'gemini-2.0-flash':    { input: 0.01,  output: 0.04, reasoning: 0.04 }, // $0.1/$0.4 per 1M
  'gemini-1.5-pro':      { input: 0.125, output: 0.5,  reasoning: 0.5  }, // $1.25/$5 per 1M
  'default':             { input: 0.3,   output: 1.5,  reasoning: 3.75 }, // fallback = sonnet-4.6
};

function calcCredits(tokens: TokenUsage, model = 'default'): number {
  const key = Object.keys(CREDITS_PER_1K).find(k => model.toLowerCase().includes(k)) ?? 'default';
  const rate = CREDITS_PER_1K[key];
  return (
    (tokens.input     / 1000) * rate.input +
    (tokens.written   / 1000) * rate.output +
    (tokens.reasoning / 1000) * rate.reasoning
  );
}

function countByType(calls: ToolCall[]) {
  let skills = 0, agents = 0, mcps = 0;
  for (const c of calls) {
    if (c.type === 'skill') skills++;
    else if (c.type === 'agent') agents++;
    else if (c.type === 'mcp') mcps++;
    if (c.children) {
      const sub = countByType(c.children);
      skills += sub.skills; agents += sub.agents; mcps += sub.mcps;
    }
  }
  return { skills, agents, mcps };
}

export function handleAcpMessage(sessionId: string, msg: AcpMessage, direction: 'in' | 'out'): void {
  // Incoming prompt from user → start a new trace
  if (direction === 'in' && msg.method === 'conversation/turn' && msg.params) {
    const params = msg.params as Record<string, unknown>;
    const prompt = (params.content as string) || JSON.stringify(params);
    const traceId = String(msg.id ?? randomUUID());

    const entry: TraceEntry = {
      id: traceId,
      sessionId,
      dateTime: new Date().toISOString(),
      prompt,
      tokens: { input: 0, output: 0, cached: 0, reasoning: 0, written: 0, total: 0 },
      aiCredits: 0,
      durationMs: 0,
      toolCalls: [],
      skillCount: 0,
      agentCount: 0,
      mcpCount: 0,
      status: 'running',
    };
    activeTraces.set(traceId, { entry, startMs: Date.now(), toolCallStack: [] });
    upsertTrace(entry);
    traceEvents.emit('trace:update', entry);
  }

  // Tool call initiated
  if (direction === 'out' && msg.method === 'tools/call' && msg.params) {
    const params = msg.params as Record<string, unknown>;
    const toolName = String(params.name ?? 'unknown');
    const toolType = detectToolType(toolName);
    const callId = String(msg.id ?? randomUUID());

    const call: ToolCall = {
      id: callId,
      name: toolName,
      type: toolType,
      input: (params.arguments as Record<string, unknown>) ?? {},
      startedAt: Date.now(),
    };

    // Attach to most recent active trace
    for (const [, active] of activeTraces) {
      if (active.entry.status === 'running') {
        active.entry.toolCalls.push(call);
        active.toolCallStack.push(call);
        upsertTrace(active.entry);
        traceEvents.emit('trace:update', active.entry);
        break;
      }
    }
  }

  // Tool call result
  if (direction === 'in' && msg.id !== undefined && msg.result !== undefined) {
    for (const [, active] of activeTraces) {
      const call = active.toolCallStack.find(c => c.id === String(msg.id));
      if (call) {
        call.output = msg.result;
        call.endedAt = Date.now();
        call.durationMs = call.endedAt - call.startedAt;
        upsertTrace(active.entry);
        traceEvents.emit('trace:update', active.entry);
        break;
      }
    }
  }

  // Token usage / completion
  if (direction === 'in' && msg.method === 'conversation/turn/complete' && msg.params) {
    const params = msg.params as Record<string, unknown>;
    const turnId = String(params.turnId ?? msg.id ?? '');
    const active = activeTraces.get(turnId);
    if (!active) return;

    const usage = (params.usage as Record<string, number>) ?? {};
    const reasoning = (params.reasoning as string) ?? undefined;
    const response = (params.content as string) ?? undefined;
    const model = String(params.model ?? params.modelId ?? 'default');

    // Use credits directly from ACP response if provided (most accurate)
    // Otherwise calculate from tokens × model rate
    const rawCredits = typeof params.ai_credits === 'number' ? params.ai_credits
      : typeof params.credits === 'number' ? params.credits
      : null;

    active.entry.tokens = {
      input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      output: usage.output_tokens ?? usage.completion_tokens ?? 0,
      cached: usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0,
      reasoning: usage.reasoning_tokens ?? 0,
      written: usage.output_tokens ?? 0,
      total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    };
    active.entry.reasoning = reasoning;
    active.entry.response = response;
    active.entry.durationMs = Date.now() - active.startMs;
    active.entry.aiCredits = rawCredits ?? calcCredits(active.entry.tokens, model);
    active.entry.status = 'done';

    const counts = countByType(active.entry.toolCalls);
    active.entry.skillCount = counts.skills;
    active.entry.agentCount = counts.agents;
    active.entry.mcpCount = counts.mcps;

    upsertTrace(active.entry);
    traceEvents.emit('trace:update', active.entry);
    traceEvents.emit('trace:done', active.entry);
    activeTraces.delete(turnId);
  }

  // Error
  if (direction === 'in' && msg.error) {
    for (const [id, active] of activeTraces) {
      if (active.entry.status === 'running') {
        active.entry.status = 'error';
        active.entry.error = msg.error.message;
        active.entry.durationMs = Date.now() - active.startMs;
        upsertTrace(active.entry);
        traceEvents.emit('trace:update', active.entry);
        activeTraces.delete(id);
        break;
      }
    }
  }
}

function detectToolType(name: string): ToolCall['type'] {
  if (name.startsWith('mcp_') || name.includes('/')) return 'mcp';
  if (name.includes('skill') || name.includes('hermes')) return 'skill';
  if (name.includes('agent') || name.includes('delegate')) return 'agent';
  return 'builtin';
}
