/**
 * identark/pricing
 * ~~~~~~~~~~~~~~~~
 * Model pricing tables and cost estimation.
 *
 * Mirrors the Python SDK's dedicated `identark.pricing` module so both SDKs
 * share one source of truth per language. Cost per 1M tokens (USD) —
 * approximate; update as providers change pricing.
 */

export const OPENAI_PRICING: Record<string, Record<string, number>> = {
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
};

export const ANTHROPIC_PRICING: Record<string, Record<string, number>> = {
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
};

export const MISTRAL_PRICING: Record<string, Record<string, number>> = {
  "mistral-large-latest": { input: 2.0, output: 6.0 },
  "mistral-small-latest": { input: 0.2, output: 0.6 },
  "open-mistral-nemo": { input: 0.15, output: 0.15 },
  "codestral-latest": { input: 0.2, output: 0.6 },
};

/** Fallback rate (USD per token) for unknown models. */
export const UNKNOWN_MODEL_RATE = 0.00001;

/**
 * Estimate the USD cost of a completion.
 *
 * @param model - Model identifier (e.g. "gpt-4o")
 * @param inputTokens - Prompt tokens consumed
 * @param outputTokens - Completion tokens produced
 * @param provider - Provider name; "local" always costs 0
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  provider: string = "openai",
): number {
  if (provider === "local") {
    return 0.0;
  }
  const pricing = { ...OPENAI_PRICING, ...ANTHROPIC_PRICING, ...MISTRAL_PRICING };
  if (!(model in pricing)) {
    return (inputTokens + outputTokens) * UNKNOWN_MODEL_RATE;
  }
  const rates = pricing[model];
  if (!rates || !rates.input || !rates.output) {
    return (inputTokens + outputTokens) * UNKNOWN_MODEL_RATE;
  }
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}
