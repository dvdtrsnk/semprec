import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { seedSystem } from "@semprec/data";
import { createRuntimeRolePool, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import { TenantScopeMissingError } from "@semprec/shared";
import { ModuleRegistry } from "@semprec/module-registry";
import { createApiQueueRuntime, type ApiQueueRuntime } from "../queueRuntime.js";

/**
 * The API queue runtime under the production default of tenant scope. `tenantScopeMode.ts` sets
 * `SEMPREC_TENANT_SCOPE=warn` for this file, which would hide a start-up call outside any scope, so each case
 * removes it and runs on a `semprec_data` runtime-role pool.
 */

const LEGACY_JOB_KEY = "legacy-key-strict-scope";

let adminPool: Pool;
let pool: Pool | undefined;
let runtime: ApiQueueRuntime | undefined;

async function legacyJobs(): Promise<{ task_identifier: string; key: string | null; attempts: number }[]> {
  const { rows } = await adminPool.query<{ task_identifier: string; key: string | null; attempts: number }>(
    "SELECT task_identifier, key, attempts FROM graphile_worker.jobs WHERE key = $1",
    [LEGACY_JOB_KEY],
  );
  return rows;
}

describe("createApiQueueRuntime under strict tenant scope (the production default)", () => {
  beforeEach(async () => {
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    await seedSystem(adminPool);
    await adminPool.query("TRUNCATE graphile_worker._private_known_crontabs");
    // `createApiActionRegistry` composes `core.agentGuidanceDrift` eagerly, which requires it.
    vi.stubEnv("AI_GATEWAY_INTERNAL_TOKEN", "test-internal-token");
    vi.stubEnv("SEMPREC_TENANT_SCOPE", undefined);
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      await runtime?.stop();
    } finally {
      runtime = undefined;
      await pool?.end();
      pool = undefined;
    }
  });

  it("refuses an unscoped enqueue, so the cases below do run under strict scope", async () => {
    expect(process.env.SEMPREC_TENANT_SCOPE).toBeUndefined();
    await expect(enqueueJob(adminPool, "heartbeatFire", { heartbeatId: "none" })).rejects.toBeInstanceOf(
      TenantScopeMissingError,
    );
  });

  it("starts and stops on a runtime-role pool with SEMPREC_TENANT_SCOPE unset", async () => {
    expect(process.env.SEMPREC_TENANT_SCOPE).toBeUndefined();
    if (!pool) throw new Error("the runtime-role pool was not created");

    runtime = await createApiQueueRuntime(pool, new ModuleRegistry(() => new Set()));

    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("starts with a legacy heartbeatFire job queued and leaves the job as it was", async () => {
    expect(process.env.SEMPREC_TENANT_SCOPE).toBeUndefined();
    if (!pool) throw new Error("the runtime-role pool was not created");
    await inTenantZero(() =>
      enqueueJob(
        adminPool,
        "heartbeatFire",
        { heartbeatId: "legacy-heartbeat", occurrenceId: "legacy-occurrence", generation: 0 },
        { jobKey: LEGACY_JOB_KEY, maxAttempts: 3 },
      ),
    );
    expect(await legacyJobs()).toEqual([{ task_identifier: "heartbeatFire", key: LEGACY_JOB_KEY, attempts: 0 }]);

    runtime = await createApiQueueRuntime(pool, new ModuleRegistry(() => new Set()));

    // The API start neither migrates the job under a split task name nor refuses it.
    expect(await legacyJobs()).toEqual([{ task_identifier: "heartbeatFire", key: LEGACY_JOB_KEY, attempts: 0 }]);
  });
});
