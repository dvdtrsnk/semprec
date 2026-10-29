import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import {
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
} from "../chokePoint/relationOps.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../chokePoint/valueLinkWrites.js";
import { insertValueLink, listValueLinksByItemIds, type ValueLinkRow } from "../chokePoint/valueLinksStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";

/** Issue #1516: user and agent writes end value links; the valueLinks process needs an `on` link. */
const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: "00000000-0000-4000-8000-000000000003" };
const VALUE_LINKS = { ownerProcess: VALUE_LINKS_OWNER_PROCESS };

let pool: Pool;
let chokePoint: ChokePoint;

async function setup(cp: ChokePoint = chokePoint) {
  const projects = await cp.createDatabase({ name: "Projects" });
  const files = await cp.createDatabase({ name: "Files" });
  await cp.createProperty({ databaseId: files.id, key: "name", name: "Name", type: "text" });
  const { property: projectsProperty, inverseProperty: filesProperty } = await cp.createRelationProperty({
    sourceDatabaseId: files.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "many_to_many",
    inverse: { key: "files", name: "Files" },
  });
  const file = await cp.createItem({ databaseId: files.id, properties: { name: "a.pdf" } });
  const alpha = await cp.createItem({ databaseId: projects.id, properties: {} });
  const beta = await cp.createItem({ databaseId: projects.id, properties: {} });
  return { files, file, alpha, beta, projectsProperty, filesProperty: filesProperty! };
}

async function link(itemId: string, propertyKey: string, state?: "broken"): Promise<void> {
  await withTransaction(pool, (client) =>
    insertValueLink(client, {
      itemId,
      propertyKey,
      ruleKey: "test",
      ...(state ? { state, brokenBy: "user" as const, brokenAt: new Date("2026-01-01T00:00:00Z") } : {}),
      sources: [],
    }),
  );
}

async function linkOf(itemId: string, propertyKey: string): Promise<ValueLinkRow | undefined> {
  const rows = await withTransaction(pool, (client) => listValueLinksByItemIds(client, [itemId]));
  return rows.find((row) => row.propertyKey === propertyKey);
}

describe("value link state on writes (issue #1516)", () => {
  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("plain properties", () => {
    it("a user write that changes a linked value breaks the link with brokenBy user", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );

      const row = await linkOf(file.id, "name");
      expect(row).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(row?.brokenAt).not.toBeNull();
    });

    it("an agent write breaks the link with brokenBy agent", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        AGENT,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("a system write leaves the link on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        SYSTEM_WRITER,
      );
      await chokePoint.updateItem({ databaseId: files.id, itemId: file.id, propertiesPatch: { name: "c.pdf" } });

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on", brokenBy: null, brokenAt: null });
    });

    it("a patch that sets the value it already holds leaves the link on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "a.pdf" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
    });

    it("only the keys whose value changed are broken", async () => {
      const { files, file } = await setup();
      await chokePoint.createProperty({ databaseId: files.id, key: "note", name: "Note", type: "text" });
      await chokePoint.updateItem({ databaseId: files.id, itemId: file.id, propertiesPatch: { note: "n" } });
      await link(file.id, "name");
      await link(file.id, "note");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf", note: "n" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "broken" });
      expect(await linkOf(file.id, "note")).toMatchObject({ state: "on" });
    });

    it("two writes keep the first brokenBy and brokenAt", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");
      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );
      const first = await linkOf(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "c.pdf" } },
        undefined,
        undefined,
        AGENT,
      );

      const second = await linkOf(file.id, "name");
      expect(second).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(second?.brokenAt).toBe(first?.brokenAt);
    });

    it("a write to an unlinked property changes no link", async () => {
      const { files, file } = await setup();

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toBeUndefined();
    });

    it("rolls the link state back together with a failed write", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await expect(
        withTransaction(pool, async (client) => {
          await updateItemWithClient(
            client,
            { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
            { writer: USER },
          );
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
    });
  });

  describe("relation edges", () => {
    it("putting a second project edge breaks the file's projects link", async () => {
      const { file, alpha, beta, projectsProperty } = await setup();
      await link(file.id, "projects");
      await chokePoint.createRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });

      await chokePoint.createRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: beta.id },
        USER,
      );

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it("putting the edge through the project's files property breaks the file's link", async () => {
      const { file, alpha, filesProperty } = await setup();
      await link(file.id, "projects");

      await chokePoint.createRelation(
        { relationPropertyId: filesProperty.id, callerItemId: alpha.id, targetItemId: file.id },
        AGENT,
      );

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("deleting an edge breaks the link, deleting an absent edge does not", async () => {
      const { file, alpha, beta, projectsProperty } = await setup();
      await chokePoint.createRelation({
        relationPropertyId: projectsProperty.id,
        callerItemId: file.id,
        targetItemId: alpha.id,
      });
      await link(file.id, "projects");

      await chokePoint.deleteRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: beta.id },
        USER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });

      await chokePoint.deleteRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        USER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it("putting an existing edge and replacing metadata leave the link on", async () => {
      const { file, alpha, projectsProperty } = await setup();
      const edge = { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id };
      await chokePoint.createRelation(edge);
      await link(file.id, "projects");

      await chokePoint.createRelation({ ...edge, metadata: { note: "x" } }, USER);
      await chokePoint.updateRelation({ ...edge, metadata: { note: "y" } }, USER);

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });
    });

    it("a system edge write leaves the link on", async () => {
      const { file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");

      await chokePoint.createRelation({
        relationPropertyId: projectsProperty.id,
        callerItemId: file.id,
        targetItemId: alpha.id,
      });

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });
    });

    it("announces the item whose link state changed after the commit", async () => {
      const { files, file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await chokePoint.createRelation(
          { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
          USER,
        );
      } finally {
        setInvalidationHook(() => {});
      }

      expect(events).toContainEqual(
        expect.objectContaining({ scope: "item", databaseId: files.id, itemId: file.id, op: "update" }),
      );
    });
  });

  describe("valueLinks handoff", () => {
    async function relationWrites(client: PoolClient, fx: Awaited<ReturnType<typeof setup>>) {
      const edge = { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id };
      return {
        create: () => createRelationWithClient(client, edge, VALUE_LINKS),
        update: () => updateRelationWithClient(client, { ...edge, metadata: {} }, VALUE_LINKS),
        remove: () => deleteRelationWithClient(client, edge, VALUE_LINKS),
      };
    }

    it("rejects a user-owned relation write without a link row", async () => {
      const fx = await setup();
      await withTransaction(pool, async (client) => {
        const writes = await relationWrites(client, fx);
        await expect(writes.create()).rejects.toMatchObject({ code: "owner_violation" });
      });
      const { rows } = await pool.query("SELECT 1 FROM item_relations");
      expect(rows).toHaveLength(0);
    });

    it("rejects every relation write with a broken row", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects", "broken");
      for (const name of ["create", "update", "remove"] as const) {
        await withTransaction(pool, async (client) => {
          const writes = await relationWrites(client, fx);
          await expect(writes[name]()).rejects.toMatchObject({ code: "owner_violation" });
        });
      }
    });

    it("writes with an on row and leaves the state on", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects");

      await withTransaction(pool, async (client) => {
        const writes = await relationWrites(client, fx);
        await writes.create();
        await writes.remove();
      });

      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "on", brokenBy: null });
    });

    it("rejects a plain property write without an on row and writes nothing", async () => {
      const { files, file } = await setup();
      await expect(
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "z.pdf" } },
            { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS },
          ),
        ),
      ).rejects.toMatchObject({ code: "owner_violation" });

      const { rows } = await pool.query("SELECT properties->>'name' AS name FROM items WHERE id = $1", [file.id]);
      expect(rows[0].name).toBe("a.pdf");
    });

    it("writes a plain property with an on row and leaves the state on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "z.pdf" } },
          { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS },
        ),
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
      const { rows } = await pool.query("SELECT properties->>'name' AS name FROM items WHERE id = $1", [file.id]);
      expect(rows[0].name).toBe("z.pdf");
    });
  });

  describe("tenants", () => {
    it("never touches the links of another tenant", async () => {
      await resetDatabase(pool);
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const cp = createChokePoint(runtimePool);
        const a = await runInTenant(tenantA, () => setup(cp));
        const b = await runInTenant(tenantB, () => setup(cp));
        await withTenantTransaction(runtimePool, tenantA, (client) =>
          insertValueLink(client, { itemId: a.file.id, propertyKey: "name", ruleKey: "test", sources: [] }),
        );
        await withTenantTransaction(runtimePool, tenantB, (client) =>
          insertValueLink(client, { itemId: b.file.id, propertyKey: "name", ruleKey: "test", sources: [] }),
        );

        await runInTenant(tenantB, () =>
          cp.updateItem(
            { databaseId: b.files.id, itemId: b.file.id, propertiesPatch: { name: "changed" } },
            undefined,
            undefined,
            USER,
          ),
        );

        const states = async (tenantId: string, itemId: string) =>
          withTenantTransaction(runtimePool, tenantId, (client) => listValueLinksByItemIds(client, [itemId]));
        expect((await states(tenantA, a.file.id))[0]).toMatchObject({ state: "on" });
        expect((await states(tenantB, b.file.id))[0]).toMatchObject({ state: "broken", brokenBy: "user" });
      } finally {
        await runtimePool.end();
      }
    });
  });
});
