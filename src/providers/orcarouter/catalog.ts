/**
 * identark/providers/orcarouter/catalog
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * Live model discovery for OrcaRouter Cyber Inference plus a small verified
 * cold-start seed.
 *
 * The single source of truth is `GET {apiBase}/models?capability=chat` on the
 * inference origin. When discovery succeeds its result is authoritative and the
 * seed is not merged in. When it fails, the caller gets the seed, flagged as
 * degraded, so a fresh install is never model-less.
 */

import { buildModelsUrl } from "./config.js";

/** Model metadata preserved for selectors and routing. */
export interface OrcaRouterModel {
  /** Vendor-qualified model ID, kept verbatim (e.g. `orcarouter/auto`). */
  id: string;
  name: string;
  contextLength?: number;
  inputModalities: Array<"text" | "image" | "audio" | "video" | "file">;
  supportedEndpointTypes: string[];
  reasoning: boolean;
  reasoningEfforts: string[];
}

export type OrcaRouterCatalogStatus = "live" | "degraded";

export interface OrcaRouterCatalog {
  models: OrcaRouterModel[];
  status: OrcaRouterCatalogStatus;
  /** Reason discovery fell back to the seed, when degraded. */
  reason?: string;
  /** Time the catalog was produced (ISO 8601). */
  fetchedAt: string;
}

/** Non-text endpoint types that must never appear in a text chat selector. */
const NON_CHAT_ENDPOINT_TYPES = ["image-generation", "openai-video", "jina-rerank", "embeddings"];

export const CATALOG_LIMITS = {
  timeoutMs: 10_000,
  maxBytes: 2 * 1024 * 1024,
  maxModels: 500,
} as const;

/**
 * Verified cold-start seed. Every entry was observed in the live
 * `GET https://api.orcarouter.ai/v1/models?capability=chat` catalog, including
 * its vendor-qualified ID and metadata. Live discovery replaces the seed
 * entirely on success.
 */
export const ORCAROUTER_VERIFIED_SEED: readonly OrcaRouterModel[] = Object.freeze([
  {
    id: "orcarouter/auto",
    name: "OrcaRouter Auto",
    inputModalities: ["text"],
    supportedEndpointTypes: ["openai", "openai-response", "anthropic", "gemini"],
    reasoning: false,
    reasoningEfforts: [],
  },
  {
    id: "orcarouter/fusion",
    name: "OrcaRouter Fusion",
    contextLength: 1000000,
    inputModalities: ["text"],
    supportedEndpointTypes: ["openai", "openai-response", "anthropic", "gemini"],
    reasoning: false,
    reasoningEfforts: [],
  },
  {
    id: "orca/orcacyber-ultra-1.0",
    name: "Orca: OrcaCyber Ultra 1.0",
    contextLength: 1048576,
    inputModalities: ["text"],
    supportedEndpointTypes: ["openai"],
    reasoning: true,
    reasoningEfforts: [],
  },
  {
    id: "orca/orcacyber-zero-1.5",
    name: "Orca: OrcaCyber Zero 1.5",
    contextLength: 1000000,
    inputModalities: ["text"],
    supportedEndpointTypes: ["openai"],
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "orca/orcacyber-zero-1.0",
    name: "Orca: OrcaCyber Zero 1.0",
    contextLength: 1000000,
    inputModalities: ["text"],
    supportedEndpointTypes: ["openai"],
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek: DeepSeek V4 Pro",
    contextLength: 1048576,
    inputModalities: ["text"],
    supportedEndpointTypes: ["openai", "openai-response"],
    reasoning: true,
    reasoningEfforts: [],
  },
]);

const TEXT_ENDPOINT_TYPES = ["openai", "anthropic", "gemini", "openai-response"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Parse one catalog record. Returns undefined for records a chat client cannot speak. */
export function parseCatalogModel(raw: unknown): OrcaRouterModel | undefined {
  const record = asRecord(raw);
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) {
    return undefined;
  }
  const endpoints = stringArray(record.supported_endpoint_types);
  const architecture = asRecord(record.architecture);
  const modalities = stringArray(architecture.input_modalities).filter(
    (m): m is OrcaRouterModel["inputModalities"][number] =>
      m === "text" || m === "image" || m === "audio" || m === "video" || m === "file",
  );
  const parameters = stringArray(record.supported_parameters);
  const reasoning = parameters.includes("reasoning") || record.reasoning === true;

  return {
    id,
    name: typeof record.name === "string" && record.name ? record.name : id,
    ...(typeof record.context_length === "number" ? { contextLength: record.context_length } : {}),
    inputModalities: modalities.includes("text") ? modalities : ["text", ...modalities],
    supportedEndpointTypes: endpoints,
    reasoning,
    reasoningEfforts: [],
  };
}

/**
 * Text chat filter: chat capability, at least one text endpoint type, and no
 * non-text-only endpoint (image generation, video, rerank, embeddings).
 */
export function isTextChatModel(model: OrcaRouterModel): boolean {
  const hasTextEndpoint = model.supportedEndpointTypes.some((t) => TEXT_ENDPOINT_TYPES.includes(t));
  if (!hasTextEndpoint) {
    return false;
  }
  const onlyNonChat =
    model.supportedEndpointTypes.length > 0 &&
    model.supportedEndpointTypes.every(
      (t) => NON_CHAT_ENDPOINT_TYPES.includes(t) || !TEXT_ENDPOINT_TYPES.includes(t),
    );
  return !onlyNonChat && model.inputModalities.includes("text");
}

/** Multimodal filter: chat, plus an explicit declaration of the required modality. */
export function filterModelsByModality(
  models: OrcaRouterModel[],
  modality: "image" | "audio" | "video",
): OrcaRouterModel[] {
  // Fail closed: a model that does not declare the modality is excluded.
  return models.filter((m) => isTextChatModel(m) && m.inputModalities.includes(modality));
}

/** Parse a `/models` response body, bounded by CATALOG_LIMITS.maxModels. */
export function parseCatalogResponse(body: unknown): OrcaRouterModel[] {
  const record = asRecord(body);
  const data = Array.isArray(record.data) ? record.data : Array.isArray(body) ? body : [];
  const models: OrcaRouterModel[] = [];
  for (const raw of data.slice(0, CATALOG_LIMITS.maxModels)) {
    const parsed = parseCatalogModel(raw);
    if (parsed) {
      models.push(parsed);
    }
  }
  return models;
}

export interface DiscoverCatalogOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Fetch the authoritative chat catalog from the inference origin. */
export async function discoverOrcaRouterModels(
  options: DiscoverCatalogOptions,
): Promise<OrcaRouterCatalog> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  try {
    const response = await fetchImpl(buildModelsUrl(options.apiBaseUrl, "chat"), {
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(CATALOG_LIMITS.timeoutMs),
    });
    if (!response.ok) {
      const reason = response.status === 401 ? "unauthorized" : `http ${response.status}`;
      return degradedSeed(now, reason);
    }
    const text = await response.text();
    if (text.length > CATALOG_LIMITS.maxBytes) {
      return degradedSeed(now, "response too large");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return degradedSeed(now, "unreadable response");
    }
    const models = parseCatalogResponse(body).filter(isTextChatModel);
    return { models, status: "live", fetchedAt: now().toISOString() };
  } catch {
    const reason = "network error";
    return degradedSeed(now, reason);
  }
}

function degradedSeed(now: () => Date, reason: string): OrcaRouterCatalog {
  return {
    models: ORCAROUTER_VERIFIED_SEED.map((m) => ({ ...m })),
    status: "degraded",
    reason,
    fetchedAt: now().toISOString(),
  };
}

/**
 * A tiny TTL cache so provider/model switches do not re-fetch on every render.
 * A failed (degraded) catalog is cached briefly; a live one for longer.
 */
export class OrcaRouterCatalogCache {
  private entry: { catalog: OrcaRouterCatalog; expires: number } | undefined;

  constructor(
    private readonly options: DiscoverCatalogOptions & { ttlMs?: number; degradedTtlMs?: number },
  ) {}

  async get(forceRefresh = false): Promise<OrcaRouterCatalog> {
    const now = Date.now();
    if (!forceRefresh && this.entry && this.entry.expires > now) {
      return this.entry.catalog;
    }
    const catalog = await discoverOrcaRouterModels(this.options);
    const ttl = catalog.status === "live" ? this.options.ttlMs ?? 5 * 60_000 : this.options.degradedTtlMs ?? 30_000;
    this.entry = { catalog, expires: now + ttl };
    return catalog;
  }

  invalidate(): void {
    this.entry = undefined;
  }
}

/**
 * Re-validate a previously selected model ID against the current catalog.
 * Returns undefined when the model is no longer available or compatible, so
 * callers can clear the stale selection instead of sending it.
 */
export function revalidateSelectedModel(
  catalog: OrcaRouterCatalog,
  selectedId: string,
  modality?: "image" | "audio" | "video",
): OrcaRouterModel | undefined {
  const pool = modality ? filterModelsByModality(catalog.models, modality) : catalog.models;
  return pool.find((m) => m.id === selectedId);
}
