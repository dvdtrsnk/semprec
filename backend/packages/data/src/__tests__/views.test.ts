import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type Actor, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { createViewTypeRegistry, registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let chokePoint: ChokePoint;
let projectsDbId: string;
let agentA: string;
let agentB: string;

const userActor: Actor = { type: "user" };
function agentActor(agentProjectItemId: string): Actor {
  return { type: "ai_agent", agentProjectItemId };
}

describe("views", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    chokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    await resetDatabase(pool);

    // A minimal stand-in for the seeded Projects system database — enough for
    // assertAuthenticatedAgentIdentity to resolve a real "owning Projects item" per agent.
    const projectsDb = await chokePoint.createDatabase({
      name: null,
      key: "projects",
      system: true,
      ownerModuleId: "projects",
    });
    projectsDbId = projectsDb.id;
    agentA = (await chokePoint.createItem({ databaseId: projectsDbId, properties: {} })).id;
    agentB = (await chokePoint.createItem({ databaseId: projectsDbId, properties: {} })).id;
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
      expect(view.creatorProjectItemId).toBeNull();
      expect(view.type).toBe("table");
    });

    it("rejects an unknown view type", async () => {
      const db = await makeTasksDb();
      await expect(
        chokePoint.createView({ databaseId: db.id, type: "mailbox-client", name: "Inbox" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("accepts a custom view type once registered, and rejects ownerModuleId on a built-in type", async () => {
      const db = await makeTasksDb();
      registerViewType(viewTypeRegistry, "mailbox-client", {});
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "mailbox-client",
        name: "Inbox",
        ownerModuleId: "emails",
      });
      expect(view.type).toBe("mailbox-client");
      expect(view.ownerModuleId).toBe("emails");

      await expect(
        chokePoint.createView({ databaseId: db.id, type: "table", name: "X", ownerModuleId: "emails" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("a curated view has no databaseId and requires config.membership = 'manual'", async () => {
      const view = await chokePoint.createView({
        type: "list",
        name: "My Collection",
        config: { membership: "manual" },
      });
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
      await expect(
        chokePoint.createView({ databaseId: db.id, type: "board", name: "B", isDefault: true }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("an agent may create a view freely, but never with isDefault: true, and it stores the agent's own creator identity", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView(
        { databaseId: db.id, type: "table", name: "Agent view" },
        agentActor(agentA),
      );
      expect(view.createdBy).toBe("ai_agent");
      expect(view.creatorProjectItemId).toBe(agentA);

      await expect(
        chokePoint.createView(
          { databaseId: db.id, type: "board", name: "Agent default", isDefault: true },
          agentActor(agentA),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("an agent creating without actor.agentProjectItemId gets 403 owner_violation / missing_authenticated_agent_identity, and persists nothing", async () => {
      const db = await makeTasksDb();
      try {
        await chokePoint.createView({ databaseId: db.id, type: "table", name: "Agent view" }, { type: "ai_agent" });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
        expect((err as ForbiddenError).details).toEqual({
          field: "agentProjectItemId",
          reason: "missing_authenticated_agent_identity",
        });
      }
      expect(await chokePoint.listViewsByDatabase(db.id)).toHaveLength(0);
    });

    it("an agent creating with an agentProjectItemId naming no real Projects item gets 403 owner_violation / unknown_authenticated_agent_identity, and persists nothing", async () => {
      const db = await makeTasksDb();
      const fakeAgentId = "00000000-0000-0000-0000-000000000000";
      try {
        await chokePoint.createView({ databaseId: db.id, type: "table", name: "Agent view" }, agentActor(fakeAgentId));
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
        expect((err as ForbiddenError).details).toEqual({
          field: "agentProjectItemId",
          reason: "unknown_authenticated_agent_identity",
        });
      }
      expect(await chokePoint.listViewsByDatabase(db.id)).toHaveLength(0);
    });

    it("inline database creation is always system: false and carries parentItemId", async () => {
      const page = await chokePoint.createDatabase({ name: "Page host" });
      const item = await chokePoint.createItem({ databaseId: page.id, properties: {} });
      const inline = await chokePoint.createInlineDatabase({ name: "Inline DB", parentItemId: item.id });
      expect(inline.system).toBe(false);
      expect(inline.parentItemId).toBe(item.id);
    });
  });

  describe("per-agent ownership enforcement", () => {
    it("agent B cannot patch, delete, or reorder membership in a view created by agent A — 403 owner_violation / creator_mismatch", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView(
        { databaseId: db.id, type: "table", name: "Agent A's view" },
        agentActor(agentA),
      );
      try {
        await chokePoint.patchView({ id: view.id, actor: agentActor(agentB), name: "Renamed" });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
        expect((err as ForbiddenError).details).toEqual({
          field: "creatorProjectItemId",
          viewId: view.id,
          reason: "creator_mismatch",
        });
      }
      await expect(chokePoint.deleteView({ id: view.id, actor: agentActor(agentB) })).rejects.toBeInstanceOf(
        ForbiddenError,
      );

      const curated = await chokePoint.createView(
        { type: "list", name: "Agent A's collection", config: { membership: "manual" } },
        agentActor(agentA),
      );
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "X" } });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item.id, actor: agentActor(agentA) });
      await expect(
        chokePoint.reorderViewItem({ viewId: curated.id, itemId: item.id, position: 0, actor: agentActor(agentB) }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        chokePoint.removeViewItem({ viewId: curated.id, itemId: item.id, actor: agentActor(agentB) }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        chokePoint.addViewItem({ viewId: curated.id, itemId: item.id, actor: agentActor(agentB) }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("agent A can mutate its own view", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView(
        { databaseId: db.id, type: "table", name: "Agent view" },
        agentActor(agentA),
      );
      const patched = await chokePoint.patchView({ id: view.id, actor: agentActor(agentA), name: "Renamed" });
      expect(patched.name).toBe("Renamed");
      await chokePoint.deleteView({ id: view.id, actor: agentActor(agentA) });
      expect(await chokePoint.getView(view.id)).toBeNull();
    });

    it("an agent mutating a user-owned view gets 403 owner_violation / user_owned", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "User view" });
      try {
        await chokePoint.patchView({ id: view.id, actor: agentActor(agentA), name: "Renamed" });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
        expect((err as ForbiddenError).details).toEqual({
          field: "creatorProjectItemId",
          viewId: view.id,
          reason: "user_owned",
        });
      }
    });

    it("an agent mutating a system-owned view gets 403 owner_violation / system_owned", async () => {
      const db = await makeTasksDb();
      const client = await pool.connect();
      let view;
      try {
        view = await viewsStore.createView(
          client,
          { databaseId: db.id, type: "table", name: "System view", createdBy: "system" },
          viewTypeRegistry,
        );
      } finally {
        client.release();
      }
      try {
        await chokePoint.deleteView({ id: view.id, actor: agentActor(agentA) });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
        expect((err as ForbiddenError).details).toEqual({
          field: "creatorProjectItemId",
          viewId: view.id,
          reason: "system_owned",
        });
      }
    });

    it("a legacy AI view (creator_project_item_id NULL) is unwritable by any agent but adoptable by a user", async () => {
      const db = await makeTasksDb();
      const client = await pool.connect();
      let legacyView;
      try {
        legacyView = await viewsStore.createView(
          client,
          { databaseId: db.id, type: "table", name: "Legacy agent view", createdBy: "ai_agent" },
          viewTypeRegistry,
        );
      } finally {
        client.release();
      }
      expect(legacyView.creatorProjectItemId).toBeNull();

      try {
        await chokePoint.patchView({ id: legacyView.id, actor: agentActor(agentA), name: "Steal" });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
        expect((err as ForbiddenError).details).toEqual({
          field: "creatorProjectItemId",
          viewId: legacyView.id,
          reason: "legacy_creator_unknown",
        });
      }

      const adopted = await chokePoint.patchView({ id: legacyView.id, actor: userActor, name: "Adopted" });
      expect(adopted.createdBy).toBe("user");
      expect(adopted.creatorProjectItemId).toBeNull();
    });

    it("a user's patch to an agent's view adopts it (ai_agent -> user) and clears the creator identity, one-way", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView(
        { databaseId: db.id, type: "table", name: "Agent view" },
        agentActor(agentA),
      );
      const adopted = await chokePoint.patchView({ id: view.id, actor: userActor, name: "Now mine" });
      expect(adopted.createdBy).toBe("user");
      expect(adopted.creatorProjectItemId).toBeNull();

      // Reverse direction never happens: an agent write now fails since it's no longer its own view.
      await expect(
        chokePoint.patchView({ id: view.id, actor: agentActor(agentA), name: "Steal back" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a user's curated-membership write (add/remove/reorder) adopts an agent's view the same way patch does", async () => {
      const view = await chokePoint.createView(
        { type: "list", name: "Agent's collection", config: { membership: "manual" } },
        agentActor(agentA),
      );
      const db = await makeTasksDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "X" } });

      const added = await chokePoint.addViewItem({ viewId: view.id, itemId: item.id, actor: userActor });
      expect(added.viewId).toBe(view.id);
      let current = await chokePoint.getView(view.id);
      expect(current?.createdBy).toBe("user");
      expect(current?.creatorProjectItemId).toBeNull();
      // Adoption already happened, so the agent that created it can no longer write to it.
      await expect(
        chokePoint.reorderViewItem({ viewId: view.id, itemId: item.id, position: 0, actor: agentActor(agentA) }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Same for removeViewItem/reorderViewItem starting from a fresh agent-owned view.
      const view2 = await chokePoint.createView(
        { type: "list", name: "Agent's collection 2", config: { membership: "manual" } },
        agentActor(agentA),
      );
      await chokePoint.addViewItem({ viewId: view2.id, itemId: item.id, actor: agentActor(agentA) });
      await chokePoint.reorderViewItem({ viewId: view2.id, itemId: item.id, position: 0, actor: userActor });
      current = await chokePoint.getView(view2.id);
      expect(current?.createdBy).toBe("user");
      expect(current?.creatorProjectItemId).toBeNull();

      const view3 = await chokePoint.createView(
        { type: "list", name: "Agent's collection 3", config: { membership: "manual" } },
        agentActor(agentA),
      );
      await chokePoint.addViewItem({ viewId: view3.id, itemId: item.id, actor: agentActor(agentA) });
      await chokePoint.removeViewItem({ viewId: view3.id, itemId: item.id, actor: userActor });
      current = await chokePoint.getView(view3.id);
      expect(current?.createdBy).toBe("user");
      expect(current?.creatorProjectItemId).toBeNull();
    });

    it("a user may delete an agent's view outright, with no adoption record needed", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView(
        { databaseId: db.id, type: "table", name: "Agent view" },
        agentActor(agentA),
      );
      await chokePoint.deleteView({ id: view.id, actor: userActor });
      expect(await chokePoint.getView(view.id)).toBeNull();
    });

    it("a user's write to a system view never flips created_by", async () => {
      const db = await makeTasksDb();
      const client = await pool.connect();
      let view;
      try {
        view = await viewsStore.createView(
          client,
          { databaseId: db.id, type: "table", name: "System view", createdBy: "system" },
          viewTypeRegistry,
        );
      } finally {
        client.release();
      }
      const patched = await chokePoint.patchView({ id: view.id, actor: userActor, name: "Renamed" });
      expect(patched.createdBy).toBe("system");
      expect(patched.creatorProjectItemId).toBeNull();
    });

    it("an agent may never set is_default via patch, even on its own view", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView(
        { databaseId: db.id, type: "table", name: "Agent view" },
        agentActor(agentA),
      );
      await expect(
        chokePoint.patchView({ id: view.id, actor: agentActor(agentA), isDefault: true }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("patching or deleting as an agent without actor.agentProjectItemId is rejected before touching the view", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "User view" });
      await expect(
        chokePoint.patchView({ id: view.id, actor: { type: "ai_agent" }, name: "Renamed" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const unchanged = await chokePoint.getView(view.id);
      expect(unchanged?.name).toBe("User view");
    });
  });

  describe("patchView: config is merged, not replaced", () => {
    it("patching one config field preserves the others", async () => {
      const db = await makeTasksDb();
      const view = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "View",
        config: { propertyOrder: ["title", "status"], sort: [{ property: "title", direction: "asc" }] },
      });

      const patched = await chokePoint.patchView({
        id: view.id,
        actor: userActor,
        config: { sort: [{ property: "status", direction: "desc" }] },
      });
      expect(patched.config.propertyOrder).toEqual(["title", "status"]);
      expect(patched.config.sort).toEqual([{ property: "status", direction: "desc" }]);
    });

    it("patching a curated view's config without re-stating membership does not reject it as a curated/filtered switch", async () => {
      const view = await chokePoint.createView({ type: "list", name: "Collection", config: { membership: "manual" } });
      const patched = await chokePoint.patchView({
        id: view.id,
        actor: userActor,
        config: { widths: { title: 200 } },
      });
      expect(patched.config.membership).toBe("manual");
      expect(patched.config.widths).toEqual({ title: 200 });
      expect(patched.databaseId).toBeNull();
    });
  });

  describe("view_items (curated membership)", () => {
    it("add/remove/reorder respects position and only applies to curated views", async () => {
      const db = await makeTasksDb();
      const item1 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "One" } });
      const item2 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Two" } });
      const filtered = await chokePoint.createView({ databaseId: db.id, type: "table", name: "Filtered" });
      await expect(
        chokePoint.addViewItem({ viewId: filtered.id, itemId: item1.id, actor: userActor }),
      ).rejects.toBeInstanceOf(ValidationError);

      const curated = await chokePoint.createView({
        type: "list",
        name: "Collection",
        config: { membership: "manual" },
      });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item1.id, actor: userActor });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item2.id, actor: userActor });
      const members = await chokePoint.listViewItems(curated.id);
      expect(members.map((m) => m.itemId)).toEqual([item1.id, item2.id]);

      await chokePoint.reorderViewItem({ viewId: curated.id, itemId: item2.id, position: 0, actor: userActor });
      const reordered = await chokePoint.listViewItems(curated.id);
      expect(reordered.map((m) => m.itemId)).toEqual([item2.id, item1.id]);

      await chokePoint.removeViewItem({ viewId: curated.id, itemId: item1.id, actor: userActor });
      expect((await chokePoint.listViewItems(curated.id)).map((m) => m.itemId)).toEqual([item2.id]);
    });

    it("inserting at an explicit position shifts existing members instead of tying with them", async () => {
      const db = await makeTasksDb();
      const item1 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "One" } });
      const item2 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Two" } });
      const item3 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Three" } });
      const curated = await chokePoint.createView({
        type: "list",
        name: "Collection",
        config: { membership: "manual" },
      });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item1.id, actor: userActor });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item2.id, actor: userActor });

      await chokePoint.addViewItem({ viewId: curated.id, itemId: item3.id, position: 0, actor: userActor });
      const members = await chokePoint.listViewItems(curated.id);
      expect(members.map((m) => m.itemId)).toEqual([item3.id, item1.id, item2.id]);
      expect(new Set(members.map((m) => m.position)).size).toBe(3); // no ties
    });

    it("re-adding an existing member with a new position moves it instead of duplicating", async () => {
      const db = await makeTasksDb();
      const item1 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "One" } });
      const item2 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Two" } });
      const curated = await chokePoint.createView({
        type: "list",
        name: "Collection",
        config: { membership: "manual" },
      });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item1.id, actor: userActor });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: item2.id, actor: userActor });

      await chokePoint.addViewItem({ viewId: curated.id, itemId: item2.id, position: 0, actor: userActor });
      const members = await chokePoint.listViewItems(curated.id);
      expect(members.map((m) => m.itemId)).toEqual([item2.id, item1.id]);
    });

    it("an agent can only write view_items on its own curated view", async () => {
      const item = await (async () => {
        const db = await makeTasksDb();
        return chokePoint.createItem({ databaseId: db.id, properties: { title: "X" } });
      })();
      const userCollection = await chokePoint.createView({
        type: "list",
        name: "Mine",
        config: { membership: "manual" },
      });
      await expect(
        chokePoint.addViewItem({ viewId: userCollection.id, itemId: item.id, actor: agentActor(agentA) }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const agentCollection = await chokePoint.createView(
        { type: "list", name: "Agent's", config: { membership: "manual" } },
        agentActor(agentA),
      );
      await chokePoint.addViewItem({ viewId: agentCollection.id, itemId: item.id, actor: agentActor(agentA) });
      expect((await chokePoint.listViewItems(agentCollection.id)).map((m) => m.itemId)).toEqual([item.id]);
    });

    it("a curated view can mix items from multiple databases", async () => {
      const dbA = await makeTasksDb();
      const dbB = await chokePoint.createDatabase({ name: "Notes" });
      await chokePoint.createProperty({ databaseId: dbB.id, key: "title", name: "Title", type: "text" });
      const itemA = await chokePoint.createItem({ databaseId: dbA.id, properties: { title: "Task" } });
      const itemB = await chokePoint.createItem({ databaseId: dbB.id, properties: { title: "Note" } });

      const collection = await chokePoint.createView({ type: "list", name: "Mixed", config: { membership: "manual" } });
      await chokePoint.addViewItem({ viewId: collection.id, itemId: itemA.id, actor: userActor });
      await chokePoint.addViewItem({ viewId: collection.id, itemId: itemB.id, actor: userActor });

      const result = await chokePoint.queryView(collection.id);
      expect(result.items.map((i) => i.id).sort()).toEqual([itemA.id, itemB.id].sort());
    });

    it("paginates a curated view with a cursor over position", async () => {
      const db = await makeTasksDb();
      const items = [];
      for (let i = 0; i < 3; i++) {
        items.push(await chokePoint.createItem({ databaseId: db.id, properties: { title: `Item ${i}` } }));
      }
      const collection = await chokePoint.createView({ type: "list", name: "Paged", config: { membership: "manual" } });
      for (const item of items) {
        await chokePoint.addViewItem({ viewId: collection.id, itemId: item.id, actor: userActor });
      }

      const firstPage = await chokePoint.queryView(collection.id, { limit: 2 });
      expect(firstPage.items.map((i) => i.id)).toEqual([items[0]!.id, items[1]!.id]);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await chokePoint.queryView(collection.id, { limit: 2, cursor: firstPage.nextCursor! });
      expect(secondPage.items.map((i) => i.id)).toEqual([items[2]!.id]);
      expect(secondPage.nextCursor).toBeNull();
    });

    it("two concurrent reorders on the same view never leave two items tied on a position", async () => {
      // Two racing reorders don't tie deterministically — the window in which both
      // transactions read the same pre-shift positions is narrow — so run enough
      // parallel pairs that an unlocked reorderViewItem reliably produces a duplicate
      // position at least once, proving the view-level lock (mirroring addViewItem's)
      // actually serializes them.
      const trials = 20;
      for (let trial = 0; trial < trials; trial++) {
        const db = await makeTasksDb();
        const item1 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "One" } });
        const item2 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Two" } });
        const item3 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Three" } });
        const item4 = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Four" } });
        const curated = await chokePoint.createView({
          type: "list",
          name: "Collection",
          config: { membership: "manual" },
        });
        await chokePoint.addViewItem({ viewId: curated.id, itemId: item1.id, actor: userActor });
        await chokePoint.addViewItem({ viewId: curated.id, itemId: item2.id, actor: userActor });
        await chokePoint.addViewItem({ viewId: curated.id, itemId: item3.id, actor: userActor });
        await chokePoint.addViewItem({ viewId: curated.id, itemId: item4.id, actor: userActor });

        await Promise.all([
          chokePoint.reorderViewItem({ viewId: curated.id, itemId: item1.id, position: 3, actor: userActor }),
          chokePoint.reorderViewItem({ viewId: curated.id, itemId: item4.id, position: 0, actor: userActor }),
        ]);

        const members = await chokePoint.listViewItems(curated.id);
        const positions = members.map((m) => m.position);
        expect(new Set(positions).size).toBe(positions.length);
      }
    });
  });

  describe("queryView: filter/sort/visibility push-down", () => {
    async function seedTasks(db: { id: string }, chokePointRef: ChokePoint) {
      const done = await chokePointRef.createItem({
        databaseId: db.id,
        properties: { title: "Ship it", status: "done", tags: ["urgent", "backend"] },
      });
      const todo = await chokePointRef.createItem({
        databaseId: db.id,
        properties: { title: "Write docs", status: "todo", tags: ["docs"] },
      });
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

    it("'is_empty'/'is_not_empty' on a multi_select property check for an empty array, not an empty string", async () => {
      const db = await makeTasksDb();
      await seedTasks(db, chokePoint); // none have empty tags
      const untagged = await chokePoint.createItem({
        databaseId: db.id,
        properties: { title: "Untagged", status: "todo", tags: [] },
      });

      const emptyView = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Untagged",
        config: { filter: { type: "is_empty", property: "tags" } },
      });
      expect((await chokePoint.queryView(emptyView.id)).items.map((i) => i.id)).toEqual([untagged.id]);

      const notEmptyView = await chokePoint.createView({
        databaseId: db.id,
        type: "table",
        name: "Tagged",
        config: { filter: { type: "is_not_empty", property: "tags" } },
      });
      const tagged = (await chokePoint.queryView(notEmptyView.id)).items.map((i) => i.id);
      expect(tagged).not.toContain(untagged.id);
      expect(tagged).toHaveLength(3);
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
      expect(Object.keys(result.items[0]!.properties)).toEqual(["status", "title"]);
    });

    it("getView returns a NotFoundError from queryView for a missing view", async () => {
      await expect(chokePoint.queryView("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
