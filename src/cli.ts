#!/usr/bin/env node
import { program } from 'commander';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { createSession, getTraces, getSessionSummary, ensureProject } from './db.js';
import { handleAcpMessage, traceEvents } from './proxy.js';
import { renderConsoleTable } from './consoleUi.js';
import { startWebServer } from './webServer.js';
import { runSetup } from './setup.js';
import open from 'open';
import os from 'os';

program
  .name('copilot-tracer')
  .description('Real-time monitor and tracer for GitHub Copilot CLI')
  .option('--ui <mode>', 'UI mode: console | web | both', 'both')
  .option('--port <port>', 'Web UI port', '4747')
  .option('--cmd <command>', 'Copilot CLI command to wrap', 'copilot')
  .option('--no-proxy', 'Run UI only (no ACP proxy, read from DB)')
  .option('--session <id>', 'Filter by session ID')
  .option('--debug', 'Dump ALL raw ACP messages to stderr (use to discover real method names)')
  .option('--setup', 'Auto-detect copilot CLI + VS Code and configure OTLP env vars')
  .option('--project-path <path>', 'Project source path (defaults to cwd)')
  .option('--daemon', 'Run as background daemon — collects all OTLP data, no ACP proxy')
  .allowUnknownOption()
  .parse();

const opts = program.opts();
const port = parseInt(opts.port);

// Handle --setup: patch env files, apply to current process, then fall through to start web UI
if (opts.setup) {
  runSetup(port, opts.daemon);

  if (opts.daemon) {
    // Relaunch as a detached background daemon so the terminal doesn't need to stay open.
    const dir = path.join(os.homedir(), '.copilot-tracer');
    fs.mkdirSync(dir, { recursive: true });
    const pidFile = path.join(dir, 'daemon.pid');

    const existingPid = fs.existsSync(pidFile) ? parseInt(fs.readFileSync(pidFile, 'utf8'), 10) : NaN;
    const alreadyRunning = !isNaN(existingPid) && (() => {
      try { process.kill(existingPid, 0); return true; } catch { return false; }
    })();

    if (alreadyRunning) {
      console.log(`\n  🤖 Daemon already running (pid ${existingPid})`);
      console.log(`  🌐 Dashboard: http://localhost:${port}/\n`);
    } else {
      const logFile = fs.openSync(path.join(dir, 'daemon.log'), 'a');
      const child = spawn(process.execPath, [process.argv[1], '--daemon', '--port', String(port)], {
        detached: true,
        stdio: ['ignore', logFile, logFile],
      });
      child.unref();
      fs.writeFileSync(pidFile, String(child.pid));
      console.log(`\n  🤖 Daemon started in background (pid ${child.pid})`);
      console.log(`  🌐 Dashboard: http://localhost:${port}/`);
      console.log(`  📄 Logs: ${path.join(dir, 'daemon.log')}`);
      console.log(`  Stop it with: kill ${child.pid}\n`);
    }
    process.exit(0);
  } else {
    opts.proxy  = false;
    opts.ui     = 'web';
  }
}

// ── Daemon mode: run as always-on OTLP receiver ───────────────────────────
if (opts.daemon) {
  console.log(`\n  🤖 Copilot Tracer — Daemon Mode`);
  console.log(`  📡 Listening for OTLP traces on port ${port}`);
  console.log(`  🌐 Dashboard: http://localhost:${port}/`);
  console.log(`  Press Ctrl+C to stop\n`);

  startWebServer(port);

  process.on('SIGINT', () => { process.exit(0); });
  process.on('SIGTERM', () => { process.exit(0); });
} else {
  // ── Normal mode: per-session with optional ACP proxy ─────────────────────
  const sessionId = opts.session || randomUUID();

  // Resolve project path and create project record
  const projectPath = opts.projectPath
    ? path.resolve(opts.projectPath)
    : process.cwd();
  const projectId = ensureProject(projectPath);

  createSession(sessionId, projectId);
  console.log(`\n  🤖 Copilot Tracer  |  Session: ${sessionId}`);
  console.log(`  📁 Project: ${projectPath}\n`);

  // Start Web UI
  if (opts.ui === 'web' || opts.ui === 'both') {
    startWebServer(port, sessionId, projectId);
    setTimeout(() => open(`http://localhost:${port}/`), 1500);
  }

  // Start Console UI refresh loop
  if (opts.ui === 'console' || opts.ui === 'both') {
    const refreshConsole = () => {
      const entries = getTraces(sessionId, 50);
      const summary = getSessionSummary(sessionId);
      renderConsoleTable(entries, summary ?? undefined);
    };
    traceEvents.on('trace:update', refreshConsole);
    traceEvents.on('trace:done', refreshConsole);
    refreshConsole();
  }

  // ACP Proxy — wrap copilot CLI
  if (opts.proxy !== false) {
    const copilotArgs = ['--acp', '--stdio', ...program.args];
    const child = spawn(opts.cmd, copilotArgs, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    if (!child.pid) {
      console.error(`\n  ❌ Failed to start: ${opts.cmd} ${copilotArgs.join(' ')}`);
      console.error('  Make sure GitHub Copilot CLI is installed: npm install -g @github/copilot-cli\n');
      process.exit(1);
    }

    const stdinRl = readline.createInterface({ input: process.stdin });
    const stdoutRl = readline.createInterface({ input: child.stdout! });
    const debug = opts.debug === true;
    const logFile = debug ? fs.createWriteStream(`/tmp/copilot-tracer-${sessionId.slice(0,8)}.ndjson`, { flags: 'a' }) : null;

    function debugLog(direction: string, raw: string, parsed?: unknown) {
      if (!debug) return;
      const entry = JSON.stringify({ ts: new Date().toISOString(), dir: direction, raw, parsed });
      process.stderr.write('[TRACER] ' + entry + '\n');
      logFile?.write(entry + '\n');
    }

    stdinRl.on('line', (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
        handleAcpMessage(sessionId, parsed as never, 'out');
      } catch (e) {
        if (debug) process.stderr.write(`[TRACER] stdin non-JSON: ${line}\n`);
      }
      debugLog('→ copilot', line, parsed);
      child.stdin!.write(line + '\n');
    });

    stdoutRl.on('line', (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
        handleAcpMessage(sessionId, parsed as never, 'in');
      } catch (e) {
        if (debug) process.stderr.write(`[TRACER] stdout non-JSON: ${line}\n`);
      }
      debugLog('← copilot', line, parsed);
      process.stdout.write(line + '\n');
    });

    child.on('exit', (code) => {
      console.log(`\n  Copilot CLI exited (code ${code})\n`);
      process.exit(code ?? 0);
    });

    process.on('SIGINT', () => { child.kill(); process.exit(0); });
  }
}
