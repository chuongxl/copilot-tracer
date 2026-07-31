#!/usr/bin/env node
import { program } from 'commander';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import readline from 'readline';
import fs from 'fs';
import { createSession, getTraces, getSessionSummary } from './db.js';
import { handleAcpMessage, traceEvents } from './proxy.js';
import { renderConsoleTable } from './consoleUi.js';
import { startWebServer } from './webServer.js';
import { runSetup } from './setup.js';
import open from 'open';
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
    .allowUnknownOption()
    .parse();
const opts = program.opts();
const port = parseInt(opts.port);
// Handle --setup: patch env files, apply to current process, then fall through to start web UI
if (opts.setup) {
    runSetup(port);
    // Force no-proxy web mode — user just needs to open the browser
    opts.proxy = false;
    opts.ui = 'web';
}
const sessionId = opts.session || randomUUID();
createSession(sessionId);
console.log(`\n  🤖 Copilot Tracer  |  Session: ${sessionId}\n`);
// Start Web UI
if (opts.ui === 'web' || opts.ui === 'both') {
    startWebServer(port, sessionId);
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
    // Parse newline-delimited JSON (NDJSON) from copilot
    const stdinRl = readline.createInterface({ input: process.stdin });
    const stdoutRl = readline.createInterface({ input: child.stdout });
    const debug = opts.debug === true;
    const logFile = debug ? fs.createWriteStream(`/tmp/copilot-tracer-${sessionId.slice(0, 8)}.ndjson`, { flags: 'a' }) : null;
    function debugLog(direction, raw, parsed) {
        if (!debug)
            return;
        const entry = JSON.stringify({ ts: new Date().toISOString(), dir: direction, raw, parsed });
        process.stderr.write('[TRACER] ' + entry + '\n');
        logFile?.write(entry + '\n');
    }
    // stdin → copilot (user → copilot = 'out' direction from user's perspective)
    stdinRl.on('line', (line) => {
        let parsed;
        try {
            parsed = JSON.parse(line);
            handleAcpMessage(sessionId, parsed, 'out'); // outbound = user sending to copilot
        }
        catch (e) {
            // Not JSON — plain text from terminal, not ACP
            if (debug)
                process.stderr.write(`[TRACER] stdin non-JSON: ${line}\n`);
        }
        debugLog('→ copilot', line, parsed);
        child.stdin.write(line + '\n');
    });
    // copilot → stdout (copilot → user = 'in' direction from user's perspective)
    stdoutRl.on('line', (line) => {
        let parsed;
        try {
            parsed = JSON.parse(line);
            handleAcpMessage(sessionId, parsed, 'in'); // inbound = copilot sending to user
        }
        catch (e) {
            if (debug)
                process.stderr.write(`[TRACER] stdout non-JSON: ${line}\n`);
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
