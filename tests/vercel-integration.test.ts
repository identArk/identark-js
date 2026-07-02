import { describe, expect, it } from "vitest";
import { MockGateway } from "../src/testing/mock-gateway.js";
import { Role, type LLMResponse } from "../src/types.js";
import { IdentArkLanguageModel, identark } from "../src/integrations/vercel.js";

function response(text: string): LLMResponse {
  return {
    message: { role: Role.ASSISTANT, content: text },
    cost_usd: 0.002,
    model: "test-model",
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

describe("Vercel AI SDK integration", () => {
  it("exposes a v1 language model with identark provider", () => {
    const model = identark(new MockGateway([response("hi")]));
    expect(model).toBeInstanceOf(IdentArkLanguageModel);
    expect(model.specificationVersion).toBe("v1");
    expect(model.provider).toBe("identark");
  });

  it("doGenerate returns text, finishReason and usage from the gateway", async () => {
    const model = identark(new MockGateway([response("Hello from IdentArk")]));

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: "Hi" }],
    });

    expect(result.text).toBe("Hello from IdentArk");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
  });

  it("surfaces cost and model in provider metadata", async () => {
    const model = identark(new MockGateway([response("x")]));
    const result = await model.doGenerate({ prompt: [{ role: "user", content: "Hi" }] });
    expect(result.providerMetadata?.identark).toMatchObject({
      cost_usd: 0.002,
      model: "test-model",
    });
  });

  it("flattens multi-part content into a single string message", async () => {
    const gateway = new MockGateway([response("ok")]);
    const model = identark(gateway);

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "part one " },
            { type: "text", text: "part two" },
          ],
        },
      ],
    });

    // MockGateway records the calls it received
    const calls = gateway.allInvokeCalls;
    expect(calls[0].newMessages[0].content).toBe("part one part two");
  });

  it("doStream emits text-delta chunks then finish", async () => {
    const gateway = new MockGateway([response("streamed")]);
    const model = identark(gateway);

    const { stream } = await model.doStream({ prompt: [{ role: "user", content: "Hi" }] });
    const reader = stream.getReader();
    const parts: Record<string, unknown>[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    expect(parts.some((p) => p.type === "text-delta")).toBe(true);
    expect(parts[parts.length - 1].type).toBe("finish");
  });
});
