import { randomUUID } from 'crypto';
import { db, getSessionProjectId, setTracePersistedListener } from './db.js';
import { AUTO_LINK_CONFIDENCE, deriveWorkItemSummary, extractWorkItemEvidence, } from './workItemExtraction.js';
const AGGREGATE_SELECT = `
  SELECT
    wi.id, wi.project_id, wi.title, wi.summary, wi.kind, wi.status, wi.source,
    wi.summary_source, wi.confidence, wi.extractor_version, wi.created_at, wi.updated_at,
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
    return { ...toWorkItem(row, references), traces };
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
/** Traces in a project that no work item has claimed yet. Powers the inbox. */
export function getUncategorizedTraces(projectId, limit = 100) {
    const rows = db.prepare(`
    SELECT t.id, t.session_id, t.date_time, t.prompt, t.tokens_total, t.ai_credits,
           t.duration_ms, t.status
    FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM work_item_traces wit WHERE wit.trace_id = t.id)
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
export function updateWorkItem(id, input) {
    const existing = db.prepare('SELECT id FROM work_items WHERE id = ?').get(id);
    if (!existing)
        return null;
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
    if (input.summary !== undefined) {
        sets.push('summary = ?', "summary_source = 'user'");
        params.push(input.summary);
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
export function linkTraceToWorkItem(input) {
    db.prepare(`
    INSERT INTO work_item_traces (work_item_id, trace_id, linked_at, link_source, confidence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id, trace_id) DO NOTHING
  `).run(input.workItemId, input.traceId, new Date().toISOString(), input.linkSource ?? 'detected', input.confidence ?? 0);
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
