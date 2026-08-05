/**
 * LangChain.js Integration Example
 *
 * Use IdentArk's credential-isolated gateway inside any LangChain chain.
 */

import { DirectGateway } from "identark";
import { IdentArkChatModel } from "identark/integrations/langchain";
import OpenAI from "openai";
import { HumanMessage } from "@langchain/core/messages";

const gateway = new DirectGateway(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  "gpt-4o",
);

const llm = new IdentArkChatModel({ gateway });

async function main() {
  const response = await llm.invoke([
    new HumanMessage("Explain quantum computing in one sentence."),
  ]);

  console.log("Response:", response.content);
}

main().catch(console.error);
