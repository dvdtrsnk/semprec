import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { clearHooksForTests, registerItemCreateHook, type ItemCreateHook } from "../../chokePoint/hooks.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { defaultCalendarCreateHook, withChosenCalendar } from "../defaultCalendarCreateHook.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

/**
 * The hook next to another create hook that writes the calendar edge first (issue #1761). The create-hook
 * registry runs hooks in registration order and has no unregister, so each test starts from empty
 * registries and registers exactly the hooks of its scenario; no other production hook runs in this file.
 */
describe("default calendar create hook after an earlier calendar edge (issue #1761)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    clearHooksForTests();
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterAll(async () => {
    clearHooksForTests();
    await runtime.end();
    await admin.end();
  });

  /** The Events database, its `calendar` relation and the calendars the scenarios name, in the tenant in scope. */
  async function setup() {
    return withTransaction(runtime, async (client) => {
      const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
      const calendars = await databasesStore.getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
      if (!events || !calendars) throw new Error("Seeded tenant is missing a database");
      const property = await propertiesStore.getPropertyByKey(client, events.id, "calendar");
      const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
      if (!property || !definition) throw new Error("Missing Events.calendar");
      const { rows } = await client.query<{ id: string; isDefault: boolean; kind: string | null }>(
        `SELECT id, properties->'isDefault' = 'true'::jsonb AS "isDefault", properties->>'kind' AS kind FROM items
          WHERE database_id = $1 ORDER BY id`,
        [calendars.id],
      );
      const personal = rows.find((row) => row.isDefault)?.id;
      const other = rows.find((row) => !row.isDefault && row.kind === "own")?.id;
      const system = rows.find((row) => row.kind === "system")?.id;
      if (!personal || !other || !system) throw new Error("Expected the default, another own and a system calendar");
      return { eventsId: events.id, propertyId: property.id, definitionId: definition.id, personal, other, system };
    });
  }

  /** Creates an Event and returns the calendars it is linked to once its transaction has committed. */
  async function createEvent(f: Awaited<ReturnType<typeof setup>>): Promise<string[]> {
    const event = await withTransaction(runtime, (client) =>
      createItemWithClient(client, { databaseId: f.eventsId, properties: { name: "Planning" } }),
    );
    const edges = await withTransaction(runtime, (client) =>
      relationsStore.listRelationsForItem(client, f.definitionId, event.id),
    );
    return edges.map((edge) => relationsStore.otherSide(edge, event.id));
  }

  /** A create hook that links every new Event to `calendarId`, standing for a writer of the edge that runs first. */
  function linkTo(f: Awaited<ReturnType<typeof setup>>, calendarId: string): ItemCreateHook {
    return async ({ client, database, item }) => {
      if (database.id !== f.eventsId) return;
      await createRelationWithClient(client, {
        relationPropertyId: f.propertyId,
        callerItemId: item.id,
        targetItemId: calendarId,
      });
    };
  }

  it("keeps the calendar edge an earlier create hook wrote and adds no other", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      registerItemCreateHook(linkTo(f, f.other));
      registerItemCreateHook(defaultCalendarCreateHook);

      expect(await createEvent(f)).toEqual([f.other]);
    }));

  it("keeps that edge and does not check a chosen calendar the hook would refuse", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      registerItemCreateHook(linkTo(f, f.other));
      registerItemCreateHook(defaultCalendarCreateHook);

      expect(await withChosenCalendar(f.system, () => createEvent(f))).toEqual([f.other]);
    }));

  it("links the default calendar when no earlier hook wrote a calendar edge", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      registerItemCreateHook(defaultCalendarCreateHook);

      expect(await createEvent(f)).toEqual([f.personal]);
    }));
});
