/**
 * identark/types
 * ~~~~~~~~~~~~~~
 * Core data types used throughout the SDK.
 */

/**
 * Message role in a conversation.
 */
export enum Role {
  USER = "user",
  ASSISTANT = "assistant",
  TOOL = "tool",
  SYSTEM = "system",
}

/**
 * A single message in a conversation.
 */
export interface Message {
  /**
   * Who authored this message.
   */
  role: Role;

  /**
   * Text content, or a list of content blocks for
   * multimodal / structured tool-call messages.
   */
  content: string | Record<string, unknown>[];

  /**
   * Required when role is Role.TOOL. Must match the
   * `id` of the tool call in the preceding assistant message.
   */
  tool_call_id?: string;

  /**
   * Optional display name. Useful in multi-agent systems.
   */
  name?: string;

  /**
   * Token count. Populated automatically by the gateway
   * after `invokeLlm` calls.
   */
  tokens?: number;
}

/**
 * Serialize a Message to the OpenAI messages API format.
 */
export function messageToOpenAiDict(msg: Message): Record<string, unknown> {
  const dict: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.tool_call_id !== undefined) {
    dict.tool_call_id = msg.tool_call_id;
  }
  if (msg.name !== undefined) {
    dict.name = msg.name;
  }
  return dict;
}

/**
 * The function portion of a tool call.
 */
export interface ToolFunction {
  /**
   * Name of the function.
   */
  name: string;

  /**
   * JSON-encoded string of function arguments.
   */
  arguments: string;
}

// Backwards compatibility alias
export type Function = ToolFunction;

/**
 * A tool/function call requested by the assistant.
 */
export interface ToolCall {
  /**
   * Unique identifier for the tool call.
   */
  id: string;

  /**
   * The function that was called.
   */
  function: ToolFunction;

  /**
   * Type of tool call. Always "function".
   */
  type?: string;
}

/**
 * Token consumption for a single LLM call.
 */
export interface TokenUsage {
  /**
   * Number of tokens in the prompt.
   */
  input_tokens: number;

  /**
   * Number of tokens in the completion.
   */
  output_tokens: number;

  /**
   * Total number of tokens (input + output).
   */
  total_tokens: number;

  /**
   * Number of cached tokens, if applicable.
   */
  cached_tokens?: number;
}

/**
 * The result of an `invokeLlm` call.
 */
export interface LLMResponse {
  /**
   * The assistant's response message.
   */
  message: Message;

  /**
   * Cost of this specific call in USD.
   */
  cost_usd: number;

  /**
   * The model that generated the response.
   */
  model: string;

  /**
   * Finish reason: 'stop', 'tool_calls', 'length', or 'content_filter'.
   */
  finish_reason: string;

  /**
   * Populated when finish_reason == 'tool_calls'.
   */
  tool_calls?: ToolCall[];

  /**
   * Token usage breakdown.
   */
  usage?: TokenUsage;
}

/**
 * A single chunk from a streaming `invokeLlmStream` call.
 */
export interface StreamChunk {
  /**
   * The text delta for this chunk. Empty string on the final chunk.
   */
  content: string;

  /**
   * None for mid-stream chunks. 'stop', 'tool_calls',
   * or 'length' on the final chunk.
   */
  finish_reason: string | null;

  /**
   * The model that generated the chunk.
   */
  model: string;

  /**
   * Populated only on the final chunk (when finish_reason is set).
   */
  input_tokens?: number;

  /**
   * Populated only on the final chunk (when finish_reason is set).
   */
  output_tokens?: number;
}

/**
 * A time-limited, scoped URL for reading or writing a workspace file.
 */
export interface PresignedURL {
  /**
   * The presigned URL. Use immediately — it is short-lived.
   */
  url: string;

  /**
   * ISO 8601 expiry timestamp.
   */
  expires_at: string;

  /**
   * 'PUT' for upload, 'GET' for download.
   */
  method: string;

  /**
   * The /workspace/ path this URL corresponds to.
   */
  file_path: string;
}
