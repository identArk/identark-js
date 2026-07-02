/**
 * @identark/sdk
 * ~~~~~~~~~~~~~
 * The AgentGateway Protocol — secure, scalable agent execution infrastructure.
 *
 * Quick start:
 *
 * ```typescript
 * // Local development
 * import { DirectGateway, Message, Role } from "@identark/sdk";
 *
 * const gateway = new DirectGateway({
 *   llmClient: new OpenAI(),
 *   model: "gpt-4o",
 * });
 *
 * const response = await gateway.invokeLlm([
 *   { role: Role.USER, content: "Hello!" }
 * ]);
 *
 * // Production — two line change, agent code identical
 * import { ControlPlaneGateway } from "@identark/sdk";
 * const gateway = new ControlPlaneGateway();  // auto-detects env vars in sandbox
 * ```
 *
 * Full documentation: https://github.com/identark/sdk#readme
 * GitHub: https://github.com/identark/sdk
 */

// Protocol
export type { AgentGateway } from "./gateway.js";

// Implementations
export { DirectGateway } from "./gateways/direct.js";
export { ControlPlaneGateway } from "./gateways/control-plane.js";

// Models
export {
  Role,
  type Message,
  type LLMResponse,
  type StreamChunk,
  type PresignedURL,
  type TokenUsage,
  type ToolCall,
  type ToolFunction,
  type Function, // Deprecated: use ToolFunction
  messageToOpenAiDict,
} from "./types.js";

// Errors
export {
  IdentArkError,
  GatewayError,
  ControlPlaneError,
  AuthenticationError,
  CostCapExceededError,
  SessionNotFoundError,
  NetworkError,
  LLMError,
  RateLimitError,
  ContentPolicyError,
  ProviderError,
  FileError,
  PathNotAllowedError,
  PresignedURLExpiredError,
  ConfigurationError,
} from "./errors.js";

// Testing
export { MockGateway } from "./testing/mock-gateway.js";

// Integrations
export { IdentArkChatModel } from "./integrations/langchain.js";

// Metadata
export const version = "1.0.0";
export const author = "Gold Okpa";
export const license = "MIT";

export { estimateCost, OPENAI_PRICING, ANTHROPIC_PRICING, MISTRAL_PRICING } from "./pricing.js";
