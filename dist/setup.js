/**
 * copilot-tracer setup — auto-detect Copilot/VS Code and inject OTLP env config
 *
 * What it does:
 *  1. Detect copilot CLI (which copilot)
 *  2. Detect VS Code installation + built-in copilot (v1.99+)
 *  3. Inject OTEL env vars into:
 *     - Shell profile (~/.zshrc / ~/.bashrc / ~/.zprofile)
 *     - VS Code settings.json (terminal.integrated.env.osx)
 *  4. Print a summary and next steps
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
const OTEL_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_ENDPOINT';
const OTEL_CONTENT_KEY = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
const OTEL_ENABLED_KEY = 'COPILOT_OTEL_ENABLED';
const CLAUDE_TELEMETRY_KEY = 'CLAUDE_CODE_ENABLE_TELEMETRY';
const CLAUDE_TRACES_KEY = 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA';
const OTEL_LOGS_EXPORTER_KEY = 'OTEL_LOGS_EXPORTER';
const OTEL_TRACES_EXPORTER_KEY = 'OTEL_TRACES_EXPORTER';
const OTEL_PROTOCOL_KEY = 'OTEL_EXPORTER_OTLP_PROTOCOL';
const OTEL_LOG_PROMPTS_KEY = 'OTEL_LOG_USER_PROMPTS';
const OTEL_LOG_RESPONSES_KEY = 'OTEL_LOG_ASSISTANT_RESPONSES';
function otelEnvBlock(port) {
    return [
        `# >>> copilot-tracer OTLP config (auto-added) >>>`,
        `export ${OTEL_ENDPOINT_KEY}=http://localhost:${port}`,
        `export ${OTEL_CONTENT_KEY}=true`,
        `export ${OTEL_ENABLED_KEY}=true`,
        `export ${CLAUDE_TELEMETRY_KEY}=1`,
        `export ${CLAUDE_TRACES_KEY}=1`,
        `export ${OTEL_LOGS_EXPORTER_KEY}=otlp`,
        `export ${OTEL_TRACES_EXPORTER_KEY}=otlp`,
        `export ${OTEL_PROTOCOL_KEY}=http/json`,
        `export ${OTEL_LOG_PROMPTS_KEY}=1`,
        `export ${OTEL_LOG_RESPONSES_KEY}=1`,
        ``,
        `# Tag every copilot prompt with the terminal folder it ran from, so the`,
        `# tracer can attribute it to the right project. OTLP carries no working-dir,`,
        `# so we inject it via OTEL_RESOURCE_ATTRIBUTES (percent-encoded).`,
        `copilot() {`,
        `  local _wd`,
        `  if command -v python3 >/dev/null 2>&1; then`,
        `    _wd="$(pwd | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip(), safe="/"))')"`,
        `  else`,
        `    _wd="$(pwd)"`,
        `  fi`,
        `  if [ -n "\${OTEL_RESOURCE_ATTRIBUTES:-}" ]; then`,
        `    # Drop any stale working_dir entry, then append the current folder`,
        `    OTEL_RESOURCE_ATTRIBUTES="$(printf '%s' "\$OTEL_RESOURCE_ATTRIBUTES" | sed -E 's/(^|,)github\.copilot\.working_dir=[^,]*/\\1/g; s/^,//')"`,
        `    [ -z "\$OTEL_RESOURCE_ATTRIBUTES" ] || OTEL_RESOURCE_ATTRIBUTES="\${OTEL_RESOURCE_ATTRIBUTES},"`,
        `  fi`,
        `  OTEL_RESOURCE_ATTRIBUTES="\${OTEL_RESOURCE_ATTRIBUTES}github.copilot.working_dir=\${_wd}"`,
        `  export OTEL_RESOURCE_ATTRIBUTES`,
        `  command copilot "\$@"`,
        `}`,
        ``,
        `claude() {`,
        `  local _wd`,
        `  if command -v python3 >/dev/null 2>&1; then`,
        `    _wd="$(pwd | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip(), safe="/"))')"`,
        `  else`,
        `    _wd="$(pwd)"`,
        `  fi`,
        `  if [ -n "\${OTEL_RESOURCE_ATTRIBUTES:-}" ]; then`,
        `    OTEL_RESOURCE_ATTRIBUTES="\${OTEL_RESOURCE_ATTRIBUTES},claude_code.working_dir=\${_wd}"`,
        `  else`,
        `    OTEL_RESOURCE_ATTRIBUTES="claude_code.working_dir=\${_wd}"`,
        `  fi`,
        `  export OTEL_RESOURCE_ATTRIBUTES`,
        `  command claude "\$@"`,
        `}`,
        `# <<< copilot-tracer <<<`,
    ].join('\n');
}
function vscodeEnvBlock(port) {
    return {
        [OTEL_ENDPOINT_KEY]: `http://localhost:${port}`,
        [OTEL_CONTENT_KEY]: 'true',
        [OTEL_ENABLED_KEY]: 'true',
        [CLAUDE_TELEMETRY_KEY]: '1',
        [CLAUDE_TRACES_KEY]: '1',
        [OTEL_LOGS_EXPORTER_KEY]: 'otlp',
        [OTEL_TRACES_EXPORTER_KEY]: 'otlp',
        [OTEL_PROTOCOL_KEY]: 'http/json',
        [OTEL_LOG_PROMPTS_KEY]: '1',
        [OTEL_LOG_RESPONSES_KEY]: '1',
    };
}
// ── Claude Code hooks ─────────────────────────────────────────────────────────
// OTLP alone can't correlate a multi-prompt Claude session (its logs key on prompt.id,
// its spans key on OTLP traceId, and neither is always present). Hooks give us the
// ordered turn/tool lifecycle; OTLP still supplies the token/model/cost numbers.
/** Events the tracer subscribes to, and which of them support a matcher. */
const CLAUDE_HOOK_EVENTS = [
    { event: 'SessionStart', matcher: undefined },
    { event: 'UserPromptSubmit', matcher: undefined },
    { event: 'PreToolUse', matcher: '.*' },
    { event: 'PostToolUse', matcher: '.*' },
    { event: 'PostToolUseFailure', matcher: '.*' },
    { event: 'Stop', matcher: undefined },
    { event: 'StopFailure', matcher: undefined },
    { event: 'SessionEnd', matcher: undefined },
];
export function claudeHookUrl(port) {
    return `http://localhost:${port}/claude/hook`;
}
function getClaudeSettingsPath() {
    return path.join(os.homedir(), '.claude', 'settings.json');
}
/** Our handler is identified by its URL path so we can update the port in place. */
function isTracerHandler(handler) {
    return handler?.type === 'http' && typeof handler.url === 'string' && handler.url.includes('/claude/hook');
}
function tracerHandler(port) {
    return {
        type: 'http',
        url: claudeHookUrl(port),
        // Short timeout: a hook that stalls must never hold up the user's session. A
        // timed-out http hook is cancelled and renders no decision, which is what we want.
        timeout: 5,
    };
}
/**
 * Merge the tracer's hooks into Claude's settings.
 *
 * Merging (never replacing) is mandatory — users and plugins routinely register their
 * own handlers on these same events, and clobbering them would silently break unrelated
 * tooling. We only ever add, update, or leave alone our own `/claude/hook` handler.
 */
export function patchClaudeSettings(settingsPath, port) {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf8').trim();
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    return { action: 'skipped', reason: '~/.claude/settings.json is not a JSON object' };
                }
                settings = parsed;
            }
            catch {
                // Never overwrite a file we can't understand — the user would lose their config.
                return { action: 'skipped', reason: 'could not parse ~/.claude/settings.json' };
            }
        }
    }
    // Everything below treats the user's file as untrusted: it is hand-edited, shared
    // between tools, and losing part of it would silently break their setup. Anything we
    // don't recognise is left exactly as found.
    const rawHooks = settings.hooks;
    if (rawHooks !== undefined && (typeof rawHooks !== 'object' || rawHooks === null || Array.isArray(rawHooks))) {
        return { action: 'skipped', reason: '"hooks" in ~/.claude/settings.json is not an object' };
    }
    const hooks = (rawHooks ?? {});
    let added = false;
    let updated = false;
    for (const { event, matcher } of CLAUDE_HOOK_EVENTS) {
        const rawGroups = hooks[event];
        // An unrecognised shape for this event is left untouched rather than replaced —
        // overwriting it would discard whatever the user or a plugin configured there.
        if (rawGroups !== undefined && !Array.isArray(rawGroups))
            continue;
        const groups = (rawGroups ?? []);
        const desired = tracerHandler(port);
        // Only well-formed groups are candidates for merging into.
        const usable = groups.filter((g) => !!g && typeof g === 'object' && !Array.isArray(g));
        // Find our handler wherever it already lives in this event's groups.
        const ownerGroup = usable.find(g => Array.isArray(g.hooks) && g.hooks.some(h => !!h && isTracerHandler(h)));
        if (ownerGroup) {
            const handlers = ownerGroup.hooks;
            const index = handlers.findIndex(h => !!h && isTracerHandler(h));
            if (handlers[index].url !== desired.url || handlers[index].timeout !== desired.timeout) {
                handlers[index] = { ...handlers[index], ...desired };
                updated = true;
            }
            if (matcher !== undefined && ownerGroup.matcher !== matcher) {
                ownerGroup.matcher = matcher;
                updated = true;
            }
            continue;
        }
        // Reuse an existing group with the same matcher so we don't fragment the config.
        const sameMatcher = usable.find(g => (g.matcher ?? undefined) === matcher);
        if (sameMatcher) {
            sameMatcher.hooks = [...(Array.isArray(sameMatcher.hooks) ? sameMatcher.hooks : []), desired];
        }
        else {
            const group = matcher === undefined ? { hooks: [desired] } : { matcher, hooks: [desired] };
            groups.push(group);
        }
        hooks[event] = groups;
        added = true;
    }
    if (!added && !updated)
        return { action: 'already_set' };
    settings.hooks = hooks;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    return { action: added ? 'added' : 'updated' };
}
// ── Detection helpers ─────────────────────────────────────────────────────────
function detectCopilotCli() {
    try {
        const p = execSync('which copilot', { encoding: 'utf8' }).trim();
        const v = execSync('copilot --version 2>/dev/null || true', { encoding: 'utf8' }).trim();
        return { found: true, path: p, version: v.split('\n')[0] };
    }
    catch {
        return { found: false };
    }
}
function detectVSCode() {
    try {
        const v = execSync('code --version 2>/dev/null', { encoding: 'utf8' }).trim();
        const lines = v.split('\n');
        const version = lines[0];
        const major = parseInt(version.split('.')[0], 10);
        const minor = parseInt(version.split('.')[1], 10);
        // Copilot built-in since VS Code 1.99
        const hasBuiltinCopilot = major > 1 || (major === 1 && minor >= 99);
        return { found: true, version, hasBuiltinCopilot };
    }
    catch {
        // Try app bundle directly
        const appPath = '/Applications/Visual Studio Code.app';
        if (fs.existsSync(appPath)) {
            return { found: true, hasBuiltinCopilot: true, version: 'unknown (app found)' };
        }
        return { found: false, hasBuiltinCopilot: false };
    }
}
function detectShellProfile() {
    const candidates = [
        path.join(os.homedir(), '.zshrc'),
        path.join(os.homedir(), '.zprofile'),
        path.join(os.homedir(), '.bash_profile'),
        path.join(os.homedir(), '.bashrc'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p))
            return p;
    }
    // Default to .zshrc (create it)
    return path.join(os.homedir(), '.zshrc');
}
function getVSCodeSettingsPath() {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library/Application Support/Code/User/settings.json');
    }
    // Linux (and WSL)
    return path.join(os.homedir(), '.config/Code/User/settings.json');
}
// ── Patchers ──────────────────────────────────────────────────────────────────
function patchShellProfile(profilePath, port) {
    const content = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
    const block = otelEnvBlock(port);
    // Already has our block?
    if (content.includes('copilot-tracer OTLP config')) {
        // Only skip if the embedded block is byte-identical to what we'd generate now —
        // a marker + matching port isn't enough, since the block's env vars can gain new
        // keys (e.g. Claude Code support) between tracer versions without the port changing.
        if (content.includes(block)) {
            return { action: 'already_set' };
        }
        // Block is stale (port changed, or vars were added/changed) — replace it in place
        const updated = content.replace(/# >>> copilot-tracer OTLP config[\s\S]*?# <<< copilot-tracer <<</, block);
        fs.writeFileSync(profilePath, updated, 'utf8');
        return { action: 'updated' };
    }
    // Append
    const newContent = content.trimEnd() + '\n\n' + block + '\n';
    fs.writeFileSync(profilePath, newContent, 'utf8');
    return { action: 'added' };
}
function patchVSCodeSettings(settingsPath, port) {
    if (!fs.existsSync(settingsPath)) {
        return { action: 'skipped', reason: 'settings.json not found' };
    }
    let settings;
    try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    catch {
        return { action: 'skipped', reason: 'could not parse settings.json' };
    }
    const envKey = 'terminal.integrated.env.osx';
    const existing = (settings[envKey] ?? {});
    const newEnv = vscodeEnvBlock(port);
    // Already set correctly only if every current key/value is present — checking a
    // hardcoded subset let newer keys (e.g. Claude Code support) silently go unset.
    if (Object.entries(newEnv).every(([k, v]) => existing[k] === v)) {
        return { action: 'already_set' };
    }
    const wasSet = !!existing[OTEL_ENDPOINT_KEY];
    settings[envKey] = { ...existing, ...newEnv };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    return { action: wasSet ? 'updated' : 'added' };
}
// ── Main setup ────────────────────────────────────────────────────────────────
export function runSetup(port, silent = false) {
    const CHECK = '✅';
    const WARN = '⚠️ ';
    const INFO = '📍';
    const ARROW = '→';
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║       Copilot Tracer — Auto Setup              ║');
    console.log('╚════════════════════════════════════════════════╝\n');
    // 1. Detect copilot CLI
    const cli = detectCopilotCli();
    if (cli.found) {
        console.log(`${CHECK} GitHub Copilot CLI detected`);
        console.log(`   ${INFO} Path   : ${cli.path}`);
        if (cli.version)
            console.log(`   ${INFO} Version: ${cli.version}`);
    }
    else {
        console.log(`${WARN} GitHub Copilot CLI not found`);
        console.log(`   Install: npm install -g @github/copilot`);
    }
    // 2. Detect VS Code
    const vscode = detectVSCode();
    if (vscode.found) {
        console.log(`\n${CHECK} Visual Studio Code detected`);
        if (vscode.version)
            console.log(`   ${INFO} Version: ${vscode.version}`);
        if (vscode.hasBuiltinCopilot) {
            console.log(`   ${CHECK} Built-in Copilot (v1.99+) — will be configured`);
        }
        else {
            console.log(`   ${WARN} VS Code version may not have built-in Copilot`);
        }
    }
    else {
        console.log(`\n${WARN} Visual Studio Code not found — skipping VS Code config`);
    }
    // 3. Patch shell profile
    const profilePath = detectShellProfile();
    if (profilePath) {
        const result = patchShellProfile(profilePath, port);
        const label = path.basename(profilePath);
        if (result.action === 'added') {
            console.log(`\n${CHECK} Shell profile patched: ${label}`);
            console.log(`   ${ARROW} Added Copilot + Claude Code OTLP env vars`);
            console.log(`   ${ARROW} Added copilot() wrapper — tags each prompt with the terminal folder`);
            console.log(`   ${ARROW} Run: source ${profilePath}`);
        }
        else if (result.action === 'updated') {
            console.log(`\n${CHECK} Shell profile updated: ${label}`);
            console.log(`   ${ARROW} Updated port to ${port} + Claude Code/Copilot OTLP config`);
            console.log(`   ${ARROW} Run: source ${profilePath}`);
        }
        else {
            console.log(`\n${CHECK} Shell profile: already configured (${label})`);
        }
    }
    // 4. Patch VS Code settings
    if (vscode.found) {
        const settingsPath = getVSCodeSettingsPath();
        const result = patchVSCodeSettings(settingsPath, port);
        if (result.action === 'added') {
            console.log(`\n${CHECK} VS Code settings patched`);
            console.log(`   ${ARROW} Added terminal.integrated.env.osx with OTEL vars`);
            console.log(`   ${ARROW} Restart VS Code to apply`);
        }
        else if (result.action === 'updated') {
            console.log(`\n${CHECK} VS Code settings updated`);
            console.log(`   ${ARROW} Updated port to ${port}`);
            console.log(`   ${ARROW} Restart VS Code to apply`);
        }
        else if (result.action === 'already_set') {
            console.log(`\n${CHECK} VS Code settings: already configured`);
        }
        else {
            console.log(`\n${WARN} VS Code settings: ${result.reason}`);
        }
    }
    // 5. Patch Claude Code hooks (turn/tool lifecycle — OTLP can't correlate multi-prompt sessions)
    const claudeSettingsPath = getClaudeSettingsPath();
    const claudeResult = patchClaudeSettings(claudeSettingsPath, port);
    if (claudeResult.action === 'added') {
        console.log(`\n${CHECK} Claude Code hooks installed`);
        console.log(`   ${ARROW} ~/.claude/settings.json → ${claudeHookUrl(port)}`);
        console.log(`   ${ARROW} Captures every prompt, tool call and turn (merged with your existing hooks)`);
        console.log(`   ${ARROW} Restart Claude Code to apply`);
    }
    else if (claudeResult.action === 'updated') {
        console.log(`\n${CHECK} Claude Code hooks updated`);
        console.log(`   ${ARROW} Endpoint now ${claudeHookUrl(port)}`);
        console.log(`   ${ARROW} Restart Claude Code to apply`);
    }
    else if (claudeResult.action === 'already_set') {
        console.log(`\n${CHECK} Claude Code hooks: already configured`);
    }
    else {
        console.log(`\n${WARN} Claude Code hooks: ${claudeResult.reason}`);
    }
    // 6. Apply env vars to the current process so the OTLP receiver works immediately
    process.env[OTEL_ENDPOINT_KEY] = `http://localhost:${port}`;
    process.env[OTEL_CONTENT_KEY] = 'true';
    process.env[OTEL_ENABLED_KEY] = 'true';
    process.env[CLAUDE_TELEMETRY_KEY] = '1';
    process.env[CLAUDE_TRACES_KEY] = '1';
    process.env[OTEL_LOGS_EXPORTER_KEY] = 'otlp';
    process.env[OTEL_TRACES_EXPORTER_KEY] = 'otlp';
    process.env[OTEL_PROTOCOL_KEY] = 'http/json';
    process.env[OTEL_LOG_PROMPTS_KEY] = '1';
    process.env[OTEL_LOG_RESPONSES_KEY] = '1';
    // 7. Summary
    if (!silent) {
        const profileBase = profilePath ? path.basename(profilePath) : '.zshrc';
        console.log('\n────────────────────────────────────────────────');
        console.log('  One manual step required:\n');
        console.log(`  source ~/${profileBase}`);
        console.log(`  (opens a new terminal already? — env is already active there)`);
        if (vscode.found)
            console.log('\n  Restart VS Code once to pick up the new terminal env.');
        console.log('\n  ✨ Starting tracer web UI now...');
        console.log(`  Open: http://localhost:${port}/`);
        console.log('────────────────────────────────────────────────\n');
    }
}
