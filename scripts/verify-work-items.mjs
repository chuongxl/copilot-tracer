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
    assert.equal(res.body.references.length, 1);
    const [reference] = res.body.references;
    assert.equal(reference.type, 'jira');
    assert.equal(reference.key, 'ABC-123');
    assert.equal(reference.url, null);
    // The reference remembers which prompt first carried the ticket.
    assert.ok(reference.sourceTraceId, 'reference should record its source trace');
    assert.ok(res.body.traces.some((t) => t.id === reference.sourceTraceId));
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

  await check('a detected work item starts unconfirmed', async () => {
    const res = await request('GET', `${base}/api/work-items/${encodeURIComponent(workItemId)}`);
    assert.equal(res.body.status, 'detected');
    assert.equal(res.body.source, 'detected');
  });

  await check('confirming moves a detected item to active', async () => {
    const res = await request('PATCH', `${base}/api/work-items/${encodeURIComponent(workItemId)}`, {
      status: 'active',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'active');
  });

  await check('refuses to mark an item completed without confirmation', async () => {
    const res = await request('PATCH', `${base}/api/work-items/${encodeURIComponent(workItemId)}`, {
      status: 'completed',
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
      status: 'completed',
      confirmCompletion: true,
      completionNote: 'merged by hand',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'ABC-123 dashboard filters');
    assert.equal(res.body.summary, 'Ship the project filter');
    assert.equal(res.body.kind, 'task');
    assert.equal(res.body.status, 'completed');
    assert.equal(res.body.summarySource, 'user');
  });

  await check('filters the project list by status', async () => {
    const completed = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items?status=completed`);
    assert.equal(completed.body.length, 1);
    const active = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items?status=active`);
    assert.equal(active.body.length, 0);
    const paused = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items?status=paused`);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.length, 0);
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

  console.log('inbox triage');

  await check('ignoring a prompt takes it out of the inbox', async () => {
    const before = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`);
    assert.ok(before.body.some((t) => t.id === orphanTraceId), 'orphan prompt should start in the inbox');

    const res = await request(
      'POST',
      `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces/${encodeURIComponent(orphanTraceId)}/dismiss`,
      { reason: 'unrelated' },
    );
    assert.equal(res.status, 200);

    const after = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`);
    assert.ok(!after.body.some((t) => t.id === orphanTraceId), 'dismissed prompt is still in the inbox');
  });

  await check('a dismissed prompt is listed with its reason and the trace survives', async () => {
    const res = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/dismissed-traces`);
    assert.equal(res.status, 200);
    const row = res.body.find((t) => t.id === orphanTraceId);
    assert.ok(row, 'dismissed prompt missing from the list');
    assert.equal(row.reason, 'unrelated');

    const trace = await request('GET', `${base}/api/traces`);
    assert.ok(trace.body.some((t) => t.id === orphanTraceId), 'dismissal must not delete the trace');
  });

  await check('restoring puts the prompt back in the inbox', async () => {
    const res = await request(
      'DELETE',
      `${base}/api/projects/${encodeURIComponent(projectId)}/dismissed-traces/${encodeURIComponent(orphanTraceId)}`,
    );
    assert.equal(res.status, 204);

    const inbox = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`);
    assert.ok(inbox.body.some((t) => t.id === orphanTraceId), 'restored prompt is not back in the inbox');
  });

  await check('a manual attach clears the dismissal', async () => {
    await request(
      'POST',
      `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces/${encodeURIComponent(orphanTraceId)}/dismiss`,
      {},
    );
    await request('POST', `${base}/api/work-items/${encodeURIComponent(manualId)}/traces`, { traceId: orphanTraceId });

    const dismissed = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/dismissed-traces`);
    assert.ok(!dismissed.body.some((t) => t.id === orphanTraceId), 'link should clear the dismissal');

    await request('DELETE', `${base}/api/work-items/${encodeURIComponent(manualId)}/traces/${encodeURIComponent(orphanTraceId)}`);
  });

  await check('rejects an unknown dismissal reason and a foreign trace', async () => {
    const bad = await request(
      'POST',
      `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces/${encodeURIComponent(orphanTraceId)}/dismiss`,
      { reason: 'whatever' },
    );
    assert.equal(bad.status, 400);

    const missing = await request(
      'POST',
      `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces/trace:nope/dismiss`,
      {},
    );
    assert.equal(missing.status, 404);
  });

  await check('backfill does not resurrect a dismissed prompt', async () => {
    await request('POST', `${base}/v1/traces`, otlpPayload({
      sessionId: 'verify-session-dismiss',
      repoUrl,
      prompt: 'Investigate REGRESS-7, the dismissal keeps coming back',
      traceId: '77777777777777777777777777777777',
      spanId: '7777777777777777',
    }));

    const items = (await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items`)).body;
    const item = items.find((w) => w.title === 'REGRESS-7');
    assert.ok(item, 'expected REGRESS-7 to group on ingestion');

    const detail = (await request('GET', `${base}/api/work-items/${encodeURIComponent(item.id)}`)).body;
    const traceId = detail.traces[0].id;

    await request('DELETE', `${base}/api/work-items/${encodeURIComponent(item.id)}/traces/${encodeURIComponent(traceId)}`);
    await request(
      'POST',
      `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces/${encodeURIComponent(traceId)}/dismiss`,
      { reason: 'unrelated' },
    );

    await request('POST', `${base}/api/projects/${encodeURIComponent(projectId)}/work-items/backfill`);

    const dismissed = (await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/dismissed-traces`)).body;
    assert.ok(dismissed.some((t) => t.id === traceId), 'backfill must leave the dismissal in place');

    const after = (await request('GET', `${base}/api/work-items/${encodeURIComponent(item.id)}`)).body;
    assert.equal(after.traceCount, 0, 'backfill must not re-link a dismissed prompt');
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

  console.log('merge and split');

  let mergeTargetId = null;
  let mergeSourceId = null;

  await check('merge moves prompts and references onto the target', async () => {
    const target = await request('POST', `${base}/api/work-items`, { projectId, title: 'Target item' });
    const source = await request('POST', `${base}/api/work-items`, { projectId, title: 'Source item' });
    mergeTargetId = target.body.id;
    mergeSourceId = source.body.id;

    await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeSourceId)}/traces`, { traceId: orphanTraceId });
    await request('PATCH', `${base}/api/work-items/${encodeURIComponent(mergeSourceId)}`, {
      acceptanceCriteria: ['the retry budget is capped'],
    });

    const res = await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/merge`, {
      sourceIds: [mergeSourceId],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.traceCount, 1);
    assert.ok(res.body.acceptanceCriteria.includes('the retry budget is capped'));
    assert.ok(res.body.traces.some((t) => t.id === orphanTraceId));

    const gone = await request('GET', `${base}/api/work-items/${encodeURIComponent(mergeSourceId)}`);
    assert.equal(gone.status, 404);
  });

  await check('merge keeps the raw trace and rejects bad input', async () => {
    const traces = await request('GET', `${base}/api/traces`);
    assert.ok(traces.body.some((t) => t.id === orphanTraceId), 'merge must not delete traces');

    assert.equal((await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/merge`, {
      sourceIds: [mergeTargetId],
    })).status, 400);
    assert.equal((await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/merge`, {
      sourceIds: ['work-item:nope'],
    })).status, 400);
    assert.equal((await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/merge`, {
      sourceIds: 'nope',
    })).status, 400);
  });

  await check('split moves picked prompts into a new work item', async () => {
    const projectTraces = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/traces`);
    const spare = projectTraces.body.find((t) => t.id !== orphanTraceId);
    assert.ok(spare, 'need a spare prompt to split');
    await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/traces`, { traceId: spare.id });

    const res = await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/split`, {
      title: 'Split off work',
      traceIds: [spare.id],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.created.title, 'Split off work');
    assert.equal(res.body.created.traceCount, 1);
    assert.equal(res.body.created.source, 'manual');
    assert.equal(res.body.source.traceCount, 1);
    assert.ok(!res.body.source.traces.some((t) => t.id === spare.id));
  });

  await check('split refuses to empty the original or move a foreign prompt', async () => {
    const item = await request('GET', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}`);
    const all = item.body.traces.map((t) => t.id);

    const emptied = await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/split`, {
      title: 'Everything', traceIds: all,
    });
    assert.equal(emptied.status, 400);

    const foreign = await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/split`, {
      title: 'Nope', traceIds: ['trace:nope'],
    });
    assert.equal(foreign.status, 400);

    const untitled = await request('POST', `${base}/api/work-items/${encodeURIComponent(mergeTargetId)}/split`, {
      title: '   ', traceIds: all.slice(0, 1),
    });
    assert.equal(untitled.status, 400);
  });

  console.log('dashboard rollup');

  await check('the dashboard reports work item counts per project', async () => {
    const res = await request('GET', `${base}/api/dashboard`);
    assert.equal(res.status, 200);
    assert.ok(res.body.workItemTotals, 'workItemTotals missing from the dashboard');
    assert.equal(typeof res.body.workItemTotals.active, 'number');
    assert.equal(typeof res.body.workItemTotals.unlinkedPrompts, 'number');
    // Detected items are open work. Counting only `active` made the headline
    // tile read zero while four items sat waiting to be confirmed.
    assert.equal(typeof res.body.workItemTotals.open, 'number');
    assert.ok(
      res.body.workItemTotals.open >= res.body.workItemTotals.detected,
      'open must include detected items',
    );

    const project = res.body.projects.find((p) => p.id === projectId);
    assert.ok(project, 'project missing from the dashboard');
    assert.ok(project.workItems, 'project card carries no work item rollup');
    assert.ok(project.workItems.total > 0, 'expected at least one work item on the card');
    assert.equal(typeof project.workItems.ticketReferences, 'number');
    assert.equal(typeof project.workItems.unlinkedPrompts, 'number');
    assert.ok(Array.isArray(project.workItems.recent));
    assert.ok(project.workItems.recent.length <= 3, 'recent list should be capped at 3');
  });

  // The project filter and the work item rollup share getDashboard. Filtering
  // must narrow the project list without disturbing either the rollups on the
  // surviving cards or the global headline totals.
  // The rollups are fetched for the whole page in one go. The two ways that
  // can break are a project silently losing its row and one project's numbers
  // landing on another's card, so check both against the global totals.
  await check('every project card carries its own rollup and none are swapped', async () => {
    const res = await request('GET', `${base}/api/dashboard?pageSize=100`);
    assert.equal(res.status, 200);

    let detected = 0;
    let completed = 0;
    for (const p of res.body.projects) {
      assert.ok(p.workItems, `project ${p.id} lost its rollup in the batch`);
      assert.ok(Array.isArray(p.workItems.recent));
      assert.ok(p.workItems.recent.length <= 3, `project ${p.id} exceeded the recent cap`);
      assert.ok(
        p.workItems.total >= p.workItems.recent.length,
        `project ${p.id} shows more recent items than it has`,
      );
      detected += p.workItems.detected;
      completed += p.workItems.completed;
    }

    assert.equal(detected, res.body.workItemTotals.detected, 'per-project detected counts do not sum to the total');
    assert.equal(completed, res.body.workItemTotals.completed, 'per-project completed counts do not sum to the total');
  });

  await check('the project filter narrows the list and keeps rollups intact', async () => {
    const res = await request('GET', `${base}/api/dashboard?q=verify-app`);
    assert.equal(res.status, 200);
    assert.ok(res.body.projects.length > 0, 'filter dropped the matching project');
    for (const p of res.body.projects) {
      const haystack = `${p.path} ${p.localPath ?? ''} ${p.repoUrl ?? ''}`.toLowerCase();
      assert.ok(haystack.includes('verify-app'), `unmatched project survived the filter: ${p.id}`);
    }

    const filtered = res.body.projects.find((p) => p.id === projectId);
    assert.ok(filtered, 'filtered result lost the project');
    assert.ok(filtered.workItems, 'filtered project card lost its work item rollup');
    assert.ok(filtered.workItems.total > 0, 'filtered project card lost its work item counts');
    assert.equal(res.body.pagination.totalProjects, res.body.projects.length);
  });

  await check('the filter is case-insensitive and matches on a substring', async () => {
    const res = await request('GET', `${base}/api/dashboard?q=VERIFY`);
    assert.equal(res.status, 200);
    assert.ok(
      res.body.projects.some((p) => p.id === projectId),
      'an upper-case query failed to match a lower-case path',
    );
  });

  await check('a query that matches nothing returns an empty list, not an error', async () => {
    const res = await request('GET', `${base}/api/dashboard?q=zzz-no-such-project-zzz`);
    assert.equal(res.status, 200);
    assert.equal(res.body.projects.length, 0);
    assert.equal(res.body.pagination.totalProjects, 0);
    // Headline totals describe the whole database, so they must survive a
    // filter that empties the project list.
    assert.ok(res.body.workItemTotals.open >= 0);
    assert.ok(res.body.totals.projects > 0, 'global project total should ignore the filter');
  });

  await check('a filter with SQL wildcards is treated as literal text', async () => {
    const res = await request('GET', `${base}/api/dashboard?q=${encodeURIComponent("%' OR '1'='1")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.projects.length, 0, 'filter input reached the query as SQL');
  });

  await check('a dismissed prompt stops counting as unlinked', async () => {
    const inbox = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`);
    if (!inbox.body.length) return;
    const victim = inbox.body[0].id;

    const before = await request('GET', `${base}/api/dashboard`);
    const beforeCount = before.body.projects.find((p) => p.id === projectId).workItems.unlinkedPrompts;

    await request(
      'POST',
      `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces/${encodeURIComponent(victim)}/dismiss`,
      {},
    );

    const after = await request('GET', `${base}/api/dashboard`);
    const afterCount = after.body.projects.find((p) => p.id === projectId).workItems.unlinkedPrompts;
    assert.equal(afterCount, beforeCount - 1);

    await request('DELETE', `${base}/api/projects/${encodeURIComponent(projectId)}/dismissed-traces/${encodeURIComponent(victim)}`);
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
    assert.ok(html.includes('dismissInboxTrace'), 'inbox dismiss control missing');
    assert.ok(html.includes('Mark unrelated'), 'mark unrelated control missing');
    assert.ok(html.includes('restoreInboxTrace'), 'restore control missing');
    assert.ok(html.includes('id="inbox-dismissed"'), 'dismissed list missing');
    assert.ok(html.includes('mergeWorkItem'), 'merge control missing');
    assert.ok(html.includes('splitWorkItemPrompt'), 'split control missing');
    assert.ok(html.includes('confirmWorkItem'), 'confirm control missing');
    assert.ok(html.includes('wi-split-pick'), 'split prompt selection missing');
    assert.ok(html.includes('dash-project-work-items'), 'dashboard work item block missing');
    assert.ok(html.includes('workItemTotals'), 'dashboard work item totals missing');
    for (const status of ['detected', 'paused', 'blocked', 'completed']) {
      assert.ok(html.includes(`<option value="${status}">`), `status filter is missing ${status}`);
    }
    assert.ok(html.includes("location.hash='#/project?project="), 'project card does not open the workspace');
    assert.ok(html.includes("'project'"), 'project route is not registered');
  });

  console.log('suggestions');

  let suggestionId = null;
  let suggestedTraceId = null;

  await check('a ticketless echo of an open item becomes a suggestion, not a link', async () => {
    await request('POST', `${base}/v1/traces`, otlpPayload({
      sessionId: 'verify-session-sugg',
      repoUrl,
      prompt: 'Fix SUGGEST-1: the websocket reconnect backoff thrashes on idle sockets',
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: 'aaaaaaaaaaaaaaaa',
    }));
    await request('POST', `${base}/v1/traces`, otlpPayload({
      sessionId: 'verify-session-sugg',
      repoUrl,
      prompt: 'the websocket reconnect backoff still thrashes whenever sockets idle',
      traceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      spanId: 'bbbbbbbbbbbbbbbb',
    }));

    const inbox = (await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`)).body;
    const row = inbox.find((t) => t.prompt.includes('still thrashes'));
    assert.ok(row, 'the echoing prompt should stay in the inbox');
    assert.equal(row.suggestions.length, 1);
    assert.equal(row.suggestions[0].reason, 'similarity');
    assert.equal(row.linkSource, 'suggested');

    suggestionId = row.suggestions[0].id;
    suggestedTraceId = row.id;

    const target = (await request('GET', `${base}/api/work-items/${encodeURIComponent(row.suggestions[0].workItemId)}`)).body;
    assert.equal(target.traceCount, 1, 'a suggestion must not link anything on its own');
  });

  await check('accepting a suggestion links the prompt', async () => {
    const res = await request('POST', `${base}/api/suggestions/${encodeURIComponent(suggestionId)}/accept`);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'accepted');

    const item = (await request('GET', `${base}/api/work-items/${encodeURIComponent(res.body.workItemId)}`)).body;
    assert.ok(item.traces.some((t) => t.id === suggestedTraceId));

    const inbox = (await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`)).body;
    assert.ok(!inbox.some((t) => t.id === suggestedTraceId), 'an accepted prompt leaves the inbox');
  });

  await check('a decided suggestion returns 409 and an unknown one 404', async () => {
    const again = await request('POST', `${base}/api/suggestions/${encodeURIComponent(suggestionId)}/accept`);
    assert.equal(again.status, 409);

    const rejected = await request('POST', `${base}/api/suggestions/${encodeURIComponent(suggestionId)}/reject`);
    assert.equal(rejected.status, 409);

    const missing = await request('POST', `${base}/api/suggestions/suggestion:nope/accept`);
    assert.equal(missing.status, 404);
  });

  await check('rejecting a suggestion leaves the prompt in the inbox with no proposals', async () => {
    await request('POST', `${base}/v1/traces`, otlpPayload({
      sessionId: 'verify-session-sugg',
      repoUrl,
      prompt: 'websocket reconnect backoff thrashes on idle sockets once more',
      traceId: 'cccccccccccccccccccccccccccccccc',
      spanId: 'cccccccccccccccc',
    }));

    const inbox = (await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`)).body;
    const row = inbox.find((t) => t.prompt.includes('once more'));
    assert.ok(row?.suggestions.length, 'expected a fresh suggestion');

    const res = await request('POST', `${base}/api/suggestions/${encodeURIComponent(row.suggestions[0].id)}/reject`);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'rejected');

    const after = (await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/uncategorized-traces`)).body;
    const stillThere = after.find((t) => t.id === row.id);
    assert.ok(stillThere, 'rejecting is not dismissing');
    assert.equal(stillThere.suggestions.length, 0);
  });

  console.log('productivity analytics');

  await check('reports project analytics with consistent totals', async () => {
    const res = await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/analytics`);
    assert.equal(res.status, 200);

    const { totals, byKind, byStatus, measures } = res.body;
    assert.ok(totals.itemCount > 0);
    assert.equal(byKind.reduce((sum, g) => sum + g.itemCount, 0), totals.itemCount);
    assert.equal(byStatus.reduce((sum, g) => sum + g.itemCount, 0), totals.itemCount);
    assert.ok(totals.credits >= 0);
    assert.ok(measures.tracesTotal > 0);
    assert.ok(measures.suggestionsDecided >= 2, 'one accept and one reject were recorded');
    assert.ok(measures.suggestionAcceptanceRate > 0);
  });

  await check('serves a global analytics report', async () => {
    const res = await request('GET', `${base}/api/analytics`);
    assert.equal(res.status, 200);
    assert.equal(res.body.projectId, null);
    assert.ok(res.body.totals.itemCount > 0);
    assert.ok(Array.isArray(res.body.topByCredits));
  });

  await check('cycle time appears only after a confirmed completion', async () => {
    const created = (await request('POST', `${base}/api/work-items`, {
      projectId,
      title: 'Cycle time check',
    })).body;
    await request('POST', `${base}/api/work-items/${encodeURIComponent(created.id)}/traces`, {
      traceId: suggestedTraceId,
    });

    const before = (await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/analytics`)).body;
    const openRow = before.topByCredits.concat(before.recentlyCompleted).find((r) => r.id === created.id);
    if (openRow) assert.equal(openRow.cycleTimeMs, null);

    await request('PATCH', `${base}/api/work-items/${encodeURIComponent(created.id)}`, {
      status: 'completed',
      confirmCompletion: true,
    });

    const after = (await request('GET', `${base}/api/projects/${encodeURIComponent(projectId)}/analytics`)).body;
    const done = after.recentlyCompleted.find((r) => r.id === created.id);
    assert.ok(done, 'a completed item should appear in recentlyCompleted');
    assert.ok(done.completedAt, 'completion time comes from the status history');
    assert.ok(after.totals.completedCount >= 1);
  });

  await check('the analytics tab and suggestion controls are served', async () => {
    const res = await request('GET', `${base}/index.html`);
    const html = res.body;
    assert.ok(html.includes("showWorkspaceTab('analytics')"), 'analytics tab missing');
    assert.ok(html.includes('an-measures'), 'success measures block missing');
    assert.ok(html.includes('decideSuggestion'), 'suggestion accept and reject missing');
    assert.ok(html.includes('wi-suggestions-ambiguous'), 'ambiguous suggestion styling missing');

    // Work item spans and single-trace durations need different formatters.
    // They shared a name once, and the trace one silently won, printing cycle
    // times as "2192.0s".
    assert.ok(html.includes('function fmtSpan(ms)'), 'work item span formatter missing');
    assert.equal(
      (html.match(/function fmtSpan\(/g) || []).length, 1,
      'fmtSpan must be defined exactly once',
    );
    assert.equal(
      (html.match(/function fmtDuration\(/g) || []).length, 1,
      'fmtDuration must be defined exactly once',
    );
    assert.ok(!/fmtDuration\((?:t|r|i)\.(?:avgC|cycleT|elapsed)/.test(html),
      'analytics must not call the trace duration formatter');
  });

  await check('a project with no work items reports empty analytics', async () => {
    const empty = (await request('GET', `${base}/api/dashboard`)).body.projects
      .find((p) => p.id !== projectId);

    if (!empty) return; // Only one project in this run.
    const res = await request('GET', `${base}/api/projects/${encodeURIComponent(empty.id)}/analytics`);
    assert.equal(res.status, 200);
    assert.ok(res.body.totals.itemCount >= 0);
    assert.equal(res.body.totals.avgCycleTimeMs, null);
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
