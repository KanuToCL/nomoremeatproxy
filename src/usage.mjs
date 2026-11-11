// One shape for what each vendor reports about a call's token use.
//   totalTokens        everything the model processed for the call: the fixed load of
//                      instructions and tool definitions, the thread so far, and the output
//   cachedInputTokens  the part of the input that was served from the vendor's cache
//   outputTokens       what the model wrote, thinking included
//   reasoningTokens    the thinking part of the output
//   listPriceUsd       Claude only: the vendor's list-price figure, not a charge on a subscription
const count = (value) => (Number.isFinite(value) ? value : 0);

export function claudeUsage(result) {
  const usage = result?.usage;
  if (!usage) return null;
  const cached = count(usage.cache_read_input_tokens);
  const output = count(usage.output_tokens);
  return {
    totalTokens: count(usage.input_tokens) + cached + count(usage.cache_creation_input_tokens) + output,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: count(usage.output_tokens_details?.thinking_tokens),
    ...(Number.isFinite(result.total_cost_usd) ? { listPriceUsd: result.total_cost_usd } : {}),
  };
}

const CODEX_FIELDS = Object.freeze(['totalTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']);

const minus = (a, b) => Object.fromEntries(CODEX_FIELDS.map((field) => [field, count(a?.[field]) - count(b?.[field])]));

// Codex reports a running total for the thread together with the latest increment. The state
// of the thread just before a turn is therefore the first report's total minus its increment.
export function codexBaseline(tokenUsage) {
  return minus(tokenUsage.total, tokenUsage.last);
}

// A turn's use: how far the thread's total grew past that baseline.
export function codexUsage(baseline, total) {
  if (!baseline || !total) return null;
  const grown = minus(total, baseline);
  return {
    totalTokens: grown.totalTokens,
    cachedInputTokens: grown.cachedInputTokens,
    outputTokens: grown.outputTokens,
    reasoningTokens: grown.reasoningOutputTokens,
  };
}
