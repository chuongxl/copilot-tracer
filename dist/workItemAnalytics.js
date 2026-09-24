import { db } from './db.js';
import { WORK_ITEM_CLOSED_STATUSES } from './types.js';
/**
 * Per-item aggregates. The completion timestamp is a correlated subquery
 * rather than a join, so it cannot multiply the trace rows and inflate the
 * token and credit sums.
 */
const ITEM_SELECT = `
  SELECT
    wi.id, wi.title, wi.kind, wi.status,
    COUNT(t.id) AS prompt_count,
    COUNT(DISTINCT t.session_id) AS session_count,
    COALESCE(SUM(t.tokens_total), 0) AS tokens,
    COALESCE(SUM(t.ai_credits), 0) AS credits,
    COALESCE(SUM(t.duration_ms), 0) AS active_ms,
    MIN(t.date_time) AS first_prompt_at,
    MAX(t.date_time) AS last_prompt_at,
    (
      SELECT MIN(h.changed_at) FROM work_item_status_history h
      WHERE h.work_item_id = wi.id AND h.to_status = 'completed'
    ) AS completed_at
  FROM work_items wi
  LEFT JOIN work_item_traces wit ON wit.work_item_id = wi.id
  LEFT JOIN traces t ON t.id = wit.trace_id
`;
function msBetween(from, to) {
    if (!from || !to)
        return null;
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end))
        return null;
    const delta = end - start;
    // A completion recorded before the first prompt means the timestamps
    // disagree, most likely from a backfill. Reporting a negative duration would
    // be worse than reporting nothing.
    return delta >= 0 ? delta : null;
}
function toAnalytics(row) {
    return {
        id: row.id,
        title: row.title,
        kind: row.kind,
        status: row.status,
        promptCount: row.prompt_count ?? 0,
        sessionCount: row.session_count ?? 0,
        tokens: row.tokens ?? 0,
        credits: Number((row.credits ?? 0).toFixed(4)),
        activeMs: row.active_ms ?? 0,
        firstPromptAt: row.first_prompt_at,
        lastPromptAt: row.last_prompt_at,
        completedAt: row.completed_at,
        cycleTimeMs: msBetween(row.first_prompt_at, row.completed_at),
        elapsedMs: msBetween(row.first_prompt_at, row.last_prompt_at),
    };
}
/** Analytics for every work item in a project, or across all projects. */
export function getWorkItemAnalytics(projectId) {
    const rows = projectId
        ? db.prepare(`${ITEM_SELECT} WHERE wi.project_id = ? GROUP BY wi.id`).all(projectId)
        : db.prepare(`${ITEM_SELECT} GROUP BY wi.id`).all();
    return rows.map(toAnalytics);
}
function groupBy(items, pick) {
    const groups = new Map();
    for (const item of items) {
        const key = pick(item);
        groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()]
        .map(([key, members]) => ({
        key,
        itemCount: members.length,
        promptCount: members.reduce((sum, m) => sum + m.promptCount, 0),
        tokens: members.reduce((sum, m) => sum + m.tokens, 0),
        credits: Number(members.reduce((sum, m) => sum + m.credits, 0).toFixed(4)),
        avgCycleTimeMs: mean(members.map((m) => m.cycleTimeMs)),
    }))
        .sort((a, b) => b.credits - a.credits || b.tokens - a.tokens || b.itemCount - a.itemCount);
}
/** Mean over the values that exist. Null when none do. */
function mean(values) {
    const present = values.filter((v) => v !== null);
    if (!present.length)
        return null;
    return Math.round(present.reduce((sum, v) => sum + v, 0) / present.length);
}
function rate(part, whole) {
    if (whole <= 0)
        return 0;
    return Number((part / whole).toFixed(4));
}
/**
 * The success measures the design says to watch before adding more automation.
 * Each one is a ratio of recorded events, so a number moving means behaviour
 * changed rather than the definition changing.
 */
export function getSuccessMeasures(projectId) {
    const scope = projectId ? 'AND s.project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    const traceTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN EXISTS (
        SELECT 1 FROM work_item_traces wit WHERE wit.trace_id = t.id
      ) OR EXISTS (
        SELECT 1 FROM work_item_suggestions sg WHERE sg.trace_id = t.id
      ) THEN 1 ELSE 0 END), 0) AS with_candidate,
      COALESCE(SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM work_item_traces wit WHERE wit.trace_id = t.id
      ) AND NOT EXISTS (
        SELECT 1 FROM work_item_dismissed_traces d WHERE d.trace_id = t.id
      ) THEN 1 ELSE 0 END), 0) AS unlinked
    FROM traces t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.project_id IS NOT NULL ${scope}
  `).get(...args);
    // An auto-link the engineer left alone is an accepted one. Unlinking is the
    // only way to reject it, and that is counted as a correction below.
    const autoLinks = db.prepare(`
    SELECT COUNT(*) AS total FROM work_item_traces wit
    JOIN work_items wi ON wi.id = wit.work_item_id
    WHERE wit.link_source = 'detected' ${projectId ? 'AND wi.project_id = ?' : ''}
  `).get(...args);
    const corrections = db.prepare(`
    SELECT COUNT(*) AS total FROM work_item_corrections
    WHERE kind IN ('merge', 'split') ${projectId ? 'AND project_id = ?' : ''}
  `).get(...args);
    const unlinks = db.prepare(`
    SELECT COUNT(*) AS total FROM work_item_corrections
    WHERE kind = 'unlink' ${projectId ? 'AND project_id = ?' : ''}
  `).get(...args);
    const suggestions = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN state = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
      COALESCE(SUM(CASE WHEN state IN ('accepted', 'rejected') THEN 1 ELSE 0 END), 0) AS decided
    FROM work_item_suggestions
    WHERE 1 = 1 ${projectId ? 'AND project_id = ?' : ''}
  `).get(...args);
    const completion = db.prepare(`
    SELECT
      COUNT(*) AS completed,
      COALESCE(SUM(CASE
        WHEN (git_evidence IS NOT NULL AND git_evidence != '' AND git_evidence != '[]')
          OR (completion_note IS NOT NULL AND TRIM(completion_note) != '')
        THEN 1 ELSE 0 END), 0) AS with_evidence
    FROM work_items
    WHERE status = 'completed' ${projectId ? 'AND project_id = ?' : ''}
  `).get(...args);
    // The design's seventh measure: time from first prompt to recovered
    // work-item context. Grouping is what recovers the context, so this is the
    // gap between an item's earliest prompt and the moment the item existed.
    // Auto-detection makes it near zero; a late backfill makes it large.
    const recovery = db.prepare(`
    SELECT wi.created_at AS created_at, MIN(t.date_time) AS first_prompt
    FROM work_items wi
    JOIN work_item_traces wit ON wit.work_item_id = wi.id
    JOIN traces t ON t.id = wit.trace_id
    ${projectId ? 'WHERE wi.project_id = ?' : ''}
    GROUP BY wi.id
  `).all(...args);
    const recoveryTimes = [];
    for (const row of recovery) {
        const ms = msBetween(row.first_prompt, row.created_at);
        if (ms !== null)
            recoveryTimes.push(ms);
    }
    const autoAccepted = Math.max(0, autoLinks.total - unlinks.total);
    return {
        tracesWithCandidate: traceTotals.with_candidate,
        tracesTotal: traceTotals.total,
        candidateRate: rate(traceTotals.with_candidate, traceTotals.total),
        autoLinksAccepted: autoAccepted,
        autoLinksTotal: autoLinks.total,
        autoLinkAcceptanceRate: rate(autoAccepted, autoLinks.total),
        suggestionsAccepted: suggestions.accepted,
        suggestionsDecided: suggestions.decided,
        suggestionAcceptanceRate: rate(suggestions.accepted, suggestions.decided),
        unlinkedPrompts: traceTotals.unlinked,
        unlinkedRate: rate(traceTotals.unlinked, traceTotals.total),
        mergeSplitCorrections: corrections.total,
        itemsCompleted: completion.completed,
        itemsCompletedWithEvidence: completion.with_evidence,
        completionEvidenceRate: rate(completion.with_evidence, completion.completed),
        itemsWithRecoveryTime: recoveryTimes.length,
        avgContextRecoveryMs: mean(recoveryTimes),
    };
}
const TOP_N = 10;
export function getAnalyticsReport(projectId) {
    const items = getWorkItemAnalytics(projectId);
    const closed = new Set(WORK_ITEM_CLOSED_STATUSES);
    const completed = items.filter((item) => item.status === 'completed');
    const credits = Number(items.reduce((sum, item) => sum + item.credits, 0).toFixed(4));
    return {
        projectId: projectId ?? null,
        totals: {
            itemCount: items.length,
            activeCount: items.filter((item) => !closed.has(item.status)).length,
            completedCount: completed.length,
            promptCount: items.reduce((sum, item) => sum + item.promptCount, 0),
            tokens: items.reduce((sum, item) => sum + item.tokens, 0),
            credits,
            avgCycleTimeMs: mean(items.map((item) => item.cycleTimeMs)),
            avgCreditsPerItem: items.length ? Number((credits / items.length).toFixed(4)) : 0,
        },
        byKind: groupBy(items, (item) => item.kind),
        byStatus: groupBy(items, (item) => item.status),
        // Credits are zero for OTLP-sourced traces, where only token counts
        // arrive. Falling back to tokens keeps this ranking meaningful instead of
        // listing four identical zeroes in arbitrary order.
        topByCredits: [...items]
            .sort((a, b) => b.credits - a.credits || b.tokens - a.tokens)
            .slice(0, TOP_N),
        recentlyCompleted: completed
            .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
            .slice(0, TOP_N),
        measures: getSuccessMeasures(projectId),
    };
}
