/**
 * OpenCode plugin event receiver.
 *
 * The OpenCode plugin the tracer installs (`assets/opencode-plugin/copilot-tracer.js`, wired
 * up by `--setup`) posts each subscribed lifecycle event here, giving the tracer an ordered,
 * complete view of a session — OpenCode has no OTLP export today, so this HTTP endpoint is
 * the single, authoritative source for a session's turns, tool calls, and completion (see
 * specs/001-opencode-support/research.md).
 *
 * Safety contract (this runs inside the user's OpenCode session, so it must never interfere):
 *   - Always answer 204 No Content — so the tracer can never block, delay, or fail the
 *     developer's OpenCode session even on an unexpected payload.
 *   - Never throw. Any error is swallowed and logged; the session continues.
 *   - Do no blocking work. Everything here is in-memory plus one SQLite upsert.
 */
import { execSync } from 'child_process';
import { updateTurn, startToolCall, finishToolCall, finishActiveTurn, endSession, registerSession, } from './openCodeSession.js';
import { ensureProject, ensureProjectByRepo } from './db.js';
function str(value) {
    if (typeof value === 'string' && value.trim())
        return value;
    return undefined;
}
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function errorText(raw) {
    if (raw === undefined || raw === null)
        return undefined;
    if (typeof raw === 'string')
        return raw || undefined;
    try {
        return JSON.stringify(raw);
    }
    catch {
        return String(raw);
    }
}
/**
 * Best-effort `git remote get-url origin` for `directory`, run server-side (never inside the
 * OpenCode plugin) so a slow/missing git binary can never affect the user's session. Returns
 * undefined for anything that isn't a clean git repo with an `origin` remote — callers must
 * treat that as "no repo signal" and fall back to path-based resolution, not an error.
 */
function detectRepoUrl(directory) {
    try {
        const url = execSync('git remote get-url origin', {
            cwd: directory,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000,
        }).trim();
        return url || undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * OpenCode reports the working directory it's running in on every plugin event, which is
 * the best project signal available. Prefers the repo's remote URL — same precedence as
 * `otlpReceiver.ts`'s `resolveProjectId()` — so an OpenCode session in the same repository as
 * an existing Copilot CLI/VS Code session joins that project instead of a separate,
 * path-keyed one. Falls back to path-based association, then to no project at all (FR-002,
 * FR-010) — traces still show up on the live page, associated with a fallback/ungrouped
 * project.
 */
function resolveProject(directory) {
    if (!directory)
        return undefined;
    try {
        const repoUrl = detectRepoUrl(directory);
        if (repoUrl)
            return ensureProjectByRepo(repoUrl);
        return ensureProject(directory);
    }
    catch {
        return undefined;
    }
}
export function handleOpenCodeHook(payload) {
    const event = str(payload.event);
    const sessionId = str(payload.session_id);
    if (!event || !sessionId)
        return;
    const messageId = str(payload.message_id);
    const projectId = resolveProject(str(payload.directory));
    const toolName = str(payload.tool_name) ?? 'OpenCode tool';
    switch (event) {
        case 'session.created':
            registerSession(sessionId, projectId);
            return;
        case 'message.updated': {
            const usage = payload.usage;
            updateTurn({
                sessionId,
                messageId: messageId ?? sessionId,
                prompt: str(payload.prompt),
                response: str(payload.response),
                projectId,
                usage: usage
                    ? {
                        input: num(usage.input),
                        output: num(usage.output),
                        cached: num(usage.cache_read),
                        written: num(usage.cache_write),
                        model: str(usage.model),
                    }
                    : undefined,
            });
            return;
        }
        case 'tool.execute.before':
            startToolCall({
                sessionId,
                messageId,
                toolCallId: str(payload.tool_call_id),
                name: toolName,
                toolInput: payload.tool_input,
                projectId,
            });
            return;
        case 'tool.execute.after':
            finishToolCall({
                sessionId,
                messageId,
                toolCallId: str(payload.tool_call_id),
                name: toolName,
                toolInput: payload.tool_input,
                output: payload.tool_output,
                error: errorText(payload.tool_error),
                projectId,
            });
            return;
        case 'session.idle':
            finishActiveTurn({ sessionId });
            return;
        case 'session.error':
            finishActiveTurn({ sessionId, error: errorText(payload.error) ?? 'OpenCode session error' });
            return;
        case 'session.deleted':
            endSession(sessionId);
            return;
        default:
            // Unknown or unsubscribed event — ignore rather than guess (FR-009).
            return;
    }
}
const stats = { total: 0, byEvent: {}, sessions: new Set() };
function recordHook(payload) {
    const event = str(payload.event) ?? 'unknown';
    stats.total++;
    stats.byEvent[event] = (stats.byEvent[event] ?? 0) + 1;
    const sid = str(payload.session_id);
    if (sid)
        stats.sessions.add(sid);
    const now = new Date().toISOString();
    stats.firstAt ??= now;
    stats.lastAt = now;
    stats.lastPayload = {
        event,
        sessionId: sid,
        messageId: str(payload.message_id),
        tool: str(payload.tool_name),
    };
    if (process.env.COPILOT_TRACER_DEBUG === '1') {
        console.log(`[opencode-hook] ${event} session=${sid ?? '?'} message=${str(payload.message_id) ?? '?'}${payload.tool_name ? ' tool=' + payload.tool_name : ''}`);
    }
}
export function getOpenCodeHookStats() {
    return {
        received: stats.total,
        byEvent: stats.byEvent,
        sessionCount: stats.sessions.size,
        sessions: [...stats.sessions].slice(-10),
        firstAt: stats.firstAt,
        lastAt: stats.lastAt,
        lastPayload: stats.lastPayload,
    };
}
export function registerOpenCodeHookRoutes(app) {
    // The OpenCode plugin posts every subscribed lifecycle event here.
    app.post('/opencode/hook', (req, res) => {
        try {
            const payload = (req.body ?? {});
            recordHook(payload);
            handleOpenCodeHook(payload);
        }
        catch (err) {
            console.error('[opencode-hook] failed to process event:', err);
        }
        // 204 = 2xx with empty body = "no decision". Never influence the session.
        res.status(204).end();
    });
    // Lets `--setup` and users confirm the receiver is reachable, and shows whether
    // OpenCode has actually delivered anything to it.
    app.get('/opencode/hook/health', (_req, res) => {
        res.json({ ok: true, receiver: 'opencode-hooks', ...getOpenCodeHookStats() });
    });
    // A malformed or oversized body fails inside the express.json() middleware, before the
    // route above ever runs, and would otherwise surface to the OpenCode plugin as a 4xx — a
    // non-2xx response is a hook error. Convert it back into "no decision" so a bad payload
    // can still never affect the user's session.
    app.use((err, req, res, next) => {
        if (!req.path.startsWith('/opencode/hook'))
            return next(err);
        console.error('[opencode-hook] rejected malformed request:', err);
        if (res.headersSent)
            return;
        res.status(204).end();
    });
}
