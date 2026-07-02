/**
 * identark/testing/mock-gateway
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * MockGateway — a test double for AgentGateway.
 *
 * Returns configurable responses without any network or LLM calls.
 * Records every call so tests can assert on what was sent.
 */

import { mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import type { AgentGateway } from "../gateway.js";
import type { Message, LLMResponse, PresignedURL, StreamChunk } from "../types.js";

/**
 * Test implementation of AgentGateway.
 *
 * Returns queued responses without any network or LLM calls.
 * Records every call for assertion.
 */
export class MockGateway implements AgentGateway {
  private responseQueue: LLMResponse[] = [];
  private defaultResponse?: LLMResponse;
  private workspaceDir: string;
  private invokeCalls: Array<{
    newMessages: Message[];
    tools?: Record<string, unknown>[];
    toolChoice: string | Record<string, unknown>;
  }> = [];
  private persistCalls: Message[][] = [];
  private fileUrlCalls: Array<{ filePath: string; method: string }> = [];
  private totalCost: number = 0.0;

  /**
   * Create a new MockGateway instance.
   *
   * @param responses - Optional initial list of LLMResponse objects to return in order.
   * @param defaultResponse - Returned when the queue is exhausted. If undefined, raises error.
   * @param workspaceDir - Local directory for file URL resolution. Defaults to '/tmp/identark-mock-workspace'.
   */
  constructor(
    responses?: LLMResponse[],
    defaultResponse?: LLMResponse,
    workspaceDir: string = "/tmp/identark-mock-workspace",
  ) {
    this.responseQueue = [...(responses || [])];
    if (defaultResponse !== undefined) {
      this.defaultResponse = defaultResponse;
    }
    this.workspaceDir = workspaceDir;
  }

  // ── Response management ───────────────────────────────────────────────────

  /**
   * Add a response to the end of the queue.
   */
  queueResponse(response: LLMResponse): void {
    this.responseQueue.push(response);
  }

  /**
   * Add multiple responses to the end of the queue.
   */
  queueResponses(responses: LLMResponse[]): void {
    this.responseQueue.push(...responses);
  }

  private nextResponse(): LLMResponse {
    const response = this.responseQueue.shift();
    if (response) {
      return response;
    }
    if (this.defaultResponse) {
      return this.defaultResponse;
    }
    throw new Error(
      "MockGateway response queue is empty and no defaultResponse was set. " +
        "Call mock.queueResponse() to add more responses.",
    );
  }

  // ── AgentGateway interface ────────────────────────────────────────────────

  /**
   * Return the next queued response.
   */
  async invokeLlm(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice: string | Record<string, unknown> = "auto",
  ): Promise<LLMResponse> {
    const call: typeof this.invokeCalls[0] = {
      newMessages,
      toolChoice,
    };
    if (tools) {
      call.tools = tools;
    }
    this.invokeCalls.push(call);
    const response = this.nextResponse();
    this.totalCost += response.cost_usd;
    return response;
  }

  /**
   * Record the persist call.
   */
  async persistMessages(messages: Message[]): Promise<void> {
    this.persistCalls.push([...messages]);
  }

  /**
   * Return a mock file:// presigned URL.
   */
  async requestFileUrl(filePath: string, method: string = "PUT"): Promise<PresignedURL> {
    this.fileUrlCalls.push({ filePath, method });

    const resolved = resolve(this.workspaceDir, filePath.replace(/^\/workspace\//, ""));
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
   * Return the total accumulated mock cost.
   */
  async getSessionCost(): Promise<number> {
    return this.totalCost;
  }

  /**
   * Stream the next queued response word by word, then yield a final chunk.
   */
  async *invokeLlmStream(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice: string | Record<string, unknown> = "auto",
  ): AsyncGenerator<StreamChunk> {
    const call: typeof this.invokeCalls[0] = {
      newMessages,
      toolChoice,
    };
    if (tools) {
      call.tools = tools;
    }
    this.invokeCalls.push(call);
    const response = this.nextResponse();
    this.totalCost += response.cost_usd;

    const content = response.message.content;
    const text = typeof content === "string" ? content : "";

    const words = text.split(" ");
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word === undefined) continue;
      const chunkText = i === words.length - 1 ? word : `${word} `;
      yield {
        content: chunkText,
        finish_reason: null,
        model: response.model,
      };
    }

    const finalChunk: StreamChunk = {
      content: "",
      finish_reason: response.finish_reason,
      model: response.model,
    };

    if (response.usage?.input_tokens !== undefined) {
      finalChunk.input_tokens = response.usage.input_tokens;
    }
    if (response.usage?.output_tokens !== undefined) {
      finalChunk.output_tokens = response.usage.output_tokens;
    }

    yield finalChunk;
  }

  // ── Assertions ────────────────────────────────────────────────────────────

  /**
   * Number of times invokeLlm was called.
   */
  get invokeLlmCallCount(): number {
    return this.invokeCalls.length;
  }

  /**
   * Number of times persistMessages was called.
   */
  get persistMessagesCallCount(): number {
    return this.persistCalls.length;
  }

  /**
   * Number of times requestFileUrl was called.
   */
  get fileUrlRequestCount(): number {
    return this.fileUrlCalls.length;
  }

  /**
   * Total number of messages passed across all invokeLlm calls.
   */
  get totalMessagesSent(): number {
    return this.invokeCalls.reduce((sum, call) => sum + call.newMessages.length, 0);
  }

  /**
   * The most recent invokeLlm call arguments, or undefined.
   */
  get lastRequest(): (typeof this.invokeCalls)[0] | undefined {
    return this.invokeCalls[this.invokeCalls.length - 1];
  }

  /**
   * All recorded invokeLlm call arguments in order.
   */
  get allInvokeCalls(): (typeof this.invokeCalls) {
    return [...this.invokeCalls];
  }

  /**
   * All messages that have been persisted, flattened.
   */
  get allPersistedMessages(): Message[] {
    return this.persistCalls.flat();
  }

  /**
   * Clear all recorded calls and reset cost. Does not clear the queue.
   */
  reset(): void {
    this.invokeCalls = [];
    this.persistCalls = [];
    this.fileUrlCalls = [];
    this.totalCost = 0.0;
  }
}
