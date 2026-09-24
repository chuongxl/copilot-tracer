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
  workItems: DashboardWorkItemSummary;
}

/** Work-item rollup shown on a project card. */
export interface DashboardWorkItemSummary {
  active: number;
  detected: number;
  completed: number;
  total: number;
  ticketReferences: number;
  unlinkedPrompts: number;
  recent: Array<{ id: string; title: string; status: WorkItemStatus; updatedAt: string }>;
}

export interface DashboardData {
  projects: DashboardProject[];
  totals: { projects: number; sessions: number; tokens: number; credits: number };
  workItemTotals: {
    /** Everything not completed or archived. Detected items count as open. */
    open: number;
    active: number;
    detected: number;
    completed: number;
    unlinkedPrompts: number;
  };
  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
    totalProjects: number;
  };
}

// ── Work items ────────────────────────────────────────────────────────────────

export type WorkItemStatus =
  | 'detected'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'archived';
export type WorkItemSource = 'detected' | 'manual';
export type WorkItemSummarySource = 'generated' | 'user';
/**
 * How a prompt came to sit under a work item. `suggested` is the one value
 * that is not a link: it marks a prompt in the suggestion queue, which has not
 * been grouped yet.
 */
export type WorkItemLinkSource = 'detected' | 'manual' | 'similarity' | 'suggested';

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'detected', 'active', 'paused', 'blocked', 'completed', 'archived',
];

/** Statuses that mean the work is no longer being carried out. */
export const WORK_ITEM_CLOSED_STATUSES: readonly WorkItemStatus[] = ['completed', 'archived'];

export interface WorkItemReference {
  type: TicketReferenceType;
  key: string;
  url: string | null;
  /** The prompt this reference was first seen in, when it came from extraction. */
  sourceTraceId?: string | null;
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
  gitEvidence: unknown | null;
  evidenceCheckedAt: string | null;
  completionNote: string | null;
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
  confirmCompletion?: boolean;
  completionNote?: string | null;
}

export interface WorkItemTraceLinkInput {
  workItemId: string;
  traceId: string;
  linkSource?: WorkItemLinkSource;
  confidence?: number;
}

export interface WorkItemEvidenceResult {
  status: 'linked' | 'uncategorized' | 'dismissed' | 'suggested';
  workItemIds: string[];
}

/** Why a prompt was taken out of the uncategorized inbox. */
export type WorkItemDismissReason = 'ignored' | 'unrelated';

export const WORK_ITEM_DISMISS_REASONS: readonly WorkItemDismissReason[] = ['ignored', 'unrelated'];

export interface DismissedTrace extends WorkItemTraceSummary {
  reason: WorkItemDismissReason;
  dismissedAt: string;
}

/** Why a medium-confidence link was proposed. */
export type WorkItemSuggestionReason = 'reference' | 'similarity';

export const WORK_ITEM_SUGGESTION_REASONS: readonly WorkItemSuggestionReason[] = [
  'reference',
  'similarity',
];

export type WorkItemSuggestionState = 'pending' | 'accepted' | 'rejected';

export interface WorkItemSuggestion {
  id: string;
  projectId: string;
  traceId: string;
  workItemId: string;
  workItemTitle: string;
  workItemStatus: WorkItemStatus;
  reason: WorkItemSuggestionReason;
  detail: string | null;
  confidence: number;
  /** True when more than one active item matched, so the design asks rather than suggests. */
  ambiguous: boolean;
  state: WorkItemSuggestionState;
  createdAt: string;
  decidedAt: string | null;
}

export interface SuggestedTrace extends WorkItemTraceSummary {
  suggestions: WorkItemSuggestion[];
}

/** Productivity rollup for a single work item. */
export interface WorkItemAnalytics {
  id: string;
  title: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  promptCount: number;
  sessionCount: number;
  tokens: number;
  credits: number;
  activeMs: number;
  firstPromptAt: string | null;
  lastPromptAt: string | null;
  completedAt: string | null;
  /** First prompt to completion. Null until the item is completed. */
  cycleTimeMs: number | null;
  /** First to last prompt. Available whether or not the item is finished. */
  elapsedMs: number | null;
}

export interface WorkItemGroupAnalytics {
  key: string;
  itemCount: number;
  promptCount: number;
  tokens: number;
  credits: number;
  /** Mean cycle time over completed items only. Null when none are completed. */
  avgCycleTimeMs: number | null;
}

/** The design's success measures, computed from recorded activity. */
export interface WorkItemSuccessMeasures {
  tracesWithCandidate: number;
  tracesTotal: number;
  candidateRate: number;
  autoLinksAccepted: number;
  autoLinksTotal: number;
  autoLinkAcceptanceRate: number;
  suggestionsAccepted: number;
  suggestionsDecided: number;
  suggestionAcceptanceRate: number;
  unlinkedPrompts: number;
  unlinkedRate: number;
  mergeSplitCorrections: number;
  itemsCompleted: number;
  itemsCompletedWithEvidence: number;
  completionEvidenceRate: number;
}

export interface WorkItemAnalyticsReport {
  projectId: string | null;
  totals: {
    itemCount: number;
    activeCount: number;
    completedCount: number;
    promptCount: number;
    tokens: number;
    credits: number;
    avgCycleTimeMs: number | null;
    avgCreditsPerItem: number;
  };
  byKind: WorkItemGroupAnalytics[];
  byStatus: WorkItemGroupAnalytics[];
  topByCredits: WorkItemAnalytics[];
  recentlyCompleted: WorkItemAnalytics[];
  measures: WorkItemSuccessMeasures;
}
