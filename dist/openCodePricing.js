/**
 * OpenCode model pricing.
 *
 * OpenCode is provider-agnostic (Anthropic, OpenAI, and others depending on how the user
 * configured it), so unlike Copilot/Claude Code — which only ever run models from one
 * catalog — a single flat rate table has to cover whatever model the user pointed OpenCode
 * at. Rates are expressed in GitHub "AI credits" (1 credit = $0.01 USD), matching the
 * convention used for Copilot pricing in `proxy.ts`.
 *
 * A model id that matches nothing below falls back to token-counts-only display with zero
 * cost (FR-004, spec Edge Cases) rather than fabricating a rate.
 */
// Credits per 1K tokens, keyed by a lowercase substring of the model id (matched via
// `Object.keys(...).find(k => model.includes(k))`, same pattern as `proxy.ts`).
const CREDITS_PER_1K = {
    // Anthropic (Claude family)
    'claude-opus': { input: 1.5, output: 7.5 },
    'claude-sonnet': { input: 0.3, output: 1.5 },
    'claude-haiku': { input: 0.025, output: 0.125 },
    // OpenAI
    'gpt-5-mini': { input: 0.1, output: 0.4 },
    'gpt-5': { input: 0.5, output: 1.5 },
    'gpt-4.1': { input: 0.2, output: 0.8 },
    'gpt-4o-mini': { input: 0.015, output: 0.06 },
    'gpt-4o': { input: 0.25, output: 1.0 },
    'o4-mini': { input: 0.11, output: 0.44 },
    'o3': { input: 0.2, output: 0.8 },
    // Google
    'gemini-2.0-flash': { input: 0.01, output: 0.04 },
    'gemini-1.5-pro': { input: 0.125, output: 0.5 },
};
function findRate(model) {
    const key = Object.keys(CREDITS_PER_1K).find(k => model.includes(k));
    return key ? CREDITS_PER_1K[key] : undefined;
}
export function calcOpenCodeCredits(tokens, model) {
    if (!model)
        return 0;
    const rate = findRate(model.toLowerCase());
    // Unknown model: token counts are still recorded on the trace, but cost is
    // intentionally left at zero rather than guessed (FR-004).
    if (!rate)
        return 0;
    return (tokens.input / 1000) * rate.input + (tokens.output / 1000) * rate.output;
}
