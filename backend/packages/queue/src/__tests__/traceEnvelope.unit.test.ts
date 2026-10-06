import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTraceContext, withTraceContext } from "@semprec/shared";
import { enqueueJob, queueJobEnvelopeSchema, registerTask } from "../index.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOLE_TENANT = "6f1d2c3e-1a2b-4c5d-8e9f-0a1b2c3d4e5f";

/** Answers the tenant task wrapper's sole-tenant and status lookups with one active tenant. */
function fakeHelpers(jobId: string | number): { job: { id: string | number }; query: unknown } {
  return {
    job: { id: jobId },
    query: async (sql: string) => ({
      rows: sql.includes("app_sole_tenant") ? [{ app_sole_tenant: SOLE_TENANT }] : [{ status: "active" }],
    }),
  };
}

describe("queueJobEnvelopeSchema", () => {
  it("accepts a valid envelope", () => {
    const result = queueJobEnvelopeSchema.safeParse({
      traceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      payload: { a: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload with no traceId (a public producer trying to omit the trace)", () => {
    const result = queueJobEnvelopeSchema.safeParse({ payload: { a: 1 } });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID traceId", () => {
    const result = queueJobEnvelopeSchema.safeParse({ traceId: "not-a-uuid", payload: {} });
    expect(result.success).toBe(false);
  });
});

describe("registerTask", () => {
  beforeEach(() => {
    vi.stubEnv("SEMPREC_LEGACY_ENVELOPE_FALLBACK", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("restores the producer's traceId and unwraps the business payload for the handler", async () => {
    let observed: { payload: unknown; context: unknown } | undefined;
    const handler = registerTask("someTask", async (payload) => {
      observed = { payload, context: getTraceContext() };
    });

    await handler(
      { traceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", payload: { itemId: "abc" } },
      fakeHelpers("42") as never,
    );

    expect(observed?.payload).toEqual({ itemId: "abc" });
    expect(observed?.context).toEqual({
      traceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      jobName: "someTask",
      jobId: "42",
    });
  });

  it("mints a fresh trace for a crontab-triggered payload with no envelope", async () => {
    let observed: { payload: unknown; traceId: string | undefined } | undefined;
    const handler = registerTask("heartbeatSweep", async (payload) => {
      observed = { payload, traceId: getTraceContext()?.traceId };
    });

    await handler({}, fakeHelpers("7") as never);

    expect(observed?.payload).toEqual({});
    expect(observed?.traceId).toMatch(UUID_PATTERN);
  });

  it("tolerates helpers missing job.id (a raw unit-test call, not a real graphile-worker run)", async () => {
    let jobId: string | undefined;
    const handler = registerTask("someTask", async () => {
      jobId = getTraceContext()?.jobId;
    });

    await handler({}, { query: fakeHelpers("0").query } as never);

    expect(jobId).toBeUndefined();
  });

  it("extends an already-active trace instead of minting a new one when called from inside one", async () => {
    let observedTraceId: string | undefined;
    const handler = registerTask("nestedTask", async () => {
      observedTraceId = getTraceContext()?.traceId;
    });

    await withTraceContext({ traceId: "outer-trace" }, () => handler({}, fakeHelpers("1") as never));

    expect(observedTraceId).toBe("outer-trace");
  });
});

describe("enqueueJob", () => {
  function fakeClient() {
    return { query: vi.fn().mockResolvedValue({ rows: [] }) };
  }

  it("stamps the envelope's traceId itself; a caller-supplied 'traceId' business field lands only inside payload", async () => {
    const client = fakeClient();

    await withTraceContext({ traceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }, () =>
      enqueueJob(client as never, "someTask", { traceId: "attacker-supplied", itemId: "abc" }),
    );

    const [, params] = client.query.mock.calls[0] as [string, unknown[]];
    const sentEnvelope = JSON.parse(params[1] as string);
    expect(sentEnvelope).toEqual({
      traceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      tenantId: null,
      payload: { traceId: "attacker-supplied", itemId: "abc" },
    });
  });

  it("mints a fresh traceId when enqueued outside any active trace", async () => {
    const client = fakeClient();

    await enqueueJob(client as never, "someTask", { itemId: "abc" });

    const [, params] = client.query.mock.calls[0] as [string, unknown[]];
    const sentEnvelope = JSON.parse(params[1] as string);
    expect(sentEnvelope.traceId).toMatch(UUID_PATTERN);
  });
});
