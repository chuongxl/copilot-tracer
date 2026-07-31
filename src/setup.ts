/**
 * copilot-tracer setup — auto-detect copilot CLI + VS Code and inject OTLP env config
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

const OTEL_ENDPOINT_KEY   = 'OTEL_EXPORTER_OTLP_ENDPOINT';
const OTEL_CONTENT_KEY    = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
const OTEL_ENABLED_KEY    = 'COPILOT_OTEL_ENABLED';

function otelEnvBlock(port: number): string {
  return [
    `# >>> copilot-tracer OTLP config (auto-added) >>>`,
    `export ${OTEL_ENDPOINT_KEY}=http://localhost:${port}`,
    `export ${OTEL_CONTENT_KEY}=true`,
    `export ${OTEL_ENABLED_KEY}=true`,
    `# <<< copilot-tracer <<<`,
  ].join('\n');
}

function vscodeEnvBlock(port: number): Record<string, string> {
  return {
    [OTEL_ENDPOINT_KEY]: `http://localhost:${port}`,
    [OTEL_CONTENT_KEY]: 'true',
    [OTEL_ENABLED_KEY]: 'true',
  };
}

// ── Detection helpers ─────────────────────────────────────────────────────────

function detectCopilotCli(): { found: boolean; path?: string; version?: string } {
  try {
    const p = execSync('which copilot', { encoding: 'utf8' }).trim();
    const v = execSync('copilot --version 2>/dev/null || true', { encoding: 'utf8' }).trim();
    return { found: true, path: p, version: v.split('\n')[0] };
  } catch {
    return { found: false };
  }
}

function detectVSCode(): { found: boolean; path?: string; version?: string; hasBuiltinCopilot: boolean } {
  try {
    const v = execSync('code --version 2>/dev/null', { encoding: 'utf8' }).trim();
    const lines = v.split('\n');
    const version = lines[0];
    const major = parseInt(version.split('.')[0], 10);
    const minor = parseInt(version.split('.')[1], 10);
    // Copilot built-in since VS Code 1.99
    const hasBuiltinCopilot = major > 1 || (major === 1 && minor >= 99);
    return { found: true, version, hasBuiltinCopilot };
  } catch {
    // Try app bundle directly
    const appPath = '/Applications/Visual Studio Code.app';
    if (fs.existsSync(appPath)) {
      return { found: true, hasBuiltinCopilot: true, version: 'unknown (app found)' };
    }
    return { found: false, hasBuiltinCopilot: false };
  }
}

function detectShellProfile(): string | null {
  const candidates = [
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.zprofile'),
    path.join(os.homedir(), '.bash_profile'),
    path.join(os.homedir(), '.bashrc'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Default to .zshrc (create it)
  return path.join(os.homedir(), '.zshrc');
}

function getVSCodeSettingsPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/Code/User/settings.json');
  }
  // Linux (and WSL)
  return path.join(os.homedir(), '.config/Code/User/settings.json');
}

// ── Patchers ──────────────────────────────────────────────────────────────────

function patchShellProfile(profilePath: string, port: number): { action: 'added' | 'already_set' | 'updated' } {
  const content = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
  const block = otelEnvBlock(port);

  // Already has our block?
  if (content.includes('copilot-tracer OTLP config')) {
    // Check if port matches
    if (content.includes(`http://localhost:${port}`)) {
      return { action: 'already_set' };
    }
    // Port changed — update
    const updated = content.replace(
      /# >>> copilot-tracer OTLP config[\s\S]*?# <<< copilot-tracer <<</,
      block
    );
    fs.writeFileSync(profilePath, updated, 'utf8');
    return { action: 'updated' };
  }

  // Append
  const newContent = content.trimEnd() + '\n\n' + block + '\n';
  fs.writeFileSync(profilePath, newContent, 'utf8');
  return { action: 'added' };
}

function patchVSCodeSettings(settingsPath: string, port: number): { action: 'added' | 'already_set' | 'updated' | 'skipped'; reason?: string } {
  if (!fs.existsSync(settingsPath)) {
    return { action: 'skipped', reason: 'settings.json not found' };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { action: 'skipped', reason: 'could not parse settings.json' };
  }

  const envKey = 'terminal.integrated.env.osx';
  const existing = (settings[envKey] ?? {}) as Record<string, string>;
  const newEnv = vscodeEnvBlock(port);

  // Check if already set correctly
  if (
    existing[OTEL_ENDPOINT_KEY] === `http://localhost:${port}` &&
    existing[OTEL_CONTENT_KEY] === 'true' &&
    existing[OTEL_ENABLED_KEY] === 'true'
  ) {
    return { action: 'already_set' };
  }

  const wasSet = !!existing[OTEL_ENDPOINT_KEY];
  settings[envKey] = { ...existing, ...newEnv };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { action: wasSet ? 'updated' : 'added' };
}

// ── Main setup ────────────────────────────────────────────────────────────────

export function runSetup(port: number): void {
  const CHECK = '✅';
  const WARN  = '⚠️ ';
  const INFO  = '📍';
  const ARROW = '→';

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║       Copilot Tracer — Auto Setup              ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // 1. Detect copilot CLI
  const cli = detectCopilotCli();
  if (cli.found) {
    console.log(`${CHECK} GitHub Copilot CLI detected`);
    console.log(`   ${INFO} Path   : ${cli.path}`);
    if (cli.version) console.log(`   ${INFO} Version: ${cli.version}`);
  } else {
    console.log(`${WARN} GitHub Copilot CLI not found`);
    console.log(`   Install: npm install -g @github/copilot`);
  }

  // 2. Detect VS Code
  const vscode = detectVSCode();
  if (vscode.found) {
    console.log(`\n${CHECK} Visual Studio Code detected`);
    if (vscode.version) console.log(`   ${INFO} Version: ${vscode.version}`);
    if (vscode.hasBuiltinCopilot) {
      console.log(`   ${CHECK} Built-in Copilot (v1.99+) — will be configured`);
    } else {
      console.log(`   ${WARN} VS Code version may not have built-in Copilot`);
    }
  } else {
    console.log(`\n${WARN} Visual Studio Code not found — skipping VS Code config`);
  }

  // 3. Patch shell profile
  const profilePath = detectShellProfile();
  if (profilePath) {
    const result = patchShellProfile(profilePath, port);
    const label = path.basename(profilePath);
    if (result.action === 'added') {
      console.log(`\n${CHECK} Shell profile patched: ${label}`);
      console.log(`   ${ARROW} Added OTEL env vars (endpoint, content capture)`);
      console.log(`   ${ARROW} Run: source ${profilePath}`);
    } else if (result.action === 'updated') {
      console.log(`\n${CHECK} Shell profile updated: ${label}`);
      console.log(`   ${ARROW} Updated port to ${port}`);
      console.log(`   ${ARROW} Run: source ${profilePath}`);
    } else {
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
    } else if (result.action === 'updated') {
      console.log(`\n${CHECK} VS Code settings updated`);
      console.log(`   ${ARROW} Updated port to ${port}`);
      console.log(`   ${ARROW} Restart VS Code to apply`);
    } else if (result.action === 'already_set') {
      console.log(`\n${CHECK} VS Code settings: already configured`);
    } else {
      console.log(`\n${WARN} VS Code settings: ${result.reason}`);
    }
  }

  // 5. Apply env vars to the current process so the OTLP receiver works immediately
  process.env[OTEL_ENDPOINT_KEY]  = `http://localhost:${port}`;
  process.env[OTEL_CONTENT_KEY]   = 'true';
  process.env[OTEL_ENABLED_KEY]   = 'true';

  // 6. Summary
  const profileBase = profilePath ? path.basename(profilePath) : '.zshrc';
  console.log('\n────────────────────────────────────────────────');
  console.log('  One manual step required:\n');
  console.log(`  source ~/${profileBase}`);
  console.log(`  (opens a new terminal already? — env is already active there)`);
  if (vscode.found) console.log('\n  Restart VS Code once to pick up the new terminal env.');
  console.log('\n  ✨ Starting tracer web UI now...');
  console.log(`  Open: http://localhost:${port}/`);
  console.log('────────────────────────────────────────────────\n');
}
