/**
 * Parity tests for DirectGateway's provider error classification.
 *
 * Mirrors the behaviour of the Python SDK's
 * `DirectGateway._classify_openai_error` / `_classify_anthropic_error`
 * (identark/gateways/direct.py).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DirectGateway } from "../src/gateways/direct.js";
import { Role } from "../src/types.js";
import type { Message } from "../src/types.js";
import { ContentPolicyError, ProviderError, RateLimitError } from "../src/errors.js";

// ── Provider SDK error doubles ────────────────────────────────────────────────
// The real SDKs are optional peer dependencies, so the classifier recognises
// them structurally (class chain / status / code). These stand in for them.

/** Base of the OpenAI JS SDK error hierarchy. */
class APIError extends Error {
  status?: number;
  code?: string;
  headers?: Record<string, string>;

  constructor(message: string, status?: number, code?: string, headers?: Record<string, string>) {
    super(message);
    this.name = this.constructor.name;
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
    if (headers !== undefined) this.headers = headers;
    Object.setPrototypeOf(this, APIError.prototype);
  }
}

class SdkRateLimitError extends APIError {
  constructor(message: string, headers?: Record<string, string>) {
    super(message, 429, "rate_limit_exceeded", headers);
    Object.setPrototypeOf(this, SdkRateLimitError.prototype);
  }
}
// The classifier matches on class names, so give it the SDK's real name.
Object.defineProperty(SdkRateLimitError, "name", { value: "RateLimitError" });

class SdkAuthenticationError extends APIError {
  constructor(message: string) {
    super(message, 401, "invalid_api_key");
    Object.setPrototypeOf(this, SdkAuthenticationError.prototype);
  }
}
Object.defineProperty(SdkAuthenticationError, "name", { value: "AuthenticationError" });

class ContentFilterFinishReasonError extends APIError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ContentFilterFinishReasonError.prototype);
  }
}

const USER_MSG: Message[] = [{ role: Role.USER, content: "Hi" }];

function openAiGateway(create: ReturnType<typeof vi.fn>, provider?: string): DirectGateway {
  return new DirectGateway(
    { chat: { completions: { create } } },
    "gpt-4o",
    undefined,
    undefined,
    "/workspace",
    provider,
  );
}

function anthropicGateway(create: ReturnType<typeof vi.fn>): DirectGateway {
  return new DirectGateway(
    { messages: { create } },
    "claude-3-5-sonnet-20241022",
    undefined,
    undefined,
    "/workspace",
    "anthropic",
  );
}

/** Invoke the gateway and return whatever it threw. */
async function captureThrown(gateway: DirectGateway): Promise<unknown> {
  try {
    await gateway.invokeLlm(USER_MSG);
  } catch (exc) {
    return exc;
  }
  throw new Error("expected invokeLlm to throw, but it resolved");
}

describe("DirectGateway OpenAI error classification", () => {
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn();
  });

  describe("rate limits", () => {
    it("maps an SDK RateLimitError to RateLimitError", async () => {
      create.mockRejectedValueOnce(new SdkRateLimitError("Rate limit reached"));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).toBeInstanceOf(RateLimitError);
      expect((thrown as RateLimitError).message).toBe("Rate limit reached");
      expect((thrown as RateLimitError).provider).toBe("openai");
    });

    it("maps a bare status 429 to RateLimitError", async () => {
      const exc = new APIError("Too many requests", 429);
      create.mockRejectedValueOnce(exc);

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).toBeInstanceOf(RateLimitError);
      expect((thrown as RateLimitError).retry_after_seconds).toBe(60);
    });

    it("defaults retry_after_seconds to 60 when no hint is present", async () => {
      create.mockRejectedValueOnce(new SdkRateLimitError("Rate limit reached"));

      const thrown = await captureThrown(openAiGateway(create));

      expect((thrown as RateLimitError).retry_after_seconds).toBe(60);
    });

    it("reads retry_after_seconds from a retry-after header record", async () => {
      create.mockRejectedValueOnce(new SdkRateLimitError("Slow down", { "retry-after": "30" }));

      const thrown = await captureThrown(openAiGateway(create));

      expect((thrown as RateLimitError).retry_after_seconds).toBe(30);
    });

    it("reads retry-after from a Headers instance", async () => {
      const exc = new SdkRateLimitError("Slow down");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (exc as any).headers = new Headers({ "retry-after": "12" });
      create.mockRejectedValueOnce(exc);

      const thrown = await captureThrown(openAiGateway(create));

      expect((thrown as RateLimitError).retry_after_seconds).toBe(12);
    });

    it("falls back to 60 when retry-after is not a usable number", async () => {
      create.mockRejectedValueOnce(
        new SdkRateLimitError("Slow down", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      );

      const thrown = await captureThrown(openAiGateway(create));

      expect((thrown as RateLimitError).retry_after_seconds).toBe(60);
    });

    it("carries the configured provider onto the error", async () => {
      create.mockRejectedValueOnce(new APIError("Too many requests", 429));

      const thrown = await captureThrown(openAiGateway(create, "mistral"));

      expect((thrown as RateLimitError).provider).toBe("mistral");
    });

    it("does not treat a non-429 status as a rate limit", async () => {
      create.mockRejectedValueOnce(new APIError("Service unavailable", 503));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).not.toBeInstanceOf(RateLimitError);
      expect(thrown).toBeInstanceOf(ProviderError);
    });
  });

  describe("content policy", () => {
    it("maps ContentFilterFinishReasonError to ContentPolicyError", async () => {
      create.mockRejectedValueOnce(new ContentFilterFinishReasonError("Blocked"));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).toBeInstanceOf(ContentPolicyError);
      expect((thrown as ContentPolicyError).message).toBe("Blocked");
    });

    it.each(["content_filter", "content_policy_violation", "output_blocked"])(
      "maps error code %s to ContentPolicyError",
      async (code) => {
        create.mockRejectedValueOnce(new APIError("Request rejected", 400, code));

        const thrown = await captureThrown(openAiGateway(create));

        expect(thrown).toBeInstanceOf(ContentPolicyError);
      },
    );

    it.each([
      "Response hit the content_filter",
      "Blocked by the content filtering policy",
      "Output blocked by safety systems",
    ])("maps message %s to ContentPolicyError via the string fallback", async (message) => {
      create.mockRejectedValueOnce(new APIError(message, 400));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).toBeInstanceOf(ContentPolicyError);
    });

    it("does not treat an unrelated error code as a content policy block", async () => {
      create.mockRejectedValueOnce(new APIError("Bad request", 400, "invalid_request_error"));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).not.toBeInstanceOf(ContentPolicyError);
      expect(thrown).toBeInstanceOf(ProviderError);
    });

    it("prefers a rate limit over a content-policy message", async () => {
      create.mockRejectedValueOnce(new APIError("content_filter tripped", 429));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).toBeInstanceOf(RateLimitError);
    });
  });

  describe("authentication", () => {
    it("maps an SDK AuthenticationError to ProviderError with a clear prefix", async () => {
      create.mockRejectedValueOnce(new SdkAuthenticationError("Incorrect API key provided"));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).message).toContain("Authentication failed:");
      expect((thrown as ProviderError).message).toContain("Incorrect API key provided");
    });

    it("maps a bare status 401 to the same authentication ProviderError", async () => {
      create.mockRejectedValueOnce(new APIError("Unauthorized", 401));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).message).toContain("Authentication failed:");
    });

    it("does not classify a 403 as an authentication failure", async () => {
      create.mockRejectedValueOnce(new APIError("Forbidden", 403));

      const thrown = await captureThrown(openAiGateway(create));

      expect((thrown as ProviderError).message).not.toContain("Authentication failed:");
      expect((thrown as ProviderError).message).toContain("Openai API error:");
    });
  });

  describe("fallback", () => {
    it("wraps an unclassified error as a capitalised provider error", async () => {
      create.mockRejectedValueOnce(new Error("kaboom"));

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).message).toContain("Openai API error:");
      expect((thrown as ProviderError).message).toContain("kaboom");
    });

    it("uses the resolved provider name in the fallback message", async () => {
      create.mockRejectedValueOnce(new Error("kaboom"));

      const thrown = await captureThrown(openAiGateway(create, "local"));

      expect((thrown as ProviderError).message).toContain("Local API error:");
    });

    it("does not reclassify a response-parsing bug as a provider error", async () => {
      // Python only wraps the API call itself; parsing failures must surface
      // as-is rather than being laundered into a ProviderError.
      create.mockResolvedValueOnce({ choices: [] });

      const thrown = await captureThrown(openAiGateway(create));

      expect(thrown).not.toBeInstanceOf(ProviderError);
      expect(thrown).toBeInstanceOf(TypeError);
    });
  });
});

describe("DirectGateway Anthropic error classification", () => {
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn();
  });

  it("maps an SDK RateLimitError to RateLimitError with provider anthropic", async () => {
    create.mockRejectedValueOnce(new SdkRateLimitError("Rate limited"));

    const thrown = await captureThrown(anthropicGateway(create));

    expect(thrown).toBeInstanceOf(RateLimitError);
    expect((thrown as RateLimitError).provider).toBe("anthropic");
  });

  it("maps a bare status 429 to RateLimitError", async () => {
    create.mockRejectedValueOnce(new APIError("Overloaded", 429));

    const thrown = await captureThrown(anthropicGateway(create));

    expect(thrown).toBeInstanceOf(RateLimitError);
    expect((thrown as RateLimitError).retry_after_seconds).toBe(60);
  });

  it("reads a retry-after header", async () => {
    create.mockRejectedValueOnce(new SdkRateLimitError("Rate limited", { "retry-after": "5" }));

    const thrown = await captureThrown(anthropicGateway(create));

    expect((thrown as RateLimitError).retry_after_seconds).toBe(5);
  });

  it.each(["content_policy_violation", "content_filter"])(
    "maps error type %s to ContentPolicyError",
    async (type) => {
      const exc = new APIError("Rejected", 400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (exc as any).type = type;
      create.mockRejectedValueOnce(exc);

      const thrown = await captureThrown(anthropicGateway(create));

      expect(thrown).toBeInstanceOf(ContentPolicyError);
    },
  );

  it.each([
    "Blocked by the content filtering policy",
    "Output blocked",
    "Violates our content policy",
  ])("maps message %s to ContentPolicyError via the string fallback", async (message) => {
    create.mockRejectedValueOnce(new APIError(message, 400));

    const thrown = await captureThrown(anthropicGateway(create));

    expect(thrown).toBeInstanceOf(ContentPolicyError);
  });

  it("does not treat an unrelated error type as a content policy block", async () => {
    const exc = new APIError("Bad request", 400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (exc as any).type = "invalid_request_error";
    create.mockRejectedValueOnce(exc);

    const thrown = await captureThrown(anthropicGateway(create));

    expect(thrown).not.toBeInstanceOf(ContentPolicyError);
    expect(thrown).toBeInstanceOf(ProviderError);
  });

  it("maps an SDK AuthenticationError to an authentication ProviderError", async () => {
    create.mockRejectedValueOnce(new SdkAuthenticationError("invalid x-api-key"));

    const thrown = await captureThrown(anthropicGateway(create));

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toContain("Anthropic authentication failed:");
  });

  it("maps a bare status 401 to an authentication ProviderError", async () => {
    create.mockRejectedValueOnce(new APIError("Unauthorized", 401));

    const thrown = await captureThrown(anthropicGateway(create));

    expect((thrown as ProviderError).message).toContain("Anthropic authentication failed:");
  });

  it("wraps an unclassified error as an Anthropic provider error", async () => {
    create.mockRejectedValueOnce(new Error("kaboom"));

    const thrown = await captureThrown(anthropicGateway(create));

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toContain("Anthropic API error:");
    expect((thrown as ProviderError).message).toContain("kaboom");
  });
});

describe("DirectGateway streaming error classification", () => {
  /** Drain a stream and return whatever it threw. */
  async function captureStreamThrown(gateway: DirectGateway): Promise<unknown> {
    try {
      for await (const _chunk of gateway.invokeLlmStream(USER_MSG)) {
        // drain
      }
    } catch (exc) {
      return exc;
    }
    throw new Error("expected invokeLlmStream to throw, but it completed");
  }

  it("classifies an OpenAI stream rate limit", async () => {
    const create = vi.fn().mockRejectedValueOnce(new SdkRateLimitError("Slow down", {
      "retry-after": "7",
    }));

    const thrown = await captureStreamThrown(openAiGateway(create));

    expect(thrown).toBeInstanceOf(RateLimitError);
    expect((thrown as RateLimitError).retry_after_seconds).toBe(7);
  });

  it("classifies an OpenAI stream authentication failure", async () => {
    const create = vi.fn().mockRejectedValueOnce(new APIError("Unauthorized", 401));

    const thrown = await captureStreamThrown(openAiGateway(create));

    expect((thrown as ProviderError).message).toContain("Authentication failed:");
  });

  it("classifies an Anthropic stream content-policy block by error type", async () => {
    const exc = new APIError("Rejected", 400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (exc as any).type = "content_policy_violation";
    const stream = vi.fn().mockRejectedValueOnce(exc);
    const gateway = new DirectGateway(
      { messages: { stream } },
      "claude-3-5-sonnet-20241022",
      undefined,
      undefined,
      "/workspace",
      "anthropic",
    );

    const thrown = await captureStreamThrown(gateway);

    expect(thrown).toBeInstanceOf(ContentPolicyError);
  });

  it("classifies an Anthropic stream rate limit as a rate limit, not a generic error", async () => {
    const stream = vi.fn().mockRejectedValueOnce(new APIError("Overloaded", 429));
    const gateway = new DirectGateway(
      { messages: { stream } },
      "claude-3-5-sonnet-20241022",
      undefined,
      undefined,
      "/workspace",
      "anthropic",
    );

    const thrown = await captureStreamThrown(gateway);

    expect(thrown).toBeInstanceOf(RateLimitError);
    expect((thrown as RateLimitError).provider).toBe("anthropic");
  });
});
