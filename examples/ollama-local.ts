/**
 * Ollama (fully local) — DirectGateway with zero data egress, zero cost.
 *
 * Requirements:
 *   ollama pull llama3.2   # download the model once
 *   ollama serve           # start the local server
 *
 * Run:
 *   npx tsx examples/ollama-local.ts
 *
 * No API key required. All inference runs on your machine.
 * Data never leaves your hardware — ideal for sovereign / air-gapped deployments.
 */

import { DirectGateway, Role } from "identark";
import OpenAI from "openai";

// Ollama exposes an OpenAI-compatible API at localhost:11434.
// provider "local" tells DirectGateway that cost is always $0.
const gateway = new DirectGateway(
  new OpenAI({
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama", // required by the openai SDK; ignored by Ollama
  }),
  "llama3.2",
  "You are a helpful assistant.",
  undefined, // no cost cap
  "/workspace",
  "local", // forces $0 cost tracking; no data leaves your machine
);

async function main() {
  const response = await gateway.invokeLlm([
    {
      role: Role.USER,
      content: "Explain the AgentGateway Protocol in one paragraph.",
    },
  ]);

  console.log(response.message.content);
  console.log(`\nProvider : ${gateway.getProvider()}`);
  console.log(
    `Cost     : $${response.cost_usd.toFixed(6)} (always $0.00 for local models)`,
  );

  const cost = await gateway.getSessionCost();
  console.log(`Session  : $${cost.toFixed(6)}`);
}

main().catch(console.error);
