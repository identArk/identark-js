/**
 * Example: use IdentArk with the Vercel AI SDK.
 *
 * The provider API key lives in IdentArk's vault — never in this process.
 * Swap DirectGateway for ControlPlaneGateway to run fully governed in prod.
 *
 * Run: npx tsx examples/vercel-ai-sdk.ts
 * (requires `ai` and `@ai-sdk/provider` if you wire it into generateText)
 */

import { MockGateway } from "../src/testing/mock-gateway.js";
import { Role } from "../src/types.js";
import { identark } from "../src/integrations/vercel.js";

async function main() {
  // In real use: const gateway = new DirectGateway(openai, "gpt-4o");
  // Here we use MockGateway so the example runs with no keys or network.
  const gateway = new MockGateway([
    {
      message: { role: Role.ASSISTANT, content: "Hello from a governed agent!" },
      cost_usd: 0.0004,
      model: "gpt-4o",
      finish_reason: "stop",
      usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 },
    },
  ]);

  const model = identark(gateway, "gpt-4o");

  // With the real AI SDK you'd call:
  //   import { generateText } from "ai";
  //   const { text } = await generateText({ model, prompt: "Hi" });
  //
  // Directly exercising the v1 interface here:
  const result = await model.doGenerate({
    prompt: [{ role: "user", content: "Say hello" }],
  });

  console.log("text:", result.text);
  console.log("finishReason:", result.finishReason);
  console.log("usage:", result.usage);
  console.log("cost (via providerMetadata):", result.providerMetadata?.identark);
}

main().catch(console.error);
