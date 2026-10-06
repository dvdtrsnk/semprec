import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { DEFAULT_COMPACTION_THRESHOLD, handleDocCompactionSweepTask } from "../docs/docPersistence.js";
import { handleDocHistoryCleanupTask } from "../docs/docHistory.js";
import { logger } from "../tenancy/logger.js";
import { logger as docsLogger } from "../docs/logger.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;

/** `count` valid Yjs updates, each one inserting a character. */
function validUpdates(count: number): Buffer[] {
  const doc = new Y.Doc();
  const updates: Buffer[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(Buffer.from(u)));
  for (let i = 0; i < count; i++) doc.getText("t").insert(0, "x");
  return updates;
}

/** Inserts a doc with the given update rows into `tenantId`; returns the doc id. */
async function seedDocWithUpdates(tenantId: string, updates: Buffer[]): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("INSERT INTO docs (item_id) VALUES ($1) RETURNING id", [
      randomUUID(),
    ]);
    const docId = rows[0]!.id;
    for (const update of updates) {
      await pool.query("INSERT INTO doc_updates (doc_id, update, created_by) VALUES ($1, $2, 'user')", [docId, update]);
    }
    return docId;
  });
}

async function countUpdates(tenantId: string, docId: string): Promise<number> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM doc_updates WHERE doc_id = $1", [
      docId,
    ]);
    return Number(rows[0]!.n);
  });
}

async function tenantsOf(table: "doc_snapshots" | "doc_snapshot_history", docId: string): Promise<string[]> {
  const { rows } = await adminPool.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table} WHERE doc_id = $1`, [
    docId,
  ]);
  return rows.map((r) => r.tenant_id);
}

describe("doc sweeps run per tenant (issue #985)", () => {
  let tenantZero: string;
  let tenantB: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(docsLogger, "error").mockImplementation(() => {});
  });

  it("compacts each tenant's over-threshold doc and stamps its rows with that tenant", async () => {
    const docZero = await seedDocWithUpdates(tenantZero, validUpdates(DEFAULT_COMPACTION_THRESHOLD));
    const docB = await seedDocWithUpdates(tenantB, validUpdates(DEFAULT_COMPACTION_THRESHOLD));

    await runAsSystem("test", () => handleDocCompactionSweepTask(pool));

    expect(await countUpdates(tenantZero, docZero)).toBeLessThan(DEFAULT_COMPACTION_THRESHOLD);
    expect(await countUpdates(tenantB, docB)).toBeLessThan(DEFAULT_COMPACTION_THRESHOLD);
    expect(await tenantsOf("doc_snapshots", docZero)).toEqual([tenantZero]);
    expect(await tenantsOf("doc_snapshot_history", docZero)).toEqual([tenantZero]);
    expect(await tenantsOf("doc_snapshots", docB)).toEqual([tenantB]);
    expect(await tenantsOf("doc_snapshot_history", docB)).toEqual([tenantB]);
  });

  it("commits tenant zero's compaction and rejects when every doc of tenant B fails", async () => {
    const docZero = await seedDocWithUpdates(tenantZero, validUpdates(DEFAULT_COMPACTION_THRESHOLD));
    const corrupt = Array.from({ length: DEFAULT_COMPACTION_THRESHOLD }, () => Buffer.from([0x00, 0xff]));
    const docB = await seedDocWithUpdates(tenantB, corrupt);

    const err: unknown = await runAsSystem("test", () => handleDocCompactionSweepTask(pool)).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AggregateError);
    const errors = (err as AggregateError).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("docCompactionSweep: all 1 attempted doc(s) failed"),
      }),
    );
    expect(await countUpdates(tenantZero, docZero)).toBeLessThan(DEFAULT_COMPACTION_THRESHOLD);
    expect(await tenantsOf("doc_snapshot_history", docZero)).toEqual([tenantZero]);
    expect(await countUpdates(tenantB, docB)).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it("does not compact the docs of a suspended tenant", async () => {
    const suspended = await createTestTenant(adminPool, { status: "suspended" });
    const docSuspended = await seedDocWithUpdates(suspended, validUpdates(DEFAULT_COMPACTION_THRESHOLD));

    await runAsSystem("test", () => handleDocCompactionSweepTask(pool));

    expect(await countUpdates(suspended, docSuspended)).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(await tenantsOf("doc_snapshot_history", docSuspended)).toEqual([]);
  });

  it("cleans expired checkpoints per tenant, keeps baselines and stamps re-baselines with the doc's tenant", async () => {
    const seedHistory = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const { rows } = await pool.query<{ id: string }>(
          "INSERT INTO docs (item_id, history_available_from) VALUES ($1, now() - interval '400 days') RETURNING id",
          [randomUUID()],
        );
        const docId = rows[0]!.id;
        const state = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
        await pool.query(
          `INSERT INTO doc_snapshot_history (doc_id, state, through_update_id, represented_at, expires_at, created_by)
           VALUES ($1, $2, 0, now() - interval '399 days', NULL, 'system'),
                  ($1, $2, 0, now() - interval '1 day', now() - interval '1 hour', 'system')`,
          [docId, state],
        );
        return docId;
      });
    const docZero = await seedHistory(tenantZero);
    const docB = await seedHistory(tenantB);

    await runAsSystem("test", () => handleDocHistoryCleanupTask(pool));

    for (const [tenantId, docId] of [
      [tenantZero, docZero],
      [tenantB, docB],
    ] as const) {
      const { rows } = await adminPool.query<{ tenant_id: string; expires_at: Date | null; represented_at: Date }>(
        "SELECT tenant_id, expires_at, represented_at FROM doc_snapshot_history WHERE doc_id = $1",
        [docId],
      );
      // The expired checkpoint is gone; the only row left is the freshly written NULL-expiry baseline.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.expires_at).toBeNull();
      expect(rows[0]!.tenant_id).toBe(tenantId);
      expect(rows[0]!.represented_at.getTime()).toBeGreaterThan(Date.now() - 399 * 24 * 3600 * 1000);
    }
  });
});
