import type { TicketReferenceType, WorkItemKind } from './workItemExtraction.js';

export type { TicketReferenceType, WorkItemKind };

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

export interface Project {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardProject {
  id: string;
  path: string;
  repoUrl: string | null;
  localPath: string | null;
  sessionCount: number;
  totalTokens: number;
  totalCredits: number;
  lastActiveAt: string | null;
  lastSession: { id: string; tokens: number; credits: number } | null;
}

export interface DashboardData {
  projects: DashboardProject[];
  totals: { projects: number; sessions: number; tokens: number; credits: number };
  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
    totalProjects: number;
  };
}

// ── Work items ────────────────────────────────────────────────────────────────

export type WorkItemStatus = 'active' | 'done' | 'archived';
export type WorkItemSource = 'detected' | 'manual';
export type WorkItemSummarySource = 'generated' | 'user';
export type WorkItemLinkSource = 'detected' | 'manual';

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['active', 'done', 'archived'];

export interface WorkItemReference {
  type: TicketReferenceType;
  key: string;
  url: string | null;
}

export interface WorkItemTraceSummary {
  id: string;
  sessionId: string;
  dateTime: string;
  prompt: string;
  tokens: number;
  credits: number;
  durationMs: number;
  status: TraceEntry['status'];
  linkSource: WorkItemLinkSource;
}

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  summary: string | null;
  kind: WorkItemKind;
  status: WorkItemStatus;
  source: WorkItemSource;
  summarySource: WorkItemSummarySource;
  acceptanceCriteria: string[];
  criteriaSource: WorkItemSummarySource;
  draftGeneratorVersion: string | null;
  confidence: number;
  extractorVersion: string | null;
  createdAt: string;
  updatedAt: string;
  references: WorkItemReference[];
  ticketKey: string | null;
  traceCount: number;
  totalTokens: number;
  totalCredits: number;
  lastActiveAt: string | null;
}

export interface WorkItemDetail extends WorkItem {
  traces: WorkItemTraceSummary[];
}

export interface CreateWorkItemInput {
  projectId: string;
  title: string;
  summary?: string | null;
  kind?: WorkItemKind;
  status?: WorkItemStatus;
  source?: WorkItemSource;
  summarySource?: WorkItemSummarySource;
  confidence?: number;
  extractorVersion?: string | null;
  references?: WorkItemReference[];
}

export interface UpdateWorkItemInput {
  title?: string;
  summary?: string | null;
  kind?: WorkItemKind;
  status?: WorkItemStatus;
  acceptanceCriteria?: string[];
}

export interface WorkItemTraceLinkInput {
  workItemId: string;
  traceId: string;
  linkSource?: WorkItemLinkSource;
  confidence?: number;
}

export interface WorkItemEvidenceResult {
  status: 'linked' | 'uncategorized';
  workItemIds: string[];
}
