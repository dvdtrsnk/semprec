import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { SLEEP_SETTINGS_MODULE_ID } from "../../seed/sleepModuleKeys.js";

/**
 * Switches off `showInCalendar` of the seeded sleep settings item of `tenantId`, through the choke point. A
 * seeded tenant shows sleep in the calendar (issue #1806), so every timeline read returns its nights. The tests
 * of the other timeline sources call this to keep to the entries they are about; the sleep source has its own
 * tests.
 */
export async function hideSleepInCalendar(pool: Pool, tenantId: string): Promise<void> {
  const chokePoint = createChokePoint(pool);
  await runInTenant(tenantId, async () => {
    const database = (await chokePoint.listDatabases()).find(
      (candidate) => candidate.ownerModuleId === SLEEP_SETTINGS_MODULE_ID,
    );
    if (!database) throw new Error("No sleep settings database");
    const [settings] = (await chokePoint.listItems(database.id, { limit: 5 })).items;
    if (!settings) throw new Error("No sleep settings item");
    await chokePoint.updateItem(
      { databaseId: database.id, itemId: settings.id, propertiesPatch: { showInCalendar: false } },
      undefined,
      undefined,
      { writerKind: "user" },
    );
  });
}
