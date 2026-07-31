import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
const DB_DIR = path.join(os.homedir(), '.copilot-tracer');
const DB_PATH = path.join(DB_DIR, 'traces.db');
if (!fs.existsSync(DB_DIR))
    fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    date_time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    response TEXT,
    reasoning TEXT,
    tokens_input INTEGER DEFAULT 0,
    tokens_output INTEGER DEFAULT 0,
    tokens_cached INTEGER DEFAULT 0,
    tokens_reasoning INTEGER DEFAULT 0,
    tokens_written INTEGER DEFAULT 0,
    tokens_total INTEGER DEFAULT 0,
    ai_credits REAL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    tool_calls TEXT DEFAULT '[]',
    skill_count INTEGER DEFAULT 0,
    agent_count INTEGER DEFAULT 0,
    mcp_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running',
    error TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
`);
export function createSession(id) {
    db.prepare('INSERT OR REPLACE INTO sessions (id, started_at) VALUES (?, ?)').run(id, new Date().toISOString());
}
export function upsertTrace(entry) {
    db.prepare(`
    INSERT OR REPLACE INTO traces (
      id, session_id, date_time, prompt, response, reasoning,
      tokens_input, tokens_output, tokens_cached, tokens_reasoning, tokens_written, tokens_total,
      ai_credits, duration_ms, tool_calls,
      skill_count, agent_count, mcp_count, status, error
    ) VALUES (
      @id, @sessionId, @dateTime, @prompt, @response, @reasoning,
      @tokensInput, @tokensOutput, @tokensCached, @tokensReasoning, @tokensWritten, @tokensTotal,
      @aiCredits, @durationMs, @toolCalls,
      @skillCount, @agentCount, @mcpCount, @status, @error
    )
  `).run({
        id: entry.id,
        sessionId: entry.sessionId,
        dateTime: entry.dateTime,
        prompt: entry.prompt,
        response: entry.response ?? null,
        reasoning: entry.reasoning ?? null,
        tokensInput: entry.tokens.input,
        tokensOutput: entry.tokens.output,
        tokensCached: entry.tokens.cached,
        tokensReasoning: entry.tokens.reasoning,
        tokensWritten: entry.tokens.written,
        tokensTotal: entry.tokens.total,
        aiCredits: entry.aiCredits,
        durationMs: entry.durationMs,
        toolCalls: JSON.stringify(entry.toolCalls),
        skillCount: entry.skillCount,
        agentCount: entry.agentCount,
        mcpCount: entry.mcpCount,
        status: entry.status,
        error: entry.error ?? null,
    });
}
export function getTraces(sessionId, limit = 100) {
    const rows = sessionId
        ? db.prepare('SELECT * FROM traces WHERE session_id = ? ORDER BY date_time DESC LIMIT ?').all(sessionId, limit)
        : db.prepare('SELECT * FROM traces ORDER BY date_time DESC LIMIT ?').all(limit);
    return rows.map((r) => rowToEntry(r));
}
export function getTrace(id) {
    const row = db.prepare('SELECT * FROM traces WHERE id = ?').get(id);
    return row ? rowToEntry(row) : null;
}
export function getSessionSummary(sessionId) {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session)
        return null;
    const stats = db.prepare(`
    SELECT
      COUNT(*) as entries,
      SUM(tokens_input) as input,
      SUM(tokens_output) as output,
      SUM(tokens_cached) as cached,
      SUM(tokens_reasoning) as reasoning,
      SUM(tokens_written) as written,
      SUM(tokens_total) as total,
      SUM(ai_credits) as credits,
      SUM(duration_ms) as duration,
      SUM(skill_count) as skills,
      SUM(agent_count) as agents,
      SUM(mcp_count) as mcps
    FROM traces WHERE session_id = ?
  `).get(sessionId);
    const tokens = {
        input: stats.input || 0,
        output: stats.output || 0,
        cached: stats.cached || 0,
        reasoning: stats.reasoning || 0,
        written: stats.written || 0,
        total: stats.total || 0,
    };
    return {
        sessionId,
        startedAt: session.started_at,
        totalEntries: stats.entries || 0,
        totalTokens: tokens,
        totalCredits: stats.credits || 0,
        totalDurationMs: stats.duration || 0,
        totalSkillCalls: stats.skills || 0,
        totalAgentCalls: stats.agents || 0,
        totalMcpCalls: stats.mcps || 0,
    };
}
function rowToEntry(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        dateTime: row.date_time,
        prompt: row.prompt,
        response: row.response,
        reasoning: row.reasoning,
        tokens: {
            input: row.tokens_input || 0,
            output: row.tokens_output || 0,
            cached: row.tokens_cached || 0,
            reasoning: row.tokens_reasoning || 0,
            written: row.tokens_written || 0,
            total: row.tokens_total || 0,
        },
        aiCredits: row.ai_credits || 0,
        durationMs: row.duration_ms || 0,
        toolCalls: JSON.parse(row.tool_calls || '[]'),
        skillCount: row.skill_count || 0,
        agentCount: row.agent_count || 0,
        mcpCount: row.mcp_count || 0,
        status: row.status,
        error: row.error,
    };
}
export function deleteTrace(id) {
    db.prepare('DELETE FROM traces WHERE id = ?').run(id);
}
export function getAllSessions() {
    const rows = db.prepare(`
    SELECT
      s.id AS sessionId,
      s.started_at AS startedAt,
      COUNT(t.id) AS totalEntries,
      SUM(t.tokens_input) AS input,
      SUM(t.tokens_output) AS output,
      SUM(t.tokens_cached) AS cached,
      SUM(t.tokens_reasoning) AS reasoning,
      SUM(t.tokens_written) AS written,
      SUM(t.tokens_total) AS total,
      SUM(t.ai_credits) AS totalCredits,
      SUM(t.duration_ms) AS totalDurationMs,
      SUM(t.skill_count) AS totalSkillCalls,
      SUM(t.agent_count) AS totalAgentCalls,
      SUM(t.mcp_count) AS totalMcpCalls
    FROM sessions s
    LEFT JOIN traces t ON t.session_id = s.id
    GROUP BY s.id
    ORDER BY s.started_at DESC
  `).all();
    return rows.map(r => ({
        sessionId: r.sessionId,
        startedAt: r.startedAt,
        totalEntries: r.totalEntries || 0,
        totalTokens: {
            input: r.input || 0,
            output: r.output || 0,
            cached: r.cached || 0,
            reasoning: r.reasoning || 0,
            written: r.written || 0,
            total: r.total || 0,
        },
        totalCredits: r.totalCredits || 0,
        totalDurationMs: r.totalDurationMs || 0,
        totalSkillCalls: r.totalSkillCalls || 0,
        totalAgentCalls: r.totalAgentCalls || 0,
        totalMcpCalls: r.totalMcpCalls || 0,
    }));
}
export function getMetrics() {
    const totals = db.prepare(`
    SELECT
      COUNT(*) AS totalTraces,
      SUM(ai_credits) AS totalCredits,
      SUM(tokens_total) AS totalTokens,
      AVG(duration_ms) AS avgDurationMs,
      AVG(ai_credits) AS avgCredits
    FROM traces
  `).get();
    const recent = db.prepare(`
    SELECT date_time, ai_credits, tokens_input, tokens_output, tokens_cached,
           duration_ms, tool_calls, status
    FROM traces
    ORDER BY date_time DESC
    LIMIT 50
  `).all();
    const toolTypeCounts = {};
    const points = [];
    for (const r of recent) {
        let toolCount = 0;
        try {
            const calls = JSON.parse(r.tool_calls || '[]');
            toolCount = calls.length;
            for (const c of calls) {
                toolTypeCounts[c.type] = (toolTypeCounts[c.type] || 0) + 1;
            }
        }
        catch { /* ignore */ }
        points.push({
            dateTime: r.date_time,
            credits: r.ai_credits || 0,
            tokensInput: r.tokens_input || 0,
            tokensOutput: r.tokens_output || 0,
            tokensCached: r.tokens_cached || 0,
            durationMs: r.duration_ms || 0,
            toolCount,
            status: r.status,
        });
    }
    return {
        totalTraces: totals.totalTraces || 0,
        totalCredits: totals.totalCredits || 0,
        totalTokens: totals.totalTokens || 0,
        avgDurationMs: totals.avgDurationMs || 0,
        avgCredits: totals.avgCredits || 0,
        toolTypeCounts,
        recentPoints: points.reverse(), // oldest first for charts
    };
}
