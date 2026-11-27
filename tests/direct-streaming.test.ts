/**
 * DirectGateway OpenAI streaming: token usage and cost booking.
 *
 * With `stream_options: { include_usage: true }`, OpenAI sends token usage in
 * a trailing chunk whose `choices` array is empty, after the chunk carrying
 * `finish_reason`. Other providers attach usage to the finish chunk. Both must
 * produce a final chunk with token counts and book the call's cost.
 */

import { describe, it, expect, vi } from "vitest";
import { DirectGateway } from "../src/gateways/direct.js";
import { estimateCost } from "../src/pricing.js";
import { Role } from "../src/types.js";
import type { Message, StreamChunk } from "../src/types.js";
import { CostCapExceededError } from "../src/errors.js";

const USER_MSG: Message[] = [{ role: Role.USER, content: "Hi" }];

type FakeChunk = {
  choices: { delta: { content?: string }; finish_reason: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
};

function chunk(content?: string, finishReason: string | null = null): FakeChunk {
  return { choices: [{ delta: { content }, finish_reason: finishReason }] };
}

const USAGE = { prompt_tokens: 1000, completion_tokens: 500 };

/** What OpenAI sends with include_usage: usage in a trailing chunk with empty choices. */
const TRAILING_USAGE: FakeChunk[] = [
  chunk("Hel"),
  chunk("lo"),
  chunk(undefined, "stop"),
  { choices: [], usage: USAGE },
];

/** Usage attached to the finish chunk itself, as some providers do. */
const USAGE_ON_FINISH: FakeChunk[] = [
  chunk("Hel"),
  chunk("lo"),
  { ...chunk(undefined, "stop"), usage: USAGE },
];

function streamOf(chunks: FakeChunk[]): AsyncIterable<FakeChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function gatewayFor(create: ReturnType<typeof vi.fn>, costCapUsd?: number): DirectGateway {
  return new DirectGateway(
    { chat: { completions: { create } } },
    "gpt-4o",
    undefined,
    costCapUsd,
    "/workspace",
    "openai",
  );
}

async function drain(gateway: DirectGateway): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gateway.invokeLlmStream(USER_MSG)) out.push(c);
  return out;
}

describe("DirectGateway OpenAI streaming usage and cost", () => {
  it.each([
    ["trailing usage chunk", TRAILING_USAGE],
    ["usage on finish chunk", USAGE_ON_FINISH],
  ])("books cost and reports tokens with %s", async (_name, chunks) => {
    const create = vi.fn().mockResolvedValueOnce(streamOf(chunks));
    const gateway = gatewayFor(create);

    const out = await drain(gateway);

    expect(out.map((c) => c.content).join("")).toBe("Hello");
    const finals = out.filter((c) => c.finish_reason !== null);
    expect(finals).toHaveLength(1);
    expect(out[out.length - 1]).toBe(finals[0]);
    expect(finals[0].finish_reason).toBe("stop");
    expect(finals[0].input_tokens).toBe(1000);
    expect(finals[0].output_tokens).toBe(500);

    const expected = estimateCost("gpt-4o", 1000, 500, "openai");
    expect(expected).toBeGreaterThan(0);
    expect(await gateway.getSessionCost()).toBeCloseTo(expected, 10);
  });

  it("blocks the next stream once a streamed call reaches the cost cap", async () => {
    const oneCall = estimateCost("gpt-4o", 1000, 500, "openai");
    const create = vi
      .fn()
      .mockResolvedValueOnce(streamOf(TRAILING_USAGE))
      .mockResolvedValueOnce(streamOf(TRAILING_USAGE));
    const gateway = gatewayFor(create, oneCall / 2);

    await drain(gateway); // soft cap: checked before the call, so this one runs

    await expect(drain(gateway)).rejects.toThrow(CostCapExceededError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("emits no final chunk when the stream never sends finish_reason", async () => {
    const create = vi.fn().mockResolvedValueOnce(streamOf([chunk("partial")]));
    const gateway = gatewayFor(create);

    const out = await drain(gateway);

    expect(out.map((c) => c.content)).toEqual(["partial"]);
    expect(out.every((c) => c.finish_reason === null)).toBe(true);
  });
});
