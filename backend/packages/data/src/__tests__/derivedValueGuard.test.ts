import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { assertRelationCreatableWithClient, createRelationWithClient } from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, tryLockRelationDefinition } from "../chokePoint/relationsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let data: Pool;
let tenant: string;
let foreign: string;
describe("derived value creation guard", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify relation role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(data));
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });
  async function fixture() {
    const cp = createChokePoint(data);
    const databases = await cp.listDatabases();
    const db = (owner: string) => {
      const found = databases.find((entry) => entry.ownerModuleId === owner);
      if (!found) throw new Error(`Missing ${owner}`);
      return found.id;
    };
    const property = async (owner: string, key: string) => {
      const found = (await cp.listProperties(db(owner))).find((entry) => entry.key === key);
      if (!found) throw new Error(`Missing ${owner}.${key}`);
      return found.id;
    };
    return { cp, db, property };
  }
  it("rejects each configured side with a live project and allows it without one", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
      const company = await cp.createItem({ databaseId: db("companies"), properties: { name: "Company" } });
      for (const [owner, field, projectKey] of [
        ["files", "area", "projects"],
        ["healthRecords", "area", "projects"],
        ["events", "area", "project"],
        ["events", "company", "project"],
        ["journal", "area", "project"],
      ] as const) {
        const ids =
          owner === "journal"
            ? [
                (await withTransaction(data, (client) => ensureJournalPeriodDoc(client, "day", "2026-01-01"))).itemId,
                (await withTransaction(data, (client) => ensureJournalPeriodDoc(client, "day", "2026-01-02"))).itemId,
              ]
            : [
                (await cp.createItem({ databaseId: db(owner), properties: { name: "With project" } })).id,
                (await cp.createItem({ databaseId: db(owner), properties: { name: "Without project" } })).id,
              ];
        await cp.createRelation({
          relationPropertyId: await property(owner, projectKey),
          callerItemId: ids[0]!,
          targetItemId: project.id,
        });
        const relationPropertyId = await property(owner, field);
        const targetItemId = field === "company" ? company.id : area.id;
        await expect(
          cp.createRelation({ relationPropertyId, callerItemId: ids[0]!, targetItemId }),
        ).rejects.toMatchObject({ status: 400, details: { field } });
        await expect(
          cp.createRelation({ relationPropertyId, callerItemId: ids[1]!, targetItemId }),
        ).resolves.toMatchObject({ relationDefinitionId: expect.any(String) });
      }
    });
  });
  it("retains and allows deletion of an older manual edge after project attachment", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
      const areaProperty = await property("files", "area");
      await cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id });
      await cp.createRelation({
        relationPropertyId: await property("files", "projects"),
        callerItemId: file.id,
        targetItemId: project.id,
      });
      expect((await cp.listItemRelations(file.id))?.some((edge) => edge.targetItemId === area.id)).toBe(true);
      const updated = await cp.updateRelation({
        relationPropertyId: areaProperty,
        callerItemId: file.id,
        targetItemId: area.id,
        metadata: { note: "retained" },
      });
      expect(updated.metadata).toEqual({ note: "retained" });
      await cp.deleteRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id });
      expect((await cp.listItemRelations(file.id))?.some((edge) => edge.targetItemId === area.id)).toBe(false);
      await cp.softDeleteItem(db("projects"), project.id);
      await expect(
        cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
      ).resolves.toBeDefined();
    });
  });
  it("refuses an inverse company edge and does not consult foreign items", async () => {
    let foreignEvent = "";
    await runInTenant(foreign, async () => {
      const { cp, db } = await fixture();
      foreignEvent = (await cp.createItem({ databaseId: db("events"), properties: { name: "Foreign" } })).id;
    });
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const event = await cp.createItem({ databaseId: db("events"), properties: { name: "Event" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const company = await cp.createItem({ databaseId: db("companies"), properties: { name: "Company" } });
      await cp.createRelation({
        relationPropertyId: await property("events", "project"),
        callerItemId: event.id,
        targetItemId: project.id,
      });
      const inverse = await property("companies", "meetings");
      await expect(
        cp.createRelation({ relationPropertyId: inverse, callerItemId: company.id, targetItemId: event.id }),
      ).rejects.toMatchObject({ status: 400, details: { field: "company" } });
      await expect(
        cp.createRelation({ relationPropertyId: inverse, callerItemId: company.id, targetItemId: foreignEvent }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
  it("rejects both guarded sides in the shared read-only assertion without reserving definitions", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const event = await cp.createItem({ databaseId: db("events"), properties: { name: "Event" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const company = await cp.createItem({ databaseId: db("companies"), properties: { name: "Company" } });
      const projectProperty = await property("events", "project");
      const companyProperty = await property("events", "company");
      const inverseProperty = await property("companies", "meetings");
      await cp.createRelation({
        relationPropertyId: projectProperty,
        callerItemId: event.id,
        targetItemId: project.id,
      });
      const before = await cp.listItemRelations(event.id);
      let release!: () => void;
      let ready!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const assertion = withTransaction(
        data,
        async (client) => {
          await expect(
            assertRelationCreatableWithClient(client, {
              relationPropertyId: companyProperty,
              callerItemId: event.id,
              targetItemId: company.id,
            }),
          ).rejects.toMatchObject({ status: 400, details: { field: "company" } });
          await expect(
            assertRelationCreatableWithClient(client, {
              relationPropertyId: inverseProperty,
              callerItemId: company.id,
              targetItemId: event.id,
            }),
          ).rejects.toMatchObject({ status: 400, details: { field: "company" } });
          ready();
          await barrier;
        },
        { isolation: "repeatable_read" },
      );
      try {
        await Promise.race([
          entered,
          assertion.then(() => {
            throw new Error("Assertion ended before its barrier");
          }),
        ]);
        await withTransaction(data, async (client) => {
          for (const id of [companyProperty, projectProperty]) {
            const definition = await getRelationDefinitionByPropertyId(client, id);
            if (!definition) throw new Error("Missing relation definition");
            expect(await tryLockRelationDefinition(client, definition.id)).toBe(true);
          }
        });
      } finally {
        release();
        await assertion;
      }
      expect(await cp.listItemRelations(event.id)).toEqual(before);
    });
  });
  it("refuses a changed set before removing its old edge while preserving no-op and delete", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const event = await cp.createItem({ databaseId: db("events"), properties: { name: "Event" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const first = await cp.createItem({ databaseId: db("areas"), properties: { name: "First" } });
      const second = await cp.createItem({ databaseId: db("areas"), properties: { name: "Second" } });
      const relationPropertyId = await property("events", "area");
      await cp.setRelation({ relationPropertyId, callerItemId: event.id, targetItemId: first.id });
      await cp.createRelation({
        relationPropertyId: await property("events", "project"),
        callerItemId: event.id,
        targetItemId: project.id,
      });
      await expect(
        cp.setRelation({ relationPropertyId, callerItemId: event.id, targetItemId: second.id }),
      ).rejects.toMatchObject({ status: 400, details: { field: "area" } });
      expect((await cp.listItemRelations(event.id))?.some((edge) => edge.targetItemId === first.id)).toBe(true);
      await expect(
        cp.setRelation({ relationPropertyId, callerItemId: event.id, targetItemId: first.id }),
      ).resolves.toBeDefined();
      await expect(
        cp.setRelation({ relationPropertyId, callerItemId: event.id, targetItemId: null }),
      ).resolves.toBeNull();
    });
  });
  it("marks a caught unsupported-isolation refusal rollback-only", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
      const relationPropertyId = await property("files", "area");
      let priorId = "";
      await expect(
        withTransaction(
          data,
          async (client) => {
            priorId = (
              await createItemWithClient(client, { databaseId: db("files"), properties: { name: "Rolled back" } })
            ).id;
            try {
              await createRelationWithClient(client, {
                relationPropertyId,
                callerItemId: file.id,
                targetItemId: area.id,
              });
            } catch (error) {
              expect(error).toMatchObject({ status: 409, details: { reason: "unsupported_isolation" } });
            }
          },
          { isolation: "repeatable_read" },
        ),
      ).rejects.toMatchObject({ details: { reason: "unsupported_isolation" } });
      expect(priorId).not.toBe("");
      expect(await cp.findItem(priorId)).toBeNull();
      expect((await cp.listItemRelations(file.id))?.some((edge) => edge.targetItemId === area.id)).toBe(false);
    });
  });
  it("reports busy while a real project insertion holds the definition and rejects after commit", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
      const unrelatedEvent = await cp.createItem({ databaseId: db("events"), properties: { name: "Unrelated" } });
      const unrelatedCompany = await cp.createItem({ databaseId: db("companies"), properties: { name: "Company" } });
      const projectProperty = await property("files", "projects");
      const areaProperty = await property("files", "area");
      const unrelatedProperty = await property("events", "company");
      let release!: () => void;
      let ready!: (pid: number) => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const holder = withTransaction(data, async (client) => {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await createRelationWithClient(client, {
          relationPropertyId: projectProperty,
          callerItemId: file.id,
          targetItemId: project.id,
        });
        ready(pid.rows[0]!.pid);
        await barrier;
      });
      try {
        expect(
          await Promise.race([
            entered,
            holder.then(() => {
              throw new Error("Holder ended before its barrier");
            }),
          ]),
        ).toBeGreaterThan(0);
        await expect(
          cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
        ).rejects.toMatchObject({ status: 409, details: { reason: "resource_busy" } });
        await expect(
          cp.createRelation({
            relationPropertyId: unrelatedProperty,
            callerItemId: unrelatedEvent.id,
            targetItemId: unrelatedCompany.id,
          }),
        ).resolves.toBeDefined();
        let priorId = "";
        await expect(
          withTransaction(data, async (client) => {
            priorId = (
              await createItemWithClient(client, { databaseId: db("files"), properties: { name: "Rollback on busy" } })
            ).id;
            try {
              await createRelationWithClient(client, {
                relationPropertyId: areaProperty,
                callerItemId: file.id,
                targetItemId: area.id,
              });
            } catch (error) {
              expect(error).toMatchObject({ details: { reason: "resource_busy" } });
            }
          }),
        ).rejects.toMatchObject({ details: { reason: "resource_busy" } });
        expect(priorId).not.toBe("");
        expect(await cp.findItem(priorId)).toBeNull();
      } finally {
        release();
        await holder;
      }
      await expect(
        cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
      ).rejects.toMatchObject({ status: 400, details: { field: "area" } });
    });
  });
  it("orders an inverse project insertion after a reserved manual edge", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
      const manual = await property("files", "area");
      const inverse = await property("projects", "files");
      let release!: () => void;
      let ready!: (pid: number) => void;
      let waiterReady!: (pid: number) => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const waiterEntered = new Promise<number>((resolve) => {
        waiterReady = resolve;
      });
      const holder = withTransaction(data, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await createRelationWithClient(client, {
          relationPropertyId: manual,
          callerItemId: file.id,
          targetItemId: area.id,
        });
        ready(pid);
        await barrier;
      });
      let waiter: Promise<unknown> | undefined;
      try {
        const holderPid = await Promise.race([
          entered,
          holder.then(() => {
            throw new Error("Holder ended before its barrier");
          }),
        ]);
        waiter = withTransaction(data, async (client) => {
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          waiterReady(pid);
          await createRelationWithClient(client, {
            relationPropertyId: inverse,
            callerItemId: project.id,
            targetItemId: file.id,
          });
        });
        const waiterPid = await Promise.race([
          waiterEntered,
          waiter.then(() => {
            throw new Error("Waiter ended before its barrier");
          }),
        ]);
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          const result = await data.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holderPid, waiterPid],
          );
          blocked = result.rows[0]?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
        await holder;
        if (waiter) await waiter;
      }
      const edges = await cp.listItemRelations(file.id);
      expect(edges?.some((edge) => edge.targetItemId === area.id)).toBe(true);
      expect(edges?.some((edge) => edge.targetItemId === project.id)).toBe(true);
    });
  });
  it("releases the project definition after rollback", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
      const projectProperty = await property("files", "projects");
      const areaProperty = await property("files", "area");
      let release!: () => void;
      let ready!: (pid: number) => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const rollback = new Error("intentional rollback");
      const holder = withTransaction(data, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await createRelationWithClient(client, {
          relationPropertyId: projectProperty,
          callerItemId: file.id,
          targetItemId: project.id,
        });
        ready(pid);
        await barrier;
        throw rollback;
      });
      const settled = holder.then(
        () => {
          throw new Error("Expected rollback");
        },
        (error: unknown) => error,
      );
      try {
        expect(
          await Promise.race([
            entered,
            settled.then(() => {
              throw new Error("Holder ended before barrier");
            }),
          ]),
        ).toBeGreaterThan(0);
        await expect(
          cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
        ).rejects.toMatchObject({ status: 409, details: { reason: "resource_busy" } });
      } finally {
        release();
        expect(await settled).toBe(rollback);
      }
      await expect(
        cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
      ).resolves.toBeDefined();
      expect((await cp.listItemRelations(file.id))?.some((edge) => edge.targetItemId === project.id)).toBe(false);
    });
  });
  it("orders actual project trash and restore against guarded creation", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
      const projectProperty = await property("files", "projects");
      const areaProperty = await property("files", "area");
      await cp.createRelation({ relationPropertyId: projectProperty, callerItemId: file.id, targetItemId: project.id });
      let releaseTrash!: () => void;
      let trashReady!: (pid: number) => void;
      const trashGate = new Promise<void>((resolve) => {
        releaseTrash = resolve;
      });
      const trashEntered = new Promise<number>((resolve) => {
        trashReady = resolve;
      });
      const trash = withTransaction(data, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        expect(
          await itemDeleteWithClient(client, db("projects"), project.id, {
            queueAffinity: createActionQueueAffinity(),
          }),
        ).toBeDefined();
        trashReady(pid);
        await trashGate;
      });
      try {
        expect(
          await Promise.race([
            trashEntered,
            trash.then(() => {
              throw new Error("Trash ended before barrier");
            }),
          ]),
        ).toBeGreaterThan(0);
        await expect(
          cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
        ).rejects.toMatchObject({ status: 409, details: { reason: "resource_busy" } });
      } finally {
        releaseTrash();
        await trash;
      }
      let releaseManual!: () => void;
      let manualReady!: (pid: number) => void;
      const manualGate = new Promise<void>((resolve) => {
        releaseManual = resolve;
      });
      const manualEntered = new Promise<number>((resolve) => {
        manualReady = resolve;
      });
      const manual = withTransaction(data, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await createRelationWithClient(client, {
          relationPropertyId: areaProperty,
          callerItemId: file.id,
          targetItemId: area.id,
        });
        manualReady(pid);
        await manualGate;
      });
      let restore: Promise<unknown> | undefined;
      try {
        const holderPid = await Promise.race([
          manualEntered,
          manual.then(() => {
            throw new Error("Manual ended before barrier");
          }),
        ]);
        let restoredPid!: (pid: number) => void;
        let rejectRestorePid!: (error: unknown) => void;
        const restoreEntered = new Promise<number>((resolve, reject) => {
          restoredPid = resolve;
          rejectRestorePid = reject;
        });
        data.once("acquire", (client: import("pg").PoolClient) => {
          void client
            .query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
            .then((result) => restoredPid(result.rows[0]!.pid), rejectRestorePid);
        });
        restore = cp.restoreItem(db("projects"), project.id);
        const waiterPid = await Promise.race([
          restoreEntered,
          restore.then(() => {
            throw new Error("Restore ended before barrier");
          }),
        ]);
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          const result = await data.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holderPid, waiterPid],
          );
          blocked = result.rows[0]?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
      } finally {
        releaseManual();
        await manual;
        if (restore) await restore;
      }
      expect((await cp.listItemRelations(file.id))?.some((edge) => edge.targetItemId === area.id)).toBe(true);
      await expect(
        cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
      ).rejects.toMatchObject({ status: 400, details: { field: "area" } });
    });
  });
});
