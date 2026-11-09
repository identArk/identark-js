import { describe, it, expect } from "vitest";
import {
  ORCAROUTER_DEFAULT_MODEL,
  ORCAROUTER_FALLBACK_MODEL,
  ORCAROUTER_PROVIDER_NAME,
  OrcaRouterClient,
  createOrcaRouterGateway,
  isTerminalAuthFailure,
  markNeedsReauth,
  probeOrcaRouter,
  recommendedCyberModels,
} from "../src/providers/orcarouter/index.js";
import {
  ORCAROUTER_VERIFIED_SEED,
  parseCatalogResponse,
  isTextChatModel,
} from "../src/providers/orcarouter/catalog.js";
import type { OrcaRouterCredential } from "../src/providers/orcarouter/credentials.js";
import { ConfigurationError, ProviderError, RateLimitError } from "../src/errors.js";

const FAKE_KEY = "sk-orca-test0000000000000000";

interface Recorded {
  url: string;
  method: string;
  auth: string;
  body: Record<string, unknown>;
}

function recordingFetch(
  reply: () => Response,
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return reply();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function completion(content = "ok"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "orcarouter/auto",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("OrcaRouter provider", () => {
  it("exposes the branded provider identity and documented defaults", () => {
    expect(ORCAROUTER_PROVIDER_NAME).toBe("OrcaRouter Cyber Inference");
    expect(ORCAROUTER_DEFAULT_MODEL).toBe("orcarouter/auto");
    expect(ORCAROUTER_FALLBACK_MODEL).toBe("orcarouter/fusion");
  });

  it("rejects a missing key instead of calling out", () => {
    expect(() => new OrcaRouterClient({ apiKey: "  " })).toThrow(ConfigurationError);
  });

  it("sends a Bearer-authenticated chat request to the inference origin", async () => {
    const { fetchImpl, calls } = recordingFetch(() => completion());
    const { gateway } = createOrcaRouterGateway({ apiKey: FAKE_KEY, fetchImpl });

    const response = await gateway.invokeLlm([{ role: "user" as never, content: "hi" }]);

    expect(response.message.content).toBe("ok");
    expect(response.model).toBe("orcarouter/auto");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.orcarouter.ai/v1/chat/completions");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.auth).toBe(`Bearer ${FAKE_KEY}`);
    expect(calls[0]!.body.model).toBe("orcarouter/auto");
    expect(calls[0]!.body.stream).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body)).not.toContain(FAKE_KEY);
  });

  it("uses the caller's model verbatim, including a dedicated cyber model", async () => {
    const { fetchImpl, calls } = recordingFetch(() => completion());
    const { gateway } = createOrcaRouterGateway({
      apiKey: FAKE_KEY,
      model: "orca/orcacyber-ultra-1.0",
      fetchImpl,
    });
    await gateway.invokeLlm([{ role: "user" as never, content: "hi" }]);
    expect(calls[0]!.body.model).toBe("orca/orcacyber-ultra-1.0");
  });

  it("rejects a malformed model ID before sending", () => {
    const { fetchImpl, calls } = recordingFetch(() => completion());
    expect(() =>
      createOrcaRouterGateway({ apiKey: FAKE_KEY, model: "two words", fetchImpl }),
    ).toThrow(ConfigurationError);
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the model is absent from the supplied catalog", async () => {
    const catalog = {
      models: parseCatalogResponse({
        data: [{ id: "orcarouter/auto", supported_endpoint_types: ["openai"] }],
      }).filter(isTextChatModel),
      status: "live" as const,
      fetchedAt: new Date().toISOString(),
    };
    const { fetchImpl, calls } = recordingFetch(() => completion());
    expect(() =>
      createOrcaRouterGateway({
        apiKey: FAKE_KEY,
        model: "vendor/retired",
        catalog,
        fetchImpl,
      }),
    ).toThrow(/not in the current OrcaRouter catalog/);
    expect(calls).toHaveLength(0);

    const ok = createOrcaRouterGateway({ apiKey: FAKE_KEY, catalog, fetchImpl });
    await ok.gateway.invokeLlm([{ role: "user" as never, content: "hi" }]);
    expect(calls).toHaveLength(1);
  });

  it("streams through the same provider path and shape", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"o"}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"content":"k"}}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      "",
      "data: [DONE]",
      "",
      'data: {"chois":"after-done-ignored"}',
    ].join("\n");
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const { gateway } = createOrcaRouterGateway({ apiKey: FAKE_KEY, fetchImpl });

    const chunks = [];
    for await (const chunk of gateway.invokeLlmStream([{ role: "user" as never, content: "hi" }])) {
      chunks.push(chunk);
    }

    expect(calls[0]!.body.stream).toBe(true);
    expect(chunks.map((c) => c.content).join("")).toBe("ok");
    expect(chunks.some((c) => c.finish_reason !== null)).toBe(false);
  });

  it("classifies 429 as RateLimitError and keeps the key out of the message", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "7" },
        }),
    );
    const { gateway } = createOrcaRouterGateway({ apiKey: FAKE_KEY, fetchImpl });
    let error: unknown;
    try {
      await gateway.invokeLlm([{ role: "user" as never, content: "hi" }]);
    } catch (exc) {
      error = exc;
    }
    expect(error).toBeInstanceOf(RateLimitError);
    expect(String((error as Error).message)).not.toContain(FAKE_KEY);
  });

  it("surfaces 401 as a terminal auth failure", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("{}", { status: 401 }));
    const { gateway } = createOrcaRouterGateway({ apiKey: FAKE_KEY, fetchImpl });
    let error: unknown;
    try {
      await gateway.invokeLlm([{ role: "user" as never, content: "hi" }]);
    } catch (exc) {
      error = exc;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect(isTerminalAuthFailure(error)).toBe(true);
    expect(isTerminalAuthFailure(new ProviderError("OrcaRouter request failed with HTTP 500"))).toBe(
      false,
    );
  });

  it("marks only the rejected generation as needing reauthentication", () => {
    const credential: OrcaRouterCredential = {
      apiKey: FAKE_KEY,
      source: "oauth_pkce",
      generation: 4,
      needsReauth: false,
    };
    const stale = markNeedsReauth(credential, 3);
    expect(stale.needsReauth).toBe(false);
    expect(stale).toBe(credential);

    const current = markNeedsReauth(credential, 4);
    expect(current.needsReauth).toBe(true);
    expect(current.apiKey).toBe(FAKE_KEY);
    expect(current.generation).toBe(4);
  });

  it("never invents a refresh token: reauth bumps the generation through the source", () => {
    // The provider exposes no refresh call; a 401 means "authorize again".
    expect("refresh" in new OrcaRouterClient({ apiKey: FAKE_KEY })).toBe(false);
  });

  it("recommends cyber models only when the live catalog lists them", () => {
    expect(recommendedCyberModels()).toEqual([]);
    const catalog = {
      models: parseCatalogResponse({
        data: [
          { id: "orca/orcacyber-ultra-1.0", supported_endpoint_types: ["openai"] },
          { id: "orca/orcacyber-zero-1.5", supported_endpoint_types: ["openai"] },
          { id: "orcarouter/auto", supported_endpoint_types: ["openai"] },
        ],
      }),
      status: "live" as const,
      fetchedAt: new Date().toISOString(),
    };
    expect(recommendedCyberModels(catalog).map((m) => m.id)).toEqual([
      "orca/orcacyber-ultra-1.0",
      "orca/orcacyber-zero-1.5",
    ]);
  });

  it("probes discovery and a chat call through the provider path", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify({ data: [{ id: "orcarouter/auto", supported_endpoint_types: ["openai"] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return completion("ok");
    }) as unknown as typeof fetch;

    const result = await probeOrcaRouter({ apiKey: FAKE_KEY, fetchImpl });
    expect(result.catalog.status).toBe("live");
    expect(result.request.ok).toBe(true);
    expect(result.request.status).toBe(200);
    expect(result.request.excerpt).toBe("ok");
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it("degrades the catalog but still reports the chat status on probe", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/models") {
        return new Response("{}", { status: 403 });
      }
      return new Response(JSON.stringify({ error: { message: "forbidden tier" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await probeOrcaRouter({ apiKey: FAKE_KEY, fetchImpl });
    expect(result.catalog.status).toBe("degraded");
    expect(result.catalog.models.map((m) => m.id)).toEqual(
      ORCAROUTER_VERIFIED_SEED.map((m) => m.id),
    );
    expect(result.request.ok).toBe(false);
    expect(result.request.status).toBe(403);
    expect(String(result.request.error)).not.toContain(FAKE_KEY);
  });
});
