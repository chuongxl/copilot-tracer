import { randomUUID } from 'crypto';
import { db, getSessionProjectId, setTracePersistedListener } from './db.js';
import {
  AUTO_LINK_CONFIDENCE,
  deriveWorkItemSummary,
  extractWorkItemEvidence,
  generateWorkItemDraft,
} from './workItemExtraction.js';
import type { TicketReferenceType, WorkItemDraft, WorkItemKind } from './workItemExtraction.js';
import type {
  CreateWorkItemInput,
  TraceEntry,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemDetail,
  WorkItemEvidenceResult,
  WorkItemLinkSource,
  WorkItemReference,
  WorkItemStatus,
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
    SELECT work_item_id, reference_type, reference_key, url
    FROM work_item_references
    WHERE work_item_id IN (${placeholders})
    ORDER BY created_at ASC, reference_type ASC, reference_key ASC
  `).all(...workItemIds) as Array<{
    work_item_id: string;
    reference_type: string;
    reference_key: string;
    url: string | null;
  }>;

  for (const row of rows) {
    const list = byItem.get(row.work_item_id) ?? [];
    list.push({
      type: row.reference_type as TicketReferenceType,
      key: row.reference_key,
      url: row.url,
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
  return { ...toWorkItem(row, references), traces };
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

/** Traces in a project that no work item has claimed yet. Powers the inbox. */
export function getUncategorizedTraces(projectId: string, limit = 100): WorkItemTraceSummary[] {
  const rows = db.prepare(`
    SELECT t.id, t.session_id, t.date_time, t.prompt, t.tokens_total, t.ai_credits,
           t.duration_ms, t.status
    FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM work_item_traces wit WHERE wit.trace_id = t.id)
    ORDER BY t.date_time DESC
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
    linkSource: 'detected' as WorkItemLinkSource,
  }));
}

// ── Writes ────────────────────────────────────────────────────────────────────

export function saveTicketReference(input: {
  workItemId: string;
  type: TicketReferenceType;
  key: string;
  url?: string | null;
}): void {
  db.prepare(`
    INSERT INTO work_item_references (work_item_id, reference_type, reference_key, url, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id, reference_type, reference_key)
      DO UPDATE SET url = COALESCE(excluded.url, work_item_references.url)
  `).run(input.workItemId, input.type, input.key, input.url ?? null, new Date().toISOString());
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
      });
    }
  });

  run();
  return getWorkItem(id) as WorkItem;
}

export function updateWorkItem(id: string, input: UpdateWorkItemInput): WorkItemDetail | null {
  const existing = db.prepare('SELECT id FROM work_items WHERE id = ?').get(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title); }
  if (input.kind !== undefined) { sets.push('kind = ?'); params.push(input.kind); }
  if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status); }
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

  return getWorkItem(id);
}

export function deleteWorkItem(id: string): boolean {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM work_item_traces WHERE work_item_id = ?').run(id);
    db.prepare('DELETE FROM work_item_references WHERE work_item_id = ?').run(id);
    return db.prepare('DELETE FROM work_items WHERE id = ?').run(id).changes > 0;
  });
  return run();
}

export function linkTraceToWorkItem(input: WorkItemTraceLinkInput): void {
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
}

export function unlinkTraceFromWorkItem(workItemId: string, traceId: string): boolean {
  return db.prepare('DELETE FROM work_item_traces WHERE work_item_id = ? AND trace_id = ?')
    .run(workItemId, traceId).changes > 0;
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
  if (!strong.length) return empty;

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
          source: 'detected',
          confidence: evidence.confidence,
          extractorVersion: evidence.extractorVersion,
          references: [{ type: reference.type, key: reference.key, url: reference.url }],
        }).id;
      } else {
        // A later prompt may carry a URL or a clearer intent than the first one did.
        saveTicketReference({
          workItemId,
          type: reference.type,
          key: reference.key,
          url: reference.url,
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
export function backfillWorkItems(projectId?: string, limit = 5000): { scanned: number; linked: number } {
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
  for (const row of rows) {
    if (!row.prompt?.trim()) continue;
    const trace = { id: row.id, sessionId: row.session_id, prompt: row.prompt } as TraceEntry;
    if (persistWorkItemEvidence(trace, row.project_id).status === 'linked') linked += 1;
  }

  return { scanned: rows.length, linked };
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
