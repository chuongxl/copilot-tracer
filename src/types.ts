export interface ToolCall {
  id: string;
  name: string;
  type: 'mcp' | 'skill' | 'agent' | 'builtin';
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  children?: ToolCall[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  written: number;
  total: number;
}

export interface TraceEntry {
  id: string;
  sessionId: string;
  dateTime: string;
  prompt: string;
  response?: string;
  reasoning?: string;
  tokens: TokenUsage;
  aiCredits: number;
  durationMs: number;
  toolCalls: ToolCall[];
  skillCount: number;
  agentCount: number;
  mcpCount: number;
  status: 'running' | 'done' | 'error';
  error?: string;
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  totalEntries: number;
  totalTokens: TokenUsage;
  totalCredits: number;
  totalDurationMs: number;
  totalSkillCalls: number;
  totalAgentCalls: number;
  totalMcpCalls: number;
}
