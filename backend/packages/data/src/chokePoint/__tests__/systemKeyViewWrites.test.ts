import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint.js";
import { getDatabaseByModuleId } from "../databasesStore.js";
import { createViewTypeRegistry } from "../viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { ForbiddenError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { PROJECTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { TASKS_TODAY_VIEW_KEY } from "../../tasks/todayView.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { ViewRow } from "../../types.js";
import type { Actor } from "../authorization.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let tasksId: string;
let agent: Actor;
const SYSTEM: Actor = { type: "system" };

beforeAll(async () => {
  admin = getTestPool();
  await resetDatabase(admin);
  pool = await createRuntimeRolePool(admin, "semprec_data");
  cp = createChokePoint(pool);
  tenant = await createTestTenant(admin);
  await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  const databases = await runInTenant(tenant, () =>
    withTransaction(pool, async (client) => ({
      tasks: await getDatabaseByModuleId(client, TASKS_MODULE_ID),
      projects: await getDatabaseByModuleId(client, PROJECTS_MODULE_ID),
    })),
  );
  if (!databases.tasks || !databases.projects) throw new Error("Tasks or Projects not seeded");
  tasksId = databases.tasks.id;
  const project = await runInTenant(tenant, () =>
    cp.createItem({ databaseId: databases.projects!.id, properties: { name: "Agent project" } }),
  );
  agent = { type: "ai_agent", agentProjectItemId: project.id };
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

async function todayView(): Promise<ViewRow> {
  const views = await runInTenant(tenant, () => cp.listViewsByDatabase(tasksId));
  const found = views.filter((view) => view.config.systemKey === TASKS_TODAY_VIEW_KEY);
  if (found.length !== 1 || !found[0]) throw new Error(`Expected one Today view, found ${found.length}`);
  return found[0];
}

async function refusal(write: () => Promise<unknown>): Promise<ForbiddenError> {
  try {
    await write();
  } catch (err) {
    if (err instanceof ForbiddenError) return err;
    throw err;
  }
  throw new Error("expected the write to be refused");
}

describe("writes to a view with a systemKey (issue #1798)", () => {
  for (const [name, actor] of [["user", { type: "user" } as Actor] as const, ["ai_agent", undefined] as const]) {
    describe(`as the ${name} actor`, () => {
      const who = (): Actor => actor ?? agent;

      it("refuses a patch with 403 system_owned and leaves the view as it was", async () => {
        const before = await todayView();
        const error = await refusal(() =>
          runInTenant(tenant, () =>
            cp.patchView({ id: before.id, actor: who(), name: "Renamed", config: { sort: [] } }),
          ),
        );
        expect(error.status).toBe(403);
        expect(error.details).toMatchObject({ viewId: before.id, reason: "system_owned" });
        expect(await todayView()).toEqual(before);
      });

      it("refuses a delete with 403 system_owned and keeps the view", async () => {
        const before = await todayView();
        const error = await refusal(() => runInTenant(tenant, () => cp.deleteView({ id: before.id, actor: who() })));
        expect(error.status).toBe(403);
        expect(error.details).toMatchObject({ viewId: before.id, reason: "system_owned" });
        expect(await todayView()).toEqual(before);
      });
    });
  }

  it("still lets a user patch and delete a view of the same database that has no systemKey", async () => {
    const own = await runInTenant(tenant, () => cp.createView({ databaseId: tasksId, type: "table", name: "Own" }));
    const patched = await runInTenant(tenant, () =>
      cp.patchView({ id: own.id, actor: { type: "user" }, name: "Renamed" }),
    );
    expect(patched.name).toBe("Renamed");
    await runInTenant(tenant, () => cp.deleteView({ id: own.id, actor: { type: "user" } }));
    expect(await runInTenant(tenant, () => cp.getView(own.id))).toBeNull();
  });

  it("refuses every actor a write to a view the system created with another key", async () => {
    const keyed = await runInTenant(tenant, () =>
      cp.createView({ databaseId: tasksId, type: "table", name: "Keyed", config: { systemKey: "keyed" } }, SYSTEM),
    );
    for (const actor of [{ type: "user" } as Actor, agent, SYSTEM]) {
      const error = await refusal(() => runInTenant(tenant, () => cp.deleteView({ id: keyed.id, actor })));
      expect(error.details).toMatchObject({ viewId: keyed.id, reason: "system_owned" });
    }
    expect(await runInTenant(tenant, () => cp.getView(keyed.id))).not.toBeNull();
  });

  describe("the system key is written by the system alone", () => {
    const reserved = { field: "config.systemKey", reason: "system_key_reserved" };

    for (const [name, actor] of [["user", { type: "user" } as Actor] as const, ["ai_agent", undefined] as const]) {
      describe(`as the ${name} actor`, () => {
        const who = (): Actor => actor ?? agent;

        it("refuses a create whose config carries a systemKey and stores no view", async () => {
          const before = await runInTenant(tenant, () => cp.listViewsByDatabase(tasksId));
          for (const config of [{ systemKey: "x" }, { systemKey: TASKS_TODAY_VIEW_KEY }]) {
            const error = await refusal(() =>
              runInTenant(tenant, () =>
                cp.createView({ databaseId: tasksId, type: "table", name: "Forged", config }, who()),
              ),
            );
            expect(error.status).toBe(403);
            expect(error.code).toBe("owner_violation");
            expect(error.details).toEqual(reserved);
          }
          expect(await runInTenant(tenant, () => cp.listViewsByDatabase(tasksId))).toEqual(before);
        });

        it("refuses a patch that sets a systemKey on its own view and leaves the view editable", async () => {
          const own = await runInTenant(tenant, () =>
            cp.createView({ databaseId: tasksId, type: "table", name: `Own ${name}` }, who()),
          );
          const error = await refusal(() =>
            runInTenant(tenant, () => cp.patchView({ id: own.id, actor: who(), config: { systemKey: "x" } })),
          );
          expect(error.status).toBe(403);
          expect(error.details).toEqual(reserved);
          const after = await runInTenant(tenant, () => cp.getView(own.id));
          expect(after?.config).toEqual(own.config);
          const renamed = await runInTenant(tenant, () =>
            cp.patchView({ id: own.id, actor: who(), name: "Still mine" }),
          );
          expect(renamed.name).toBe("Still mine");
          await runInTenant(tenant, () => cp.deleteView({ id: own.id, actor: who() }));
        });
      });
    }

    it("lets the system actor create a view with a systemKey", async () => {
      const created = await runInTenant(tenant, () =>
        cp.createView(
          { databaseId: tasksId, type: "table", name: "System keyed", config: { systemKey: "sys" } },
          SYSTEM,
        ),
      );
      expect(created.config.systemKey).toBe("sys");
      expect(created.createdBy).toBe("system");
    });
  });
});
