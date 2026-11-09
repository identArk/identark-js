import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  OrcaRouterPkceSource,
  assertValidCallbackUrl,
  buildAuthorizeUrl,
  computeCodeChallenge,
  createPkceAttempt,
  exchangeCode,
  startLoopbackListener,
  statesMatch,
} from "../src/providers/orcarouter/pkce.js";
import { createMemoryCredentialStore } from "../src/providers/orcarouter/credentials.js";
import { ConfigurationError, ProviderError } from "../src/errors.js";

const FAKE_KEY = "sk-orca-fakePkceKey0000000000";
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface RecordedRequest {
  path: string;
  host: string;
  contentType: string;
  body: Record<string, unknown>;
}

/** Local fake OrcaRouter auth server: `/auth` consent + `/api/v1/auth/keys` exchange. */
function startFakeAuthServer(behaviour: {
  grant?: (req: RecordedRequest) => { status: number; body: unknown };
} = {}) {
  const requests: RecordedRequest[] = [];
  let authorizeUrl: string | undefined;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/auth/keys") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const recorded = {
          path: req.url ?? "",
          host: String(req.headers.host ?? ""),
          contentType: String(req.headers["content-type"] ?? ""),
          body,
        };
        requests.push(recorded);
        const result = behaviour.grant
          ? behaviour.grant(recorded)
          : {
              status: 200,
              body: {
                // Only a matching verifier redeems the fake code.
                ...(recorded.body.code_verifier === pendingVerifier
                  ? { key: FAKE_KEY, user_id: "u-1", scope: "api" }
                  : { error: "invalid_grant" }),
              },
            };
        if (!behaviour.grant && !("key" in (result.body as object))) {
          res.writeHead(403, { "Content-Type": "application/json" });
        } else {
          res.writeHead(result.status, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify(result.body));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/auth?")) {
      authorizeUrl = `http://${req.headers.host}${req.url}`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<p>consent</p>");
      return;
    }
    res.writeHead(404).end();
  });
  let pendingVerifier = "";
  return {
    server,
    requests,
    setPendingVerifier: (v: string) => {
      pendingVerifier = v;
    },
    getAuthorizeUrl: () => authorizeUrl,
  };
}

describe("OrcaRouter PKCE helpers", () => {
  it("derives an unpadded base64url S256 challenge from the verifier (RFC 7636 vector)", () => {
    expect(computeCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("uses a fresh cryptographic verifier and state for every attempt", () => {
    const a = createPkceAttempt();
    const b = createPkceAttempt();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).toMatch(VERIFIER_PATTERN);
    expect(a.verifier).not.toContain("=");
    expect(a.challenge).toBe(computeCodeChallenge(a.verifier));
  });

  it("compares state in constant time and rejects empty or wrong values", () => {
    const attempt = createPkceAttempt();
    expect(statesMatch(attempt.state, attempt.state)).toBe(true);
    expect(statesMatch(attempt.state, null)).toBe(false);
    expect(statesMatch(attempt.state, "")).toBe(false);
    expect(statesMatch(attempt.state, `${attempt.state}x`)).toBe(false);
    expect(statesMatch(attempt.state, createPkceAttempt().state)).toBe(false);
  });

  it("builds the authorize URL with S256, state, and never the verifier", () => {
    const attempt = createPkceAttempt();
    const url = new URL(
      buildAuthorizeUrl({
        authBaseUrl: "https://www.orcarouter.ai",
        attempt,
        callbackUrl: "oob",
      }),
    );
    expect(url.origin).toBe("https://www.orcarouter.ai");
    expect(url.pathname).toBe("/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(attempt.challenge);
    expect(url.searchParams.get("state")).toBe(attempt.state);
    expect(url.searchParams.get("callback_url")).toBe("oob");
    expect(url.searchParams.get("scope")).toBe("api");
    expect(url.toString()).not.toContain(attempt.verifier);
  });

  it("validates callback URLs before a request is made", () => {
    expect(assertValidCallbackUrl("http://127.0.0.1:51733/cb")).toBe("http://127.0.0.1:51733/cb");
    expect(assertValidCallbackUrl("http://localhost:8080/cb")).toBe("http://localhost:8080/cb");
    expect(assertValidCallbackUrl("https://app.example.com:8443/cb")).toBe(
      "https://app.example.com:8443/cb",
    );
    expect(assertValidCallbackUrl("oob")).toBe("oob");
    expect(() => assertValidCallbackUrl("http://app.example.com/cb")).toThrow(ConfigurationError);
    expect(() => assertValidCallbackUrl("https://u:p@app.example.com/cb")).toThrow(
      ConfigurationError,
    );
    expect(() => assertValidCallbackUrl("https://app.example.com/cb#frag")).toThrow(
      ConfigurationError,
    );
  });
});

describe("OrcaRouter PKCE exchange", () => {
  it("posts code + verifier to the auth origin at /api/v1/auth/keys only", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      return new Response(JSON.stringify({ key: FAKE_KEY, user_id: "u-9", scope: "api" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await exchangeCode({
      authBaseUrl: "https://www.orcarouter.ai",
      code: "fake-code",
      verifier: "fake-verifier",
      fetchImpl,
    });
    expect(result.key).toBe(FAKE_KEY);
    expect(result.scope).toBe("api");
    expect(result.scopeDowngraded).toBe(false);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.origin).toBe("https://www.orcarouter.ai");
    expect(call.url.pathname).toBe("/api/v1/auth/keys");
    expect(call.url.hostname).not.toBe("api.orcarouter.ai");
    expect(JSON.parse(String(call.init.body))).toEqual({
      code: "fake-code",
      code_verifier: "fake-verifier",
      code_challenge_method: "S256",
    });
  });

  it("reports a scope downgrade without assuming the requested scope", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ key: FAKE_KEY, scope: "connector" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await exchangeCode({
      authBaseUrl: "https://www.orcarouter.ai",
      code: "c",
      verifier: "v",
      fetchImpl,
    });
    expect(result.scope).toBe("connector");
    expect(result.scopeDowngraded).toBe(true);
  });

  it.each([
    [403, /Start the login again/],
    [400, /HTTP 400/],
    [429, /Too many/],
  ])("maps HTTP %i to an actionable, secret-free error", async (status, pattern) => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status })) as unknown as typeof fetch;
    const promise = exchangeCode({
      authBaseUrl: "https://www.orcarouter.ai",
      code: "fake-code",
      verifier: "fake-secret-verifier",
      fetchImpl,
    });
    await expect(promise).rejects.toThrow(pattern);
    await promise.catch((err: Error) => {
      expect(err.message).not.toContain("fake-secret-verifier");
      expect(err.message).not.toContain("fake-code");
    });
  });

  it("turns network failures into a retryable error without the verifier", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const promise = exchangeCode({
      authBaseUrl: "https://www.orcarouter.ai",
      code: "fake-code",
      verifier: "fake-secret-verifier",
      fetchImpl,
    });
    await expect(promise).rejects.toThrow(ProviderError);
    await promise.catch((err: Error) => {
      expect(err.message).not.toContain("fake-secret-verifier");
      expect(err.message).not.toContain(FAKE_KEY);
    });
  });

  it("rejects an unreadable or key-less response", async () => {
    const noKey = (async () =>
      new Response(JSON.stringify({ scope: "api" }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      exchangeCode({ authBaseUrl: "https://www.orcarouter.ai", code: "c", verifier: "v", fetchImpl: noKey }),
    ).rejects.toThrow(/no key/);

    const garbage = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(
      exchangeCode({ authBaseUrl: "https://www.orcarouter.ai", code: "c", verifier: "v", fetchImpl: garbage }),
    ).rejects.toThrow(/unreadable/);
  });
});

describe("OrcaRouter PKCE loopback listener (Flow A)", () => {
  it("accepts the code only when state matches, then closes", async () => {
    const attempt = createPkceAttempt();
    const listener = await startLoopbackListener(attempt);
    const callback = new URL(listener.callbackUrl);
    expect(callback.hostname).toBe("127.0.0.1");
    expect(callback.pathname).toBe("/cb");

    callback.searchParams.set("code", "fake-code");
    callback.searchParams.set("state", attempt.state);
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(await listener.code).toBe("fake-code");
  });

  it("fails on state mismatch without returning the code", async () => {
    const attempt = createPkceAttempt();
    const listener = await startLoopbackListener(attempt);
    const callback = new URL(listener.callbackUrl);
    callback.searchParams.set("code", "attacker-code");
    callback.searchParams.set("state", "not-the-state");
    await fetch(callback);
    await expect(listener.code).rejects.toThrow(/state mismatch/);
  });

  it("reports denial and timeout safely", async () => {
    const attempt = createPkceAttempt();
    const listener = await startLoopbackListener(attempt);
    const callback = new URL(listener.callbackUrl);
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("state", attempt.state);
    await fetch(callback);
    await expect(listener.code).rejects.toThrow(/access_denied/);

    const timed = await startLoopbackListener(createPkceAttempt(), { timeoutMs: 20 });
    await expect(timed.code).rejects.toThrow(/timed out/);
  });

  it("can be cancelled and refuses to bind a non-loopback host", async () => {
    const listener = await startLoopbackListener(createPkceAttempt());
    listener.close();
    await expect(listener.code).rejects.toThrow(/cancelled/);
    await expect(startLoopbackListener(createPkceAttempt(), { host: "0.0.0.0" })).rejects.toThrow(
      ConfigurationError,
    );
  });
});

describe("OrcaRouter PKCE connect adapter (Flow A against a local fake auth server)", () => {
  let fake: ReturnType<typeof startFakeAuthServer>;
  let authBaseUrl: string;

  beforeAll(async () => {
    fake = startFakeAuthServer();
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    authBaseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it("authorize → callback → exchange → persist yields a usable credential", async () => {
    const store = createMemoryCredentialStore();
    const seenUrls: string[] = [];
    let verifierSeenAtAuthorize = true;
    const source = new OrcaRouterPkceSource({
      flow: "loopback",
      authBaseUrl,
      store,
      appName: "IdentArk Test",
      onAuthorizeUrl: async (url) => {
        seenUrls.push(url);
        const authorize = new URL(url);
        expect(authorize.origin).toBe(authBaseUrl);
        expect(authorize.pathname).toBe("/auth");
        expect(authorize.searchParams.get("app_name")).toBe("IdentArk Test");
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
        const challenge = authorize.searchParams.get("code_challenge") ?? "";
        verifierSeenAtAuthorize = url.includes(challenge) && /^[A-Za-z0-9_-]{43}$/.test(challenge);
        // The fake consent screen "approves": redirect the callback URL.
        const callback = new URL(authorize.searchParams.get("callback_url") ?? "");
        callback.searchParams.set("code", "fake-code");
        callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        await fetch(callback);
      },
      fetchImpl: undefined,
    });

    // The fake exchange server needs the verifier to match. Recover it by
    // intercepting the exchange request the source sends.
    const originalFetch = globalThis.fetch;
    const recorded: RecordedRequest[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/keys") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        recorded.push({
          path: url.pathname,
          host: url.host,
          contentType: String((init?.headers as Record<string, string>)?.["Content-Type"] ?? ""),
          body,
        });
        fake.setPendingVerifier(String(body.code_verifier ?? ""));
      }
      return originalFetch(input as never, init as never);
    }) as typeof fetch;
    try {
      const credential = await source.connect(7);
      expect(credential.apiKey).toBe(FAKE_KEY);
      expect(credential.source).toBe("oauth_pkce");
      expect(credential.scope).toBe("api");
      expect(credential.generation).toBe(7);
      expect(credential.needsReauth).toBe(false);

      expect(await store.load()).toEqual(credential);
      expect(seenUrls).toHaveLength(1);
      expect(verifierSeenAtAuthorize).toBe(true);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.path).toBe("/api/v1/auth/keys");
      expect(recorded[0]!.host).toBe(new URL(authBaseUrl).host);
      expect(recorded[0]!.body.code_challenge_method).toBe("S256");
      expect(JSON.stringify(seenUrls)).not.toContain(String(recorded[0]!.body.code_verifier));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reuses the stored key instead of re-authorizing", async () => {
    const store = createMemoryCredentialStore({
      apiKey: FAKE_KEY,
      source: "oauth_pkce",
      generation: 2,
      needsReauth: true,
    });
    let authorized = false;
    const source = new OrcaRouterPkceSource({
      flow: "loopback",
      authBaseUrl,
      store,
      onAuthorizeUrl: () => {
        authorized = true;
      },
    });
    const credential = await source.obtain(2);
    expect(credential.apiKey).toBe(FAKE_KEY);
    expect(authorized).toBe(false);
  });

  it("a denied authorization rejects and persists nothing", async () => {
    const store = createMemoryCredentialStore();
    const source = new OrcaRouterPkceSource({
      flow: "loopback",
      authBaseUrl,
      store,
      onAuthorizeUrl: async (url) => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("callback_url") ?? "");
        callback.searchParams.set("error", "access_denied");
        callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        await fetch(callback);
      },
    });
    await expect(source.connect(1)).rejects.toThrow(/access_denied/);
    expect(await store.load()).toBeUndefined();
  });

  it("a reused/expired code (403) rejects with a terminal message", async () => {
    const store = createMemoryCredentialStore();
    const source = new OrcaRouterPkceSource({
      flow: "loopback",
      authBaseUrl,
      store,
      fetchImpl: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch,
      onAuthorizeUrl: async (url) => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("callback_url") ?? "");
        callback.searchParams.set("code", "already-used");
        callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        await fetch(callback);
      },
    });
    await expect(source.connect(1)).rejects.toThrow(/already used/);
    expect(await store.load()).toBeUndefined();
  });

  it("Flow B (OOB) prompts for the displayed code and uses S256", async () => {
    const store = createMemoryCredentialStore();
    let authorizeUrl: string | undefined;
    const source = new OrcaRouterPkceSource({
      flow: "oob",
      authBaseUrl,
      store,
      onAuthorizeUrl: (url) => {
        authorizeUrl = url;
      },
      promptForCode: async () => "  fake-code  ",
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        expect(String(input)).toBe(
          `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/api/v1/auth/keys`,
        );
        expect(body.code_challenge_method).toBe("S256");
        expect(body.code).toBe("fake-code");
        // The fake server only grants when the verifier matches the challenge
        // sent on the authorize URL.
        const challenge = new URL(authorizeUrl ?? "").searchParams.get("code_challenge");
        fake.setPendingVerifier(String(body.code_verifier));
        const verifier = String(body.code_verifier);
        const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
        return new Response(JSON.stringify({ key: FAKE_KEY, scope: "api" }), {
          status: computed === challenge ? 200 : 403,
        });
      }) as unknown as typeof fetch,
    });
    const credential = await source.connect(4);
    expect(credential.apiKey).toBe(FAKE_KEY);
    const oob = new URL(authorizeUrl ?? "");
    expect(oob.searchParams.get("callback_url")).toBe("oob");
    expect(oob.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("Flow B without an entered code fails cleanly", async () => {
    const source = new OrcaRouterPkceSource({
      flow: "oob",
      authBaseUrl,
      store: createMemoryCredentialStore(),
      promptForCode: async () => "   ",
    });
    await expect(source.connect(1)).rejects.toThrow(/No OrcaRouter authorization code/);
  });
});
