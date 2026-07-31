import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getTraces, getTrace, getSessionSummary } from './db.js';
import { traceEvents } from './proxy.js';
import { registerOtlpRoutes } from './otlpReceiver.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function startWebServer(port = 4747, sessionId) {
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer, { cors: { origin: '*' } });
    // Serve static web UI
    app.use(express.static(path.join(__dirname, '../web')));
    // Register OTLP receiver routes
    app.use(express.json({ limit: '10mb' }));
    registerOtlpRoutes(app, sessionId ?? 'default');
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
    // Socket.io — push real-time updates
    io.on('connection', (socket) => {
        // Send current state on connect
        const sid = sessionId;
        socket.emit('init', {
            traces: getTraces(sid, 200),
            summary: sid ? getSessionSummary(sid) : null,
        });
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
