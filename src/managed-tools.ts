/** Client for asynchronous IdentArk-managed MCP/database tools. */

import { ConfigurationError, ManagedToolsError } from "./errors.js";

export type ManagedExecutionStatus =
  | "received"
  | "pending_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "rejected"
  | "timeout"
  | "cancelled";

export interface ManagedExecution {
  execution_id: string;
  connector_id: string;
  tool_name: string;
  status: ManagedExecutionStatus;
  risk_score: number | null;
  risk_level: string | null;
  approval_id: string | null;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
}

export interface ManagedToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  requires_human_approval: boolean;
}

export interface ManagedToolsClientOptions {
  apiKey?: string;
  url?: string;
  agentId?: string;
  timeoutSeconds?: number;
}

const TERMINAL = new Set<ManagedExecutionStatus>([
  "succeeded",
  "failed",
  "rejected",
  "timeout",
  "cancelled",
]);

export class ManagedToolsClient {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly agentId: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: ManagedToolsClientOptions = {}) {
    this.apiKey =
      options.apiKey ||
      (process.env.IDENTARK_SESSION_TOKEN as string | undefined) ||
      (process.env.IDENTARK_API_KEY as string | undefined) ||
      "";
    this.url =
      options.url ||
      (process.env.IDENTARK_CONTROL_PLANE_URL as string | undefined) ||
      "";
    this.agentId =
      options.agentId || (process.env.IDENTARK_AGENT_ID as string | undefined);
    this.timeoutMs = (options.timeoutSeconds ?? 30) * 1000;
    if (!this.apiKey) {
      throw new ConfigurationError(
        "Provide apiKey or set IDENTARK_API_KEY/IDENTARK_SESSION_TOKEN.",
      );
    }
    if (!this.url) {
      throw new ConfigurationError(
        "Provide url or set IDENTARK_CONTROL_PLANE_URL.",
      );
    }
  }

  async listTools(connectorId: string): Promise<ManagedToolDefinition[]> {
    const data = await this.request(
      "GET",
      `/mcp/managed-databases/${encodeURIComponent(connectorId)}/tools`,
    );
    return (data.tools || []) as ManagedToolDefinition[];
  }

  async createExecution(input: {
    connectorId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<ManagedExecution> {
    const headers: Record<string, string> = {
      "Idempotency-Key": input.idempotencyKey,
    };
    if (this.agentId) headers["X-IdentArk-Agent-Id"] = this.agentId;
    return (await this.request("POST", "/mcp/managed-databases/executions", {
      headers,
      body: JSON.stringify({
        connector_id: input.connectorId,
        tool_name: input.toolName,
        arguments: input.arguments,
      }),
    })) as unknown as ManagedExecution;
  }

  async getExecution(executionId: string): Promise<ManagedExecution> {
    return (await this.request(
      "GET",
      `/mcp/managed-databases/executions/${encodeURIComponent(executionId)}`,
    )) as unknown as ManagedExecution;
  }

  async resumeExecution(executionId: string): Promise<ManagedExecution> {
    return (await this.request(
      "POST",
      `/mcp/managed-databases/executions/${encodeURIComponent(executionId)}/resume`,
    )) as unknown as ManagedExecution;
  }

  async cancelExecution(executionId: string): Promise<ManagedExecution> {
    return (await this.request(
      "POST",
      `/mcp/managed-databases/executions/${encodeURIComponent(executionId)}/cancel`,
    )) as unknown as ManagedExecution;
  }

  async waitForExecution(
    executionId: string,
    options: { timeoutSeconds?: number; pollIntervalMs?: number } = {},
  ): Promise<ManagedExecution> {
    const deadline = Date.now() + (options.timeoutSeconds ?? 300) * 1000;
    const interval = options.pollIntervalMs ?? 1000;
    let current = await this.getExecution(executionId);
    while (!TERMINAL.has(current.status)) {
      if (Date.now() >= deadline) {
        throw new ManagedToolsError(
          `Timed out waiting for managed execution ${executionId}`,
          408,
          "client_timeout",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
      current = await this.resumeExecution(executionId);
    }
    return current;
  }

  private async request(
    method: string,
    path: string,
    options: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
        ...options,
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ManagedToolsError(
        `Unable to reach the IdentArk managed tools API: ${(error as Error).message}`,
      );
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const detail = body.detail;
      const structured =
        typeof detail === "object" && detail !== null
          ? (detail as Record<string, unknown>)
          : undefined;
      throw new ManagedToolsError(
        String(structured?.message || detail || "Managed tool request failed"),
        response.status,
        String(structured?.code || "managed_tools_error"),
      );
    }
    return body;
  }
}
