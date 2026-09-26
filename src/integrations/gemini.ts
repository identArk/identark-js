/**
 * identark/integrations/gemini
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * Google Gemini integration — IdentArkGeminiGateway.
 *
 * Native integration with Google's Gemini API using the `@google/generative-ai`
 * SDK. Supports multimodal inputs, function calling, and cost tracking.
 *
 * The SDK is an optional peer dependency:
 *
 *     npm install @google/generative-ai
 *
 * @example
 * ```typescript
 * import { GeminiGateway } from "identark/integrations/gemini";
 * import { Role } from "identark";
 *
 * const gateway = new GeminiGateway({
 *   apiKey: "your-gemini-api-key",
 *   model: "gemini-1.5-pro",
 * });
 *
 * const response = await gateway.invokeLlm([
 *   { role: Role.USER, content: "Hello, Gemini!" },
 * ]);
 * console.log(response.message.content);
 * console.log(`Cost: $${response.cost_usd.toFixed(6)}`);
 * ```
 */

import { createRequire } from "module";
import { mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import type { AgentGateway } from "../gateway.js";
import type {
  LLMResponse,
  Message,
  PresignedURL,
  StreamChunk,
  ToolCall,
} from "../types.js";
import { Role } from "../types.js";
import {
  ConfigurationError,
  ContentPolicyError,
  CostCapExceededError,
  PathNotAllowedError,
  ProviderError,
  RateLimitError,
} from "../errors.js";

// Gemini pricing per 1M tokens (USD) — as of 2024
// See: https://ai.google.dev/pricing
const GEMINI_INTEGRATION_PRICING: Record<string, { input: number; output: number }> = {
  // Gemini 1.5 Pro
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-1.5-pro-latest": { input: 1.25, output: 5.0 },
  "gemini-1.5-pro-002": { input: 1.25, output: 5.0 },
  // Gemini 1.5 Flash
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-flash-latest": { input: 0.075, output: 0.3 },
  "gemini-1.5-flash-002": { input: 0.075, output: 0.3 },
  // Gemini 1.5 Flash-8B (cheapest)
  "gemini-1.5-flash-8b": { input: 0.0375, output: 0.15 },
  "gemini-1.5-flash-8b-latest": { input: 0.0375, output: 0.15 },
  // Gemini 2.0 Flash (experimental)
  "gemini-2.0-flash-exp": { input: 0.1, output: 0.4 },
  // Gemini 1.0 Pro (legacy)
  "gemini-1.0-pro": { input: 0.5, output: 1.5 },
  "gemini-pro": { input: 0.5, output: 1.5 },
};

/** Own-property lookup, so model names like "constructor" never hit `Object.prototype`. */
function hasRates(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(GEMINI_INTEGRATION_PRICING, model);
}

/**
 * Estimate cost in USD for a Gemini model.
 *
 * Unknown models fall back to prefix matching, then to flash pricing as a
 * conservative estimate.
 */
export function estimateGeminiCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Normalize model name
  let modelKey = model.toLowerCase();
  if (!hasRates(modelKey)) {
    // Try prefix matching
    const match = Object.keys(GEMINI_INTEGRATION_PRICING).find((key) =>
      modelKey.startsWith(key.replace("-latest", "").replace("-002", "")),
    );
    if (match !== undefined) {
      modelKey = match;
    } else {
      // Unknown model — use flash pricing as conservative estimate
      console.warn(`identark.integrations.gemini: unknown Gemini model ${model}, using flash pricing`);
      modelKey = "gemini-1.5-flash";
    }
  }

  const rates = GEMINI_INTEGRATION_PRICING[modelKey]!;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

/** Convert an IdentArk role to a Gemini role. */
export function convertRoleToGemini(role: Role): string {
  switch (role) {
    case Role.USER:
      return "user";
    case Role.ASSISTANT:
      return "model";
    case Role.SYSTEM:
      return "user"; // Gemini handles system via systemInstruction
    case Role.TOOL:
      return "function";
    default:
      return "user";
  }
}

/** A Gemini function declaration. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Convert OpenAI-format tools to Gemini function declarations. */
export function convertToolsToGemini(
  tools: Record<string, unknown>[],
): GeminiFunctionDeclaration[] {
  const geminiTools: GeminiFunctionDeclaration[] = [];
  for (const tool of tools) {
    if (tool.type === "function") {
      const func = tool.function as Record<string, unknown>;
      geminiTools.push({
        name: func.name as string,
        description: (func.description as string | undefined) ?? "",
        parameters: (func.parameters as Record<string, unknown> | undefined) ?? {
          type: "object",
          properties: {},
        },
      });
    }
  }
  return geminiTools;
}

// Gemini finish reasons, keyed by both the numeric enum (as in the Python SDK)
// and the string enum the JS SDK returns.
const FINISH_REASON_MAP: Record<string, string> = {
  "0": "stop", // FINISH_REASON_UNSPECIFIED
  "1": "stop", // STOP
  "2": "length", // MAX_TOKENS
  "3": "tool_calls", // TOOL
  "4": "content_filter", // SAFETY
  "5": "recitation", // RECITATION
  FINISH_REASON_UNSPECIFIED: "stop",
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "recitation",
};

// ── Structural types for the optional `@google/generative-ai` SDK ────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type GeminiPart = Record<string, any>;

/** The subset of `GoogleGenerativeAI` this gateway uses. */
export interface GeminiClientLike {
  getGenerativeModel(params: Record<string, unknown>): {
    startChat(params: Record<string, unknown>): {
      sendMessage(content: GeminiPart[]): Promise<{ response: any }>;
      sendMessageStream(content: GeminiPart[]): Promise<{ stream: AsyncIterable<any> }>;
    };
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Options for {@link GeminiGateway}. */
export interface GeminiGatewayOptions {
  /** Your Google AI API key (from https://aistudio.google.com). */
  apiKey: string;
  /** Gemini model identifier e.g. 'gemini-1.5-pro'. Defaults to 'gemini-1.5-pro'. */
  model?: string;
  /** Optional system instruction prepended to every conversation. */
  systemPrompt?: string;
  /** Optional soft cost cap. Raises CostCapExceededError when exceeded. */
  costCapUsd?: number;
  /** Local directory for file operations. Defaults to '/workspace'. */
  workspaceDir?: string;
  /** Optional Gemini safety settings. */
  safetySettings?: Record<string, unknown>[] | Record<string, unknown>;
  /** Optional Gemini generation config. */
  generationConfig?: Record<string, unknown>;
  /**
   * Optional pre-built `GoogleGenerativeAI` client. When omitted, the gateway
   * loads `@google/generative-ai` and builds one from `apiKey`.
   */
  client?: GeminiClientLike;
}

/** Load `@google/generative-ai` synchronously, so construction stays sync as in Python. */
function loadGeminiClient(apiKey: string): GeminiClientLike {
  let mod: { GoogleGenerativeAI: new (apiKey: string) => GeminiClientLike };
  try {
    mod = createRequire(import.meta.url)("@google/generative-ai");
  } catch {
    throw new ConfigurationError(
      "@google/generative-ai package not installed. Run: npm install @google/generative-ai",
    );
  }
  return new mod.GoogleGenerativeAI(apiKey);
}

/**
 * Native Google Gemini implementation of AgentGateway.
 *
 * Uses the `@google/generative-ai` SDK directly for optimal performance and
 * access to Gemini-specific features like multimodal inputs and grounding.
 * Keeps conversation history in memory and resolves /workspace/ file paths to
 * the local filesystem.
 */
export class GeminiGateway implements AgentGateway {
  private modelName: string;
  private costCap?: number;
  private workspace: string;
  private model: ReturnType<GeminiClientLike["getGenerativeModel"]>;
  private history: Message[] = [];
  private totalCost: number = 0.0;

  /**
   * Create a new GeminiGateway instance.
   *
   * @throws ConfigurationError - If apiKey or model is empty, or the SDK is missing.
   */
  constructor(options: GeminiGatewayOptions) {
    const {
      apiKey,
      model = "gemini-1.5-pro",
      systemPrompt,
      costCapUsd,
      workspaceDir = "/workspace",
      safetySettings,
      generationConfig,
      client,
    } = options;

    if (!apiKey) {
      throw new ConfigurationError("apiKey must be provided for GeminiGateway.");
    }
    if (!model) {
      throw new ConfigurationError("model must be a non-empty string.");
    }

    const genAI = client ?? loadGeminiClient(apiKey);

    this.modelName = model;
    if (costCapUsd !== undefined) {
      this.costCap = costCapUsd;
    }
    this.workspace = workspaceDir;

    // Create model instance
    const modelParams: Record<string, unknown> = { model };
    if (systemPrompt) {
      modelParams.systemInstruction = systemPrompt;
    }
    if (safetySettings) {
      modelParams.safetySettings = safetySettings;
    }
    if (generationConfig) {
      modelParams.generationConfig = generationConfig;
    }

    this.model = genAI.getGenerativeModel(modelParams);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send new messages to Gemini and receive a response.
   */
  async invokeLlm(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    _toolChoice: string | Record<string, unknown> = "auto",
  ): Promise<LLMResponse> {
    this._checkCostCap();

    const geminiHistory = this._buildGeminiHistory();
    const geminiContent = this._messagesToGeminiContent(newMessages);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any;
    try {
      const chat = this.model.startChat(this._chatParams(geminiHistory, tools));
      const result = await chat.sendMessage(geminiContent);
      response = result.response;
    } catch (exc) {
      this._classifyGeminiError(exc);
    }

    const result = this._parseGeminiResponse(response);

    this.totalCost += result.cost_usd;
    this.history.push(...newMessages);
    this.history.push(result.message);

    return result;
  }

  /**
   * Persist messages to conversation history without calling the LLM.
   */
  async persistMessages(messages: Message[]): Promise<void> {
    this.history.push(...messages);
  }

  /**
   * Return a local file:// URL for the given workspace path.
   */
  async requestFileUrl(filePath: string, method: string = "PUT"): Promise<PresignedURL> {
    const resolved = this._resolveWorkspacePath(filePath);
    if (method === "PUT") {
      await mkdir(dirname(resolved), { recursive: true });
    }

    const now = new Date();
    const expiry = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59).toISOString();

    return {
      url: `file://${resolved}`,
      expires_at: expiry,
      method,
      file_path: filePath,
    };
  }

  /**
   * Return total accumulated cost in USD for this gateway instance.
   */
  async getSessionCost(): Promise<number> {
    return this.totalCost;
  }

  /**
   * Stream the LLM response token by token.
   *
   * Yields StreamChunk objects as they arrive. The final chunk has
   * `finish_reason` set and token counts populated.
   */
  async *invokeLlmStream(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    _toolChoice: string | Record<string, unknown> = "auto",
  ): AsyncGenerator<StreamChunk> {
    this._checkCostCap();

    const geminiHistory = this._buildGeminiHistory();
    const geminiContent = this._messagesToGeminiContent(newMessages);

    try {
      const chat = this.model.startChat(this._chatParams(geminiHistory, tools));
      const { stream } = await chat.sendMessageStream(geminiContent);

      let fullContent = "";
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream) {
        // Extract text from chunk
        const parts: GeminiPart[] = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.text) {
            fullContent += part.text;
            yield {
              content: part.text,
              finish_reason: null,
              model: this.modelName,
            };
          }
        }

        // Check for usage metadata on final chunk
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
        }
      }

      // Emit final chunk with usage info
      this.totalCost += estimateGeminiCost(this.modelName, inputTokens, outputTokens);

      // Persist to history
      this.history.push(...newMessages);
      this.history.push({ role: Role.ASSISTANT, content: fullContent });

      yield {
        content: "",
        finish_reason: "stop",
        model: this.modelName,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      };
    } catch (exc) {
      this._classifyGeminiError(exc);
    }
  }

  /**
   * Clear conversation history and reset cost counter.
   */
  reset(): void {
    this.history = [];
    this.totalCost = 0.0;
  }

  /**
   * Read-only view of the conversation history.
   */
  getHistory(): Message[] {
    return [...this.history];
  }

  /**
   * The model identifier this gateway is configured to use.
   */
  getModel(): string {
    return this.modelName;
  }

  /**
   * The provider string.
   */
  getProvider(): string {
    return "google";
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _checkCostCap(): void {
    if (this.costCap !== undefined && this.totalCost >= this.costCap) {
      throw new CostCapExceededError(
        `GeminiGateway cost cap of $${this.costCap.toFixed(4)} reached. Accumulated: $${this.totalCost.toFixed(4)}. Call gateway.reset() to start fresh.`,
        this.costCap,
        this.totalCost,
      );
    }
  }

  private _resolveWorkspacePath(filePath: string): string {
    if (!filePath.startsWith("/workspace/")) {
      throw new PathNotAllowedError(filePath);
    }
    const relative = filePath.slice("/workspace/".length);
    return resolve(this.workspace, relative);
  }

  private _chatParams(
    history: GeminiPart[],
    tools: Record<string, unknown>[] | undefined,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = { history };
    if (tools && tools.length > 0) {
      params.tools = [{ functionDeclarations: convertToolsToGemini(tools) }];
    }
    return params;
  }

  /** Convert internal history to Gemini format. */
  private _buildGeminiHistory(): GeminiPart[] {
    return this.history.map((msg) => {
      const role = convertRoleToGemini(msg.role);
      if (role === "function") {
        // Tool result
        return {
          role: "function",
          parts: [
            {
              functionResponse: {
                name: msg.tool_call_id || "tool",
                response: { result: msg.content },
              },
            },
          ],
        };
      }
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return { role, parts: [{ text: content }] };
    });
  }

  /** Convert new messages to Gemini content format. */
  private _messagesToGeminiContent(messages: Message[]): GeminiPart[] {
    const parts: GeminiPart[] = [];
    for (const msg of messages) {
      if (msg.role === Role.TOOL) {
        // Tool result
        parts.push({
          functionResponse: {
            name: msg.tool_call_id || "tool",
            response: { result: msg.content },
          },
        });
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Multimodal content
        for (const block of msg.content as unknown[]) {
          if (block !== null && typeof block === "object" && !Array.isArray(block)) {
            const b = block as Record<string, unknown>;
            if (b.type === "text") {
              parts.push({ text: (b.text as string | undefined) ?? "" });
            } else if (b.type === "image_url") {
              const imageUrl = (b.image_url as Record<string, unknown> | undefined) ?? {};
              const url = (imageUrl.url as string | undefined) ?? "";
              if (url.startsWith("data:")) {
                // Base64 image
                const comma = url.indexOf(",");
                const header = url.slice(0, comma);
                const data = url.slice(comma + 1);
                const mimeType = header.split(";")[0]!.split(":")[1]!;
                parts.push({ inlineData: { mimeType, data } });
              } else {
                parts.push({ text: `[Image: ${url}]` });
              }
            }
          } else {
            parts.push({ text: String(block) });
          }
        }
      } else {
        parts.push({ text: String(msg.content) });
      }
    }
    return parts;
  }

  /** Parse a Gemini response into an LLMResponse. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _parseGeminiResponse(response: any): LLMResponse {
    const candidate = response.candidates[0];

    // Extract text content
    let content = "";
    let toolCalls: ToolCall[] | undefined;

    for (const part of candidate.content.parts as GeminiPart[]) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        const fc = part.functionCall;
        toolCalls ??= [];
        // Generate a unique ID for the tool call
        toolCalls.push({
          id: `call_${toolCalls.length}_${fc.name}`,
          function: {
            name: fc.name,
            arguments: JSON.stringify(fc.args ?? {}),
          },
        });
      }
    }

    // Get token counts from usage metadata
    const usageMeta = response.usageMetadata ?? {};
    const inputTokens: number = usageMeta.promptTokenCount ?? 0;
    const outputTokens: number = usageMeta.candidatesTokenCount ?? 0;
    const totalTokens: number = usageMeta.totalTokenCount ?? inputTokens + outputTokens;

    const cost = estimateGeminiCost(this.modelName, inputTokens, outputTokens);

    // Determine finish reason
    let finishReason = FINISH_REASON_MAP[String(candidate.finishReason)] ?? "stop";
    if (toolCalls && finishReason === "stop") {
      finishReason = "tool_calls";
    }

    const result: LLMResponse = {
      message: {
        role: Role.ASSISTANT,
        content,
        tokens: outputTokens,
      },
      cost_usd: cost,
      model: this.modelName,
      finish_reason: finishReason,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
      },
    };
    if (toolCalls) {
      result.tool_calls = toolCalls;
    }
    return result;
  }

  /** Re-throw a Gemini SDK error as an IdentArk error. */
  private _classifyGeminiError(exc: unknown): never {
    const message = exc instanceof Error ? exc.message : String(exc);
    const excStr = String(exc).toLowerCase();

    if (excStr.includes("quota") || excStr.includes("rate") || excStr.includes("429")) {
      throw new RateLimitError(message, 60, "google");
    }
    if (
      excStr.includes("safety") ||
      excStr.includes("blocked") ||
      excStr.includes("harm") ||
      excStr.includes("content")
    ) {
      throw new ContentPolicyError(message);
    }
    if (excStr.includes("invalid") && excStr.includes("api")) {
      throw new ConfigurationError(`Invalid Gemini API key: ${exc}`);
    }

    throw new ProviderError(`Gemini API error: ${exc}`);
  }
}

// Convenience alias
export { GeminiGateway as IdentArkGeminiGateway };
