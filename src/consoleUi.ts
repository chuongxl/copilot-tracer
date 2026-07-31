import chalk from 'chalk';
import Table from 'cli-table3';
import { format } from 'date-fns';
import type { TraceEntry, SessionSummary } from './types.js';

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCredits(c: number): string {
  return `${c.toFixed(2)} cr`;
}

function statusColor(status: TraceEntry['status'], text: string): string {
  if (status === 'running') return chalk.yellow(text);
  if (status === 'error') return chalk.red(text);
  return chalk.green(text);
}

export function renderConsoleTable(entries: TraceEntry[], summary?: SessionSummary): void {
  console.clear();

  const table = new Table({
    head: [
      chalk.cyan('Date / Time'),
      chalk.cyan('Prompt'),
      chalk.cyan('AI Credits'),
      chalk.cyan('Duration'),
      chalk.cyan('Tokens\nCached|Written|Reason'),
      chalk.cyan('Skills'),
      chalk.cyan('Agents'),
      chalk.cyan('MCPs'),
    ],
    colWidths: [20, 40, 12, 10, 26, 8, 8, 8],
    style: { head: [], border: ['grey'] },
    wordWrap: true,
  });

  // TOTALS row (right after header)
  if (summary) {
    const t = summary.totalTokens;
    table.push([
      chalk.bold.white('TOTALS'),
      chalk.bold.white(`${summary.totalEntries} prompts`),
      chalk.bold.yellow(fmtCredits(summary.totalCredits)),
      chalk.bold.white(fmtDuration(summary.totalDurationMs)),
      chalk.bold.white(`${t.cached} | ${t.written} | ${t.reasoning}`),
      chalk.bold.magenta(String(summary.totalSkillCalls)),
      chalk.bold.blue(String(summary.totalAgentCalls)),
      chalk.bold.cyan(String(summary.totalMcpCalls)),
    ]);

    // divider
    table.push([{ colSpan: 8, content: chalk.grey('─'.repeat(130)) }]);
  }

  // Data rows
  for (const e of entries) {
    const dt = format(new Date(e.dateTime), 'MM-dd HH:mm:ss');
    const tokenStr = `${e.tokens.cached} | ${e.tokens.written} | ${e.tokens.reasoning}`;
    const tools = e.toolCalls.map(c => c.name).join(', ');

    table.push([
      statusColor(e.status, dt),
      truncate(e.prompt, 38),
      chalk.yellow(fmtCredits(e.aiCredits)),
      fmtDuration(e.durationMs),
      tokenStr + (tools ? chalk.grey(`\n[${truncate(tools, 22)}]`) : ''),
      chalk.magenta(String(e.skillCount)),
      chalk.blue(String(e.agentCount)),
      chalk.cyan(String(e.mcpCount)),
    ]);
  }

  console.log(chalk.bold.white('\n  🤖  COPILOT TRACER — Real-time Monitor\n'));
  console.log(table.toString());
  console.log(chalk.grey(`  Last updated: ${format(new Date(), 'HH:mm:ss')}  |  DB: ~/.copilot-tracer/traces.db\n`));
}
