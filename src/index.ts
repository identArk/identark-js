/**
 * identark
 * ~~~~~~~~~~~~~
 * The AgentGateway Protocol — secure, scalable agent execution infrastructure.
 *
 * Quick start:
 *
 * ```typescript
 * // Local development
 * import { DirectGateway, Message, Role } from "identark";
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
 * import { ControlPlaneGateway } from "identark";
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
//
// Deliberately NOT re-exported here. Each integration imports its framework
// (@langchain/core, ai, ...) at module scope, and ESM resolves imports
// eagerly — so re-exporting them from this barrel made `import { DirectGateway }
// from "identark"` fail with ERR_MODULE_NOT_FOUND for anyone who had not also
// installed LangChain. Import them from their own subpath instead:
//
//   import { IdentArkChatModel } from "identark/integrations/langchain";
//   import { identark }          from "identark/integrations/vercel";

// Metadata
export const version = "1.0.2";
export const author = "Gold Okpa";
export const license = "MIT";

export { estimateCost, OPENAI_PRICING, ANTHROPIC_PRICING, MISTRAL_PRICING } from "./pricing.js";
