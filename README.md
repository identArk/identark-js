<p align="center">
  <img src="https://raw.githubusercontent.com/identArk/identark-js/main/assets/logo.jpg" alt="IdentArk" width="360">
</p>

# identark

The AgentGateway Protocol — secure, scalable agent execution infrastructure.

A TypeScript SDK for building agents that hold zero secrets and maintain zero state. Route requests through your own LLM provider (local development) or the IdentArk control plane (production). Perfect for multi-turn conversations, function calling, file I/O, and cost tracking.

## Features

- **Agent Protocol**: `AgentGateway` interface enables seamless swapping between local and cloud execution
- **DirectGateway**: Call OpenAI, Anthropic, Mistral, or any OpenAI-compatible endpoint (Ollama, vLLM) directly
- **ControlPlaneGateway**: Production-grade routing through IdentArk control plane with automatic env var detection
- **Zero Secrets**: Agents never hold API keys or credentials
- **Cost Tracking**: Built-in pricing tables and session cost calculation
- **Streaming Support**: Token-by-token streaming from any provider
- **Tool Calling**: Full support for OpenAI-style function definitions and tool calls
- **File I/O**: Presigned URLs for secure workspace file access
- **Testing**: `MockGateway` for unit testing agent logic
- **Zero Dependencies**: Native `fetch` API, no required runtime deps
- **TypeScript First**: Full type safety, strict mode enabled

## Installation

```bash
npm install identark

# Optional peer dependencies for type hints
npm install --save-peer openai @anthropic-ai/sdk
```

## Quick Start

### Local Development with OpenAI

```typescript
import { DirectGateway, Message, Role } from "identark";
import { OpenAI } from "openai";

const gateway = new DirectGateway(
  new OpenAI(),
  "gpt-4o",
  "You are a helpful assistant."
);

const response = await gateway.invokeLlm([
  { role: Role.USER, content: "What is 2 + 2?" }
]);

console.log(response.message.content);
console.log(`Cost: $${response.cost_usd.toFixed(4)}`);
```

### Local Development with Anthropic

```typescript
import { DirectGateway, Role } from "identark";
import { Anthropic } from "@anthropic-ai/sdk";

const gateway = new DirectGateway(
  new Anthropic(),
  "claude-3-5-sonnet-20241022"
);

const response = await gateway.invokeLlm([
  { role: Role.USER, content: "Hello Claude!" }
]);
```

### Production with IdentArk Control Plane

```typescript
import { ControlPlaneGateway, Role } from "identark";

// Auto-detects from env vars:
// - IDENTARK_SESSION_TOKEN (inside sandbox)
// - IDENTARK_API_KEY (outside sandbox)
// - IDENTARK_CONTROL_PLANE_URL
// - IDENTARK_SESSION_ID (optional)

const gateway = new ControlPlaneGateway();

const response = await gateway.invokeLlm([
  { role: Role.USER, content: "Hello from production!" }
]);
```

### Streaming Responses

```typescript
const gateway = new DirectGateway(new OpenAI(), "gpt-4o");

for await (const chunk of gateway.invokeLlmStream([
  { role: Role.USER, content: "Write a haiku about TypeScript." }
])) {
  if (chunk.content) {
    process.stdout.write(chunk.content);
  }
}
```

### Function Calling

```typescript
const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" }
        },
        required: ["location"]
      }
    }
  }
];

const response = await gateway.invokeLlm(
  [{ role: Role.USER, content: "What's the weather in NYC?" }],
  tools
);

if (response.tool_calls) {
  for (const call of response.tool_calls) {
    const args = JSON.parse(call.function.arguments);
    console.log(`Calling ${call.function.name} with`, args);
  }
}
```

### File Operations

```typescript
// Request a presigned URL for workspace file access
const presigned = await gateway.requestFileUrl("/workspace/data.json", "PUT");

// Use the URL to upload/download files (valid for ~24 hours)
const response = await fetch(presigned.url, {
  method: "PUT",
  body: JSON.stringify({ data: "value" })
});
```

### Cost Tracking

```typescript
const gateway = new DirectGateway(
  new OpenAI(),
  "gpt-4o",
  undefined,
  0.10  // $0.10 cost cap
);

try {
  await gateway.invokeLlm([{ role: Role.USER, content: "..." }]);
} catch (err) {
  if (err instanceof CostCapExceededError) {
    console.log(`Cost cap exceeded: $${err.consumed_usd}/$${err.cap_usd}`);
  }
}

const totalCost = await gateway.getSessionCost();
console.log(`Session total: $${totalCost.toFixed(4)}`);
```

### Testing with MockGateway

```typescript
import { MockGateway, Role, LLMResponse } from "identark";

const mockResponse: LLMResponse = {
  message: { role: Role.ASSISTANT, content: "Mocked response" },
  cost_usd: 0.001,
  model: "mock",
  finish_reason: "stop",
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
};

const gateway = new MockGateway([mockResponse]);

const response = await gateway.invokeLlm([
  { role: Role.USER, content: "Test message" }
]);

// Assert on calls
console.log(gateway.invokeLlmCallCount);  // 1
console.log(gateway.totalMessagesSent);   // 1
```

## API Reference

### Types

#### `Role` enum
Message roles: `USER`, `ASSISTANT`, `TOOL`, `SYSTEM`

#### `Message` interface
```typescript
interface Message {
  role: Role;
  content: string | Record<string, unknown>[];
  tool_call_id?: string;
  name?: string;
  tokens?: number;
}
```

#### `LLMResponse` interface
```typescript
interface LLMResponse {
  message: Message;
  cost_usd: number;
  model: string;
  finish_reason: string;
  tool_calls?: ToolCall[];
  usage?: TokenUsage;
}
```

#### `StreamChunk` interface
```typescript
interface StreamChunk {
  content: string;
  finish_reason: string | null;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
}
```

#### `PresignedURL` interface
```typescript
interface PresignedURL {
  url: string;
  expires_at: string;
  method: string;
  file_path: string;
}
```

### Gateways

#### `AgentGateway` interface
The core protocol. Implement this to create custom gateways:

```typescript
interface AgentGateway {
  invokeLlm(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice?: string | Record<string, unknown>
  ): Promise<LLMResponse>;

  persistMessages(messages: Message[]): Promise<void>;

  requestFileUrl(filePath: string, method?: string): Promise<PresignedURL>;

  getSessionCost(): Promise<number>;

  invokeLlmStream(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice?: string | Record<string, unknown>
  ): AsyncGenerator<StreamChunk>;
}
```

#### `DirectGateway`
Local development gateway. Calls LLM providers directly.

```typescript
new DirectGateway(
  llmClient: unknown,           // OpenAI, Anthropic, or compatible client
  model: string,                 // Model ID
  systemPrompt?: string,         // Optional system prompt
  costCapUsd?: number,           // Optional cost cap
  workspaceDir?: string,         // Local workspace directory (default: /workspace)
  provider?: string              // Explicit provider: 'openai' | 'anthropic' | 'mistral' | 'local'
)
```

#### `ControlPlaneGateway`
Production gateway. Routes through IdentArk control plane.

```typescript
new ControlPlaneGateway(
  apiKey?: string,       // Auto-detected from env
  url?: string,          // Auto-detected from env
  sessionId?: string,    // Optional session ID
  timeout?: number,      // Request timeout in seconds (default: 30)
  maxRetries?: number    // Retry attempts (default: 3)
)
```

#### `MockGateway`
Test double for unit testing.

```typescript
const mock = new MockGateway(
  responses?: LLMResponse[],    // Responses to return in order
  defaultResponse?: LLMResponse, // Fallback response
  workspaceDir?: string         // Workspace for file URLs
);

// Record calls for assertions
mock.invokeLlmCallCount
mock.totalMessagesSent
mock.lastRequest
mock.allInvokeCalls
mock.allPersistedMessages
```

## Error Handling

All errors inherit from `IdentArkError`:

```typescript
import {
  IdentArkError,
  CostCapExceededError,
  AuthenticationError,
  RateLimitError,
  ContentPolicyError,
  PathNotAllowedError,
  ConfigurationError
} from "identark";

try {
  const response = await gateway.invokeLlm([msg]);
} catch (err) {
  if (err instanceof CostCapExceededError) {
    console.log(`Over budget: $${err.consumed_usd}/$${err.cap_usd}`);
  } else if (err instanceof AuthenticationError) {
    console.log(`Auth failed: ${err.reason}`);
  } else if (err instanceof RateLimitError) {
    console.log(`Rate limited. Retry after ${err.retry_after_seconds}s`);
  } else if (err instanceof IdentArkError) {
    console.error(`SDK error: ${err.message}`);
  } else {
    throw err;
  }
}
```

## Provider Support

### DirectGateway supports:

| Provider | Client | Example |
|----------|--------|---------|
| **OpenAI** | `openai` npm package | `gpt-4o`, `gpt-4-turbo` |
| **Anthropic** | `@anthropic-ai/sdk` | `claude-3-5-sonnet-20241022` |
| **Mistral** | OpenAI SDK (base_url) | `mistral-large-latest` |
| **Ollama** | OpenAI SDK (local) | `llama3.2`, custom models |
| **vLLM** | OpenAI SDK (base_url) | Any HuggingFace model |

### Cost Estimation

Built-in pricing tables for popular models. Unknown models use a conservative default. Local providers (Ollama) always cost $0.00.

```typescript
// Pricing is automatic
const response = await gateway.invokeLlm([msg]);
console.log(`This call cost: $${response.cost_usd.toFixed(6)}`);
```

## Environment Variables

For `ControlPlaneGateway`:

```bash
IDENTARK_SESSION_TOKEN         # Inside IdentArk sandbox (auto-created)
IDENTARK_API_KEY               # Outside sandbox (your API key)
IDENTARK_CONTROL_PLANE_URL     # Control plane endpoint
IDENTARK_SESSION_ID            # Optional: explicit session ID
```

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Build
npm run build

# Watch mode
npm run dev
```

## Migration from Python SDK

The TypeScript SDK mirrors the Python SDK's design. Here's the mapping:

| Python | TypeScript |
|--------|-----------|
| `Role` enum | `Role` enum |
| `Message` dataclass | `Message` interface |
| `LLMResponse` dataclass | `LLMResponse` interface |
| `AgentGateway` Protocol | `AgentGateway` interface |
| `DirectGateway` class | `DirectGateway` class |
| `ControlPlaneGateway` class | `ControlPlaneGateway` class |
| `MockGateway` class | `MockGateway` class |

Main differences:
- Use constructor parameters instead of `@dataclass` fields
- Use async/await instead of `async def`
- Use `AsyncGenerator` instead of Python's async generator syntax
- Use fetch API instead of httpx
- Property getters (`getModel()`) instead of `@property` decorators

## License

MIT

See LICENSE file for details.

## Contributing

Contributions welcome! Please ensure tests pass and TypeScript is strictly typed.

```bash
npm test
npm run typecheck
npm run lint
```
