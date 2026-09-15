#!/usr/bin/env node
/**
 * End-to-end verification for Claude Code hybrid tracing (hooks + OTLP).
 *
 * Reproduces the bug this feature fixes: a Claude session with several prompts used to
 * land as a single trace (only the first prompt), losing later prompts, their tool
 * calls and their token usage.
 *
 * Runs the real daemon against a throwaway database (COPILOT_TRACER_HOME), replays a
 * two-prompt session as Claude Code would emit it — hook events for the lifecycle,
 * OTLP spans for token usage — then asserts the stored traces.
 *
 * Usage: node test-claude-hooks.mjs
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { patchClaudeSettings } from './dist/setup.js';

const PORT = Number(process.env.TEST_PORT ?? 4791);
const BASE = `http://localhost:${PORT}`;
const SESSION = `claude-verify-${Date.now()}`;
const PROMPT_1 = `${SESSION}-prompt-1`;
const PROMPT_2 = `${SESSION}-prompt-2`;
const OOO_SESSION = `${SESSION}-ooo`;
const CWD = process.cwd();

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tracer-verify-'));

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — got: ${JSON.stringify(detail)}` : ''}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/claude/hook/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return false;
}

async function hook(body) {
  const res = await fetch(`${BASE}/claude/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: SESSION, cwd: CWD, ...body }),
  });
  if (res.status !== 204) throw new Error(`hook ${body.hook_event_name} returned ${res.status}, expected 204`);
}

function attr(key, value) {
  return typeof value === 'number'
    ? { key, value: { intValue: value } }
    : { key, value: { stringValue: String(value) } };
}

/** POST log records for a session. */
async function postLogs(sessionId, records) {
  const now = Date.now();
  const res = await fetch(`${BASE}/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceLogs: [{
        resource: { attributes: [attr('session.id', sessionId)] },
        scopeLogs: [{
          logRecords: records.map(r => ({ timeUnixNano: String(now * 1e6), ...r })),
        }],
      }],
    }),
  });
  if (!res.ok) throw new Error(`/v1/logs returned ${res.status}`);
}

/** POST arbitrary spans for a session. */
async function postSpans(sessionId, spans) {
  const now = Date.now();
  const payload = {
    resourceSpans: [{
      resource: { attributes: [attr('session.id', sessionId)] },
      scopeSpans: [{
        spans: spans.map(s => ({
          traceId: 'bb'.repeat(16),
          spanId: Math.random().toString(16).slice(2).padEnd(16, '0'),
          startTimeUnixNano: String(now * 1e6),
          endTimeUnixNano: String((now + 500) * 1e6),
          ...s,
        })),
      }],
    }],
  };
  const res = await fetch(`${BASE}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`/v1/traces returned ${res.status}`);
}

/** One iteration of Claude's agentic loop. */
async function llmRequest(promptId, input, output, model = 'claude-opus-5', sessionId = SESSION) {
  const now = Date.now();
  const payload = {
    resourceSpans: [{
      resource: { attributes: [attr('session.id', sessionId)] },
      scopeSpans: [{
        spans: [{
          traceId: 'aa'.repeat(16),
          spanId: Math.random().toString(16).slice(2).padEnd(16, '0'),
          name: 'claude_code.llm_request',
          startTimeUnixNano: String(now * 1e6),
          endTimeUnixNano: String((now + 500) * 1e6),
          attributes: [
            attr('session.id', sessionId),
            attr('prompt.id', promptId),
            attr('input_tokens', input),
            attr('output_tokens', output),
            attr('cache_read_tokens', 10),
            attr('model', model),
          ],
        }],
      }],
    }],
  };
  const res = await fetch(`${BASE}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`/v1/traces returned ${res.status}`);
}

/**
 * Claude's OTLP exporter batches spans, so a turn's usage can reach the daemon before
 * the hook that creates the turn. The tracker buffers usage rather than dropping it.
 */
async function verifyOutOfOrderUsage() {
  const promptId = `${SESSION}-prompt-3`;
  // SessionStart fires before any model request in a real session, which is what puts
  // the session into hook-authoritative mode ahead of the usage spans.
  await hook({ hook_event_name: 'SessionStart', session_id: OOO_SESSION, source: 'startup' });
  await llmRequest(promptId, 4242, 42, 'claude-opus-5', OOO_SESSION);   // usage first…
  await sleep(100);
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: OOO_SESSION, prompt_id: promptId, prompt: 'Out of order prompt' });
  await hook({ hook_event_name: 'Stop', session_id: OOO_SESSION, prompt_id: promptId, last_assistant_message: 'ok' });
  await sleep(200);

  const res = await fetch(`${BASE}/api/traces?sessionId=${encodeURIComponent(OOO_SESSION)}`);
  const traces = await res.json();
  check('out-of-order usage does not create a duplicate trace', traces.length === 1, traces.length);
  const t3 = traces.find(t => t.prompt === 'Out of order prompt');
  check('usage arriving before its prompt hook is buffered, not dropped',
    !!t3 && t3.tokens.input === 4242 && t3.tokens.output === 42,
    t3?.tokens);
}

/** The Copilot path must be untouched by the Claude changes. */
async function verifyCopilotUnaffected() {
  const copilotSession = `${SESSION}-copilot`;
  await postSpans(copilotSession, [{
    name: 'invoke_agent',
    attributes: [
      attr('gen_ai.input.messages', 'Copilot prompt'),
      attr('gen_ai.usage.input_tokens', 321),
      attr('gen_ai.usage.output_tokens', 21),
      attr('gen_ai.request.model', 'gpt-5'),
    ],
  }]);
  await sleep(200);

  const res = await fetch(`${BASE}/api/traces?sessionId=${encodeURIComponent(copilotSession)}`);
  const traces = await res.json();
  check('Copilot invoke_agent spans still produce a trace', traces.length === 1, traces.length);
  check('Copilot token usage is unchanged', traces[0]?.tokens.input === 321, traces[0]?.tokens);
}

/**
 * Regression checks for correlation bugs found in review. Each of these is a real
 * ordering Claude Code can produce.
 */
async function verifyCorrelationEdgeCases() {
  const s = `${SESSION}-edge`;
  const h = body => hook({ session_id: s, ...body });
  await h({ hook_event_name: 'SessionStart', source: 'startup' });

  // A resubmitted prompt re-fires UserPromptSubmit with the same prompt_id.
  await h({ hook_event_name: 'UserPromptSubmit', prompt_id: 'e1', prompt: 'Edge prompt one' });
  await h({ hook_event_name: 'UserPromptSubmit', prompt_id: 'e1', prompt: 'Edge prompt one' });

  await h({ hook_event_name: 'PreToolUse', prompt_id: 'e1', tool_use_id: 'e-t1', tool_name: 'Read', tool_input: { file: 'a' } });
  await h({ hook_event_name: 'Stop', prompt_id: 'e1', last_assistant_message: 'one done' });

  // Next turn starts, and only then does turn one's PostToolUse straggle in.
  await h({ hook_event_name: 'UserPromptSubmit', prompt_id: 'e2', prompt: 'Edge prompt two' });
  await h({ hook_event_name: 'PostToolUse', prompt_id: 'e1', tool_use_id: 'e-t1', tool_name: 'Read', tool_input: { file: 'a' }, tool_response: 'contents' });

  // The same tool called twice with identical input and no tool_use_id.
  await h({ hook_event_name: 'PreToolUse', prompt_id: 'e2', tool_name: 'Bash', tool_input: { command: 'pwd' } });
  await h({ hook_event_name: 'PostToolUse', prompt_id: 'e2', tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_response: '/tmp' });
  await h({ hook_event_name: 'PreToolUse', prompt_id: 'e2', tool_name: 'Bash', tool_input: { command: 'pwd' } });
  await h({ hook_event_name: 'PostToolUse', prompt_id: 'e2', tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_response: '/tmp' });

  // The turn fails, then the OTLP assistant_response arrives to backfill text.
  await h({ hook_event_name: 'StopFailure', prompt_id: 'e2', reason: 'rate_limit' });
  await postLogs(s, [{
    attributes: [
      attr('event.name', 'claude_code.assistant_response'),
      attr('session.id', s),
      attr('prompt.id', 'e2'),
      attr('response', 'partial answer'),
    ],
  }]);
  await sleep(250);

  const traces = await (await fetch(`${BASE}/api/traces?sessionId=${encodeURIComponent(s)}`)).json();
  const e1 = traces.find(t => t.prompt === 'Edge prompt one');
  const e2 = traces.find(t => t.prompt === 'Edge prompt two');

  check('a resubmitted prompt reuses its turn instead of duplicating it', traces.length === 2, traces.map(t => t.prompt));
  check('a straggling PostToolUse lands on its own turn, not the next one',
    e1?.toolCalls.length === 1 && !!e1.toolCalls[0].endedAt,
    { turn1: e1?.toolCalls.length, turn2: e2?.toolCalls.map(c => c.name) });
  check('repeated identical tool calls are recorded separately',
    e2?.toolCalls.filter(c => c.name === 'Bash').length === 2,
    e2?.toolCalls.map(c => c.name));
  check('a failed turn is not downgraded to done by a later response event',
    e2?.status === 'error', e2?.status);
  check('the response text is still backfilled onto the failed turn',
    e2?.response === 'partial answer', e2?.response);
}

/** The receiver must answer 204 even for input it cannot parse. */
async function verifyMalformedRequestIsSafe() {
  const res = await fetch(`${BASE}/claude/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ this is not json',
  });
  check('a malformed hook body still gets "no decision" (204)', res.status === 204, res.status);

  const empty = await fetch(`${BASE}/claude/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check('an unrecognised hook payload is ignored safely', empty.status === 204, empty.status);
}

/** Malformed user config must be left alone, never rewritten. */
function verifyMalformedSettingsPreserved() {
  const file = path.join(tmpHome, 'claude-settings-bad.json');

  fs.writeFileSync(file, '{ not valid json');
  const bad = patchClaudeSettings(file, PORT);
  check('unparseable settings are skipped, not overwritten', bad.action === 'skipped', bad);
  check('unparseable settings file is left byte-identical',
    fs.readFileSync(file, 'utf8') === '{ not valid json');

  // `hooks` present but the wrong shape — must not be replaced.
  const weird = path.join(tmpHome, 'claude-settings-weird.json');
  fs.writeFileSync(weird, JSON.stringify({ hooks: { Stop: { legacy: true } } }));
  patchClaudeSettings(weird, PORT);
  const after = JSON.parse(fs.readFileSync(weird, 'utf8'));
  check('an unrecognised per-event hook shape is preserved',
    after.hooks.Stop?.legacy === true, after.hooks.Stop);
  check('other events are still configured alongside it',
    JSON.stringify(after.hooks.UserPromptSubmit).includes('/claude/hook'));
}

async function verifyLegacySession(legacySession) {
  const res = await fetch(`${BASE}/api/traces?sessionId=${encodeURIComponent(legacySession)}`);
  const traces = await res.json();
  check('OTLP-only session still produces a trace (fallback intact)', traces.length === 1, traces.length);
  if (traces[0]) {
    check('OTLP-only trace keeps its prompt', traces[0].prompt === 'Legacy prompt', traces[0].prompt);
    check('OTLP-only trace keeps its tokens', traces[0].tokens.input === 700, traces[0].tokens);
  }
}

/**
 * `--setup` writes into the user's real ~/.claude/settings.json, where unrelated hooks
 * from the user and from plugins already live. Clobbering them would silently break
 * other tooling, so verify the merge preserves everything it finds.
 */
function verifySettingsMerge() {
  const file = path.join(tmpHome, 'claude-settings.json');
  const preExisting = {
    model: 'opus',
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo existing' }] }],
      PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'lint.sh' }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(preExisting, null, 2));

  patchClaudeSettings(file, PORT);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));

  check('setup preserves unrelated settings keys', after.model === 'opus', after.model);
  check('setup preserves a pre-existing UserPromptSubmit hook',
    JSON.stringify(after.hooks.UserPromptSubmit).includes('echo existing'));
  check('setup preserves a pre-existing PostToolUse hook',
    JSON.stringify(after.hooks.PostToolUse).includes('lint.sh'));
  check('setup adds the tracer hook to UserPromptSubmit',
    JSON.stringify(after.hooks.UserPromptSubmit).includes(`:${PORT}/claude/hook`));
  check('setup subscribes to every lifecycle event',
    ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd']
      .every(e => JSON.stringify(after.hooks[e] ?? []).includes('/claude/hook')),
    Object.keys(after.hooks));

  // Running setup twice must be a no-op, not a duplicate-hook generator.
  const second = patchClaudeSettings(file, PORT);
  check('setup is idempotent', second.action === 'already_set', second);

  const rerun = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tracerHandlers = JSON.stringify(rerun.hooks.Stop).split('/claude/hook').length - 1;
  check('setup does not duplicate handlers on re-run', tracerHandlers === 1, tracerHandlers);

  // A port change should update in place rather than append a second endpoint.
  patchClaudeSettings(file, PORT + 1);
  const repointed = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('setup repoints an existing hook when the port changes',
    JSON.stringify(repointed.hooks.Stop).includes(`:${PORT + 1}/claude/hook`)
    && !JSON.stringify(repointed.hooks.Stop).includes(`:${PORT}/claude/hook`),
    repointed.hooks.Stop);
}

async function main() {
  console.log(`\n🧪 Claude hybrid tracing verification`);
  console.log(`   session : ${SESSION}`);
  console.log(`   db home : ${tmpHome}\n`);

  const daemon = spawn('node', ['dist/cli.js', '--daemon', '--port', String(PORT)], {
    env: { ...process.env, COPILOT_TRACER_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let daemonLog = '';
  daemon.stdout.on('data', d => { daemonLog += d; });
  daemon.stderr.on('data', d => { daemonLog += d; });

  try {
    if (!await waitForServer()) {
      console.error('Daemon did not start. Output:\n' + daemonLog);
      process.exit(1);
    }

    // ── Turn 1: prompt → two tool calls → two model-loop iterations → stop ──
    console.log('▶ Replaying turn 1 (2 tools, 2 model iterations)');
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt_id: PROMPT_1, prompt: 'First prompt' });
    await hook({ hook_event_name: 'PreToolUse', prompt_id: PROMPT_1, tool_use_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await llmRequest(PROMPT_1, 1000, 100);
    await hook({ hook_event_name: 'PostToolUse', prompt_id: PROMPT_1, tool_use_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'file.txt' });
    await hook({ hook_event_name: 'PreToolUse', prompt_id: PROMPT_1, tool_use_id: 't2', tool_name: 'mcp__graft__ask', tool_input: { q: 'x' } });
    await hook({ hook_event_name: 'PostToolUse', prompt_id: PROMPT_1, tool_use_id: 't2', tool_name: 'mcp__graft__ask', tool_input: { q: 'x' }, tool_response: 'ok' });
    await llmRequest(PROMPT_1, 2000, 200);
    await hook({ hook_event_name: 'Stop', prompt_id: PROMPT_1, last_assistant_message: 'Done with first.' });

    // ── Turn 2: the turn that used to be dropped entirely ──────────────────
    console.log('▶ Replaying turn 2 (1 subagent tool, 1 model iteration)');
    await hook({ hook_event_name: 'UserPromptSubmit', prompt_id: PROMPT_2, prompt: 'Second prompt' });
    await hook({ hook_event_name: 'PreToolUse', prompt_id: PROMPT_2, tool_use_id: 't3', tool_name: 'Task', tool_input: { agent: 'explore' } });
    await hook({ hook_event_name: 'PostToolUse', prompt_id: PROMPT_2, tool_use_id: 't3', tool_name: 'Task', tool_input: { agent: 'explore' }, tool_response: 'found' });
    await llmRequest(PROMPT_2, 500, 50);
    await hook({ hook_event_name: 'Stop', prompt_id: PROMPT_2, last_assistant_message: 'Done with second.' });

    await hook({ hook_event_name: 'SessionEnd', reason: 'other' });
    await sleep(300);

    // ── Regression guard: sessions WITHOUT hooks must keep the old OTLP-only path ──
    // Older Claude versions, hooks disabled, or remote sessions never post hook events.
    console.log('▶ Replaying an OTLP-only session (no hooks configured)');
    const legacySession = `${SESSION}-legacy`;
    await postSpans(legacySession, [{
      name: 'claude_code.interaction',
      attributes: [
        attr('session.id', legacySession),
        attr('user_prompt', 'Legacy prompt'),
        attr('input_tokens', 700),
        attr('output_tokens', 70),
        attr('model', 'claude-opus-5'),
      ],
    }]);
    await sleep(200);

    // ── Assertions ──────────────────────────────────────────────────────────
    const res = await fetch(`${BASE}/api/traces?sessionId=${encodeURIComponent(SESSION)}`);
    const traces = await res.json();
    const byPrompt = Object.fromEntries(traces.map(t => [t.prompt, t]));

    console.log('\n📋 Results');
    check('both prompts produced their own trace', traces.length === 2, traces.map(t => t.prompt));

    const t1 = byPrompt['First prompt'];
    const t2 = byPrompt['Second prompt'];

    check('turn 1 trace exists', !!t1);
    check('turn 2 trace exists (the prompt that used to be lost)', !!t2);

    if (t1) {
      check('turn 1 captured both tool calls', t1.toolCalls.length === 2, t1.toolCalls.map(c => c.name));
      check('turn 1 classified the MCP tool', t1.mcpCount === 1, t1.mcpCount);
      check('turn 1 tool calls all completed', t1.toolCalls.every(c => c.endedAt), t1.toolCalls);
      check('turn 1 recorded tool input', t1.toolCalls.some(c => c.input?.command === 'ls'), t1.toolCalls.map(c => c.input));
      check('turn 1 summed both model iterations (3000 in / 300 out)',
        t1.tokens.input === 3000 && t1.tokens.output === 300,
        t1.tokens);
      check('turn 1 total matches the codebase convention (input + output)',
        t1.tokens.total === 3300, t1.tokens);
      check('turn 1 has credits', t1.aiCredits > 0, t1.aiCredits);
      check('turn 1 captured the response', t1.response === 'Done with first.', t1.response);
      check('turn 1 is done', t1.status === 'done', t1.status);
    }

    if (t2) {
      check('turn 2 captured its tool call', t2.toolCalls.length === 1, t2.toolCalls.map(c => c.name));
      check('turn 2 classified the subagent tool', t2.agentCount === 1, t2.agentCount);
      check('turn 2 kept its own token usage (500 in / 50 out)',
        t2.tokens.input === 500 && t2.tokens.output === 50,
        t2.tokens);
      check('turn 2 captured the response', t2.response === 'Done with second.', t2.response);
      check('turn 2 is done', t2.status === 'done', t2.status);
    }

    console.log('');
    await verifyLegacySession(legacySession);
    await verifyOutOfOrderUsage();
    await verifyCorrelationEdgeCases();
    await verifyMalformedRequestIsSafe();
    verifyMalformedSettingsPreserved();
    await verifyCopilotUnaffected();
    verifySettingsMerge();

    console.log('');
    if (failures > 0) {
      console.log(`❌ ${failures} check(s) failed\n`);
      console.log('--- daemon output ---\n' + daemonLog);
      process.exitCode = 1;
    } else {
      console.log('✅ All checks passed\n');
    }
  } finally {
    daemon.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.exit(1);
});
