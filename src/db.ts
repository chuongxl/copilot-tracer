import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { TraceEntry, SessionSummary, TokenUsage, DashboardData } from './types.js';

const DB_DIR = path.join(os.homedir(), '.copilot-tracer');
const DB_PATH = path.join(DB_DIR, 'traces.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

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
try { db.prepare('ALTER TABLE projects ADD COLUMN repo_url TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE projects ADD COLUMN local_path TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)').run(); } catch {}

export function ensureProject(projectPath: string, repoUrl?: string): string {
  const id = 'project:' + projectPath;
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO projects (id, path, repo_url, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectPath, repoUrl ?? null, projectPath, now, now);
  if (repoUrl) {
    db.prepare('UPDATE projects SET repo_url = ?, updated_at = ? WHERE id = ?').run(repoUrl, now, id);
  }
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, id);
  return id;
}

export function ensureProjectByRepo(repoUrl: string): string {
  // Try to find existing project by repo URL
  const existing = db.prepare('SELECT id FROM projects WHERE repo_url = ?').get(repoUrl) as { id: string } | undefined;
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

export function updateProjectLocalPath(projectId: string, localPath: string): void {
  db.prepare('UPDATE projects SET local_path = ?, updated_at = ? WHERE id = ?').run(localPath, new Date().toISOString(), projectId);
}

export function findProjectByRepo(repoUrl: string): { id: string; path: string; local_path: string | null } | null {
  const row = db.prepare('SELECT id, path, local_path FROM projects WHERE repo_url = ?').get(repoUrl) as Record<string, unknown> | undefined;
  return row ? { id: row.id as string, path: row.path as string, local_path: row.local_path as string | null } : null;
}

export function createSession(id: string, projectId?: string): void {
  db.prepare('INSERT OR REPLACE INTO sessions (id, started_at, project_id) VALUES (?, ?, ?)').run(id, new Date().toISOString(), projectId ?? null);
}

export function getDashboard(): DashboardData {
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
  `).all() as Record<string, unknown>[];

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects) as projects,
      (SELECT COUNT(*) FROM sessions) as sessions,
      COALESCE((SELECT SUM(tokens_total) FROM traces), 0) as tokens,
      COALESCE((SELECT SUM(ai_credits) FROM traces), 0) as credits
  `).get() as Record<string, number>;

  const enriched = projects.map(p => {
    const lastSession = db.prepare(`
      SELECT s.id,
        COALESCE((SELECT SUM(tokens_total) FROM traces WHERE session_id = s.id), 0) as tokens,
        COALESCE((SELECT SUM(ai_credits) FROM traces WHERE session_id = s.id), 0) as credits
      FROM sessions s
      WHERE s.project_id = ?
      ORDER BY s.started_at DESC
      LIMIT 1
    `).get(p.id) as { id: string; tokens: number; credits: number } | undefined;

    return {
      id: p.id as string,
      path: p.path as string,
      repoUrl: p.repo_url as string | null,
      localPath: p.local_path as string | null,
      sessionCount: (p.session_count as number) || 0,
      totalTokens: (p.total_tokens as number) || 0,
      totalCredits: (p.total_credits as number) || 0,
      lastActiveAt: p.last_active_at as string | null,
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

export function upsertTrace(entry: TraceEntry): void {
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

export function getTraces(sessionId?: string, limit = 100): TraceEntry[] {
  const rows = sessionId
    ? db.prepare('SELECT * FROM traces WHERE session_id = ? ORDER BY date_time DESC LIMIT ?').all(sessionId, limit)
    : db.prepare('SELECT * FROM traces ORDER BY date_time DESC LIMIT ?').all(limit);
  return (rows as Record<string, unknown>[]).map((r) => rowToEntry(r));
}

export function getTrace(id: string): TraceEntry | null {
  const row = db.prepare('SELECT * FROM traces WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToEntry(row) : null;
}

export function getSessionSummary(sessionId: string): SessionSummary | null {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!session) return null;

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
  `).get(sessionId) as Record<string, number>;

  const tokens: TokenUsage = {
    input: stats.input || 0,
    output: stats.output || 0,
    cached: stats.cached || 0,
    reasoning: stats.reasoning || 0,
    written: stats.written || 0,
    total: stats.total || 0,
  };

  return {
    sessionId,
    startedAt: session.started_at as string,
    totalEntries: stats.entries || 0,
    totalTokens: tokens,
    totalCredits: stats.credits || 0,
    totalDurationMs: stats.duration || 0,
    totalSkillCalls: stats.skills || 0,
    totalAgentCalls: stats.agents || 0,
    totalMcpCalls: stats.mcps || 0,
  };
}

function rowToEntry(row: Record<string, unknown>): TraceEntry {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    dateTime: row.date_time as string,
    prompt: row.prompt as string,
    response: row.response as string | undefined,
    reasoning: row.reasoning as string | undefined,
    tokens: {
      input: (row.tokens_input as number) || 0,
      output: (row.tokens_output as number) || 0,
      cached: (row.tokens_cached as number) || 0,
      reasoning: (row.tokens_reasoning as number) || 0,
      written: (row.tokens_written as number) || 0,
      total: (row.tokens_total as number) || 0,
    },
    aiCredits: (row.ai_credits as number) || 0,
    durationMs: (row.duration_ms as number) || 0,
    toolCalls: JSON.parse((row.tool_calls as string) || '[]'),
    skillCount: (row.skill_count as number) || 0,
    agentCount: (row.agent_count as number) || 0,
    mcpCount: (row.mcp_count as number) || 0,
    status: row.status as TraceEntry['status'],
    error: row.error as string | undefined,
  };
}

export function deleteTrace(id: string): void {
  db.prepare('DELETE FROM traces WHERE id = ?').run(id);
}

export function getProjectTraces(projectId: string, limit = 200): TraceEntry[] {
  const rows = db.prepare(`
    SELECT t.* FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id = ?
    ORDER BY t.date_time DESC
    LIMIT ?
  `).all(projectId, limit) as Record<string, unknown>[];
  return rows.map((r) => rowToEntry(r));
}

export function getProjectSessionSummary(projectId: string): SessionSummary | null {
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
  `).get(projectId) as Record<string, number>;

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
