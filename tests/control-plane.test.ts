import { describe, it, expect, beforeEach, vi } from "vitest";
import { ControlPlaneGateway } from "../src/gateways/control-plane.js";
import { Message, Role } from "../src/types.js";
import {
  ConfigurationError,
  AuthenticationError,
  CostCapExceededError,
  SessionNotFoundError,
  ContentPolicyError,
  ControlPlaneError,
} from "../src/errors.js";

// Mock fetch globally
global.fetch = vi.fn();

describe("ControlPlaneGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IDENTARK_API_KEY = "";
    process.env.IDENTARK_SESSION_TOKEN = "";
    process.env.IDENTARK_CONTROL_PLANE_URL = "";
    process.env.IDENTARK_SESSION_ID = "";
  });

  describe("Constructor", () => {
    it("should throw if no API key provided", () => {
      expect(() => {
        new ControlPlaneGateway(
          undefined,
          "http://localhost:3000",
        );
      }).toThrow(ConfigurationError);
    });

    it("should throw if no URL provided", () => {
      expect(() => {
        new ControlPlaneGateway("test-key");
      }).toThrow(ConfigurationError);
    });

    it("should auto-detect from environment variables", () => {
      process.env.IDENTARK_API_KEY = "env-key";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";

      const gateway = new ControlPlaneGateway();
      expect(gateway).toBeDefined();
    });

    it("should prefer IDENTARK_SESSION_TOKEN over IDENTARK_API_KEY", () => {
      process.env.IDENTARK_API_KEY = "api-key";
      process.env.IDENTARK_SESSION_TOKEN = "session-token";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";

      const gateway = new ControlPlaneGateway();
      // Can't directly check which was used, but it should initialize
      expect(gateway).toBeDefined();
    });

    it("should accept explicit parameters", () => {
      const gateway = new ControlPlaneGateway(
        "test-key",
        "http://localhost:3000",
        "session-123",
        30,
        3,
      );
      expect(gateway).toBeDefined();
    });
  });

  describe("invokeLlm", () => {
    beforeEach(() => {
      process.env.IDENTARK_API_KEY = "test-key";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";
    });

    it("should send messages and return response", async () => {
      const mockResponse = {
        message: {
          role: "assistant",
          content: "Hello",
        },
        cost_usd: 0.001,
        model: "gpt-4o",
        finish_reason: "stop",
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          total_tokens: 20,
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const gateway = new ControlPlaneGateway();
      const response = await gateway.invokeLlm([
        { role: Role.USER, content: "Hi" },
      ]);

      expect(response.message.content).toBe("Hello");
      expect(response.cost_usd).toBe(0.001);
      expect(response.model).toBe("gpt-4o");
    });

    it("should include session_id in payload if set", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: "assistant", content: "Test" },
          cost_usd: 0.001,
          model: "test",
          finish_reason: "stop",
        }),
      });

      const gateway = new ControlPlaneGateway(
        "test-key",
        "http://localhost:3000",
        "session-123",
      );
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);

      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.session_id).toBe("session-123");
    });
  });

  describe("requestFileUrl", () => {
    beforeEach(() => {
      process.env.IDENTARK_API_KEY = "test-key";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";
    });

    it("should throw for paths outside /workspace/", async () => {
      const gateway = new ControlPlaneGateway();
      await expect(async () => {
        await gateway.requestFileUrl("/etc/passwd");
      }).rejects.toThrow("not allowed");
    });

    it("should request presigned URL for valid paths", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://presigned.url",
          expires_at: "2025-03-28T23:59:00Z",
          method: "PUT",
          file_path: "/workspace/test.txt",
        }),
      });

      const gateway = new ControlPlaneGateway();
      const presigned = await gateway.requestFileUrl("/workspace/test.txt");

      expect(presigned.url).toBe("https://presigned.url");
      expect(presigned.method).toBe("PUT");
    });
  });

  describe("Error handling", () => {
    beforeEach(() => {
      process.env.IDENTARK_API_KEY = "test-key";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";
    });

    it("should throw AuthenticationError on 401", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({
          error_code: "authentication_failed",
          message: "Invalid token",
        }),
      });

      const gateway = new ControlPlaneGateway();
      await expect(async () => {
        await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      }).rejects.toThrow(AuthenticationError);
    });

    it("should throw CostCapExceededError on 402", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 402,
        text: async () => JSON.stringify({
          error_code: "cost_cap_exceeded",
          message: "Cost cap exceeded",
          cap_usd: 1.0,
          consumed_usd: 1.5,
        }),
      });

      const gateway = new ControlPlaneGateway();
      await expect(async () => {
        await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      }).rejects.toThrow(CostCapExceededError);
    });

    it("should throw SessionNotFoundError on 404 with session_not_found", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          error_code: "session_not_found",
          message: "Session not found",
          session_id: "session-123",
        }),
      });

      const gateway = new ControlPlaneGateway();
      await expect(async () => {
        await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      }).rejects.toThrow(SessionNotFoundError);
    });

    it("should throw ContentPolicyError when appropriate", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          error_code: "content_policy",
          message: "Content blocked",
        }),
      });

      const gateway = new ControlPlaneGateway();
      await expect(async () => {
        await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      }).rejects.toThrow(ContentPolicyError);
    });
  });

  describe("getSessionCost", () => {
    beforeEach(() => {
      process.env.IDENTARK_API_KEY = "test-key";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";
    });

    it("should return session cost", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          cost_usd: 0.123,
        }),
      });

      const gateway = new ControlPlaneGateway();
      const cost = await gateway.getSessionCost();
      expect(cost).toBe(0.123);
    });
  });

  describe("resolveCredential", () => {
    beforeEach(() => {
      process.env.IDENTARK_API_KEY = "test-key";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";
    });

    it("exposes structured credential fields on the returned session", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "postgres",
          path: "prod/postgres",
          value: '{"password":"not-logged"}',
          type: "postgres",
          kind: "database",
          category: "database",
          fields: { host: "db.internal", username: "agent", password: "not-logged", database: "prod" },
        }),
      });

      const gateway = new ControlPlaneGateway();
      const session = await gateway.resolveCredential("prod/postgres");

      expect(session.kind).toBe("database");
      expect(session.fields).toEqual({
        host: "db.internal", username: "agent", password: "not-logged", database: "prod",
      });
    });
  });

  describe("persistMessages", () => {
    beforeEach(() => {
      process.env.IDENTARK_API_KEY = "test-key";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";
    });

    it("should persist messages via control plane", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const gateway = new ControlPlaneGateway();
      const msgs: Message[] = [{ role: Role.TOOL, content: "Result" }];

      await gateway.persistMessages(msgs);

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toContain("/messages/persist");
    });
  });

  describe("close", () => {
    beforeEach(() => {
      process.env.IDENTARK_API_KEY = "test-key";
      process.env.IDENTARK_CONTROL_PLANE_URL = "http://localhost:3000";
    });

    it("should close the gateway without error", async () => {
      const gateway = new ControlPlaneGateway();
      await gateway.close();
      // No error should be thrown
    });
  });

  describe("history modes", () => {
    const reply = (extra: Record<string, unknown> = {}) => ({
      ok: true,
      json: async () => ({
        message: { role: "assistant", content: "Hello!" },
        cost_usd: 0.001,
        model: "gpt-4o",
        finish_reason: "stop",
        ...extra,
      }),
    });
    const sent = (call: number) =>
      JSON.parse((global.fetch as any).mock.calls[call][1].body);
    const gw = (history?: "server" | "client") =>
      new ControlPlaneGateway("test-key", "http://localhost:3000", "sess-1", 30, 3, history);

    it("server mode sends only the new turn", async () => {
      (global.fetch as any).mockResolvedValueOnce(reply());
      const gateway = gw();
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);

      expect(sent(0).new_messages).toEqual([{ role: "user", content: "Hi" }]);
      expect(sent(0).store_history).toBeUndefined();
      expect(gateway.getHistoryMode()).toBe("server");
      expect(gateway.history).toEqual([]);
    });

    it("client mode holds and replays the conversation", async () => {
      (global.fetch as any).mockResolvedValue(reply());
      const gateway = gw("client");
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);
      await gateway.invokeLlm([{ role: Role.USER, content: "And then?" }]);

      expect(sent(0).store_history).toBe(false);
      expect(sent(1).store_history).toBe(false);
      expect(sent(0).new_messages.map((m: any) => m.content)).toEqual(["Hi"]);
      expect(sent(1).new_messages.map((m: any) => m.content)).toEqual(["Hi", "Hello!", "And then?"]);
      expect(gateway.history.map((m) => m.content)).toEqual(["Hi", "Hello!", "And then?", "Hello!"]);
    });

    it("client mode keeps assistant tool calls", async () => {
      (global.fetch as any).mockResolvedValueOnce(
        reply({
          message: { role: "assistant", content: "" },
          tool_calls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }],
        }),
      );
      const gateway = gw("client");
      await gateway.invokeLlm([{ role: Role.USER, content: "Find it" }]);

      expect(gateway.history[1].tool_calls).toEqual([
        { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
      ]);
    });

    it("client mode persist is local", async () => {
      (global.fetch as any).mockResolvedValue(reply());
      const gateway = gw("client");
      await gateway.persistMessages([{ role: Role.SYSTEM, content: "Be brief." }]);
      expect((global.fetch as any).mock.calls.length).toBe(0);
      await gateway.invokeLlm([{ role: Role.USER, content: "Hi" }]);

      expect(sent(0).new_messages.map((m: any) => m.content)).toEqual(["Be brief.", "Hi"]);
      gateway.clearHistory();
      expect(gateway.history).toEqual([]);
    });

    it("reads the mode from IDENTARK_HISTORY_MODE and rejects unknown modes", () => {
      process.env.IDENTARK_HISTORY_MODE = "client";
      try {
        expect(gw().getHistoryMode()).toBe("client");
      } finally {
        delete process.env.IDENTARK_HISTORY_MODE;
      }
      expect(() => gw("browser" as any)).toThrow(ConfigurationError);
    });

    const sse = (text: string) => ({
      ok: true,
      body: new Response(text).body,
    });

    it("client mode stream records the streamed reply", async () => {
      (global.fetch as any).mockResolvedValueOnce(
        sse('data: {"delta": "Hello "}\n\ndata: {"delta": "world"}\n\ndata: {"finish_reason": "stop"}\n\n'),
      );
      const gateway = gw("client");
      let text = "";
      for await (const chunk of gateway.invokeLlmStream([{ role: Role.USER, content: "Hi" }])) {
        text += chunk.content;
      }

      expect(text).toBe("Hello world");
      expect(sent(0).store_history).toBe(false);
      expect(gateway.history).toEqual([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello world" },
      ]);
    });

    it("stream error event raises and records nothing", async () => {
      (global.fetch as any).mockResolvedValueOnce(sse('data: {"error": "provider down"}\n\n'));
      const gateway = gw("client");
      await expect(async () => {
        for await (const _ of gateway.invokeLlmStream([{ role: Role.USER, content: "Hi" }])) {
          // drain
        }
      }).rejects.toThrow(ControlPlaneError);
      expect(gateway.history).toEqual([]);
    });
  });
});
