import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getTraces, getTrace, getSessionSummary, getDashboard, updateProjectLocalPath, getProjectTraces, getProjectSessionSummary, projectExists } from './db.js';
import { applyWorkItemDraft, CompletionNotConfirmedError, dismissTrace, getDismissedTraces, mergeWorkItems, refreshWorkItemEvidence, restoreDismissedTrace, splitWorkItem, WorkItemMergeError, WorkItemSplitError, backfillWorkItems, buildWorkItemDraft, createWorkItem, deleteWorkItem, getUncategorizedTraces, getWorkItem, getWorkItems, installWorkItemExtraction, linkTraceToWorkItem, unlinkTraceFromWorkItem, updateWorkItem, } from './workItemService.js';
import { isWorkItemKind } from './workItemExtraction.js';
import { WORK_ITEM_DISMISS_REASONS, WORK_ITEM_STATUSES } from './types.js';
import { traceEvents } from './proxy.js';
import { registerOtlpRoutes } from './otlpReceiver.js';
import { registerClaudeHookRoutes } from './claudeHooks.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function startWebServer(port = 4747, sessionId, projectId) {
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer, { cors: { origin: '*' } });
    // Group captured traces into work items as they are persisted.
    installWorkItemExtraction();
    // Serve static web UI
    app.use(express.static(path.join(__dirname, '../web')));
    // Register OTLP receiver routes
    app.use(express.json({ limit: '10mb' }));
    registerOtlpRoutes(app, sessionId ?? 'default', projectId);
    // Register Claude Code hook receiver (turn/tool lifecycle; OTLP supplies token usage)
    registerClaudeHookRoutes(app);
    // API
    app.get('/api/traces', (req, res) => {
        const sid = req.query.sessionId || undefined; // undefined = all sessions
        const traces = getTraces(sid, 200);
        res.json(traces);
    });
    app.post('/api/refine', async (req, res) => {
        const { prompt } = req.body;
        if (!prompt?.trim()) {
            res.status(400).json({ error: 'prompt required' });
            return;
        }
        const origTok = Math.ceil(prompt.trim().length / 4);
        // Meta-prompt grounded in prompt engineering best practices (promptingguide.ai)
        const metaPrompt = `You are a world-class prompt engineering expert. Rewrite the user prompt below using these techniques where applicable:
1. Role grounding — prepend "You are a <expert role>" if no persona is set
2. Imperative clarity — replace indirect/hedging phrases with direct imperatives (Explain / List / Generate / Analyze)
3. Output format — specify format (JSON, markdown, numbered steps, bullet list) when missing
4. Chain-of-thought — add "Think step by step." for multi-step reasoning or debugging tasks
5. Remove noise — remove filler (please, could you, I want you to, thank you, if you don't mind, maybe, I think, kind of, sort of)
6. Add constraints — specify language, length, audience, tone if not present
7. Redundancy — collapse repeated or contradictory instructions

Respond ONLY with a valid JSON object (no markdown, no code fences):
{"optimized":"<rewritten prompt>","issues":[{"type":"warn","msg":"<what was wrong>"}],"techniques":["<applied>"]}

Prompt to optimize:
${prompt.trim()}`;
        try {
            const raw = execSync(`copilot -p ${JSON.stringify(metaPrompt)} --model claude-sonnet-4.6`, { timeout: 45000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
            // Strip copilot CLI chrome (trailing "Changes  +0 -0" line, ANSI codes)
            const cleaned = raw
                .replace(/\x1b\[[0-9;]*m/g, '') // ANSI
                .replace(/\r/g, '')
                .split('\n')
                .filter(l => !/^Changes\s+\+\d/.test(l.trim()))
                .join('\n')
                .trim();
            // Extract JSON — copilot may wrap with prose
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                throw new Error('No JSON in response: ' + cleaned.slice(0, 200));
            const result = JSON.parse(jsonMatch[0]);
            const newTok = Math.ceil((result.optimized ?? '').length / 4);
            const inputSavingPct = origTok > 0 ? Math.max(0, Math.round((1 - newTok / origTok) * 100)) : 0;
            res.json({ ok: true, ...result, origTok, newTok, inputSavingPct });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ ok: false, error: msg });
        }
    });
    app.get('/api/traces/:id', (req, res) => {
        const trace = getTrace(req.params.id);
        if (!trace)
            return res.status(404).json({ error: 'Not found' });
        res.json(trace);
    });
    app.get('/api/summary', (req, res) => {
        const sid = req.query.sessionId || sessionId;
        if (!sid)
            return res.json(null);
        res.json(getSessionSummary(sid));
    });
    app.get('/api/dashboard', (req, res) => {
        const pageParam = req.query.page;
        const pageSizeParam = req.query.pageSize;
        const page = pageParam === undefined ? 1 : Number(pageParam);
        const pageSize = pageSizeParam === undefined ? 12 : Number(pageSizeParam);
        if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
            res.status(400).json({ error: 'page must be a positive integer and pageSize must be an integer between 1 and 100' });
            return;
        }
        res.json(getDashboard(page, pageSize));
    });
    // Project registration — CLI registers its local path for a project
    app.post('/api/projects', (req, res) => {
        const { projectId, localPath } = req.body;
        if (!projectId || !localPath) {
            res.status(400).json({ error: 'projectId and localPath required' });
            return;
        }
        updateProjectLocalPath(projectId, localPath);
        res.json({ ok: true });
    });
    // Project-scoped traces
    app.get('/api/projects/:id/traces', (req, res) => {
        const traces = getProjectTraces(req.params.id, 200);
        res.json(traces);
    });
    // Project-scoped summary
    app.get('/api/projects/:id/summary', (req, res) => {
        res.json(getProjectSessionSummary(req.params.id));
    });
    // ── Work items ──────────────────────────────────────────────────────────────
    const isStatus = (value) => typeof value === 'string' && WORK_ITEM_STATUSES.includes(value);
    app.get('/api/projects/:id/work-items', (req, res) => {
        if (!projectExists(req.params.id)) {
            res.status(404).json({ error: 'project not found' });
            return;
        }
        const status = req.query.status;
        if (status !== undefined && !isStatus(status)) {
            res.status(400).json({ error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` });
            return;
        }
        res.json(getWorkItems(req.params.id, status));
    });
    app.get('/api/projects/:id/uncategorized-traces', (req, res) => {
        if (!projectExists(req.params.id)) {
            res.status(404).json({ error: 'project not found' });
            return;
        }
        const limitParam = req.query.limit;
        const limit = limitParam === undefined ? 100 : Number(limitParam);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
            return;
        }
        res.json(getUncategorizedTraces(req.params.id, limit));
    });
    // Inbox triage. Dismissing hides a prompt from the inbox; the trace is kept.
    app.post('/api/projects/:id/uncategorized-traces/:traceId/dismiss', (req, res) => {
        if (!projectExists(req.params.id)) {
            res.status(404).json({ error: 'project not found' });
            return;
        }
        const { reason } = req.body;
        if (reason !== undefined
            && !WORK_ITEM_DISMISS_REASONS.includes(reason)) {
            res.status(400).json({ error: `reason must be one of ${WORK_ITEM_DISMISS_REASONS.join(', ')}` });
            return;
        }
        const ok = dismissTrace(req.params.id, req.params.traceId, reason ?? 'ignored');
        if (!ok) {
            res.status(404).json({ error: 'trace not found in this project' });
            return;
        }
        res.json({ traceId: req.params.traceId, reason: reason ?? 'ignored' });
    });
    app.get('/api/projects/:id/dismissed-traces', (req, res) => {
        if (!projectExists(req.params.id)) {
            res.status(404).json({ error: 'project not found' });
            return;
        }
        res.json(getDismissedTraces(req.params.id));
    });
    app.delete('/api/projects/:id/dismissed-traces/:traceId', (req, res) => {
        if (!restoreDismissedTrace(req.params.id, req.params.traceId)) {
            res.status(404).json({ error: 'dismissed trace not found' });
            return;
        }
        res.status(204).end();
    });
    app.post('/api/projects/:id/work-items/backfill', (req, res) => {
        if (!projectExists(req.params.id)) {
            res.status(404).json({ error: 'project not found' });
            return;
        }
        res.json(backfillWorkItems(req.params.id));
    });
    app.get('/api/work-items/:id', (req, res) => {
        const item = getWorkItem(req.params.id);
        if (!item) {
            res.status(404).json({ error: 'work item not found' });
            return;
        }
        res.json(item);
    });
    app.post('/api/work-items', (req, res) => {
        const { projectId, title, summary, kind, status } = req.body;
        if (!projectId || typeof projectId !== 'string') {
            res.status(400).json({ error: 'projectId is required' });
            return;
        }
        if (!title || typeof title !== 'string' || !title.trim()) {
            res.status(400).json({ error: 'title is required' });
            return;
        }
        if (!projectExists(projectId)) {
            res.status(404).json({ error: 'project not found' });
            return;
        }
        if (kind !== undefined && !isWorkItemKind(kind)) {
            res.status(400).json({ error: 'kind is not a known work item kind' });
            return;
        }
        if (status !== undefined && !isStatus(status)) {
            res.status(400).json({ error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` });
            return;
        }
        res.status(201).json(createWorkItem({
            projectId,
            title: title.trim(),
            summary: typeof summary === 'string' ? summary : null,
            kind: kind,
            status,
            source: 'manual',
            summarySource: 'user',
        }));
    });
    app.patch('/api/work-items/:id', (req, res) => {
        const { title, summary, kind, status, acceptanceCriteria, confirmCompletion, completionNote } = req.body;
        if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
            res.status(400).json({ error: 'title must be a non-empty string' });
            return;
        }
        if (summary !== undefined && summary !== null && typeof summary !== 'string') {
            res.status(400).json({ error: 'summary must be a string or null' });
            return;
        }
        if (kind !== undefined && !isWorkItemKind(kind)) {
            res.status(400).json({ error: 'kind is not a known work item kind' });
            return;
        }
        if (status !== undefined && !isStatus(status)) {
            res.status(400).json({ error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` });
            return;
        }
        if (acceptanceCriteria !== undefined
            && (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.some((c) => typeof c !== 'string'))) {
            res.status(400).json({ error: 'acceptanceCriteria must be an array of strings' });
            return;
        }
        if (completionNote !== undefined && completionNote !== null && typeof completionNote !== 'string') {
            res.status(400).json({ error: 'completionNote must be a string or null' });
            return;
        }
        let updated;
        try {
            updated = updateWorkItem(req.params.id, {
                title: title,
                summary: summary,
                kind: kind,
                status: status,
                acceptanceCriteria: acceptanceCriteria,
                confirmCompletion: confirmCompletion === true,
                completionNote: completionNote,
            });
        }
        catch (error) {
            if (error instanceof CompletionNotConfirmedError) {
                res.status(409).json({ error: error.message, needsConfirmation: true });
                return;
            }
            throw error;
        }
        if (!updated) {
            res.status(404).json({ error: 'work item not found' });
            return;
        }
        res.json(updated);
    });
    // Fold other work items into this one. Raw traces are never deleted.
    app.post('/api/work-items/:id/merge', (req, res) => {
        const { sourceIds } = req.body;
        if (!Array.isArray(sourceIds) || sourceIds.some((v) => typeof v !== 'string')) {
            res.status(400).json({ error: 'sourceIds must be an array of work item ids' });
            return;
        }
        try {
            res.json(mergeWorkItems(req.params.id, sourceIds));
        }
        catch (error) {
            if (error instanceof WorkItemMergeError) {
                res.status(400).json({ error: error.message });
                return;
            }
            throw error;
        }
    });
    // Move some prompts out into a new work item.
    app.post('/api/work-items/:id/split', (req, res) => {
        const { title, traceIds, kind } = req.body;
        if (typeof title !== 'string' || !title.trim()) {
            res.status(400).json({ error: 'title is required' });
            return;
        }
        if (!Array.isArray(traceIds) || traceIds.some((v) => typeof v !== 'string')) {
            res.status(400).json({ error: 'traceIds must be an array of trace ids' });
            return;
        }
        if (kind !== undefined && !isWorkItemKind(kind)) {
            res.status(400).json({ error: 'kind is not a known work item kind' });
            return;
        }
        try {
            res.status(201).json(splitWorkItem(req.params.id, {
                title: title.trim(),
                traceIds: traceIds,
                kind: kind,
            }));
        }
        catch (error) {
            if (error instanceof WorkItemSplitError) {
                res.status(400).json({ error: error.message });
                return;
            }
            throw error;
        }
    });
    // Re-read git for this work item. Read-only, and never changes status.
    app.post('/api/work-items/:id/refresh-evidence', (req, res) => {
        const updated = refreshWorkItemEvidence(req.params.id);
        if (!updated) {
            res.status(404).json({ error: 'work item not found' });
            return;
        }
        res.json(updated);
    });
    // Preview a draft without saving it.
    app.get('/api/work-items/:id/draft', (req, res) => {
        const draft = buildWorkItemDraft(req.params.id);
        if (!draft) {
            res.status(404).json({ error: 'work item not found' });
            return;
        }
        res.json(draft);
    });
    // Regenerate summary, criteria and kind from the linked prompts. Fields the
    // user edited are preserved unless overwrite is explicitly requested.
    app.post('/api/work-items/:id/draft', (req, res) => {
        const { overwriteUserEdits } = req.body;
        if (overwriteUserEdits !== undefined && typeof overwriteUserEdits !== 'boolean') {
            res.status(400).json({ error: 'overwriteUserEdits must be a boolean' });
            return;
        }
        const result = applyWorkItemDraft(req.params.id, { overwriteUserEdits: overwriteUserEdits === true });
        if (!result) {
            res.status(404).json({ error: 'work item not found' });
            return;
        }
        res.json({ workItem: result.item, draft: result.draft, applied: result.applied });
    });
    app.delete('/api/work-items/:id', (req, res) => {
        if (!deleteWorkItem(req.params.id)) {
            res.status(404).json({ error: 'work item not found' });
            return;
        }
        res.json({ ok: true });
    });
    app.post('/api/work-items/:id/traces', (req, res) => {
        const { traceId } = req.body;
        if (!traceId || typeof traceId !== 'string') {
            res.status(400).json({ error: 'traceId is required' });
            return;
        }
        if (!getWorkItem(req.params.id)) {
            res.status(404).json({ error: 'work item not found' });
            return;
        }
        if (!getTrace(traceId)) {
            res.status(404).json({ error: 'trace not found' });
            return;
        }
        linkTraceToWorkItem({ workItemId: req.params.id, traceId, linkSource: 'manual', confidence: 1 });
        res.json(getWorkItem(req.params.id));
    });
    app.delete('/api/work-items/:id/traces/:traceId', (req, res) => {
        if (!getWorkItem(req.params.id)) {
            res.status(404).json({ error: 'work item not found' });
            return;
        }
        if (!unlinkTraceFromWorkItem(req.params.id, req.params.traceId)) {
            res.status(404).json({ error: 'trace is not linked to this work item' });
            return;
        }
        res.json(getWorkItem(req.params.id));
    });
    // Socket.io — push real-time updates
    io.on('connection', (socket) => {
        const projectId = socket.handshake.query.projectId;
        // Send current state on connect
        if (projectId) {
            socket.emit('init', {
                traces: getProjectTraces(projectId, 200),
                summary: getProjectSessionSummary(projectId),
            });
        }
        else {
            const sid = sessionId;
            socket.emit('init', {
                traces: getTraces(sid, 200),
                summary: sid ? getSessionSummary(sid) : null,
            });
        }
        const onUpdate = (entry) => socket.emit('trace:update', entry);
        const onDone = (entry) => socket.emit('trace:done', entry);
        traceEvents.on('trace:update', onUpdate);
        traceEvents.on('trace:done', onDone);
        socket.on('disconnect', () => {
            traceEvents.off('trace:update', onUpdate);
            traceEvents.off('trace:done', onDone);
        });
    });
    httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\n  ❌ Port ${port} is already in use.`);
            console.error(`     A tracer may already be running — open http://localhost:${port}/`);
            console.error(`     Or kill it: lsof -ti:${port} | xargs kill\n`);
            process.exit(1);
        }
        throw err;
    });
    httpServer.listen(port, () => {
        console.log(`\n  🌐 Copilot Tracer Web UI: http://localhost:${port}/\n`);
    });
}
