/**
 * identark/gateway
 * ~~~~~~~~~~~~~~~~
 * The AgentGateway protocol — the core interface of the SDK.
 *
 * Any class that implements these methods is a valid gateway,
 * whether it comes from this SDK or not.
 */

import type { Message, LLMResponse, PresignedURL, StreamChunk } from "./types.js";

/**
 * The AgentGateway protocol defines how an agent communicates
 * with the outside world.
 *
 * Implement this protocol to create a custom gateway for any backend.
 * All methods must be async.
 *
 * The gateway is the single boundary between your agent logic and
 * everything external: LLM providers, file storage, cost tracking.
 * Agents built against this protocol hold no secrets and maintain
 * no persistent state themselves.
 */
export interface AgentGateway {
  /**
   * Send new messages to the LLM and receive a response.
   *
   * The gateway is responsible for maintaining and reconstructing
   * the full conversation history. Callers should pass only the
   * *new* messages for this turn — do not include prior history.
   *
   * @param newMessages - New messages to send this turn.
   * @param tools - OpenAI-format tool/function definitions.
   *                Pass `undefined` if no tools are available.
   * @param toolChoice - Tool selection mode. One of 'auto', 'none', 'required',
   *                     or a specific tool dict.
   * @returns LLMResponse containing the assistant message, cost, finish reason,
   *          and token usage.
   * @throws CostCapExceededError - If the session cost cap has been reached.
   * @throws RateLimitError - If the provider rate-limits the request.
   * @throws LLMError - For any other provider-level error.
   * @throws NetworkError - If all retry attempts to the control plane are exhausted.
   */
  invokeLlm(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice?: string | Record<string, unknown>,
  ): Promise<LLMResponse>;

  /**
   * Persist messages to conversation history without invoking the LLM.
   *
   * Use this to store tool call results, system context, or any
   * messages you want the agent to remember on future turns without
   * generating a new LLM response.
   *
   * @param messages - Messages to persist. Can include any role.
   * @throws GatewayError - If persistence fails.
   */
  persistMessages(messages: Message[]): Promise<void>;

  /**
   * Request a presigned URL for reading or writing a workspace file.
   *
   * The agent never holds cloud storage credentials. The gateway
   * generates a time-limited, path-scoped URL on demand.
   *
   * @param filePath - Absolute path to the file in the sandbox workspace.
   *                   Must start with `/workspace/`.
   * @param method - 'PUT' for upload, 'GET' for download.
   * @returns PresignedURL with the URL, expiry timestamp, method, and
   *          resolved file path.
   * @throws PathNotAllowedError - If filePath is outside /workspace/.
   * @throws FileError - For any other file-related error.
   */
  requestFileUrl(filePath: string, method?: string): Promise<PresignedURL>;

  /**
   * Return the total cost in USD consumed by this session so far.
   *
   * Reflects all invokeLlm calls made through this gateway instance.
   * With ControlPlaneGateway, this queries the control plane for the
   * authoritative total.
   *
   * @returns Total accumulated cost in USD.
   */
  getSessionCost(): Promise<number>;

  /**
   * Stream a response from the LLM token by token.
   *
   * Yields StreamChunk objects as they arrive.
   * The final chunk has finish_reason set and input_tokens / output_tokens
   * populated. All prior chunks have finish_reason=null.
   *
   * @param newMessages - New messages to send this turn.
   * @param tools - OpenAI-format tool/function definitions.
   * @param toolChoice - Tool selection mode.
   * @yields StreamChunk — one per token delta.
   * @throws CostCapExceededError - If the session cost cap has been reached.
   * @throws RateLimitError - If the provider rate-limits the request.
   * @throws ContentPolicyError - If the output is blocked by content filtering.
   */
  invokeLlmStream(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice?: string | Record<string, unknown>,
  ): AsyncGenerator<StreamChunk, void, undefined>;
}
