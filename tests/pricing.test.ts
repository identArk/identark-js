import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `loadLocalOverrides` reads `~/.identark/pricing.json`. Point HOME at a throwaway
// directory so the suite never depends on (or is polluted by) the real one.
const mocks = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mocks.home };
});

type PricingModule = typeof import("../src/pricing.js");

/** Pricing caches its table in module scope, so each test needs a fresh copy. */
async function loadPricing(): Promise<PricingModule> {
  vi.resetModules();
  return import("../src/pricing.js");
}

function writeLocalOverrides(contents: string): void {
  mkdirSync(join(mocks.home, ".identark"), { recursive: true });
  writeFileSync(join(mocks.home, ".identark", "pricing.json"), contents);
}

let originalPricingUrl: string | undefined;

beforeEach(() => {
  mocks.home = mkdtempSync(join(tmpdir(), "identark-pricing-"));
  originalPricingUrl = process.env.IDENTARK_PRICING_URL;
  delete process.env.IDENTARK_PRICING_URL;
});

afterEach(() => {
  rmSync(mocks.home, { recursive: true, force: true });
  if (originalPricingUrl === undefined) {
    delete process.env.IDENTARK_PRICING_URL;
  } else {
    process.env.IDENTARK_PRICING_URL = originalPricingUrl;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Pricing", () => {
  describe("getPricing", () => {
    it("should return pricing for a known model", async () => {
      const { getPricing } = await loadPricing();
      const pricing = getPricing("gpt-4o");
      expect(pricing).toBeDefined();
      expect(pricing?.input).toBe(2.5);
      expect(pricing?.output).toBe(10.0);
    });

    it("should return undefined for an unknown model", async () => {
      const { getPricing } = await loadPricing();
      expect(getPricing("unknown-model-xyz")).toBeUndefined();
    });

    it("should return correct Anthropic pricing", async () => {
      const { getPricing } = await loadPricing();
      const pricing = getPricing("claude-3-5-sonnet-20241022");
      expect(pricing?.input).toBe(3.0);
      expect(pricing?.output).toBe(15.0);
    });

    it("should return correct Mistral pricing", async () => {
      const { getPricing } = await loadPricing();
      const pricing = getPricing("mistral-large-latest");
      expect(pricing?.input).toBe(2.0);
      expect(pricing?.output).toBe(6.0);
    });

    it("should return correct Gemini pricing", async () => {
      const { getPricing } = await loadPricing();
      const pricing = getPricing("gemini-1.5-flash");
      expect(pricing?.input).toBe(0.075);
      expect(pricing?.output).toBe(0.3);
    });

    it("should return an empty string model as undefined", async () => {
      const { getPricing } = await loadPricing();
      expect(getPricing("")).toBeUndefined();
    });

    it("should not resolve inherited Object properties as models", async () => {
      const { getPricing } = await loadPricing();
      expect(getPricing("toString")).toBeUndefined();
      expect(getPricing("constructor")).toBeUndefined();
    });
  });

  describe("listKnownModels", () => {
    it("should include models from every bundled provider", async () => {
      const { listKnownModels } = await loadPricing();
      const models = listKnownModels();
      expect(models).toContain("gpt-4o");
      expect(models).toContain("gpt-4o-mini");
      expect(models).toContain("o1");
      expect(models).toContain("claude-3-5-sonnet-20241022");
      expect(models).toContain("claude-opus-4-20250514");
      expect(models).toContain("mistral-large-latest");
      expect(models).toContain("gemini-1.5-pro");
    });

    it("should not include unknown models", async () => {
      const { listKnownModels } = await loadPricing();
      expect(listKnownModels()).not.toContain("unknown-model-xyz");
    });

    it("should include models added by setPricingTable", async () => {
      const { listKnownModels, setPricingTable } = await loadPricing();
      setPricingTable({ "custom-model": { input: 1.0, output: 2.0 } });
      const models = listKnownModels();
      expect(models).toContain("custom-model");
      expect(models).toContain("gpt-4o");
    });
  });

  describe("setPricingTable", () => {
    it("should override pricing and keep bundled models reachable", async () => {
      const { getPricing, setPricingTable } = await loadPricing();
      setPricingTable({ "custom-model": { input: 1.0, output: 2.0 } });

      const pricing = getPricing("custom-model");
      expect(pricing?.input).toBe(1.0);
      expect(pricing?.output).toBe(2.0);
      expect(getPricing("gpt-4o")).toBeDefined();
    });

    it("should replace the price of a bundled model", async () => {
      const { getPricing, setPricingTable } = await loadPricing();
      setPricingTable({ "gpt-4o": { input: 99.0, output: 100.0 } });
      expect(getPricing("gpt-4o")?.input).toBe(99.0);
    });

    it("should flow through to estimateCost", async () => {
      const { estimateCost, setPricingTable } = await loadPricing();
      setPricingTable({ "custom-model": { input: 1.0, output: 2.0 } });
      expect(estimateCost("custom-model", 1_000_000, 1_000_000)).toBeCloseTo(3.0, 10);
    });

    it("should suppress the local override file", async () => {
      writeLocalOverrides(JSON.stringify({ "gpt-4o": { input: 1.0, output: 1.0 } }));
      const { getPricing, setPricingTable } = await loadPricing();

      setPricingTable({ "custom-model": { input: 1.0, output: 2.0 } });

      expect(getPricing("gpt-4o")?.input).toBe(2.5);
    });
  });

  describe("estimateCost", () => {
    it("should estimate cost for a known model", async () => {
      const { estimateCost } = await loadPricing();
      const expected = (1000 * 2.5 + 500 * 10.0) / 1_000_000;
      expect(estimateCost("gpt-4o", 1000, 500)).toBeCloseTo(expected, 10);
    });

    it("should return zero for the local provider", async () => {
      const { estimateCost } = await loadPricing();
      expect(estimateCost("any-model", 1_000_000, 1_000_000, "local")).toBe(0);
    });

    it("should use the fallback rate for an unknown model", async () => {
      const { estimateCost, UNKNOWN_MODEL_RATE } = await loadPricing();
      const expected = (1000 + 500) * UNKNOWN_MODEL_RATE;
      expect(estimateCost("unknown-model", 1000, 500)).toBeCloseTo(expected, 10);
    });

    it("should return zero for a zero-priced model rather than the fallback", async () => {
      const { estimateCost, setPricingTable } = await loadPricing();
      setPricingTable({ "free-model": { input: 0, output: 0 } });
      expect(estimateCost("free-model", 1000, 500)).toBe(0);
    });

    it("should charge only for output when input is free", async () => {
      const { estimateCost, setPricingTable } = await loadPricing();
      setPricingTable({ "half-free": { input: 0, output: 10.0 } });
      expect(estimateCost("half-free", 1_000_000, 1_000_000)).toBeCloseTo(10.0, 10);
    });

    it("should return zero for zero tokens", async () => {
      const { estimateCost } = await loadPricing();
      expect(estimateCost("gpt-4o", 0, 0)).toBe(0);
    });
  });

  describe("local override file", () => {
    it("should merge a valid override file over the bundled defaults", async () => {
      writeLocalOverrides(
        JSON.stringify({
          "gpt-4o": { input: 1.0, output: 2.0 },
          "house-model": { input: 0.5, output: 0.5 },
        }),
      );
      const { getPricing } = await loadPricing();

      expect(getPricing("gpt-4o")?.input).toBe(1.0);
      expect(getPricing("house-model")?.output).toBe(0.5);
      // Unlisted bundled models survive the merge.
      expect(getPricing("claude-3-opus-20240229")?.input).toBe(15.0);
    });

    it("should fall back to bundled defaults when no override file exists", async () => {
      const { getPricing } = await loadPricing();
      expect(getPricing("gpt-4o")?.input).toBe(2.5);
    });

    it("should fall back to bundled defaults when the file is malformed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeLocalOverrides("{ not valid json");
      const { getPricing } = await loadPricing();

      expect(getPricing("gpt-4o")?.input).toBe(2.5);
      expect(warn).toHaveBeenCalledOnce();
    });

    it("should read the override file only once", async () => {
      writeLocalOverrides(JSON.stringify({ "gpt-4o": { input: 1.0, output: 2.0 } }));
      const { getPricing } = await loadPricing();
      expect(getPricing("gpt-4o")?.input).toBe(1.0);

      // A later rewrite is ignored — the table is cached after first use.
      writeLocalOverrides(JSON.stringify({ "gpt-4o": { input: 7.0, output: 8.0 } }));
      expect(getPricing("gpt-4o")?.input).toBe(1.0);
    });
  });

  describe("initPricing", () => {
    it("should apply a remote pricing table", async () => {
      process.env.IDENTARK_PRICING_URL = "https://pricing.example/table.json";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Promise.resolve(
            new Response(JSON.stringify({ "gpt-4o": { input: 4.0, output: 20.0 } }), {
              status: 200,
            }),
          ),
        ),
      );
      const { getPricing, initPricing } = await loadPricing();

      await initPricing();

      expect(getPricing("gpt-4o")?.input).toBe(4.0);
      // Bundled models not named remotely are still reachable.
      expect(getPricing("mistral-large-latest")?.input).toBe(2.0);
    });

    it("should keep bundled defaults when the fetch rejects", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.IDENTARK_PRICING_URL = "https://pricing.example/table.json";
      vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));
      const { getPricing, initPricing } = await loadPricing();

      await expect(initPricing()).resolves.toBeUndefined();

      expect(getPricing("gpt-4o")?.input).toBe(2.5);
      expect(warn).toHaveBeenCalledOnce();
    });

    it("should keep bundled defaults on a non-OK HTTP status", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.IDENTARK_PRICING_URL = "https://pricing.example/table.json";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.resolve(new Response("nope", { status: 500 }))),
      );
      const { getPricing, initPricing } = await loadPricing();

      await initPricing();

      expect(getPricing("gpt-4o")?.input).toBe(2.5);
      expect(warn).toHaveBeenCalledOnce();
    });

    it("should ignore the local override file when a pricing URL is set", async () => {
      writeLocalOverrides(JSON.stringify({ "gpt-4o": { input: 1.0, output: 2.0 } }));
      process.env.IDENTARK_PRICING_URL = "https://pricing.example/table.json";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Promise.resolve(
            new Response(JSON.stringify({ "gpt-4o": { input: 4.0, output: 20.0 } }), {
              status: 200,
            }),
          ),
        ),
      );
      const { getPricing, initPricing } = await loadPricing();

      await initPricing();

      expect(getPricing("gpt-4o")?.input).toBe(4.0);
    });

    it("should not apply the local override file when a pricing URL is set but never fetched", async () => {
      writeLocalOverrides(JSON.stringify({ "gpt-4o": { input: 1.0, output: 2.0 } }));
      process.env.IDENTARK_PRICING_URL = "https://pricing.example/table.json";
      const { getPricing } = await loadPricing();

      // No initPricing() call — the higher-priority URL wins, so the lower-priority
      // file stays unread and the table is left on bundled defaults.
      expect(getPricing("gpt-4o")?.input).toBe(2.5);
    });

    it("should fetch only once across repeated calls", async () => {
      process.env.IDENTARK_PRICING_URL = "https://pricing.example/table.json";
      const fetchMock = vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ "gpt-4o": { input: 4.0, output: 20.0 } }), {
            status: 200,
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { initPricing } = await loadPricing();

      await initPricing();
      await initPricing();

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("should not overwrite an explicit setPricingTable call", async () => {
      process.env.IDENTARK_PRICING_URL = "https://pricing.example/table.json";
      const fetchMock = vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ "gpt-4o": { input: 4.0, output: 20.0 } }), {
            status: 200,
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { getPricing, initPricing, setPricingTable } = await loadPricing();

      setPricingTable({ "gpt-4o": { input: 9.0, output: 9.0 } });
      await initPricing();

      expect(getPricing("gpt-4o")?.input).toBe(9.0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should apply the local override file when no pricing URL is set", async () => {
      writeLocalOverrides(JSON.stringify({ "gpt-4o": { input: 1.0, output: 2.0 } }));
      const { getPricing, initPricing } = await loadPricing();

      await initPricing();

      expect(getPricing("gpt-4o")?.input).toBe(1.0);
    });
  });

  describe("bundled tables", () => {
    it("should expose every provider table through BUNDLED_PRICING", async () => {
      const {
        BUNDLED_PRICING,
        OPENAI_PRICING,
        ANTHROPIC_PRICING,
        MISTRAL_PRICING,
        GEMINI_PRICING,
      } = await loadPricing();

      const expected =
        Object.keys(OPENAI_PRICING).length +
        Object.keys(ANTHROPIC_PRICING).length +
        Object.keys(MISTRAL_PRICING).length +
        Object.keys(GEMINI_PRICING).length;
      expect(Object.keys(BUNDLED_PRICING)).toHaveLength(expected);
    });

    it("should price every bundled model with positive, finite rates", async () => {
      const { BUNDLED_PRICING } = await loadPricing();
      for (const [model, pricing] of Object.entries(BUNDLED_PRICING)) {
        expect(pricing.input, model).toBeGreaterThan(0);
        expect(pricing.output, model).toBeGreaterThan(0);
        expect(Number.isFinite(pricing.input), model).toBe(true);
        expect(Number.isFinite(pricing.output), model).toBe(true);
      }
    });

    it("should not be mutated by setPricingTable", async () => {
      const { BUNDLED_PRICING, setPricingTable } = await loadPricing();
      setPricingTable({ "custom-model": { input: 1.0, output: 2.0 } });
      expect(BUNDLED_PRICING["custom-model"]).toBeUndefined();
    });
  });
});
