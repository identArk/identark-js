/**
 * identark/providers/orcarouter/pkce
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * OAuth 2.0 + PKCE ("Connect with OrcaRouter") adapter that yields the same
 * durable `sk-orca-…` API key the API-key adapter yields.
 *
 * Two flows are implemented:
 *
 *   - Flow A, loopback redirect: a local `http://127.0.0.1:<port>/cb` listener
 *     receives the code. Used by CLI tools and desktop processes that can bind
 *     loopback.
 *   - Flow B, out-of-band code: `callback_url=oob`, the consent screen shows a
 *     code the user pastes back. Used by clients that cannot listen (hosted
 *     apps, sandboxes, locked-down machines).
 *
 * Both always send `code_challenge_method=S256`: even a loopback client can be
 * handed a shown code by a human.
 *
 * The result is a persistent API key, not a refresh token. There is no refresh
 * grant: reuse the stored key until OrcaRouter revokes it, then re-run connect.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigurationError, ProviderError } from "../../errors.js";
import {
  buildAuthorizeBaseUrl,
  buildExchangeUrl,
  resolveOrcaRouterOrigins,
} from "./config.js";
import {
  assertLooksLikeOrcaRouterKey,
  type CredentialStoreOptions,
  type OrcaRouterCredential,
  type OrcaRouterCredentialSource,
  resolveStore,
} from "./credentials.js";

/** The only scope this provider needs. The response reports what was granted. */
export const ORCAROUTER_PKCE_SCOPE = "api";

const CODE_CHALLENGE_METHOD = "S256";
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 30 * 1000;

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** Fresh high-entropy verifier from the platform CSPRNG. */
export function generateCodeVerifier(): string {
  return b64url(crypto.randomBytes(32));
}

/** `base64url(sha256(verifier))` without padding, per RFC 7636 S256. */
export function computeCodeChallenge(verifier: string): string {
  if (!verifier) {
    throw new ConfigurationError("PKCE verifier must not be empty.");
  }
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

/** Fresh opaque `state` value (CSRF token). */
export function generateState(): string {
  return b64url(crypto.randomBytes(16));
}

/** Constant-time comparison of the echoed `state`. */
export function statesMatch(expected: string, actual: string | null | undefined): boolean {
  if (typeof actual !== "string" || actual.length === 0) {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A single authorization attempt. The verifier never leaves this object. */
export interface PkceAttempt {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

/** Build a fresh attempt. Call once per authorization, never reuse. */
export function createPkceAttempt(): PkceAttempt {
  const verifier = generateCodeVerifier();
  return { verifier, challenge: computeCodeChallenge(verifier), state: generateState() };
}

export type PkceFlow = "loopback" | "oob";

export interface AuthorizeUrlOptions {
  authBaseUrl: string;
  attempt: PkceAttempt;
  callbackUrl: string;
  appName?: string;
  scope?: string;
}

/** Build the consent-screen URL. Contains the challenge and state, never the verifier. */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = buildAuthorizeBaseUrl(options.authBaseUrl);
  url.searchParams.set("callback_url", options.callbackUrl);
  url.searchParams.set("code_challenge", options.attempt.challenge);
  url.searchParams.set("code_challenge_method", CODE_CHALLENGE_METHOD);
  url.searchParams.set("state", options.attempt.state);
  url.searchParams.set("app_name", options.appName ?? "IdentArk");
  url.searchParams.set("scope", options.scope ?? ORCAROUTER_PKCE_SCOPE);
  return url.toString();
}

/**
 * Callback URL accepted by the consent endpoint, validated before a request is
 * made: `https://` any host/port, or `http://` loopback only, no userinfo, no fragment.
 */
export function assertValidCallbackUrl(callbackUrl: string): string {
  if (callbackUrl === "oob") {
    return callbackUrl;
  }
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new ConfigurationError("PKCE callback URL must be an absolute URL or the literal \"oob\".");
  }
  if (url.username || url.password || url.hash) {
    throw new ConfigurationError("PKCE callback URL must not contain userinfo or a fragment.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigurationError(
      "PKCE callback URL must use HTTPS, or plain HTTP on localhost/127.0.0.1/[::1].",
    );
  }
  return callbackUrl;
}

const CLOSE_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>OrcaRouter</title>" +
  "<p>Connected to OrcaRouter. You can close this tab.</p>";

/**
 * Flow A: start a loopback listener on `127.0.0.1:<port>` before opening the
 * browser, so the port is known and nothing races. Resolves with the code
 * after the state has been compared in constant time.
 */
export function startLoopbackListener(
  attempt: PkceAttempt,
  options: { host?: string; port?: number; timeoutMs?: number } = {},
): Promise<{ callbackUrl: string; code: Promise<string>; close: () => void }> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return Promise.reject(new ConfigurationError("Loopback listener must bind a loopback host."));
  }
  const timeoutMs = options.timeoutMs ?? AUTHORIZE_TIMEOUT_MS;

  return new Promise((ready, failReady) => {
    let settle!: (value: string) => void;
    let fail!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // The server may settle before a caller awaits `code`; keep that rejection
    // observed so a denial/timeout never surfaces as an unhandled rejection.
    code.catch(() => undefined);

    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, value?: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (error) fail(error);
      else settle(value as string);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname !== "/cb") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      // Compare state before touching anything the request carried.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CLOSE_PAGE);
      server.close();

      if (!statesMatch(attempt.state, url.searchParams.get("state"))) {
        finish(new ProviderError("OrcaRouter authorization failed: state mismatch."));
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        finish(new ProviderError(`OrcaRouter authorization was not completed (${error}).`));
        return;
      }
      const received = url.searchParams.get("code");
      if (!received) {
        finish(new ProviderError("OrcaRouter authorization returned no code."));
        return;
      }
      finish(null, received);
    });

    server.on("error", (err) => {
      finish(err);
      failReady(err);
    });

    server.listen(options.port ?? 0, host, () => {
      const address = server.address() as AddressInfo;
      timer = setTimeout(() => {
        finish(new ProviderError("OrcaRouter authorization timed out. Start the login again."));
        server.close();
      }, timeoutMs);
      timer.unref?.();
      const port = address.port;
      const callbackHost = host === "::1" ? "[::1]" : host;
      ready({
        callbackUrl: `http://${callbackHost}:${port}/cb`,
        code,
        close: () => {
          finish(new ProviderError("OrcaRouter authorization was cancelled."));
          server.close();
        },
      });
    });
  });
}

export interface ExchangeOptions {
  authBaseUrl: string;
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  scope?: string;
}

export interface ExchangeResult {
  key: string;
  scope: string;
  userId?: string;
  /** True when the granted scope differs from the requested one. */
  scopeDowngraded: boolean;
}

/** POST the code + verifier to the auth origin's `/api/v1/auth/keys`. */
export async function exchangeCode(options: ExchangeOptions): Promise<ExchangeResult> {
  if (!options.code) {
    throw new ProviderError("OrcaRouter authorization returned no code.");
  }
  if (!options.verifier) {
    throw new ConfigurationError("PKCE verifier is missing.");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestedScope = options.scope ?? ORCAROUTER_PKCE_SCOPE;

  let response: Response;
  try {
    response = await fetchImpl(buildExchangeUrl(options.authBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code: options.code,
        code_verifier: options.verifier,
        code_challenge_method: CODE_CHALLENGE_METHOD,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    // Never include the request body (it holds the verifier) in the error.
    throw new ProviderError("Could not reach OrcaRouter to exchange the authorization code. Retry.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(
      "OrcaRouter rejected the authorization code (expired, already used, or verifier mismatch). Start the login again.",
    );
  }
  if (response.status === 429) {
    throw new ProviderError(
      "Too many OrcaRouter authorizations from this account. Reuse the stored key or retry later.",
    );
  }
  if (!response.ok) {
    throw new ProviderError(`OrcaRouter code exchange failed with HTTP ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProviderError("OrcaRouter code exchange returned an unreadable response.");
  }
  const record = body as { key?: unknown; scope?: unknown; user_id?: unknown };
  if (typeof record?.key !== "string" || !record.key) {
    throw new ProviderError("OrcaRouter code exchange returned no key.");
  }
  // Granted, not requested: a narrower grant is reported, never assumed away.
  const grantedScope = typeof record.scope === "string" ? record.scope : "";
  return {
    key: assertLooksLikeOrcaRouterKey(record.key),
    scope: grantedScope,
    ...(typeof record.user_id === "string" ? { userId: record.user_id } : {}),
    scopeDowngraded: grantedScope !== requestedScope,
  };
}

export interface PkceSourceOptions extends CredentialStoreOptions {
  flow?: PkceFlow;
  authBaseUrl?: string;
  appName?: string;
  /** Called with the authorization URL so the host can open/copy it. */
  onAuthorizeUrl?: (url: string) => void | Promise<void>;
  /** Flow B only: resolves with the code the user pasted. */
  promptForCode?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Current credential generation, used to stamp newly saved credentials. */
  generation?: () => number;
}

/**
 * PKCE adapter. `connect()` performs one authorization attempt and persists the
 * resulting durable key; `obtain()` reuses the stored key without re-authorizing
 * (10 PKCE keys per user per 24h).
 */
export class OrcaRouterPkceSource implements OrcaRouterCredentialSource {
  readonly kind = "oauth_pkce" as const;
  private readonly options: PkceSourceOptions;
  private readonly origins;

  constructor(options: PkceSourceOptions = {}) {
    this.options = options;
    this.origins = resolveOrcaRouterOrigins(
      options.authBaseUrl !== undefined ? { authBaseUrl: options.authBaseUrl } : {},
    );
  }

  private async persist(result: ExchangeResult, generation: number): Promise<OrcaRouterCredential> {
    const credential: OrcaRouterCredential = {
      apiKey: result.key,
      source: "oauth_pkce",
      scope: result.scope,
      generation,
      needsReauth: false,
      ...(result.userId !== undefined ? { userId: result.userId } : {}),
    };
    await resolveStore(this.options).save(credential);
    return credential;
  }

  /** One authorization attempt. A fresh verifier and state are generated each time. */
  async connect(generation = this.options.generation?.() ?? 1): Promise<OrcaRouterCredential> {
    const attempt = createPkceAttempt();
    const flow = this.options.flow ?? "loopback";

    if (flow === "oob") {
      const url = buildAuthorizeUrl({
        authBaseUrl: this.origins.authBaseUrl,
        attempt,
        callbackUrl: "oob",
        ...(this.options.appName !== undefined ? { appName: this.options.appName } : {}),
      });
      await this.options.onAuthorizeUrl?.(url);
      const code = (await this.options.promptForCode?.())?.trim();
      if (!code) {
        throw new ProviderError("No OrcaRouter authorization code was entered. Start the login again.");
      }
      const result = await exchangeCode({
        authBaseUrl: this.origins.authBaseUrl,
        code,
        verifier: attempt.verifier,
        ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      });
      return this.persist(result, generation);
    }

    const listener = await startLoopbackListener(attempt, {
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    try {
      const url = buildAuthorizeUrl({
        authBaseUrl: this.origins.authBaseUrl,
        attempt,
        callbackUrl: listener.callbackUrl,
        ...(this.options.appName !== undefined ? { appName: this.options.appName } : {}),
      });
      await this.options.onAuthorizeUrl?.(url);
      const code = await listener.code;
      const result = await exchangeCode({
        authBaseUrl: this.origins.authBaseUrl,
        code,
        verifier: attempt.verifier,
        ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      });
      return this.persist(result, generation);
    } finally {
      listener.close();
    }
  }

  async obtain(generation: number): Promise<OrcaRouterCredential> {
    const existing = await resolveStore(this.options).load();
    if (existing) {
      // Stamp the caller's generation: it is the counter a `401` is attributed to.
      return { ...existing, generation };
    }
    return this.connect(generation);
  }
}
