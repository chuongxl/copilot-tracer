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
import { randomUUID } from 'crypto';
import { upsertTrace, createSession, deleteTrace, ensureProject, ensureProjectByRepo } from './db.js';
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
function getStringAttr(attrs, ...keys) {
    for (const key of keys) {
        const value = getAttr(attrs, key);
        if (value !== undefined && String(value).trim())
            return String(value);
    }
    return undefined;
}
function getBodyText(body) {
    if (!body)
        return undefined;
    if (body.stringValue !== undefined)
        return body.stringValue;
    if (body.intValue !== undefined)
        return String(body.intValue);
    if (body.doubleValue !== undefined)
        return String(body.doubleValue);
    if (body.boolValue !== undefined)
        return String(body.boolValue);
    return undefined;
}
const inFlight = new Map(); // traceId → InFlight
// Anthropic API pricing per 1K tokens (USD), converted to GitHub "AI credit" units
// (1 credit = $0.01) so aiCredits stays one unit across Copilot and Claude entries.
// Rates are Anthropic's current published per-model prices; a model id that doesn't
// match a specific entry falls back to its tier's (opus/sonnet/haiku) latest rate.
const ANTHROPIC_USD_PER_1K = {
    'claude-fable-5': { input: 0.010, output: 0.050 },
    'claude-mythos-5': { input: 0.010, output: 0.050 },
    'claude-opus-5': { input: 0.005, output: 0.025 },
    'claude-opus-4-8': { input: 0.005, output: 0.025 },
    'claude-opus-4-7': { input: 0.005, output: 0.025 },
    'claude-opus-4-6': { input: 0.005, output: 0.025 },
    'claude-sonnet-5': { input: 0.002, output: 0.010 },
    'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
    'claude-haiku-4-5': { input: 0.001, output: 0.005 },
    'opus': { input: 0.005, output: 0.025 },
    'sonnet': { input: 0.003, output: 0.015 },
    'haiku': { input: 0.001, output: 0.005 },
    'default': { input: 0.003, output: 0.015 },
};
export function calcClaudeCredits(tokens, model) {
    const key = Object.keys(ANTHROPIC_USD_PER_1K).find(k => (model ?? '').toLowerCase().includes(k)) ?? 'default';
    const rate = ANTHROPIC_USD_PER_1K[key];
    const usd = (tokens.input / 1000) * rate.input + (tokens.output / 1000) * rate.output;
    return usd * 100; // USD → credits (1 credit = $0.01)
}
// Sessions are created lazily. Always upsert so project_id gets backfilled
// when the session was created earlier without a project.
function ensureSession(sessionId, projectId) {
    createSession(sessionId, projectId);
}
// ── Project resolution ────────────────────────────────────────────────────────
// Precedence: repo URL > working dir > default (CLI) project.
// If none match, the session keeps no project (traces still appear on live page).
function resolveProjectId(repoUrl, workingDir, defaultProjectId) {
    if (repoUrl)
        return ensureProjectByRepo(String(repoUrl));
    if (workingDir)
        return ensureProject(workingDir);
    return defaultProjectId;
}
function detectWorkingDir(attrs) {
    for (const key of ['process.working_directory', 'github.copilot.working_dir', 'claude_code.working_dir']) {
        const v = getAttr(attrs, key);
        if (v && String(v).trim())
            return String(v).trim();
    }
    return undefined;
}
// ── Process one batch of spans ────────────────────────────────────────────────
// Track standalone chat entries so invoke_agent can replace them (multiple chat spans per traceId)
const pendingChatIds = new Map(); // `chat:${traceId}` → list of entryIds
// Buffer tool calls that arrive before invoke_agent
const pendingToolCalls = new Map(); // traceId → tool calls
const claudePromptEntries = new Map(); // prompt.id → trace entry
const claudeInteractionEntries = new Map(); // traceId → interaction entry
// Real Claude Code telemetry sends the child claude_code.llm_request span before its
// parent claude_code.interaction span within the same batch, so buffer llm_request's
// token/cost delta here until the interaction entry shows up to receive it.
const pendingClaudeLlmDeltas = new Map();
const CLAUDE_STATE_LIMIT = 1000;
function rememberClaudeEntry(map, key, entry) {
    map.set(key, entry);
    if (map.size > CLAUDE_STATE_LIMIT) {
        const oldest = map.keys().next().value;
        if (oldest)
            map.delete(oldest);
    }
}
function claudeEventId(record, attrs, eventName) {
    const messageId = getStringAttr(attrs, 'message.uuid', 'tool_use_id');
    const promptId = getStringAttr(attrs, 'prompt.id');
    return `claude:${messageId ?? promptId ?? record.traceId ?? randomUUID()}:${eventName}`;
}
function processClaudeLogRecord(record, resourceAttrs, sessionId, projectId, workingDir) {
    const attrs = record.attributes ?? [];
    const eventName = getStringAttr(attrs, 'event.name') ?? getBodyText(record.body);
    if (!eventName || !eventName.startsWith('claude_code.'))
        return;
    const eventTime = getStringAttr(attrs, 'event.timestamp');
    const dateTime = eventTime ?? (record.timeUnixNano ? nanoToIso(record.timeUnixNano) : new Date().toISOString());
    const promptId = getStringAttr(attrs, 'prompt.id');
    const resolvedProjectId = resolveProjectId(getStringAttr(resourceAttrs, 'github.copilot.git.repository', 'vcs.repository.url'), getStringAttr(attrs, 'process.working_directory', 'github.copilot.working_dir', 'claude_code.working_dir') ?? workingDir, projectId);
    const eventSessionId = getStringAttr(attrs, 'session.id') ?? sessionId;
    if (eventName === 'claude_code.user_prompt') {
        const entry = {
            id: claudeEventId(record, attrs, 'prompt'),
            sessionId: eventSessionId,
            dateTime,
            prompt: getStringAttr(attrs, 'prompt') ?? '[Claude Code prompt]',
            tokens: { input: 0, output: 0, cached: 0, reasoning: 0, written: 0, total: 0 },
            aiCredits: 0,
            durationMs: 0,
            toolCalls: [],
            skillCount: 0,
            agentCount: 0,
            mcpCount: 0,
            status: 'running',
        };
        if (promptId)
            rememberClaudeEntry(claudePromptEntries, promptId, entry);
        ensureSession(eventSessionId, resolvedProjectId);
        upsertTrace(entry);
        traceEvents.emit('trace:update', entry);
        return;
    }
    if (eventName === 'claude_code.assistant_response') {
        const existingEntry = promptId ? claudePromptEntries.get(promptId) : undefined;
        const entry = existingEntry ?? {
            id: claudeEventId(record, attrs, 'response'),
            sessionId: eventSessionId,
            dateTime,
            prompt: '[Claude Code response]',
            tokens: { input: 0, output: 0, cached: 0, reasoning: 0, written: 0, total: 0 },
            aiCredits: 0,
            durationMs: 0,
            toolCalls: [],
            skillCount: 0,
            agentCount: 0,
            mcpCount: 0,
            status: 'running',
        };
        entry.response = getStringAttr(attrs, 'response');
        entry.status = 'done';
        entry.durationMs = Number(getStringAttr(attrs, 'duration_ms') ?? 0);
        ensureSession(eventSessionId, resolvedProjectId);
        upsertTrace(entry);
        traceEvents.emit('trace:update', entry);
        traceEvents.emit('trace:done', entry);
        return;
    }
    if (eventName === 'claude_code.tool_result') {
        const entry = promptId ? claudePromptEntries.get(promptId) : undefined;
        if (!entry)
            return;
        const toolName = getStringAttr(attrs, 'tool_name') ?? 'Claude Code tool';
        const toolId = getStringAttr(attrs, 'tool_use_id') ?? randomUUID();
        if (entry.toolCalls.some(call => call.id === toolId))
            return;
        entry.toolCalls.push({
            id: toolId,
            name: toolName,
            type: detectToolType(toolName),
            input: {},
            startedAt: Date.parse(dateTime),
            endedAt: Date.parse(dateTime),
            durationMs: Number(getStringAttr(attrs, 'duration_ms') ?? 0),
            error: getStringAttr(attrs, 'error'),
        });
        upsertTrace(entry);
        traceEvents.emit('trace:update', entry);
    }
}
function processClaudeLogs(payload, defaultSessionId, projectId) {
    if (!payload || !Array.isArray(payload.resourceLogs)) {
        throw new Error('OTLP logs payload must contain resourceLogs');
    }
    for (const resourceLogs of payload.resourceLogs ?? []) {
        const resourceAttrs = resourceLogs.resource?.attributes ?? [];
        const sessionId = getStringAttr(resourceAttrs, 'session.id') ?? defaultSessionId;
        const workingDir = detectWorkingDir(resourceAttrs);
        for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
            for (const record of scopeLogs.logRecords ?? []) {
                processClaudeLogRecord(record, resourceAttrs, sessionId, projectId, workingDir);
            }
        }
    }
}
function processSpans(spans, sessionId, projectId, workingDir) {
    for (const span of spans) {
        // DEBUG — log raw span to stderr when COPILOT_TRACER_DEBUG=1
        if (process.env.COPILOT_TRACER_DEBUG === '1') {
            process.stderr.write('[SPAN] ' + JSON.stringify({ name: span.name, attrs: span.attributes?.map(a => a.key), events: span.events?.map(e => ({ name: e.name, attrKeys: e.attributes?.map(a => a.key) })) }) + '\n');
        }
        const attrs = span.attributes ?? [];
        const spanName = span.name;
        const traceId = span.traceId;
        const spanId = span.spanId;
        if (spanName === 'claude_code.interaction') {
            const attrs = span.attributes ?? [];
            const inputTokens = Number(getAttr(attrs, 'input_tokens') ?? 0);
            const outputTokens = Number(getAttr(attrs, 'output_tokens') ?? 0);
            const model = getStringAttr(attrs, 'model', 'gen_ai.request.model');
            const entry = {
                id: spanId,
                sessionId: getStringAttr(attrs, 'session.id') ?? sessionId,
                dateTime: nanoToIso(span.startTimeUnixNano),
                prompt: getStringAttr(attrs, 'user_prompt') ?? '[Claude Code interaction]',
                tokens: { input: inputTokens, output: outputTokens, cached: Number(getAttr(attrs, 'cache_read_tokens') ?? 0), reasoning: 0, written: outputTokens, total: inputTokens + outputTokens },
                aiCredits: calcClaudeCredits({ input: inputTokens, output: outputTokens }, model),
                durationMs: Number(getAttr(attrs, 'interaction.duration_ms')
                    ?? (nanoToMs(span.endTimeUnixNano) - nanoToMs(span.startTimeUnixNano))),
                toolCalls: [],
                skillCount: 0,
                agentCount: 0,
                mcpCount: 0,
                status: (span.status?.code ?? 0) === 2 ? 'error' : 'done',
                error: span.status?.message,
            };
            // Apply any llm_request delta that arrived before this interaction span.
            const pendingDelta = pendingClaudeLlmDeltas.get(traceId);
            if (pendingDelta) {
                entry.tokens = {
                    input: entry.tokens.input + pendingDelta.input,
                    output: entry.tokens.output + pendingDelta.output,
                    cached: entry.tokens.cached + pendingDelta.cached,
                    reasoning: 0,
                    written: entry.tokens.written + pendingDelta.output,
                    total: entry.tokens.total + pendingDelta.input + pendingDelta.output,
                };
                entry.aiCredits += pendingDelta.credits;
                pendingClaudeLlmDeltas.delete(traceId);
            }
            ensureSession(entry.sessionId, resolveProjectId(getAttr(attrs, 'vcs.repository.url'), detectWorkingDir(attrs) ?? workingDir, projectId));
            upsertTrace(entry);
            rememberClaudeEntry(claudeInteractionEntries, traceId, entry);
            traceEvents.emit('trace:update', entry);
            traceEvents.emit('trace:done', entry);
            continue;
        }
        if (spanName === 'claude_code.llm_request') {
            const inputTokens = Number(getAttr(attrs, 'input_tokens') ?? 0);
            const outputTokens = Number(getAttr(attrs, 'output_tokens') ?? 0);
            const cachedTokens = Number(getAttr(attrs, 'cache_read_tokens') ?? 0);
            const model = getStringAttr(attrs, 'model', 'gen_ai.request.model');
            const entry = claudeInteractionEntries.get(traceId);
            if (entry) {
                entry.tokens = {
                    input: entry.tokens.input + inputTokens,
                    output: entry.tokens.output + outputTokens,
                    cached: entry.tokens.cached + cachedTokens,
                    reasoning: 0,
                    written: entry.tokens.written + outputTokens,
                    total: entry.tokens.total + inputTokens + outputTokens,
                };
                entry.aiCredits += calcClaudeCredits({ input: inputTokens, output: outputTokens }, model);
                upsertTrace(entry);
                traceEvents.emit('trace:update', entry);
            }
            else {
                // Parent claude_code.interaction span hasn't arrived yet — buffer the delta.
                const pending = pendingClaudeLlmDeltas.get(traceId) ?? { input: 0, output: 0, cached: 0, credits: 0 };
                pending.input += inputTokens;
                pending.output += outputTokens;
                pending.cached += cachedTokens;
                pending.credits += calcClaudeCredits({ input: inputTokens, output: outputTokens }, model);
                rememberClaudeEntry(pendingClaudeLlmDeltas, traceId, pending);
            }
            continue;
        }
        // ── invoke_agent span = top-level agent turn ──────────────────────────
        if (spanName === 'invoke_agent') {
            const startMs = nanoToMs(span.startTimeUnixNano);
            const endMs = nanoToMs(span.endTimeUnixNano);
            const durationMs = endMs - startMs;
            // Extract repo URL for auto project detection
            const repoUrl = getAttr(attrs, 'github.copilot.git.repository');
            const resolvedProjectId = resolveProjectId(repoUrl, workingDir, projectId);
            // Extract prompt from gen_ai.input.messages (real attr name from copilot)
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
                // Real copilot event for user message
                if (ev.name === 'github.copilot.user.message') {
                    const msg = getAttr(ev.attributes, 'github.copilot.user.message.text')
                        ?? getAttr(ev.attributes, 'gen_ai.prompt');
                    if (msg)
                        promptText = String(msg);
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
                            ? msgs.find((m) => m.role === 'user')
                            : null;
                        if (userMsg?.parts) {
                            promptText = userMsg.parts
                                .filter((p) => p.type === 'text')
                                .map((p) => {
                                // Strip system injections like <current_datetime>...</current_datetime>\n\n
                                let text = p.content ?? '';
                                text = text.replace(/<current_datetime>[\s\S]*?<\/current_datetime>\s*/g, '');
                                text = text.replace(/<system_reminder>[\s\S]*?<\/system_reminder>\s*/g, '');
                                return text.trim();
                            })
                                .join(' ')
                                .trim();
                        }
                        else {
                            promptText = (userMsg?.content ?? String(raw)).trim();
                        }
                    }
                    catch {
                        promptText = String(raw).trim();
                    }
                }
            }
            if (!responseText) {
                const raw = getAttr(attrs, 'gen_ai.output.messages');
                if (raw) {
                    try {
                        const msgs = JSON.parse(String(raw));
                        const assistantMsg = Array.isArray(msgs)
                            ? msgs.find((m) => m.role === 'assistant')
                            : null;
                        if (assistantMsg?.parts) {
                            responseText = assistantMsg.parts
                                .filter((p) => p.type === 'text')
                                .map((p) => p.content ?? '')
                                .join(' ')
                                .slice(0, 1000);
                        }
                        else {
                            responseText = (assistantMsg?.content ?? String(raw)).slice(0, 1000);
                        }
                    }
                    catch {
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
            const inputTokens = Number(getAttr(attrs, 'gen_ai.usage.input_tokens') ?? 0);
            const outputTokens = Number(getAttr(attrs, 'gen_ai.usage.output_tokens') ?? 0);
            // Real cached token attr: gen_ai.usage.cache_read.input_tokens (with dot, not underscore)
            const cachedTokens = Number(getAttr(attrs, 'gen_ai.usage.cache_read.input_tokens')
                ?? getAttr(attrs, 'gen_ai.usage.cache_read_input_tokens')
                ?? 0);
            // Skills from context
            const skillsRaw = getAttr(attrs, 'github.copilot.context.skills');
            const skillCount = skillsRaw ? String(skillsRaw).split(',').filter(Boolean).length : 0;
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
                const inf = inFlight.get(traceId);
                for (const tc of buffered) {
                    inf.entry.toolCalls.push(tc);
                    inf.toolCalls.set(tc.id, tc);
                }
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
                pendingToolCalls.delete(traceId);
            }
            ensureSession(sessionId, resolvedProjectId);
            upsertTrace(entry);
            traceEvents.emit('trace:update', entry);
            traceEvents.emit('trace:done', entry);
            // Clean up ALL standalone chat entries for this traceId (invoke_agent replaces them all)
            const chatKey = `chat:${traceId}`;
            const staleIds = pendingChatIds.get(chatKey) ?? [];
            for (const staleId of staleIds) {
                if (staleId !== entry.id)
                    deleteTrace(staleId);
            }
            pendingChatIds.delete(chatKey);
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
                ensureSession(sessionId, resolveProjectId(getAttr(attrs, 'github.copilot.git.repository'), workingDir, projectId));
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
            // Extract tool input from span attrs (real copilot attr names from debug)
            // gen_ai.tool.call.arguments — JSON string of args
            // github.copilot.tool.parameters.* — individual params (e.g. github.copilot.tool.parameters.command)
            // gen_ai.tool.call.result — tool output
            const argsRaw = getAttr(attrs, 'gen_ai.tool.call.arguments');
            const resultRaw = getAttr(attrs, 'gen_ai.tool.call.result');
            if (argsRaw) {
                try {
                    call.input = JSON.parse(String(argsRaw));
                }
                catch {
                    call.input = { args: String(argsRaw) };
                }
            }
            // Supplement with individual tool params (e.g. command for bash)
            const toolParams = {};
            for (const attr of attrs) {
                if (attr.key?.startsWith('github.copilot.tool.parameters.')) {
                    const paramName = attr.key.replace('github.copilot.tool.parameters.', '');
                    toolParams[paramName] = attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.boolValue;
                }
            }
            if (Object.keys(toolParams).length > 0)
                call.input = { ...call.input, ...toolParams };
            if (resultRaw)
                call.output = String(resultRaw).slice(0, 500);
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
            else {
                // Buffer tool call — invoke_agent hasn't arrived yet
                const buf = pendingToolCalls.get(traceId) ?? [];
                buf.push(call);
                pendingToolCalls.set(traceId, buf);
            }
            continue;
        }
    }
}
function detectToolType(name) {
    const n = name.toLowerCase();
    // MCP — either mcp_ prefix, slash-separated server/tool, or gh CLI (copilot uses gh over MCP)
    if (n.startsWith('mcp_') || n.includes('/') || n === 'gh' || n.startsWith('gh_'))
        return 'mcp';
    // Agent — sub-agent delegation
    if (n.includes('agent') || n.includes('delegate') || n.includes('spawn'))
        return 'agent';
    // Skill — named capability loaded from skills context
    if (n.includes('skill') || n.includes('hermes') || n === 'copilot-tracer')
        return 'skill';
    // Builtin — shell, file, search, etc
    return 'builtin';
}
// ── Register OTLP HTTP routes on the Express app ──────────────────────────────
export function registerOtlpRoutes(app, defaultSessionId, projectId) {
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
                const workingDir = detectWorkingDir(resAttrs);
                for (const ss of rs.scopeSpans ?? []) {
                    processSpans(ss.spans ?? [], sessionId, projectId, workingDir);
                }
            }
            res.status(200).json({ partialSuccess: {} });
        }
        catch (e) {
            console.error('[OTLP] parse error:', e);
            res.status(400).json({ error: 'invalid payload' });
        }
    });
    app.post('/v1/logs', (req, res) => {
        try {
            processClaudeLogs(req.body, defaultSessionId, projectId);
            res.status(200).json({ partialSuccess: {} });
        }
        catch (e) {
            console.error('[OTLP] log parse error:', e);
            res.status(400).json({ error: 'invalid payload' });
        }
    });
    // Metrics remain accepted for Claude Code dashboards but are not trace entries.
    app.post('/v1/metrics', (_req, res) => res.status(200).json({ partialSuccess: {} }));
    console.log('  📡 OTLP receiver ready on /v1/traces and /v1/logs');
}
