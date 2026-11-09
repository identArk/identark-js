import { describe, it, expect } from "vitest";
import {
  CATALOG_LIMITS,
  ORCAROUTER_VERIFIED_SEED,
  OrcaRouterCatalogCache,
  discoverOrcaRouterModels,
  filterModelsByModality,
  isTextChatModel,
  parseCatalogModel,
  parseCatalogResponse,
  revalidateSelectedModel,
  type OrcaRouterModel,
} from "../src/providers/orcarouter/catalog.js";

const FAKE_KEY = "sk-orca-test0000000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const liveBody = {
  data: [
    {
      id: "orcarouter/auto",
      name: "OrcaRouter Auto",
      context_length: 200000,
      architecture: { input_modalities: ["text"] },
      supported_endpoint_types: ["openai", "anthropic"],
      supported_parameters: [],
    },
    {
      id: "orca/orcacyber-ultra-1.0",
      name: "OrcaCyber Ultra",
      context_length: 256000,
      architecture: { input_modalities: ["text"] },
      supported_endpoint_types: ["openai"],
      supported_parameters: ["reasoning"],
    },
    {
      id: "orca/orcacyber-zero-1.5",
      name: "OrcaCyber Zero",
      context_length: 256000,
      architecture: { input_modalities: ["text"] },
      supported_endpoint_types: ["openai"],
      supported_parameters: ["reasoning"],
    },
    {
      id: "openai/gpt-5.5",
      name: "GPT-5.5",
      context_length: 400000,
      architecture: { input_modalities: ["text", "image"] },
      supported_endpoint_types: ["openai-response"],
      supported_parameters: ["reasoning"],
    },
    {
      id: "google/imagen-4",
      name: "Imagen 4",
      architecture: { input_modalities: ["text"] },
      supported_endpoint_types: ["image-generation"],
      supported_parameters: [],
    },
    {
      id: "openai/sora-2",
      name: "Sora 2",
      architecture: { input_modalities: ["text", "image"] },
      supported_endpoint_types: ["openai-video"],
      supported_parameters: [],
    },
    {
      id: "jina/jina-reranker-v3",
      name: "Jina Reranker",
      architecture: { input_modalities: ["text"] },
      supported_endpoint_types: ["jina-rerank"],
      supported_parameters: [],
    },
    {
      id: "openai/text-embedding-4",
      name: "Text Embedding 4",
      architecture: { input_modalities: ["text"] },
      supported_endpoint_types: ["embeddings"],
      supported_parameters: [],
    },
    {
      id: "acme/gemini-pro",
      name: "Gemini Pro",
      architecture: { input_modalities: ["text", "image", "audio"] },
      supported_endpoint_types: ["gemini"],
      supported_parameters: ["reasoning"],
    },
  ],
};

describe("OrcaRouter model catalog", () => {
  it("parses vendor-qualified IDs verbatim and keeps metadata", () => {
    const model = parseCatalogModel(liveBody.data[1]);
    expect(model).toBeDefined();
    expect(model!.id).toBe("orca/orcacyber-ultra-1.0");
    expect(model!.contextLength).toBe(256000);
    expect(model!.reasoning).toBe(true);
    expect(model!.inputModalities).toEqual(["text"]);
  });

  it("drops records without an ID and never invents one", () => {
    expect(parseCatalogModel({ name: "no id" })).toBeUndefined();
    expect(parseCatalogModel(null)).toBeUndefined();
    expect(parseCatalogModel({ id: "   " })).toBeUndefined();
  });

  it("defaults to text modality when a record declares none", () => {
    const model = parseCatalogModel({ id: "x/y", supported_endpoint_types: ["openai"] });
    expect(model!.inputModalities).toEqual(["text"]);
  });

  it("keeps only text chat models and excludes non-chat endpoint types", () => {
    const models = parseCatalogResponse(liveBody).filter(isTextChatModel);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("orcarouter/auto");
    expect(ids).toContain("orca/orcacyber-ultra-1.0");
    expect(ids).toContain("orca/orcacyber-zero-1.5");
    expect(ids).toContain("openai/gpt-5.5");
    expect(ids).toContain("acme/gemini-pro");
    expect(ids).not.toContain("google/imagen-4");
    expect(ids).not.toContain("openai/sora-2");
    expect(ids).not.toContain("jina/jina-reranker-v3");
    expect(ids).not.toContain("openai/text-embedding-4");
  });

  it("filters by modality fail-closed: undeclared modality is excluded", () => {
    const models = parseCatalogResponse(liveBody);
    const imageModels = filterModelsByModality(models, "image").map((m) => m.id);
    expect(imageModels).toContain("openai/gpt-5.5");
    expect(imageModels).toContain("acme/gemini-pro");
    expect(imageModels).not.toContain("orcarouter/auto");
    expect(imageModels).not.toContain("orca/orcacyber-ultra-1.0");
    // Video is never inferred from a text/image declaration.
    expect(filterModelsByModality(models, "video")).toHaveLength(0);
  });

  it("bounds the parsed catalog", () => {
    const many = Array.from({ length: CATALOG_LIMITS.maxModels + 50 }, (_, i) => ({
      id: `vendor/model-${i}`,
      supported_endpoint_types: ["openai"],
    }));
    expect(parseCatalogResponse({ data: many })).toHaveLength(CATALOG_LIMITS.maxModels);
  });

  it("discovers from the inference origin with a Bearer key", async () => {
    let seen: { url: string; auth: string } | undefined;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      seen = {
        url: String(input),
        auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
      };
      return jsonResponse(liveBody);
    }) as unknown as typeof fetch;

    const catalog = await discoverOrcaRouterModels({
      apiBaseUrl: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      fetchImpl,
    });

    expect(seen!.url).toBe("https://api.orcarouter.ai/v1/models?capability=chat");
    expect(seen!.auth).toBe(`Bearer ${FAKE_KEY}`);
    expect(catalog.status).toBe("live");
    expect(catalog.reason).toBeUndefined();
    expect(catalog.models.map((m) => m.id)).toContain("orcarouter/auto");
    expect(catalog.models.map((m) => m.id)).not.toContain("google/imagen-4");
    expect(ORCAROUTER_VERIFIED_SEED.map((m) => m.id)).not.toContain("google/imagen-4");
  });

  it.each([
    ["HTTP 401", (async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch, "unauthorized"],
    ["HTTP 500", (async () => jsonResponse({}, 500)) as unknown as typeof fetch, "http 500"],
    ["unreadable body", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch, "unreadable response"],
    ["network error", (async () => Promise.reject(new Error("boom"))) as unknown as typeof fetch, "network error"],
  ])("falls back to the verified seed on %s", async (_label, fetchImpl, reason) => {
    const catalog = await discoverOrcaRouterModels({
      apiBaseUrl: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      fetchImpl,
    });
    expect(catalog.status).toBe("degraded");
    expect(catalog.reason).toBe(reason);
    expect(catalog.models.map((m) => m.id)).toEqual(
      ORCAROUTER_VERIFIED_SEED.map((m) => m.id),
    );
  });

  it("the seed itself is text-chat only and includes the documented defaults", () => {
    const ids = ORCAROUTER_VERIFIED_SEED.map((m) => m.id);
    expect(ids).toContain("orcarouter/auto");
    expect(ORCAROUTER_VERIFIED_SEED.every(isTextChatModel)).toBe(true);
    expect(ORCAROUTER_VERIFIED_SEED.every((m) => !m.id.startsWith("deepseek/") || m.id !== "deepseek")).toBe(true);
  });

  it("caches a live catalog and refreshes on demand", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(liveBody);
    }) as unknown as typeof fetch;
    const cache = new OrcaRouterCatalogCache({
      apiBaseUrl: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      fetchImpl,
      ttlMs: 60_000,
    });

    const first = await cache.get();
    const second = await cache.get();
    expect(first).toBe(second);
    expect(calls).toBe(1);

    const forced = await cache.get(true);
    expect(calls).toBe(2);
    expect(forced.status).toBe("live");

    cache.invalidate();
    await cache.get();
    expect(calls).toBe(3);
  });

  it("re-validates a stale selection and clears it when gone", () => {
    const models = parseCatalogResponse(liveBody);
    const catalog = { models, status: "live" as const, fetchedAt: new Date().toISOString() };
    expect(revalidateSelectedModel(catalog, "orcarouter/auto")?.id).toBe("orcarouter/auto");
    expect(revalidateSelectedModel(catalog, "vendor/retired")).toBeUndefined();
    // Present, but not compatible with the requested modality.
    expect(revalidateSelectedModel(catalog, "orcarouter/auto", "image")).toBeUndefined();
    expect(revalidateSelectedModel(catalog, "openai/gpt-5.5", "image")?.id).toBe("openai/gpt-5.5");
  });

  it("never turns a free-text model into a catalog entry", () => {
    const models: OrcaRouterModel[] = parseCatalogResponse(liveBody).filter(isTextChatModel);
    const catalog = { models, status: "live" as const, fetchedAt: new Date().toISOString() };
    expect(revalidateSelectedModel(catalog, "my own model")).toBeUndefined();
  });
});
