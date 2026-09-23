/**
 * identark/pricing
 * ~~~~~~~~~~~~~~~~
 * LLM token pricing tables with support for external overrides.
 *
 * Mirrors the Python SDK's dedicated `identark.pricing` module so both SDKs
 * share one source of truth per language. Cost per 1M tokens (USD) —
 * approximate; update as providers change pricing.
 *
 * Pricing can be customized via:
 * 1. Environment variable: `IDENTARK_PRICING_URL` (fetched by `initPricing()`)
 * 2. Local file: `~/.identark/pricing.json`
 * 3. Programmatic override: `setPricingTable()`
 *
 * Falls back to bundled defaults if no override is found.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Cost of a model in USD per 1M tokens. */
export interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
}

export const OPENAI_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  o1: { input: 15.0, output: 60.0 },
  "o1-mini": { input: 3.0, output: 12.0 },
};

export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
};

export const MISTRAL_PRICING: Record<string, ModelPricing> = {
  "mistral-large-latest": { input: 2.0, output: 6.0 },
  "mistral-small-latest": { input: 0.2, output: 0.6 },
  "open-mistral-nemo": { input: 0.15, output: 0.15 },
  "codestral-latest": { input: 0.2, output: 0.6 },
};

export const GEMINI_PRICING: Record<string, ModelPricing> = {
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash-exp": { input: 0.1, output: 0.4 },
};

/** Bundled defaults — updated periodically with SDK releases. */
export const BUNDLED_PRICING: Record<string, ModelPricing> = {
  ...OPENAI_PRICING,
  ...ANTHROPIC_PRICING,
  ...MISTRAL_PRICING,
  ...GEMINI_PRICING,
};

/** Fallback rate (USD per token) for unknown models. */
export const UNKNOWN_MODEL_RATE = 0.00001;

/** Timeout for a remote pricing fetch, in milliseconds. */
const REMOTE_FETCH_TIMEOUT_MS = 5000;

// Active pricing table — starts as bundled, can be overridden.
let pricingTable: Record<string, ModelPricing> = { ...BUNDLED_PRICING };
let initialized = false;

/** Load pricing from `~/.identark/pricing.json` if it exists. */
function loadLocalOverrides(): Record<string, ModelPricing> | undefined {
  const configPath = join(homedir(), ".identark", "pricing.json");
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, ModelPricing>;
  } catch (error) {
    console.warn(`identark.pricing: failed to load ${configPath}: ${String(error)}`);
    return undefined;
  }
}

/** Fetch pricing from a remote URL (best-effort — never throws). */
async function fetchRemotePricing(url: string): Promise<Record<string, ModelPricing> | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as Record<string, ModelPricing>;
  } catch (error) {
    console.warn(`identark.pricing: failed to fetch pricing from ${url}: ${String(error)}`);
    return undefined;
  }
}

/**
 * Apply the overrides reachable without async I/O.
 *
 * Priority is `IDENTARK_PRICING_URL` > `~/.identark/pricing.json` > bundled.
 * Node has no synchronous HTTP primitive, so when a pricing URL is configured
 * this leaves the table on bundled defaults — and deliberately does *not* mark
 * initialization as done — so that a later `initPricing()` can still apply the
 * remote table. The lower-priority local file is never consulted in that case,
 * matching the Python SDK's `elif` branch.
 */
function initializeSync(): void {
  if (initialized || process.env.IDENTARK_PRICING_URL) {
    return;
  }
  const local = loadLocalOverrides();
  if (local) {
    pricingTable = { ...BUNDLED_PRICING, ...local };
  }
  initialized = true;
}

/**
 * Initialize the pricing table, including the remote `IDENTARK_PRICING_URL`.
 *
 * Call this once at startup if you use `IDENTARK_PRICING_URL`; the local-file
 * and `setPricingTable()` overrides need no such call. A no-op once the table
 * has been initialized. Never throws — a failed fetch leaves bundled defaults.
 */
export async function initPricing(): Promise<void> {
  if (initialized) {
    return;
  }
  const url = process.env.IDENTARK_PRICING_URL;
  if (url) {
    const remote = await fetchRemotePricing(url);
    if (remote) {
      pricingTable = { ...BUNDLED_PRICING, ...remote };
    }
  } else {
    const local = loadLocalOverrides();
    if (local) {
      pricingTable = { ...BUNDLED_PRICING, ...local };
    }
  }
  initialized = true;
}

/**
 * Get pricing for a model, or `undefined` if unknown.
 *
 * @param model - Model identifier (e.g. "gpt-4o")
 */
export function getPricing(model: string): ModelPricing | undefined {
  initializeSync();
  // `hasOwn` keeps inherited members ("toString", "constructor", ...) from
  // resolving as models, matching Python's `dict.get`.
  return Object.hasOwn(pricingTable, model) ? pricingTable[model] : undefined;
}

/**
 * Programmatically override the pricing table.
 *
 * Entries are merged over the bundled defaults, so unlisted models stay
 * resolvable. This also completes initialization, so any `IDENTARK_PRICING_URL`
 * or `~/.identark/pricing.json` override is skipped from here on.
 *
 * @param table - Model identifier to pricing, merged over the bundled defaults
 */
export function setPricingTable(table: Record<string, ModelPricing>): void {
  pricingTable = { ...BUNDLED_PRICING, ...table };
  initialized = true;
}

/** Return the list of models with known pricing. */
export function listKnownModels(): string[] {
  initializeSync();
  return Object.keys(pricingTable);
}

/**
 * Estimate the USD cost of a completion.
 *
 * Returns 0 for local providers (Ollama, self-hosted models) and a
 * conservative estimate for unknown models.
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
  const pricing = getPricing(model);
  if (pricing === undefined) {
    return (inputTokens + outputTokens) * UNKNOWN_MODEL_RATE;
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
