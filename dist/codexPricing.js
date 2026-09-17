/**
 * OpenAI Codex CLI token pricing, shared by the OTLP receiver.
 *
 * Lives in its own module — mirroring claudePricing.ts's split — so otlpReceiver.ts stays
 * focused on parsing, and per-tool rate tables stay independently maintainable.
 */
// OpenAI API pricing per 1K tokens (USD), converted to GitHub "AI credit" units
// (1 credit = $0.01) so aiCredits stays one unit across Copilot/Claude/Codex entries.
// Rates are OpenAI's current published per-model prices; a model id that doesn't match a
// specific entry falls back to `default` (FR-006: every table carries a default rate so
// unrecognized models never yield a null/undefined credit calculation).
const OPENAI_USD_PER_1K = {
    'gpt-5-codex': { input: 0.00125, output: 0.010 },
    'gpt-5': { input: 0.00125, output: 0.010 },
    'gpt-5-mini': { input: 0.00025, output: 0.002 },
    'gpt-5-nano': { input: 0.00005, output: 0.0004 },
    'o3': { input: 0.002, output: 0.008 },
    'o4-mini': { input: 0.0011, output: 0.0044 },
    'gpt-4.1': { input: 0.002, output: 0.008 },
    'gpt-4o': { input: 0.0025, output: 0.010 },
    'default': { input: 0.00125, output: 0.010 },
};
export function calcCodexCredits(tokens, model) {
    const key = Object.keys(OPENAI_USD_PER_1K).find(k => (model ?? '').toLowerCase().includes(k)) ?? 'default';
    const rate = OPENAI_USD_PER_1K[key];
    const usd = (tokens.input / 1000) * rate.input + (tokens.output / 1000) * rate.output;
    return usd * 100; // USD → credits (1 credit = $0.01)
}
