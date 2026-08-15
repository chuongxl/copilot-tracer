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
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    repo_url TEXT,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    project_id TEXT REFERENCES projects(id)
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
// Migrate existing DBs
try {
    db.prepare('ALTER TABLE projects ADD COLUMN repo_url TEXT').run();
}
catch { }
try {
    db.prepare('ALTER TABLE projects ADD COLUMN local_path TEXT').run();
}
catch { }
try {
    db.prepare('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)').run();
}
catch { }
export function ensureProject(projectPath, repoUrl) {
    const id = 'project:' + projectPath;
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO projects (id, path, repo_url, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectPath, repoUrl ?? null, projectPath, now, now);
    if (repoUrl) {
        db.prepare('UPDATE projects SET repo_url = ?, updated_at = ? WHERE id = ?').run(repoUrl, now, id);
    }
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, id);
    return id;
}
export function ensureProjectByRepo(repoUrl) {
    // Try to find existing project by repo URL
    const existing = db.prepare('SELECT id FROM projects WHERE repo_url = ?').get(repoUrl);
    if (existing) {
        db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), existing.id);
        return existing.id;
    }
    // Create new project with repo URL as path (local_path set later)
    const id = 'project:' + repoUrl;
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO projects (id, path, repo_url, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, repoUrl, repoUrl, null, now, now);
    return id;
}
export function updateProjectLocalPath(projectId, localPath) {
    db.prepare('UPDATE projects SET local_path = ?, updated_at = ? WHERE id = ?').run(localPath, new Date().toISOString(), projectId);
}
export function findProjectByRepo(repoUrl) {
    const row = db.prepare('SELECT id, path, local_path FROM projects WHERE repo_url = ?').get(repoUrl);
    return row ? { id: row.id, path: row.path, local_path: row.local_path } : null;
}
export function createSession(id, projectId) {
    db.prepare('INSERT OR REPLACE INTO sessions (id, started_at, project_id) VALUES (?, ?, ?)').run(id, new Date().toISOString(), projectId ?? null);
}
export function getDashboard() {
    const projects = db.prepare(`
    SELECT
      p.id, p.path, p.repo_url, p.local_path,
      COUNT(DISTINCT s.id) as session_count,
      COALESCE(SUM(t.tokens_total), 0) as total_tokens,
      COALESCE(SUM(t.ai_credits), 0) as total_credits,
      MAX(s.started_at) as last_active_at
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id
    LEFT JOIN traces t ON t.session_id = s.id
    GROUP BY p.id
    ORDER BY last_active_at DESC
  `).all();
    const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects) as projects,
      (SELECT COUNT(*) FROM sessions) as sessions,
      COALESCE((SELECT SUM(tokens_total) FROM traces), 0) as tokens,
      COALESCE((SELECT SUM(ai_credits) FROM traces), 0) as credits
  `).get();
    const enriched = projects.map(p => {
        const lastSession = db.prepare(`
      SELECT s.id,
        COALESCE((SELECT SUM(tokens_total) FROM traces WHERE session_id = s.id), 0) as tokens,
        COALESCE((SELECT SUM(ai_credits) FROM traces WHERE session_id = s.id), 0) as credits
      FROM sessions s
      WHERE s.project_id = ?
      ORDER BY s.started_at DESC
      LIMIT 1
    `).get(p.id);
        return {
            id: p.id,
            path: p.path,
            repoUrl: p.repo_url,
            localPath: p.local_path,
            sessionCount: p.session_count || 0,
            totalTokens: p.total_tokens || 0,
            totalCredits: p.total_credits || 0,
            lastActiveAt: p.last_active_at,
            lastSession: lastSession ?? null,
        };
    });
    return {
        projects: enriched,
        totals: {
            projects: totals.projects,
            sessions: totals.sessions,
            tokens: totals.tokens,
            credits: totals.credits,
        },
    };
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
export function getProjectTraces(projectId, limit = 200) {
    const rows = db.prepare(`
    SELECT t.* FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id = ?
    ORDER BY t.date_time DESC
    LIMIT ?
  `).all(projectId, limit);
    return rows.map((r) => rowToEntry(r));
}
export function getProjectSessionSummary(projectId) {
    const stats = db.prepare(`
    SELECT
      COUNT(*) as entries,
      SUM(t.tokens_input) as input,
      SUM(t.tokens_output) as output,
      SUM(t.tokens_cached) as cached,
      SUM(t.tokens_reasoning) as reasoning,
      SUM(t.tokens_written) as written,
      SUM(t.tokens_total) as total,
      SUM(t.ai_credits) as credits,
      SUM(t.duration_ms) as duration,
      SUM(t.skill_count) as skills,
      SUM(t.agent_count) as agents,
      SUM(t.mcp_count) as mcps
    FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id = ?
  `).get(projectId);
    return {
        sessionId: projectId,
        startedAt: '',
        totalEntries: stats.entries || 0,
        totalTokens: {
            input: stats.input || 0,
            output: stats.output || 0,
            cached: stats.cached || 0,
            reasoning: stats.reasoning || 0,
            written: stats.written || 0,
            total: stats.total || 0,
        },
        totalCredits: stats.credits || 0,
        totalDurationMs: stats.duration || 0,
        totalSkillCalls: stats.skills || 0,
        totalAgentCalls: stats.agents || 0,
        totalMcpCalls: stats.mcps || 0,
    };
}
