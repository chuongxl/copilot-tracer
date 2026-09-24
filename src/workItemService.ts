import { randomUUID } from 'crypto';
import { db, getSessionProjectId, setTracePersistedListener } from './db.js';
import {
  AUTO_LINK_CONFIDENCE,
  deriveWorkItemSummary,
  extractWorkItemEvidence,
  generateWorkItemDraft,
  SIMILARITY_SUGGEST_MIN,
  similarityScore,
} from './workItemExtraction.js';
import type {
  TicketReference,
  TicketReferenceType,
  WorkItemDraft,
  WorkItemKind,
} from './workItemExtraction.js';
import { collectGitEvidence, matchEvidenceToKeys } from './workItemGitEvidence.js';
import { WORK_ITEM_CLOSED_STATUSES } from './types.js';
import type {
  CreateWorkItemInput,
  DismissedTrace,
  SuggestedTrace,
  TraceEntry,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemDetail,
  WorkItemDismissReason,
  WorkItemEvidenceResult,
  WorkItemLinkSource,
  WorkItemReference,
  WorkItemStatus,
  WorkItemSuggestion,
  WorkItemSuggestionReason,
  WorkItemSuggestionState,
  WorkItemTraceLinkInput,
  WorkItemTraceSummary,
} from './types.js';

interface WorkItemRow {
  id: string;
  project_id: string;
  title: string;
  summary: string | null;
  kind: string;
  status: string;
  source: string;
  summary_source: string;
  confidence: number;
  extractor_version: string | null;
  acceptance_criteria: string | null;
  draft_generator_version: string | null;
  criteria_source: string | null;
  git_evidence: string | null;
  evidence_checked_at: string | null;
  completion_note: string | null;
  created_at: string;
  updated_at: string;
  trace_count: number;
  total_tokens: number;
  total_credits: number;
  last_active_at: string | null;
}

const AGGREGATE_SELECT = `
  SELECT
    wi.id, wi.project_id, wi.title, wi.summary, wi.kind, wi.status, wi.source,
    wi.summary_source, wi.confidence, wi.extractor_version, wi.created_at, wi.updated_at,
    wi.acceptance_criteria, wi.draft_generator_version, wi.criteria_source,
    wi.git_evidence, wi.evidence_checked_at, wi.completion_note,
    COUNT(wit.trace_id) AS trace_count,
    COALESCE(SUM(t.tokens_total), 0) AS total_tokens,
    COALESCE(SUM(t.ai_credits), 0) AS total_credits,
    MAX(t.date_time) AS last_active_at
  FROM work_items wi
  LEFT JOIN work_item_traces wit ON wit.work_item_id = wi.id
  LEFT JOIN traces t ON t.id = wit.trace_id
`;

// References are loaded separately: joining them into AGGREGATE_SELECT would
// multiply the trace rows and inflate the token and credit sums.
function loadReferences(workItemIds: string[]): Map<string, WorkItemReference[]> {
  const byItem = new Map<string, WorkItemReference[]>();
  if (!workItemIds.length) return byItem;

  const placeholders = workItemIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT work_item_id, reference_type, reference_key, url, source_trace_id
    FROM work_item_references
    WHERE work_item_id IN (${placeholders})
    ORDER BY created_at ASC, reference_type ASC, reference_key ASC
  `).all(...workItemIds) as Array<{
    work_item_id: string;
    reference_type: string;
    reference_key: string;
    url: string | null;
    source_trace_id: string | null;
  }>;

  for (const row of rows) {
    const list = byItem.get(row.work_item_id) ?? [];
    list.push({
      type: row.reference_type as TicketReferenceType,
      key: row.reference_key,
      url: row.url,
      sourceTraceId: row.source_trace_id,
    });
    byItem.set(row.work_item_id, list);
  }
  return byItem;
}

function parseCriteria(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function toWorkItem(row: WorkItemRow, references: WorkItemReference[]): WorkItem {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    summary: row.summary,
    kind: row.kind as WorkItemKind,
    status: row.status as WorkItemStatus,
    source: row.source as WorkItem['source'],
    summarySource: row.summary_source as WorkItem['summarySource'],
    acceptanceCriteria: parseCriteria(row.acceptance_criteria),
    criteriaSource: (row.criteria_source ?? 'generated') as WorkItem['criteriaSource'],
    draftGeneratorVersion: row.draft_generator_version,
    confidence: row.confidence,
    extractorVersion: row.extractor_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    references,
    ticketKey: references.length ? references[0].key : null,
    traceCount: row.trace_count,
    totalTokens: row.total_tokens,
    totalCredits: Number(row.total_credits.toFixed(6)),
    lastActiveAt: row.last_active_at,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function getWorkItems(projectId: string, status?: WorkItemStatus): WorkItem[] {
  const where = status ? 'WHERE wi.project_id = ? AND wi.status = ?' : 'WHERE wi.project_id = ?';
  const params = status ? [projectId, status] : [projectId];

  const rows = db.prepare(`
    ${AGGREGATE_SELECT}
    ${where}
    GROUP BY wi.id
    ORDER BY COALESCE(MAX(t.date_time), wi.updated_at) DESC
  `).all(...params) as WorkItemRow[];

  const references = loadReferences(rows.map((row) => row.id));
  return rows.map((row) => toWorkItem(row, references.get(row.id) ?? []));
}

export function getWorkItem(id: string): WorkItemDetail | null {
  const row = db.prepare(`
    ${AGGREGATE_SELECT}
    WHERE wi.id = ?
    GROUP BY wi.id
  `).get(id) as WorkItemRow | undefined;

  if (!row) return null;

  const traceRows = db.prepare(`
    SELECT t.id, t.session_id, t.date_time, t.prompt, t.tokens_total, t.ai_credits,
           t.duration_ms, t.status, wit.link_source
    FROM work_item_traces wit
    JOIN traces t ON t.id = wit.trace_id
    WHERE wit.work_item_id = ?
    ORDER BY t.date_time DESC
  `).all(id) as Array<Record<string, unknown>>;

  const traces: WorkItemTraceSummary[] = traceRows.map((t) => ({
    id: t.id as string,
    sessionId: t.session_id as string,
    dateTime: t.date_time as string,
    prompt: t.prompt as string,
    tokens: (t.tokens_total as number) ?? 0,
    credits: (t.ai_credits as number) ?? 0,
    durationMs: (t.duration_ms as number) ?? 0,
    status: t.status as TraceEntry['status'],
    linkSource: t.link_source as WorkItemLinkSource,
  }));

  const references = loadReferences([id]).get(id) ?? [];
  let gitEvidence: unknown | null = null;
  if (row.git_evidence) {
    try { gitEvidence = JSON.parse(row.git_evidence); } catch { gitEvidence = null; }
  }
  return {
    ...toWorkItem(row, references),
    traces,
    gitEvidence,
    evidenceCheckedAt: row.evidence_checked_at ?? null,
    completionNote: row.completion_note ?? null,
  };
}

export function findWorkItemIdByReference(
  projectId: string,
  type: TicketReferenceType,
  key: string,
): string | null {
  const row = db.prepare(`
    SELECT wi.id FROM work_items wi
    JOIN work_item_references r ON r.work_item_id = wi.id
    WHERE wi.project_id = ? AND r.reference_type = ? AND r.reference_key = ?
    LIMIT 1
  `).get(projectId, type, key) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Traces in a project that no work item has claimed and nobody has dismissed,
 * each carrying any pending suggestions. Suggestions ride along with the inbox
 * rather than forming a rival list, because both answer the same question:
 * what should happen to this prompt?
 */
export function getUncategorizedTraces(projectId: string, limit = 100): SuggestedTrace[] {
  // Traces carrying a pending suggestion sort first. On real data this project
  // had 536 unlinked prompts and 84 suggestions, all older than the newest 100,
  // so a plain date sort hid every actionable row behind the limit and the
  // suggestion tier looked broken. Date still orders within each group.
  const rows = db.prepare(`
    SELECT t.id, t.session_id, t.date_time, t.prompt, t.tokens_total, t.ai_credits,
           t.duration_ms, t.status,
           EXISTS (
             SELECT 1 FROM work_item_suggestions sg
             WHERE sg.trace_id = t.id AND sg.state = 'pending'
           ) as has_suggestion
    FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM work_item_traces wit WHERE wit.trace_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM work_item_dismissed_traces d WHERE d.trace_id = t.id)
    ORDER BY has_suggestion DESC, t.date_time DESC
    LIMIT ?
  `).all(projectId, limit) as Array<Record<string, unknown>>;

  const suggestions = loadPendingSuggestions(rows.map((t) => t.id as string));

  return rows.map((t) => ({
    id: t.id as string,
    sessionId: t.session_id as string,
    dateTime: t.date_time as string,
    prompt: t.prompt as string,
    tokens: (t.tokens_total as number) ?? 0,
    credits: (t.ai_credits as number) ?? 0,
    durationMs: (t.duration_ms as number) ?? 0,
    status: t.status as TraceEntry['status'],
    linkSource: (suggestions.has(t.id as string) ? 'suggested' : 'detected') as WorkItemLinkSource,
    suggestions: suggestions.get(t.id as string) ?? [],
  }));
}

// ── Inbox dismissal ───────────────────────────────────────────────────────────

/**
 * Take a prompt out of the uncategorized inbox without touching the trace.
 * Returns false when the trace does not belong to the project, so a stale page
 * cannot dismiss someone else's prompt.
 */
export function dismissTrace(
  projectId: string,
  traceId: string,
  reason: WorkItemDismissReason = 'ignored',
): boolean {
  const owns = db.prepare(`
    SELECT 1 FROM traces t JOIN sessions s ON s.id = t.session_id
    WHERE t.id = ? AND s.project_id = ?
  `).get(traceId, projectId);
  if (!owns) return false;

  db.prepare(`
    INSERT INTO work_item_dismissed_traces (trace_id, project_id, reason, dismissed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(trace_id) DO UPDATE SET reason = excluded.reason, dismissed_at = excluded.dismissed_at
  `).run(traceId, projectId, reason, new Date().toISOString());
  return true;
}

/** Put a dismissed prompt back in the inbox. */
export function restoreDismissedTrace(projectId: string, traceId: string): boolean {
  return db.prepare('DELETE FROM work_item_dismissed_traces WHERE trace_id = ? AND project_id = ?')
    .run(traceId, projectId).changes > 0;
}

export function getDismissedTraces(projectId: string, limit = 100): DismissedTrace[] {
  const rows = db.prepare(`
    SELECT t.id, t.session_id, t.date_time, t.prompt, t.tokens_total, t.ai_credits,
           t.duration_ms, t.status, d.reason, d.dismissed_at
    FROM work_item_dismissed_traces d
    JOIN traces t ON t.id = d.trace_id
    WHERE d.project_id = ?
    ORDER BY d.dismissed_at DESC
    LIMIT ?
  `).all(projectId, limit) as Array<Record<string, unknown>>;

  return rows.map((t) => ({
    id: t.id as string,
    sessionId: t.session_id as string,
    dateTime: t.date_time as string,
    prompt: t.prompt as string,
    tokens: (t.tokens_total as number) ?? 0,
    credits: (t.ai_credits as number) ?? 0,
    durationMs: (t.duration_ms as number) ?? 0,
    status: t.status as TraceEntry['status'],
    linkSource: 'manual' as WorkItemLinkSource,
    reason: t.reason as WorkItemDismissReason,
    dismissedAt: t.dismissed_at as string,
  }));
}

// ── Writes ────────────────────────────────────────────────────────────────────

export function saveTicketReference(input: {
  workItemId: string;
  type: TicketReferenceType;
  key: string;
  url?: string | null;
  sourceTraceId?: string | null;
}): void {
  db.prepare(`
    INSERT INTO work_item_references (
      work_item_id, reference_type, reference_key, url, source_trace_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id, reference_type, reference_key)
      DO UPDATE SET
        url = COALESCE(excluded.url, work_item_references.url),
        source_trace_id = COALESCE(work_item_references.source_trace_id, excluded.source_trace_id)
  `).run(
    input.workItemId,
    input.type,
    input.key,
    input.url ?? null,
    input.sourceTraceId ?? null,
    new Date().toISOString(),
  );
}

/** Append a status transition. Cycle-time queries read only this table. */
function recordStatusChange(
  workItemId: string,
  from: string | null,
  to: string,
  at = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT INTO work_item_status_history (work_item_id, from_status, to_status, changed_at)
    VALUES (?, ?, ?, ?)
  `).run(workItemId, from, to, at);
}

/** Record a manual correction so the merge and split rate is measurable. */
export function recordCorrection(projectId: string, kind: 'merge' | 'split' | 'unlink'): void {
  db.prepare(
    'INSERT INTO work_item_corrections (project_id, kind, created_at) VALUES (?, ?, ?)',
  ).run(projectId, kind, new Date().toISOString());
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const id = `work-item:${randomUUID()}`;
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO work_items (
        id, project_id, title, summary, kind, status, source, summary_source,
        confidence, extractor_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.title,
      input.summary ?? null,
      input.kind ?? 'unknown',
      input.status ?? 'active',
      input.source ?? 'manual',
      input.summarySource ?? 'generated',
      input.confidence ?? 0,
      input.extractorVersion ?? null,
      now,
      now,
    );

    for (const reference of input.references ?? []) {
      saveTicketReference({
        workItemId: id,
        type: reference.type,
        key: reference.key,
        url: reference.url,
        sourceTraceId: reference.sourceTraceId,
      });
    }

    recordStatusChange(id, null, input.status ?? 'active', now);
  });

  run();
  return getWorkItem(id) as WorkItem;
}

export class CompletionNotConfirmedError extends Error {
  constructor() {
    super('Marking a work item completed needs explicit confirmation. Send confirmCompletion: true.');
    this.name = 'CompletionNotConfirmedError';
  }
}

export function updateWorkItem(id: string, input: UpdateWorkItemInput): WorkItemDetail | null {
  const existing = db.prepare('SELECT id, status FROM work_items WHERE id = ?').get(id) as
    { id: string; status: string } | undefined;
  if (!existing) return null;

  // Git evidence and prompt counts can suggest an item is finished, but only a
  // person decides that, so the move to completed needs an explicit confirmation.
  if (input.status === 'completed' && existing.status !== 'completed' && input.confirmCompletion !== true) {
    throw new CompletionNotConfirmedError();
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title); }
  if (input.kind !== undefined) { sets.push('kind = ?'); params.push(input.kind); }
  if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status); }
  if (input.completionNote !== undefined) {
    sets.push('completion_note = ?');
    params.push(input.completionNote);
  }
  if (input.summary !== undefined) {
    sets.push('summary = ?', "summary_source = 'user'");
    params.push(input.summary);
  }
  if (input.acceptanceCriteria !== undefined) {
    sets.push('acceptance_criteria = ?', "criteria_source = 'user'");
    params.push(JSON.stringify(input.acceptanceCriteria));
  }

  if (sets.length) {
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), id);
    db.prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  if (input.status !== undefined && input.status !== existing.status) {
    recordStatusChange(id, existing.status, input.status);
  }

  return getWorkItem(id);
}

export function deleteWorkItem(id: string): boolean {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM work_item_traces WHERE work_item_id = ?').run(id);
    db.prepare('DELETE FROM work_item_references WHERE work_item_id = ?').run(id);
    db.prepare('DELETE FROM work_item_status_history WHERE work_item_id = ?').run(id);
    db.prepare('DELETE FROM work_item_suggestions WHERE work_item_id = ?').run(id);
    return db.prepare('DELETE FROM work_items WHERE id = ?').run(id).changes > 0;
  });
  return run();
}

// ── Merge and split ───────────────────────────────────────────────────────────

export class WorkItemMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkItemMergeError';
  }
}

export class WorkItemSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkItemSplitError';
  }
}

/**
 * Fold `sourceIds` into `targetId`: every trace link, ticket reference and
 * acceptance criterion moves across, then the sources are removed. Raw traces
 * are untouched, so a bad merge costs nothing but a re-split.
 */
export function mergeWorkItems(targetId: string, sourceIds: string[]): WorkItemDetail {
  const sources = [...new Set(sourceIds)].filter((sourceId) => sourceId !== targetId);
  if (!sources.length) throw new WorkItemMergeError('Pick at least one other work item to merge in.');

  const run = db.transaction(() => {
    const target = db.prepare('SELECT id, project_id, summary, acceptance_criteria FROM work_items WHERE id = ?')
      .get(targetId) as
      | { id: string; project_id: string; summary: string | null; acceptance_criteria: string | null }
      | undefined;
    if (!target) throw new WorkItemMergeError('Target work item not found.');

    const criteria = parseCriteria(target.acceptance_criteria);
    const seenCriteria = new Set(criteria.map((c) => c.trim().toLowerCase()));
    let summary = target.summary;

    for (const sourceId of sources) {
      const source = db.prepare('SELECT id, project_id, summary, acceptance_criteria FROM work_items WHERE id = ?')
        .get(sourceId) as
        | { id: string; project_id: string; summary: string | null; acceptance_criteria: string | null }
        | undefined;
      if (!source) throw new WorkItemMergeError(`Work item ${sourceId} not found.`);
      if (source.project_id !== target.project_id) {
        throw new WorkItemMergeError('Work items from different projects cannot be merged.');
      }

      db.prepare(`
        INSERT INTO work_item_traces (work_item_id, trace_id, linked_at, link_source, confidence)
        SELECT ?, trace_id, linked_at, link_source, confidence
        FROM work_item_traces WHERE work_item_id = ?
        ON CONFLICT(work_item_id, trace_id) DO NOTHING
      `).run(targetId, sourceId);

      db.prepare(`
        INSERT INTO work_item_references (
          work_item_id, reference_type, reference_key, url, source_trace_id, created_at
        )
        SELECT ?, reference_type, reference_key, url, source_trace_id, created_at
        FROM work_item_references WHERE work_item_id = ?
        ON CONFLICT(work_item_id, reference_type, reference_key)
          DO UPDATE SET url = COALESCE(excluded.url, work_item_references.url)
      `).run(targetId, sourceId);

      if (!summary?.trim() && source.summary?.trim()) summary = source.summary;

      for (const criterion of parseCriteria(source.acceptance_criteria)) {
        const key = criterion.trim().toLowerCase();
        if (!key || seenCriteria.has(key)) continue;
        seenCriteria.add(key);
        criteria.push(criterion);
      }

      db.prepare('DELETE FROM work_item_traces WHERE work_item_id = ?').run(sourceId);
      db.prepare('DELETE FROM work_item_references WHERE work_item_id = ?').run(sourceId);
      db.prepare('DELETE FROM work_item_status_history WHERE work_item_id = ?').run(sourceId);
      db.prepare('DELETE FROM work_item_suggestions WHERE work_item_id = ?').run(sourceId);
      db.prepare('DELETE FROM work_items WHERE id = ?').run(sourceId);
    }

    db.prepare('UPDATE work_items SET summary = ?, acceptance_criteria = ?, updated_at = ? WHERE id = ?')
      .run(summary, JSON.stringify(criteria), new Date().toISOString(), targetId);
    recordCorrection(target.project_id, 'merge');
  });

  run();
  return getWorkItem(targetId) as WorkItemDetail;
}

/**
 * Move `traceIds` out of `id` into a brand new work item. At least one trace
 * must stay behind, otherwise this is a rename and should go through PATCH.
 */
export function splitWorkItem(
  id: string,
  input: { title: string; traceIds: string[]; kind?: WorkItemKind },
): { source: WorkItemDetail; created: WorkItemDetail } {
  const title = input.title?.trim();
  if (!title) throw new WorkItemSplitError('The new work item needs a title.');

  const traceIds = [...new Set(input.traceIds ?? [])];
  if (!traceIds.length) throw new WorkItemSplitError('Pick at least one prompt to split out.');

  const createdId = `work-item:${randomUUID()}`;

  const run = db.transaction(() => {
    const source = db.prepare('SELECT id, project_id, kind FROM work_items WHERE id = ?').get(id) as
      | { id: string; project_id: string; kind: string }
      | undefined;
    if (!source) throw new WorkItemSplitError('Work item not found.');

    const linked = db.prepare('SELECT trace_id FROM work_item_traces WHERE work_item_id = ?')
      .all(id) as Array<{ trace_id: string }>;
    const linkedIds = new Set(linked.map((row) => row.trace_id));

    for (const traceId of traceIds) {
      if (!linkedIds.has(traceId)) {
        throw new WorkItemSplitError(`Prompt ${traceId} is not linked to this work item.`);
      }
    }
    if (traceIds.length >= linkedIds.size) {
      throw new WorkItemSplitError('Leave at least one prompt on the original work item.');
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO work_items (
        id, project_id, title, summary, kind, status, source, summary_source,
        confidence, extractor_version, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, 'active', 'manual', 'generated', 0, NULL, ?, ?)
    `).run(createdId, source.project_id, title, input.kind ?? source.kind, now, now);

    const move = db.prepare(`
      UPDATE work_item_traces SET work_item_id = ?, link_source = 'manual'
      WHERE work_item_id = ? AND trace_id = ?
    `);
    for (const traceId of traceIds) move.run(createdId, id, traceId);

    db.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, id);
    recordStatusChange(createdId, null, 'active', now);
    recordCorrection(source.project_id, 'split');
  });

  run();
  return {
    source: getWorkItem(id) as WorkItemDetail,
    created: getWorkItem(createdId) as WorkItemDetail,
  };
}

export class WorkItemProjectMismatchError extends Error {
  constructor() {
    super('That prompt belongs to a different project.');
    this.name = 'WorkItemProjectMismatchError';
  }
}

/** True when a prompt was explicitly taken out of the inbox and not since restored. */
function isTraceDismissed(traceId: string): boolean {
  return !!db.prepare('SELECT 1 FROM work_item_dismissed_traces WHERE trace_id = ?').get(traceId);
}

export function linkTraceToWorkItem(input: WorkItemTraceLinkInput): void {
  // A work item aggregates tokens and credits for one project, so a trace from
  // another project would silently inflate the wrong totals.
  const scope = db.prepare(`
    SELECT wi.project_id AS item_project, s.project_id AS trace_project
    FROM work_items wi, traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE wi.id = ? AND t.id = ?
  `).get(input.workItemId, input.traceId) as
    | { item_project: string; trace_project: string | null }
    | undefined;

  if (scope && scope.trace_project !== scope.item_project) {
    throw new WorkItemProjectMismatchError();
  }

  db.prepare(`
    INSERT INTO work_item_traces (work_item_id, trace_id, linked_at, link_source, confidence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id, trace_id) DO NOTHING
  `).run(
    input.workItemId,
    input.traceId,
    new Date().toISOString(),
    input.linkSource ?? 'detected',
    input.confidence ?? 0,
  );

  // Only a deliberate attach overrides a dismissal. If automatic extraction
  // cleared it too, re-running backfill would quietly resurrect every prompt
  // the user had already waved away.
  if ((input.linkSource ?? 'detected') === 'manual') {
    db.prepare('DELETE FROM work_item_dismissed_traces WHERE trace_id = ?').run(input.traceId);
  }
}

export function unlinkTraceFromWorkItem(workItemId: string, traceId: string): boolean {
  const removed = db.prepare('DELETE FROM work_item_traces WHERE work_item_id = ? AND trace_id = ?')
    .run(workItemId, traceId).changes > 0;

  if (removed) {
    const owner = db.prepare('SELECT project_id FROM work_items WHERE id = ?').get(workItemId) as
      | { project_id: string }
      | undefined;
    if (owner) recordCorrection(owner.project_id, 'unlink');
  }

  return removed;
}

// ── Suggestions ───────────────────────────────────────────────────────────────
//
// A suggestion is a proposed link the engineer has not accepted. Keeping it
// separate from work_item_traces is what makes the design's "percentage of
// suggested links accepted" measurable: an auto-link that was never questioned
// and a guess the user approved are different facts.

/** Items a new prompt could plausibly join. Closed work is not a candidate. */
function openWorkItemsFor(projectId: string): Array<{
  id: string;
  title: string;
  summary: string | null;
  status: string;
}> {
  const closed = WORK_ITEM_CLOSED_STATUSES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, title, summary, status FROM work_items
    WHERE project_id = ? AND status NOT IN (${closed})
    ORDER BY updated_at DESC
    LIMIT 200
  `).all(projectId, ...WORK_ITEM_CLOSED_STATUSES) as Array<{
    id: string;
    title: string;
    summary: string | null;
    status: string;
  }>;
}

/** The text a work item is matched on: its title, summary and linked prompts. */
function workItemMatchText(workItemId: string, title: string, summary: string | null): string {
  const prompts = db.prepare(`
    SELECT t.prompt FROM work_item_traces wit
    JOIN traces t ON t.id = wit.trace_id
    WHERE wit.work_item_id = ?
    ORDER BY t.date_time DESC LIMIT 5
  `).all(workItemId) as Array<{ prompt: string | null }>;

  return [title, summary ?? '', ...prompts.map((p) => p.prompt ?? '')].join(' ');
}

interface SuggestionCandidate {
  workItemId: string;
  reason: WorkItemSuggestionReason;
  detail: string;
  confidence: number;
}

/**
 * Propose links for a prompt that carried no strong evidence. Two sources:
 * a medium-confidence reference such as a bare `#42` that an existing item
 * already tracks, and strong wording overlap with a single open item.
 */
export function buildSuggestionCandidates(
  projectId: string,
  prompt: string,
  references: TicketReference[] = [],
): SuggestionCandidate[] {
  const byItem = new Map<string, SuggestionCandidate>();

  for (const reference of references) {
    if (reference.confidence >= AUTO_LINK_CONFIDENCE) continue;
    const workItemId = findWorkItemIdByReference(projectId, reference.type, reference.key);
    if (!workItemId) continue;
    byItem.set(workItemId, {
      workItemId,
      reason: 'reference',
      detail: `Mentions ${reference.key}`,
      confidence: reference.confidence,
    });
  }

  const scored: SuggestionCandidate[] = [];
  for (const item of openWorkItemsFor(projectId)) {
    if (byItem.has(item.id)) continue;
    const score = similarityScore(prompt, workItemMatchText(item.id, item.title, item.summary));
    if (score < SIMILARITY_SUGGEST_MIN) continue;
    scored.push({
      workItemId: item.id,
      reason: 'similarity',
      detail: `Wording overlaps "${item.title}"`,
      confidence: score,
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  // More candidates than this is a sign the threshold let noise through, and a
  // wall of guesses is worse than none.
  for (const candidate of scored.slice(0, 3)) byItem.set(candidate.workItemId, candidate);

  return [...byItem.values()];
}

/**
 * Store suggestions for a prompt. Returns how many are pending. A suggestion
 * the user already decided on is never re-raised, otherwise rejecting one
 * would be pointless.
 */
export function recordSuggestions(
  projectId: string,
  traceId: string,
  candidates: SuggestionCandidate[],
): number {
  if (!candidates.length) return 0;

  // The design separates "one clear match" from "several plausible items". The
  // second needs a decision, not a nudge, so the UI is told which case it is.
  const similar = candidates.filter((c) => c.reason === 'similarity');
  const ambiguous = similar.length > 1;

  const insert = db.prepare(`
    INSERT INTO work_item_suggestions (
      id, project_id, trace_id, work_item_id, reason, detail, confidence, ambiguous, state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(trace_id, work_item_id) DO NOTHING
  `);

  const now = new Date().toISOString();
  let stored = 0;
  const run = db.transaction(() => {
    for (const candidate of candidates) {
      const flagged = ambiguous && candidate.reason === 'similarity' ? 1 : 0;
      const result = insert.run(
        `suggestion:${randomUUID()}`,
        projectId,
        traceId,
        candidate.workItemId,
        candidate.reason,
        candidate.detail,
        candidate.confidence,
        flagged,
        now,
      );
      stored += result.changes;
    }
  });
  run();

  return stored;
}

const SUGGESTION_SELECT = `
  SELECT s.id, s.project_id, s.trace_id, s.work_item_id, s.reason, s.detail,
         s.confidence, s.ambiguous, s.state, s.created_at, s.decided_at,
         wi.title AS work_item_title, wi.status AS work_item_status
  FROM work_item_suggestions s
  JOIN work_items wi ON wi.id = s.work_item_id
`;

interface SuggestionRow {
  id: string;
  project_id: string;
  trace_id: string;
  work_item_id: string;
  reason: string;
  detail: string | null;
  confidence: number;
  ambiguous: number;
  state: string;
  created_at: string;
  decided_at: string | null;
  work_item_title: string;
  work_item_status: string;
}

function toSuggestion(row: SuggestionRow): WorkItemSuggestion {
  return {
    id: row.id,
    projectId: row.project_id,
    traceId: row.trace_id,
    workItemId: row.work_item_id,
    workItemTitle: row.work_item_title,
    workItemStatus: row.work_item_status as WorkItemStatus,
    reason: row.reason as WorkItemSuggestionReason,
    detail: row.detail,
    confidence: row.confidence,
    ambiguous: row.ambiguous === 1,
    state: row.state as WorkItemSuggestionState,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/** Pending suggestions for the given prompts, keyed by trace id. */
function loadPendingSuggestions(traceIds: string[]): Map<string, WorkItemSuggestion[]> {
  const byTrace = new Map<string, WorkItemSuggestion[]>();
  if (!traceIds.length) return byTrace;

  const placeholders = traceIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    ${SUGGESTION_SELECT}
    WHERE s.state = 'pending' AND s.trace_id IN (${placeholders})
    ORDER BY s.confidence DESC, wi.title ASC
  `).all(...traceIds) as SuggestionRow[];

  for (const row of rows) {
    const list = byTrace.get(row.trace_id) ?? [];
    list.push(toSuggestion(row));
    byTrace.set(row.trace_id, list);
  }
  return byTrace;
}

export function getSuggestion(id: string): WorkItemSuggestion | null {
  const row = db.prepare(`${SUGGESTION_SELECT} WHERE s.id = ?`).get(id) as SuggestionRow | undefined;
  return row ? toSuggestion(row) : null;
}

export class SuggestionAlreadyDecidedError extends Error {
  constructor() {
    super('That suggestion has already been accepted or rejected.');
    this.name = 'SuggestionAlreadyDecidedError';
  }
}

/**
 * Accept a suggestion: link the prompt with source `similarity` and close out
 * the competing suggestions for the same prompt, which would otherwise keep
 * offering an answer the user has already given.
 */
export function acceptSuggestion(id: string): WorkItemSuggestion | null {
  const existing = getSuggestion(id);
  if (!existing) return null;
  if (existing.state !== 'pending') throw new SuggestionAlreadyDecidedError();

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    linkTraceToWorkItem({
      workItemId: existing.workItemId,
      traceId: existing.traceId,
      linkSource: existing.reason === 'reference' ? 'detected' : 'similarity',
      confidence: existing.confidence,
    });

    db.prepare("UPDATE work_item_suggestions SET state = 'accepted', decided_at = ? WHERE id = ?")
      .run(now, id);
    db.prepare(`
      UPDATE work_item_suggestions SET state = 'rejected', decided_at = ?
      WHERE trace_id = ? AND id != ? AND state = 'pending'
    `).run(now, existing.traceId, id);
  });
  run();

  return getSuggestion(id);
}

export function rejectSuggestion(id: string): WorkItemSuggestion | null {
  const existing = getSuggestion(id);
  if (!existing) return null;
  if (existing.state !== 'pending') throw new SuggestionAlreadyDecidedError();

  db.prepare("UPDATE work_item_suggestions SET state = 'rejected', decided_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  return getSuggestion(id);
}

// ── Extraction pipeline ───────────────────────────────────────────────────────

export function persistWorkItemEvidence(
  trace: TraceEntry,
  projectId: string | null | undefined,
): WorkItemEvidenceResult {
  const empty: WorkItemEvidenceResult = { status: 'uncategorized', workItemIds: [] };
  if (!projectId || !trace?.id) return empty;

  const evidence = extractWorkItemEvidence(trace.prompt ?? '');
  const strong = evidence.references.filter((ref) => ref.confidence >= AUTO_LINK_CONFIDENCE);

  // A dismissed prompt stays dismissed. Without this, "Group past traces"
  // would re-link everything the user had explicitly waved away.
  if (isTraceDismissed(trace.id)) return { status: 'dismissed', workItemIds: [] };

  if (!strong.length) {
    // No certainty, so propose rather than decide. Already-linked prompts are
    // skipped: a suggestion for work that is already grouped is just noise.
    const alreadyLinked = db.prepare('SELECT 1 FROM work_item_traces WHERE trace_id = ?').get(trace.id);
    if (alreadyLinked) return empty;

    const candidates = buildSuggestionCandidates(projectId, trace.prompt ?? '', evidence.references);
    if (!candidates.length) return empty;

    recordSuggestions(projectId, trace.id, candidates);
    return { status: 'suggested', workItemIds: candidates.map((c) => c.workItemId) };
  }

  const run = db.transaction(() => {
    const ids: string[] = [];

    for (const reference of strong) {
      let workItemId = findWorkItemIdByReference(projectId, reference.type, reference.key);

      if (!workItemId) {
        workItemId = createWorkItem({
          projectId,
          title: reference.key,
          summary: deriveWorkItemSummary(trace.prompt ?? ''),
          kind: evidence.kind,
          status: 'detected',
          source: 'detected',
          confidence: evidence.confidence,
          extractorVersion: evidence.extractorVersion,
          references: [{
            type: reference.type,
            key: reference.key,
            url: reference.url,
            sourceTraceId: trace.id,
          }],
        }).id;
      } else {
        // A later prompt may carry a URL or a clearer intent than the first one did.
        saveTicketReference({
          workItemId,
          type: reference.type,
          key: reference.key,
          url: reference.url,
          sourceTraceId: trace.id,
        });
        if (evidence.kind !== 'unknown') {
          db.prepare("UPDATE work_items SET kind = ? WHERE id = ? AND kind = 'unknown'")
            .run(evidence.kind, workItemId);
        }
      }

      linkTraceToWorkItem({
        workItemId,
        traceId: trace.id,
        linkSource: 'detected',
        confidence: evidence.confidence,
      });
      ids.push(workItemId);
    }

    return ids;
  });

  const workItemIds = run();
  return { status: 'linked', workItemIds };
}

/**
 * Group traces that were captured before extraction existed, or before a
 * session was linked to its project. Safe to re-run: linking is idempotent.
 */
export function backfillWorkItems(
  projectId?: string,
  limit = 5000,
): { scanned: number; linked: number; suggested: number } {
  const rows = (projectId
    ? db.prepare(`
        SELECT t.id, t.session_id, t.prompt, s.project_id
        FROM traces t JOIN sessions s ON s.id = t.session_id
        WHERE s.project_id = ?
        ORDER BY t.date_time DESC LIMIT ?
      `).all(projectId, limit)
    : db.prepare(`
        SELECT t.id, t.session_id, t.prompt, s.project_id
        FROM traces t JOIN sessions s ON s.id = t.session_id
        WHERE s.project_id IS NOT NULL
        ORDER BY t.date_time DESC LIMIT ?
      `).all(limit)) as Array<{ id: string; session_id: string; prompt: string; project_id: string }>;

  let linked = 0;
  let suggested = 0;
  for (const row of rows) {
    if (!row.prompt?.trim()) continue;
    const trace = { id: row.id, sessionId: row.session_id, prompt: row.prompt } as TraceEntry;
    const result = persistWorkItemEvidence(trace, row.project_id);
    if (result.status === 'linked') linked += 1;
    else if (result.status === 'suggested') suggested += 1;
  }

  return { scanned: rows.length, linked, suggested };
}

// ── Draft generation ──────────────────────────────────────────────────────────

/** Build a draft from a work item's linked prompts without saving it. */
export function buildWorkItemDraft(workItemId: string): WorkItemDraft | null {
  const item = db.prepare('SELECT id FROM work_items WHERE id = ?').get(workItemId);
  if (!item) return null;

  const rows = db.prepare(`
    SELECT t.prompt, t.date_time
    FROM work_item_traces wit
    JOIN traces t ON t.id = wit.trace_id
    WHERE wit.work_item_id = ?
    ORDER BY t.date_time ASC
  `).all(workItemId) as Array<{ prompt: string; date_time: string }>;

  return generateWorkItemDraft(rows.map((r) => ({ prompt: r.prompt, dateTime: r.date_time })));
}

/**
 * Regenerate a work item's summary, criteria and kind from its prompts.
 *
 * Fields a person has edited are left alone unless `overwriteUserEdits` is set,
 * so a regeneration triggered by new prompts cannot quietly discard their work.
 * The title is never auto-replaced: for detected items it is the ticket key,
 * which is the one piece of identity worth keeping stable.
 */
export function applyWorkItemDraft(
  workItemId: string,
  options: { overwriteUserEdits?: boolean } = {},
): { item: WorkItemDetail; draft: WorkItemDraft; applied: string[] } | null {
  const draft = buildWorkItemDraft(workItemId);
  if (!draft) return null;

  const current = db.prepare(
    'SELECT summary, summary_source, acceptance_criteria, criteria_source, kind FROM work_items WHERE id = ?',
  ).get(workItemId) as {
    summary: string | null;
    summary_source: string;
    acceptance_criteria: string | null;
    criteria_source: string | null;
    kind: string;
  };

  const sets: string[] = ['draft_generator_version = ?'];
  const params: unknown[] = [draft.generatorVersion];
  const applied: string[] = [];

  // A blank field is never a user edit worth protecting, so fill it even when
  // the source says 'user' (manual items start that way with nothing in them).
  const summaryFree = options.overwriteUserEdits
    || current.summary_source !== 'user'
    || !current.summary?.trim();
  if (draft.summary && summaryFree) {
    sets.push('summary = ?', "summary_source = 'generated'");
    params.push(draft.summary);
    applied.push('summary');
  }

  const criteriaFree = options.overwriteUserEdits
    || current.criteria_source !== 'user'
    || parseCriteria(current.acceptance_criteria).length === 0;
  if (draft.acceptanceCriteria.length && criteriaFree) {
    sets.push('acceptance_criteria = ?', "criteria_source = 'generated'");
    params.push(JSON.stringify(draft.acceptanceCriteria));
    applied.push('acceptanceCriteria');
  }

  if (draft.kind !== 'unknown' && current.kind === 'unknown') {
    sets.push('kind = ?');
    params.push(draft.kind);
    applied.push('kind');
  }

  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), workItemId);
  db.prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return { item: getWorkItem(workItemId) as WorkItemDetail, draft, applied };
}

// ── Git evidence ──────────────────────────────────────────────────────────────

/**
 * Collect git evidence for one work item and store it.
 *
 * Evidence is informational. It never changes status on its own: a commit
 * mentioning ABC-123 proves work happened, not that the work is done.
 */
export function refreshWorkItemEvidence(workItemId: string): WorkItemDetail | null {
  const row = db.prepare('SELECT project_id FROM work_items WHERE id = ?').get(workItemId) as
    { project_id: string } | undefined;
  if (!row) return null;

  const project = db.prepare('SELECT path, local_path FROM projects WHERE id = ?').get(row.project_id) as
    { path: string; local_path: string | null } | undefined;

  // `path` is a filesystem path for locally detected projects and a repo URL
  // for ones discovered through telemetry, so only use it when it looks local.
  const candidate = project?.local_path
    ?? (project?.path?.startsWith('/') ? project.path : null);

  const references = loadReferences([workItemId]).get(workItemId) ?? [];
  const evidence = matchEvidenceToKeys(collectGitEvidence(candidate), references.map((r) => r.key));

  db.prepare('UPDATE work_items SET git_evidence = ?, evidence_checked_at = ? WHERE id = ?')
    .run(JSON.stringify(evidence), evidence.collectedAt, workItemId);

  return getWorkItem(workItemId);
}

// Streaming updates re-persist the same trace many times. Remembering the last
// prompt we extracted from keeps that off the hot path without changing results.
const PROCESSED_LIMIT = 2000;
const processedPrompts = new Map<string, string>();

function alreadyProcessed(traceId: string, prompt: string): boolean {
  if (processedPrompts.get(traceId) === prompt) return true;
  processedPrompts.set(traceId, prompt);
  if (processedPrompts.size > PROCESSED_LIMIT) {
    const oldest = processedPrompts.keys().next().value;
    if (oldest) processedPrompts.delete(oldest);
  }
  return false;
}

/**
 * Wire work-item extraction into trace persistence. Registering one listener
 * covers every ingestion path instead of patching each upsertTrace call site.
 */
export function installWorkItemExtraction(): void {
  setTracePersistedListener((entry) => {
    const prompt = entry.prompt ?? '';
    if (!prompt.trim()) return;
    if (alreadyProcessed(entry.id, prompt)) return;

    const projectId = getSessionProjectId(entry.sessionId);
    if (!projectId) return;

    persistWorkItemEvidence(entry, projectId);
  });
}
