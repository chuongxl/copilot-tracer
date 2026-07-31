import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTraces, getTrace, getSessionSummary } from './db.js';
import { traceEvents } from './proxy.js';
import { registerOtlpRoutes } from './otlpReceiver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startWebServer(port = 4747, sessionId?: string): void {
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
    const sid = (req.query.sessionId as string) || undefined;  // undefined = all sessions
    const traces = getTraces(sid, 200);
    res.json(traces);
  });

  app.get('/api/traces/:id', (req, res) => {
    const trace = getTrace(req.params.id);
    if (!trace) return res.status(404).json({ error: 'Not found' });
    res.json(trace);
  });

  app.get('/api/summary', (req, res) => {
    const sid = (req.query.sessionId as string) || sessionId;
    if (!sid) return res.json(null);
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

    const onUpdate = (entry: unknown) => socket.emit('trace:update', entry);
    const onDone = (entry: unknown) => socket.emit('trace:done', entry);

    traceEvents.on('trace:update', onUpdate);
    traceEvents.on('trace:done', onDone);
    socket.on('disconnect', () => {
      traceEvents.off('trace:update', onUpdate);
      traceEvents.off('trace:done', onDone);
    });
  });

  httpServer.listen(port, () => {
    console.log(`\n  🌐 Copilot Tracer Web UI: http://localhost:${port}\n`);
  });
}
