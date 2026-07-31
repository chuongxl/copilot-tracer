/**
 * OTLP HTTP receiver — accepts traces and metrics pushed by GitHub Copilot CLI
 * via OpenTelemetry export (OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4747).
 *
 * Copilot uses OTel GenAI semantic conventions:
 *   - span "invoke_agent"    — top-level agent invocation
 *   - span "chat <model>"    — individual LLM call
 *   - span "execute_tool"    — tool call
 *
 * Relevant attributes:
 *   gen_ai.prompt / gen_ai.completion  (when OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true)
 *   gen_ai.usage.input_tokens
 *   gen_ai.usage.output_tokens
 *   gen_ai.usage.cache_read_input_tokens
 *   gen_ai.request.model
 *   gen_ai.system
 *   github.copilot.ai_credits
 */
import { upsertTrace, createSession } from './db.js';
import { traceEvents } from './proxy.js';
// ── Helpers ───────────────────────────────────────────────────────────────────
function getAttr(attrs, key) {
    const kv = attrs?.find(a => a.key === key);
    if (!kv)
        return undefined;
    const v = kv.value;
    if (v.stringValue !== undefined)
        return v.stringValue;
    if (v.intValue !== undefined)
        return typeof v.intValue === 'string' ? parseInt(v.intValue) : v.intValue;
    if (v.doubleValue !== undefined)
        return v.doubleValue;
    return undefined;
}
function nanoToMs(nano) {
    return Math.round(Number(BigInt(nano) / 1000000n));
}
function nanoToIso(nano) {
    return new Date(nanoToMs(nano)).toISOString();
}
const inFlight = new Map(); // traceId → InFlight
// Sessions we've created in DB (avoid duplicate createSession calls)
const knownSessions = new Set();
function ensureSession(sessionId) {
    if (!knownSessions.has(sessionId)) {
        createSession(sessionId);
        knownSessions.add(sessionId);
    }
}
// ── Process one batch of spans ────────────────────────────────────────────────
function processSpans(spans, sessionId) {
    for (const span of spans) {
        const attrs = span.attributes ?? [];
        const spanName = span.name;
        const traceId = span.traceId;
        const spanId = span.spanId;
        // ── invoke_agent span = top-level agent turn ──────────────────────────
        if (spanName === 'invoke_agent') {
            const startMs = nanoToMs(span.startTimeUnixNano);
            const endMs = nanoToMs(span.endTimeUnixNano);
            const durationMs = endMs - startMs;
            // Extract prompt from events (gen_ai.content.prompt event)
            let promptText = '';
            let responseText = '';
            for (const ev of span.events ?? []) {
                if (ev.name === 'gen_ai.content.prompt') {
                    const msg = getAttr(ev.attributes, 'gen_ai.prompt');
                    if (msg)
                        promptText = String(msg);
                }
                if (ev.name === 'gen_ai.content.completion') {
                    const msg = getAttr(ev.attributes, 'gen_ai.completion');
                    if (msg)
                        responseText = String(msg);
                }
            }
            // Fallback: check attributes directly
            if (!promptText) {
                const p = getAttr(attrs, 'gen_ai.prompt') ?? getAttr(attrs, 'github.copilot.prompt');
                if (p)
                    promptText = String(p);
            }
            const credits = getAttr(attrs, 'github.copilot.ai_credits');
            const inputTokens = Number(getAttr(attrs, 'gen_ai.usage.input_tokens') ?? 0);
            const outputTokens = Number(getAttr(attrs, 'gen_ai.usage.output_tokens') ?? 0);
            const cachedTokens = Number(getAttr(attrs, 'gen_ai.usage.cache_read_input_tokens') ?? 0);
            const isError = (span.status?.code ?? 0) === 2; // OTEL status ERROR = 2
            const entry = {
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
                aiCredits: credits ? Number(credits) : 0,
                durationMs,
                toolCalls: [],
                skillCount: 0,
                agentCount: 0,
                mcpCount: 0,
                status: isError ? 'error' : 'done',
                error: isError ? (span.status?.message ?? 'error') : undefined,
            };
            inFlight.set(traceId, { entry, toolCalls: new Map(), agentSpanId: spanId });
            ensureSession(sessionId);
            upsertTrace(entry);
            traceEvents.emit('trace:update', entry);
            traceEvents.emit('trace:done', entry);
            continue;
        }
        // ── chat span = LLM call — extract token usage + prompt/response ──────
        if (spanName.startsWith('chat ') || spanName === 'chat') {
            const model = String(getAttr(attrs, 'gen_ai.request.model') ?? spanName.replace('chat ', ''));
            const inputTokens = Number(getAttr(attrs, 'gen_ai.usage.input_tokens') ?? 0);
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
                if (!inf.entry.prompt && promptText)
                    inf.entry.prompt = promptText;
                if (!inf.entry.response && responseText)
                    inf.entry.response = responseText;
                if (inf.entry.tokens.total === 0 && inputTokens + outputTokens > 0) {
                    inf.entry.tokens = { input: inputTokens, output: outputTokens, cached: cachedTokens, reasoning: 0, written: outputTokens, total: inputTokens + outputTokens };
                }
                if (!inf.entry.aiCredits && credits)
                    inf.entry.aiCredits = Number(credits);
                upsertTrace(inf.entry);
                traceEvents.emit('trace:update', inf.entry);
            }
            else {
                // Standalone chat span (no parent invoke_agent) — create its own entry
                const durationMs = nanoToMs(span.endTimeUnixNano) - nanoToMs(span.startTimeUnixNano);
                const entry = {
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
            const call = {
                id: spanId,
                name: toolName,
                type: toolType,
                input: {},
                startedAt: nanoToMs(span.startTimeUnixNano),
                endedAt: nanoToMs(span.endTimeUnixNano),
                durationMs,
                error: isError ? (span.status?.message ?? 'error') : undefined,
            };
            // Extract tool input/output from events
            for (const ev of span.events ?? []) {
                if (ev.name === 'gen_ai.content.prompt') {
                    call.input = { args: getAttr(ev.attributes, 'gen_ai.prompt') };
                }
                if (ev.name === 'gen_ai.content.completion') {
                    call.output = getAttr(ev.attributes, 'gen_ai.completion');
                }
            }
            const inf = inFlight.get(traceId);
            if (inf) {
                inf.entry.toolCalls.push(call);
                inf.toolCalls.set(spanId, call);
                // Recount
                let skills = 0, agents = 0, mcps = 0;
                for (const c of inf.entry.toolCalls) {
                    if (c.type === 'skill')
                        skills++;
                    else if (c.type === 'agent')
                        agents++;
                    else if (c.type === 'mcp')
                        mcps++;
                }
                inf.entry.skillCount = skills;
                inf.entry.agentCount = agents;
                inf.entry.mcpCount = mcps;
                upsertTrace(inf.entry);
                traceEvents.emit('trace:update', inf.entry);
            }
            continue;
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
// ── Register OTLP HTTP routes on the Express app ──────────────────────────────
export function registerOtlpRoutes(app, defaultSessionId) {
    // OTLP traces — copilot sends JSON (http/json protocol)
    // body already parsed by express.json() middleware registered before this call
    app.post('/v1/traces', (req, res) => {
        try {
            const payload = req.body;
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
        }
        catch (e) {
            console.error('[OTLP] parse error:', e);
            res.status(400).json({ error: 'invalid payload' });
        }
    });
    // Metrics + logs — accept and ignore
    app.post('/v1/metrics', (_req, res) => res.status(200).json({ partialSuccess: {} }));
    app.post('/v1/logs', (_req, res) => res.status(200).json({ partialSuccess: {} }));
    console.log('  📡 OTLP receiver ready on /v1/traces');
}
