// Deterministic work-item evidence extraction.
//
// This module is pure: no database, no network, no clock. Everything here runs
// on the ingestion hot path, so it must stay cheap and must never throw.

export const EXTRACTOR_VERSION = '1.0.0';

export type TicketReferenceType =
  | 'jira'
  | 'github_issue'
  | 'github_pr'
  | 'azure_devops'
  | 'linear';

export type WorkItemKind =
  | 'feature'
  | 'bug'
  | 'task'
  | 'refactor'
  | 'investigation'
  | 'performance'
  | 'documentation'
  | 'operations'
  | 'unknown';

export const WORK_ITEM_KINDS: readonly WorkItemKind[] = [
  'feature', 'bug', 'task', 'refactor',
  'investigation', 'performance', 'documentation', 'operations', 'unknown',
];

export interface TicketReference {
  type: TicketReferenceType;
  key: string;
  url: string | null;
  sourceText: string;
  confidence: number;
}

export interface WorkItemEvidence {
  references: TicketReference[];
  kind: WorkItemKind;
  signals: string[];
  confidence: number;
  extractorVersion: string;
}

/** A reference at or above this confidence is trustworthy enough to auto-group by. */
export const AUTO_LINK_CONFIDENCE = 0.8;

// Tokens that look like `PREFIX-123` but are standards, encodings or model names
// rather than ticket keys. Without this list "UTF-8" and "SHA-256" become tickets.
const JIRA_PREFIX_DENYLIST = new Set([
  'UTF', 'ISO', 'RFC', 'CVE', 'SHA', 'MD', 'IPV', 'AES', 'RSA', 'DES', 'ECDSA',
  'HTTP', 'HTTPS', 'TLS', 'SSL', 'UTC', 'GMT', 'ASCII', 'BASE',
  'MP', 'GPT', 'CLAUDE', 'LLAMA', 'ES', 'EC', 'S', 'X', 'H', 'N', 'K', 'W',
  'WCAG', 'SOC', 'PCI', 'DSS', 'FIPS', 'NIST', 'OWASP', 'GDPR', 'HIPAA',
  'COVID', 'ARM', 'AMD', 'INT', 'UINT', 'FLOAT', 'RGB', 'RGBA', 'HSL', 'CMYK',
  'USD', 'EUR', 'GBP', 'JDK', 'JRE', 'NODE', 'PY', 'IE', 'MS',
  // Credential prefixes. A leaked key fragment must never become a work item
  // title, and none of these are plausible Jira project keys.
  'AKIA', 'ASIA', 'ABIA', 'ACCA', 'AGPA', 'AIDA', 'ANPA', 'ANVA', 'APKA', 'AROA', 'ASCA',
  'GHP', 'GHO', 'GHU', 'GHS', 'GHR', 'XOXB', 'XOXP', 'XOXA', 'XOXS', 'SK', 'PK', 'BEARER',
  'TOKEN', 'SECRET', 'APIKEY', 'PASSWORD', 'PWD', 'PRIVATE',
]);

interface Located {
  index: number;
  ref: TicketReference;
}

function maskSpan(chars: string[], start: number, end: number): void {
  for (let i = start; i < end && i < chars.length; i++) chars[i] = ' ';
}

function normalizeRepoRef(owner: string, repo: string, num: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${num}`;
}

// ── Reference extraction ──────────────────────────────────────────────────────

function extractUrlReferences(prompt: string, chars: string[]): Located[] {
  const found: Located[] = [];

  const push = (m: RegExpExecArray, ref: Omit<TicketReference, 'sourceText'>) => {
    found.push({ index: m.index, ref: { ...ref, sourceText: m[0] } });
    maskSpan(chars, m.index, m.index + m[0].length);
  };

  const githubRe = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/gi;
  for (let m = githubRe.exec(prompt); m; m = githubRe.exec(prompt)) {
    push(m, {
      type: m[3].toLowerCase() === 'pull' ? 'github_pr' : 'github_issue',
      key: normalizeRepoRef(m[1], m[2], m[4]),
      url: m[0],
      confidence: 0.95,
    });
  }

  const azureRe = /https?:\/\/dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_workitems\/edit\/(\d+)/gi;
  for (let m = azureRe.exec(prompt); m; m = azureRe.exec(prompt)) {
    push(m, { type: 'azure_devops', key: `${m[1]}/${m[2]}#${m[3]}`, url: m[0], confidence: 0.95 });
  }

  const vstsRe = /https?:\/\/([\w-]+)\.visualstudio\.com\/([^/\s]+)\/_workitems\/edit\/(\d+)/gi;
  for (let m = vstsRe.exec(prompt); m; m = vstsRe.exec(prompt)) {
    push(m, { type: 'azure_devops', key: `${m[1]}/${m[2]}#${m[3]}`, url: m[0], confidence: 0.95 });
  }

  const linearRe = /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/gi;
  for (let m = linearRe.exec(prompt); m; m = linearRe.exec(prompt)) {
    push(m, { type: 'linear', key: m[1].toUpperCase(), url: m[0], confidence: 0.95 });
  }

  const jiraUrlRe = /https?:\/\/[\w.-]+(?::\d+)?\/browse\/([A-Za-z][A-Za-z0-9]{1,9}-\d+)/gi;
  for (let m = jiraUrlRe.exec(prompt); m; m = jiraUrlRe.exec(prompt)) {
    push(m, { type: 'jira', key: m[1].toUpperCase(), url: m[0], confidence: 0.95 });
  }

  return found;
}

/** A bare `#42` carries no repo, so it is recorded as evidence but never auto-groups. */
export const BARE_ISSUE_CONFIDENCE = 0.6;

// `#42` also spells a CSS colour and a heading anchor. Rather than guess, the
// bare form scores below AUTO_LINK_CONFIDENCE so it shows as a suggestion.
const COLOR_CONTEXT_RE = /(colou?r|background|bg|fill|stroke|border|shadow|hex)\s*[:=]?\s*$/i;

function extractPlainReferences(residual: string): Located[] {
  const found: Located[] = [];

  const shorthandRe = /\b([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
  for (let m = shorthandRe.exec(residual); m; m = shorthandRe.exec(residual)) {
    found.push({
      index: m.index,
      ref: {
        type: 'github_issue',
        key: normalizeRepoRef(m[1], m[2], m[3]),
        url: null,
        sourceText: m[0],
        confidence: 0.85,
      },
    });
  }

  const jiraRe = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
  for (let m = jiraRe.exec(residual); m; m = jiraRe.exec(residual)) {
    if (JIRA_PREFIX_DENYLIST.has(m[1])) continue;
    found.push({
      index: m.index,
      ref: {
        type: 'jira',
        key: `${m[1]}-${m[2]}`,
        url: null,
        sourceText: m[0],
        confidence: 0.8,
      },
    });
  }

  // Bare `#42`. The leading class rejects `owner/repo#42` (already matched
  // above) and `#42a5f5`, which the digit-only body also excludes.
  const bareIssueRe = /(^|[^\w/#.-])#(\d{1,5})(?![\w-])/g;
  for (let m = bareIssueRe.exec(residual); m; m = bareIssueRe.exec(residual)) {
    const at = m.index + m[1].length;
    if (COLOR_CONTEXT_RE.test(residual.slice(Math.max(0, at - 16), at))) continue;
    found.push({
      index: at,
      ref: {
        type: 'github_issue',
        key: `#${m[2]}`,
        url: null,
        sourceText: `#${m[2]}`,
        confidence: BARE_ISSUE_CONFIDENCE,
      },
    });
  }

  return found;
}

function dedupeReferences(located: Located[]): TicketReference[] {
  const byKey = new Map<string, Located>();

  for (const item of located) {
    const id = `${item.ref.type}|${item.ref.key.toLowerCase()}`;
    const prev = byKey.get(id);
    if (!prev) {
      byKey.set(id, item);
      continue;
    }
    // Keep the earliest mention so output order follows the prompt, but carry
    // over the richest evidence (a URL beats a bare key).
    const winner: Located = {
      index: Math.min(prev.index, item.index),
      ref: {
        ...prev.ref,
        url: prev.ref.url ?? item.ref.url,
        confidence: Math.max(prev.ref.confidence, item.ref.confidence),
        sourceText: prev.index <= item.index ? prev.ref.sourceText : item.ref.sourceText,
      },
    };
    byKey.set(id, winner);
  }

  return [...byKey.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.ref);
}

// ── Work kind classification ──────────────────────────────────────────────────

const KIND_PHRASES: Record<Exclude<WorkItemKind, 'unknown'>, string[]> = {
  bug: [
    'fix', 'fixes', 'fixed', 'bug', 'broken', 'crash', 'crashes', 'crashing',
    'error', 'errors', 'exception', 'regression', 'defect', 'fails', 'failing',
    'failure', 'not working', "doesn't work", 'does not work', 'stack trace',
    'traceback', 'hotfix',
  ],
  feature: [
    'add', 'adds', 'adding', 'implement', 'implements', 'implementing',
    'create', 'creates', 'build', 'support', 'new feature', 'introduce',
    'enable', 'allow', 'feature',
  ],
  investigation: [
    'why', 'investigate', 'debug', 'root cause', 'analyze', 'analyse',
    'explain', 'understand', 'look into', 'diagnose', 'how come',
    'figure out', 'what causes',
  ],
  refactor: [
    'refactor', 'clean up', 'cleanup', 'simplify', 'rename', 'restructure',
    'tech debt', 'modernize', 'deduplicate',
  ],
  performance: [
    'slow', 'slower', 'slowness', 'sluggish', 'latency', 'optimize', 'optimise',
    'optimization', 'optimisation', 'performance', 'perf', 'speed up', 'speedup',
    'bottleneck', 'memory leak', 'throughput', 'p95', 'p99', 'profiling', 'profile',
    'timing out', 'times out', 'too slow',
  ],
  documentation: [
    'document', 'documentation', 'docs', 'readme', 'changelog', 'write up', 'adr',
  ],
  operations: [
    'deploy', 'release', 'publish', 'rollback', 'pipeline', 'infra',
    'docker', 'kubernetes', 'monitoring', 'alerting', 'bump version', 'migrate',
  ],
  task: [
    'chore', 'update dependency', 'bump', 'configure', 'setup', 'set up',
    'install', 'upgrade',
  ],
};

// Checked in order so a tie resolves to the more actionable classification.
const KIND_PRIORITY: Exclude<WorkItemKind, 'unknown'>[] = [
  'bug', 'performance', 'investigation', 'feature', 'refactor',
  'documentation', 'operations', 'task',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classifyKind(prompt: string): { kind: WorkItemKind; signals: string[] } {
  const scores = new Map<WorkItemKind, number>();
  const signals: string[] = [];

  for (const kind of KIND_PRIORITY) {
    for (const phrase of KIND_PHRASES[kind]) {
      const re = new RegExp(`(^|[^\\w])${escapeRegExp(phrase)}(?![\\w])`, 'i');
      const match = re.exec(prompt);
      if (!match) continue;

      // A phrase opening the prompt states the intent; the same word buried in
      // a later clause is much weaker evidence.
      const leading = match.index === 0;
      scores.set(kind, (scores.get(kind) ?? 0) + (leading ? 3 : 1));
      signals.push(`${kind}:${phrase}`);
    }
  }

  if (prompt.trimEnd().endsWith('?')) {
    scores.set('investigation', (scores.get('investigation') ?? 0) + 1);
    signals.push('investigation:question');
  }

  let kind: WorkItemKind = 'unknown';
  let best = 0;
  for (const candidate of KIND_PRIORITY) {
    const score = scores.get(candidate) ?? 0;
    if (score > best) {
      best = score;
      kind = candidate;
    }
  }

  return { kind, signals };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function extractWorkItemEvidence(prompt: string): WorkItemEvidence {
  const empty: WorkItemEvidence = {
    references: [],
    kind: 'unknown',
    signals: [],
    confidence: 0,
    extractorVersion: EXTRACTOR_VERSION,
  };

  if (typeof prompt !== 'string' || !prompt.trim()) return empty;

  const chars = prompt.split('');
  const located = extractUrlReferences(prompt, chars);

  // Blank out every remaining URL so a path segment like /AB-12/ is not read as
  // a Jira key. Masking preserves offsets, so indices still line up.
  const anyUrlRe = /https?:\/\/[^\s<>()"'\][]+/gi;
  for (let m = anyUrlRe.exec(prompt); m; m = anyUrlRe.exec(prompt)) {
    maskSpan(chars, m.index, m.index + m[0].length);
  }

  located.push(...extractPlainReferences(chars.join('')));

  const references = dedupeReferences(located);
  const { kind, signals } = classifyKind(prompt);

  let confidence = 0.2;
  if (references.some((ref) => ref.confidence >= AUTO_LINK_CONFIDENCE)) confidence += 0.6;
  if (kind !== 'unknown') confidence += 0.2;

  return {
    references,
    kind,
    signals,
    confidence: Math.min(1, Number(confidence.toFixed(2))),
    extractorVersion: EXTRACTOR_VERSION,
  };
}

/**
 * Condense a prompt into a one-line summary for a generated work item.
 * Uses the first sentence so the result stays readable and predictable.
 */
export function deriveWorkItemSummary(prompt: string, maxLength = 180): string {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';

  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat);
  const candidate = sentence ? sentence[1] : flat;
  if (candidate.length <= maxLength) return candidate;
  return `${candidate.slice(0, maxLength - 1).trimEnd()}…`;
}

export function isWorkItemKind(value: unknown): value is WorkItemKind {
  return typeof value === 'string' && (WORK_ITEM_KINDS as readonly string[]).includes(value);
}

// ── Draft generation ──────────────────────────────────────────────────────────
//
// Builds a title, summary and acceptance criteria from the prompts already
// linked to a work item. Deterministic sentence selection, no model call: the
// same prompts always produce the same draft, which is what makes the output
// safe to regenerate over a user's edits without surprising them.

export const DRAFT_GENERATOR_VERSION = '1.0.0';

export interface WorkItemDraft {
  title: string;
  summary: string;
  acceptanceCriteria: string[];
  kind: WorkItemKind;
  source: 'prompt';
  generatorVersion: string;
  promptCount: number;
}

export interface DraftInputPrompt {
  prompt: string;
  dateTime?: string;
}

const CRITERIA_HEADING = /^\s*(acceptance criteria|requirements?|criteria|definition of done|must have)\s*:?\s*$/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const OBLIGATION = /\b(must|should|needs? to|has to|have to|required to|expected to)\b/i;

function cleanLine(line: string): string {
  return line.replace(/\s+/g, ' ').replace(/^[\s>]+/, '').trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => cleanLine(s))
    .filter(Boolean);
}

/**
 * Pull acceptance criteria out of prompt text. Two sources, in priority order:
 * bullets under an "Acceptance criteria" style heading, then any line stating
 * an obligation. Both are literal excerpts, never paraphrased.
 */
function collectCriteria(prompt: string): string[] {
  const lines = prompt.split('\n');
  const headed: string[] = [];
  const obligations: string[] = [];
  let inSection = false;

  for (const rawLine of lines) {
    const line = cleanLine(rawLine);

    if (CRITERIA_HEADING.test(rawLine)) {
      inSection = true;
      continue;
    }

    const bullet = BULLET.exec(rawLine);

    if (inSection) {
      // A blank line or a non-bullet paragraph ends the section.
      if (!line) continue;
      if (bullet) { headed.push(cleanLine(bullet[1])); continue; }
      inSection = false;
    }

    if (!line) continue;

    if (bullet && OBLIGATION.test(bullet[1])) {
      obligations.push(cleanLine(bullet[1]));
    } else if (!bullet && OBLIGATION.test(line)) {
      for (const sentence of splitSentences(line)) {
        if (OBLIGATION.test(sentence)) obligations.push(sentence);
      }
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [...headed, ...obligations]) {
    const text = candidate.replace(/[.;]+$/, '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** The first sentence that states intent, preferred over a bare greeting. */
function pickObjective(prompt: string): string {
  const paragraph = prompt
    .split('\n')
    .map(cleanLine)
    .find((line) => line && !CRITERIA_HEADING.test(line) && !BULLET.test(line));

  if (!paragraph) return cleanLine(prompt);
  return splitSentences(paragraph)[0] ?? paragraph;
}

function titleCaseFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Drop the conversational lead-in people put in front of a requirement.
 *
 * "PAY-412 follow-up: the expired card should stay visible" carries the ticket
 * key and a connector that mean nothing once the line sits under that ticket's
 * work item. The requirement itself is what belongs in the criteria list.
 */
function stripLeadIn(criterion: string): string {
  const stripped = criterion.replace(
    /^(?:for\s+|re:?\s+|on\s+)?[A-Z][A-Z0-9]{1,9}-\d+\s*(?:follow[- ]?up|update|part\s*\d+)?\s*[:,-]\s*/i,
    '',
  );
  const out = stripped.trim() || criterion.trim();
  return titleCaseFirst(out);
}

/** Normalize a criterion for duplicate detection: strip filler and punctuation. */
function criterionKey(criterion: string): string {
  return criterion
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(remember|please|also|note|again|and|the|a|an|that|to)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function generateWorkItemDraft(prompts: DraftInputPrompt[]): WorkItemDraft {
  const texts = (prompts ?? [])
    .map((p) => String(p?.prompt ?? ''))
    .filter((t) => t.trim());

  const empty: WorkItemDraft = {
    title: '',
    summary: '',
    acceptanceCriteria: [],
    kind: 'unknown',
    source: 'prompt',
    generatorVersion: DRAFT_GENERATOR_VERSION,
    promptCount: 0,
  };
  if (!texts.length) return empty;

  // The first prompt states the objective; later ones refine it. Criteria are
  // gathered from all of them because requirements often arrive piecemeal.
  const objective = pickObjective(texts[0]);
  const criteria: string[] = [];
  const keys: string[] = [];
  // The objective becomes the summary, so repeating it as a criterion is noise.
  // It usually states an obligation, which is exactly why it would be picked up.
  const objectiveKey = criterionKey(objective);

  for (const text of texts) {
    for (const rawCriterion of collectCriteria(text)) {
      const criterion = stripLeadIn(rawCriterion);
      const key = criterionKey(criterion);
      if (!key || key === objectiveKey) continue;
      // The same requirement often reappears with a lead-in ("Remember, the API
      // should …"), so an exact-match set is not enough. If one normalized form
      // contains the other, keep the shorter, more canonical phrasing.
      const clashIndex = keys.findIndex((k) => k === key || k.includes(key) || key.includes(k));
      if (clashIndex >= 0) {
        if (key.length < keys[clashIndex].length) {
          keys[clashIndex] = key;
          criteria[clashIndex] = criterion;
        }
        continue;
      }
      keys.push(key);
      criteria.push(criterion);
    }
  }

  // Kind is a majority vote across prompts; a single stray word should not
  // reclassify a work item that five prompts agree is a bug.
  const votes = new Map<WorkItemKind, number>();
  for (const text of texts) {
    const { kind } = extractWorkItemEvidence(text);
    if (kind !== 'unknown') votes.set(kind, (votes.get(kind) ?? 0) + 1);
  }
  let kind: WorkItemKind = 'unknown';
  let best = 0;
  for (const [candidate, count] of votes) {
    if (count > best) { best = count; kind = candidate; }
  }

  const followUp = texts.length > 1
    ? ` Refined across ${texts.length} prompts.`
    : '';

  return {
    title: truncate(titleCaseFirst(objective.replace(/[.!?]+$/, '')), 120),
    summary: truncate(titleCaseFirst(objective) + followUp, 400),
    acceptanceCriteria: criteria.slice(0, 20),
    kind,
    source: 'prompt',
    generatorVersion: DRAFT_GENERATOR_VERSION,
    promptCount: texts.length,
  };
}
