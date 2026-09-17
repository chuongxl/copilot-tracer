#!/usr/bin/env node
/**
 * End-to-end verification for Codex CLI OTLP-logs tracing (T002, T012, T022).
 *
 * Runs the real daemon against a throwaway database (COPILOT_TRACER_HOME), replays a
 * synthetic Codex session over POST /v1/logs (codex.conversation_starts → codex.user_prompt →
 * codex.tool_decision → codex.turn_cost), then asserts the resulting project/session/trace,
 * tool call, token usage, and computed aiCredits (quickstart.md steps 1-3, SC-003).
 *
 * Usage: node test-codex-otlp.mjs
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = Number(process.env.TEST_PORT ?? 4792);
const BASE = `http://localhost:${PORT}`;
const SESSION = `codex-verify-${Date.now()}`;
const CWD = process.cwd();

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tracer-codex-verify-'));

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
      const res = await fetch(`${BASE}/api/dashboard`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return false;
}

function attr(key, value) {
  return typeof value === 'number'
    ? { key, value: { intValue: value } }
    : { key, value: { stringValue: String(value) } };
}

/** POST log records for a session (all sharing one turn id, unless overridden per-record). */
async function postLogs(sessionId, records, resourceAttrs = []) {
  const now = Date.now();
  const res = await fetch(`${BASE}/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceLogs: [{
        resource: { attributes: [attr('codex.session_id', sessionId), attr('codex.cwd', CWD), ...resourceAttrs] },
        scopeLogs: [{
          logRecords: records.map(r => ({ timeUnixNano: String(now * 1e6), ...r })),
        }],
      }],
    }),
  });
  if (!res.ok) throw new Error(`/v1/logs returned ${res.status}`);
  return res;
}

async function main() {
  console.log(`\n🧪 Codex CLI OTLP-logs tracing verification`);
  console.log(`   session : ${SESSION}`);
  console.log(`   db home : ${tmpHome}\n`);

  const daemon = spawn('node', ['dist/cli.js', '--daemon', '--port', String(PORT)], {
    // This branch's db.ts does not yet read COPILOT_TRACER_HOME (it always resolves
    // os.homedir()), so HOME is overridden to sandbox the SQLite DB under tmpHome; also setting
    // COPILOT_TRACER_HOME for forward-compat once that support lands.
    env: { ...process.env, HOME: tmpHome, COPILOT_TRACER_HOME: tmpHome },
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

    const TURN = `turn-${SESSION}`;

    // ── Recognized-event happy path (T012) ────────────────────────────────
    console.log('▶ Replaying a Codex turn (prompt → tool call → cost)');
    await postLogs(SESSION, [
      { attributes: [attr('event.name', 'codex.conversation_starts')] },
    ]);
    await postLogs(SESSION, [
      { attributes: [attr('event.name', 'codex.user_prompt'), attr('codex.turn_id', TURN), attr('codex.prompt', 'List the files here')] },
    ]);
    await postLogs(SESSION, [
      { attributes: [attr('event.name', 'codex.tool_decision'), attr('codex.turn_id', TURN), attr('codex.tool_name', 'shell'), attr('codex.tool_call_id', 'call-1')] },
    ]);
    const INPUT_TOKENS = 1200, OUTPUT_TOKENS = 300;
    const MODEL = 'gpt-5-codex';
    await postLogs(SESSION, [
      { attributes: [
        attr('event.name', 'codex.turn_cost'),
        attr('codex.turn_id', TURN),
        attr('gen_ai.usage.input_tokens', INPUT_TOKENS),
        attr('gen_ai.usage.output_tokens', OUTPUT_TOKENS),
        attr('gen_ai.request.model', MODEL),
      ] },
    ]);
    await sleep(300);

    const dashboard = await (await fetch(`${BASE}/api/dashboard`)).json();
    check('dashboard has at least one project', dashboard.projects.length > 0, dashboard.projects.length);

    const traces = await (await fetch(`${BASE}/api/traces?sessionId=${SESSION}`)).json();
    check('exactly one trace recorded for the session', traces.length === 1, traces.length);

    const entry = traces[0];
    check('trace id is codex-namespaced', entry?.id?.startsWith('codex:'), entry?.id);
    check('trace status is done', entry?.status === 'done', entry?.status);
    check('trace has the tool call', entry?.toolCalls?.length === 1 && entry.toolCalls[0].name === 'shell', entry?.toolCalls);
    check('tool call classified as builtin', entry?.toolCalls?.[0]?.type === 'builtin', entry?.toolCalls?.[0]?.type);
    check('token usage recorded', entry?.tokens?.input === INPUT_TOKENS && entry?.tokens?.output === OUTPUT_TOKENS, entry?.tokens);

    // T022 — cost accuracy within 1% (SC-003): gpt-5-codex is $0.00125/1K in, $0.010/1K out.
    const expectedUsd = (INPUT_TOKENS / 1000) * 0.00125 + (OUTPUT_TOKENS / 1000) * 0.010;
    const expectedCredits = expectedUsd * 100;
    const withinTolerance = Math.abs(entry?.aiCredits - expectedCredits) <= expectedCredits * 0.01;
    check('aiCredits matches hand-computed rate within 1%', withinTolerance, { got: entry?.aiCredits, expected: expectedCredits });

    // ── Unrecognized-event resilience (T011, FR-010/SC-005) ────────────────
    console.log('▶ Sending an unrecognized event alongside a recognized one');
    const TURN2 = `${TURN}-2`;
    await postLogs(SESSION, [
      { attributes: [attr('event.name', 'codex.something_unrecognized'), attr('codex.turn_id', TURN2)] },
      { attributes: [attr('event.name', 'codex.user_prompt'), attr('codex.turn_id', TURN2), attr('codex.prompt', 'Second prompt')] },
    ]);
    await sleep(300);

    const stillUp = await fetch(`${BASE}/api/dashboard`);
    check('daemon still responds after an unrecognized event', stillUp.ok, stillUp.status);

    const traces2 = await (await fetch(`${BASE}/api/traces?sessionId=${SESSION}`)).json();
    check('the recognized event in the same batch is still recorded', traces2.length === 2, traces2.length);

  } finally {
    daemon.kill('SIGTERM');
    await sleep(200);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
