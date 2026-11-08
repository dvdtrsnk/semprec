import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { readProposalRelationCatalog, readProposalWorkspaceContext } from "../inbox/proposalWorkspaceContext.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;

describe("bounded Inbox proposal workspace context", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("reads active built-in items within the tenant and event date window", async () => {
    const a = await createTestTenant(admin);
    const b = await createTestTenant(admin);
    const make = async (tenantId: string, name: string) =>
      runInTenant(tenantId, async () => {
        await seedSystem(runtime);
        const dbs = await runtime.query<{ id: string; owner_module_id: string }>(
          "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
          [["projects", "events", "healthRecords"]],
        );
        const id = (moduleId: string) => {
          const row = dbs.rows.find((entry) => entry.owner_module_id === moduleId);
          if (!row) throw new Error(`Missing ${moduleId}`);
          return row.id;
        };
        const writer = createChokePoint(runtime);
        const project = await writer.createItem({
          databaseId: id("projects"),
          properties: { name, status: "inProgress" },
        });
        const archived = await writer.createItem({
          databaseId: id("projects"),
          properties: { name: "Archived", status: "archived" },
        });
        const event = await writer.createItem({
          databaseId: id("events"),
          properties: { name: "Meeting", date: "2026-08-29" },
        });
        const firstDay = await writer.createItem({
          databaseId: id("events"),
          properties: { name: "First", date: "2026-08-27" },
        });
        const lastDay = await writer.createItem({
          databaseId: id("events"),
          properties: { name: "Last", date: "2026-09-11" },
        });
        const before = await writer.createItem({
          databaseId: id("events"),
          properties: { name: "Before", date: "2026-08-26" },
        });
        const after = await writer.createItem({
          databaseId: id("events"),
          properties: { name: "After", date: "2026-09-12" },
        });
        const outside = await writer.createItem({
          databaseId: id("events"),
          properties: { name: "Later", date: "2026-10-01" },
        });
        const health = await writer.createItem({ databaseId: id("healthRecords"), properties: { name: "Sensitive" } });
        return { project, archived, event, outside, health, firstDay, lastDay, before, after };
      });
    const local = await make(a, "A project");
    const foreign = await make(b, "B project");
    const context = await runInTenant(a, () =>
      withTransaction(runtime, (client) => readProposalWorkspaceContext(client, "2026-08-28")),
    );
    const ids = context.flatMap((group) => group.items.map((item) => item.id));
    expect(ids).toContain(local.project.id);
    expect(ids).toContain(local.event.id);
    expect(context.find((group) => group.moduleId === "events")?.items.map((item) => item.id)).toEqual([
      local.firstDay.id,
      local.event.id,
      local.lastDay.id,
    ]);
    for (const hidden of [
      local.archived.id,
      local.outside.id,
      local.health.id,
      local.before.id,
      local.after.id,
      foreign.project.id,
      foreign.event.id,
    ])
      expect(ids).not.toContain(hidden);
    expect(context.map((group) => group.moduleId)).not.toContain("healthRecords");
    const foreignRelations = await runInTenant(a, () =>
      withTransaction(runtime, (client) => readProposalRelationCatalog(client, foreign.project.databaseId)),
    );
    expect(foreignRelations).toEqual([]);
    const localRelations = await runInTenant(a, () =>
      withTransaction(runtime, (client) => readProposalRelationCatalog(client, local.project.databaseId)),
    );
    expect(localRelations.length).toBeGreaterThan(0);
    const noDate = await runInTenant(a, () =>
      withTransaction(runtime, (client) => readProposalWorkspaceContext(client, "invalid")),
    );
    expect(noDate.find((group) => group.moduleId === "events")?.items).toEqual([]);
  });

  it("bounds each context group and limits names without returning unrelated item properties", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      await seedSystem(runtime);
      const db = await runtime.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'people'");
      if (!db.rows[0]) throw new Error("Missing People database");
      const writer = createChokePoint(runtime);
      const ids: string[] = [];
      for (let n = 0; n < 23; n++) {
        const item = await writer.createItem({
          databaseId: db.rows[0].id,
          properties: { name: `Person ${n} ${"x".repeat(120)}` },
        });
        ids.push(item.id);
      }
      await runtime.query("UPDATE items SET updated_at = '2026-08-01T00:00:00Z' WHERE id = ANY($1::uuid[])", [ids]);
      await runtime.query("UPDATE items SET updated_at = '2026-08-02T00:00:00Z' WHERE id = $1", [ids[0]]);
      const context = await withTransaction(runtime, (client) => readProposalWorkspaceContext(client, "2026-08-28"));
      const people = context.find((group) => group.moduleId === "people");
      expect(people?.items).toHaveLength(20);
      expect(people?.items.every((item) => Object.keys(item).sort().join(",") === "id,name")).toBe(true);
      expect(people?.items.every((item) => item.name.length === 100 && ids.includes(item.id))).toBe(true);
      expect(people?.items.map((item) => item.id)).toEqual([ids[0], ...ids.slice(1).sort().slice(0, 19)]);
    });
  });

  it("orders equal-date events by ID within the original capture window", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      await seedSystem(runtime);
      const db = await runtime.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'events'");
      if (!db.rows[0]) throw new Error("Missing Events database");
      const writer = createChokePoint(runtime);
      const sameDate: string[] = [];
      for (let n = 0; n < 22; n++) {
        sameDate.push(
          (
            await writer.createItem({
              databaseId: db.rows[0].id,
              properties: { name: `Event ${n}`, date: "2026-08-29" },
            })
          ).id,
        );
      }
      const first = await writer.createItem({
        databaseId: db.rows[0].id,
        properties: { name: "Earlier", date: "2026-08-28" },
      });
      const outside = await writer.createItem({
        databaseId: db.rows[0].id,
        properties: { name: "Outside", date: "2026-09-30" },
      });
      const context = await withTransaction(runtime, (client) => readProposalWorkspaceContext(client, "2026-08-28"));
      const ids = context.find((group) => group.moduleId === "events")?.items.map((item) => item.id);
      expect(ids).toEqual([first.id, ...sameDate.sort().slice(0, 19)]);
      expect(ids).not.toContain(outside.id);
    });
  });
});
