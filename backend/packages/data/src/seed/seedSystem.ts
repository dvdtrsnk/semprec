import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { DRIFT_CHECK_ACTION_ID } from "../manifest/driftCheck.js";
import { DEFAULT_TIMEZONE, SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";

export const PROJECTS_MODULE_ID = "projects";

/**
 * Seeds the two system records this issue's spec names directly: the "System settings"
 * singleton (home) DB, holding the supervisor's name ("Semp") and the system timezone,
 * and the "Projects" system DB holding the Semprec project row itself (the supervisor's
 * home project — `agent_runs.project_item_id` for a supervisor run points here).
 *
 * A code-level migration with direct DB access is the one sanctioned way to write a
 * system DB's schema (see the issue's choke-point section) — this seed uses the raw
 * stores directly rather than the choke-point, which would otherwise reject writes to
 * a `schema_locked`/`system` database. Idempotent: safe to call on every startup.
 */
export async function seedSystem(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const existingSettings = await client.query(`SELECT id FROM databases WHERE owner_module_id = $1`, [SYSTEM_SETTINGS_MODULE_ID]);
    if ((existingSettings.rowCount ?? 0) > 0) return;

    const projectsDb = await databasesStore.createDatabase(client, {
      name: "Projects",
      system: true,
      ownerModuleId: PROJECTS_MODULE_ID,
    });
    await propertiesStore.createProperty(client, {
      databaseId: projectsDb.id,
      key: "name",
      name: "Name",
      type: "text",
      locked: true,
      owner: "user",
    });
    await propertiesStore.createProperty(client, {
      databaseId: projectsDb.id,
      key: "agents",
      name: "AGENT.md",
      type: "text",
      locked: true,
      owner: "user",
    });

    // Locked immediately after its (fixed, code-defined) schema is seeded — same rule
    // as settingsDb below: a system DB's schema changes only via a code-level migration.
    await client.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [projectsDb.id]);

    const semprecProject = await itemsStore.insertItem(client, {
      databaseId: projectsDb.id,
      properties: {
        name: "Semprec",
        agents:
          "Purpose: supervise Semprec, the personal life-organization system, and delegate to project agents.\n" +
          "What I may do: read the schema-derived permission manifest for any project and delegate tasks to its agent.\n" +
          "What I may not do: write any property whose owner is 'system', or change a locked/schema_locked database.\n" +
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
  });
}
