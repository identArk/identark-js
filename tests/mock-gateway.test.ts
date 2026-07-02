import { describe, it, expect, beforeEach } from "vitest";
import { MockGateway } from "../src/testing/mock-gateway.js";
import { Message, Role, LLMResponse } from "../src/types.js";

describe("MockGateway", () => {
  let gateway: MockGateway;
  const defaultResponse: LLMResponse = {
    message: {
      role: Role.ASSISTANT,
      content: "Test response",
    },
    cost_usd: 0.001,
    model: "test",
    finish_reason: "stop",
  };

  beforeEach(() => {
    gateway = new MockGateway([defaultResponse]);
  });

  describe("Response queuing", () => {
    it("should return queued responses in order", async () => {
      const response1: LLMResponse = {
        message: {
          role: Role.ASSISTANT,
          content: "First",
        },
        cost_usd: 0.001,
        model: "test",
        finish_reason: "stop",
      };
      const response2: LLMResponse = {
        message: {
          role: Role.ASSISTANT,
          content: "Second",
        },
        cost_usd: 0.002,
        model: "test",
        finish_reason: "stop",
      };

      gateway = new MockGateway([response1, response2]);

      const res1 = await gateway.invokeLlm([
        { role: Role.USER, content: "Hi" },
      ]);
      const res2 = await gateway.invokeLlm([
        { role: Role.USER, content: "Hi again" },
      ]);

      expect(res1.message.content).toBe("First");
      expect(res2.message.content).toBe("Second");
    });

    it("should use default response when queue is empty", async () => {
      gateway = new MockGateway([], defaultResponse);

      const res1 = await gateway.invokeLlm([
        { role: Role.USER, content: "Hi" },
      ]);
      const res2 = await gateway.invokeLlm([
        { role: Role.USER, content: "Hi again" },
      ]);

      expect(res1.message.content).toBe("Test response");
      expect(res2.message.content).toBe("Test response");
    });

    it("should throw when queue is empty and no default", async () => {
      gateway = new MockGateway();

      await expect(async () => {
        await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      }).rejects.toThrow("response queue is empty");
    });
  });

  describe("Call recording", () => {
    it("should record invokeLlm calls", async () => {
      const msg1: Message = { role: Role.USER, content: "First" };
      const msg2: Message = { role: Role.USER, content: "Second" };

      const response: LLMResponse = {
        message: { role: Role.ASSISTANT, content: "Response" },
        cost_usd: 0.001,
        model: "test",
        finish_reason: "stop",
      };
      gateway = new MockGateway([response, response]);

      await gateway.invokeLlm([msg1]);
      await gateway.invokeLlm([msg2]);

      expect(gateway.invokeLlmCallCount).toBe(2);
      expect(gateway.allInvokeCalls[0].newMessages).toEqual([msg1]);
      expect(gateway.allInvokeCalls[1].newMessages).toEqual([msg2]);
    });

    it("should record persistMessages calls", async () => {
      const msg1: Message = { role: Role.ASSISTANT, content: "Stored" };
      const msg2: Message = { role: Role.TOOL, content: "Result" };

      await gateway.persistMessages([msg1]);
      await gateway.persistMessages([msg2]);

      expect(gateway.persistMessagesCallCount).toBe(2);
      expect(gateway.allPersistedMessages).toEqual([msg1, msg2]);
    });

    it("should record requestFileUrl calls", async () => {
      await gateway.requestFileUrl("/workspace/file.txt", "PUT");
      await gateway.requestFileUrl("/workspace/other.txt", "GET");

      expect(gateway.fileUrlRequestCount).toBe(2);
    });

    it("should track total messages sent", async () => {
      const response: LLMResponse = {
        message: { role: Role.ASSISTANT, content: "Response" },
        cost_usd: 0.001,
        model: "test",
        finish_reason: "stop",
      };
      gateway = new MockGateway([response, response]);

      await gateway.invokeLlm([
        { role: Role.USER, content: "1" },
        { role: Role.USER, content: "2" },
      ]);
      await gateway.invokeLlm([{ role: Role.USER, content: "3" }]);

      expect(gateway.totalMessagesSent).toBe(3);
    });

    it("should provide access to last request", async () => {
      const msg: Message = { role: Role.USER, content: "Last" };
      const response: LLMResponse = {
        message: { role: Role.ASSISTANT, content: "Response" },
        cost_usd: 0.001,
        model: "test",
        finish_reason: "stop",
      };
      gateway = new MockGateway([response]);

      await gateway.invokeLlm([msg]);

      expect(gateway.lastRequest?.newMessages).toEqual([msg]);
    });
  });

  describe("Cost tracking", () => {
    it("should accumulate costs from responses", async () => {
      const resp1: LLMResponse = {
        message: { role: Role.ASSISTANT, content: "A" },
        cost_usd: 0.001,
        model: "test",
        finish_reason: "stop",
      };
      const resp2: LLMResponse = {
        message: { role: Role.ASSISTANT, content: "B" },
        cost_usd: 0.002,
        model: "test",
        finish_reason: "stop",
      };

      gateway = new MockGateway([resp1, resp2]);

      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);

      const cost = await gateway.getSessionCost();
      expect(cost).toBe(0.003);
    });
  });

  describe("Streaming", () => {
    it("should yield stream chunks", async () => {
      const response: LLMResponse = {
        message: { role: Role.ASSISTANT, content: "Hello world" },
        cost_usd: 0.001,
        model: "test",
        finish_reason: "stop",
      };

      gateway = new MockGateway([response]);

      const chunks: string[] = [];
      for await (const chunk of gateway.invokeLlmStream([
        { role: Role.USER, content: "Hi" },
      ])) {
        if (chunk.content) {
          chunks.push(chunk.content);
        }
      }

      expect(chunks.join("")).toBe("Hello world");
    });
  });

  describe("Reset", () => {
    it("should clear call records and cost", async () => {
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      expect(gateway.invokeLlmCallCount).toBe(1);

      gateway.reset();

      expect(gateway.invokeLlmCallCount).toBe(0);
      expect(await gateway.getSessionCost()).toBe(0);
    });

    it("should not clear the response queue", async () => {
      gateway.reset();
      // Should still have responses in queue from initialization
      const res = await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      expect(res.message.content).toBe("Test response");
    });
  });
});
