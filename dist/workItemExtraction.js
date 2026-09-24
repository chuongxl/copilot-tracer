// Deterministic work-item evidence extraction.
//
// This module is pure: no database, no network, no clock. Everything here runs
// on the ingestion hot path, so it must stay cheap and must never throw.
export const EXTRACTOR_VERSION = '1.0.0';
export const WORK_ITEM_KINDS = [
    'feature', 'bug', 'task', 'refactor',
    'investigation', 'documentation', 'operations', 'unknown',
];
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
]);
function maskSpan(chars, start, end) {
    for (let i = start; i < end && i < chars.length; i++)
        chars[i] = ' ';
}
function normalizeRepoRef(owner, repo, num) {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}#${num}`;
}
// ── Reference extraction ──────────────────────────────────────────────────────
function extractUrlReferences(prompt, chars) {
    const found = [];
    const push = (m, ref) => {
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
function extractPlainReferences(residual) {
    const found = [];
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
        if (JIRA_PREFIX_DENYLIST.has(m[1]))
            continue;
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
    return found;
}
function dedupeReferences(located) {
    const byKey = new Map();
    for (const item of located) {
        const id = `${item.ref.type}|${item.ref.key.toLowerCase()}`;
        const prev = byKey.get(id);
        if (!prev) {
            byKey.set(id, item);
            continue;
        }
        // Keep the earliest mention so output order follows the prompt, but carry
        // over the richest evidence (a URL beats a bare key).
        const winner = {
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
const KIND_PHRASES = {
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
const KIND_PRIORITY = [
    'bug', 'investigation', 'feature', 'refactor', 'documentation', 'operations', 'task',
];
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function classifyKind(prompt) {
    const scores = new Map();
    const signals = [];
    for (const kind of KIND_PRIORITY) {
        for (const phrase of KIND_PHRASES[kind]) {
            const re = new RegExp(`(^|[^\\w])${escapeRegExp(phrase)}(?![\\w])`, 'i');
            const match = re.exec(prompt);
            if (!match)
                continue;
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
    let kind = 'unknown';
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
export function extractWorkItemEvidence(prompt) {
    const empty = {
        references: [],
        kind: 'unknown',
        signals: [],
        confidence: 0,
        extractorVersion: EXTRACTOR_VERSION,
    };
    if (typeof prompt !== 'string' || !prompt.trim())
        return empty;
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
    if (references.some((ref) => ref.confidence >= AUTO_LINK_CONFIDENCE))
        confidence += 0.6;
    if (kind !== 'unknown')
        confidence += 0.2;
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
export function deriveWorkItemSummary(prompt, maxLength = 180) {
    const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim();
    if (!flat)
        return '';
    const sentence = /^(.+?[.!?])(\s|$)/.exec(flat);
    const candidate = sentence ? sentence[1] : flat;
    if (candidate.length <= maxLength)
        return candidate;
    return `${candidate.slice(0, maxLength - 1).trimEnd()}…`;
}
export function isWorkItemKind(value) {
    return typeof value === 'string' && WORK_ITEM_KINDS.includes(value);
}
