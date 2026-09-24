import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
// Overridable so a verification run can point at a throwaway database instead of
// polluting the user's real trace history.
const DB_DIR = process.env.COPILOT_TRACER_HOME ?? path.join(os.homedir(), '.copilot-tracer');
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
// Work items group traces by the piece of work they belong to. Kept in a
// separate exec block so the original schema above stays easy to diff.
db.exec(`
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    summary TEXT,
    kind TEXT NOT NULL DEFAULT 'unknown',
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'detected',
    summary_source TEXT NOT NULL DEFAULT 'generated',
    confidence REAL NOT NULL DEFAULT 0,
    extractor_version TEXT,
    acceptance_criteria TEXT,
    draft_generator_version TEXT,
    criteria_source TEXT,
    git_evidence TEXT,
    evidence_checked_at TEXT,
    completion_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS work_item_traces (
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    trace_id TEXT NOT NULL REFERENCES traces(id),
    linked_at TEXT NOT NULL,
    link_source TEXT NOT NULL DEFAULT 'detected',
    confidence REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (work_item_id, trace_id)
  );

  CREATE TABLE IF NOT EXISTS work_item_references (
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    reference_type TEXT NOT NULL,
    reference_key TEXT NOT NULL,
    url TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (work_item_id, reference_type, reference_key)
  );

  CREATE TABLE IF NOT EXISTS work_item_dismissed_traces (
    trace_id TEXT PRIMARY KEY REFERENCES traces(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    reason TEXT NOT NULL DEFAULT 'ignored',
    dismissed_at TEXT NOT NULL
  );

  -- Medium-confidence links the engineer has not accepted yet. A suggestion is
  -- never a link: it only becomes one when accepted, which is what makes the
  -- design's "suggested links accepted" measure countable.
  CREATE TABLE IF NOT EXISTS work_item_suggestions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    trace_id TEXT NOT NULL REFERENCES traces(id),
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    detail TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    ambiguous INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    decided_at TEXT,
    UNIQUE (trace_id, work_item_id)
  );

  -- Status transitions, so cycle time is measured from recorded events rather
  -- than inferred from updated_at, which any edit overwrites.
  CREATE TABLE IF NOT EXISTS work_item_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );

  -- Merge, split and unlink events, so the design's correction rate is a count
  -- of what actually happened rather than a guess from current state.
  CREATE TABLE IF NOT EXISTS work_item_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id);
  CREATE INDEX IF NOT EXISTS idx_work_item_traces_trace ON work_item_traces(trace_id);
  CREATE INDEX IF NOT EXISTS idx_work_item_refs_lookup ON work_item_references(reference_type, reference_key);
  CREATE INDEX IF NOT EXISTS idx_work_item_dismissed_project ON work_item_dismissed_traces(project_id);
  CREATE INDEX IF NOT EXISTS idx_work_item_suggestions_project ON work_item_suggestions(project_id, state);
  CREATE INDEX IF NOT EXISTS idx_work_item_suggestions_trace ON work_item_suggestions(trace_id);
  CREATE INDEX IF NOT EXISTS idx_work_item_status_history_item ON work_item_status_history(work_item_id, changed_at);
  CREATE INDEX IF NOT EXISTS idx_work_item_corrections_project ON work_item_corrections(project_id);
`);
// Migrate existing DBs
try {
    db.prepare('ALTER TABLE projects ADD COLUMN repo_url TEXT').run();
}
catch { }
try {
    db.prepare('ALTER TABLE work_items ADD COLUMN acceptance_criteria TEXT').run();
}
catch { }
try {
    db.prepare('ALTER TABLE work_items ADD COLUMN draft_generator_version TEXT').run();
}
catch { }
try {
    db.prepare('ALTER TABLE work_items ADD COLUMN criteria_source TEXT').run();
}
catch { }
try {
    db.prepare('ALTER TABLE work_items ADD COLUMN git_evidence TEXT').run();
}
catch { }
try {
    db.prepare('ALTER TABLE work_items ADD COLUMN evidence_checked_at TEXT').run();
}
catch { }
try {
    db.prepare('ALTER TABLE work_items ADD COLUMN completion_note TEXT').run();
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
// The status vocabulary gained detected/paused/blocked and renamed done to
// completed, so existing rows carry the old spelling forward.
try {
    db.prepare("UPDATE work_items SET status = 'completed' WHERE status = 'done'").run();
}
catch { }
// Which prompt first produced a reference, and how a trace relates to its item.
try {
    db.prepare('ALTER TABLE work_item_references ADD COLUMN source_trace_id TEXT REFERENCES traces(id)').run();
}
catch { }
try {
    db.prepare("ALTER TABLE work_item_traces ADD COLUMN relationship TEXT NOT NULL DEFAULT 'work'").run();
}
catch { }
// Items that predate the history table get one synthetic row, so cycle-time
// queries do not silently skip them.
try {
    db.prepare(`
    INSERT INTO work_item_status_history (work_item_id, from_status, to_status, changed_at)
    SELECT id, NULL, status, created_at FROM work_items
    WHERE id NOT IN (SELECT work_item_id FROM work_item_status_history)
  `).run();
}
catch { }
// Exposed so companion modules (work items) can query without opening a second
// connection to the same file.
export { db };
export function getSessionProjectId(sessionId) {
    const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId);
    return row?.project_id ?? null;
}
let tracePersistedListener = null;
export function setTracePersistedListener(listener) {
    tracePersistedListener = listener;
}
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
export function projectExists(projectId) {
    return !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
}
export function createSession(id, projectId) {
    // Backfill-safe upsert: insert if missing, set project_id only when a project is
    // provided AND the session currently has none (never null out an existing link).
    db.prepare(`
    INSERT INTO sessions (id, started_at, project_id) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = CASE
        WHEN excluded.project_id IS NOT NULL THEN COALESCE(sessions.project_id, excluded.project_id)
        ELSE sessions.project_id
      END
  `).run(id, new Date().toISOString(), projectId ?? null);
}
const EMPTY_WORK_ITEM_SUMMARY = {
    total: 0,
    active: 0,
    detected: 0,
    completed: 0,
    ticketReferences: 0,
    unlinkedPrompts: 0,
    recent: [],
};
/**
 * Work-item rollups for a page of project cards. Kept here rather than in
 * workItemService so the dashboard query does not import the whole service.
 *
 * Batched over the whole page: four queries total, not four per card. The
 * per-project version re-prepared its statements on every card, so a dashboard
 * of twelve projects paid for forty-eight prepares it did not need.
 */
function getProjectWorkItemSummaries(projectIds) {
    const summaries = new Map();
    if (!projectIds.length)
        return summaries;
    for (const id of projectIds) {
        summaries.set(id, { ...EMPTY_WORK_ITEM_SUMMARY, recent: [] });
    }
    const placeholders = projectIds.map(() => '?').join(', ');
    const counts = db.prepare(`
    SELECT
      project_id,
      COUNT(*) as total,
      COALESCE(SUM(status = 'active'), 0) as active,
      COALESCE(SUM(status = 'detected'), 0) as detected,
      COALESCE(SUM(status = 'completed'), 0) as completed
    FROM work_items
    WHERE project_id IN (${placeholders})
    GROUP BY project_id
  `).all(...projectIds);
    for (const row of counts) {
        const summary = summaries.get(row.project_id);
        if (!summary)
            continue;
        summary.total = row.total;
        summary.active = row.active;
        summary.detected = row.detected;
        summary.completed = row.completed;
    }
    const references = db.prepare(`
    SELECT wi.project_id, COUNT(DISTINCT r.reference_type || '|' || r.reference_key) as count
    FROM work_item_references r
    JOIN work_items wi ON wi.id = r.work_item_id
    WHERE wi.project_id IN (${placeholders})
    GROUP BY wi.project_id
  `).all(...projectIds);
    for (const row of references) {
        const summary = summaries.get(row.project_id);
        if (summary)
            summary.ticketReferences = row.count;
    }
    const unlinked = db.prepare(`
    SELECT s.project_id, COUNT(*) as count
    FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM work_item_traces wit WHERE wit.trace_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM work_item_dismissed_traces d WHERE d.trace_id = t.id)
    GROUP BY s.project_id
  `).all(...projectIds);
    for (const row of unlinked) {
        const summary = summaries.get(row.project_id);
        if (summary)
            summary.unlinkedPrompts = row.count;
    }
    // The window function does the per-project "top 3" that a LIMIT cannot do
    // across groups.
    const recent = db.prepare(`
    SELECT project_id, id, title, status, updated_at FROM (
      SELECT
        project_id, id, title, status, updated_at,
        ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC, id ASC) as rank
      FROM work_items
      WHERE project_id IN (${placeholders}) AND status NOT IN ('archived')
    ) WHERE rank <= 3
    ORDER BY project_id ASC, rank ASC
  `).all(...projectIds);
    for (const row of recent) {
        const summary = summaries.get(row.project_id);
        if (!summary)
            continue;
        summary.recent.push({
            id: row.id,
            title: row.title,
            status: row.status,
            updatedAt: row.updated_at,
        });
    }
    return summaries;
}
export function getDashboard(page = 1, pageSize = 12, query = '') {
    const filter = query.trim();
    const filterClause = filter
        ? 'WHERE LOWER(p.path) LIKE ? OR LOWER(COALESCE(p.local_path, \'\')) LIKE ? OR LOWER(COALESCE(p.repo_url, \'\')) LIKE ?'
        : '';
    const filterParams = filter ? [`%${filter.toLowerCase()}%`, `%${filter.toLowerCase()}%`, `%${filter.toLowerCase()}%`] : [];
    const projectCount = db.prepare(`SELECT COUNT(*) as count FROM projects p ${filterClause}`).get(...filterParams);
    const totalProjects = projectCount.count;
    const totalPages = Math.max(1, Math.ceil(totalProjects / pageSize));
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * pageSize;
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
    ${filterClause}
    GROUP BY p.id
    ORDER BY last_active_at DESC, p.id ASC
    LIMIT ? OFFSET ?
  `).all(...filterParams, pageSize, offset);
    const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects) as projects,
      (SELECT COUNT(*) FROM sessions) as sessions,
      COALESCE((SELECT SUM(tokens_total) FROM traces), 0) as tokens,
      COALESCE((SELECT SUM(ai_credits) FROM traces), 0) as credits
  `).get();
    const workItemSummaries = getProjectWorkItemSummaries(projects.map((p) => p.id));
    const lastSessionStmt = db.prepare(`
    SELECT s.id,
      COALESCE((SELECT SUM(tokens_total) FROM traces WHERE session_id = s.id), 0) as tokens,
      COALESCE((SELECT SUM(ai_credits) FROM traces WHERE session_id = s.id), 0) as credits
    FROM sessions s
    WHERE s.project_id = ?
    ORDER BY s.started_at DESC
    LIMIT 1
  `);
    const enriched = projects.map(p => {
        const lastSession = lastSessionStmt.get(p.id);
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
            workItems: workItemSummaries.get(p.id) ?? { ...EMPTY_WORK_ITEM_SUMMARY, recent: [] },
        };
    });
    const workItemTotals = db.prepare(`
    SELECT
      COALESCE(SUM(status NOT IN ('completed', 'archived')), 0) as open,
      COALESCE(SUM(status = 'active'), 0) as active,
      COALESCE(SUM(status = 'detected'), 0) as detected,
      COALESCE(SUM(status = 'completed'), 0) as completed
    FROM work_items
  `).get();
    const unlinkedTotal = db.prepare(`
    SELECT COUNT(*) as count
    FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM work_item_traces wit WHERE wit.trace_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM work_item_dismissed_traces d WHERE d.trace_id = t.id)
  `).get();
    return {
        projects: enriched,
        totals: {
            projects: totals.projects,
            sessions: totals.sessions,
            tokens: totals.tokens,
            credits: totals.credits,
        },
        workItemTotals: {
            open: workItemTotals.open,
            active: workItemTotals.active,
            detected: workItemTotals.detected,
            completed: workItemTotals.completed,
            unlinkedPrompts: unlinkedTotal.count,
        },
        pagination: {
            page: currentPage,
            pageSize,
            totalPages,
            totalProjects,
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
    // Derived data must never break or slow ingestion, so failures are swallowed.
    if (tracePersistedListener) {
        try {
            tracePersistedListener(entry);
        }
        catch (error) {
            console.error('[work-items] trace listener failed:', error?.message ?? error);
        }
    }
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
