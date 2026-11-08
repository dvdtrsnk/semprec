import "../domainWriteHooks.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { getValueLinksForItems } from "../chokePoint/valueLinkReads.js";
import { insertValueLink } from "../chokePoint/valueLinksStore.js";
import { withTransaction } from "../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let foreign: string;

async function db(key: string): Promise<string> {
  const database = (await cp.listDatabases()).find((row) => row.ownerModuleId === key);
  if (!database) throw new Error(`Missing ${key}`);
  return database.id;
}

async function item(moduleId: string, name: string): Promise<string> {
  return (await cp.createItem({ databaseId: await db(moduleId), properties: { name } })).id;
}

async function link(moduleId: string, key: string, from: string, to: string): Promise<void> {
  const databaseId = await db(moduleId);
  const property = await withTransaction(pool, (client) => getPropertyByKey(client, databaseId, key));
  if (!property) throw new Error(`Missing ${moduleId}.${key}`);
  await cp.createRelation({ relationPropertyId: property.id, callerItemId: from, targetItemId: to });
}

/**
 * The file's inherited `projects` link, written through the links store: no link rule of a shipped
 * module creates one yet (the rules are later issues), so the store's own insert stands in for the
 * rule's producer. The file's edge itself is the value the link inherited.
 */
async function inheritProjects(file: string, sources: string[], sourcePropertyKey = "project"): Promise<string> {
  const { link: created } = await withTransaction(pool, (client) =>
    insertValueLink(client, {
      itemId: file,
      propertyKey: "projects",
      ruleKey: "test.inheritProjects",
      sources: sources.map((sourceItemId) => ({ kind: "item", sourceItemId, sourcePropertyKey })),
    }),
  );
  return created.id;
}

async function linkRows(): Promise<{
  links: { id: string; item_id: string; state: string }[];
  sources: { link_id: string; source_item_id: string | null }[];
}> {
  return withTransaction(pool, async (client) => ({
    links: (
      await client.query<{ id: string; item_id: string; state: string }>(
        "SELECT id, item_id, state FROM value_links WHERE tenant_id = app_tenant_default() ORDER BY id",
      )
    ).rows,
    sources: (
      await client.query<{ link_id: string; source_item_id: string | null }>(
        "SELECT link_id, source_item_id FROM value_link_sources WHERE tenant_id = app_tenant_default() ORDER BY link_id, source_item_id",
      )
    ).rows,
  }));
}

async function linksOf(itemId: string) {
  return (await withTransaction(pool, (client) => getValueLinksForItems(client, [itemId]))).get(itemId) ?? {};
}

/** The targets of the file's `projects` edges: the inherited value, which a detach never touches. */
async function projectEdgeTargets(file: string): Promise<string[]> {
  const files = await db("files");
  return withTransaction(pool, async (client) => {
    const property = await getPropertyByKey(client, files, "projects");
    const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
    if (!definition) throw new Error("Missing Files.projects");
    return (await listRelationsForItem(client, definition.id, file)).map((edge) => otherSide(edge, file)).sort();
  });
}

const FAR_FUTURE = new Date("2999-01-01T00:00:00Z");

describe("value links detach when their source is deleted (issue #1656)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    const role = await runAsSystem("verify value link role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(pool));
  });

  afterEach(async () => {
    setInvalidationHook(() => {});
    await admin.query("DROP TRIGGER IF EXISTS fail_value_link_cleanup_test ON value_link_sources");
    await admin.query("DROP TRIGGER IF EXISTS fail_item_trash_test ON items");
    await admin.query("DROP FUNCTION IF EXISTS fail_value_link_cleanup_test()");
    await admin.query("DROP FUNCTION IF EXISTS fail_item_trash_test()");
    await admin.query("DROP TABLE IF EXISTS fail_item_trash_test_ids");
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("detaches an attached file's link when its task is trashed; the file keeps its project edge as its own", async () => {
    await runInTenant(tenant, async () => {
      const project = await item("projects", "Web");
      const task = await item("tasks", "Nabídka");
      const file = await item("files", "nabidka.pdf");
      await link("tasks", "project", task, project);
      await link("files", "projects", file, project);
      await inheritProjects(file, [task]);
      expect(Object.keys(await linksOf(file))).toEqual(["projects"]);
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => {
        events.push(event);
      });

      await cp.softDeleteItem(await db("tasks"), task);

      expect(await linkRows()).toEqual({ links: [], sources: [] });
      expect(await linksOf(file)).toEqual({});
      expect(await projectEdgeTargets(file)).toEqual([project]);
      expect(events.some((event) => event.scope === "item" && event.itemId === file)).toBe(true);

      // Restoring the source relinks nothing: the value stays the file's own.
      await cp.restoreItem(await db("tasks"), task);
      expect(await linkRows()).toEqual({ links: [], sources: [] });
      expect(await projectEdgeTargets(file)).toEqual([project]);
    });
  });

  it("keeps a link with two sources on with the other source when one is trashed", async () => {
    await runInTenant(tenant, async () => {
      const first = await item("projects", "První");
      const second = await item("projects", "Druhý");
      const file = await item("files", "smlouva.pdf");
      await link("files", "projects", file, first);
      await link("files", "projects", file, second);
      const linkId = await inheritProjects(file, [first, second], "name");

      await cp.softDeleteItem(await db("projects"), first);

      expect(await linkRows()).toEqual({
        links: [{ id: linkId, item_id: file, state: "on" }],
        sources: [{ link_id: linkId, source_item_id: second }],
      });
      const entry = (await linksOf(file)).projects;
      expect(entry?.valueKind).toBe("inherited");
      expect(entry?.sources.map((source) => (source.kind === "item" ? source.itemId : null))).toEqual([second]);
      expect(await projectEdgeTargets(file)).toEqual([first, second].sort());
    });
  });

  it("detaches links whose source sits in an inline database trashed with its page", async () => {
    await runInTenant(tenant, async () => {
      const page = await cp.createDatabase({ name: "Stránky" });
      const root = await cp.createItem({ databaseId: page.id, properties: {} });
      const inline = await cp.createInlineDatabase({ name: "Řádky", parentItemId: root.id });
      const row = await cp.createItem({ databaseId: inline.id, properties: {} });
      const file = await item("files", "radek.pdf");
      await inheritProjects(file, [row.id]);

      await cp.softDeleteItem(page.id, root.id);

      expect((await cp.findItemIncludingDeleted(row.id))?.deletedAt).not.toBeNull();
      expect(await linkRows()).toEqual({ links: [], sources: [] });
    });
  });

  it("removes a purged source's rows and the links left without a source", async () => {
    await runInTenant(tenant, async () => {
      const task = await item("tasks", "Starý úkol");
      const keptSource = await item("tasks", "Živý úkol");
      const lonely = await item("files", "a.pdf");
      const shared = await item("files", "b.pdf");
      await cp.softDeleteItem(await db("tasks"), task);
      // Links naming an already-trashed source, as a link created before this cleanup existed would:
      // the store's insert does not check the source, so the fixture uses it after the trash.
      const lonelyLink = await inheritProjects(lonely, [task]);
      const sharedLink = await inheritProjects(shared, [task, keptSource]);

      const purged = await cp.purgeExpiredTrashSubtree(task, FAR_FUTURE);

      expect(purged.purgedItemIds).toEqual([task]);
      const rows = await linkRows();
      expect(rows.links.map((row) => row.id)).toEqual([sharedLink]);
      expect(rows.links.map((row) => row.id)).not.toContain(lonelyLink);
      expect(rows.sources).toEqual([{ link_id: sharedLink, source_item_id: keptSource }]);
    });
  });

  it("removes a purged inheriting item's own link and its sources", async () => {
    await runInTenant(tenant, async () => {
      const task = await item("tasks", "Zdroj");
      const file = await item("files", "dedic.pdf");
      const linkId = await inheritProjects(file, [task]);
      await cp.softDeleteItem(await db("files"), file);
      // The inheriting item's own link survives its soft delete: only a source's trash detaches links.
      expect((await linkRows()).links.map((row) => row.id)).toEqual([linkId]);

      await cp.purgeExpiredTrashSubtree(file, FAR_FUTURE);

      expect(await linkRows()).toEqual({ links: [], sources: [] });
    });
  });

  it("keeps the item and its links when the cleanup fails, because it shares the delete transaction", async () => {
    await runInTenant(tenant, async () => {
      const task = await item("tasks", "Nesmazatelný");
      const file = await item("files", "c.pdf");
      const linkId = await inheritProjects(file, [task]);
      // Fault injection inside the cleanup's own DELETE: no production input can make it fail.
      await admin.query(`CREATE FUNCTION fail_value_link_cleanup_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'value link cleanup failure'; END $$`);
      await admin.query(`CREATE TRIGGER fail_value_link_cleanup_test BEFORE DELETE ON value_link_sources
        FOR EACH ROW EXECUTE FUNCTION fail_value_link_cleanup_test()`);

      await expect(cp.softDeleteItem(await db("tasks"), task)).rejects.toThrow("value link cleanup failure");

      expect((await cp.findItemIncludingDeleted(task))?.deletedAt).toBeNull();
      expect(await linkRows()).toEqual({
        links: [{ id: linkId, item_id: file, state: "on" }],
        sources: [{ link_id: linkId, source_item_id: task }],
      });
    });
  });

  it("rolls the cleanup back with the delete when a later step of the cascade fails", async () => {
    await runInTenant(tenant, async () => {
      const page = await cp.createDatabase({ name: "Stránky" });
      const root = await cp.createItem({ databaseId: page.id, properties: {} });
      const inline = await cp.createInlineDatabase({ name: "Řádky", parentItemId: root.id });
      const child = await cp.createItem({ databaseId: inline.id, properties: {} });
      const file = await item("files", "d.pdf");
      const linkId = await inheritProjects(file, [root.id]);
      // The child's soft delete, after the root's cleanup already ran, fails. The failing id is passed
      // to the trigger through a scratch table, not interpolated into its body.
      await admin.query("CREATE TABLE fail_item_trash_test_ids (id uuid PRIMARY KEY)");
      await admin.query("INSERT INTO fail_item_trash_test_ids (id) VALUES ($1)", [child.id]);
      await admin.query("GRANT SELECT ON fail_item_trash_test_ids TO PUBLIC");
      await admin.query(`CREATE FUNCTION fail_item_trash_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM fail_item_trash_test_ids WHERE id = NEW.id) THEN
            RAISE EXCEPTION 'later cascade step failure';
          END IF;
          RETURN NEW;
        END $$`);
      await admin.query(`CREATE TRIGGER fail_item_trash_test BEFORE UPDATE ON items
        FOR EACH ROW EXECUTE FUNCTION fail_item_trash_test()`);

      await expect(cp.softDeleteItem(page.id, root.id)).rejects.toThrow("later cascade step failure");

      expect((await cp.findItemIncludingDeleted(root.id))?.deletedAt).toBeNull();
      expect(await linkRows()).toEqual({
        links: [{ id: linkId, item_id: file, state: "on" }],
        sources: [{ link_id: linkId, source_item_id: root.id }],
      });
    });
  });

  it("neither reads nor removes another tenant's link rows", async () => {
    const own = await runInTenant(tenant, async () => {
      const task = await item("tasks", "Vlastní");
      const file = await item("files", "e.pdf");
      await inheritProjects(file, [task]);
      return task;
    });
    // Another tenant's link whose source id happens to equal this tenant's task id.
    const foreignLink = await runInTenant(foreign, async () => {
      const file = await item("files", "cizi.pdf");
      return inheritProjects(file, [own]);
    });
    await runInTenant(tenant, async () => {
      await cp.softDeleteItem(await db("tasks"), own);
      expect(await linkRows()).toEqual({ links: [], sources: [] });
      await cp.purgeExpiredTrashSubtree(own, FAR_FUTURE);
    });
    await runInTenant(foreign, async () => {
      const rows = await linkRows();
      expect(rows.links.map((row) => row.id)).toEqual([foreignLink]);
      expect(rows.sources).toEqual([{ link_id: foreignLink, source_item_id: own }]);
    });
  });
});
