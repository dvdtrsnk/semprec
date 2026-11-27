import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { readProposalRelationCatalog, readProposalWorkspaceContext } from "../inbox/proposalWorkspaceContext.js";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

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
    const projectItemId = await runInTenant(a, () => createTestProjectItem(runtime));
    const read = (captureDate: unknown) =>
      runInTenant(a, () =>
        withTransaction(runtime, (client) =>
          readProposalWorkspaceContext(client, { projectItemId, captureDate, limitPerKind: 20 }),
        ),
      );
    const context = await read("2026-08-28");
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
    const noDate = await read("invalid");
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
      const projectItemId = await createTestProjectItem(runtime);
      const context = await withTransaction(runtime, (client) =>
        readProposalWorkspaceContext(client, { projectItemId, captureDate: "2026-08-28", limitPerKind: 20 }),
      );
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
      const projectItemId = await createTestProjectItem(runtime);
      const context = await withTransaction(runtime, (client) =>
        readProposalWorkspaceContext(client, { projectItemId, captureDate: "2026-08-28", limitPerKind: 20 }),
      );
      const ids = context.find((group) => group.moduleId === "events")?.items.map((item) => item.id);
      expect(ids).toEqual([first.id, ...sameDate.sort().slice(0, 19)]);
      expect(ids).not.toContain(outside.id);
    });
  });

  describe("values per kind and grants (issue gh-1987)", () => {
    interface Fixture {
      tenant: string;
      projectItemId: string;
      databaseIds: Record<string, string>;
      writer: ReturnType<typeof createChokePoint>;
    }

    async function setup(): Promise<Fixture> {
      const tenant = await createTestTenant(admin);
      return runInTenant(tenant, async () => {
        await seedSystem(runtime);
        const dbs = await runtime.query<{ id: string; owner_module_id: string }>(
          "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
          [["projects", "people", "companies", "events", "healthRecords"]],
        );
        const databaseIds = Object.fromEntries(dbs.rows.map((row) => [row.owner_module_id, row.id]));
        return {
          tenant,
          projectItemId: await createTestProjectItem(runtime),
          databaseIds,
          writer: createChokePoint(runtime),
        };
      });
    }

    function readContext(fixture: Fixture, limitPerKind = 20, projectItemId = fixture.projectItemId) {
      return runInTenant(fixture.tenant, () =>
        withTransaction(runtime, async (client) => {
          await client.query("SET TRANSACTION READ ONLY");
          return readProposalWorkspaceContext(client, { projectItemId, captureDate: "2026-08-28", limitPerKind });
        }),
      );
    }

    /** The API cannot mark a built-in database sensitive, so the test does it directly. */
    async function markSensitive(databaseId: string): Promise<void> {
      await admin.query("UPDATE databases SET sensitive = true WHERE id = $1", [databaseId]);
    }

    async function grant(fixture: Fixture, projectItemId: string, databaseId: string, access: "read" | "write") {
      await runInTenant(fixture.tenant, () =>
        withTransaction(runtime, (client) => setAgentDatabaseGrant(client, { projectItemId, databaseId, access })),
      );
    }

    it("carries status of a project, relationship of a person, registration number of a company, type and date of an event", async () => {
      const f = await setup();
      const created = await runInTenant(f.tenant, async () => {
        const longTerm = await f.writer.createItem({
          databaseId: f.databaseIds.projects!,
          properties: { name: "Flat", status: "longTerm" },
        });
        const inProgress = await f.writer.createItem({
          databaseId: f.databaseIds.projects!,
          properties: { name: "Loose", status: "inProgress" },
        });
        const person = await f.writer.createItem({
          databaseId: f.databaseIds.people!,
          properties: { name: "Anna", relationship: "client" },
        });
        const plainPerson = await f.writer.createItem({
          databaseId: f.databaseIds.people!,
          properties: { name: "Bob" },
        });
        const company = await f.writer.createItem({
          databaseId: f.databaseIds.companies!,
          properties: { name: "Acme", ico: "27419363" },
        });
        const event = await f.writer.createItem({
          databaseId: f.databaseIds.events!,
          properties: { name: "Review", type: "meeting", date: "2026-08-30" },
        });
        const longName = await f.writer.createItem({
          databaseId: f.databaseIds.people!,
          properties: { name: "n".repeat(130) },
        });
        return { longTerm, inProgress, person, plainPerson, company, event, longName };
      });
      const context = await readContext(f);
      const byModule = (moduleId: string) => context.find((group) => group.moduleId === moduleId)?.items ?? [];
      expect(context.map((group) => group.moduleId)).not.toContain("areas");
      const projects = byModule("projects");
      expect(projects).toHaveLength(2);
      expect(projects).toContainEqual({ id: created.longTerm.id, name: "Flat", status: "longTerm" });
      expect(projects).toContainEqual({ id: created.inProgress.id, name: "Loose", status: "inProgress" });
      expect(byModule("people")).toContainEqual({ id: created.person.id, name: "Anna", relationship: "client" });
      expect(byModule("people")).toContainEqual({ id: created.plainPerson.id, name: "Bob" });
      expect(byModule("people")).toContainEqual({ id: created.longName.id, name: "n".repeat(100) });
      expect(byModule("companies")).toEqual([{ id: created.company.id, name: "Acme", registrationNumber: "27419363" }]);
      expect(byModule("events")).toEqual([
        { id: created.event.id, name: "Review", type: "meeting", date: "2026-08-30" },
      ]);
    });

    it("lists at most limitPerKind entries per kind, newest update first, and refuses a limit that is no positive integer", async () => {
      const f = await setup();
      const ids = await runInTenant(f.tenant, async () => {
        const created: string[] = [];
        for (let n = 0; n < 5; n++) {
          created.push(
            (await f.writer.createItem({ databaseId: f.databaseIds.people!, properties: { name: `Person ${n}` } })).id,
          );
        }
        for (const [index, id] of created.entries())
          await admin.query("UPDATE items SET updated_at = $2 WHERE id = $1", [id, `2026-08-0${index + 1}T00:00:00Z`]);
        return created;
      });
      const people = (await readContext(f, 3)).find((group) => group.moduleId === "people");
      expect(people?.items.map((item) => item.id)).toEqual([ids[4], ids[3], ids[2]]);
      await expect(readContext(f, 0)).rejects.toThrow(RangeError);
      await expect(readContext(f, 1.5)).rejects.toThrow(RangeError);
    });

    it("leaves a sensitive built-in database out entirely without a grant for the project and lists it with a read grant for that project only", async () => {
      const f = await setup();
      const otherProject = await runInTenant(f.tenant, () => createTestProjectItem(runtime));
      const company = await runInTenant(f.tenant, () =>
        f.writer.createItem({ databaseId: f.databaseIds.companies!, properties: { name: "Clinic s.r.o." } }),
      );
      const person = await runInTenant(f.tenant, () =>
        f.writer.createItem({ databaseId: f.databaseIds.people!, properties: { name: "Anna" } }),
      );
      await markSensitive(f.databaseIds.companies!);

      const closed = await readContext(f);
      expect(closed.map((group) => group.moduleId)).not.toContain("companies");
      expect(JSON.stringify(closed)).not.toContain(company.id);
      expect(closed.find((group) => group.moduleId === "people")?.items.map((item) => item.id)).toEqual([person.id]);

      await grant(f, otherProject, f.databaseIds.companies!, "read");
      expect((await readContext(f)).map((group) => group.moduleId)).not.toContain("companies");
      expect((await readContext(f, 20, otherProject)).find((group) => group.moduleId === "companies")?.items).toEqual([
        { id: company.id, name: "Clinic s.r.o." },
      ]);

      await grant(f, f.projectItemId, f.databaseIds.companies!, "read");
      const opened = await readContext(f);
      expect(opened.find((group) => group.moduleId === "companies")?.items.map((item) => item.id)).toEqual([
        company.id,
      ]);
    });

    it("never lists a Health record, with a grant for the Health database as well", async () => {
      const f = await setup();
      const health = await runInTenant(f.tenant, () =>
        f.writer.createItem({ databaseId: f.databaseIds.healthRecords!, properties: { name: "Blood test" } }),
      );
      expect(JSON.stringify(await readContext(f))).not.toContain(health.id);
      await grant(f, f.projectItemId, f.databaseIds.healthRecords!, "read");
      const context = await readContext(f);
      expect(JSON.stringify(context)).not.toContain(health.id);
      expect(context.map((group) => group.moduleId)).not.toContain("healthRecords");
    });
  });
});
