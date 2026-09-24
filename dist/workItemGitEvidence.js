/**
 * Local git evidence for work items.
 *
 * Reads the branch, recent commits and remote URL of a checkout with bounded,
 * read-only git commands. Everything here can fail for ordinary reasons (no
 * checkout, no path recorded, a repo that has no commits yet), so failure is a
 * normal result carried in `error`, never a thrown exception.
 *
 * This only ever reads. It never marks a work item complete on its own: a
 * commit mentioning a ticket says work happened, not that it is finished.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
export const GIT_EVIDENCE_VERSION = '1.0.0';
const GIT_TIMEOUT_MS = 5_000;
const COMMIT_LIMIT = 50;
function emptyEvidence(projectPath, error) {
    return {
        ok: false,
        error,
        projectPath,
        branch: null,
        remoteUrl: null,
        commits: [],
        collectedAt: new Date().toISOString(),
        version: GIT_EVIDENCE_VERSION,
    };
}
function git(args, cwd) {
    return execFileSync('git', args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
    }).trim();
}
/** Read branch, remote and recent commits from a checkout. Never throws. */
export function collectGitEvidence(projectPath) {
    if (!projectPath || !projectPath.trim()) {
        return emptyEvidence(null, 'No local path recorded for this project. Projects detected from a repository URL have no checkout on this machine.');
    }
    const cwd = projectPath.trim();
    if (!fs.existsSync(cwd)) {
        return emptyEvidence(cwd, `Path not found: ${cwd}`);
    }
    try {
        git(['rev-parse', '--is-inside-work-tree'], cwd);
    }
    catch {
        return emptyEvidence(cwd, `Not a git repository: ${cwd}`);
    }
    let branch = null;
    try {
        branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || null;
    }
    catch {
        branch = null;
    }
    let remoteUrl = null;
    try {
        remoteUrl = git(['config', '--get', 'remote.origin.url'], cwd) || null;
    }
    catch {
        remoteUrl = null;
    }
    const commits = [];
    try {
        // A unit separator keeps subjects containing pipes or tabs intact.
        const raw = git(['log', `-${COMMIT_LIMIT}`, '--no-merges', '--date=iso-strict', '--pretty=format:%H\u001f%an\u001f%ad\u001f%s'], cwd);
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            const [hash, author, dateTime, ...rest] = line.split('\u001f');
            commits.push({ hash, author, dateTime, subject: rest.join('\u001f') });
        }
    }
    catch (error) {
        const evidence = emptyEvidence(cwd, `Could not read commit history: ${error.message}`);
        evidence.branch = branch;
        evidence.remoteUrl = remoteUrl;
        return evidence;
    }
    return {
        ok: true,
        error: null,
        projectPath: cwd,
        branch,
        remoteUrl,
        commits,
        collectedAt: new Date().toISOString(),
        version: GIT_EVIDENCE_VERSION,
    };
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Narrow repository evidence to one work item by matching its ticket keys.
 *
 * A GitHub reference like `acme/app#42` is matched on the `#42` part, because
 * that is what people actually type in a commit message.
 */
export function matchEvidenceToKeys(evidence, keys) {
    const needles = keys
        .map((key) => key.trim())
        .filter(Boolean)
        .flatMap((key) => (key.includes('#') ? [key, `#${key.split('#').pop()}`] : [key]));
    const patterns = needles.map((needle) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(needle)}([^A-Za-z0-9]|$)`, 'i'));
    const matched = new Set();
    const commits = needles.length
        ? evidence.commits.filter((commit) => patterns.some((pattern, i) => {
            if (!pattern.test(commit.subject))
                return false;
            matched.add(needles[i]);
            return true;
        }))
        : [];
    const branchMatches = Boolean(evidence.branch && patterns.some((p) => p.test(evidence.branch)));
    return {
        ok: evidence.ok,
        error: evidence.error,
        projectPath: evidence.projectPath,
        branch: evidence.branch,
        branchMatches,
        remoteUrl: evidence.remoteUrl,
        commits,
        matchedKeys: [...matched],
        collectedAt: evidence.collectedAt,
        version: evidence.version,
    };
}
