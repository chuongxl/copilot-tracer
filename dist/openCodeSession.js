/**
 * OpenCode session tracker.
 *
 * OpenCode has no OTLP export today; its only documented integration surface is a plugin
 * system (`.opencode/plugins/`, `~/.config/opencode/plugins/`, or an npm package) whose
 * hooks receive session/message/tool lifecycle events directly. This design follows the
 * same "hooks own the lifecycle" pattern used elsewhere for host integrations that lack
 * OTLP export, but simpler: there is no separate telemetry stream to join against — the
 * plugin's events are the single, authoritative source for a turn's lifecycle, content,
 * and token usage (research.md R2/R9 in specs/001-opencode-support/).
 *
 * A turn is keyed on `(sessionId, messageId)` and a tool call on `(messageId, toolCallId)`
 * (spec Clarifications, data-model.md), so a redelivered event upserts the existing record
 * instead of creating a duplicate one.
 */
import { randomUUID } from 'crypto';
import { upsertTrace, createSession } from './db.js';
import { traceEvents } from './proxy.js';
import { calcOpenCodeCredits } from './openCodePricing.js';
// ── Bounded state ─────────────────────────────────────────────────────────────
// A long-lived daemon sees unbounded sessions, so every map is FIFO-capped.
const ACTIVE_LIMIT = 200; // concurrent OpenCode sessions we track turns for
const HISTORY_LIMIT = 2000; // finished turns retained for late tool-call events
/**
 * A turn with no terminal signal (`session.idle` / `session.error`) for longer than this
 * is considered abandoned (process killed, machine slept) and is closed as `error` rather
 * than staying `running` forever (FR-011, spec Edge Cases).
 */
const STALE_TURN_MS = 30 * 60 * 1000;
/** sessionId → the turn currently open for that session */
const activeBySession = new Map();
/** `${sessionId}:${messageId}` → turn (open or closed). The idempotency key for turns. */
const turnsByKey = new Map();
/** sessionId → last-seen timestamp, purely for FIFO capping of known sessions */
const knownSessions = new Map();
function capped(map, limit) {
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined)
            return;
        map.delete(oldest);
    }
}
function emptyTokens() {
    return { input: 0, output: 0, cached: 0, reasoning: 0, written: 0, total: 0 };
}
function turnKey(sessionId, messageId) {
    return `${sessionId}:${messageId}`;
}
// ── Tool classification ───────────────────────────────────────────────────────
// OpenCode's tool vocabulary (bash/read/edit/write/grep/glob, MCP-backed tools, its own
// sub-agent/task delegation) gets its own classifier, matched to OpenCode's actual naming
// (research.md R6) rather than reusing any other host's tool taxonomy.
export function detectOpenCodeToolType(name) {
    const n = name.toLowerCase();
    if (n.startsWith('mcp__') || n.startsWith('mcp_'))
        return 'mcp';
    if (n === 'task' || n === 'agent' || n.includes('subagent') || n.includes('delegate'))
        return 'agent';
    // OpenCode has no distinct "skill" primitive; only classify as one when the tool's own
    // name says so, otherwise fall back to builtin (research.md R6).
    if (n.includes('skill'))
        return 'skill';
    return 'builtin';
}
function recount(entry) {
    entry.skillCount = entry.toolCalls.filter(c => c.type === 'skill').length;
    entry.agentCount = entry.toolCalls.filter(c => c.type === 'agent').length;
    entry.mcpCount = entry.toolCalls.filter(c => c.type === 'mcp').length;
}
function persist(ctx, done = false) {
    recount(ctx.entry);
    upsertTrace(ctx.entry);
    traceEvents.emit('trace:update', ctx.entry);
    if (done)
        traceEvents.emit('trace:done', ctx.entry);
}
function markSession(sessionId) {
    // Re-insert so the most recently active sessions are evicted last.
    knownSessions.delete(sessionId);
    knownSessions.set(sessionId, Date.now());
    capped(knownSessions, ACTIVE_LIMIT);
}
// ── Stale-turn expiry (FR-011) ────────────────────────────────────────────────
function expireStaleTurns() {
    const cutoff = Date.now() - STALE_TURN_MS;
    for (const ctx of activeBySession.values()) {
        if (!ctx.closed && ctx.startedAtMs < cutoff) {
            closeTurn(ctx, { error: 'OpenCode turn timed out (no completion signal received)' });
        }
    }
}
// ── Lifecycle: turns ──────────────────────────────────────────────────────────
function closeTurn(ctx, opts) {
    if (!ctx.closed) {
        ctx.entry.durationMs = ctx.entry.durationMs || Date.now() - ctx.startedAtMs;
        ctx.closed = true;
    }
    if (opts.response)
        ctx.entry.response = opts.response;
    if (opts.error)
        ctx.entry.error = opts.error;
    // A turn can be asked to close twice (e.g. session.idle after an already-errored turn);
    // never downgrade an error back to done.
    if (opts.error) {
        ctx.entry.status = 'error';
    }
    else if (ctx.entry.status !== 'error') {
        ctx.entry.status = 'done';
    }
    // Any tool still open at turn end never got its tool.execute.after (denied,
    // interrupted, or the session ended mid-call). Close it out rather than leaving it
    // dangling.
    for (const call of ctx.entry.toolCalls) {
        if (call.endedAt === undefined) {
            call.endedAt = Date.now();
            call.durationMs = call.endedAt - call.startedAt;
            call.error = call.error ?? 'incomplete (no tool.execute.after received)';
        }
    }
    if (activeBySession.get(ctx.sessionId) === ctx)
        activeBySession.delete(ctx.sessionId);
    persist(ctx, true);
}
export function registerSession(sessionId, projectId) {
    markSession(sessionId);
    createSession(sessionId, projectId);
}
/**
 * Start (or, on redelivery, update) the turn for `(sessionId, messageId)`. Idempotent:
 * a repeat call for the same key updates the existing entry instead of creating a new
 * one (FR-009, spec Clarifications).
 */
export function startTurn(input) {
    expireStaleTurns();
    markSession(input.sessionId);
    const key = turnKey(input.sessionId, input.messageId);
    const existing = turnsByKey.get(key);
    if (existing) {
        if (input.prompt && (!existing.entry.prompt || existing.entry.prompt === '[OpenCode prompt]')) {
            existing.entry.prompt = input.prompt;
        }
        if (!existing.closed)
            activeBySession.set(input.sessionId, existing);
        persist(existing);
        return existing;
    }
    // A different turn in the same session that never received session.idle/session.error
    // (a new message started before the previous one signalled completion) would otherwise
    // sit at 'running' forever and swallow this turn's tool calls.
    const stale = activeBySession.get(input.sessionId);
    if (stale && !stale.closed)
        closeTurn(stale, {});
    const startedAtMs = Date.now();
    const entry = {
        id: `opencode:turn:${key}`,
        sessionId: input.sessionId,
        dateTime: input.dateTime ?? new Date(startedAtMs).toISOString(),
        prompt: input.prompt || '[OpenCode prompt]',
        tokens: emptyTokens(),
        aiCredits: 0,
        durationMs: 0,
        toolCalls: [],
        skillCount: 0,
        agentCount: 0,
        mcpCount: 0,
        status: 'running',
    };
    const ctx = {
        entry,
        tools: new Map(),
        sessionId: input.sessionId,
        messageId: input.messageId,
        startedAtMs,
        closed: false,
    };
    activeBySession.set(input.sessionId, ctx);
    capped(activeBySession, ACTIVE_LIMIT);
    turnsByKey.set(key, ctx);
    capped(turnsByKey, HISTORY_LIMIT);
    createSession(input.sessionId, input.projectId);
    persist(ctx);
    return ctx;
}
/** Look up an existing turn (open or closed) by its idempotency key. */
export function findOpenCodeTurn(sessionId, messageId) {
    if (!messageId)
        return activeBySession.get(sessionId);
    return turnsByKey.get(turnKey(sessionId, messageId));
}
/**
 * Apply response text and/or usage reported on a `message.updated` event onto the turn
 * for `(sessionId, messageId)`, creating it first if this is the first event seen for it.
 */
export function updateTurn(input) {
    const ctx = findOpenCodeTurn(input.sessionId, input.messageId)
        ?? startTurn({ sessionId: input.sessionId, messageId: input.messageId, prompt: input.prompt ?? '', projectId: input.projectId });
    // A tool event can create an implicit turn (prompt: '[OpenCode turn]') before
    // message.updated ever arrives with the real prompt — backfill it once available.
    if (input.prompt && (!ctx.entry.prompt || ctx.entry.prompt === '[OpenCode turn]' || ctx.entry.prompt === '[OpenCode prompt]')) {
        ctx.entry.prompt = input.prompt;
    }
    if (input.response)
        ctx.entry.response = input.response;
    if (input.usage)
        applyUsage(ctx, input.usage);
    persist(ctx);
    return ctx;
}
function applyUsage(ctx, delta) {
    const t = ctx.entry.tokens;
    t.input += delta.input ?? 0;
    t.output += delta.output ?? 0;
    t.cached += delta.cached ?? 0;
    t.reasoning += delta.reasoning ?? 0;
    t.written += delta.written ?? 0;
    // Matches the rest of the codebase: `written`/`cached` are reporting breakdowns of the
    // same traffic, so summing them into `total` would double-count output tokens.
    t.total = t.input + t.output;
    if (delta.model)
        ctx.model = delta.model;
    ctx.entry.aiCredits += delta.credits
        ?? calcOpenCodeCredits({ input: delta.input ?? 0, output: delta.output ?? 0 }, delta.model ?? ctx.model);
}
/**
 * Close the currently-open turn for a session in response to `session.idle`
 * (success) or `session.error` (failure) — these events describe the session as a
 * whole rather than carrying a specific `messageId`.
 */
export function finishActiveTurn(input) {
    markSession(input.sessionId);
    const ctx = activeBySession.get(input.sessionId);
    if (!ctx || ctx.closed)
        return;
    closeTurn(ctx, { error: input.error });
}
export function endSession(sessionId) {
    const ctx = activeBySession.get(sessionId);
    if (ctx && !ctx.closed)
        closeTurn(ctx, {});
    activeBySession.delete(sessionId);
    knownSessions.delete(sessionId);
}
// ── Lifecycle: tool calls ─────────────────────────────────────────────────────
/**
 * `tool.execute.before`/`tool.execute.after` share a `tool_call_id` on OpenCode's plugin
 * events; fall back to a stable key derived from name + input if it's ever absent.
 */
function toolKey(toolCallId, name, input) {
    if (toolCallId)
        return toolCallId;
    let serialized = '';
    try {
        serialized = JSON.stringify(input ?? {});
    }
    catch {
        serialized = String(input);
    }
    return `${name}:${serialized.slice(0, 512)}`;
}
/**
 * Attach a tool call to the session's turn for `messageId`. If no turn exists yet
 * (a tool event arrived before/without a matching `message.updated`) an implicit turn
 * is created so the call is recorded rather than silently dropped.
 */
function turnForTool(sessionId, messageId, projectId) {
    const key = messageId ?? '';
    if (key) {
        const existing = turnsByKey.get(turnKey(sessionId, key));
        if (existing)
            return existing;
    }
    const active = activeBySession.get(sessionId);
    if (active && !active.closed)
        return active;
    return startTurn({ sessionId, messageId: messageId ?? randomUUID(), prompt: '[OpenCode turn]', projectId });
}
export function startToolCall(input) {
    markSession(input.sessionId);
    const ctx = turnForTool(input.sessionId, input.messageId, input.projectId);
    const key = toolKey(input.toolCallId, input.name, input.toolInput);
    const previous = ctx.tools.get(key);
    // Without a tool_call_id the key is only name+input, so a repeat of an identical call
    // collides with the earlier one. Skip only while that earlier call is still open (a
    // genuine duplicate tool.execute.before); once it has completed, this is a new call.
    if (previous && previous.endedAt === undefined)
        return;
    const call = {
        id: input.toolCallId ?? randomUUID(),
        name: input.name,
        type: detectOpenCodeToolType(input.name),
        input: input.toolInput ?? {},
        startedAt: Date.now(),
    };
    ctx.tools.set(key, call);
    ctx.entry.toolCalls.push(call);
    persist(ctx);
}
export function finishToolCall(input) {
    markSession(input.sessionId);
    const ctx = turnForTool(input.sessionId, input.messageId, input.projectId);
    const key = toolKey(input.toolCallId, input.name, input.toolInput);
    let call = ctx.tools.get(key);
    if (!call) {
        // tool.execute.after without a matching tool.execute.before. Record it as a
        // zero-duration call so the tool isn't lost.
        call = {
            id: input.toolCallId ?? randomUUID(),
            name: input.name,
            type: detectOpenCodeToolType(input.name),
            input: input.toolInput ?? {},
            startedAt: Date.now(),
        };
        ctx.tools.set(key, call);
        ctx.entry.toolCalls.push(call);
    }
    call.endedAt = Date.now();
    call.durationMs = call.endedAt - call.startedAt;
    if (input.output !== undefined)
        call.output = input.output;
    if (input.error)
        call.error = input.error;
    persist(ctx);
}
/** Test-only: drop all in-memory state. */
export function resetOpenCodeTracker() {
    activeBySession.clear();
    turnsByKey.clear();
    knownSessions.clear();
}
