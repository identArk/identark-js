import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedToolsClient } from "../src/managed-tools.js";
import { ManagedToolsError } from "../src/errors.js";

global.fetch = vi.fn();

const execution = {
  execution_id: "exec-1",
  connector_id: "connector-1",
  tool_name: "update_customer",
  status: "pending_approval",
  risk_score: 67,
  risk_level: "medium",
  approval_id: "approval-1",
  result: null,
  error: null,
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z",
  executed_at: null,
};

describe("ManagedToolsClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an idempotent execution without a provider credential", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => execution,
    });
    const client = new ManagedToolsClient({
      apiKey: "csk-test",
      url: "https://api.identark.io/v1",
      agentId: "customer-agent",
    });

    const result = await client.createExecution({
      connectorId: "connector-1",
      toolName: "update_customer",
      arguments: { customer_id: "cus-1", updates: { status: "inactive" } },
      idempotencyKey: "customer-request-1",
    });

    expect(result.status).toBe("pending_approval");
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "customer-request-1",
    );
    expect((init.headers as Record<string, string>)["X-IdentArk-Agent-Id"]).toBe(
      "customer-agent",
    );
    expect(JSON.stringify(init.body)).not.toContain("password");
  });

  it("parses structured API failures", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        detail: { code: "execution_in_progress", message: "Already running" },
      }),
    });
    const client = new ManagedToolsClient({ apiKey: "csk-test", url: "https://api/v1" });

    await expect(client.resumeExecution("exec-1")).rejects.toMatchObject<ManagedToolsError>({
      error_code: "execution_in_progress",
      status_code: 409,
    });
  });
});
