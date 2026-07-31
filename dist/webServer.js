import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTraces, getTrace, getSessionSummary, getAllSessions, getMetrics } from './db.js';
import { traceEvents } from './proxy.js';
import { registerOtlpRoutes } from './otlpReceiver.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function startWebServer(port = 4747, sessionId) {
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer, { cors: { origin: '*' } });
    app.use(express.static(path.join(__dirname, '../web')));
    app.use(express.json({ limit: '10mb' }));
    registerOtlpRoutes(app, sessionId ?? 'default');
    // All traces (optionally filter by session)
    app.get('/api/traces', (req, res) => {
        const sid = req.query.sessionId || undefined;
        const limit = parseInt(req.query.limit) || 200;
        res.json(getTraces(sid, limit));
    });
    // Single trace detail
    app.get('/api/traces/:id', (req, res) => {
        const trace = getTrace(req.params.id);
        if (!trace) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.json(trace);
    });
    // All sessions list
    app.get('/api/sessions', (_req, res) => {
        res.json(getAllSessions());
    });
    // Summary for one session
    app.get('/api/summary', (req, res) => {
        const sid = req.query.sessionId || sessionId;
        if (!sid) {
            res.json(null);
            return;
        }
        res.json(getSessionSummary(sid));
    });
    // Aggregated metrics across all traces
    app.get('/api/metrics', (_req, res) => {
        res.json(getMetrics());
    });
    // Socket.io — real-time push
    io.on('connection', (socket) => {
        const sid = sessionId;
        socket.emit('init', {
            traces: getTraces(sid, 200),
            summary: sid ? getSessionSummary(sid) : null,
            sessions: getAllSessions(),
            metrics: getMetrics(),
        });
        const onUpdate = (entry) => {
            socket.emit('trace:update', entry);
            socket.emit('metrics:update', getMetrics());
        };
        const onDone = (entry) => {
            socket.emit('trace:done', entry);
            socket.emit('metrics:update', getMetrics());
        };
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
            console.error(`     Open http://localhost:${port}/`);
            console.error(`     Or kill it: lsof -ti:${port} | xargs kill\n`);
            process.exit(1);
        }
        throw err;
    });
    httpServer.listen(port, () => {
        console.log(`\n  🌐 Copilot Tracer Web UI: http://localhost:${port}/\n`);
    });
}
