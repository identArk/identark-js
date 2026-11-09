/**
 * identark/providers/orcarouter/credentials
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * Credential seam for the OrcaRouter Cyber Inference provider.
 *
 * Both ways of obtaining an OrcaRouter API key — pasting an existing
 * `sk-orca-…` key, or signing in with OAuth 2.0 + PKCE — are adapters on the
 * same small {@link OrcaRouterCredentialSource} interface. Each adapter yields
 * the same {@link OrcaRouterCredential} shape, so the provider, model
 * discovery, and every downstream adapter only ever see "a key".
 *
 * The seam has no opinion about where keys are stored: hosts pass in their
 * own load/save/clear functions (OS keychain, existing credentials file, ...).
 * A small in-process fallback store is provided for scripts and tests.
 */

import { ConfigurationError } from "../../errors.js";

/** How a credential was obtained. Downstream code must not branch on this. */
export type OrcaRouterCredentialKind = "api_key" | "oauth_pkce";

/** A resolved OrcaRouter API key plus provenance metadata. */
export interface OrcaRouterCredential {
  /** The `sk-orca-…` key. Never log, serialize, or embed this value. */
  readonly apiKey: string;
  /** Which adapter produced this credential. */
  readonly source: OrcaRouterCredentialKind;
  /**
   * Granted scope reported by the PKCE exchange (`"api"` for this provider)
   * or an explicit edit time for pasted keys. Metadata only.
   */
  readonly scope?: string;
  /** Account identifier returned by the PKCE exchange, when present. */
  readonly userId?: string;
  /**
   * Monotonic credential generation. A `401` must only mark the exact
   * generation that made the rejected request as needing reauthentication.
   */
  readonly generation: number;
  /** True once the relay rejected this exact generation. */
  readonly needsReauth: boolean;
}

/** Persistence hooks owned by the host application. */
export interface OrcaRouterCredentialStore {
  /** Return the stored credential, or undefined. Must never throw on absence. */
  load(): Promise<OrcaRouterCredential | undefined> | OrcaRouterCredential | undefined;
  /** Persist a credential. Must not log or return the secret. */
  save(credential: OrcaRouterCredential): Promise<void> | void;
  /** Remove the stored credential. */
  clear(): Promise<void> | void;
}

/**
 * Obtain an OrcaRouter credential. `generation` identifies the credential
 * instance so that a late `401` from an older instance cannot poison a newer one.
 */
export interface OrcaRouterCredentialSource {
  readonly kind: OrcaRouterCredentialKind;
  obtain(generation: number): Promise<OrcaRouterCredential>;
}

const KEY_PREFIX = "sk-orca-";

/** A single blank `sk-orca-…` key can never be valid: the prefix is the whole value. */
const MIN_KEY_LENGTH = KEY_PREFIX.length + 8;

/**
 * Lightweight format check only. The `sk-orca-` prefix is not proof that a
 * credential is valid; validity is established by the first real request.
 */
export function assertLooksLikeOrcaRouterKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new ConfigurationError("An OrcaRouter API key is required.");
  }
  if (trimmed.length < MIN_KEY_LENGTH || !trimmed.startsWith(KEY_PREFIX)) {
    throw new ConfigurationError(
      `OrcaRouter API keys start with "${KEY_PREFIX}". Copy the key from ` +
        "https://www.orcarouter.ai/console and try again.",
    );
  }
  return trimmed;
}

/** Replace a secret with a fixed marker for diagnostics. */
export function maskOrcaRouterKey(key: string): string {
  return key ? `${KEY_PREFIX}…` : "";
}

/** In-memory store for scripts and tests. Not for production secret storage. */
export function createMemoryCredentialStore(
  initial?: OrcaRouterCredential,
): OrcaRouterCredentialStore {
  let stored = initial;
  return {
    load: () => stored,
    save: (credential) => {
      stored = credential;
    },
    clear: () => {
      stored = undefined;
    },
  };
}

/** Options shared by credential sources that persist through a store. */
export interface CredentialStoreOptions {
  /** Host-owned persistence. Defaults to an in-process memory store. */
  store?: OrcaRouterCredentialStore;
  /** Current credential generation, used to stamp newly saved credentials. */
  generation?: () => number;
}

/** Resolve the host's store, defaulting to an in-process one. */
export function resolveStore(options: CredentialStoreOptions | undefined): OrcaRouterCredentialStore {
  return options?.store ?? createMemoryCredentialStore();
}

/**
 * API-key adapter: reads a pasted `sk-orca-…` key, optionally persists it via
 * the host's store, and can be updated or cleared.
 */
export class OrcaRouterApiKeySource implements OrcaRouterCredentialSource {
  readonly kind = "api_key" as const;
  private readonly store: OrcaRouterCredentialStore;
  private readonly nextGeneration: () => number;
  private scope: string | undefined;
  private userId: string | undefined;

  constructor(options: CredentialStoreOptions = {}) {
    this.store = resolveStore(options);
    this.nextGeneration = options.generation ?? (() => 1);
  }

  /** Save a pasted key. The key never appears in thrown errors. */
  async setApiKey(apiKey: string): Promise<OrcaRouterCredential> {
    const credential: OrcaRouterCredential = {
      apiKey: assertLooksLikeOrcaRouterKey(apiKey),
      source: "api_key",
      generation: this.nextGeneration(),
      needsReauth: false,
      ...(this.scope !== undefined ? { scope: this.scope } : {}),
      ...(this.userId !== undefined ? { userId: this.userId } : {}),
    };
    await this.store.save(credential);
    return credential;
  }

  /** Remove the stored key. Returns true if something was removed. */
  async clear(): Promise<boolean> {
    const existing = await this.store.load();
    await this.store.clear();
    return existing !== undefined;
  }

  /** The stored key as a masked string, safe for diagnostics. */
  async masked(): Promise<string> {
    const existing = await this.store.load();
    return existing ? maskOrcaRouterKey(existing.apiKey) : "";
  }

  async obtain(generation: number): Promise<OrcaRouterCredential> {
    const existing = await this.store.load();
    if (existing) {
      // Stamp the caller's generation: it is the counter a `401` is attributed to.
      return { ...existing, generation };
    }
    const envKey = globalThis.process?.env?.ORCAROUTER_API_KEY;
    if (envKey) {
      return this.setApiKey(envKey);
    }
    throw new ConfigurationError(
      "No OrcaRouter API key configured. Paste one from " +
        "https://www.orcarouter.ai/console or set ORCAROUTER_API_KEY.",
    );
  }
}

/**
 * Build a credential source that accepts either auth method. This is the
 * small interface the provider depends on; the host picks an adapter.
 */
export function staticCredentialSource(
  credential: OrcaRouterCredential,
): OrcaRouterCredentialSource {
  return {
    kind: credential.source,
    obtain: (generation) => Promise.resolve({ ...credential, generation }),
  };
}
