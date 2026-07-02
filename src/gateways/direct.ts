/**
 * identark/gateways/direct
 * ~~~~~~~~~~~~~~~~~~~~~~~~
 * DirectGateway — local development implementation of AgentGateway.
 *
 * Calls LLM providers directly using your own API keys, keeps
 * conversation history in memory, and resolves file paths to the
 * local filesystem. No IdentArk account or control plane required.
 *
 * Supports OpenAI, Anthropic, Mistral (EU), and any OpenAI-compatible
 * endpoint including Ollama for fully local, zero-egress inference.
 */

import { mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import type { AgentGateway } from "../gateway.js";
import type {
  Message,
  LLMResponse,
  PresignedURL,
  StreamChunk,
  ToolCall,
} from "../types.js";
import { Role, messageToOpenAiDict } from "../types.js";
import {
  ConfigurationError,
  ContentPolicyError,
  CostCapExceededError,
  PathNotAllowedError,
  ProviderError,
  RateLimitError,
} from "../errors.js";

import { estimateCost } from "../pricing.js";

/**
 * Local development implementation of AgentGateway.
 *
 * Calls LLM providers directly. Keeps conversation history in memory.
 * Resolves /workspace/ file paths to the local filesystem.
 *
 * Supports OpenAI, Anthropic, Mistral (EU), and any OpenAI-compatible endpoint.
 */
export class DirectGateway implements AgentGateway {
  private client: unknown;
  private model: string;
  private systemPrompt?: string;
  private costCap?: number;
  private workspace: string;
  private provider: string;
  private history: Message[] = [];
  private totalCost: number = 0.0;

  /**
   * Create a new DirectGateway instance.
   *
   * @param llmClient - An initialised async LLM client (AsyncOpenAI, AsyncAnthropic,
   *                    or any OpenAI-compatible client).
   * @param model - Model identifier e.g. 'gpt-4o', 'mistral-large-latest', 'llama3.2'.
   * @param systemPrompt - Optional system prompt prepended to every conversation.
   * @param costCapUsd - Optional soft cost cap. Raises CostCapExceededError when exceeded.
   * @param workspaceDir - Local directory for file operations. Defaults to '/workspace'.
   * @param provider - Optional explicit provider override. Recognised values:
   *                   'openai', 'anthropic', 'mistral', 'local'.
   */
  constructor(
    llmClient: unknown,
    model: string,
    systemPrompt?: string,
    costCapUsd?: number,
    workspaceDir: string = "/workspace",
    provider?: string,
  ) {
    if (!llmClient) {
      throw new ConfigurationError("llmClient must not be null");
    }
    if (!model) {
      throw new ConfigurationError("model must be a non-empty string");
    }

    this.client = llmClient;
    this.model = model;
    if (systemPrompt !== undefined) {
      this.systemPrompt = systemPrompt;
    }
    if (costCapUsd !== undefined) {
      this.costCap = costCapUsd;
    }
    this.workspace = workspaceDir;

    // Determine provider
    if (provider) {
      this.provider = provider;
    } else {
      this.provider = this._detectProvider();
    }
  }

  /**
   * Send new messages to the LLM and receive a response.
   */
  async invokeLlm(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice: string | Record<string, unknown> = "auto",
  ): Promise<LLMResponse> {
    this._checkCostCap();
    const messages = this._buildMessages(newMessages);

    let response: LLMResponse;
    if (this.provider === "anthropic") {
      response = await this._callAnthropic(messages, tools, toolChoice);
    } else {
      response = await this._callOpenAi(messages, tools, toolChoice);
    }

    this.totalCost += response.cost_usd;
    this.history.push(...newMessages);
    this.history.push(response.message);

    return response;
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

    const url = `file://${resolved}`;
    return {
      url,
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
   */
  async *invokeLlmStream(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice: string | Record<string, unknown> = "auto",
  ): AsyncGenerator<StreamChunk> {
    if (this.costCap !== undefined && this.totalCost >= this.costCap) {
      throw new CostCapExceededError(
        `Cost cap of $${this.costCap.toFixed(4)} reached.`,
        this.costCap,
        this.totalCost,
      );
    }

    const messages = this._buildMessages(newMessages);
    const generator =
      this.provider === "anthropic"
        ? this._streamAnthropic(messages, tools, toolChoice)
        : this._streamOpenAi(messages, tools, toolChoice);

    for await (const chunk of generator) {
      yield chunk;
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
    return this.model;
  }

  /**
   * The resolved provider string (e.g. 'openai', 'mistral', 'local').
   */
  getProvider(): string {
    return this.provider;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _checkCostCap(): void {
    if (this.costCap !== undefined && this.totalCost >= this.costCap) {
      throw new CostCapExceededError(
        `DirectGateway cost cap of $${this.costCap.toFixed(4)} reached. Accumulated: $${this.totalCost.toFixed(4)}. Call gateway.reset() to start fresh.`,
        this.costCap,
        this.totalCost,
      );
    }
  }

  private _buildMessages(newMessages: Message[]): Record<string, unknown>[] {
    const msgs: Record<string, unknown>[] = [];
    if (this.systemPrompt) {
      msgs.push({ role: "system", content: this.systemPrompt });
    }
    msgs.push(...this.history.map((m) => messageToOpenAiDict(m)));
    msgs.push(...newMessages.map((m) => messageToOpenAiDict(m)));
    return msgs;
  }

  private _resolveWorkspacePath(filePath: string): string {
    if (!filePath.startsWith("/workspace/")) {
      throw new PathNotAllowedError(filePath);
    }
    const relative = filePath.slice("/workspace/".length);
    return resolve(this.workspace, relative);
  }

  private _detectProvider(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientClass = (this.client as any).constructor.name;
    if (clientClass.includes("Anthropic")) {
      return "anthropic";
    }
    if (clientClass.includes("Mistral")) {
      return "mistral";
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseUrl = (this.client as any).baseURL || (this.client as any).base_url || "";
    if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("::1")) {
      return "local";
    }
    if (baseUrl.includes("mistral.ai")) {
      return "mistral";
    }

    return "openai";
  }

  private async _callOpenAi(
    messages: Record<string, unknown>[],
    tools: Record<string, unknown>[] | undefined,
    toolChoice: string | Record<string, unknown>,
  ): Promise<LLMResponse> {
    const kwargs: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (tools) {
      kwargs.tools = tools;
      kwargs.tool_choice = toolChoice;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const completion = await (this.client as any).chat.completions.create(kwargs);
      const choice = completion.choices[0];
      const rawMsg = choice.message;
      const usage = completion.usage;

      const toolCalls: ToolCall[] | undefined = rawMsg.tool_calls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? rawMsg.tool_calls.map((tc: any) => ({
            id: tc.id,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }))
        : undefined;

      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;
      const cost = estimateCost(this.model, inputTokens, outputTokens, this.provider);

      const response: LLMResponse = {
        message: {
          role: Role.ASSISTANT,
          content: rawMsg.content || "",
          tokens: outputTokens,
        },
        cost_usd: cost,
        model: this.model,
        finish_reason: choice.finish_reason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cached_tokens:
            usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
      };

      if (toolCalls) {
        response.tool_calls = toolCalls;
      }

      return response;
    } catch (exc) {
      this._classifyOpenAiError(exc as Error);
    }
  }

  private async _callAnthropic(
    messages: Record<string, unknown>[],
    tools: Record<string, unknown>[] | undefined,
    _toolChoice: string | Record<string, unknown>,
  ): Promise<LLMResponse> {
    let system: string | undefined;
    const filtered: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = msg.content as string;
      } else {
        filtered.push(msg);
      }
    }

    const kwargs: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: filtered,
    };

    if (system) {
      kwargs.system = system;
    }

    if (tools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kwargs.tools = tools.map((t: any) => ({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || {},
      }));
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (this.client as any).messages.create(kwargs);

      let content = "";
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          content += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cost = estimateCost(this.model, inputTokens, outputTokens, "anthropic");

      const finishMap: Record<string, string> = {
        end_turn: "stop",
        tool_use: "tool_calls",
        max_tokens: "length",
      };
      const finishReason = finishMap[response.stop_reason || "end_turn"] || "stop";

      const anthropicResponse: LLMResponse = {
        message: {
          role: Role.ASSISTANT,
          content,
          tokens: outputTokens,
        },
        cost_usd: cost,
        model: this.model,
        finish_reason: finishReason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      };

      if (toolCalls.length > 0) {
        anthropicResponse.tool_calls = toolCalls;
      }

      return anthropicResponse;
    } catch (exc) {
      const excStr = (exc as Error).toString().toLowerCase();
      if (
        excStr.includes("content filtering policy") ||
        excStr.includes("output blocked")
      ) {
        throw new ContentPolicyError((exc as Error).message);
      }
      throw new ProviderError(`Anthropic API error: ${exc}`);
    }
  }

  private _classifyOpenAiError(exc: Error): never {
    const excType = exc.constructor.name;
    const excStr = exc.toString().toLowerCase();

    if (excType.includes("RateLimitError")) {
      throw new RateLimitError(exc.message, 60, this.provider);
    }
    if (
      excType.includes("ContentFilter") ||
      excStr.includes("content_filter") ||
      excStr.includes("content filtering policy") ||
      excStr.includes("output blocked")
    ) {
      throw new ContentPolicyError(exc.message);
    }
    throw new ProviderError(`${this.provider.charAt(0).toUpperCase() + this.provider.slice(1)} API error: ${exc}`);
  }

  // ── Streaming ─────────────────────────────────────────────────────────────

  private async *_streamOpenAi(
    messages: Record<string, unknown>[],
    tools: Record<string, unknown>[] | undefined,
    toolChoice: string | Record<string, unknown>,
  ): AsyncGenerator<StreamChunk> {
    const kwargs: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools) {
      kwargs.tools = tools;
      kwargs.tool_choice = toolChoice;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = await (this.client as any).chat.completions.create(kwargs);
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
        }

        if (!choice) {
          continue;
        }

        const deltaContent = choice.delta?.content || "";
        const finishReason = choice.finish_reason;

        if (deltaContent) {
          yield {
            content: deltaContent,
            finish_reason: null,
            model: this.model,
          };
        }

        if (finishReason) {
          const cost = estimateCost(this.model, inputTokens, outputTokens, this.provider);
          this.totalCost += cost;

          yield {
            content: "",
            finish_reason: finishReason,
            model: this.model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          };
        }
      }
    } catch (exc) {
      this._classifyOpenAiError(exc as Error);
    }
  }

  private async *_streamAnthropic(
    messages: Record<string, unknown>[],
    tools: Record<string, unknown>[] | undefined,
    _toolChoice: string | Record<string, unknown>,
  ): AsyncGenerator<StreamChunk> {
    let system: string | undefined;
    const filtered = messages.filter((m) => m.role !== "system");
    for (const msg of messages) {
      if (msg.role === "system") {
        system = msg.content as string;
      }
    }

    const kwargs: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: filtered,
    };

    if (system) {
      kwargs.system = system;
    }

    if (tools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kwargs.tools = tools.map((t: any) => ({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || {},
      }));
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = await (this.client as any).messages.stream(kwargs);

      for await (const text of stream.textStream) {
        yield {
          content: text,
          finish_reason: null,
          model: this.model,
        };
      }

      const final = await stream.finalMessage();
      const inputTokens = final.usage.input_tokens;
      const outputTokens = final.usage.output_tokens;
      const cost = estimateCost(this.model, inputTokens, outputTokens, "anthropic");
      this.totalCost += cost;

      const finishMap: Record<string, string> = {
        end_turn: "stop",
        tool_use: "tool_calls",
        max_tokens: "length",
      };
      const finishReason = finishMap[final.stop_reason || "end_turn"] || "stop";

      yield {
        content: "",
        finish_reason: finishReason,
        model: this.model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      };
    } catch (exc) {
      const excStr = (exc as Error).toString().toLowerCase();
      if (
        excStr.includes("content filtering policy") ||
        excStr.includes("output blocked")
      ) {
        throw new ContentPolicyError((exc as Error).message);
      }
      throw new ProviderError(`Anthropic streaming error: ${exc}`);
    }
  }
}
