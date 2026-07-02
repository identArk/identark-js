import { describe, it, expect } from "vitest";
import { Role, messageToOpenAiDict } from "../src/types.js";

describe("Types", () => {
  describe("Role enum", () => {
    it("should have correct values", () => {
      expect(Role.USER).toBe("user");
      expect(Role.ASSISTANT).toBe("assistant");
      expect(Role.TOOL).toBe("tool");
      expect(Role.SYSTEM).toBe("system");
    });
  });

  describe("messageToOpenAiDict", () => {
    it("should serialize a basic message", () => {
      const msg = {
        role: Role.USER,
        content: "Hello",
      };
      const result = messageToOpenAiDict(msg);
      expect(result).toEqual({
        role: Role.USER,
        content: "Hello",
      });
    });

    it("should include tool_call_id when present", () => {
      const msg = {
        role: Role.TOOL,
        content: "Done",
        tool_call_id: "call_123",
      };
      const result = messageToOpenAiDict(msg);
      expect(result.tool_call_id).toBe("call_123");
    });

    it("should include name when present", () => {
      const msg = {
        role: Role.ASSISTANT,
        content: "Hello",
        name: "Assistant",
      };
      const result = messageToOpenAiDict(msg);
      expect(result.name).toBe("Assistant");
    });

    it("should not include undefined optional fields", () => {
      const msg = {
        role: Role.USER,
        content: "Hello",
      };
      const result = messageToOpenAiDict(msg);
      expect("tool_call_id" in result).toBe(false);
      expect("name" in result).toBe(false);
    });
  });
});
