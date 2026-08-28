import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { DRIFT_CHECK_ACTION_ID } from "../manifest/driftCheck.js";
import { DEFAULT_TIMEZONE, SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { registerTemporalSwitcherViewType } from "../views/temporalSwitcherViewType.js";
import { registerLibraryGridViewType } from "../views/libraryGridViewType.js";
import { seedTenDatabasesInTransaction } from "./seedTenDatabases.js";
import { seedLibraryModuleInTransaction } from "./seedLibraryModule.js";

export { PROJECTS_MODULE_ID } from "./tenDatabaseKeys.js";

/**
 * Seeds the system records this issue's spec names directly, plus the ten hardcoded
 * databases from issue #24 (seedTenDatabasesInTransaction): the "System settings"
 * singleton (home) DB, holding the supervisor's name ("Semp") and the system timezone,
 * and the "Projects" system DB (now issue #24's full Projects schema) holding the
 * Semprec project row itself (the supervisor's home project — `agent_runs.project_item_id`
 * for a supervisor run points here).
 *
 * A code-level migration with direct DB access is the one sanctioned way to write a
 * system DB's schema (see the issue's choke-point section) — this seed uses the raw
 * stores directly rather than the choke-point, which would otherwise reject writes to
 * a `schema_locked`/`system` database. Idempotent: safe to call on every startup.
 *
 * `viewTypeRegistry`/`computedKeyRegistry` default to fresh, private instances for
 * standalone/test use; a real server composition root should pass its own shared instances
 * so the "temporal-switcher" view type and any declared computed cache keys registered here
 * are also known to the chokePoint instance(s) it later serves requests through.
 */
export async function seedSystem(
  pool: Pool,
  viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry(),
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
): Promise<void> {
  // Registered unconditionally, ahead of the idempotency-guarded block below: the DB seed
  // itself only ever runs once (first startup), but `viewTypeRegistry` is an in-memory,
  // per-process registry — every subsequent process start still needs "temporal-switcher"
  // registered into *its own* registry instance for Journal's default view to remain usable,
  // even though `seedTenDatabasesInTransaction` (the only other place that registers it)
  // gets skipped by the early return. `registerViewType` is idempotent for a non-builtin
  // type (a plain Map.set), so calling this on every startup is safe.
  registerTemporalSwitcherViewType(viewTypeRegistry);
  // Same reasoning as temporal-switcher just above (issue #25's library-grid view type):
  // needed in *this process's* registry on every startup, not only the one-time DB seed.
  registerLibraryGridViewType(viewTypeRegistry);

  await withTransaction(pool, async (client) => {
    const existingSettings = await client.query(`SELECT id FROM databases WHERE owner_module_id = $1`, [SYSTEM_SETTINGS_MODULE_ID]);
    if ((existingSettings.rowCount ?? 0) > 0) return;

    const tenDatabases = await seedTenDatabasesInTransaction(client, viewTypeRegistry, computedKeyRegistry);
    const projectsDb = tenDatabases.projects;

    const semprecProject = await itemsStore.insertItem(client, {
      databaseId: projectsDb.id,
      properties: {
        name: "Semprec",
        systemActive: true,
        agents:
          "Purpose: supervise Semprec, the personal life-organization system, and delegate to project agents.\n" +
          "Allowed: read the schema-derived permission manifest for any project and delegate tasks to its agent.\n" +
          "Not allowed: write any property whose owner is 'system', or change a locked/schema_locked database.\n" +
          "General instructions: keep delegated tasks and their results terse; the manifest is the source of truth for what is allowed.",
      },
    });

    // Created unlocked so propertiesStore.createProperty (which itself enforces
    // schema_locked, even for this seed's direct-store calls) will accept the schema
    // writes below; locked via a raw UPDATE afterwards, matching "a system DB's schema
    // can only be changed by a code-level migration with direct DB access."
    const settingsDb = await databasesStore.createDatabase(client, {
      name: "System settings",
      system: true,
      ownerModuleId: SYSTEM_SETTINGS_MODULE_ID,
      ownerProjectItemId: semprecProject.id,
    });
    await propertiesStore.createProperty(client, {
      databaseId: settingsDb.id,
      key: "name",
      name: "Name",
      type: "text",
      locked: true,
      owner: "user",
    });
    await propertiesStore.createProperty(client, {
      databaseId: settingsDb.id,
      key: "timezone",
      name: "Timezone",
      type: "text",
      locked: true,
      owner: "user",
    });

    await itemsStore.insertItem(client, {
      databaseId: settingsDb.id,
      properties: { name: "Semp", timezone: DEFAULT_TIMEZONE },
    });

    await client.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [settingsDb.id]);

    // The drift heartbeat this issue's spec requires ("watched by a separate drift
    // heartbeat check") — reports manifest<->text/owner_process drift for the
    // supervisor's own project. Daily is frequent enough to catch drift without
    // competing with the minute-granularity onItemEvent heartbeats. Must come after
    // settingsDb exists: computing next_fire_at reads the system timezone.
    await createHeartbeat(client, {
      projectItemId: semprecProject.id,
      name: "Manifest drift check",
      rule: { kind: "dailyTime", at: "03:00" },
      actionId: DRIFT_CHECK_ACTION_ID,
    });

    // Books and Movies/TV (issue #25): the second wave, two concrete instantiations of the
    // generic "library module" contract. Runs last: needs Projects/People (from
    // seedTenDatabasesInTransaction above) and the system timezone (settingsDb, just above).
    await seedLibraryModuleInTransaction(client, projectsDb.id, tenDatabases.people.id, viewTypeRegistry, computedKeyRegistry);
  });
}
