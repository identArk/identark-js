import { describe, it, expect, beforeEach, vi } from "vitest";
import { DirectGateway } from "../src/gateways/direct.js";
import { Message, Role } from "../src/types.js";
import { ConfigurationError, CostCapExceededError, PathNotAllowedError } from "../src/errors.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("DirectGateway", () => {
  let tempDir: string;
  const mockClient = {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Constructor", () => {
    it("should throw if llmClient is null", () => {
      expect(() => {
        new DirectGateway(null as unknown, "gpt-4o");
      }).toThrow(ConfigurationError);
    });

    it("should throw if model is empty", () => {
      expect(() => {
        new DirectGateway(mockClient, "");
      }).toThrow(ConfigurationError);
    });

    it("should initialize with required params", () => {
      const gateway = new DirectGateway(mockClient, "gpt-4o");
      expect(gateway.getModel()).toBe("gpt-4o");
      expect(gateway.getProvider()).toBe("openai");
    });

    it("should detect anthropic provider", () => {
      const anthropicClient = {
        constructor: { name: "AsyncAnthropic" },
      };
      const gateway = new DirectGateway(anthropicClient, "claude-3-opus");
      expect(gateway.getProvider()).toBe("anthropic");
    });

    it("should allow explicit provider override", () => {
      const gateway = new DirectGateway(
        mockClient,
        "llama3.2",
        undefined,
        undefined,
        tempDir,
        "local",
      );
      expect(gateway.getProvider()).toBe("local");
    });
  });

  describe("Cost cap", () => {
    it("should throw CostCapExceededError when cap is reached", async () => {
      const gateway = new DirectGateway(
        mockClient,
        "gpt-4o",
        undefined,
        0.001, // $0.001 cap
        tempDir,
      );

      // Simulate a call that costs more
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Test", tool_calls: null },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 1000,
        },
      });

      // First call within budget
      const msg: Message = { role: Role.USER, content: "Hi" };
      try {
        await gateway.invokeLlm([msg]);
      } catch (e) {
        // Cost exceeded on first call
      }

      // Second call should be rejected
      await expect(async () => {
        await gateway.invokeLlm([msg]);
      }).rejects.toThrow(CostCapExceededError);
    });
  });

  describe("File paths", () => {
    it("should throw PathNotAllowedError for paths outside /workspace/", async () => {
      const gateway = new DirectGateway(mockClient, "gpt-4o", undefined, undefined, tempDir);

      await expect(async () => {
        await gateway.requestFileUrl("/etc/passwd");
      }).rejects.toThrow(PathNotAllowedError);
    });

    it("should return a file:// URL for valid paths", async () => {
      const gateway = new DirectGateway(mockClient, "gpt-4o", undefined, undefined, tempDir);

      const presigned = await gateway.requestFileUrl("/workspace/test.txt");
      expect(presigned.url).toContain("file://");
      expect(presigned.method).toBe("PUT");
      expect(presigned.file_path).toBe("/workspace/test.txt");
    });
  });

  describe("History management", () => {
    it("should track conversation history", async () => {
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Hello", tool_calls: null },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 10,
        },
      });

      const gateway = new DirectGateway(mockClient, "gpt-4o", undefined, undefined, tempDir);
      const msg: Message = { role: Role.USER, content: "Hi" };
      await gateway.invokeLlm([msg]);

      const history = gateway.getHistory();
      expect(history.length).toBeGreaterThan(0);
      expect(history[0]).toEqual(msg);
    });

    it("should reset history when reset() is called", async () => {
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Hello", tool_calls: null },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 10,
        },
      });

      const gateway = new DirectGateway(mockClient, "gpt-4o", undefined, undefined, tempDir);
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);

      gateway.reset();
      expect(gateway.getHistory()).toHaveLength(0);
    });
  });

  describe("Session cost", () => {
    it("should track session cost", async () => {
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Hello", tool_calls: null },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 100,
        },
      });

      const gateway = new DirectGateway(mockClient, "gpt-4o", undefined, undefined, tempDir);
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);

      const cost = await gateway.getSessionCost();
      expect(cost).toBeGreaterThan(0);
    });

    it("should return zero cost for local provider", async () => {
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Hello", tool_calls: null },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 1000,
        },
      });

      const gateway = new DirectGateway(
        mockClient,
        "llama3.2",
        undefined,
        undefined,
        tempDir,
        "local",
      );
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);

      const cost = await gateway.getSessionCost();
      expect(cost).toBe(0.0);
    });
  });

  describe("persistMessages", () => {
    it("should persist messages without invoking LLM", async () => {
      const gateway = new DirectGateway(mockClient, "gpt-4o", undefined, undefined, tempDir);
      const msgs: Message[] = [
        { role: Role.TOOL, content: "Result" },
        { role: Role.ASSISTANT, content: "Got it" },
      ];

      await gateway.persistMessages(msgs);
      const history = gateway.getHistory();
      expect(history).toEqual(msgs);
      expect(mockClient.chat.completions.create).not.toHaveBeenCalled();
    });
  });
});
