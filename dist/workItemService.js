import { randomUUID } from 'crypto';
import { db, getSessionProjectId, setTracePersistedListener } from './db.js';
import { AUTO_LINK_CONFIDENCE, deriveWorkItemSummary, extractWorkItemEvidence, generateWorkItemDraft, } from './workItemExtraction.js';
import { collectGitEvidence, matchEvidenceToKeys } from './workItemGitEvidence.js';
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
function loadReferences(workItemIds) {
    const byItem = new Map();
    if (!workItemIds.length)
        return byItem;
    const placeholders = workItemIds.map(() => '?').join(', ');
    const rows = db.prepare(`
    SELECT work_item_id, reference_type, reference_key, url
    FROM work_item_references
    WHERE work_item_id IN (${placeholders})
    ORDER BY created_at ASC, reference_type ASC, reference_key ASC
  `).all(...workItemIds);
    for (const row of rows) {
        const list = byItem.get(row.work_item_id) ?? [];
        list.push({
            type: row.reference_type,
            key: row.reference_key,
            url: row.url,
        });
        byItem.set(row.work_item_id, list);
    }
    return byItem;
}
function parseCriteria(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    }
    catch {
        return [];
    }
}
function toWorkItem(row, references) {
    return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        summary: row.summary,
        kind: row.kind,
        status: row.status,
        source: row.source,
        summarySource: row.summary_source,
        acceptanceCriteria: parseCriteria(row.acceptance_criteria),
        criteriaSource: (row.criteria_source ?? 'generated'),
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
export function getWorkItems(projectId, status) {
    const where = status ? 'WHERE wi.project_id = ? AND wi.status = ?' : 'WHERE wi.project_id = ?';
    const params = status ? [projectId, status] : [projectId];
    const rows = db.prepare(`
    ${AGGREGATE_SELECT}
    ${where}
    GROUP BY wi.id
    ORDER BY COALESCE(MAX(t.date_time), wi.updated_at) DESC
  `).all(...params);
    const references = loadReferences(rows.map((row) => row.id));
    return rows.map((row) => toWorkItem(row, references.get(row.id) ?? []));
}
export function getWorkItem(id) {
    const row = db.prepare(`
    ${AGGREGATE_SELECT}
    WHERE wi.id = ?
    GROUP BY wi.id
  `).get(id);
    if (!row)
        return null;
    const traceRows = db.prepare(`
    SELECT t.id, t.session_id, t.date_time, t.prompt, t.tokens_total, t.ai_credits,
           t.duration_ms, t.status, wit.link_source
    FROM work_item_traces wit
    JOIN traces t ON t.id = wit.trace_id
    WHERE wit.work_item_id = ?
    ORDER BY t.date_time DESC
  `).all(id);
    const traces = traceRows.map((t) => ({
        id: t.id,
        sessionId: t.session_id,
        dateTime: t.date_time,
        prompt: t.prompt,
        tokens: t.tokens_total ?? 0,
        credits: t.ai_credits ?? 0,
        durationMs: t.duration_ms ?? 0,
        status: t.status,
        linkSource: t.link_source,
    }));
    const references = loadReferences([id]).get(id) ?? [];
    let gitEvidence = null;
    if (row.git_evidence) {
        try {
            gitEvidence = JSON.parse(row.git_evidence);
        }
        catch {
            gitEvidence = null;
        }
    }
    return {
        ...toWorkItem(row, references),
        traces,
        gitEvidence,
        evidenceCheckedAt: row.evidence_checked_at ?? null,
        completionNote: row.completion_note ?? null,
    };
}
export function findWorkItemIdByReference(projectId, type, key) {
    const row = db.prepare(`
    SELECT wi.id FROM work_items wi
    JOIN work_item_references r ON r.work_item_id = wi.id
    WHERE wi.project_id = ? AND r.reference_type = ? AND r.reference_key = ?
    LIMIT 1
  `).get(projectId, type, key);
    return row?.id ?? null;
}
/** Traces in a project that no work item has claimed and nobody has dismissed. */
export function getUncategorizedTraces(projectId, limit = 100) {
    const rows = db.prepare(`
    SELECT t.id, t.session_id, t.date_time, t.prompt, t.tokens_total, t.ai_credits,
           t.duration_ms, t.status
    FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM work_item_traces wit WHERE wit.trace_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM work_item_dismissed_traces d WHERE d.trace_id = t.id)
    ORDER BY t.date_time DESC
    LIMIT ?
  `).all(projectId, limit);
    return rows.map((t) => ({
        id: t.id,
        sessionId: t.session_id,
        dateTime: t.date_time,
        prompt: t.prompt,
        tokens: t.tokens_total ?? 0,
        credits: t.ai_credits ?? 0,
        durationMs: t.duration_ms ?? 0,
        status: t.status,
        linkSource: 'detected',
    }));
}
// ── Inbox dismissal ───────────────────────────────────────────────────────────
/**
 * Take a prompt out of the uncategorized inbox without touching the trace.
 * Returns false when the trace does not belong to the project, so a stale page
 * cannot dismiss someone else's prompt.
 */
export function dismissTrace(projectId, traceId, reason = 'ignored') {
    const owns = db.prepare(`
    SELECT 1 FROM traces t JOIN sessions s ON s.id = t.session_id
    WHERE t.id = ? AND s.project_id = ?
  `).get(traceId, projectId);
    if (!owns)
        return false;
    db.prepare(`
    INSERT INTO work_item_dismissed_traces (trace_id, project_id, reason, dismissed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(trace_id) DO UPDATE SET reason = excluded.reason, dismissed_at = excluded.dismissed_at
  `).run(traceId, projectId, reason, new Date().toISOString());
    return true;
}
/** Put a dismissed prompt back in the inbox. */
export function restoreDismissedTrace(projectId, traceId) {
    return db.prepare('DELETE FROM work_item_dismissed_traces WHERE trace_id = ? AND project_id = ?')
        .run(traceId, projectId).changes > 0;
}
export function getDismissedTraces(projectId, limit = 100) {
    const rows = db.prepare(`
    SELECT t.id, t.session_id, t.date_time, t.prompt, t.tokens_total, t.ai_credits,
           t.duration_ms, t.status, d.reason, d.dismissed_at
    FROM work_item_dismissed_traces d
    JOIN traces t ON t.id = d.trace_id
    WHERE d.project_id = ?
    ORDER BY d.dismissed_at DESC
    LIMIT ?
  `).all(projectId, limit);
    return rows.map((t) => ({
        id: t.id,
        sessionId: t.session_id,
        dateTime: t.date_time,
        prompt: t.prompt,
        tokens: t.tokens_total ?? 0,
        credits: t.ai_credits ?? 0,
        durationMs: t.duration_ms ?? 0,
        status: t.status,
        linkSource: 'manual',
        reason: t.reason,
        dismissedAt: t.dismissed_at,
    }));
}
// ── Writes ────────────────────────────────────────────────────────────────────
export function saveTicketReference(input) {
    db.prepare(`
    INSERT INTO work_item_references (work_item_id, reference_type, reference_key, url, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id, reference_type, reference_key)
      DO UPDATE SET url = COALESCE(excluded.url, work_item_references.url)
  `).run(input.workItemId, input.type, input.key, input.url ?? null, new Date().toISOString());
}
export function createWorkItem(input) {
    const id = `work-item:${randomUUID()}`;
    const now = new Date().toISOString();
    const run = db.transaction(() => {
        db.prepare(`
      INSERT INTO work_items (
        id, project_id, title, summary, kind, status, source, summary_source,
        confidence, extractor_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.projectId, input.title, input.summary ?? null, input.kind ?? 'unknown', input.status ?? 'active', input.source ?? 'manual', input.summarySource ?? 'generated', input.confidence ?? 0, input.extractorVersion ?? null, now, now);
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
    return getWorkItem(id);
}
export class CompletionNotConfirmedError extends Error {
    constructor() {
        super('Marking a work item completed needs explicit confirmation. Send confirmCompletion: true.');
        this.name = 'CompletionNotConfirmedError';
    }
}
export function updateWorkItem(id, input) {
    const existing = db.prepare('SELECT id, status FROM work_items WHERE id = ?').get(id);
    if (!existing)
        return null;
    // Git evidence and prompt counts can suggest an item is finished, but only a
    // person decides that, so the move to completed needs an explicit confirmation.
    if (input.status === 'completed' && existing.status !== 'completed' && input.confirmCompletion !== true) {
        throw new CompletionNotConfirmedError();
    }
    const sets = [];
    const params = [];
    if (input.title !== undefined) {
        sets.push('title = ?');
        params.push(input.title);
    }
    if (input.kind !== undefined) {
        sets.push('kind = ?');
        params.push(input.kind);
    }
    if (input.status !== undefined) {
        sets.push('status = ?');
        params.push(input.status);
    }
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
    return getWorkItem(id);
}
export function deleteWorkItem(id) {
    const run = db.transaction(() => {
        db.prepare('DELETE FROM work_item_traces WHERE work_item_id = ?').run(id);
        db.prepare('DELETE FROM work_item_references WHERE work_item_id = ?').run(id);
        return db.prepare('DELETE FROM work_items WHERE id = ?').run(id).changes > 0;
    });
    return run();
}
// ── Merge and split ───────────────────────────────────────────────────────────
export class WorkItemMergeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WorkItemMergeError';
    }
}
export class WorkItemSplitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WorkItemSplitError';
    }
}
/**
 * Fold `sourceIds` into `targetId`: every trace link, ticket reference and
 * acceptance criterion moves across, then the sources are removed. Raw traces
 * are untouched, so a bad merge costs nothing but a re-split.
 */
export function mergeWorkItems(targetId, sourceIds) {
    const sources = [...new Set(sourceIds)].filter((sourceId) => sourceId !== targetId);
    if (!sources.length)
        throw new WorkItemMergeError('Pick at least one other work item to merge in.');
    const run = db.transaction(() => {
        const target = db.prepare('SELECT id, project_id, summary, acceptance_criteria FROM work_items WHERE id = ?')
            .get(targetId);
        if (!target)
            throw new WorkItemMergeError('Target work item not found.');
        const criteria = parseCriteria(target.acceptance_criteria);
        const seenCriteria = new Set(criteria.map((c) => c.trim().toLowerCase()));
        let summary = target.summary;
        for (const sourceId of sources) {
            const source = db.prepare('SELECT id, project_id, summary, acceptance_criteria FROM work_items WHERE id = ?')
                .get(sourceId);
            if (!source)
                throw new WorkItemMergeError(`Work item ${sourceId} not found.`);
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
        INSERT INTO work_item_references (work_item_id, reference_type, reference_key, url, created_at)
        SELECT ?, reference_type, reference_key, url, created_at
        FROM work_item_references WHERE work_item_id = ?
        ON CONFLICT(work_item_id, reference_type, reference_key)
          DO UPDATE SET url = COALESCE(excluded.url, work_item_references.url)
      `).run(targetId, sourceId);
            if (!summary?.trim() && source.summary?.trim())
                summary = source.summary;
            for (const criterion of parseCriteria(source.acceptance_criteria)) {
                const key = criterion.trim().toLowerCase();
                if (!key || seenCriteria.has(key))
                    continue;
                seenCriteria.add(key);
                criteria.push(criterion);
            }
            db.prepare('DELETE FROM work_item_traces WHERE work_item_id = ?').run(sourceId);
            db.prepare('DELETE FROM work_item_references WHERE work_item_id = ?').run(sourceId);
            db.prepare('DELETE FROM work_items WHERE id = ?').run(sourceId);
        }
        db.prepare('UPDATE work_items SET summary = ?, acceptance_criteria = ?, updated_at = ? WHERE id = ?')
            .run(summary, JSON.stringify(criteria), new Date().toISOString(), targetId);
    });
    run();
    return getWorkItem(targetId);
}
/**
 * Move `traceIds` out of `id` into a brand new work item. At least one trace
 * must stay behind, otherwise this is a rename and should go through PATCH.
 */
export function splitWorkItem(id, input) {
    const title = input.title?.trim();
    if (!title)
        throw new WorkItemSplitError('The new work item needs a title.');
    const traceIds = [...new Set(input.traceIds ?? [])];
    if (!traceIds.length)
        throw new WorkItemSplitError('Pick at least one prompt to split out.');
    const createdId = `work-item:${randomUUID()}`;
    const run = db.transaction(() => {
        const source = db.prepare('SELECT id, project_id, kind FROM work_items WHERE id = ?').get(id);
        if (!source)
            throw new WorkItemSplitError('Work item not found.');
        const linked = db.prepare('SELECT trace_id FROM work_item_traces WHERE work_item_id = ?')
            .all(id);
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
        for (const traceId of traceIds)
            move.run(createdId, id, traceId);
        db.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, id);
    });
    run();
    return {
        source: getWorkItem(id),
        created: getWorkItem(createdId),
    };
}
export class WorkItemProjectMismatchError extends Error {
    constructor() {
        super('That prompt belongs to a different project.');
        this.name = 'WorkItemProjectMismatchError';
    }
}
/** True when a prompt was explicitly taken out of the inbox and not since restored. */
function isTraceDismissed(traceId) {
    return !!db.prepare('SELECT 1 FROM work_item_dismissed_traces WHERE trace_id = ?').get(traceId);
}
export function linkTraceToWorkItem(input) {
    // A work item aggregates tokens and credits for one project, so a trace from
    // another project would silently inflate the wrong totals.
    const scope = db.prepare(`
    SELECT wi.project_id AS item_project, s.project_id AS trace_project
    FROM work_items wi, traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE wi.id = ? AND t.id = ?
  `).get(input.workItemId, input.traceId);
    if (scope && scope.trace_project !== scope.item_project) {
        throw new WorkItemProjectMismatchError();
    }
    db.prepare(`
    INSERT INTO work_item_traces (work_item_id, trace_id, linked_at, link_source, confidence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id, trace_id) DO NOTHING
  `).run(input.workItemId, input.traceId, new Date().toISOString(), input.linkSource ?? 'detected', input.confidence ?? 0);
    // Only a deliberate attach overrides a dismissal. If automatic extraction
    // cleared it too, re-running backfill would quietly resurrect every prompt
    // the user had already waved away.
    if ((input.linkSource ?? 'detected') === 'manual') {
        db.prepare('DELETE FROM work_item_dismissed_traces WHERE trace_id = ?').run(input.traceId);
    }
}
export function unlinkTraceFromWorkItem(workItemId, traceId) {
    return db.prepare('DELETE FROM work_item_traces WHERE work_item_id = ? AND trace_id = ?')
        .run(workItemId, traceId).changes > 0;
}
// ── Extraction pipeline ───────────────────────────────────────────────────────
export function persistWorkItemEvidence(trace, projectId) {
    const empty = { status: 'uncategorized', workItemIds: [] };
    if (!projectId || !trace?.id)
        return empty;
    const evidence = extractWorkItemEvidence(trace.prompt ?? '');
    const strong = evidence.references.filter((ref) => ref.confidence >= AUTO_LINK_CONFIDENCE);
    if (!strong.length)
        return empty;
    // A dismissed prompt stays dismissed. Without this, "Group past traces"
    // would re-link everything the user had explicitly waved away.
    if (isTraceDismissed(trace.id))
        return { status: 'dismissed', workItemIds: [] };
    const run = db.transaction(() => {
        const ids = [];
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
                    references: [{ type: reference.type, key: reference.key, url: reference.url }],
                }).id;
            }
            else {
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
export function backfillWorkItems(projectId, limit = 5000) {
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
      `).all(limit));
    let linked = 0;
    for (const row of rows) {
        if (!row.prompt?.trim())
            continue;
        const trace = { id: row.id, sessionId: row.session_id, prompt: row.prompt };
        if (persistWorkItemEvidence(trace, row.project_id).status === 'linked')
            linked += 1;
    }
    return { scanned: rows.length, linked };
}
// ── Draft generation ──────────────────────────────────────────────────────────
/** Build a draft from a work item's linked prompts without saving it. */
export function buildWorkItemDraft(workItemId) {
    const item = db.prepare('SELECT id FROM work_items WHERE id = ?').get(workItemId);
    if (!item)
        return null;
    const rows = db.prepare(`
    SELECT t.prompt, t.date_time
    FROM work_item_traces wit
    JOIN traces t ON t.id = wit.trace_id
    WHERE wit.work_item_id = ?
    ORDER BY t.date_time ASC
  `).all(workItemId);
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
export function applyWorkItemDraft(workItemId, options = {}) {
    const draft = buildWorkItemDraft(workItemId);
    if (!draft)
        return null;
    const current = db.prepare('SELECT summary, summary_source, acceptance_criteria, criteria_source, kind FROM work_items WHERE id = ?').get(workItemId);
    const sets = ['draft_generator_version = ?'];
    const params = [draft.generatorVersion];
    const applied = [];
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
    return { item: getWorkItem(workItemId), draft, applied };
}
// ── Git evidence ──────────────────────────────────────────────────────────────
/**
 * Collect git evidence for one work item and store it.
 *
 * Evidence is informational. It never changes status on its own: a commit
 * mentioning ABC-123 proves work happened, not that the work is done.
 */
export function refreshWorkItemEvidence(workItemId) {
    const row = db.prepare('SELECT project_id FROM work_items WHERE id = ?').get(workItemId);
    if (!row)
        return null;
    const project = db.prepare('SELECT path, local_path FROM projects WHERE id = ?').get(row.project_id);
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
const processedPrompts = new Map();
function alreadyProcessed(traceId, prompt) {
    if (processedPrompts.get(traceId) === prompt)
        return true;
    processedPrompts.set(traceId, prompt);
    if (processedPrompts.size > PROCESSED_LIMIT) {
        const oldest = processedPrompts.keys().next().value;
        if (oldest)
            processedPrompts.delete(oldest);
    }
    return false;
}
/**
 * Wire work-item extraction into trace persistence. Registering one listener
 * covers every ingestion path instead of patching each upsertTrace call site.
 */
export function installWorkItemExtraction() {
    setTracePersistedListener((entry) => {
        const prompt = entry.prompt ?? '';
        if (!prompt.trim())
            return;
        if (alreadyProcessed(entry.id, prompt))
            return;
        const projectId = getSessionProjectId(entry.sessionId);
        if (!projectId)
            return;
        persistWorkItemEvidence(entry, projectId);
    });
}
