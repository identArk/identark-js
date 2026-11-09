/**
 * identark/providers/orcarouter/config
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * Origin, endpoint, and model-catalog configuration for the OrcaRouter Cyber
 * Inference provider.
 *
 * Authentication and inference use **different** public origins:
 *
 *   - auth / code exchange: `https://www.orcarouter.ai` (`/auth`,
 *     `/api/v1/auth/keys`)
 *   - inference and model discovery: `https://api.orcarouter.ai/v1`
 *
 * Neither origin is derived from the other by rewriting a hostname or
 * appending `/v1`. A shared `ORCA_BASE_URL` is supported for single-origin
 * self-hosted deployments, with explicit `ORCA_AUTH_BASE_URL` and
 * `ORCA_API_BASE_URL` overrides taking precedence. Remote origins must be
 * HTTPS; plain HTTP is accepted only for loopback development.
 */

import { ConfigurationError } from "../../errors.js";

/** Display and model identifiers for the provider. Brand name is always kept. */
export const ORCAROUTER_PROVIDER_ID = "orcarouter";
export const ORCAROUTER_PROVIDER_NAME = "OrcaRouter Cyber Inference";
export const ORCAROUTER_DEFAULT_AUTH_BASE = "https://www.orcarouter.ai";
export const ORCAROUTER_DEFAULT_API_BASE = "https://api.orcarouter.ai/v1";
export const ORCAROUTER_AUTHORIZE_PATH = "/auth";
export const ORCAROUTER_EXCHANGE_PATH = "/api/v1/auth/keys";
export const ORCAROUTER_KEY_CONSOLE_URL = "https://www.orcarouter.ai/console/authorized-apps";
export const ORCAROUTER_PROVIDER_PAGE_URL = "https://www.orcarouter.ai/cyber";
export const ORCAROUTER_CYBER_MODELS_URL = "https://www.orcarouter.ai/models?tier=cyber";

/**
 * Default model: automatic routing, usable with any key.
 */
export const ORCAROUTER_DEFAULT_MODEL = "orcarouter/auto";
/** General fallback model. */
export const ORCAROUTER_FALLBACK_MODEL = "orcarouter/fusion";
/** Dedicated cyber models for verified security teams (recommended, not defaults). */
export const ORCAROUTER_RECOMMENDED_CYBER_MODELS = [
  "orca/orcacyber-ultra-1.0",
  "orca/orcacyber-zero-1.5",
] as const;

export interface OrcaRouterOriginConfig {
  authBaseUrl: string;
  apiBaseUrl: string;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function parseOrigin(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(`${label} must be an absolute URL (got an unparsable value).`);
  }
  if (url.username || url.password) {
    throw new ConfigurationError(`${label} must not contain userinfo.`);
  }
  if (url.hash || url.search) {
    throw new ConfigurationError(`${label} must not contain a query string or fragment.`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return url;
  }
  throw new ConfigurationError(`${label} must use HTTPS (plain HTTP is allowed only for loopback).`);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Resolve the auth and inference origins.
 *
 * Precedence, per origin: explicit option / `ORCA_AUTH_BASE_URL` or
 * `ORCA_API_BASE_URL` → shared `ORCA_BASE_URL` → public default.
 */
export function resolveOrcaRouterOrigins(
  options: Partial<OrcaRouterOriginConfig> & { baseUrl?: string } = {},
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): OrcaRouterOriginConfig {
  const shared = options.baseUrl ?? env.ORCA_BASE_URL;
  const authRaw = options.authBaseUrl ?? env.ORCA_AUTH_BASE_URL ?? shared ?? ORCAROUTER_DEFAULT_AUTH_BASE;
  const apiRaw = options.apiBaseUrl ?? env.ORCA_API_BASE_URL ?? shared ?? ORCAROUTER_DEFAULT_API_BASE;

  let authBaseUrl = stripTrailingSlash(parseOrigin(authRaw, "OrcaRouter auth base URL").toString());
  let apiBaseUrl = stripTrailingSlash(parseOrigin(apiRaw, "OrcaRouter API base URL").toString());

  // The default API base carries the relay's `/v1`. When a shared or explicit
  // value omits it, append `/v1` only to the inference origin — never to auth.
  const apiPath = apiBaseUrl.replace(/^[a-z]+:\/\/[^/]+/i, "");
  if (apiPath === "" || apiPath === "/") {
    apiBaseUrl = `${apiBaseUrl}/v1`;
  }
  authBaseUrl = authBaseUrl.replace(/\/+$/i, "");
  return { authBaseUrl, apiBaseUrl };
}

/** The consent-screen URL. `authorize` is always `/auth`. */
export function buildAuthorizeBaseUrl(authBaseUrl: string): URL {
  return new URL(`${stripTrailingSlash(authBaseUrl)}${ORCAROUTER_AUTHORIZE_PATH}`);
}

/**
 * The code-exchange URL. Always on the auth origin at `/api/v1/auth/keys` —
 * never `https://api.orcarouter.ai/v1/auth/keys`, which is a 404.
 */
export function buildExchangeUrl(authBaseUrl: string): URL {
  return new URL(`${stripTrailingSlash(authBaseUrl)}${ORCAROUTER_EXCHANGE_PATH}`);
}

/** The model-catalog URL on the inference origin. */
export function buildModelsUrl(
  apiBaseUrl: string,
  capability?: "chat" | "embedding" | "image",
): URL {
  const url = new URL(`${stripTrailingSlash(apiBaseUrl)}/models`);
  if (capability) {
    url.searchParams.set("capability", capability);
  }
  return url;
}
