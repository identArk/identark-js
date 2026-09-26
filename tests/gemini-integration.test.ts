import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createRequire } from "module";
import {
  GeminiGateway,
  IdentArkGeminiGateway,
  convertRoleToGemini,
  convertToolsToGemini,
  estimateGeminiCost,
} from "../src/integrations/gemini.js";
import { Role, type Message } from "../src/types.js";
import {
  ConfigurationError,
  ContentPolicyError,
  CostCapExceededError,
  PathNotAllowedError,
  ProviderError,
  RateLimitError,
} from "../src/errors.js";

function textResponse(text = "Hello! How can I help you?", finishReason: unknown = "STOP") {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15, totalTokenCount: 25 },
  };
}

describe("GeminiGateway", () => {
  let tempDir: string;
  const sendMessage = vi.fn();
  const sendMessageStream = vi.fn();
  const startChat = vi.fn();
  const getGenerativeModel = vi.fn();
  const client = { getGenerativeModel };

  const make = (extra: Record<string, unknown> = {}) =>
    new GeminiGateway({
      apiKey: "test-api-key",
      model: "gemini-1.5-flash",
      systemPrompt: "You are a helpful assistant.",
      workspaceDir: tempDir,
      client,
      ...extra,
    });

  const user = (content: Message["content"]): Message => ({ role: Role.USER, content });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gemini-test-"));
    vi.resetAllMocks();
    sendMessage.mockResolvedValue({ response: textResponse() });
    startChat.mockReturnValue({ sendMessage, sendMessageStream });
    getGenerativeModel.mockReturnValue({ startChat });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("throws ConfigurationError when apiKey is missing", () => {
      expect(() => new GeminiGateway({ apiKey: "", model: "gemini-1.5-flash", client })).toThrow(
        ConfigurationError,
      );
    });

    it("throws ConfigurationError when model is empty", () => {
      expect(() => new GeminiGateway({ apiKey: "k", model: "", client })).toThrow(
        ConfigurationError,
      );
    });

    it("defaults the model to gemini-1.5-pro", () => {
      expect(new GeminiGateway({ apiKey: "k", client }).getModel()).toBe("gemini-1.5-pro");
    });

    it("passes system prompt, safety settings and generation config to the model", () => {
      make({ safetySettings: [{ category: "x" }], generationConfig: { temperature: 0 } });
      expect(getGenerativeModel).toHaveBeenCalledWith({
        model: "gemini-1.5-flash",
        systemInstruction: "You are a helpful assistant.",
        safetySettings: [{ category: "x" }],
        generationConfig: { temperature: 0 },
      });
    });

    it("omits optional model params that were not supplied", () => {
      new GeminiGateway({ apiKey: "k", model: "gemini-1.5-flash", client });
      expect(getGenerativeModel).toHaveBeenCalledWith({ model: "gemini-1.5-flash" });
    });

    it("throws ConfigurationError when the SDK is not installed", () => {
      let installed = true;
      try {
        createRequire(import.meta.url)("@google/generative-ai");
      } catch {
        installed = false;
      }
      if (installed) {
        return; // Only meaningful where the optional peer dependency is absent.
      }
      expect(() => new GeminiGateway({ apiKey: "k", model: "gemini-1.5-flash" })).toThrow(
        /npm install @google\/generative-ai/,
      );
    });

    it("exposes IdentArkGeminiGateway as an alias", () => {
      expect(IdentArkGeminiGateway).toBe(GeminiGateway);
    });
  });

  describe("properties", () => {
    it("reports provider 'google'", () => {
      expect(make().getProvider()).toBe("google");
    });

    it("reports the configured model", () => {
      expect(make().getModel()).toBe("gemini-1.5-flash");
    });
  });

  describe("invokeLlm", () => {
    it("returns a parsed response", async () => {
      const response = await make().invokeLlm([user("Hello!")]);
      expect(response.message.role).toBe(Role.ASSISTANT);
      expect(response.message.content).toBe("Hello! How can I help you?");
      expect(response.model).toBe("gemini-1.5-flash");
      expect(response.finish_reason).toBe("stop");
      expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 15, total_tokens: 25 });
      expect(response.tool_calls).toBeUndefined();
    });

    it("sends new messages as Gemini parts", async () => {
      await make().invokeLlm([user("Hello!")]);
      expect(sendMessage).toHaveBeenCalledWith([{ text: "Hello!" }]);
    });

    it("maintains history across calls", async () => {
      const gateway = make();
      await gateway.invokeLlm([user("First message")]);
      expect(gateway.getHistory()).toHaveLength(2);
      await gateway.invokeLlm([user("Second message")]);
      expect(gateway.getHistory()).toHaveLength(4);
    });

    it("replays history to Gemini with model/user roles", async () => {
      const gateway = make();
      await gateway.invokeLlm([user("First")]);
      await gateway.invokeLlm([user("Second")]);
      expect(startChat).toHaveBeenLastCalledWith({
        history: [
          { role: "user", parts: [{ text: "First" }] },
          { role: "model", parts: [{ text: "Hello! How can I help you?" }] },
        ],
      });
    });

    it("accumulates cost", async () => {
      const gateway = make();
      expect(await gateway.getSessionCost()).toBe(0);
      await gateway.invokeLlm([user("Hello")]);
      expect(await gateway.getSessionCost()).toBeCloseTo((10 * 0.075 + 15 * 0.3) / 1_000_000, 12);
    });

    it("passes tools as functionDeclarations", async () => {
      const tools = [
        { type: "function", function: { name: "get_weather", description: "Weather" } },
      ];
      await make().invokeLlm([user("Weather?")], tools);
      expect(startChat).toHaveBeenCalledWith({
        history: [],
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                description: "Weather",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
      });
    });

    it("does not send tools when none are given", async () => {
      await make().invokeLlm([user("Hi")], []);
      expect(startChat).toHaveBeenCalledWith({ history: [] });
    });

    it("parses function calls into tool_calls with a tool_calls finish reason", async () => {
      sendMessage.mockResolvedValue({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: "get_weather", args: { location: "Paris" } } },
                  { functionCall: { name: "get_time", args: {} } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
        },
      });
      const response = await make().invokeLlm([user("?")]);
      expect(response.finish_reason).toBe("tool_calls");
      expect(response.tool_calls).toEqual([
        { id: "call_0_get_weather", function: { name: "get_weather", arguments: '{"location":"Paris"}' } },
        { id: "call_1_get_time", function: { name: "get_time", arguments: "{}" } },
      ]);
      expect(response.usage?.total_tokens).toBe(3);
    });

    it.each([
      ["STOP", "stop"],
      ["MAX_TOKENS", "length"],
      ["SAFETY", "content_filter"],
      ["RECITATION", "recitation"],
      ["OTHER", "stop"],
      [2, "length"],
      [4, "content_filter"],
      [0, "stop"],
      [undefined, "stop"],
    ])("maps finish reason %s to %s", async (raw, expected) => {
      sendMessage.mockResolvedValue({ response: textResponse("x", raw) });
      const response = await make().invokeLlm([user("?")]);
      expect(response.finish_reason).toBe(expected);
    });

    it("converts tool-result messages to functionResponse parts", async () => {
      await make().invokeLlm([{ role: Role.TOOL, content: "sunny", tool_call_id: "call_0_w" }]);
      expect(sendMessage).toHaveBeenCalledWith([
        { functionResponse: { name: "call_0_w", response: { result: "sunny" } } },
      ]);
    });

    it("falls back to the name 'tool' when a tool result has no tool_call_id", async () => {
      await make().invokeLlm([{ role: Role.TOOL, content: "x" }]);
      expect(sendMessage).toHaveBeenCalledWith([
        { functionResponse: { name: "tool", response: { result: "x" } } },
      ]);
    });

    it("converts multimodal content: text, data-URL images and remote images", async () => {
      await make().invokeLlm([
        user([
          { type: "text", text: "Look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: "https://x.test/a.png" } },
        ]),
      ]);
      expect(sendMessage).toHaveBeenCalledWith([
        { text: "Look" },
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
        { text: "[Image: https://x.test/a.png]" },
      ]);
    });

    it("stringifies non-object content blocks", async () => {
      await make().invokeLlm([user(["plain" as unknown as Record<string, unknown>])]);
      expect(sendMessage).toHaveBeenCalledWith([{ text: "plain" }]);
    });

    it("replays tool messages in history as function turns", async () => {
      const gateway = make();
      await gateway.persistMessages([{ role: Role.TOOL, content: "42", tool_call_id: "c1" }]);
      await gateway.invokeLlm([user("next")]);
      expect(startChat).toHaveBeenCalledWith({
        history: [
          {
            role: "function",
            parts: [{ functionResponse: { name: "c1", response: { result: "42" } } }],
          },
        ],
      });
    });

    it("maps system messages in history to the user role", async () => {
      const gateway = make();
      await gateway.persistMessages([{ role: Role.SYSTEM, content: "ctx" }]);
      await gateway.invokeLlm([user("next")]);
      expect(startChat).toHaveBeenCalledWith({
        history: [{ role: "user", parts: [{ text: "ctx" }] }],
      });
    });

    it("JSON-encodes structured history content", async () => {
      const gateway = make();
      await gateway.persistMessages([user([{ type: "text", text: "hi" }])]);
      await gateway.invokeLlm([user("next")]);
      expect(startChat).toHaveBeenCalledWith({
        history: [{ role: "user", parts: [{ text: '[{"type":"text","text":"hi"}]' }] }],
      });
    });
  });

  describe("cost cap", () => {
    it("throws CostCapExceededError once the cap is reached", async () => {
      const gateway = make({ costCapUsd: 0.0001 });
      await gateway.invokeLlm([user("Hello")]);
      // Force the accumulated cost over the cap.
      (gateway as unknown as { totalCost: number }).totalCost = 0.001;
      await expect(gateway.invokeLlm([user("Hello again")])).rejects.toThrow(CostCapExceededError);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("does not throw below the cap", async () => {
      const gateway = make({ costCapUsd: 1 });
      await expect(gateway.invokeLlm([user("Hello")])).resolves.toBeDefined();
    });

    it("applies to streaming as well", async () => {
      const gateway = make({ costCapUsd: 0.0001 });
      (gateway as unknown as { totalCost: number }).totalCost = 0.001;
      await expect(gateway.invokeLlmStream([user("Hi")]).next()).rejects.toThrow(
        CostCapExceededError,
      );
    });
  });

  describe("persistMessages / reset", () => {
    it("persists without calling the LLM", async () => {
      const gateway = make();
      await gateway.persistMessages([
        user("Test"),
        { role: Role.ASSISTANT, content: "Response" },
      ]);
      expect(gateway.getHistory()).toHaveLength(2);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("reset clears history and cost", async () => {
      const gateway = make();
      await gateway.invokeLlm([user("Hello")]);
      expect(gateway.getHistory().length).toBeGreaterThan(0);
      expect(await gateway.getSessionCost()).toBeGreaterThan(0);
      gateway.reset();
      expect(gateway.getHistory()).toHaveLength(0);
      expect(await gateway.getSessionCost()).toBe(0);
    });

    it("getHistory returns a copy", async () => {
      const gateway = make();
      await gateway.persistMessages([user("a")]);
      gateway.getHistory().pop();
      expect(gateway.getHistory()).toHaveLength(1);
    });
  });

  describe("requestFileUrl", () => {
    it("returns a file:// URL for a workspace path", async () => {
      const url = await make().requestFileUrl("/workspace/test.txt", "PUT");
      expect(url.file_path).toBe("/workspace/test.txt");
      expect(url.method).toBe("PUT");
      expect(url.url.startsWith("file://")).toBe(true);
      expect(url.url.endsWith("/test.txt")).toBe(true);
    });

    it("creates parent directories for PUT but not GET", async () => {
      const gateway = make();
      await gateway.requestFileUrl("/workspace/a/b/c.txt", "GET");
      expect(existsSync(join(tempDir, "a"))).toBe(false);
      await gateway.requestFileUrl("/workspace/a/b/c.txt", "PUT");
      expect(existsSync(join(tempDir, "a", "b"))).toBe(true);
    });

    it("rejects paths outside the workspace", async () => {
      await expect(make().requestFileUrl("/etc/passwd", "GET")).rejects.toThrow(
        PathNotAllowedError,
      );
    });
  });

  describe("error classification", () => {
    const failWith = (message: string) => sendMessage.mockRejectedValue(new Error(message));

    it.each([
      "Resource has been exhausted (quota)",
      "Too many requests: rate limited",
      "[429 Too Many Requests]",
    ])("maps %s to RateLimitError", async (message) => {
      failWith(message);
      const err = await make()
        .invokeLlm([user("x")])
        .catch((e) => e);
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.provider).toBe("google");
      expect(err.retry_after_seconds).toBe(60);
    });

    it.each([
      "Response was blocked due to SAFETY",
      "Candidate was blocked",
      "Potential harm detected",
      "Content not permitted",
    ])("maps %s to ContentPolicyError", async (message) => {
      failWith(message);
      await expect(make().invokeLlm([user("x")])).rejects.toThrow(ContentPolicyError);
    });

    it("maps an invalid API key to ConfigurationError", async () => {
      failWith("API key not valid. Invalid api key");
      await expect(make().invokeLlm([user("x")])).rejects.toThrow(ConfigurationError);
    });

    it("wraps anything else in ProviderError", async () => {
      failWith("boom");
      await expect(make().invokeLlm([user("x")])).rejects.toThrow(/Gemini API error: Error: boom/);
      failWith("boom");
      await expect(make().invokeLlm([user("x")])).rejects.toThrow(ProviderError);
    });

    it("wraps non-Error rejections", async () => {
      sendMessage.mockRejectedValue("kaboom");
      await expect(make().invokeLlm([user("x")])).rejects.toThrow(ProviderError);
    });

    it("does not record history or cost when the call fails", async () => {
      failWith("boom");
      const gateway = make();
      await gateway.invokeLlm([user("x")]).catch(() => undefined);
      expect(gateway.getHistory()).toHaveLength(0);
      expect(await gateway.getSessionCost()).toBe(0);
    });
  });

  describe("invokeLlmStream", () => {
    async function* chunks(...items: unknown[]) {
      for (const item of items) {
        yield item;
      }
    }
    const textChunk = (text: string, usage?: Record<string, number>) => ({
      candidates: [{ content: { parts: [{ text }] } }],
      ...(usage ? { usageMetadata: usage } : {}),
    });

    it("streams text deltas then a final usage chunk", async () => {
      sendMessageStream.mockResolvedValue({
        stream: chunks(
          textChunk("Hel"),
          textChunk("lo", { promptTokenCount: 4, candidatesTokenCount: 6 }),
        ),
      });
      const gateway = make();
      const out = [];
      for await (const chunk of gateway.invokeLlmStream([user("Hi")])) {
        out.push(chunk);
      }
      expect(out).toEqual([
        { content: "Hel", finish_reason: null, model: "gemini-1.5-flash" },
        { content: "lo", finish_reason: null, model: "gemini-1.5-flash" },
        {
          content: "",
          finish_reason: "stop",
          model: "gemini-1.5-flash",
          input_tokens: 4,
          output_tokens: 6,
        },
      ]);
      expect(gateway.getHistory()).toEqual([
        user("Hi"),
        { role: Role.ASSISTANT, content: "Hello" },
      ]);
      expect(await gateway.getSessionCost()).toBeCloseTo((4 * 0.075 + 6 * 0.3) / 1_000_000, 12);
    });

    it("tolerates chunks without candidates", async () => {
      sendMessageStream.mockResolvedValue({ stream: chunks({}, textChunk("ok")) });
      const out = [];
      for await (const chunk of make().invokeLlmStream([user("Hi")])) {
        out.push(chunk);
      }
      expect(out.map((c) => c.content)).toEqual(["ok", ""]);
    });

    it("sends tools to Gemini when streaming", async () => {
      sendMessageStream.mockResolvedValue({ stream: chunks() });
      const tools = [{ type: "function", function: { name: "f" } }];
      for await (const _ of make().invokeLlmStream([user("Hi")], tools)) {
        // drain
      }
      expect(startChat).toHaveBeenCalledWith({
        history: [],
        tools: [
          {
            functionDeclarations: [
              { name: "f", description: "", parameters: { type: "object", properties: {} } },
            ],
          },
        ],
      });
    });

    it("classifies errors raised before streaming starts", async () => {
      sendMessageStream.mockRejectedValue(new Error("429 quota"));
      await expect(make().invokeLlmStream([user("Hi")]).next()).rejects.toThrow(RateLimitError);
    });

    it("classifies errors raised mid-stream and records no history", async () => {
      async function* broken() {
        yield textChunk("partial");
        throw new Error("response blocked");
      }
      sendMessageStream.mockResolvedValue({ stream: broken() });
      const gateway = make();
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const chunk of gateway.invokeLlmStream([user("Hi")])) {
            seen.push(chunk.content);
          }
        })(),
      ).rejects.toThrow(ContentPolicyError);
      expect(seen).toEqual(["partial"]);
      expect(gateway.getHistory()).toHaveLength(0);
    });
  });
});

describe("estimateGeminiCost", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prices flash cheaply and pro higher", () => {
    const flash = estimateGeminiCost("gemini-1.5-flash", 1000, 1000);
    const pro = estimateGeminiCost("gemini-1.5-pro", 1000, 1000);
    expect(flash).toBeGreaterThan(0);
    expect(flash).toBeLessThan(0.001);
    expect(pro).toBeGreaterThan(flash);
  });

  it("computes per-million-token rates exactly", () => {
    expect(estimateGeminiCost("gemini-1.5-pro", 1_000_000, 1_000_000)).toBeCloseTo(6.25, 10);
  });

  it("is case-insensitive", () => {
    expect(estimateGeminiCost("Gemini-1.5-PRO", 1000, 0)).toBe(
      estimateGeminiCost("gemini-1.5-pro", 1000, 0),
    );
  });

  it("uses prefix matching for unlisted variants without warning", () => {
    expect(estimateGeminiCost("gemini-1.5-pro-exp-0801", 1_000_000, 0)).toBeCloseTo(1.25, 10);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back to flash pricing with a warning for unknown models", () => {
    expect(estimateGeminiCost("mystery-model", 1_000_000, 0)).toBeCloseTo(0.075, 10);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("does not resolve Object.prototype names as models", () => {
    expect(estimateGeminiCost("constructor", 1_000_000, 0)).toBeCloseTo(0.075, 10);
    expect(estimateGeminiCost("__proto__", 1_000_000, 0)).toBeCloseTo(0.075, 10);
  });

  it("is zero for zero tokens", () => {
    expect(estimateGeminiCost("gemini-1.5-pro", 0, 0)).toBe(0);
  });
});

describe("convertToolsToGemini", () => {
  it("converts OpenAI-format tools", () => {
    const declarations = convertToolsToGemini([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      },
    ]);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]!.name).toBe("get_weather");
    expect(declarations[0]!.description).toBe("Get current weather");
    expect(declarations[0]!.parameters).toHaveProperty("properties.location");
  });

  it("defaults description and parameters", () => {
    expect(convertToolsToGemini([{ type: "function", function: { name: "f" } }])).toEqual([
      { name: "f", description: "", parameters: { type: "object", properties: {} } },
    ]);
  });

  it("skips non-function tools", () => {
    expect(convertToolsToGemini([{ type: "retrieval" }])).toEqual([]);
  });

  it("returns an empty list for no tools", () => {
    expect(convertToolsToGemini([])).toEqual([]);
  });
});

describe("convertRoleToGemini", () => {
  it.each([
    [Role.USER, "user"],
    [Role.ASSISTANT, "model"],
    [Role.SYSTEM, "user"],
    [Role.TOOL, "function"],
  ])("maps %s to %s", (role, expected) => {
    expect(convertRoleToGemini(role)).toBe(expected);
  });
});
