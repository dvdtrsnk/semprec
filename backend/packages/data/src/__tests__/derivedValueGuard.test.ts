import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES } from "@semprec/queue";
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
import { enqueueItemSearchReindex } from "../search/itemSearchFanout.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let data: Pool;
let tenant: string;
let foreign: string;
async function waitForBarrier<T>(signal: Promise<T>, actor: Promise<unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      actor.then(() => {
        throw new Error("Participant ended before barrier");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Barrier timed out")), 4000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function withReleasedGate(
  run: () => Promise<void>,
  release: () => void,
  actors: () => Promise<unknown>[],
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await run();
  } catch (error) {
    failures.push(error);
  }
  try {
    release();
  } catch (error) {
    failures.push(error);
  }
  const outcomes = await Promise.allSettled(actors());
  for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Relation test and settlement failed");
}
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
        expect((await cp.listItemRelations(ids[0]!))?.some((edge) => edge.targetItemId === targetItemId)).toBe(false);
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
      foreignEvent = (
        await cp.createItem({ databaseId: db("events"), properties: { name: "Foreign", date: "2026-10-16" } })
      ).id;
    });
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const event = await cp.createItem({
        databaseId: db("events"),
        properties: { name: "Event", date: "2026-10-16" },
      });
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
      const event = await cp.createItem({
        databaseId: db("events"),
        properties: { name: "Event", date: "2026-10-16" },
      });
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
      await withReleasedGate(
        async () => {
          await waitForBarrier(entered, assertion);
          await withTransaction(data, async (client) => {
            for (const id of [companyProperty, projectProperty]) {
              const definition = await getRelationDefinitionByPropertyId(client, id);
              if (!definition) throw new Error("Missing relation definition");
              expect(await tryLockRelationDefinition(client, definition.id)).toBe(true);
            }
          });
        },
        release,
        () => [assertion],
      );
      expect(await cp.listItemRelations(event.id)).toEqual(before);
    });
  });
  it("refuses a changed set before removing its old edge while preserving no-op and delete", async () => {
    await runInTenant(tenant, async () => {
      const { cp, db, property } = await fixture();
      const event = await cp.createItem({
        databaseId: db("events"),
        properties: { name: "Event", date: "2026-10-16" },
      });
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
  /*
   * The edge writes below queue issue #1652's search reindex jobs, which are added at each transaction's
   * pre-commit flush (R1 D1): the holder's edge holds no queue row while it waits at the barrier, whether or not
   * an earlier search enqueue of this tenant committed first ("warm") or none did ("cold").
   */
  it.each(["cold", "warm"] as const)(
    "reports busy while a real project insertion holds the definition and rejects after commit (%s search enqueue)",
    async (start) => {
      await runInTenant(tenant, async () => {
        const { cp, db, property } = await fixture();
        const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
        const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
        const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
        const unrelatedEvent = await cp.createItem({
          databaseId: db("events"),
          properties: { name: "Unrelated", date: "2026-10-16" },
        });
        const unrelatedCompany = await cp.createItem({ databaseId: db("companies"), properties: { name: "Company" } });
        const projectProperty = await property("files", "projects");
        const areaProperty = await property("files", "area");
        const unrelatedProperty = await property("events", "company");
        if (start === "warm")
          await withTransaction(data, (client) => enqueueItemSearchReindex(client, { kind: "item", itemId: area.id }));
        let rolledBack = "";
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
        await withReleasedGate(
          async () => {
            expect(await waitForBarrier(entered, holder)).toBeGreaterThan(0);
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
                  await createItemWithClient(client, {
                    databaseId: db("files"),
                    properties: { name: "Rollback on busy" },
                  })
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
            rolledBack = priorId;
          },
          release,
          () => [holder],
        );
        await expect(
          cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
        ).rejects.toMatchObject({ status: 400, details: { field: "area" } });
        // Exactly the committed edges' documents are queued: the holder's file and project, the unrelated
        // event and company, the warm-up's area; nothing for the rolled-back item or the refused edges.
        expect(rolledBack).not.toBe("");
        const scenario = [file.id, project.id, area.id, unrelatedEvent.id, unrelatedCompany.id, rolledBack];
        const { rows } = await admin.query<{ key: string | null }>(
          "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
          [CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS],
        );
        const queued = rows.flatMap((row) =>
          row.key !== null && scenario.some((id) => row.key?.endsWith(id)) ? [row.key] : [],
        );
        const expected = [
          file.id,
          project.id,
          unrelatedEvent.id,
          unrelatedCompany.id,
          ...(start === "warm" ? [area.id] : []),
        ];
        expect(queued).toEqual(expected.map((id) => `item-search-reindex:item:${id}`).sort());
      });
    },
  );
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
      await withReleasedGate(
        async () => {
          const holderPid = await waitForBarrier(entered, holder);
          waiter = withTransaction(data, async (client) => {
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
            waiterReady(pid);
            await createRelationWithClient(client, {
              relationPropertyId: inverse,
              callerItemId: project.id,
              targetItemId: file.id,
            });
          });
          const waiterPid = await waitForBarrier(waiterEntered, waiter);
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
        },
        release,
        () => [holder, ...(waiter ? [waiter] : [])],
      );
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
      await withReleasedGate(
        async () => {
          expect(await waitForBarrier(entered, settled)).toBeGreaterThan(0);
          await expect(
            cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
          ).rejects.toMatchObject({ status: 409, details: { reason: "resource_busy" } });
        },
        release,
        () => [
          settled.then((result) => {
            expect(result).toBe(rollback);
          }),
        ],
      );
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
      await withReleasedGate(
        async () => {
          expect(await waitForBarrier(trashEntered, trash)).toBeGreaterThan(0);
          await expect(
            cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
          ).rejects.toMatchObject({ status: 409, details: { reason: "resource_busy" } });
          let priorId = "";
          let refusal: unknown;
          let finalError: unknown;
          try {
            await withTransaction(data, async (client) => {
              priorId = (
                await createItemWithClient(client, {
                  databaseId: db("files"),
                  properties: { name: "Rollback after savepoint" },
                })
              ).id;
              await client.query("SAVEPOINT lock_probe");
              try {
                await client.query(
                  "SELECT id FROM items WHERE tenant_id = app_tenant_default() AND id = $1 FOR UPDATE NOWAIT",
                  [project.id],
                );
                throw new Error("Expected project row lock conflict");
              } catch (error) {
                expect(error).toBeInstanceOf(DatabaseError);
                if (!(error instanceof DatabaseError)) throw error;
                expect(error.code).toBe("55P03");
              }
              await client.query("ROLLBACK TO SAVEPOINT lock_probe");
              await client.query("SAVEPOINT admission");
              try {
                await createRelationWithClient(client, {
                  relationPropertyId: areaProperty,
                  callerItemId: file.id,
                  targetItemId: area.id,
                });
              } catch (error) {
                refusal = error;
              }
              expect(refusal).toMatchObject({ status: 409, details: { reason: "resource_busy" } });
              await client.query("ROLLBACK TO SAVEPOINT admission");
            });
          } catch (error) {
            finalError = error;
          }
          expect(refusal).toBeDefined();
          expect(finalError).toBe(refusal);
          expect(priorId).not.toBe("");
          expect(await cp.findItem(priorId)).toBeNull();
        },
        releaseTrash,
        () => [trash],
      );
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
      let observeRestore: ((client: PoolClient) => void) | undefined;
      await withReleasedGate(
        async () => {
          const holderPid = await waitForBarrier(manualEntered, manual);
          let restoredPid!: (pid: number) => void;
          let rejectRestorePid!: (error: unknown) => void;
          const restoreEntered = new Promise<number>((resolve, reject) => {
            restoredPid = resolve;
            rejectRestorePid = reject;
          });
          observeRestore = (client: PoolClient) => {
            void client
              .query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
              .then((result) => restoredPid(result.rows[0]!.pid), rejectRestorePid);
          };
          data.once("acquire", observeRestore);
          restore = cp.restoreItem(db("projects"), project.id);
          const waiterPid = await waitForBarrier(restoreEntered, restore);
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
        },
        () => {
          if (observeRestore) data.off("acquire", observeRestore);
          releaseManual();
        },
        () => [manual, ...(restore ? [restore] : [])],
      );
      expect((await cp.listItemRelations(file.id))?.some((edge) => edge.targetItemId === area.id)).toBe(true);
      await expect(
        cp.createRelation({ relationPropertyId: areaProperty, callerItemId: file.id, targetItemId: area.id }),
      ).rejects.toMatchObject({ status: 400, details: { field: "area" } });
    });
  });
});
