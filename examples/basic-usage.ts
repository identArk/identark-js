/**
 * Basic IdentArk TypeScript SDK Usage
 *
 * Shows how to create a gateway and execute an agent task.
 */

import { DirectGateway } from "@identark/sdk";
import OpenAI from "openai";

// Create a direct gateway with your OpenAI client
const gateway = new DirectGateway(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  "gpt-4o",
  undefined, // No system prompt
  0.50,      // $0.50 cost cap
);

// Execute a simple task
async function main() {
  const response = await gateway.invokeLlm([
    { role: "user", content: "What is the capital of France?" },
  ]);

  console.log("Response:", response.message.content);
  console.log("Cost:", response.cost_usd);
}

main().catch(console.error);
