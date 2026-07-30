#!/usr/bin/env node
import { program } from 'commander';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import readline from 'readline';
import { createSession, getTraces, getSessionSummary } from './db.js';
import { handleAcpMessage, traceEvents } from './proxy.js';
import { renderConsoleTable } from './consoleUi.js';
import { startWebServer } from './webServer.js';
import open from 'open';
program
    .name('copilot-tracer')
    .description('Real-time monitor and tracer for GitHub Copilot CLI')
    .option('--ui <mode>', 'UI mode: console | web | both', 'both')
    .option('--port <port>', 'Web UI port', '4747')
    .option('--cmd <command>', 'Copilot CLI command to wrap', 'copilot')
    .option('--no-proxy', 'Run UI only (no ACP proxy, read from DB)')
    .option('--session <id>', 'Filter by session ID')
    .allowUnknownOption()
    .parse();
const opts = program.opts();
const port = parseInt(opts.port);
const sessionId = opts.session || randomUUID();
createSession(sessionId);
console.log(`\n  🤖 Copilot Tracer  |  Session: ${sessionId}\n`);
// Start Web UI
if (opts.ui === 'web' || opts.ui === 'both') {
    startWebServer(port, sessionId);
    setTimeout(() => open(`http://localhost:${port}`), 1500);
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
    // stdin → copilot (user → model)
    stdinRl.on('line', (line) => {
        try {
            const msg = JSON.parse(line);
            handleAcpMessage(sessionId, msg, 'in');
        }
        catch { }
        child.stdin.write(line + '\n');
    });
    // copilot → stdout (model → user)
    stdoutRl.on('line', (line) => {
        try {
            const msg = JSON.parse(line);
            handleAcpMessage(sessionId, msg, 'out');
        }
        catch { }
        process.stdout.write(line + '\n');
    });
    child.on('exit', (code) => {
        console.log(`\n  Copilot CLI exited (code ${code})\n`);
        process.exit(code ?? 0);
    });
    process.on('SIGINT', () => { child.kill(); process.exit(0); });
}
