/**
 * Claude Code hook receiver.
 *
 * Claude Code posts each lifecycle event here as a native `type: "http"` hook, giving
 * the tracer an ordered, complete view of a session: every prompt, every tool call, and
 * every turn boundary — the things OTLP alone can't correlate reliably across a
 * multi-prompt session.
 *
 * Safety contract (this runs inside the user's Claude session, so it must never interfere):
 *   - Always answer 204 No Content. Per the hooks spec a 2xx with an empty body means
 *     "no decision", so the tracer can never block a tool call, deny a permission, or
 *     stop a turn — even if the handler hits an unexpected payload.
 *   - Never throw. Any error is swallowed and logged; the session continues.
 *   - Do no blocking work. Everything here is in-memory plus one SQLite upsert.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import {
  startTurn,
  finishTurn,
  startToolCall,
  finishToolCall,
  endSession,
  registerSession,
} from './claudeSession.js';
import { ensureProject } from './db.js';

/** The subset of Claude Code's hook payload the tracer reads. */
interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  /** Matches the OTLP `prompt.id` attribute — the join key for the hybrid design. */
  prompt_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_error?: unknown;
  error?: unknown;
  error_details?: unknown;
  last_assistant_message?: string;
  reason?: string;
  source?: string;
  [key: string]: unknown;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

function errorText(payload: ClaudeHookPayload): string | undefined {
  const raw = payload.tool_error ?? payload.error;
  let code: string | undefined;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'string') code = raw || undefined;
    else {
      try {
        code = JSON.stringify(raw);
      } catch {
        code = String(raw);
      }
    }
  }
  // `error` is a terse machine code like "authentication_failed". On its own it leaves the
  // user guessing why a turn produced no tokens or tools, so append whatever human-readable
  // detail Claude sent alongside it.
  const detail = str(payload.error_details) ?? str(payload.last_assistant_message);
  if (code && detail && !code.includes(detail)) return `${code}: ${detail}`;
  return code ?? detail;
}

/**
 * Claude reports the working directory it's actually in (worktree-aware), which is the
 * best project signal available from a hook. Falls back to no project — traces still
 * show up on the live page.
 */
function resolveProject(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    return ensureProject(cwd);
  } catch {
    return undefined;
  }
}

export function handleClaudeHook(payload: ClaudeHookPayload): void {
  const event = str(payload.hook_event_name);
  const sessionId = str(payload.session_id);
  if (!event || !sessionId) return;

  const promptId = str(payload.prompt_id);
  const projectId = resolveProject(str(payload.cwd));
  const toolName = str(payload.tool_name) ?? 'Claude Code tool';

  switch (event) {
    case 'SessionStart':
      registerSession(sessionId, projectId);
      return;

    case 'UserPromptSubmit':
      startTurn({
        sessionId,
        promptId,
        prompt: str(payload.prompt) ?? '[Claude Code prompt]',
        projectId,
      });
      return;

    case 'PreToolUse':
      startToolCall({
        sessionId,
        promptId,
        toolUseId: str(payload.tool_use_id),
        name: toolName,
        toolInput: payload.tool_input,
        projectId,
      });
      return;

    case 'PostToolUse':
    case 'PostToolUseFailure':
      finishToolCall({
        sessionId,
        promptId,
        toolUseId: str(payload.tool_use_id),
        name: toolName,
        toolInput: payload.tool_input,
        output: payload.tool_response,
        error: event === 'PostToolUseFailure' ? (errorText(payload) ?? 'tool failed') : errorText(payload),
        projectId,
      });
      return;

    case 'Stop':
    case 'SubagentStop':
      finishTurn({
        sessionId,
        promptId,
        response: str(payload.last_assistant_message),
      });
      return;

    case 'StopFailure':
      finishTurn({
        sessionId,
        promptId,
        error: errorText(payload) ?? str(payload.reason) ?? 'Claude Code turn failed',
      });
      return;

    case 'SessionEnd':
      endSession(sessionId);
      return;

    default:
      // Unknown or unsubscribed event — ignore rather than guess.
      return;
  }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
// When hooks silently don't fire there is otherwise no way to tell "Claude never
// called us" from "Claude called us and we ignored it". This records what actually
// arrived so `--check-claude` (and the health endpoint) can answer that question.

interface HookStats {
  total: number;
  byEvent: Record<string, number>;
  sessions: Set<string>;
  firstAt?: string;
  lastAt?: string;
  lastPayload?: { event?: string; sessionId?: string; promptId?: string; tool?: string };
}

const stats: HookStats = { total: 0, byEvent: {}, sessions: new Set() };

function recordHook(payload: ClaudeHookPayload): void {
  const event = str(payload.hook_event_name) ?? 'unknown';
  stats.total++;
  stats.byEvent[event] = (stats.byEvent[event] ?? 0) + 1;
  const sid = str(payload.session_id);
  if (sid) stats.sessions.add(sid);
  const now = new Date().toISOString();
  stats.firstAt ??= now;
  stats.lastAt = now;
  stats.lastPayload = {
    event,
    sessionId: sid,
    promptId: str(payload.prompt_id),
    tool: str(payload.tool_name),
  };
  if (process.env.COPILOT_TRACER_DEBUG === '1') {
    console.log(`[claude-hook] ${event} session=${sid ?? '?'} prompt=${str(payload.prompt_id) ?? '?'}${payload.tool_name ? ' tool=' + payload.tool_name : ''}`);
  }
}

export function getClaudeHookStats() {
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

export function registerClaudeHookRoutes(app: Express): void {
  // Claude Code posts every subscribed lifecycle event here.
  app.post('/claude/hook', (req: Request, res: Response) => {
    try {
      const payload = (req.body ?? {}) as ClaudeHookPayload;
      recordHook(payload);
      handleClaudeHook(payload);
    } catch (err) {
      console.error('[claude-hook] failed to process event:', err);
    }
    // 204 = 2xx with empty body = "no decision". Never influence the session.
    res.status(204).end();
  });

  // Lets `--setup` and users confirm the receiver is reachable, and shows whether
  // Claude has actually delivered anything to it.
  app.get('/claude/hook/health', (_req: Request, res: Response) => {
    res.json({ ok: true, receiver: 'claude-hooks', ...getClaudeHookStats() });
  });

  // A malformed or oversized body fails inside the express.json() middleware, before the
  // route above ever runs, and would otherwise surface to Claude as a 4xx — a non-2xx
  // response is a hook error. Convert it back into "no decision" so a bad payload can
  // still never affect the user's session.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/claude/hook')) return next(err);
    console.error('[claude-hook] rejected malformed request:', err);
    if (res.headersSent) return;
    res.status(204).end();
  });
}
