import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@semprec/shared/src/logger.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => log,
}));

import { TenantScopeMissingError, currentTenantScope, runAsSystem, runInTenant } from "@semprec/shared";
import {
  AGENT_TASK_NAMES,
  CORE_TASK_NAMES,
  TASK_TENANCY,
  enqueueJob,
  queueJobEnvelopeSchema,
  registerTask,
} from "../index.js";

const T = randomUUID();
const U = randomUUID();
const TRACE_ID = randomUUID();

const SYSTEM_TASKS = [
  "heartbeatSweep",
  "docCompactionSweep",
  "docHistoryCleanup",
  "mailAccountSyncSweep",
  "mailSearchReindexSweep",
  "itemTrashPurgeSweep",
  "trashPurge",
  "observabilityCheckSystem",
  "mcpRunCredentialExpirySweep",
  "agentRunEventsRetention",
  "queueFailedJobsPrune",
];

interface FakeHelperOptions {
  status?: string | null;
  soleTenant?: string | null;
  key?: string | null;
}

/** Fake graphile helpers: `status: null` means no `tenants` row; `soleTenant` is `app_sole_tenant()`'s answer. */
function fakeHelpers(options: FakeHelperOptions = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("app_sole_tenant")) return { rows: [{ app_sole_tenant: options.soleTenant ?? null }] };
    if (sql.includes("FROM tenants")) {
      return { rows: options.status === null ? [] : [{ status: options.status ?? "active" }] };
    }
    if (sql.includes("graphile_worker.jobs")) return { rows: [{ key: null }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { job: { id: "9", key: options.key ?? null }, query };
}

function fakeClient() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) };
}

function sentEnvelope(client: ReturnType<typeof fakeClient>): Record<string, unknown> {
  const [, params] = client.query.mock.calls[0] as [string, unknown[]];
  return JSON.parse(params[1] as string) as Record<string, unknown>;
}

describe("enqueueJob tenant stamping", () => {
  const original = process.env.SEMPREC_TENANT_SCOPE;

  beforeEach(() => {
    log.warn.mockClear();
    delete process.env.SEMPREC_TENANT_SCOPE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = original;
  });

  it("stamps the tenant id inside runInTenant", async () => {
    const client = fakeClient();
    await runInTenant(T, () => enqueueJob(client as never, "someTask", { a: 1 }));
    expect(sentEnvelope(client)).toMatchObject({ tenantId: T, payload: { a: 1 } });
  });

  it("stamps null inside runAsSystem", async () => {
    const client = fakeClient();
    await runAsSystem("test", () => enqueueJob(client as never, "someTask", {}));
    expect(sentEnvelope(client).tenantId).toBeNull();
  });

  it("stamps null and logs tenant_scope_missing once with no scope in warn mode", async () => {
    const client = fakeClient();
    await enqueueJob(client as never, "someTask", {});
    expect(sentEnvelope(client).tenantId).toBeNull();
    const missing = log.warn.mock.calls.filter((call) => call[1] === "tenant_scope_missing");
    expect(missing).toHaveLength(1);
  });

  it("rejects with TenantScopeMissingError and sends no SQL with no scope in strict mode", async () => {
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    const client = fakeClient();
    await expect(enqueueJob(client as never, "someTask", {})).rejects.toBeInstanceOf(TenantScopeMissingError);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("never reads the tenant from the payload", async () => {
    const client = fakeClient();
    await runInTenant(T, () => enqueueJob(client as never, "someTask", { tenantId: U }));
    expect(sentEnvelope(client)).toMatchObject({ tenantId: T, payload: { tenantId: U } });
  });
});

describe("registerTask tenant tasks", () => {
  beforeEach(() => {
    log.warn.mockClear();
    log.info.mockClear();
  });

  function observingTask(name: string) {
    const seen: Array<{ scope: unknown; payload: unknown }> = [];
    const task = registerTask(name, async (payload) => {
      seen.push({ scope: currentTenantScope(), payload });
    });
    return { task, seen };
  }

  it.each(["active", "provisioning"])("runs the handler in the envelope's tenant when it is %s", async (status) => {
    const { task, seen } = observingTask("someTask");
    const helpers = fakeHelpers({ status });
    await task({ traceId: TRACE_ID, tenantId: T, payload: { a: 1 } }, helpers as never);
    expect(seen).toEqual([{ scope: { kind: "tenant", tenantId: T }, payload: { a: 1 } }]);
    expect(helpers.query).toHaveBeenCalledWith("SELECT status FROM tenants WHERE id = $1", [T]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(["suspended", "deleting", null])("does not call the handler when the tenant is %s", async (status) => {
    const { task, seen } = observingTask("someTask");
    await expect(
      task({ traceId: TRACE_ID, tenantId: T, payload: {} }, fakeHelpers({ status }) as never),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: "someTask", jobId: "9", tenantId: T, status: status ?? "missing" }),
      expect.any(String),
    );
  });

  it.each([
    ["a legacy envelope", { traceId: TRACE_ID, payload: { a: 1 } }, { a: 1 }],
    ["a null tenantId", { traceId: TRACE_ID, tenantId: null, payload: { a: 1 } }, { a: 1 }],
    ["a raw payload", { raw: true }, { raw: true }],
  ])("falls back to the sole tenant for %s", async (_label, raw, expectedPayload) => {
    const { task, seen } = observingTask("someTask");
    await task(raw, fakeHelpers({ soleTenant: T }) as never);
    expect(seen).toEqual([{ scope: { kind: "tenant", tenantId: T }, payload: expectedPayload }]);
    const warned = log.warn.mock.calls.filter((call) => call[1] === "tenant_task_without_tenant");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.[0]).toEqual({ jobName: "someTask", jobId: "9" });
  });

  it("rejects when there is no tenant and no sole tenant", async () => {
    const { task, seen } = observingTask("someTask");
    await expect(task({ traceId: TRACE_ID, payload: {} }, fakeHelpers({ soleTenant: null }) as never)).rejects.toThrow(
      /no tenant/,
    );
    expect(seen).toEqual([]);
  });

  it("treats a module task name outside the catalog as a tenant task", async () => {
    const { task, seen } = observingTask("fixtureModule.processThing");
    await task({ traceId: TRACE_ID, tenantId: T, payload: {} }, fakeHelpers() as never);
    expect(seen[0]?.scope).toEqual({ kind: "tenant", tenantId: T });
  });
});

describe("registerTask system tasks", () => {
  it("runs a system task in a system scope even when the envelope carries a tenantId", async () => {
    let scope: unknown;
    const task = registerTask("heartbeatSweep", async () => {
      scope = currentTenantScope();
    });
    const helpers = fakeHelpers();
    await task({ traceId: TRACE_ID, tenantId: T, payload: {} }, helpers as never);
    expect(scope).toEqual({ kind: "system", reason: "task:heartbeatSweep" });
    expect(helpers.query).not.toHaveBeenCalled();
  });
});

describe("registerTask supersession", () => {
  it("swallows a handler error when the job's key was cleared", async () => {
    const task = registerTask("someTask", async () => {
      throw new Error("boom");
    });
    await expect(
      task({ traceId: TRACE_ID, tenantId: T, payload: {} }, fakeHelpers({ key: "k" }) as never),
    ).resolves.toBeUndefined();
  });

  it("propagates a handler error when the job has no key", async () => {
    const task = registerTask("someTask", async () => {
      throw new Error("boom");
    });
    await expect(task({ traceId: TRACE_ID, tenantId: T, payload: {} }, fakeHelpers() as never)).rejects.toThrow("boom");
  });
});

describe("TASK_TENANCY", () => {
  it("has an entry for every core and agent task name, with exactly the 11 sweeps as system", () => {
    const names = [...Object.values(CORE_TASK_NAMES), ...Object.values(AGENT_TASK_NAMES)];
    expect(Object.keys(TASK_TENANCY).sort()).toEqual([...names].sort());
    const system = names.filter((name) => TASK_TENANCY[name] === "system");
    expect(system.sort()).toEqual([...SYSTEM_TASKS].sort());
  });
});

describe("envelope rollback safety", () => {
  const previousSchema = z.object({ traceId: z.string().uuid(), payload: z.unknown() });

  it("parses an envelope produced by the new enqueueJob under the previous schema", async () => {
    const client = fakeClient();
    await runInTenant(T, () => enqueueJob(client as never, "someTask", { a: 1 }));
    expect(previousSchema.safeParse(sentEnvelope(client)).success).toBe(true);
  });

  it("parses a legacy envelope under the new schema", () => {
    expect(queueJobEnvelopeSchema.safeParse({ traceId: TRACE_ID, payload: {} }).success).toBe(true);
  });
});
