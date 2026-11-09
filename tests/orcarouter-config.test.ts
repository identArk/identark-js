import { describe, it, expect } from "vitest";
import {
  ORCAROUTER_DEFAULT_API_BASE,
  ORCAROUTER_DEFAULT_MODEL,
  ORCAROUTER_EXCHANGE_PATH,
  ORCAROUTER_PROVIDER_NAME,
  buildAuthorizeBaseUrl,
  buildExchangeUrl,
  buildModelsUrl,
  resolveOrcaRouterOrigins,
} from "../src/providers/orcarouter/config.js";
import { ConfigurationError } from "../src/errors.js";

describe("OrcaRouter configuration", () => {
  it("keeps the branded provider name and defaults", () => {
    expect(ORCAROUTER_PROVIDER_NAME).toBe("OrcaRouter Cyber Inference");
    expect(ORCAROUTER_PROVIDER_NAME).toContain("OrcaRouter");
    expect(ORCAROUTER_DEFAULT_MODEL).toBe("orcarouter/auto");
    expect(ORCAROUTER_DEFAULT_API_BASE).toBe("https://api.orcarouter.ai/v1");
    expect(ORCAROUTER_EXCHANGE_PATH).toBe("/api/v1/auth/keys");
  });

  it("uses separate auth and inference origins by default", () => {
    const { authBaseUrl, apiBaseUrl } = resolveOrcaRouterOrigins({}, {});
    expect(authBaseUrl).toBe("https://www.orcarouter.ai");
    expect(apiBaseUrl).toBe("https://api.orcarouter.ai/v1");
    expect(buildAuthorizeBaseUrl(authBaseUrl).toString()).toBe("https://www.orcarouter.ai/auth");
    expect(buildExchangeUrl(authBaseUrl).toString()).toBe(
      "https://www.orcarouter.ai/api/v1/auth/keys",
    );
    expect(buildExchangeUrl(authBaseUrl).toString()).not.toContain("api.orcarouter.ai/v1/auth");
    expect(buildModelsUrl(apiBaseUrl, "chat").toString()).toBe(
      "https://api.orcarouter.ai/v1/models?capability=chat",
    );
  });

  it("never derives one origin from the other", () => {
    const { authBaseUrl, apiBaseUrl } = resolveOrcaRouterOrigins(
      { authBaseUrl: "https://auth.example.com" },
      {},
    );
    expect(authBaseUrl).toBe("https://auth.example.com");
    expect(apiBaseUrl).toBe("https://api.orcarouter.ai/v1");
    expect(buildExchangeUrl(authBaseUrl).toString()).toBe("https://auth.example.com/api/v1/auth/keys");
  });

  it("supports a shared self-hosted base and explicit overrides", () => {
    const shared = resolveOrcaRouterOrigins({ baseUrl: "https://orca.internal.example" }, {});
    expect(shared.authBaseUrl).toBe("https://orca.internal.example");
    expect(shared.apiBaseUrl).toBe("https://orca.internal.example/v1");

    const explicit = resolveOrcaRouterOrigins(
      { baseUrl: "https://orca.internal.example", apiBaseUrl: "https://relay.example/custom/v1" },
      {},
    );
    expect(explicit.authBaseUrl).toBe("https://orca.internal.example");
    expect(explicit.apiBaseUrl).toBe("https://relay.example/custom/v1");
  });

  it("reads ORCA_BASE_URL, ORCA_AUTH_BASE_URL and ORCA_API_BASE_URL from the environment", () => {
    const env = {
      ORCA_BASE_URL: "https://shared.example",
      ORCA_AUTH_BASE_URL: "https://sso.example",
      ORCA_API_BASE_URL: "https://relay.example/v1",
    };
    const { authBaseUrl, apiBaseUrl } = resolveOrcaRouterOrigins({}, env);
    expect(authBaseUrl).toBe("https://sso.example");
    expect(apiBaseUrl).toBe("https://relay.example/v1");
  });

  it("permits plain HTTP only on loopback", () => {
    const local = resolveOrcaRouterOrigins(
      { authBaseUrl: "http://127.0.0.1:8080", apiBaseUrl: "http://localhost:9000/v1" },
      {},
    );
    expect(local.authBaseUrl).toBe("http://127.0.0.1:8080");
    expect(() =>
      resolveOrcaRouterOrigins({ authBaseUrl: "http://www.orcarouter.ai" }, {}),
    ).toThrow(ConfigurationError);
    expect(() =>
      resolveOrcaRouterOrigins({ authBaseUrl: "http://orca.internal.example" }, {}),
    ).toThrow(ConfigurationError);
  });

  it("rejects userinfo, query strings and fragments in origins", () => {
    expect(() =>
      resolveOrcaRouterOrigins({ authBaseUrl: "https://user:pw@www.orcarouter.ai" }, {}),
    ).toThrow(ConfigurationError);
    expect(() =>
      resolveOrcaRouterOrigins({ apiBaseUrl: "https://api.orcarouter.ai/v1?x=1" }, {}),
    ).toThrow(ConfigurationError);
    expect(() => resolveOrcaRouterOrigins({ apiBaseUrl: "not a url" }, {})).toThrow(
      ConfigurationError,
    );
  });
});
