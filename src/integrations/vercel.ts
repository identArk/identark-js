/**
 * IdentArk Vercel AI SDK Integration
 *
 * Exposes any `AgentGateway` as a Vercel AI SDK v1 language model, so you can
 * use IdentArk's credential-isolated, governed gateway with `generateText`,
 * `streamText`, and the rest of the AI SDK — the provider API keys stay in
 * IdentArk's vault, never in your app.
 *
 * The AI SDK is where the largest population of TS/JS agent developers already
 * is; this adapter is the cheapest way for them to adopt governed agents.
 *
 * @example
 * ```typescript
 * import { generateText } from "ai";
 * import { DirectGateway } from "@identark/sdk";
 * import { identark } from "@identark/sdk/integrations/vercel";
 *
 * const gateway = new DirectGateway(openaiClient, "gpt-4o");
 * const { text } = await generateText({
 *   model: identark(gateway),
 *   prompt: "Hello!",
 * });
 * ```
 *
 * Depends on `@ai-sdk/provider` (a peer dependency) for the interface types.
 * We intentionally avoid a hard import of that package so the core SDK stays
 * dependency-free; the types below mirror `LanguageModelV1`.
 */

import type { AgentGateway } from "../gateway.js";
import { type LLMResponse, type Message, Role, type StreamChunk } from "../types.js";

// ── Minimal structural types mirroring @ai-sdk/provider LanguageModelV1 ───────
// Kept local so the core package pulls in no runtime dependency. If you have
// `@ai-sdk/provider` installed, this model is assignable to `LanguageModelV1`.

interface Prompt {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
}

interface DoGenerateResult {
  text?: string;
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number };
  rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  providerMetadata?: Record<string, unknown>;
}

interface DoStreamResult {
  stream: ReadableStream<Record<string, unknown>>;
  rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
}

/** Flatten AI SDK prompt content parts to a plain string. */
function partsToText(content: Prompt["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

/** Map an AI SDK prompt to IdentArk messages. */
function promptToIdentark(prompt: Prompt[]): Message[] {
  const roleMap: Record<Prompt["role"], Role> = {
    system: Role.SYSTEM,
    user: Role.USER,
    assistant: Role.ASSISTANT,
    tool: Role.TOOL,
  };
  return prompt.map((p) => ({ role: roleMap[p.role], content: partsToText(p.content) }));
}

/**
 * A Vercel AI SDK v1 language model backed by an IdentArk gateway.
 */
export class IdentArkLanguageModel {
  readonly specificationVersion = "v1" as const;
  readonly provider = "identark";
  readonly defaultObjectGenerationMode = "json" as const;

  private gateway: AgentGateway;
  readonly modelId: string;

  constructor(gateway: AgentGateway, modelId = "identark") {
    this.gateway = gateway;
    this.modelId = modelId;
  }

  async doGenerate(options: { prompt: Prompt[] }): Promise<DoGenerateResult> {
    const messages = promptToIdentark(options.prompt);
    const res: LLMResponse = await this.gateway.invokeLlm(messages);
    const raw = res.message.content;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");

    return {
      text,
      finishReason: mapFinishReason(res.finish_reason),
      usage: {
        promptTokens: res.usage?.input_tokens ?? 0,
        completionTokens: res.usage?.output_tokens ?? 0,
      },
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
      providerMetadata: { identark: { cost_usd: res.cost_usd, model: res.model } },
    };
  }

  async doStream(options: { prompt: Prompt[] }): Promise<DoStreamResult> {
    const messages = promptToIdentark(options.prompt);
    const gatewayStream = this.gateway.invokeLlmStream(messages);

    const stream = new ReadableStream<Record<string, unknown>>({
      async start(controller) {
        try {
          for await (const chunk of gatewayStream) {
            const delta = (chunk as StreamChunk).content ?? "";
            if (delta) {
              controller.enqueue({ type: "text-delta", textDelta: delta });
            }
          }
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 0, completionTokens: 0 },
          });
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return { stream, rawCall: { rawPrompt: options.prompt, rawSettings: {} } };
  }
}

/** AI SDK finish reasons differ slightly from IdentArk's — normalise. */
function mapFinishReason(reason: string): string {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "other";
  }
}

/**
 * Convenience factory matching the AI SDK provider style: `identark(gateway)`.
 */
export function identark(gateway: AgentGateway, modelId?: string): IdentArkLanguageModel {
  return new IdentArkLanguageModel(gateway, modelId);
}
