#!/usr/bin/env node
/**
 * Boot a daemon against a throwaway database and fill it with realistic work
 * item data, so a browser can be driven through the feature for screenshots.
 *
 * Run with: node scripts/demo-work-items.mjs [--port 4793]
 * Stays in the foreground. Ctrl-C stops the daemon and deletes the database.
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tracer-demo-'));

const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 4793;
const base = `http://127.0.0.1:${port}`;
const repoUrl = 'https://github.com/acme/checkout-service';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function attr(key, value) {
  return { key, value: { stringValue: String(value) } };
}

let spanSeq = 0;
function span(sessionId, prompt) {
  spanSeq += 1;
  const now = Date.now() - (40 - spanSeq) * 60_000;
  return {
    resourceSpans: [{
      resource: { attributes: [attr('github.copilot.session_id', sessionId)] },
      scopeSpans: [{
        spans: [{
          traceId: String(spanSeq).padStart(32, '0'),
          spanId: String(spanSeq).padStart(16, '0'),
          name: 'invoke_agent',
          startTimeUnixNano: String((now - 9_000) * 1e6),
          endTimeUnixNano: String(now * 1e6),
          attributes: [
            attr('github.copilot.git.repository', repoUrl),
            attr('gen_ai.request.model', 'claude-sonnet-4'),
            attr('gen_ai.usage.input_tokens', 1800 + spanSeq * 140),
            attr('gen_ai.usage.output_tokens', 620 + spanSeq * 55),
          ],
          events: [{ name: 'gen_ai.content.prompt', attributes: [attr('gen_ai.prompt', prompt)] }],
        }],
      }],
    }],
  };
}

const PROMPTS = [
  ['session-checkout-1', 'Implement PAY-412: the checkout page must show the saved card list before the total.\n\nAcceptance criteria:\n- Saved cards load before the order total renders\n- An expired card is shown greyed out and cannot be selected\n- The list falls back to the add-card form when the customer has none'],
  ['session-checkout-1', 'PAY-412 follow-up: the expired card should still be visible, just not selectable.'],
  ['session-checkout-1', 'For PAY-412 add a loading skeleton so the total does not jump when cards arrive.'],

  ['session-checkout-2', 'Fix PAY-398, the tax line is wrong for orders shipping to Quebec. It must apply both GST and QST.'],
  ['session-checkout-2', 'PAY-398 again: rounding should happen once at the end, not per tax line.'],

  ['session-checkout-3', 'Look at https://github.com/acme/checkout-service/issues/214 — refunds over 90 days old crash the worker.'],

  ['session-checkout-4', 'Review https://github.com/acme/checkout-service/pull/221 before I merge it.'],

  ['session-checkout-5', 'Explain how the order state machine decides when a payment is captured.'],
  ['session-checkout-5', 'Now show me where retries are handled.'],
  ['session-checkout-6', 'Why is the staging deploy taking eleven minutes?'],
];

// A second project that does have a checkout on this machine, so the git
// evidence path can be exercised as well as the "no checkout" error path.
const localRepo = path.join(tempHome, 'billing-service');

function seedLocalRepo() {
  fs.mkdirSync(localRepo, { recursive: true });
  const run = (cmd) => execSync(cmd, { cwd: localRepo, stdio: 'ignore' });
  run('git init -q -b main');
  run('git config user.email demo@example.com');
  run('git config user.name "Demo Engineer"');
  run('git remote add origin https://github.com/acme/billing-service.git');

  fs.writeFileSync(path.join(localRepo, 'README.md'), '# billing-service\n');
  run('git add -A');
  run('git commit -q -m "BIL-88 add the invoice retry worker"');

  fs.writeFileSync(path.join(localRepo, 'retry.js'), 'export const retries = 3;\n');
  run('git add -A');
  run('git commit -q -m "BIL-88 cap retries at three attempts"');

  fs.writeFileSync(path.join(localRepo, 'notes.md'), 'unrelated\n');
  run('git add -A');
  run('git commit -q -m "tidy up the notes file"');

  run('git checkout -q -b feature/BIL-88-invoice-retries');
}

let child = null;

function cleanup() {
  if (child && child.pid) {
    try { process.kill(child.pid); } catch { /* already gone */ }
    child = null;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

async function main() {
  seedLocalRepo();

  // Register the local project before the daemon opens the database.
  process.env.COPILOT_TRACER_HOME = tempHome;
  const db = await import(path.join(root, 'dist/db.js'));
  const localProjectId = db.ensureProject(localRepo, 'https://github.com/acme/billing-service');
  db.createSession('session-billing-1', localProjectId);
  db.upsertTrace({
    id: 'trace-billing-1',
    sessionId: 'session-billing-1',
    dateTime: new Date(Date.now() - 30 * 60_000).toISOString(),
    prompt: 'BIL-88: the invoice retry worker must stop after three attempts and record the failure.',
    tokens: { input: 2100, output: 740, cached: 0, reasoning: 0, written: 0, total: 2840 },
    aiCredits: 0,
    durationMs: 8200,
    toolCalls: [],
    skillCount: 0,
    agentCount: 0,
    mcpCount: 0,
    status: 'done',
  });
  const service = await import(path.join(root, 'dist/workItemService.js'));
  service.persistWorkItemEvidence(
    { id: 'trace-billing-1', prompt: 'BIL-88: the invoice retry worker must stop after three attempts and record the failure.' },
    localProjectId,
  );

  child = spawn(process.execPath, [path.join(root, 'dist/cli.js'), '--daemon', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, COPILOT_TRACER_HOME: tempHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      ready = (await fetch(`${base}/api/dashboard`)).status === 200;
    } catch { /* not listening yet */ }
    if (!ready) await sleep(250);
  }
  if (!ready) {
    console.error(`daemon never became ready on ${port}\n${log}`);
    cleanup();
    process.exit(1);
  }

  for (const [sessionId, prompt] of PROMPTS) {
    await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(span(sessionId, prompt)),
    });
    await sleep(120);
  }

  const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
  const project = dashboard.projects.find((p) => p.repoUrl === repoUrl);

  console.log(JSON.stringify({
    base,
    home: tempHome,
    projectId: project ? project.id : null,
    workspaceUrl: project ? `${base}/index.html#/project?project=${encodeURIComponent(project.id)}` : null,
    localProjectId,
    localWorkspaceUrl: `${base}/index.html#/project?project=${encodeURIComponent(localProjectId)}`,
    localRepo,
    prompts: PROMPTS.length,
  }, null, 2));
  console.log('\nready. Ctrl-C to stop and clean up.');
}

main().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
