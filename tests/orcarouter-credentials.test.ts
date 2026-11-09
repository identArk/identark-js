import { describe, it, expect, afterEach } from "vitest";
import {
  OrcaRouterApiKeySource,
  assertLooksLikeOrcaRouterKey,
  createMemoryCredentialStore,
  maskOrcaRouterKey,
  staticCredentialSource,
  type OrcaRouterCredential,
} from "../src/providers/orcarouter/credentials.js";
import { OrcaRouterPkceSource } from "../src/providers/orcarouter/pkce.js";
import { ConfigurationError } from "../src/errors.js";

// Fake credentials only — no real keys in this repository.
const FAKE_KEY = "sk-orca-test0000000000000000";
const OTHER_FAKE_KEY = "sk-orca-test1111111111111111";

describe("OrcaRouter credential adapters", () => {
  const envKey = process.env.ORCAROUTER_API_KEY;
  afterEach(() => {
    if (envKey === undefined) {
      delete process.env.ORCAROUTER_API_KEY;
    } else {
      process.env.ORCAROUTER_API_KEY = envKey;
    }
  });

  describe("API-key adapter", () => {
    it("saves, reads, masks and clears a key", async () => {
      const store = createMemoryCredentialStore();
      const source = new OrcaRouterApiKeySource({ store });

      expect(await source.masked()).toBe("");
      const saved = await source.setApiKey(`  ${FAKE_KEY}  `);
      expect(saved.apiKey).toBe(FAKE_KEY);
      expect(saved.source).toBe("api_key");
      expect(saved.needsReauth).toBe(false);

      const loaded = await source.obtain(1);
      expect(loaded.apiKey).toBe(FAKE_KEY);

      const masked = await source.masked();
      expect(masked).toContain("…");
      expect(masked).not.toContain(FAKE_KEY.slice(8));

      expect(await source.clear()).toBe(true);
      expect(await store.load()).toBeUndefined();
      expect(await source.clear()).toBe(false);
    });

    it("accepts updates without leaking the previous key", async () => {
      const source = new OrcaRouterApiKeySource({ store: createMemoryCredentialStore() });
      await source.setApiKey(FAKE_KEY);
      const updated = await source.setApiKey(OTHER_FAKE_KEY);
      expect(updated.apiKey).toBe(OTHER_FAKE_KEY);
      expect(JSON.stringify(updated)).not.toContain(FAKE_KEY + "0000");
    });

    it("rejects malformed keys with an actionable error that does not echo the key", () => {
      let error: unknown;
      try {
        assertLooksLikeOrcaRouterKey("wrong-prefix-key-value");
      } catch (exc) {
        error = exc;
      }
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String((error as Error).message)).not.toContain("wrong-prefix-key-value");
      expect(String((error as Error).message)).toContain("sk-orca-");
      expect(() => assertLooksLikeOrcaRouterKey("sk-orca-")).toThrow(ConfigurationError);
      expect(() => assertLooksLikeOrcaRouterKey("   ")).toThrow(ConfigurationError);
    });

    it("falls back to ORCAROUTER_API_KEY when no key is stored", async () => {
      process.env.ORCAROUTER_API_KEY = FAKE_KEY;
      const source = new OrcaRouterApiKeySource({ store: createMemoryCredentialStore() });
      const credential = await source.obtain(1);
      expect(credential.apiKey).toBe(FAKE_KEY);
    });

    it("explains how to configure a key when none is available", async () => {
      delete process.env.ORCAROUTER_API_KEY;
      const source = new OrcaRouterApiKeySource({ store: createMemoryCredentialStore() });
      await expect(source.obtain(1)).rejects.toThrow(/ORCAROUTER_API_KEY/);
    });
  });

  describe("shared credential seam", () => {
    const fakeExchange = (async () =>
      new Response(JSON.stringify({ key: FAKE_KEY, user_id: "42", scope: "api" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    it("both adapters yield the same credential shape", async () => {
      const apiKeySource = new OrcaRouterApiKeySource({ store: createMemoryCredentialStore() });
      await apiKeySource.setApiKey(FAKE_KEY);
      const fromApiKey = await apiKeySource.obtain(3);

      const pkceSource = new OrcaRouterPkceSource({
        flow: "oob",
        store: createMemoryCredentialStore(),
        promptForCode: async () => "fake-code",
        fetchImpl: fakeExchange,
      });
      const fromPkce = await pkceSource.connect(3);

      for (const credential of [fromApiKey, fromPkce]) {
        expect(typeof credential.apiKey).toBe("string");
        expect(credential.generation).toBe(3);
        expect(credential.needsReauth).toBe(false);
        expect(credential.source === "api_key" || credential.source === "oauth_pkce").toBe(true);
      }
      expect(fromApiKey.source).toBe("api_key");
      expect(fromPkce.source).toBe("oauth_pkce");
      expect(fromPkce.scope).toBe("api");
      expect(fromPkce.userId).toBe("42");
    });

    it("a static source is interchangeable with the adapters", async () => {
      const credential: OrcaRouterCredential = {
        apiKey: FAKE_KEY,
        source: "oauth_pkce",
        generation: 1,
        needsReauth: false,
      };
      const resolved = await staticCredentialSource(credential).obtain(2);
      expect(resolved.apiKey).toBe(FAKE_KEY);
      expect(resolved.generation).toBe(2);
    });

    it("masking never reveals the secret", () => {
      expect(maskOrcaRouterKey(FAKE_KEY)).toBe("sk-orca-…");
      expect(maskOrcaRouterKey("")).toBe("");
    });
  });
});
