/**
 * Anthropic token pricing, shared by the OTLP receiver and the Claude hook tracker.
 *
 * Lives in its own module so `claudeSession.ts` and `otlpReceiver.ts` can both use it
 * without importing each other (they reference each other in the hybrid hook+OTLP flow).
 */
// Anthropic API pricing per 1K tokens (USD), converted to GitHub "AI credit" units
// (1 credit = $0.01) so aiCredits stays one unit across Copilot and Claude entries.
// Rates are Anthropic's current published per-model prices; a model id that doesn't
// match a specific entry falls back to its tier's (opus/sonnet/haiku) latest rate.
const ANTHROPIC_USD_PER_1K = {
    'claude-fable-5': { input: 0.010, output: 0.050 },
    'claude-mythos-5': { input: 0.010, output: 0.050 },
    'claude-opus-5': { input: 0.005, output: 0.025 },
    'claude-opus-4-8': { input: 0.005, output: 0.025 },
    'claude-opus-4-7': { input: 0.005, output: 0.025 },
    'claude-opus-4-6': { input: 0.005, output: 0.025 },
    'claude-sonnet-5': { input: 0.002, output: 0.010 },
    'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
    'claude-haiku-4-5': { input: 0.001, output: 0.005 },
    'opus': { input: 0.005, output: 0.025 },
    'sonnet': { input: 0.003, output: 0.015 },
    'haiku': { input: 0.001, output: 0.005 },
    'default': { input: 0.003, output: 0.015 },
};
export function calcClaudeCredits(tokens, model) {
    const key = Object.keys(ANTHROPIC_USD_PER_1K).find(k => (model ?? '').toLowerCase().includes(k)) ?? 'default';
    const rate = ANTHROPIC_USD_PER_1K[key];
    const usd = (tokens.input / 1000) * rate.input + (tokens.output / 1000) * rate.output;
    return usd * 100; // USD → credits (1 credit = $0.01)
}
