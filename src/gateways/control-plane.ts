/**
 * identark/gateways/control-plane
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * ControlPlaneGateway — production implementation of AgentGateway.
 *
 * Routes all requests through the IdentArk control plane. The agent
 * holds zero API keys or credentials. All credentialed operations are
 * executed by the control plane on the agent's behalf.
 */

import type { AgentGateway } from "../gateway.js";
import type {
  Message,
  LLMResponse,
  PresignedURL,
  StreamChunk,
  ToolCall,
} from "../types.js";
import { Role, messageToOpenAiDict } from "../types.js";
import {
  AuthenticationError,
  ConfigurationError,
  ContentPolicyError,
  ControlPlaneError,
  CostCapExceededError,
  NetworkError,
  PathNotAllowedError,
  SessionNotFoundError,
} from "../errors.js";

/**
 * Production implementation of AgentGateway.
 *
 * Routes all requests through the IdentArk control plane. When running
 * inside an IdentArk sandbox, all parameters are auto-detected from
 * environment variables — no arguments required.
 */
export class ControlPlaneGateway implements AgentGateway {
  private apiKey: string;
  private url: string;
  private sessionId?: string;
  private timeout: number;
  private maxRetries: number;

  /**
   * Create a new ControlPlaneGateway instance.
   *
   * @param apiKey - IdentArk API key. Auto-detected from IDENTARK_API_KEY or
   *                 IDENTARK_SESSION_TOKEN env vars.
   * @param url - Control plane base URL. Auto-detected from IDENTARK_CONTROL_PLANE_URL.
   * @param sessionId - Session identifier. Auto-detected from IDENTARK_SESSION_ID.
   * @param timeout - Per-request timeout in seconds. Default: 30.
   * @param maxRetries - Retry attempts on transient failures. Default: 3.
   */
  constructor(
    apiKey?: string,
    url?: string,
    sessionId?: string,
    timeout: number = 30.0,
    maxRetries: number = 3,
  ) {
    this.apiKey =
      apiKey ||
      (process.env.IDENTARK_SESSION_TOKEN as string | undefined) ||
      (process.env.IDENTARK_API_KEY as string | undefined) ||
      "";

    this.url =
      url || (process.env.IDENTARK_CONTROL_PLANE_URL as string | undefined) || "";
    const sessionIdValue =
      sessionId || (process.env.IDENTARK_SESSION_ID as string | undefined);
    if (sessionIdValue) {
      this.sessionId = sessionIdValue;
    }
    this.timeout = timeout;
    this.maxRetries = maxRetries;

    if (!this.apiKey) {
      throw new ConfigurationError(
        "No API key found. Provide apiKey= or set IDENTARK_API_KEY " +
          "(outside sandbox) / IDENTARK_SESSION_TOKEN (inside sandbox).",
      );
    }
    if (!this.url) {
      throw new ConfigurationError(
        "No control plane URL found. Provide url= or set IDENTARK_CONTROL_PLANE_URL.",
      );
    }
  }

  /**
   * Send new messages to the LLM via the control plane.
   */
  async invokeLlm(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice: string | Record<string, unknown> = "auto",
  ): Promise<LLMResponse> {
    const payload: Record<string, unknown> = {
      new_messages: newMessages.map((m) => messageToOpenAiDict(m)),
    };
    if (this.sessionId) {
      payload.session_id = this.sessionId;
    }
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = toolChoice;
    }

    const data = await this._post("/llm/invoke", payload);
    return this._parseLlmResponse(data);
  }

  /**
   * Persist messages to conversation history via the control plane.
   */
  async persistMessages(messages: Message[]): Promise<void> {
    const payload: Record<string, unknown> = {
      messages: messages.map((m) => messageToOpenAiDict(m)),
    };
    if (this.sessionId) {
      payload.session_id = this.sessionId;
    }

    await this._post("/messages/persist", payload);
  }

  /**
   * Request a presigned URL for workspace file access.
   */
  async requestFileUrl(filePath: string, method: string = "PUT"): Promise<PresignedURL> {
    if (!filePath.startsWith("/workspace/")) {
      throw new PathNotAllowedError(filePath);
    }

    const payload: Record<string, unknown> = {
      file_path: filePath,
      method,
    };
    if (this.sessionId) {
      payload.session_id = this.sessionId;
    }

    const data = await this._post("/files/presigned-urls", payload);
    return {
      url: data.url as string,
      expires_at: data.expires_at as string,
      method: data.method as string,
      file_path: data.file_path as string,
    };
  }

  /**
   * Stream the LLM response via SSE from the control plane.
   */
  async *invokeLlmStream(
    newMessages: Message[],
    tools?: Record<string, unknown>[],
    toolChoice: string | Record<string, unknown> = "auto",
  ): AsyncGenerator<StreamChunk> {
    const payload: Record<string, unknown> = {
      new_messages: newMessages.map((m) => messageToOpenAiDict(m)),
    };
    if (this.sessionId) {
      payload.session_id = this.sessionId;
    }
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = toolChoice;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "X-IdentArk-SDK": "1.0.0",
    };

    const url = `${this.url.replace(/\/$/, "")}/llm/stream`;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      this._raise4xx(response.status, text);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response has no body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const data = line.slice("data:".length).trim();
          if (data === "[DONE]") {
            return;
          }

          try {
            const event = JSON.parse(data);
            yield {
              content: event.content || "",
              finish_reason: event.finish_reason || null,
              model: event.model || "unknown",
              input_tokens: event.input_tokens || 0,
              output_tokens: event.output_tokens || 0,
            };
          } catch {
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Return the authoritative total session cost from the control plane.
   */
  async getSessionCost(): Promise<number> {
    const params = new URLSearchParams();
    if (this.sessionId) {
      params.append("session_id", this.sessionId as string);
    }

    const data = await this._get("/sessions/cost", params);
    const costValue = data.cost_usd as string | number | undefined;
    return parseFloat(String(costValue ?? "0.0"));
  }

  /**
   * Close the gateway connection.
   */
  async close(): Promise<void> {
    // No resources to clean up with fetch API
  }

  // ── HTTP internals ────────────────────────────────────────────────────────

  private async _post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._request("POST", path, { body: JSON.stringify(payload) });
  }

  private async _get(
    path: string,
    params: URLSearchParams | null = null,
  ): Promise<Record<string, unknown>> {
    const url = params ? `${path}?${params.toString()}` : path;
    return this._request("GET", url);
  }

  private async _request(
    method: string,
    path: string,
    options?: RequestInit,
  ): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-IdentArk-SDK": "1.0.0",
        };

        const url = `${this.url.replace(/\/$/, "")}${path}`;
        const response = await fetch(url, {
          method,
          headers,
          ...options,
          signal: AbortSignal.timeout(this.timeout * 1000),
        });

        if (response.ok) {
          return (await response.json()) as Record<string, unknown>;
        }

        if (response.status >= 400 && response.status < 500) {
          const text = await response.text();
          this._raise4xx(response.status, text);
        }

        // 5xx — transient, retry
        lastError = new ControlPlaneError(
          `Control plane error ${response.status}`,
          response.status,
        );

        if (attempt < this.maxRetries) {
          await this._sleep(2 ** (attempt - 1));
        }
      } catch (exc) {
        // Re-throw client errors immediately — they should never be retried
        if (
          exc instanceof AuthenticationError ||
          exc instanceof CostCapExceededError ||
          exc instanceof SessionNotFoundError ||
          exc instanceof ContentPolicyError ||
          exc instanceof PathNotAllowedError
        ) {
          throw exc;
        }

        if (
          exc instanceof TypeError ||
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (exc as any).name === "AbortError"
        ) {
          lastError = new Error(
            `Request timeout or network error: ${(exc as Error).message}`,
          );
        } else {
          lastError = exc as Error;
        }

        if (attempt < this.maxRetries) {
          await this._sleep(2 ** (attempt - 1));
        }
      }
    }

    throw new NetworkError(
      `All ${this.maxRetries} attempts to control plane failed for ${path}.`,
      this.maxRetries,
      (lastError instanceof ControlPlaneError) ? lastError.status_code : undefined,
    );
  }

  private _raise4xx(status: number, text: string): never {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      // Ignore JSON parsing errors
    }

    const errorCode = (body.error_code as string) || "unknown";
    const message = (body.message as string) || text;

    if (status === 401 || errorCode === "authentication_failed") {
      throw new AuthenticationError(
        message,
        (body.session_id as string) || "",
        (body.reason as string) || "",
      );
    }

    if (status === 402 || errorCode === "cost_cap_exceeded") {
      throw new CostCapExceededError(
        message,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parseFloat(body.cap_usd as any) || 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parseFloat(body.consumed_usd as any) || 0,
        (body.session_id as string) || "",
      );
    }

    if (status === 404 || errorCode === "session_not_found") {
      throw new SessionNotFoundError((body.session_id as string) || "unknown");
    }

    if (errorCode === "content_policy") {
      throw new ContentPolicyError(message);
    }

    throw new ControlPlaneError(message, status, errorCode);
  }

  private _parseLlmResponse(data: Record<string, unknown>): LLMResponse {
    const msgData = (data.message || {}) as Record<string, unknown>;
    const usageData = (data.usage || {}) as Record<string, unknown>;

    let toolCalls: ToolCall[] | undefined;
    if (data.tool_calls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCalls = (data.tool_calls as any[]).map((tc) => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    const roleStr = (msgData.role as string) || "assistant";
    const roleValue = Object.values(Role).includes(roleStr as Role)
      ? (roleStr as Role)
      : Role.ASSISTANT;

    const response: LLMResponse = {
      message: {
        role: roleValue,
        content: (msgData.content as string) || "",
        tokens: (usageData.output_tokens as number) || 0,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cost_usd: parseFloat(data.cost_usd as any) || 0.0,
      model: (data.model as string) || "unknown",
      finish_reason: (data.finish_reason as string) || "stop",
      usage: {
        input_tokens: (usageData.input_tokens as number) || 0,
        output_tokens: (usageData.output_tokens as number) || 0,
        total_tokens: (usageData.total_tokens as number) || 0,
        cached_tokens: (usageData.cached_tokens as number) || 0,
      },
    };

    if (toolCalls) {
      response.tool_calls = toolCalls;
    }

    return response;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms * 1000));
  }
}
