import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateMessageContent,
  validateToolDefinitions,
  validateToolResultJson,
} from "../src/validation.js";
import { ConfigurationError } from "../src/errors.js";
import { DirectGateway } from "../src/gateways/direct.js";
import { MockGateway } from "../src/testing/mock-gateway.js";
import { Role, LLMResponse, Message } from "../src/types.js";
import * as sdk from "../src/index.js";

describe("validateToolDefinitions", () => {
  it("accepts undefined and null tools", () => {
    expect(() => validateToolDefinitions(undefined)).not.toThrow();
    expect(() => validateToolDefinitions(null)).not.toThrow();
  });

  it("accepts an empty array", () => {
    expect(() => validateToolDefinitions([])).not.toThrow();
  });

  it("accepts a well-formed tool definition", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a location",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      },
    ];
    expect(() => validateToolDefinitions(tools)).not.toThrow();
  });

  it("accepts a minimal tool (just type and name)", () => {
    expect(() =>
      validateToolDefinitions([{ type: "function", function: { name: "do_something" } }]),
    ).not.toThrow();
  });

  it("accepts parameters without a 'type' field", () => {
    expect(() =>
      validateToolDefinitions([
        { type: "function", function: { name: "t", parameters: { properties: {} } } },
      ]),
    ).not.toThrow();
  });

  it("rejects non-array tools", () => {
    expect(() => validateToolDefinitions({ type: "function" })).toThrow(ConfigurationError);
    expect(() => validateToolDefinitions({ type: "function" })).toThrow(/must be an array/);
  });

  it("rejects a tool that is not an object", () => {
    expect(() => validateToolDefinitions(["not a dict"])).toThrow(/tools\[0\] must be an object/);
    expect(() => validateToolDefinitions([["nested"]])).toThrow(/must be an object, got array/);
  });

  it("rejects a tool missing the 'type' field", () => {
    expect(() => validateToolDefinitions([{ function: { name: "test" } }])).toThrow(
      /missing required 'type'/,
    );
  });

  it("rejects a non-function type", () => {
    expect(() =>
      validateToolDefinitions([{ type: "retrieval", function: { name: "test" } }]),
    ).toThrow(/must be 'function', got 'retrieval'/);
  });

  it("rejects a tool missing the 'function' field", () => {
    expect(() => validateToolDefinitions([{ type: "function" }])).toThrow(
      /missing required 'function'/,
    );
  });

  it("rejects a non-object function field", () => {
    expect(() => validateToolDefinitions([{ type: "function", function: "not a dict" }])).toThrow(
      /function must be an object/,
    );
  });

  it("rejects a function missing 'name'", () => {
    expect(() => validateToolDefinitions([{ type: "function", function: {} }])).toThrow(
      /missing required 'name'/,
    );
  });

  it("rejects an empty or non-string function name", () => {
    expect(() => validateToolDefinitions([{ type: "function", function: { name: "" } }])).toThrow(
      /non-empty string/,
    );
    expect(() => validateToolDefinitions([{ type: "function", function: { name: 42 } }])).toThrow(
      /non-empty string/,
    );
  });

  it("rejects a non-string description", () => {
    expect(() =>
      validateToolDefinitions([{ type: "function", function: { name: "test", description: 123 } }]),
    ).toThrow(/description must be a string/);
  });

  it("rejects non-object parameters", () => {
    expect(() =>
      validateToolDefinitions([
        { type: "function", function: { name: "test", parameters: "invalid" } },
      ]),
    ).toThrow(/parameters must be an object/);
    expect(() =>
      validateToolDefinitions([{ type: "function", function: { name: "test", parameters: [] } }]),
    ).toThrow(/parameters must be an object/);
  });

  it("reports the index of the offending tool", () => {
    const tools = [
      { type: "function", function: { name: "ok" } },
      { type: "function", function: { name: "" } },
    ];
    expect(() => validateToolDefinitions(tools)).toThrow(/tools\[1\]\.function\.name/);
  });
});

describe("validateToolResultJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes silently for valid JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateToolResultJson('{"result": "success"}', "test_tool");
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes silently for empty content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateToolResultJson("", "test_tool");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns but does not throw for invalid JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateToolResultJson("not json", "test_tool")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("not valid JSON");
    expect(warn.mock.calls[0]?.[0]).toContain("test_tool");
  });
});

describe("validateMessageContent", () => {
  it("accepts string content", () => {
    expect(() => validateMessageContent("Hello, world!")).not.toThrow();
  });

  it("accepts null and undefined content", () => {
    expect(() => validateMessageContent(null)).not.toThrow();
    expect(() => validateMessageContent(undefined)).not.toThrow();
  });

  it("accepts multimodal content blocks", () => {
    const content = [
      { type: "text", text: "What's in this image?" },
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ];
    expect(() => validateMessageContent(content)).not.toThrow();
  });

  it("rejects invalid content types", () => {
    expect(() => validateMessageContent(123)).toThrow(ConfigurationError);
    expect(() => validateMessageContent(123)).toThrow(/must be string, array, or null/);
    expect(() => validateMessageContent({ type: "text" })).toThrow(/got object/);
  });

  it("rejects content blocks that are not objects", () => {
    expect(() => validateMessageContent(["not a dict"])).toThrow(/content\[0\] must be an object/);
  });

  it("rejects content blocks missing 'type'", () => {
    expect(() => validateMessageContent([{ text: "no type field" }])).toThrow(/missing 'type'/);
  });
});

describe("gateway wiring", () => {
  const badTools = [{ type: "retrieval", function: { name: "x" } }];
  const messages: Message[] = [{ role: Role.USER, content: "hi" }];
  const response: LLMResponse = {
    message: { role: Role.ASSISTANT, content: "ok" },
    cost_usd: 0.001,
    model: "test",
    finish_reason: "stop",
  };

  it("exports the validators from the package index", () => {
    expect(sdk.validateToolDefinitions).toBe(validateToolDefinitions);
    expect(sdk.validateToolResultJson).toBe(validateToolResultJson);
    expect(sdk.validateMessageContent).toBe(validateMessageContent);
  });

  it("DirectGateway.invokeLlm rejects malformed tools before calling the provider", async () => {
    const create = vi.fn();
    const gateway = new DirectGateway({ chat: { completions: { create } } }, "gpt-4o");
    await expect(gateway.invokeLlm(messages, badTools)).rejects.toThrow(ConfigurationError);
    expect(create).not.toHaveBeenCalled();
    expect(gateway.getHistory()).toHaveLength(0);
  });

  it("DirectGateway.invokeLlmStream rejects malformed tools before calling the provider", async () => {
    const create = vi.fn();
    const gateway = new DirectGateway({ chat: { completions: { create } } }, "gpt-4o");
    const consume = async () => {
      for await (const _chunk of gateway.invokeLlmStream(messages, badTools)) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow(/must be 'function'/);
    expect(create).not.toHaveBeenCalled();
  });

  it("DirectGateway.invokeLlm passes valid tools through to the provider", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const gateway = new DirectGateway({ chat: { completions: { create } } }, "gpt-4o");
    const tools = [{ type: "function", function: { name: "get_weather" } }];
    await gateway.invokeLlm(messages, tools);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].tools).toEqual(tools);
  });

  it("MockGateway does not validate tools, matching the Python MockGateway", async () => {
    const mock = new MockGateway([response]);
    await expect(mock.invokeLlm(messages, badTools)).resolves.toBe(response);
    expect(mock.lastRequest?.tools).toEqual(badTools);
  });
});
