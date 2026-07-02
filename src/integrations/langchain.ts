/**
 * IdentArk LangChain.js Integration
 *
 * Wraps any AgentGateway as a LangChain BaseChatModel so you can use
 * IdentArk's credential-isolated gateway inside any LangChain chain,
 * agent, or pipeline.
 *
 * @example
 * ```typescript
 * import { DirectGateway } from "@identark/sdk";
 * import { OpenAI } from "openai";
 * import { IdentArkChatModel } from "@identark/sdk/integrations/langchain";
 * import { HumanMessage } from "@langchain/core/messages";
 *
 * const gateway = new DirectGateway(new OpenAI(), "gpt-4o");
 * const llm = new IdentArkChatModel({ gateway });
 *
 * const response = await llm.invoke([new HumanMessage("Hello!")]);
 * ```
 */

import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { AgentGateway, LLMResponse, Message, StreamChunk } from "../gateway.js";
import { Role } from "../types.js";

export interface IdentArkChatModelInput extends BaseChatModelParams {
  gateway: AgentGateway;
}

/**
 * Convert LangChain messages to IdentArk Message format.
 */
function lcToIdentark(messages: BaseMessage[]): Message[] {
  return messages.map((msg): Message => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

    if (msg instanceof HumanMessage) {
      return { role: Role.USER, content };
    }
    if (msg instanceof SystemMessage) {
      return { role: Role.SYSTEM, content };
    }
    if (msg instanceof AIMessage) {
      return { role: Role.ASSISTANT, content };
    }
    if (msg instanceof ToolMessage) {
      return { role: Role.TOOL, content, tool_call_id: msg.tool_call_id };
    }
    // Fallback
    return { role: Role.USER, content };
  });
}

/**
 * Convert an IdentArk LLMResponse to a LangChain AIMessage.
 */
function identarkToLc(response: LLMResponse): AIMessage {
  const msg = new AIMessage(response.message.content ?? "");
  // Attach usage metadata if available
  if (response.usage) {
    (msg as any).usage_metadata = {
      input_tokens: response.usage.prompt_tokens ?? 0,
      output_tokens: response.usage.completion_tokens ?? 0,
      total_tokens: response.usage.total_tokens ?? 0,
    };
  }
  return msg;
}

/**
 * IdentArk-powered LangChain chat model.
 *
 * Uses the AgentGateway protocol so you can swap between DirectGateway
 * (local dev) and ControlPlaneGateway (production) without changing
 * your LangChain code.
 */
export class IdentArkChatModel extends BaseChatModel<IdentArkChatModelInput> {
  lc_namespace = ["identark", "integrations", "langchain"];

  gateway: AgentGateway;

  constructor(fields: IdentArkChatModelInput) {
    super(fields);
    this.gateway = fields.gateway;
  }

  get lc_secrets(): Record<string, string> | undefined {
    return undefined;
  }

  get _llmType(): string {
    return "identark";
  }

  get _modelType(): string {
    return "identark_chat";
  }

  /**
   * Core invocation method required by BaseChatModel.
   */
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const identarkMessages = lcToIdentark(messages);

    const response: LLMResponse = await this.gateway.invokeLlm(
      identarkMessages,
      options.tools as any,
      options.tool_choice as any,
    );

    const message = identarkToLc(response);
    const generation = { text: message.content as string, message };

    return {
      generations: [generation],
      llmOutput: {
        cost_usd: response.cost_usd,
        model: response.model,
        finish_reason: response.finish_reason,
      },
    };
  }

  /**
   * Streaming support via async iterator.
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const identarkMessages = lcToIdentark(messages);

    const stream = this.gateway.invokeLlmStream(
      identarkMessages,
      options.tools as any,
      options.tool_choice as any,
    );

    for await (const chunk of stream) {
      const text = (chunk as StreamChunk).content ?? "";
      const generationChunk = new ChatGenerationChunk({
        text,
        message: new AIMessage(text),
      });

      yield generationChunk;

      if (runManager) {
        await runManager.handleLLMNewToken(text);
      }
    }
  }

  /**
   * Bind tools to the model (required for tool-calling agents).
   */
  bindTools(tools: any[], kwargs?: any): this {
    return this.bind({
      tools: tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema ?? t.parameters,
        },
      })),
      ...kwargs,
    }) as this;
  }
}
