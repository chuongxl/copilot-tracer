// Verifies deterministic work-item extraction and, once the service exists,
// its persistence behaviour against a throwaway database.
//
// Run with: npm run build && node scripts/test-work-item-extraction.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tracer-wi-'));
process.env.COPILOT_TRACER_HOME = tempHome;

let failures = 0;
let passes = 0;

function check(name, fn) {
  try {
    fn();
    passes += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
}

const { extractWorkItemEvidence, deriveWorkItemSummary, generateWorkItemDraft } = await import('../dist/workItemExtraction.js');

const bare = (refs) => refs.map((r) => ({ type: r.type, key: r.key }));

console.log('extraction: ticket references');

check('finds a Jira key and a GitHub issue URL in prompt order', () => {
  const { references } = extractWorkItemEvidence('Fix ABC-123. See https://github.com/acme/app/issues/42');
  assert.deepEqual(bare(references), [
    { type: 'jira', key: 'ABC-123' },
    { type: 'github_issue', key: 'acme/app#42' },
  ]);
  assert.equal(references[1].url, 'https://github.com/acme/app/issues/42');
  assert.equal(references[0].url, null);
});

check('classifies a GitHub pull request URL separately from an issue', () => {
  const { references } = extractWorkItemEvidence('Review https://github.com/acme/app/pull/7');
  assert.deepEqual(bare(references), [{ type: 'github_pr', key: 'acme/app#7' }]);
});

check('reads an Azure DevOps work item URL', () => {
  const { references } = extractWorkItemEvidence('Ticket https://dev.azure.com/contoso/Web/_workitems/edit/9001');
  assert.deepEqual(bare(references), [{ type: 'azure_devops', key: 'contoso/Web#9001' }]);
});

check('reads a Linear issue URL and uppercases the key', () => {
  const { references } = extractWorkItemEvidence('See https://linear.app/team/issue/eng-88/do-the-thing');
  assert.deepEqual(bare(references), [{ type: 'linear', key: 'ENG-88' }]);
});

check('reads a Jira browse URL', () => {
  const { references } = extractWorkItemEvidence('Open https://jira.acme.com/browse/PLAT-77 next');
  assert.deepEqual(bare(references), [{ type: 'jira', key: 'PLAT-77' }]);
  assert.equal(references[0].confidence, 0.95);
});

check('reads owner/repo#number shorthand', () => {
  const { references } = extractWorkItemEvidence('Blocked by acme/app#12');
  assert.deepEqual(bare(references), [{ type: 'github_issue', key: 'acme/app#12' }]);
});

check('deduplicates a key mentioned twice and keeps the URL evidence', () => {
  const { references } = extractWorkItemEvidence('ABC-123 again: https://jira.acme.com/browse/ABC-123');
  assert.equal(references.length, 1);
  assert.equal(references[0].key, 'ABC-123');
  assert.equal(references[0].url, 'https://jira.acme.com/browse/ABC-123');
  assert.equal(references[0].confidence, 0.95);
});

check('ignores standards and encodings that look like ticket keys', () => {
  const noise = 'Encode as UTF-8 using SHA-256 over ISO-8601 dates, see RFC-2119 and CVE-2021-1234';
  assert.deepEqual(extractWorkItemEvidence(noise).references, []);
});

check('does not read a ticket key out of a URL path segment', () => {
  const { references } = extractWorkItemEvidence('Check https://example.com/docs/AB-12/readme');
  assert.deepEqual(references, []);
});

console.log('extraction: work kind');

check('classifies a feature request', () => {
  assert.equal(extractWorkItemEvidence('Add project filtering to the dashboard').kind, 'feature');
});

check('classifies an investigation', () => {
  assert.equal(extractWorkItemEvidence('Why is telemetry missing from VS Code?').kind, 'investigation');
});

check('classifies a bug report', () => {
  assert.equal(extractWorkItemEvidence('Fix the crash when the dashboard loads').kind, 'bug');
});

check('classifies a refactor', () => {
  assert.equal(extractWorkItemEvidence('Refactor the OTLP receiver into smaller modules').kind, 'refactor');
});

check('classifies documentation work', () => {
  assert.equal(extractWorkItemEvidence('Document the work item API in the readme').kind, 'documentation');
});

check('falls back to unknown without evidence', () => {
  assert.equal(extractWorkItemEvidence('dashboard API').kind, 'unknown');
});

check('returns empty evidence for a blank prompt', () => {
  const evidence = extractWorkItemEvidence('   ');
  assert.deepEqual(evidence.references, []);
  assert.equal(evidence.kind, 'unknown');
  assert.equal(evidence.confidence, 0);
});

console.log('extraction: confidence and summary');

check('scores a referenced, classified prompt highest', () => {
  assert.equal(extractWorkItemEvidence('Fix ABC-123 in the dashboard').confidence, 1);
});

check('scores an unreferenced, unclassified prompt lowest', () => {
  assert.equal(extractWorkItemEvidence('dashboard API').confidence, 0.2);
});

check('summarises the first sentence of a prompt', () => {
  assert.equal(
    deriveWorkItemSummary('Add project filtering. Then also add sorting.'),
    'Add project filtering.',
  );
});

check('truncates a long single-sentence prompt', () => {
  const summary = deriveWorkItemSummary('x'.repeat(400), 50);
  assert.equal(summary.length, 50);
  assert.ok(summary.endsWith('…'));
});

// ── Draft generation ──────────────────────────────────────────────────────────

console.log('drafts: summary and acceptance criteria');

check('an empty prompt list yields an empty draft', () => {
  const draft = generateWorkItemDraft([]);
  assert.equal(draft.summary, '');
  assert.deepEqual(draft.acceptanceCriteria, []);
  assert.equal(draft.kind, 'unknown');
  assert.equal(draft.promptCount, 0);
});

check('summary comes from the first prompt objective', () => {
  const draft = generateWorkItemDraft([
    { prompt: 'Add a project filter to the dashboard page so engineers can narrow traces.' },
    { prompt: 'Also make it persist across reloads.' },
  ]);
  assert.ok(draft.summary.length > 0);
  assert.ok(/project filter/i.test(draft.summary));
  assert.equal(draft.promptCount, 2);
  assert.equal(draft.source, 'prompt');
});

check('collects bullets under an acceptance criteria heading', () => {
  const draft = generateWorkItemDraft([{
    prompt: [
      'Build the export button.',
      'Acceptance criteria:',
      '- Export produces a CSV file',
      '- The file name contains the project name',
    ].join('\n'),
  }]);
  assert.ok(draft.acceptanceCriteria.includes('Export produces a CSV file'));
  assert.ok(draft.acceptanceCriteria.includes('The file name contains the project name'));
});

check('collects obligation sentences even without a heading', () => {
  const draft = generateWorkItemDraft([
    { prompt: 'Fix the login redirect. The session must survive a page reload.' },
  ]);
  assert.ok(draft.acceptanceCriteria.some((c) => /must survive a page reload/i.test(c)));
});

check('deduplicates criteria repeated across prompts', () => {
  const draft = generateWorkItemDraft([
    { prompt: 'The API should return 404 for unknown ids.' },
    { prompt: 'Remember the API should return 404 for unknown ids.' },
  ]);
  const matches = draft.acceptanceCriteria.filter((c) => /404 for unknown ids/i.test(c));
  assert.equal(matches.length, 1);
});

check('kind is a majority vote across prompts', () => {
  const draft = generateWorkItemDraft([
    { prompt: 'Fix the crash on startup, it is a bug.' },
    { prompt: 'Another bug: the list fails to load.' },
    { prompt: 'Add a new feature for exports.' },
  ]);
  assert.equal(draft.kind, 'bug');
});

// ── Persistence ───────────────────────────────────────────────────────────────

const service = await import('../dist/workItemService.js').catch(() => null);

if (!service) {
  console.error('\nwork item service not built yet; persistence checks skipped');
} else {
  const { persistWorkItemEvidence, getWorkItems, getWorkItem, createWorkItem, linkTraceToWorkItem, unlinkTraceFromWorkItem, updateWorkItem, applyWorkItemDraft, buildWorkItemDraft } = service;
  const { ensureProject, createSession, upsertTrace } = await import('../dist/db.js');

  const projectId = ensureProject('/tmp/work-item-test-project');
  const otherProjectId = ensureProject('/tmp/work-item-other-project');
  createSession('session-wi-1', projectId);

  let seq = 0;
  const makeTrace = (prompt) => {
    seq += 1;
    const entry = {
      id: `trace-${seq}`,
      sessionId: 'session-wi-1',
      dateTime: new Date(Date.now() + seq * 1000).toISOString(),
      prompt,
      tokens: { input: 10, output: 5, cached: 0, reasoning: 0, written: 0, total: 15 },
      aiCredits: 0.5,
      durationMs: 1000,
      toolCalls: [],
      skillCount: 0,
      agentCount: 0,
      mcpCount: 0,
      status: 'done',
    };
    upsertTrace(entry);
    return entry;
  };

  console.log('persistence: detected work items');

  const first = makeTrace('Fix ABC-123 in the dashboard');
  persistWorkItemEvidence(first, projectId);

  check('creates one work item from a ticket reference', () => {
    const items = getWorkItems(projectId);
    assert.equal(items.length, 1);
    assert.equal(items[0].ticketKey, 'ABC-123');
    assert.equal(items[0].traceCount, 1);
    assert.equal(items[0].kind, 'bug');
    assert.equal(items[0].source, 'detected');
  });

  check('re-persisting the same trace is idempotent', () => {
    persistWorkItemEvidence(first, projectId);
    persistWorkItemEvidence(first, projectId);
    const items = getWorkItems(projectId);
    assert.equal(items.length, 1);
    assert.equal(items[0].traceCount, 1);
  });

  check('a second prompt with the same ticket joins the existing work item', () => {
    persistWorkItemEvidence(makeTrace('Still working on ABC-123'), projectId);
    const items = getWorkItems(projectId);
    assert.equal(items.length, 1);
    assert.equal(items[0].traceCount, 2);
  });

  check('a different ticket creates a separate work item', () => {
    persistWorkItemEvidence(makeTrace('Start ABC-999 now'), projectId);
    assert.equal(getWorkItems(projectId).length, 2);
  });

  check('one trace links to two work items when it cites two tickets', () => {
    const trace = makeTrace('Link ABC-123 with https://github.com/acme/app/issues/42');
    persistWorkItemEvidence(trace, projectId);
    const linked = getWorkItems(projectId).filter((item) =>
      getWorkItem(item.id).traces.some((t) => t.id === trace.id));
    assert.equal(linked.length, 2);
  });

  check('a prompt with no reference creates no work item', () => {
    const before = getWorkItems(projectId).length;
    const result = persistWorkItemEvidence(makeTrace('dashboard API'), projectId);
    assert.equal(result.workItemIds.length, 0);
    assert.equal(result.status, 'uncategorized');
    assert.equal(getWorkItems(projectId).length, before);
  });

  check('work items are scoped to their project', () => {
    assert.equal(getWorkItems(otherProjectId).length, 0);
  });

  check('aggregates tokens and credits across linked traces', () => {
    const item = getWorkItems(projectId).find((i) => i.ticketKey === 'ABC-123');
    assert.equal(item.traceCount, 3);
    assert.equal(item.totalTokens, 45);
    assert.equal(item.totalCredits, 1.5);
  });

  console.log('persistence: manual work items');

  check('creates a manual work item and links a trace by hand', () => {
    const manual = createWorkItem({
      projectId,
      title: 'Manual grouping',
      summary: 'Traces grouped by hand',
      kind: 'task',
    });
    assert.equal(manual.source, 'manual');

    const orphan = makeTrace('some unrelated exploration');
    linkTraceToWorkItem({ workItemId: manual.id, traceId: orphan.id, linkSource: 'manual' });
    assert.equal(getWorkItem(manual.id).traceCount, 1);

    unlinkTraceFromWorkItem(manual.id, orphan.id);
    assert.equal(getWorkItem(manual.id).traceCount, 0);
  });

  check('getWorkItem returns null for an unknown id', () => {
    assert.equal(getWorkItem('work-item:does-not-exist'), null);
  });

  check('filters work items by status', () => {
    assert.ok(getWorkItems(projectId, 'active').length > 0);
    assert.equal(getWorkItems(projectId, 'done').length, 0);
  });

  console.log('persistence: drafts');

  check('applying a draft fills summary and criteria from linked prompts', () => {
    const item = createWorkItem({ projectId, title: 'Draft target', kind: 'unknown' });
    const trace = makeTrace('Add CSV export to the dashboard. The export must include the project name.');
    linkTraceToWorkItem({ workItemId: item.id, traceId: trace.id, linkSource: 'manual' });

    const result = applyWorkItemDraft(item.id);
    assert.ok(result.applied.includes('summary'));
    assert.ok(result.applied.includes('acceptanceCriteria'));
    assert.ok(result.item.acceptanceCriteria.length > 0);
    assert.equal(result.item.criteriaSource, 'generated');
    assert.ok(result.item.draftGeneratorVersion);
  });

  check('a regenerated draft does not overwrite user edits', () => {
    const item = createWorkItem({ projectId, title: 'Protected edits', kind: 'task' });
    const trace = makeTrace('Ship the importer. It should validate headers.');
    linkTraceToWorkItem({ workItemId: item.id, traceId: trace.id, linkSource: 'manual' });
    applyWorkItemDraft(item.id);

    updateWorkItem(item.id, { summary: 'my own words', acceptanceCriteria: ['mine only'] });
    const after = applyWorkItemDraft(item.id);
    assert.equal(after.item.summary, 'my own words');
    assert.deepEqual(after.item.acceptanceCriteria, ['mine only']);
    assert.equal(after.applied.length, 0);
  });

  check('overwriteUserEdits replaces user text on request', () => {
    const item = createWorkItem({ projectId, title: 'Overwrite me', kind: 'task' });
    linkTraceToWorkItem({
      workItemId: item.id,
      traceId: makeTrace('Rework the parser. It must handle empty files.').id,
      linkSource: 'manual',
    });
    updateWorkItem(item.id, { summary: 'stale note', acceptanceCriteria: ['stale'] });

    const after = applyWorkItemDraft(item.id, { overwriteUserEdits: true });
    assert.notEqual(after.item.summary, 'stale note');
    assert.notDeepEqual(after.item.acceptanceCriteria, ['stale']);
    assert.equal(after.item.summarySource, 'generated');
  });

  check('applying a draft to an unknown work item returns null', () => {
    assert.equal(applyWorkItemDraft('work-item:missing'), null);
    assert.equal(buildWorkItemDraft('work-item:missing'), null);
  });
}

fs.rmSync(tempHome, { recursive: true, force: true });

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
