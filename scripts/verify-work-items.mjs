// End-to-end check for the work item pipeline.
//
// Boots a real daemon against a throwaway database, feeds it an OTLP span, and
// asserts that the trace is grouped into a work item and exposed over HTTP.
//
// Run with: npm run build && node scripts/verify-work-items.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tracer-verify-'));

let failures = 0;
let passes = 0;
let child = null;

async function check(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function attr(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function otlpPayload({ sessionId, repoUrl, prompt, traceId, spanId }) {
  const now = Date.now();
  return {
    resourceSpans: [{
      resource: { attributes: [attr('github.copilot.session_id', sessionId)] },
      scopeSpans: [{
        spans: [{
          traceId,
          spanId,
          name: 'invoke_agent',
          startTimeUnixNano: String((now - 1200) * 1e6),
          endTimeUnixNano: String(now * 1e6),
          attributes: [attr('github.copilot.git.repository', repoUrl)],
          events: [{
            name: 'gen_ai.content.prompt',
            attributes: [attr('gen_ai.prompt', prompt)],
          }],
        }],
      }],
    }],
  };
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const repoUrl = 'https://github.com/acme/verify-app';

  child = spawn(process.execPath, [path.join(root, 'dist/cli.js'), '--daemon', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, COPILOT_TRACER_HOME: tempHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let daemonLog = '';
  child.stdout.on('data', (d) => { daemonLog += d; });
  child.stderr.on('data', (d) => { daemonLog += d; });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`daemon exited early (${code}):\n${daemonLog}`);
  });

  // Wait for the daemon to accept requests.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      const res = await request('GET', `${base}/api/dashboard`);
      ready = res.status === 200;
    } catch { /* not listening yet */ }
    if (!ready) await sleep(250);
  }
  assert.ok(ready, `daemon never became ready on port ${port}\n${daemonLog}`);
  console.log(`daemon ready on ${base}`);

  console.log('ingestion');

  await check('accepts an OTLP span carrying a ticket reference', async () => {
    const res = await request('POST', `${base}/v1/traces`, otlpPayload({
      sessionId: 'verify-session-1',
      repoUrl,
      prompt: 'Implement ABC-123 and open a PR',
      traceId: '11111111111111111111111111111111',
      spanId: '1111111111111111',
    }));
    assert.equal(res.status, 200);
  });

  await check('stays responsive after ingestion', async () => {
    const res = await request('GET', `${base}/api/dashboard`);
    assert.equal(res.status, 200);
  });

  const dashboard = (await request('GET', `${base}/api/dashboard`)).body;
  const project = dashboard.projects.find((p) => p.repoUrl === repoUrl);
  assert.ok(project, `project for ${repoUrl} was not created`);
  const projectId = project.id;

  console.log('detected work items');

  let workItemId = null;

  await check('groups the trace into a work item keyed by the ticket', async () => {
    const res = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].ticketKey, 'ABC-123');
    assert.equal(res.body[0].traceCount, 1);
    assert.equal(res.body[0].kind, 'feature');
    assert.equal(res.body[0].source, 'detected');
    workItemId = res.body[0].id;
  });

  await check('a second prompt with the same ticket joins the work item', async () => {
    await request('POST', `${base}/v1/traces`, otlpPayload({
      sessionId: 'verify-session-1',
      repoUrl,
      prompt: 'Still finishing ABC-123 review comments',
      traceId: '22222222222222222222222222222222',
      spanId: '2222222222222222',
    }));
    const res = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items`);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].traceCount, 2);
  });

  await check('returns work item detail with references and traces', async () => {
    const res = await request('GET', `${base}/api/work-items/${encodeURIComponent(workItemId)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.traces.length, 2);
    assert.deepEqual(res.body.references, [{ type: 'jira', key: 'ABC-123', url: null }]);
    assert.ok(res.body.summary.includes('ABC-123'));
  });

  console.log('uncategorized inbox');

  let orphanTraceId = null;

  await check('a prompt with no ticket lands in the uncategorized inbox', async () => {
    await request('POST', `${base}/v1/traces`, otlpPayload({
      sessionId: 'verify-session-1',
      repoUrl,
      prompt: 'poke around the dashboard code',
      traceId: '33333333333333333333333333333333',
      spanId: '3333333333333333',
    }));
    const res = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].prompt, 'poke around the dashboard code');
    orphanTraceId = res.body[0].id;
  });

  console.log('backfill');

  await check('backfill regroups existing traces and stays idempotent', async () => {
    const first = await request('POST', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items/backfill`);
    assert.equal(first.status, 200);
    assert.equal(first.body.scanned, 3);
    assert.equal(first.body.linked, 2);

    const items = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items`);
    assert.equal(items.body.length, 1);
    assert.equal(items.body[0].traceCount, 2);
  });

  await check('backfill rejects an unknown project with 404', async () => {
    const res = await request('POST', `${base}/api/projects/project:nope/work-items/backfill`);
    assert.equal(res.status, 404);
  });

  console.log('manual grouping');

  await check('refuses to mark an item done without confirmation', async () => {
    const res = await request('PATCH', `${base}/api/work-items/${encodeURIComponent(workItemId)}`, {
      status: 'done',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.needsConfirmation, true);

    const unchanged = await request('GET', `${base}/api/work-items/${encodeURIComponent(workItemId)}`);
    assert.equal(unchanged.body.status, 'active');
  });

  await check('edits title, summary, kind and status', async () => {
    const res = await request('PATCH', `${base}/api/work-items/${encodeURIComponent(workItemId)}`, {
      title: 'ABC-123 dashboard filters',
      summary: 'Ship the project filter',
      kind: 'task',
      status: 'done',
      confirmCompletion: true,
      completionNote: 'merged by hand',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'ABC-123 dashboard filters');
    assert.equal(res.body.summary, 'Ship the project filter');
    assert.equal(res.body.kind, 'task');
    assert.equal(res.body.status, 'done');
    assert.equal(res.body.summarySource, 'user');
  });

  await check('filters the project list by status', async () => {
    const done = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items?status=done`);
    assert.equal(done.body.length, 1);
    const active = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items?status=active`);
    assert.equal(active.body.length, 0);
  });

  let manualId = null;

  await check('creates a manual work item', async () => {
    const res = await request('POST', `${base}/api/work-items`, {
      projectId,
      title: 'Exploration',
      summary: 'Unticketed spelunking',
      kind: 'investigation',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.source, 'manual');
    assert.equal(res.body.traceCount, 0);
    manualId = res.body.id;
  });

  await check('attaches an unlinked trace', async () => {
    const res = await request('POST', `${base}/api/work-items/${encodeURIComponent(manualId)}/traces`, { traceId: orphanTraceId });
    assert.equal(res.status, 200);
    assert.equal(res.body.traceCount, 1);

    const inbox = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`);
    assert.equal(inbox.body.length, 0);
  });

  await check('detaches a trace', async () => {
    const res = await request('DELETE', `${base}/api/work-items/${encodeURIComponent(manualId)}/traces/${encodeURIComponent(orphanTraceId)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.traceCount, 0);
  });

  console.log('drafts');

  let draftItemId = null;

  await check('generates a draft summary and criteria from linked prompts', async () => {
    const created = await request('POST', `${base}/api/work-items`, {
      projectId,
      title: 'Draft target',
      kind: 'unknown',
    });
    draftItemId = created.body.id;
    await request('POST', `${base}/api/work-items/${encodeURIComponent(draftItemId)}/traces`, { traceId: orphanTraceId });

    const preview = await request('GET', `${base}/api/work-items/${encodeURIComponent(draftItemId)}/draft`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.promptCount, 1);

    const res = await request('POST', `${base}/api/work-items/${encodeURIComponent(draftItemId)}/draft`, {});
    assert.equal(res.status, 200);
    assert.ok(res.body.applied.includes('summary'));
    assert.ok(res.body.workItem.summary);
    assert.ok(res.body.workItem.draftGeneratorVersion);
  });

  await check('a user edit to criteria survives regeneration', async () => {
    const edited = await request('PATCH', `${base}/api/work-items/${encodeURIComponent(draftItemId)}`, {
      acceptanceCriteria: ['only mine'],
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.acceptanceCriteria, ['only mine']);
    assert.equal(edited.body.criteriaSource, 'user');

    const again = await request('POST', `${base}/api/work-items/${encodeURIComponent(draftItemId)}/draft`, {});
    assert.deepEqual(again.body.workItem.acceptanceCriteria, ['only mine']);
    assert.ok(!again.body.applied.includes('acceptanceCriteria'));

    assert.equal((await request('DELETE', `${base}/api/work-items/${encodeURIComponent(draftItemId)}`)).status, 200);
  });

  await check('rejects malformed criteria and unknown draft targets', async () => {
    const bad = await request('PATCH', `${base}/api/work-items/${encodeURIComponent(manualId)}`, {
      acceptanceCriteria: 'not an array',
    });
    assert.equal(bad.status, 400);
    assert.equal((await request('POST', `${base}/api/work-items/work-item:nope/draft`, {})).status, 404);
    assert.equal((await request('GET', `${base}/api/work-items/work-item:nope/draft`)).status, 404);
  });

  console.log('git evidence');

  await check('records evidence without changing status', async () => {
    const before = await request('GET', `${base}/api/work-items/${encodeURIComponent(workItemId)}`);
    const res = await request('POST', `${base}/api/work-items/${encodeURIComponent(workItemId)}/refresh-evidence`, {});
    assert.equal(res.status, 200);
    assert.ok(res.body.gitEvidence, 'evidence was not stored');
    assert.ok(res.body.evidenceCheckedAt, 'evidence timestamp missing');
    assert.equal(res.body.status, before.body.status);
  });

  await check('a project with no checkout reports an explicit evidence error', async () => {
    const res = await request('GET', `${base}/api/work-items/${encodeURIComponent(workItemId)}`);
    const ev = res.body.gitEvidence;
    if (!ev.ok) {
      assert.ok(ev.error && ev.error.length > 0, 'missing evidence error message');
    } else {
      assert.ok(Array.isArray(ev.commits));
    }
  });

  await check('rejects refreshing evidence for an unknown work item', async () => {
    assert.equal((await request('POST', `${base}/api/work-items/work-item:nope/refresh-evidence`, {})).status, 404);
  });

  console.log('workspace ui');

  await check('serves the project workspace page and its controls', async () => {
    const res = await fetch(`${base}/index.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of [
      'page-project', 'ws-title', 'ws-tab-work-items', 'ws-tab-inbox',
      'ws-panel-work-items', 'ws-panel-inbox', 'wi-status-filter',
      'wi-list', 'inbox-list', 'wi-modal', 'ws-backfill-btn',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `missing element #${id}`);
    }
    assert.ok(html.includes('wi-edit-criteria'), 'criteria editor missing from the detail modal');
    assert.ok(html.includes('regenerateDraft'), 'generate draft control missing');
    assert.ok(html.includes('id="wi-evidence"'), 'evidence panel missing');
    assert.ok(html.includes('refreshEvidence'), 'evidence refresh control missing');
    assert.ok(html.includes('confirmCompletion'), 'completion confirmation missing');
    assert.ok(html.includes("location.hash='#/project?project="), 'project card does not open the workspace');
    assert.ok(html.includes("'project'"), 'project route is not registered');
  });

  console.log('validation');

  await check('rejects an unknown project with 404', async () => {
    const res = await request('GET', `${base}/api/projects/project:nope/work-items`);
    assert.equal(res.status, 404);
  });

  await check('rejects an unknown work item with 404', async () => {
    assert.equal((await request('GET', `${base}/api/work-items/work-item:nope`)).status, 404);
    assert.equal((await request('PATCH', `${base}/api/work-items/work-item:nope`, { title: 'x' })).status, 404);
  });

  await check('rejects detaching a trace that is not linked', async () => {
    const res = await request('DELETE', `${base}/api/work-items/${encodeURIComponent(manualId)}/traces/trace-nope`);
    assert.equal(res.status, 404);
  });

  await check('rejects an unknown trace when attaching', async () => {
    const res = await request('POST', `${base}/api/work-items/${encodeURIComponent(manualId)}/traces`, { traceId: 'trace-nope' });
    assert.equal(res.status, 404);
  });

  await check('rejects an invalid kind with 400', async () => {
    const res = await request('PATCH', `${base}/api/work-items/${encodeURIComponent(manualId)}`, { kind: 'wizardry' });
    assert.equal(res.status, 400);
  });

  await check('rejects an invalid status with 400', async () => {
    const res = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items?status=sideways`);
    assert.equal(res.status, 400);
  });

  await check('rejects a work item without a title', async () => {
    const res = await request('POST', `${base}/api/work-items`, { projectId, title: '  ' });
    assert.equal(res.status, 400);
  });

  await check('deletes a work item', async () => {
    assert.equal((await request('DELETE', `${base}/api/work-items/${encodeURIComponent(manualId)}`)).status, 200);
    assert.equal((await request('GET', `${base}/api/work-items/${encodeURIComponent(manualId)}`)).status, 404);
  });
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\nverification aborted: ${error.message}`);
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await sleep(400);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
