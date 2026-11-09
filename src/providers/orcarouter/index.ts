/**
 * identark/providers/orcarouter
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * OrcaRouter Cyber Inference — first-class provider for the AgentGateway SDK.
 *
 * OrcaRouter is an OpenAI-compatible AI gateway that routes many providers
 * behind one endpoint. This provider targets **authorized security work**:
 *
 *   - default model `orcarouter/auto` (automatic routing, works with any key);
 *   - recommended dedicated cyber models for verified security teams —
 *     `orca/orcacyber-ultra-1.0`, `orca/orcacyber-zero-1.5` (see
 *     https://www.orcarouter.ai/models?tier=cyber);
 *   - general fallback `orcarouter/fusion`.
 *
 * Provider page: https://www.orcarouter.ai/cyber
 *
 * Two ways to authenticate, both yielding the same durable `sk-orca-…` key:
 *
 *   - `new OrcaRouterClient({ apiKey })` / `ORCAROUTER_API_KEY`;
 *   - `new OrcaRouterPkceSource().connect()` ("Connect with OrcaRouter").
 *
 * Inference and model discovery always go to `https://api.orcarouter.ai/v1`;
 * authorization always goes to `https://www.orcarouter.ai`. The provider needs
 * no runtime dependency: it uses the global `fetch`.
 */

import { ConfigurationError } from "../../errors.js";
import { DirectGateway } from "../../gateways/direct.js";
import {
  type OrcaRouterCatalog,
  OrcaRouterCatalogCache,
  type OrcaRouterModel,
} from "./catalog.js";
import { resolveOrcaRouterOrigins, ORCAROUTER_RECOMMENDED_CYBER_MODELS } from "./config.js";
import type { OrcaRouterCredential } from "./credentials.js";

/** Minimal OpenAI-compatible client surface the SDK's DirectGateway uses. */
export interface OrcaRouterChatClient {
  readonly baseURL: string;
  readonly apiKey: string;
  chat: {
    completions: {
      create: (body: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

/**
 * OpenAI-compatible client for OrcaRouter Cyber Inference.
 *
 * Deliberately tiny: `chat.completions.create` is all `DirectGateway` needs,
 * so the SDK keeps its zero-runtime-dependency guarantee.
 */
export class OrcaRouterClient implements OrcaRouterChatClient {
  readonly providerId = "orcarouter";
  readonly providerName = "OrcaRouter Cyber Inference";
  readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Exposed for SDKs that read `client.apiKey`; never log this value. */
  apiKey: string;
  chat: OrcaRouterChatClient["chat"];

  constructor(options: {
    apiKey: string;
    apiBaseUrl?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    const key = options.apiKey?.trim();
    if (!key) {
      throw new ConfigurationError("OrcaRouterClient requires an apiKey.");
    }
    this.apiKey = key;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.baseURL = resolveOrcaRouterOrigins({
      ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    }).apiBaseUrl;

    this.chat = {
      completions: {
        create: (body) => this.createChatCompletion(body),
      },
    };
  }

  /** Rotate the key, e.g. after a fresh PKCE login. */
  setApiKey(apiKey: string): void {
    if (!apiKey?.trim()) {
      throw new ConfigurationError("OrcaRouterClient requires a non-empty apiKey.");
    }
    this.apiKey = apiKey.trim();
  }

  private async createChatCompletion(body: Record<string, unknown>): Promise<unknown> {
    if (!body.model) {
      throw new ConfigurationError("OrcaRouter requests require a model. Discover one from GET /v1/models.");
    }
    const response = await this.send(body);

    if (body.stream === true) {
      return this.readStream(response);
    }
    return response.json();
  }

  private async send(body: Record<string, unknown>): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw await toClientError(response);
    }
    return response;
  }

  /**
   * Re-shape OrcaRouter's server-sent events into the OpenAI chunk objects the
   * SDK's stream reader expects. Malformed events are skipped rather than
   * aborting a partially delivered answer.
   */
  private async *readStream(response: Response): AsyncGenerator<Record<string, unknown>> {
    if (!response.body) {
      throw new ConfigurationError("OrcaRouter returned an empty streaming response.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.search(/\r?\n/);
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + (buffer[newline] === "\r" ? 2 : 1));
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              return;
            }
            try {
              yield JSON.parse(payload) as Record<string, unknown>;
            } catch {
              // Ignore a keep-alive or a partially framed event.
            }
          }
          newline = buffer.search(/\r?\n/);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Build an error that classifies through `DirectGateway` (429 → RateLimitError,
 * 401 → auth failure) and never carries the request body or key.
 */
async function toClientError(response: Response): Promise<Error> {
  let detail = "";
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === "string") {
      detail = message.slice(0, 300);
    }
  } catch {
    // Keep the generic message; a body that does not parse is not useful.
  }
  const error = new Error(
    `OrcaRouter request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
  ) as Error & { status: number; headers: Headers };
  error.status = response.status;
  error.headers = response.headers;
  return error;
}

/** Options for {@link DirectGateway.fromOrcaRouter}. */
export interface OrcaRouterGatewayOptions {
  /** The key to use. Pass `credential.apiKey` from either auth adapter. */
  apiKey: string;
  /** Model ID, verbatim. Defaults to `orcarouter/auto`. */
  model?: string;
  apiBaseUrl?: string;
  baseUrl?: string;
  systemPrompt?: string;
  costCapUsd?: number;
  workspaceDir?: string;
  fetchImpl?: typeof fetch;
  /** Optional catalog used to fail closed on an incompatible or unavailable model. */
  catalog?: OrcaRouterCatalog;
}

export interface OrcaRouterGateway {
  gateway: DirectGateway;
  client: OrcaRouterClient;
}

/**
 * Build a `DirectGateway` routed through OrcaRouter Cyber Inference.
 *
 * Provider selection and base URL are set explicitly, so nothing depends on
 * client-class sniffing and no request can fall back to another provider.
 */
export function createOrcaRouterGateway(options: OrcaRouterGatewayOptions): OrcaRouterGateway {
  const model = options.model ?? "orcarouter/auto";
  if (model.trim() !== model || model.includes(" ")) {
    throw new ConfigurationError("OrcaRouter model IDs are vendor-qualified, e.g. \"orcarouter/auto\".");
  }
  if (options.catalog) {
    const available = options.catalog.models.find((m) => m.id === model);
    if (!available) {
      throw new ConfigurationError(
        `Model "${model}" is not in the current OrcaRouter catalog. ` +
          "Choose another model from discoverOrcaRouterModels().",
      );
    }
  }
  const client = new OrcaRouterClient({
    apiKey: options.apiKey,
    ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  const gateway = new DirectGateway(
    client,
    model,
    options.systemPrompt,
    options.costCapUsd,
    options.workspaceDir,
    "orcarouter",
  );
  return { gateway, client };
}

export interface OrcaRouterProbeResult {
  ok: boolean;
  status: number;
  /** First 200 characters of the reply; never includes the key. */
  excerpt?: string;
  error?: string;
}

/**
 * Prove the wiring end to end: catalog discovery plus one real chat call, both
 * through the provider code path. Used by the SDK's live smoke script.
 */
export async function probeOrcaRouter(options: {
  apiKey: string;
  model?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ catalog: OrcaRouterCatalog; request: OrcaRouterProbeResult }> {
  const origins = resolveOrcaRouterOrigins({
    ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
  });
  const cache = new OrcaRouterCatalogCache({
    apiBaseUrl: origins.apiBaseUrl,
    apiKey: options.apiKey,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  const catalog = await cache.get();
  const model = options.model ?? "orcarouter/auto";

  let status = 0;
  let excerpt: string | undefined;
  let error: string | undefined;
  try {
    const { gateway } = createOrcaRouterGateway({
      apiKey: options.apiKey,
      model,
      ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    const response = await gateway.invokeLlm([
      { role: "user" as never, content: "Reply with the single word: ok" },
    ]);
    status = 200;
    excerpt = String(response.message.content ?? "").slice(0, 200);
  } catch (exc) {
    status = errorHttpStatus(exc);
    error = typeof (exc as { message?: unknown })?.message === "string"
      ? String((exc as { message: string }).message).slice(0, 300)
      : String(exc).slice(0, 300);
  }
  return {
    catalog,
    request: {
      ok: status === 200,
      status,
      ...(excerpt !== undefined ? { excerpt } : {}),
      ...(error !== undefined ? { error } : {}),
    },
  };
}

/**
 * Mark only the exact credential generation that made a rejected request as
 * needing reauthentication. A late `401` from an older generation never
 * touches a newer, freshly authorized credential.
 */
export function markNeedsReauth(
  current: OrcaRouterCredential,
  rejectedGeneration: number,
): OrcaRouterCredential {
  if (current.generation !== rejectedGeneration) {
    return current;
  }
  return { ...current, needsReauth: true };
}

/**
 * Best-effort HTTP status for an error raised anywhere along the provider path:
 * the raw client error carries `status`, while the gateway's normalised
 * `ProviderError` keeps the status inside its message.
 */
export function errorHttpStatus(error: unknown): number {
  const e = error as { status?: unknown; status_code?: unknown; message?: unknown };
  const raw = e?.status ?? e?.status_code;
  if (typeof raw === "number") {
    return raw;
  }
  const message = typeof e?.message === "string" ? e.message : "";
  const match = /\bHTTP (\d{3})\b/.exec(message);
  return match ? Number(match[1]) : 0;
}

/**
 * True when an error is an authentication failure that must not be retried.
 *
 * Accepts both the raw client error (which carries `status`) and the normalised
 * `ProviderError` the SDK's gateway raises after classification, whose message
 * retains the upstream status.
 */
export function isTerminalAuthFailure(error: unknown): boolean {
  const e = error as { message?: unknown; constructor?: { name?: string } };
  if (e?.constructor?.name === "AuthenticationError") {
    return true;
  }
  if (errorHttpStatus(error) === 401) {
    return true;
  }
  const message = typeof e?.message === "string" ? e.message : "";
  return message.startsWith("Authentication failed");
}

/** Models recommended for verified security teams (not defaults). */
export function recommendedCyberModels(catalog?: OrcaRouterCatalog): OrcaRouterModel[] {
  const source = catalog?.models ?? [];
  return source.filter((m) => ORCAROUTER_RECOMMENDED_CYBER_MODELS.includes(m.id as never));
}

export {
  ORCAROUTER_AUTHORIZE_PATH,
  ORCAROUTER_CYBER_MODELS_URL,
  ORCAROUTER_DEFAULT_API_BASE,
  ORCAROUTER_DEFAULT_AUTH_BASE,
  ORCAROUTER_DEFAULT_MODEL,
  ORCAROUTER_EXCHANGE_PATH,
  ORCAROUTER_FALLBACK_MODEL,
  ORCAROUTER_KEY_CONSOLE_URL,
  ORCAROUTER_PROVIDER_ID,
  ORCAROUTER_PROVIDER_NAME,
  ORCAROUTER_PROVIDER_PAGE_URL,
  ORCAROUTER_RECOMMENDED_CYBER_MODELS,
  buildAuthorizeBaseUrl,
  buildExchangeUrl,
  buildModelsUrl,
  resolveOrcaRouterOrigins,
  type OrcaRouterOriginConfig,
} from "./config.js";
export {
  assertLooksLikeOrcaRouterKey,
  createMemoryCredentialStore,
  maskOrcaRouterKey,
  OrcaRouterApiKeySource,
  staticCredentialSource,
  type CredentialStoreOptions,
  type OrcaRouterCredential,
  type OrcaRouterCredentialKind,
  type OrcaRouterCredentialSource,
  type OrcaRouterCredentialStore,
} from "./credentials.js";
export {
  OrcaRouterCatalogCache,
  ORCAROUTER_VERIFIED_SEED,
  discoverOrcaRouterModels,
  filterModelsByModality,
  isTextChatModel,
  parseCatalogModel,
  parseCatalogResponse,
  revalidateSelectedModel,
  type DiscoverCatalogOptions,
  type OrcaRouterCatalog,
  type OrcaRouterCatalogStatus,
  type OrcaRouterModel,
} from "./catalog.js";
export {
  ORCAROUTER_PKCE_SCOPE,
  OrcaRouterPkceSource,
  assertValidCallbackUrl,
  buildAuthorizeUrl,
  computeCodeChallenge,
  createPkceAttempt,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  startLoopbackListener,
  statesMatch,
  type AuthorizeUrlOptions,
  type ExchangeOptions,
  type ExchangeResult,
  type PkceAttempt,
  type PkceFlow,
  type PkceSourceOptions,
} from "./pkce.js";
