/**
 * identark/errors
 * ~~~~~~~~~~~~~~~
 * All exceptions raised by the SDK. Rooted at IdentArkError so
 * callers can catch broadly or specifically.
 *
 * Hierarchy:
 * IdentArkError
 * ├── GatewayError
 * │   ├── ControlPlaneError
 * │   │   ├── AuthenticationError
 * │   │   ├── CostCapExceededError
 * │   │   └── SessionNotFoundError
 * │   └── NetworkError
 * ├── LLMError
 * │   ├── RateLimitError
 * │   ├── ContentPolicyError
 * │   └── ProviderError
 * ├── FileError
 * │   ├── PathNotAllowedError
 * │   └── PresignedURLExpiredError
 * └── ConfigurationError
 */

/**
 * Base class for all SDK exceptions.
 */
export class IdentArkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, IdentArkError.prototype);
  }
}

// ── Gateway ───────────────────────────────────────────────────────────────────

/**
 * Raised when a gateway communication operation fails.
 */
export class GatewayError extends IdentArkError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GatewayError.prototype);
  }
}

/**
 * The control plane returned an error response.
 */
export class ControlPlaneError extends GatewayError {
  readonly status_code: number;
  readonly error_code: string;
  override readonly message: string;

  constructor(message: string, statusCode: number = 0, errorCode: string = "unknown") {
    super(message);
    this.message = message;
    this.status_code = statusCode;
    this.error_code = errorCode;
    Object.setPrototypeOf(this, ControlPlaneError.prototype);
  }
}

/**
 * Session token is invalid or has expired.
 */
export class AuthenticationError extends ControlPlaneError {
  readonly session_id: string;
  readonly reason: string;

  constructor(message: string, sessionId: string = "", reason: string = "") {
    super(message, 401, "authentication_failed");
    this.session_id = sessionId;
    this.reason = reason;
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * The session has reached its configured cost cap.
 */
export class CostCapExceededError extends ControlPlaneError {
  readonly cap_usd: number;
  readonly consumed_usd: number;
  readonly session_id: string;

  constructor(
    message: string,
    capUsd: number = 0.0,
    consumedUsd: number = 0.0,
    sessionId: string = "",
  ) {
    super(message, 402, "cost_cap_exceeded");
    this.cap_usd = capUsd;
    this.consumed_usd = consumedUsd;
    this.session_id = sessionId;
    Object.setPrototypeOf(this, CostCapExceededError.prototype);
  }
}

/**
 * Session ID does not exist or has already been terminated.
 */
export class SessionNotFoundError extends ControlPlaneError {
  readonly session_id: string;

  constructor(sessionId: string) {
    super(`Session '${sessionId}' not found or already terminated.`, 404, "session_not_found");
    this.session_id = sessionId;
    Object.setPrototypeOf(this, SessionNotFoundError.prototype);
  }
}

/**
 * All retry attempts to the control plane were exhausted.
 */
export class NetworkError extends GatewayError {
  readonly attempts: number;
  readonly last_status_code: number | undefined;

  constructor(message: string, attempts: number = 0, lastStatusCode?: number) {
    super(message);
    this.attempts = attempts;
    this.last_status_code = lastStatusCode;
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

// ── LLM ──────────────────────────────────────────────────────────────────────

/**
 * Raised when the LLM provider returns an error.
 */
export class LLMError extends IdentArkError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, LLMError.prototype);
  }
}

/**
 * The LLM provider's rate limit has been hit.
 */
export class RateLimitError extends LLMError {
  readonly retry_after_seconds: number;
  readonly provider: string;

  constructor(message: string, retryAfterSeconds: number = 60, provider: string = "unknown") {
    super(message);
    this.retry_after_seconds = retryAfterSeconds;
    this.provider = provider;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * The request was blocked by the provider's content policy.
 */
export class ContentPolicyError extends LLMError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ContentPolicyError.prototype);
  }
}

/**
 * An unclassified error returned by the LLM provider.
 */
export class ProviderError extends LLMError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ProviderError.prototype);
  }
}

// ── File ──────────────────────────────────────────────────────────────────────

/**
 * Raised when a file operation fails.
 */
export class FileError extends IdentArkError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, FileError.prototype);
  }
}

/**
 * The requested file path is outside the allowed workspace.
 */
export class PathNotAllowedError extends FileError {
  readonly attempted_path: string;
  readonly allowed_prefix: string;

  constructor(attemptedPath: string, allowedPrefix: string = "/workspace/") {
    super(
      `Path '${attemptedPath}' is not allowed. File paths must start with '${allowedPrefix}'.`,
    );
    this.attempted_path = attemptedPath;
    this.allowed_prefix = allowedPrefix;
    Object.setPrototypeOf(this, PathNotAllowedError.prototype);
  }
}

/**
 * The presigned URL was used after its expiry timestamp.
 */
export class PresignedURLExpiredError extends FileError {
  readonly file_path: string;
  readonly expired_at: string;

  constructor(filePath: string, expiredAt: string) {
    super(
      `Presigned URL for '${filePath}' expired at ${expiredAt}. Request a new URL via gateway.requestFileUrl().`,
    );
    this.file_path = filePath;
    this.expired_at = expiredAt;
    Object.setPrototypeOf(this, PresignedURLExpiredError.prototype);
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * The gateway was misconfigured at initialisation time.
 */
export class ConfigurationError extends IdentArkError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}
