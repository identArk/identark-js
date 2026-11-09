/**
 * Example: OrcaRouter Cyber Inference as a first-class IdentArk provider.
 *
 *   Run: npx tsx examples/orcarouter-usage.ts
 *
 * Runs with no credentials and no network: a fake `fetch` stands in for the
 * gateway. Delete the `fetchImpl` options to use the real endpoint.
 *
 * OrcaRouter is an OpenAI-compatible AI gateway that routes many providers
 * behind one endpoint (https://www.orcarouter.ai). This provider targets
 * authorized, scoped security inference for verified security teams.
 */

import {
  ORCAROUTER_DEFAULT_MODEL,
  ORCAROUTER_RECOMMENDED_CYBER_MODELS,
  createOrcaRouterGateway,
  discoverOrcaRouterModels,
  filterModelsByModality,
  type OrcaRouterChatClient,
} from "../src/providers/orcarouter/index.js";
import { Role } from "../src/types.js";

const FAKE_KEY = "sk-orca-0000000000000000example";

/** Minimal stand-in for the two OrcaRouter endpoints this provider uses. */
const fakeFetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/models")) {
    return new Response(
      JSON.stringify({
        data: [
          { id: "orcarouter/auto", supported_endpoint_types: ["openai", "anthropic"] },
          {
            id: "orca/orcacyber-ultra-1.0",
            name: "Orca: OrcaCyber Ultra 1.0",
            context_length: 1048576,
            architecture: { input_modalities: ["text"] },
            supported_endpoint_types: ["openai"],
            supported_parameters: ["reasoning"],
          },
          {
            id: "orca/orcacyber-zero-1.5",
            name: "Orca: OrcaCyber Zero 1.5",
            context_length: 1000000,
            architecture: { input_modalities: ["text"] },
            supported_endpoint_types: ["openai"],
            supported_parameters: ["reasoning"],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      id: "chatcmpl-example",
      model: ORCAROUTER_DEFAULT_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as unknown as typeof fetch;

async function main(): Promise<void> {
  // 1. Discover the authoritative chat catalog.
  const catalog = await discoverOrcaRouterModels({
    apiBaseUrl: "https://api.orcarouter.ai/v1",
    apiKey: FAKE_KEY,
    fetchImpl: fakeFetch,
  });
  console.log(`catalog: ${catalog.status} (${catalog.models.length} chat models)`);
  console.log(`default model: ${ORCAROUTER_DEFAULT_MODEL}`);
  console.log(`recommended cyber models: ${ORCAROUTER_RECOMMENDED_CYBER_MODELS.join(", ")}`);
  console.log(`image-capable chat models: ${filterModelsByModality(catalog.models, "image").length}`);

  // 2. Route a request through the provider. `provider` is pinned internally.
  const { gateway, client } = createOrcaRouterGateway({
    apiKey: FAKE_KEY,
    model: ORCAROUTER_DEFAULT_MODEL,
    catalog,
    fetchImpl: fakeFetch,
  });
  const response = await gateway.invokeLlm([{ role: Role.USER, content: "hello" }]);
  console.log(`reply: ${response.message.content} (model ${response.model})`);
  console.log(`request went to: ${client.baseURL}/chat/completions`);

  // 3. Streaming uses the same client; the provider is OpenAI-compatible.
  const streamClient: OrcaRouterChatClient = client;
  console.log(`client provider: ${streamClient.baseURL}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
