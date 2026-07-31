import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';

const DB_DIR = path.join(os.homedir(), '.copilot-tracer');
const DB_PATH = path.join(DB_DIR, 'traces.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

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

const sessionId = 'test-session-001';
db.prepare('INSERT OR REPLACE INTO sessions (id, started_at) VALUES (?, ?)').run(sessionId, new Date().toISOString());

const traces = [
  {
    id: randomUUID(),
    prompt: 'Scan all AI/ML news and trending GitHub repos for today',
    response: 'Here is your daily digest...',
    reasoning: 'I need to search multiple sources: HackerNews, Reddit r/MachineLearning, GitHub Trending. Let me start with GitHub trending to get the most viral repos, then cross-reference with HN for AI news context.',
    tokens_input: 4200, tokens_output: 1800, tokens_cached: 1200, tokens_reasoning: 620, tokens_written: 1800, tokens_total: 6000,
    ai_credits: 2.34, duration_ms: 8400, skill_count: 2, agent_count: 0, mcp_count: 3, status: 'done',
    tool_calls: JSON.stringify([
      { id: '1', name: 'web_search', type: 'mcp', input: { query: 'github trending AI today' }, output: { results: ['vllm', 'crawl4ai'] }, startedAt: Date.now()-8000, endedAt: Date.now()-7200, durationMs: 800 },
      { id: '2', name: 'web_search', type: 'mcp', input: { query: 'AI ML news HackerNews' }, output: { results: ['Claude Opus 5', 'DeepSeek R2'] }, startedAt: Date.now()-7000, endedAt: Date.now()-6100, durationMs: 900 },
      { id: '3', name: 'ai-ml-news-digest', type: 'skill', input: { sources: ['github', 'hn', 'reddit'] }, output: { sections: 6 }, startedAt: Date.now()-6000, endedAt: Date.now()-4000, durationMs: 2000 },
      { id: '4', name: 'web_extract', type: 'mcp', input: { url: 'https://github.com/trending' }, output: { repos: 25 }, startedAt: Date.now()-3800, endedAt: Date.now()-3000, durationMs: 800 },
      { id: '5', name: 'format_output', type: 'skill', input: { format: 'whatsapp' }, output: { length: 1240 }, startedAt: Date.now()-2800, endedAt: Date.now()-2000, durationMs: 800 },
    ])
  },
  {
    id: randomUUID(),
    prompt: 'Check my Blueprint punch-in status for today',
    response: 'Your punch-in time for today Jul 22 is 08:23.',
    reasoning: 'User wants to verify today punch-in. I should navigate to Blueprint timesheet and check the In column for today date.',
    tokens_input: 1800, tokens_output: 420, tokens_cached: 900, tokens_reasoning: 210, tokens_written: 420, tokens_total: 2220,
    ai_credits: 0.71, duration_ms: 3200, skill_count: 0, agent_count: 0, mcp_count: 2, status: 'done',
    tool_calls: JSON.stringify([
      { id: '6', name: 'browser_navigate', type: 'mcp', input: { url: 'https://blueprint.cyberlogitec.com.vn' }, output: { title: 'Blueprint' }, startedAt: Date.now()-3000, endedAt: Date.now()-2200, durationMs: 800 },
      { id: '7', name: 'browser_snapshot', type: 'mcp', input: {}, output: { gridCells: 22 }, startedAt: Date.now()-2100, endedAt: Date.now()-1600, durationMs: 500 },
    ])
  },
  {
    id: randomUUID(),
    prompt: 'Init opencode agents for my new project',
    response: 'Initialized OpenCode agents and Speckit for your project.',
    reasoning: 'I need to: 1) check if speckit is installed, 2) run specify init --ai opencode, 3) verify .opencode/ and .specify/ dirs are created. Let me start by checking the environment.',
    tokens_input: 5600, tokens_output: 2100, tokens_cached: 2800, tokens_reasoning: 980, tokens_written: 2100, tokens_total: 7700,
    ai_credits: 3.98, duration_ms: 14200, skill_count: 1, agent_count: 2, mcp_count: 4, status: 'done',
    tool_calls: JSON.stringify([
      { id: '8', name: 'terminal', type: 'mcp', input: { command: 'which specify' }, output: { output: '/usr/local/bin/specify' }, startedAt: Date.now()-14000, endedAt: Date.now()-13500, durationMs: 500 },
      { id: '9', name: 'init-agent-master', type: 'skill', input: { path: '/Users/chuongnd/myproject' }, output: { status: 'ok' }, startedAt: Date.now()-13000, endedAt: Date.now()-9000, durationMs: 4000,
        children: [
          { id: '9a', name: 'terminal', type: 'mcp', input: { command: 'specify init --ai opencode .' }, output: { output: 'Initialized' }, startedAt: Date.now()-12800, endedAt: Date.now()-11000, durationMs: 1800 },
          { id: '9b', name: 'terminal', type: 'mcp', input: { command: 'ls .opencode .specify' }, output: { output: 'agents.md  AGENTS.md' }, startedAt: Date.now()-10800, endedAt: Date.now()-10200, durationMs: 600 },
        ]
      },
      { id: '10', name: 'delegate_task', type: 'agent', input: { goal: 'verify speckit config' }, output: { status: 'verified' }, startedAt: Date.now()-8800, endedAt: Date.now()-6000, durationMs: 2800 },
      { id: '11', name: 'delegate_task', type: 'agent', input: { goal: 'generate architecture.md' }, output: { file: 'architecture.md' }, startedAt: Date.now()-5800, endedAt: Date.now()-3000, durationMs: 2800 },
    ])
  },
  {
    id: randomUUID(),
    prompt: 'running DDD audit for SRM project',
    response: null,
    reasoning: 'Starting DDD audit. Loading event storming PDFs from TestData/SRM folder...',
    tokens_input: 3100, tokens_output: 0, tokens_cached: 0, tokens_reasoning: 340, tokens_written: 0, tokens_total: 3100,
    ai_credits: 0.93, duration_ms: 5100, skill_count: 1, agent_count: 1, mcp_count: 2, status: 'running',
    tool_calls: JSON.stringify([
      { id: '12', name: 'read_file', type: 'mcp', input: { path: 'TestData/SRM' }, output: { files: 4 }, startedAt: Date.now()-5000, endedAt: Date.now()-4200, durationMs: 800 },
      { id: '13', name: 'ddd-artifact-analysis', type: 'skill', input: { path: 'TestData/SRM' }, startedAt: Date.now()-4000, durationMs: null },
    ])
  },
];

for (const t of traces) {
  db.prepare(`INSERT OR REPLACE INTO traces (
    id, session_id, date_time, prompt, response, reasoning,
    tokens_input, tokens_output, tokens_cached, tokens_reasoning, tokens_written, tokens_total,
    ai_credits, duration_ms, tool_calls, skill_count, agent_count, mcp_count, status
  ) VALUES (
    @id, @sessionId, @dateTime, @prompt, @response, @reasoning,
    @tokens_input, @tokens_output, @tokens_cached, @tokens_reasoning, @tokens_written, @tokens_total,
    @ai_credits, @duration_ms, @tool_calls, @skill_count, @agent_count, @mcp_count, @status
  )`).run({
    ...t,
    sessionId,
    dateTime: new Date(Date.now() - Math.random() * 3600000).toISOString(),
    response: t.response ?? null,
  });
}

console.log('Seeded', traces.length, 'test traces into', DB_PATH);
