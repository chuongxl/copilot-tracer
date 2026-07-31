import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { upsertTrace } from './db.js';
export const traceEvents = new EventEmitter();
const activeTraces = new Map(); // keyed by sessionId
const pendingPrompts = new Map(); // id → sessionId
// GitHub AI Credits: 1 credit = $0.01 USD
// Rates based on official Copilot model pricing (credits per 1k tokens)
const CREDITS_PER_1K = {
    'claude-sonnet-5': { input: 0.3, output: 1.5, reasoning: 3.75 },
    'claude-sonnet-4.6': { input: 0.3, output: 1.5, reasoning: 3.75 },
    'claude-sonnet-4': { input: 0.3, output: 1.5, reasoning: 3.75 },
    'claude-haiku-4.5': { input: 0.025, output: 0.125, reasoning: 0.25 },
    'claude-opus-5': { input: 1.5, output: 7.5, reasoning: 7.5 },
    'claude-opus-4': { input: 1.5, output: 7.5, reasoning: 7.5 },
    'gpt-4.1': { input: 0.2, output: 0.8, reasoning: 0.8 },
    'gpt-4o': { input: 0.25, output: 1.0, reasoning: 1.0 },
    'gemini-2.0-flash': { input: 0.01, output: 0.04, reasoning: 0.04 },
    'gemini-1.5-pro': { input: 0.125, output: 0.5, reasoning: 0.5 },
    'default': { input: 0.3, output: 1.5, reasoning: 3.75 }, // fallback
};
function calcCredits(tokens, model = 'default') {
    const key = Object.keys(CREDITS_PER_1K).find(k => model.toLowerCase().includes(k)) ?? 'default';
    const rate = CREDITS_PER_1K[key];
    return ((tokens.input / 1000) * rate.input +
        (tokens.written / 1000) * rate.output +
        (tokens.reasoning / 1000) * rate.reasoning);
}
function countByType(calls) {
    let skills = 0, agents = 0, mcps = 0;
    for (const c of calls) {
        if (c.type === 'skill')
            skills++;
        else if (c.type === 'agent')
            agents++;
        else if (c.type === 'mcp')
            mcps++;
        if (c.children) {
            const sub = countByType(c.children);
            skills += sub.skills;
            agents += sub.agents;
            mcps += sub.mcps;
        }
    }
    return { skills, agents, mcps };
}
export function handleAcpMessage(sessionId, msg, direction) {
    // ── OUTBOUND (client → copilot) ──────────────────────────────────────────
    if (direction === 'out') {
        // session/prompt: user sent a new prompt
        if (msg.method === 'session/prompt' && msg.params) {
            const params = msg.params;
            const acpSessionId = String(params.sessionId ?? sessionId);
            // Extract prompt text from ACP prompt array: [{type:"text", text:"..."}]
            let promptText = '';
            const promptArr = params.prompt;
            if (Array.isArray(promptArr)) {
                promptText = promptArr
                    .filter(p => p.type === 'text' && p.text)
                    .map(p => p.text)
                    .join(' ');
            }
            if (!promptText)
                promptText = JSON.stringify(params);
            const traceId = String(msg.id ?? randomUUID());
            const entry = {
                id: traceId,
                sessionId, // use the tracer session ID, not ACP session ID
                dateTime: new Date().toISOString(),
                prompt: promptText,
                tokens: { input: 0, output: 0, cached: 0, reasoning: 0, written: 0, total: 0 },
                aiCredits: 0,
                durationMs: 0,
                toolCalls: [],
                skillCount: 0,
                agentCount: 0,
                mcpCount: 0,
                status: 'running',
            };
            // Store keyed by ACP session ID for notification correlation
            activeTraces.set(acpSessionId, { entry, startMs: Date.now(), toolCallStack: [], promptId: msg.id });
            if (msg.id !== undefined)
                pendingPrompts.set(msg.id, acpSessionId);
            upsertTrace(entry);
            traceEvents.emit('trace:update', entry);
        }
        // session/command or tool_call_result going back — nothing to capture on out direction for tools
    }
    // ── INBOUND (copilot → client) ───────────────────────────────────────────
    if (direction === 'in') {
        // session/update notifications — all streaming events
        if (msg.method === 'session/update' && msg.params) {
            const params = msg.params;
            const acpSessionId = String(params.sessionId ?? sessionId);
            const update = (params.update ?? {});
            const updateType = String(update.sessionUpdate ?? '');
            const active = activeTraces.get(acpSessionId);
            if (!active)
                return;
            if (updateType === 'agent_message_chunk') {
                // Text chunk of AI response — accumulate
                const content = update.content ?? {};
                if (content.text) {
                    active.entry.response = (active.entry.response ?? '') + content.text;
                }
            }
            else if (updateType === 'tool_call_start' || updateType === 'tool_call_begin') {
                // Tool call starting
                const toolName = String(update.toolName ?? update.name ?? 'unknown');
                const toolType = detectToolType(toolName);
                const callId = String(update.callId ?? update.id ?? randomUUID());
                const call = {
                    id: callId,
                    name: toolName,
                    type: toolType,
                    input: (update.arguments ?? update.input ?? {}),
                    startedAt: Date.now(),
                };
                active.entry.toolCalls.push(call);
                active.toolCallStack.push(call);
                upsertTrace(active.entry);
                traceEvents.emit('trace:update', active.entry);
            }
            else if (updateType === 'tool_call_end' || updateType === 'tool_call_result' || updateType === 'tool_call_complete') {
                // Tool call completed
                const callId = String(update.callId ?? update.id ?? '');
                const call = active.toolCallStack.find(c => c.id === callId);
                if (call) {
                    call.output = update.result ?? update.output;
                    call.endedAt = Date.now();
                    call.durationMs = call.endedAt - call.startedAt;
                    upsertTrace(active.entry);
                    traceEvents.emit('trace:update', active.entry);
                }
            }
            else if (updateType === 'usage_update' || updateType === 'token_usage') {
                // Token usage update
                const usage = (update.usage ?? update.tokens ?? {});
                const model = String(update.model ?? update.modelId ?? 'default');
                active.entry.tokens = {
                    input: usage.input_tokens ?? usage.prompt_tokens ?? active.entry.tokens.input,
                    output: usage.output_tokens ?? usage.completion_tokens ?? active.entry.tokens.output,
                    cached: usage.cache_read_input_tokens ?? usage.cached_tokens ?? active.entry.tokens.cached,
                    reasoning: usage.reasoning_tokens ?? active.entry.tokens.reasoning,
                    written: usage.output_tokens ?? active.entry.tokens.written,
                    total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                };
                const rawCredits = typeof update.ai_credits === 'number' ? update.ai_credits
                    : typeof update.credits === 'number' ? update.credits
                        : null;
                if (rawCredits !== null)
                    active.entry.aiCredits = rawCredits;
                else
                    active.entry.aiCredits = calcCredits(active.entry.tokens, model);
                upsertTrace(active.entry);
                traceEvents.emit('trace:update', active.entry);
            }
        }
        // Response to session/prompt request — completion signal
        if (msg.id !== undefined && msg.result !== undefined && !msg.method) {
            const acpSessionId = pendingPrompts.get(msg.id);
            if (acpSessionId) {
                const active = activeTraces.get(acpSessionId);
                if (active) {
                    const result = msg.result;
                    const stopReason = String(result.stopReason ?? 'end_turn');
                    active.entry.durationMs = Date.now() - active.startMs;
                    active.entry.status = stopReason === 'end_turn' ? 'done' : 'done';
                    // If no tokens from usage_update, estimate from text length
                    if (active.entry.tokens.total === 0 && active.entry.response) {
                        const roughTokens = Math.ceil(active.entry.response.length / 4);
                        active.entry.tokens.output = roughTokens;
                        active.entry.tokens.written = roughTokens;
                        active.entry.tokens.total = roughTokens;
                        active.entry.aiCredits = calcCredits(active.entry.tokens);
                    }
                    const counts = countByType(active.entry.toolCalls);
                    active.entry.skillCount = counts.skills;
                    active.entry.agentCount = counts.agents;
                    active.entry.mcpCount = counts.mcps;
                    upsertTrace(active.entry);
                    traceEvents.emit('trace:update', active.entry);
                    traceEvents.emit('trace:done', active.entry);
                    pendingPrompts.delete(msg.id);
                    activeTraces.delete(acpSessionId);
                }
            }
        }
        // Error response
        if (msg.error) {
            // Try to match by pending prompt id
            if (msg.id !== undefined) {
                const acpSessionId = pendingPrompts.get(msg.id);
                if (acpSessionId) {
                    const active = activeTraces.get(acpSessionId);
                    if (active) {
                        active.entry.status = 'error';
                        active.entry.error = msg.error.message;
                        active.entry.durationMs = Date.now() - active.startMs;
                        upsertTrace(active.entry);
                        traceEvents.emit('trace:update', active.entry);
                        pendingPrompts.delete(msg.id);
                        activeTraces.delete(acpSessionId);
                        return;
                    }
                }
            }
            // Fallback: mark any running trace as error
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
}
function detectToolType(name) {
    if (name.startsWith('mcp_') || name.includes('/'))
        return 'mcp';
    if (name.includes('skill') || name.includes('hermes'))
        return 'skill';
    if (name.includes('agent') || name.includes('delegate'))
        return 'agent';
    return 'builtin';
}
