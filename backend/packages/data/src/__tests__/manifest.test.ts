import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { createDriftCheckAction, findOrphanedOwnerProcessProperties } from "../manifest/driftCheck.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("permission manifest and drift check", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("generates a manifest scoped to one project's owned databases", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });

    const owned = await chokePoint.createDatabase({ name: "Owned", ownerProjectItemId: projectItem.id });
    await chokePoint.createProperty({ databaseId: owned.id, key: "note", name: "Note", type: "text" });
    await chokePoint.createProperty({
      databaseId: owned.id,
      key: "rating",
      name: "Rating",
      type: "number",
      owner: "system",
      ownerProcess: "critics.rate",
    });

    await chokePoint.createDatabase({ name: "NotOwned" }); // should not appear

    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, projectItem.id));
    expect(manifest.databases).toHaveLength(1);
    expect(manifest.databases[0].databaseId).toBe(owned.id);
    expect(manifest.databases[0].properties.map((p) => p.key).sort()).toEqual(["note", "rating"]);
  });

  it("finds owner:'system' properties with no owner_process as orphaned", async () => {
    const db = await chokePoint.createDatabase({ name: "D" });
    await chokePoint.createProperty({ databaseId: db.id, key: "userField", name: "User field", type: "text" });
    await chokePoint.createProperty({ databaseId: db.id, key: "orphan", name: "Orphan", type: "text", owner: "system" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "owned",
      name: "Owned",
      type: "text",
      owner: "system",
      ownerProcess: "library.processLibraryMetadata",
    });

    const orphaned = await withTransaction(pool, (client) => findOrphanedOwnerProcessProperties(client));
    expect(orphaned.map((o) => o.key)).toEqual(["orphan"]);

    const orphanedWithActiveList = await withTransaction(pool, (client) =>
      findOrphanedOwnerProcessProperties(client, new Set(["some.otherModule"])),
    );
    expect(orphanedWithActiveList.map((o) => o.key).sort()).toEqual(["orphan", "owned"]);
  });

  it("the drift check action writes a notification when an orphan is found, and nothing when clean", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects2" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });
    const db = await chokePoint.createDatabase({ name: "Owned2", ownerProjectItemId: projectItem.id });
    await chokePoint.createProperty({ databaseId: db.id, key: "orphan", name: "Orphan", type: "text", owner: "system" });

    const action = createDriftCheckAction(pool);
    await action({}, { heartbeatId: "hb", projectItemId: projectItem.id });

    const { rows } = await pool.query("SELECT kind, payload FROM notifications WHERE kind = 'agent_manifest_drift'");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.orphanedOwnerProcess).toHaveLength(1);
  });
});
