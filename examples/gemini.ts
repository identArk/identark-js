/**
 * Gemini integration example.
 *
 * Prerequisite: npm install @google/generative-ai
 * Run with: GEMINI_API_KEY=your-key npx tsx examples/gemini.ts
 */

import { GeminiGateway } from "identark/integrations/gemini";
import { Role } from "identark";

const gateway = new GeminiGateway({
  apiKey: process.env.GEMINI_API_KEY ?? "",
  model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
});

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Return the current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City to look up" },
        },
        required: ["city"],
      },
    },
  },
];

async function main() {
  const response = await gateway.invokeLlm(
    [
      {
        role: Role.USER,
        content: "What is the weather in Paris? Use get_weather before answering.",
      },
    ],
    tools,
  );

  const toolCall = response.tool_calls?.[0];
  if (toolCall) {
    console.log("Tool call:", toolCall.function.name, toolCall.function.arguments);
  }

  console.log("Response:", response.message.content);
  console.log("Cost:", response.cost_usd);
}

main().catch(console.error);
