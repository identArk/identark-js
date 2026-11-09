import { describe, it, expect } from "vitest";
import { createOrcaRouterGateway, probeOrcaRouter } from "../src/providers/orcarouter/index.js";
import { discoverOrcaRouterModels } from "../src/providers/orcarouter/catalog.js";

/**
 * Live connectivity check. Runs only when a real key is present in the
 * environment; skipped otherwise so CI stays hermetic and no key is committed.
 */
const apiKey = process.env.ORCAROUTER_API_KEY?.trim();
const hasKey = Boolean(apiKey);

/**
 * Dedicated cyber model first (this key is provisioned for the cyber tier);
 * a general model is only used to prove connectivity if the cyber tier is
 * rejected. Neither is ever written as a user-facing default.
 */
const LIVE_MODEL_CANDIDATES = [
  process.env.ORCAROUTER_LIVE_MODEL,
  "orca/orcacyber-ultra-1.0",
  "deepseek/deepseek-v4.1-flash",
].filter((id): id is string => typeof id === "string" && id.length > 0);

/**
 * The live suite talks to a real gateway, so a transient transport failure must
 * not be reported as a provider bug. Retry the whole assertion a few times and
 * surface the last error only if every attempt fails.
 */
async function retryTransient<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (exc) {
      lastError = exc;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

describe.skipIf(!hasKey)("OrcaRouter live connectivity", () => {
  it("discovers the real chat catalog from the inference origin", async () => {
    await retryTransient(async () => {
      const catalog = await discoverOrcaRouterModels({
        apiBaseUrl: "https://api.orcarouter.ai/v1",
        apiKey: apiKey as string,
      });
      expect(catalog.status).toBe("live");
      expect(catalog.models.length).toBeGreaterThan(0);
      expect(catalog.models.some((m) => m.id === "orcarouter/auto")).toBe(true);
      // The dedicated cyber models are present in the live catalog.
      expect(catalog.models.some((m) => m.id === "orca/orcacyber-ultra-1.0")).toBe(true);
      // No image/video/rerank/embedding models leak into the chat catalog.
      for (const model of catalog.models) {
        expect(model.inputModalities).toContain("text");
      }
    });
  }, 60_000);

  it("answers one chat request through the provider code path", async () => {
    await retryTransient(async () => {
      let last: Awaited<ReturnType<typeof probeOrcaRouter>> | undefined;
      for (const model of LIVE_MODEL_CANDIDATES) {
        last = await probeOrcaRouter({ apiKey: apiKey as string, model });
        if (last.request.status === 200) {
          break;
        }
        // Only a tier/entitlement rejection justifies trying the next model.
        if (last.request.status !== 403) {
          break;
        }
      }
      expect(last).toBeDefined();
      expect(last!.request.status).toBe(200);
      expect(last!.request.ok).toBe(true);
      expect(last!.catalog.models.length).toBeGreaterThan(0);
      expect(JSON.stringify(last)).not.toContain(apiKey as string);
    });
  }, 120_000);

  it("streams a reply through the provider code path", async () => {
    await retryTransient(async () => {
      let streamed = "";
      let used = "";
      for (const model of LIVE_MODEL_CANDIDATES) {
        try {
          const { gateway } = createOrcaRouterGateway({ apiKey: apiKey as string, model });
          streamed = "";
          for await (const chunk of gateway.invokeLlmStream([
            { role: "user" as never, content: "Reply with the single word: ok" },
          ])) {
            streamed += chunk.content;
          }
          used = model;
          break;
        } catch (exc) {
          const status = (exc as { message?: string }).message ?? "";
          if (!status.includes("HTTP 403")) {
            throw exc;
          }
          // Tier entitlement rejection: try the next candidate model.
        }
      }
      expect(used).not.toBe("");
      expect(streamed.trim().length).toBeGreaterThan(0);
    });
  }, 120_000);
});
