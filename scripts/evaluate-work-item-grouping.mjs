#!/usr/bin/env node
/**
 * Measure how well deterministic grouping works before anyone reaches for
 * similarity scoring or a model.
 *
 * Every fixture states the references a human would expect from a prompt.
 * The evaluator compares that to what the extractor actually finds and reports
 * precision, recall, auto-link acceptance, the correction rate, and the share
 * of prompts left unlinked.
 *
 * Run with: npx tsc && node scripts/evaluate-work-item-grouping.mjs
 * Options:  --json  print machine-readable output only
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const jsonOnly = args.has('--json');

const distModule = path.join(root, 'dist', 'workItemExtraction.js');
if (!fs.existsSync(distModule)) {
  console.error('dist/workItemExtraction.js is missing. Run npx tsc first.');
  process.exit(1);
}

const { extractWorkItemEvidence, AUTO_LINK_CONFIDENCE, EXTRACTOR_VERSION } = await import(distModule);

// The precision floor below which automatic linking stops being trustworthy.
// Raising this is a deliberate act: see docs/work-items-evaluation.md.
const PRECISION_THRESHOLD = 0.95;

/**
 * category  groups fixtures in the report
 * prompt    the text a person typed
 * expected  the reference keys a person would expect to be detected
 * sensitive substrings that must never appear in a detected reference key
 */
const FIXTURES = [
  // 1. Exact Jira keys
  { category: 'exact jira keys', prompt: 'Fix ABC-123, the filter drops the last row.', expected: ['ABC-123'] },
  { category: 'exact jira keys', prompt: 'PROJ-9 is blocked on the migration script.', expected: ['PROJ-9'] },
  { category: 'exact jira keys', prompt: 'Start work on PLATFORM-4821 tomorrow.', expected: ['PLATFORM-4821'] },

  // Known limitation, deliberately encoded: a lower-case key is not treated as
  // a ticket. Matching it would also match step-1, node-18, top-10 and every
  // other hyphenated word-number pair, and a false work item costs more than a
  // missed one. See docs/work-items-evaluation.md.
  { category: 'lower case (limit)', prompt: 'abc-123 in lower case is not read as a ticket.', expected: [] },

  // 1b. Source line ranges, taken verbatim from captured traces. These scored
  // as tickets and produced three real work items titled L12-38, L30-44 and
  // L52-71. The fixture set said 100% precision at the time, which is exactly
  // why cases drawn from real prompts belong here and not only in unit tests.
  {
    category: 'line ranges (real)',
    prompt: '`L52-71: delete: retry wrapper around an idempotent local call. Nothing replaces it.`',
    expected: [],
  },
  {
    category: 'line ranges (real)',
    prompt: '`L30-44: shrink: manual loop builds dict. dict(zip(keys, values)) is one line.`',
    expected: [],
  },
  {
    category: 'line ranges (real)',
    prompt: '`L12-38: stdlib: 27-line validator class. "@" in email is one line.`',
    expected: [],
  },
  {
    category: 'line ranges (real)',
    prompt: 'Per L30-44 of the diff, this is the fix for DDM-5101.',
    expected: ['DDM-5101'],
  },

  // 2. GitHub issue and PR URLs
  { category: 'github urls', prompt: 'See https://github.com/acme/app/issues/42 for the repro.', expected: ['acme/app#42'] },
  { category: 'github urls', prompt: 'Review https://github.com/acme/app/pull/1337 before merging.', expected: ['acme/app#1337'] },
  { category: 'github urls', prompt: 'Details at https://github.com/chuongxl/copilot-tracer/issues/7', expected: ['chuongxl/copilot-tracer#7'] },

  // 3. Multiple tickets in one prompt
  { category: 'multiple tickets', prompt: 'ABC-123 and DEF-456 both need the same fix.', expected: ['ABC-123', 'DEF-456'] },
  { category: 'multiple tickets', prompt: 'Close ABC-123 via https://github.com/acme/app/pull/88', expected: ['ABC-123', 'acme/app#88'] },

  // 4. Similar wording, different tasks. Wording alone must not group these.
  { category: 'similar wording', prompt: 'Add a project filter to the dashboard for ABC-123.', expected: ['ABC-123'] },
  { category: 'similar wording', prompt: 'Add a project filter to the reports page for DEF-456.', expected: ['DEF-456'] },
  { category: 'similar wording', prompt: 'Add a project filter to the export screen.', expected: [] },

  // 5. Follow-ups with no ticket key. These belong in the inbox, not guessed at.
  { category: 'follow-ups', prompt: 'Now make it persist across reloads.', expected: [] },
  { category: 'follow-ups', prompt: 'Same as before but for the other tab.', expected: [] },
  { category: 'follow-ups', prompt: 'Try again, that broke the tests.', expected: [] },

  // 6. Unrelated prompts sharing broad nouns
  { category: 'broad nouns', prompt: 'Explain how the dashboard loads its data.', expected: [] },
  { category: 'broad nouns', prompt: 'The dashboard is slow on large projects.', expected: [] },
  { category: 'broad nouns', prompt: 'Document the project detection logic.', expected: [] },

  // 7. Sensitive-looking values. None of these are tickets and none may leak.
  {
    category: 'sensitive values',
    prompt: 'Decode the UTF-8 payload and verify the SHA-256 digest.',
    expected: [],
    sensitive: ['UTF-8', 'SHA-256'],
  },
  {
    category: 'sensitive values',
    prompt: 'Follow RFC-2119 wording and patch CVE-2021-1234 this week.',
    expected: [],
    sensitive: ['RFC-2119', 'CVE-2021-1234'],
  },
  {
    category: 'sensitive values',
    prompt: 'My key is AKIA-1234 and the card ends 4111-1111. Fix ABC-777.',
    expected: ['ABC-777'],
    sensitive: ['AKIA-1234', '4111-1111'],
  },
  {
    category: 'sensitive values',
    prompt: 'Token sk-live-9999 must stay out of logs.',
    expected: [],
    sensitive: ['sk-live-9999'],
  },
];

let truePositives = 0;
let falsePositives = 0;
let falseNegatives = 0;
let autoLinkable = 0;
let unlinked = 0;
let promptsNeedingCorrection = 0;
let leaks = 0;

const byCategory = new Map();
const failures = [];

for (const fixture of FIXTURES) {
  const { references } = extractWorkItemEvidence(fixture.prompt);
  const found = references.map((r) => r.key);
  const expected = fixture.expected;

  const missing = expected.filter((key) => !found.includes(key));
  const spurious = found.filter((key) => !expected.includes(key));

  truePositives += expected.length - missing.length;
  falseNegatives += missing.length;
  falsePositives += spurious.length;

  if (missing.length || spurious.length) {
    promptsNeedingCorrection += 1;
    failures.push({ prompt: fixture.prompt, expected, found, missing, spurious });
  }

  if (!found.length) unlinked += 1;
  if (references.some((r) => (r.confidence ?? AUTO_LINK_CONFIDENCE) >= AUTO_LINK_CONFIDENCE)) autoLinkable += 1;

  for (const secret of fixture.sensitive ?? []) {
    if (found.some((key) => key.toLowerCase().includes(secret.toLowerCase()))) {
      leaks += 1;
      failures.push({ prompt: fixture.prompt, leak: secret });
    }
  }

  const bucket = byCategory.get(fixture.category) ?? { total: 0, correct: 0, missing: 0, spurious: 0 };
  bucket.total += 1;
  bucket.missing += missing.length;
  bucket.spurious += spurious.length;
  if (!missing.length && !spurious.length) bucket.correct += 1;
  byCategory.set(fixture.category, bucket);
}

// Auto-link acceptance only means something for prompts that carry a reference;
// the rest are supposed to land in the inbox.
const referencedFixtures = FIXTURES.filter((f) => f.expected.length > 0).length;

const ratio = (num, den) => (den === 0 ? 1 : num / den);
const precision = ratio(truePositives, truePositives + falsePositives);
const recall = ratio(truePositives, truePositives + falseNegatives);
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

const report = {
  extractorVersion: EXTRACTOR_VERSION,
  generatedAt: new Date().toISOString(),
  fixtureCount: FIXTURES.length,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  f1: Number(f1.toFixed(4)),
  autoLinkAcceptance: Number(ratio(autoLinkable, referencedFixtures).toFixed(4)),
  correctionRate: Number(ratio(promptsNeedingCorrection, FIXTURES.length).toFixed(4)),
  unlinkedRate: Number(ratio(unlinked, FIXTURES.length).toFixed(4)),
  sensitiveLeaks: leaks,
  threshold: PRECISION_THRESHOLD,
  categories: Object.fromEntries([...byCategory].map(([name, b]) => [name, {
    fixtures: b.total,
    exactlyRight: b.correct,
    missedReferences: b.missing,
    spuriousReferences: b.spurious,
  }])),
  failures,
};

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  console.log(`\nWork item grouping quality (extractor ${EXTRACTOR_VERSION})\n`);
  console.log('category              fixtures  right  missed  spurious');
  console.log('--------------------  --------  -----  ------  --------');
  for (const [name, b] of byCategory) {
    console.log(
      `${name.padEnd(20)}  ${String(b.total).padStart(8)}  ${String(b.correct).padStart(5)}  ` +
      `${String(b.missing).padStart(6)}  ${String(b.spurious).padStart(8)}`,
    );
  }
  console.log('');
  console.log(`precision            ${pct(precision)}   (threshold ${pct(PRECISION_THRESHOLD)})`);
  console.log(`recall               ${pct(recall)}`);
  console.log(`f1                   ${pct(f1)}`);
  console.log(`auto-link acceptance ${pct(report.autoLinkAcceptance)}`);
  console.log(`correction rate      ${pct(report.correctionRate)}`);
  console.log(`unlinked rate        ${pct(report.unlinkedRate)}`);
  console.log(`sensitive leaks      ${leaks}`);

  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) {
      if (f.leak) {
        console.log(`  LEAK  ${f.leak} detected as a reference in: ${f.prompt}`);
      } else {
        console.log(`  ${f.prompt}`);
        console.log(`        expected [${f.expected.join(', ')}] got [${f.found.join(', ')}]`);
      }
    }
  }
  console.log('');
}

if (leaks > 0) {
  console.error(`FAIL: ${leaks} sensitive value(s) were treated as ticket references.`);
  process.exit(1);
}
if (precision < PRECISION_THRESHOLD) {
  console.error(`FAIL: precision ${precision.toFixed(4)} is below the ${PRECISION_THRESHOLD} threshold.`);
  process.exit(1);
}
