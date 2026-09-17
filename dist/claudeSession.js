/**
 * Claude Code session tracker — the "hook" half of the hybrid tracing design.
 *
 * Why this exists
 * ---------------
 * Claude Code's OTLP stream alone can't reliably reconstruct a multi-prompt session.
 * Its log events are correlated by `prompt.id` while its spans are correlated by OTLP
 * `traceId`, and neither key is guaranteed to be present, so turns after the first one
 * would routinely lose their tool calls or land on a duplicate entry.
 *
 * Claude Code hooks give us a deterministic, ordered lifecycle instead:
 *   UserPromptSubmit → PreToolUse* / PostToolUse* → Stop
 * and every hook payload carries `session_id` plus `prompt_id`, where `prompt_id` is
 * documented to match the OTLP `prompt.id` attribute. That shared key is what lets the
 * two halves join up.
 *
 * Division of responsibility:
 *   - Hooks own the turn/tool *lifecycle* (what happened, in what order, on which turn).
 *   - OTLP owns *enrichment* (tokens, model, cost), applied onto the hook-created turn.
 *
 * When hooks aren't configured the OTLP receiver keeps its original standalone behaviour,
 * so this module degrades to a no-op rather than breaking existing users.
 */
import { randomUUID } from 'crypto';
import { upsertTrace, createSession } from './db.js';
import { traceEvents } from './proxy.js';
import { calcClaudeCredits } from './claudePricing.js';
// ── Bounded state ─────────────────────────────────────────────────────────────
// A long-lived daemon sees unbounded sessions, so every map is FIFO-capped.
const ACTIVE_LIMIT = 200; // concurrent Claude sessions we track turns for
const HISTORY_LIMIT = 2000; // finished turns retained for late OTLP enrichment
const PENDING_LIMIT = 2000; // buffered usage waiting for its turn to appear
const PENDING_TTL_MS = 10 * 60 * 1000;
/** sessionId → the turn currently open for that session */
const activeBySession = new Map();
/** promptId → turn (open or closed). The join key shared with OTLP's `prompt.id`. */
const turnsByPromptId = new Map();
/** sessionId → most recently closed turn, so usage arriving after Stop still lands */
const lastClosedBySession = new Map();
/** buffered usage for turns that haven't been created yet, keyed `p:<promptId>`/`s:<sessionId>` */
const pendingUsage = new Map();
/**
 * Sessions that have produced at least one hook event — enables hook-authoritative mode.
 * A Map (not a Set) so it can be FIFO-capped: real sessions frequently end without a
 * SessionEnd hook (crash, kill, machine sleep), and this daemon runs for weeks.
 */
const hookSessions = new Map();
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
// ── Tool classification ───────────────────────────────────────────────────────
// Claude's tool vocabulary differs from Copilot's, so it gets its own classifier
// rather than reusing the Copilot heuristics (which would mislabel `Task`/`Skill`).
export function detectClaudeToolType(name) {
    const n = name.toLowerCase();
    if (n.startsWith('mcp__') || n.startsWith('mcp_'))
        return 'mcp';
    if (n === 'task' || n === 'agent' || n.includes('subagent'))
        return 'agent';
    if (n === 'skill' || n.startsWith('skill__') || n.includes('skill'))
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
// ── Pending-usage buffering ───────────────────────────────────────────────────
function pendingKeys(sessionId, promptId) {
    const keys = [];
    if (promptId)
        keys.push(`p:${promptId}`);
    if (sessionId)
        keys.push(`s:${sessionId}`);
    return keys;
}
function bufferUsage(delta, sessionId, promptId) {
    const key = pendingKeys(sessionId, promptId)[0];
    if (!key)
        return;
    const existing = pendingUsage.get(key);
    if (existing) {
        mergeDelta(existing.delta, delta);
        existing.at = Date.now();
    }
    else {
        pendingUsage.set(key, { delta: { ...delta }, at: Date.now() });
    }
    expirePending();
    capped(pendingUsage, PENDING_LIMIT);
}
function mergeDelta(target, extra) {
    target.input = (target.input ?? 0) + (extra.input ?? 0);
    target.output = (target.output ?? 0) + (extra.output ?? 0);
    target.cached = (target.cached ?? 0) + (extra.cached ?? 0);
    target.reasoning = (target.reasoning ?? 0) + (extra.reasoning ?? 0);
    target.written = (target.written ?? 0) + (extra.written ?? 0);
    target.credits = (target.credits ?? 0) + (extra.credits ?? 0);
    target.model = extra.model ?? target.model;
}
function expirePending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, value] of pendingUsage) {
        if (value.at < cutoff)
            pendingUsage.delete(key);
    }
}
function drainPending(ctx) {
    const keys = [`p:${ctx.promptId ?? ''}`];
    // Session-keyed usage is only ever buffered when the session had no turn at all, so
    // it belongs to the session's first turn. Claiming it later would credit one turn's
    // tokens to an unrelated, subsequent turn.
    if (!lastClosedBySession.has(ctx.sessionId))
        keys.push(`s:${ctx.sessionId}`);
    for (const key of keys) {
        if (key === 'p:')
            continue;
        const buffered = pendingUsage.get(key);
        if (!buffered)
            continue;
        pendingUsage.delete(key);
        addUsage(ctx, buffered.delta);
    }
}
function addUsage(ctx, delta) {
    const t = ctx.entry.tokens;
    t.input += delta.input ?? 0;
    t.output += delta.output ?? 0;
    t.cached += delta.cached ?? 0;
    t.reasoning += delta.reasoning ?? 0;
    t.written += delta.written ?? 0;
    // Matches the rest of the codebase (proxy.ts, the OTLP fallback path): `written` and
    // `cached` are reporting breakdowns of the same traffic, so summing them into `total`
    // would double-count output tokens.
    t.total = t.input + t.output;
    if (delta.model)
        ctx.model = delta.model;
    ctx.entry.aiCredits += delta.credits
        ?? calcClaudeCredits({ input: delta.input ?? 0, output: delta.output ?? 0 }, delta.model ?? ctx.model);
}
// ── Turn lookup ───────────────────────────────────────────────────────────────
/**
 * Resolve the turn an OTLP event belongs to. Prefers the exact `prompt.id` join,
 * then the session's open turn, then the session's most recently closed turn
 * (usage spans routinely arrive just after Stop).
 */
export function findClaudeTurn(sessionId, promptId) {
    if (promptId) {
        const byPrompt = turnsByPromptId.get(promptId);
        if (byPrompt)
            return byPrompt;
    }
    if (sessionId) {
        return activeBySession.get(sessionId) ?? lastClosedBySession.get(sessionId);
    }
    return undefined;
}
/** True when hooks have reported activity for this session, so hooks own its lifecycle. */
export function isHookTracked(sessionId) {
    return !!sessionId && hookSessions.has(sessionId);
}
function markHookSession(sessionId) {
    // Re-insert so the most recently active sessions are evicted last.
    hookSessions.delete(sessionId);
    hookSessions.set(sessionId, Date.now());
    capped(hookSessions, ACTIVE_LIMIT);
}
// ── Lifecycle: turns ──────────────────────────────────────────────────────────
export function startTurn(input) {
    const { sessionId, promptId, projectId } = input;
    markHookSession(sessionId);
    // Claude re-fires UserPromptSubmit for the same prompt_id (retries, resubmits). Reuse
    // that turn. This must be checked BEFORE closing the stale turn below, since the two
    // are frequently the same context — closing it first would force a duplicate trace.
    const existing = promptId ? turnsByPromptId.get(promptId) : undefined;
    if (existing && !existing.closed) {
        existing.entry.prompt = input.prompt || existing.entry.prompt;
        activeBySession.set(sessionId, existing);
        persist(existing);
        return existing;
    }
    // A different turn that never received Stop (crash, /clear, interrupt) would otherwise
    // sit at status 'running' forever and swallow this turn's tool calls.
    const stale = activeBySession.get(sessionId);
    if (stale && stale !== existing && !stale.closed)
        closeTurn(stale, { status: 'done' });
    const startedAtMs = Date.now();
    const entry = {
        id: `claude:turn:${promptId ?? randomUUID()}`,
        sessionId,
        dateTime: input.dateTime ?? new Date(startedAtMs).toISOString(),
        prompt: input.prompt || '[Claude Code prompt]',
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
        sessionId,
        promptId,
        startedAtMs,
        closed: false,
    };
    activeBySession.set(sessionId, ctx);
    capped(activeBySession, ACTIVE_LIMIT);
    if (promptId) {
        turnsByPromptId.set(promptId, ctx);
        capped(turnsByPromptId, HISTORY_LIMIT);
    }
    createSession(sessionId, projectId);
    drainPending(ctx);
    persist(ctx);
    return ctx;
}
function closeTurn(ctx, opts) {
    if (!ctx.closed) {
        ctx.entry.durationMs = ctx.entry.durationMs || Date.now() - ctx.startedAtMs;
        ctx.closed = true;
    }
    if (opts.response)
        ctx.entry.response = opts.response;
    if (opts.error)
        ctx.entry.error = opts.error;
    // A turn can be closed twice: the Stop hook fires, then the OTLP assistant_response
    // event arrives to backfill the text. The second call must not downgrade a failure
    // (StopFailure) back to 'done'.
    if (opts.error) {
        ctx.entry.status = 'error';
    }
    else if (ctx.entry.status !== 'error') {
        ctx.entry.status = opts.status ?? 'done';
    }
    // Any tool still open at turn end never got its PostToolUse (denied, interrupted,
    // or the session ended mid-call). Close it out rather than leaving it dangling.
    for (const call of ctx.entry.toolCalls) {
        if (call.endedAt === undefined) {
            call.endedAt = Date.now();
            call.durationMs = call.endedAt - call.startedAt;
            call.error = call.error ?? 'incomplete (no PostToolUse received)';
        }
    }
    if (activeBySession.get(ctx.sessionId) === ctx)
        activeBySession.delete(ctx.sessionId);
    lastClosedBySession.set(ctx.sessionId, ctx);
    capped(lastClosedBySession, ACTIVE_LIMIT);
    persist(ctx, true);
}
export function finishTurn(input) {
    const ctx = findClaudeTurn(input.sessionId, input.promptId);
    if (!ctx)
        return;
    markHookSession(input.sessionId);
    closeTurn(ctx, { response: input.response, error: input.error });
}
export function endSession(sessionId) {
    const ctx = activeBySession.get(sessionId);
    if (ctx && !ctx.closed)
        closeTurn(ctx, { status: 'done' });
    activeBySession.delete(sessionId);
    hookSessions.delete(sessionId);
}
export function registerSession(sessionId, projectId) {
    markHookSession(sessionId);
    createSession(sessionId, projectId);
}
// ── Lifecycle: tool calls ─────────────────────────────────────────────────────
/**
 * Pre/Post hook pairs share `tool_use_id` on recent Claude Code versions. Older
 * versions omit it, so fall back to a stable key derived from name + input.
 */
function toolKey(toolUseId, name, input) {
    if (toolUseId)
        return toolUseId;
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
 * Attach a tool call to the session's open turn. If no turn exists (hooks enabled
 * mid-session, or a subagent session whose UserPromptSubmit we never saw) an implicit
 * turn is created so the call is recorded rather than silently dropped.
 */
function turnForTool(sessionId, promptId, projectId) {
    // A tool event carrying a prompt_id belongs to that prompt's turn, full stop — even if
    // the turn already closed. Falling back to the session's *current* turn here would file
    // a straggling PostToolUse from the previous prompt onto the next prompt's trace.
    const existing = promptId ? turnsByPromptId.get(promptId) : undefined;
    if (existing)
        return existing;
    const active = activeBySession.get(sessionId);
    if (active && !active.closed)
        return active;
    return startTurn({ sessionId, promptId, prompt: '[Claude Code turn]', projectId });
}
export function startToolCall(input) {
    markHookSession(input.sessionId);
    const ctx = turnForTool(input.sessionId, input.promptId, input.projectId);
    const key = toolKey(input.toolUseId, input.name, input.toolInput);
    const previous = ctx.tools.get(key);
    // Without a tool_use_id the key is only name+input, so a repeat of an identical call
    // collides with the earlier one. Skip only while that earlier call is still open (a
    // genuine duplicate PreToolUse); once it has completed, this is a new call.
    if (previous && previous.endedAt === undefined)
        return;
    const call = {
        id: input.toolUseId ?? randomUUID(),
        name: input.name,
        type: detectClaudeToolType(input.name),
        input: input.toolInput ?? {},
        startedAt: Date.now(),
    };
    ctx.tools.set(key, call);
    ctx.entry.toolCalls.push(call);
    persist(ctx);
}
export function finishToolCall(input) {
    markHookSession(input.sessionId);
    const ctx = turnForTool(input.sessionId, input.promptId, input.projectId);
    const key = toolKey(input.toolUseId, input.name, input.toolInput);
    let call = ctx.tools.get(key);
    if (!call) {
        // PostToolUse without a matching PreToolUse (hook added mid-call, or matcher
        // mismatch). Record it as a zero-duration call so the tool isn't lost.
        call = {
            id: input.toolUseId ?? randomUUID(),
            name: input.name,
            type: detectClaudeToolType(input.name),
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
// ── Enrichment from OTLP ──────────────────────────────────────────────────────
/**
 * Apply token/model/cost usage reported over OTLP onto the matching hook turn.
 * Returns false when no turn matched — the usage is buffered, and the caller may
 * fall back to its own standalone handling.
 */
export function applyClaudeUsage(input) {
    const ctx = findClaudeTurn(input.sessionId, input.promptId);
    if (!ctx) {
        bufferUsage(input.delta, input.sessionId, input.promptId);
        return false;
    }
    addUsage(ctx, input.delta);
    persist(ctx);
    return true;
}
/** Fill in prompt/response text discovered over OTLP without clobbering hook data. */
export function enrichClaudeContent(input) {
    const ctx = findClaudeTurn(input.sessionId, input.promptId);
    if (!ctx)
        return false;
    const placeholder = /^\[Claude Code (prompt|turn)\]$/;
    if (input.prompt && placeholder.test(ctx.entry.prompt))
        ctx.entry.prompt = input.prompt;
    if (input.response && !ctx.entry.response)
        ctx.entry.response = input.response;
    persist(ctx);
    return true;
}
/** Test-only: drop all in-memory state. */
export function resetClaudeTracker() {
    activeBySession.clear();
    turnsByPromptId.clear();
    lastClosedBySession.clear();
    pendingUsage.clear();
    hookSessions.clear();
}
