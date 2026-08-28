import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { createViewTypeRegistry, registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let chokePoint: ChokePoint;

describe("views", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    chokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeTasksDb() {
    const db = await chokePoint.createDatabase({ name: "Tasks" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    await chokePoint.createProperty({ databaseId: db.id, key: "status", name: "Status", type: "select" });
    await chokePoint.createProperty({ databaseId: db.id, key: "tags", name: "Tags", type: "multi_select" });
    await chokePoint.createProperty({ databaseId: db.id, key: "due", name: "Due", type: "date" });
    return db;
  }

  describe("creation", () => {
    it("creates a linked (filtered) view against an existing database", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "All tasks" });
      expect(view.databaseId).toBe(db.id);
      expect(view.createdBy).toBe("user");
      expect(view.type).toBe("table");
    });

    it("rejects an unknown view type", async () => {
      const db = await makeTasksDb();
      await expect(chokePoint.createView({ databaseId: db.id, type: "mailbox-client", name: "Inbox" })).rejects.toBeInstanceOf(ValidationError);
    });

    it("accepts a custom view type once registered, and rejects ownerModuleId on a built-in type", async () => {
      const db = await makeTasksDb();
      registerViewType(viewTypeRegistry, "mailbox-client", {});
      const view = await chokePoint.createView({ databaseId: db.id, type: "mailbox-client", name: "Inbox", ownerModuleId: "emails" });
      expect(view.type).toBe("mailbox-client");
      expect(view.ownerModuleId).toBe("emails");

      await expect(
        chokePoint.createView({ databaseId: db.id, type: "table", name: "X", ownerModuleId: "emails" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("a curated view has no databaseId and requires config.membership = 'manual'", async () => {
      const view = await chokePoint.createView({ type: "list", name: "My Collection", config: { membership: "manual" } });
      expect(view.databaseId).toBeNull();

      await expect(chokePoint.createView({ type: "list", name: "Bad" })).rejects.toBeInstanceOf(ValidationError);
      const db = await makeTasksDb();
      await expect(
        chokePoint.createView({ databaseId: db.id, type: "list", name: "Bad", config: { membership: "manual" } }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("only one default view per database — a second is a conflict", async () => {
      const db = await makeTasksDb();
      await chokePoint.createView({ databaseId: db.id, type: "table", name: "A", isDefault: true });
      await expect(chokePoint.createView({ databaseId: db.id, type: "board", name: "B", isDefault: true })).rejects.toBeInstanceOf(ConflictError);
    });

    it("an agent may create a view freely, but never with isDefault: true", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "Agent view", createdBy: "ai_agent" });
      expect(view.createdBy).toBe("ai_agent");

      await expect(
        chokePoint.createView({ databaseId: db.id, type: "board", name: "Agent default", createdBy: "ai_agent", isDefault: true }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("inline database creation is always system: false and carries parentItemId", async () => {
      const page = await chokePoint.createDatabase({ name: "Page host" });
      const item = await chokePoint.createItem({ databaseId: page.id, properties: {} });
      const inline = await chokePoint.createInlineDatabase({ name: "Inline DB", parentItemId: item.id });
      expect(inline.system).toBe(false);
      expect(inline.parentItemId).toBe(item.id);
    });
  });

  describe("created_by enforcement", () => {
    it("an agent cannot patch a user's view — 403 owner_violation", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "User view" });
      try {
        await chokePoint.patchView({ id: view.id, actor: "ai_agent", name: "Renamed" });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
      }
    });

    it("an agent can patch its own view", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "Agent view", createdBy: "ai_agent" });
      const patched = await chokePoint.patchView({ id: view.id, actor: "ai_agent", name: "Renamed by agent" });
      expect(patched.name).toBe("Renamed by agent");
      expect(patched.createdBy).toBe("ai_agent");
    });

    it("a user's patch to an agent's view adopts it (ai_agent -> user), one-way", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "Agent view", createdBy: "ai_agent" });
      const adopted = await chokePoint.patchView({ id: view.id, actor: "user", name: "Now mine" });
      expect(adopted.createdBy).toBe("user");

      // Reverse direction never happens: an agent write now fails since it's no longer its own view.
      await expect(chokePoint.patchView({ id: view.id, actor: "ai_agent", name: "Steal back" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a user's write to a system view never flips created_by", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "System view", createdBy: "system" });
      const patched = await chokePoint.patchView({ id: view.id, actor: "user", name: "Edited" });
      expect(patched.createdBy).toBe("system");
    });

    it("an agent may never set is_default via patch, even on its own view", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "Agent view", createdBy: "ai_agent" });
      await expect(chokePoint.patchView({ id: view.id, actor: "ai_agent", isDefault: true })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("an agent cannot delete a user's view but can delete its own", async () => {
      const db = await makeTasksDb();
      const userView = await chokePoint.createView({ databaseId: db.id, type: "table", name: "User view" });
      await expect(chokePoint.deleteView({ id: userView.id, actor: "ai_agent" })).rejects.toBeInstanceOf(ForbiddenError);

      const agentView = await chokePoint.createView({ databaseId: db.id, type: "table", name: "Agent view", createdBy: "ai_agent" });
      await chokePoint.deleteView({ id: agentView.id, actor: "ai_agent" });
      expect(await chokePoint.getView(agentView.id)).toBeNull();
    });
  });

  describe("view_items (curated membership)", () => {
    it("add/remove/reorder respects position and only applies to curated views", async () => {
      const db = await makeTasksDb();
      const item1 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "One" } });
      const item2 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Two" } });
      const filtered = await chokePoint.createView({ databaseId: db.id, type: "table", name: "Filtered" });
      await expect(
        chokePoint.addViewItem({ viewId: filtered.id, itemId: item1.id, actor: "user" }),
      ).rejects.toBeInstanceOf(ValidationError);

      const curated = await chokePoint.createView({ type: "list", name: "Collection", config: { membership: "manual" } });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item1.id, actor: "user" });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item2.id, actor: "user" });
      const members = await chokePoint.listViewItems(curated.id);
      expect(members.map((m) => m.itemId)).toEqual([item1.id, item2.id]);

      await chokePoint.reorderViewItem({ viewId: curated.id, itemId: item2.id, position: 0, actor: "user" });
      const reordered = await chokePoint.listViewItems(curated.id);
      expect(reordered.map((m) => m.itemId)).toEqual([item2.id, item1.id]);

      await chokePoint.removeViewItem({ viewId: curated.id, itemId: item1.id, actor: "user" });
      expect((await chokePoint.listViewItems(curated.id)).map((m) => m.itemId)).toEqual([item2.id]);
    });

    it("an agent can only write view_items on its own curated view", async () => {
      const item = await (async () => {
        const db = await makeTasksDb();
        return chokePoint.createItem({ databaseId: db.id, properties: { title: "X" } });
      })();
      const userCollection = await chokePoint.createView({ type: "list", name: "Mine", config: { membership: "manual" } });
      await expect(
        chokePoint.addViewItem({ viewId: userCollection.id, itemId: item.id, actor: "ai_agent" }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const agentCollection = await chokePoint.createView({
        type: "list",
        name: "Agent's",
        config: { membership: "manual" },
        createdBy: "ai_agent",
      });
      await chokePoint.addViewItem({ viewId: agentCollection.id, itemId: item.id, actor: "ai_agent" });
      expect((await chokePoint.listViewItems(agentCollection.id)).map((m) => m.itemId)).toEqual([item.id]);
    });

    it("a curated view can mix items from multiple databases", async () => {
      const dbA = await makeTasksDb();
      const dbB = await chokePoint.createDatabase({ name: "Notes" });
      await chokePoint.createProperty({ databaseId: dbB.id, key: "title", name: "Title", type: "text" });
      const itemA = await chokePoint.createItem({ databaseId: dbA.id, properties: { title: "Task" } });
      const itemB = await chokePoint.createItem({ databaseId: dbB.id, properties: { title: "Note" } });

      const collection = await chokePoint.createView({ type: "list", name: "Mixed", config: { membership: "manual" } });
      await chokePoint.addViewItem({ viewId: collection.id, itemId: itemA.id, actor: "user" });
      await chokePoint.addViewItem({ viewId: collection.id, itemId: itemB.id, actor: "user" });

      const result = await chokePoint.queryView(collection.id);
      expect(result.items.map((i) => i.id).sort()).toEqual([itemA.id, itemB.id].sort());
    });
  });

  describe("queryView: filter/sort/visibility push-down", () => {
    async function seedTasks(db: { id: string }, chokePointRef: ChokePoint) {
      const done = await chokePointRef.createItem({ databaseId: db.id, properties: { title: "Ship it", status: "done", tags: ["urgent", "backend"] } });
      const todo = await chokePointRef.createItem({ databaseId: db.id, properties: { title: "Write docs", status: "todo", tags: ["docs"] } });
      const inProgress = await chokePointRef.createItem({
        databaseId: db.id,
        properties: { title: "Refactor", status: "in_progress", tags: ["backend"] },
      });
      return { done, todo, inProgress };
    }

    it("compiles an 'equals' filter to a push-down predicate", async () => {
      const db = await makeTasksDb();
      const { done } = await seedTasks(db, chokePoint);
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Done",
        config: { filter: { type: "equals", property: "status", value: "done" } },
      });
      const result = await chokePoint.queryView(view.id);
      expect(result.items.map((i) => i.id)).toEqual([done.id]);
    });

    it("compiles an 'in' filter over a multi_select property as overlap", async () => {
      const db = await makeTasksDb();
      const { done, inProgress } = await seedTasks(db, chokePoint);
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Backend",
        config: { filter: { type: "in", property: "tags", value: ["backend"] } },
      });
      const result = await chokePoint.queryView(view.id);
      expect(result.items.map((i) => i.id).sort()).toEqual([done.id, inProgress.id].sort());
    });

    it("compiles 'not' + 'or' connectives", async () => {
      const db = await makeTasksDb();
      const { done, todo, inProgress } = await seedTasks(db, chokePoint);
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Not done",
        config: {
          filter: {
            type: "not",
            node: { type: "or", nodes: [{ type: "equals", property: "status", value: "done" }] },
          },
        },
      });
      const result = await chokePoint.queryView(view.id);
      expect(result.items.map((i) => i.id).sort()).toEqual([todo.id, inProgress.id].sort());
      expect(result.items.map((i) => i.id)).not.toContain(done.id);
    });

    it("a filter value cannot inject SQL — special characters are treated as literal data", async () => {
      const db = await makeTasksDb();
      await chokePoint.createItem({ databaseId: db.id, properties: { title: "normal", status: "todo" } });
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Injection attempt",
        config: { filter: { type: "equals", property: "status", value: "todo'; DROP TABLE views; --" } },
      });
      const result = await chokePoint.queryView(view.id);
      expect(result.items).toHaveLength(0);
      // The views table must still exist and be queryable.
      expect(await chokePoint.getView(view.id)).not.toBeNull();
    });

    it("rejects a filter referencing an unknown property", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Bad filter",
        config: { filter: { type: "equals", property: "nope", value: "x" } },
      });
      await expect(chokePoint.queryView(view.id)).rejects.toBeInstanceOf(ValidationError);
    });

    it("sorts by a property, casting dates", async () => {
      const db = await makeTasksDb();
      const a = await chokePoint.createItem({ databaseId: db.id, properties: { title: "A", due: "2026-01-01" } });
      const b = await chokePoint.createItem({ databaseId: db.id, properties: { title: "B", due: "2025-01-01" } });
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "By due",
        config: { sort: [{ property: "due", direction: "asc" }] },
      });
      const result = await chokePoint.queryView(view.id);
      expect(result.items.map((i) => i.id)).toEqual([b.id, a.id]);
    });

    it("projects propertyOrder and visibility onto returned items", async () => {
      const db = await makeTasksDb();
      await chokePoint.createItem({ databaseId: db.id, properties: { title: "A", status: "todo" } });
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Slim",
        config: { propertyOrder: ["status", "title"], visibility: { tags: false, due: false } },
      });
      const result = await chokePoint.queryView(view.id);
      expect(Object.keys(result.items[0].properties)).toEqual(["status", "title"]);
    });

    it("getView returns a NotFoundError from queryView for a missing view", async () => {
      await expect(chokePoint.queryView("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
