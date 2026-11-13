import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { computeDeleteImpact, type DeleteImpact } from "../deleteImpact.js";
import { insertValueLink } from "../../chokePoint/valueLinksStore.js";
import { withTransaction } from "../../db/pool.js";
import { createSubpageWithClient } from "../../docs/pageOperations.js";
import { ForbiddenError } from "../../errors.js";
import type { DatabaseReader } from "../../agentGrants/agentDatabaseAccess.js";
import { setAgentDatabaseGrant } from "../../agentGrants/agentDatabaseGrantsAdminStore.js";
import {
  createCollectionMetadataResolver,
  type CollectionMetadataResolver,
} from "../../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import type { DatabaseRow, ItemRow } from "../../types.js";

// Seeding the system databases of one tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let resolver: CollectionMetadataResolver;
const databases = new Map<string, DatabaseRow>();

function inTenant<T>(work: () => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, work);
}

function database(key: string): DatabaseRow {
  const found = databases.get(key);
  if (!found) throw new Error(`Missing seeded database '${key}'`);
  return found;
}

function make(key: string, properties: Record<string, unknown> = {}): Promise<ItemRow> {
  return inTenant(() => cp.createItem({ databaseId: database(key).id, properties: { name: key, ...properties } }));
}

/** Links `from` to `to` through the relation property `key` of the database `from` belongs to, as a user write does. */
async function link(from: Pick<ItemRow, "id" | "databaseId">, key: string, to: Pick<ItemRow, "id">): Promise<void> {
  await inTenant(async () => {
    const property = (await cp.listProperties(from.databaseId)).find((candidate) => candidate.key === key);
    if (!property) throw new Error(`Missing relation property '${key}'`);
    await cp.createRelation({ relationPropertyId: property.id, callerItemId: from.id, targetItemId: to.id });
  });
}

/** The impact of deleting `itemId`; a missing item fails the test, as `impactOrNull` is for the not-found cases. */
async function impact(itemId: string, reader?: DatabaseReader): Promise<DeleteImpact> {
  const found = await impactOrNull(itemId, reader);
  if (found === null) throw new Error(`Item ${itemId} is not found`);
  return found;
}

function impactOrNull(itemId: string, reader?: DatabaseReader, tenantId = tenant): Promise<DeleteImpact | null> {
  return inTenant(
    () => withTransaction(pool, (client) => computeDeleteImpact(client, itemId, resolver, reader)),
    tenantId,
  );
}

/** `{ databaseKey: count }` of the `related` part, so a test names the collections and not their order. */
function relatedCounts(result: DeleteImpact): Record<string, number> {
  return Object.fromEntries(result.related.map((row) => [row.databaseKey ?? "(user database)", row.count]));
}

/** A user-created database with an owner item (an inline database) and `size` records without properties. */
async function inlineDatabase(
  parent: Pick<ItemRow, "id">,
  size: number,
): Promise<{ db: DatabaseRow; rows: ItemRow[] }> {
  return inTenant(async () => {
    const db = await cp.createInlineDatabase({ name: `Inline ${randomUUID()}`, parentItemId: parent.id });
    const rows: ItemRow[] = [];
    for (let index = 0; index < size; index += 1) {
      rows.push(await cp.createItem({ databaseId: db.id, properties: {} }));
    }
    return { db, rows };
  });
}

async function subpage(parentItemId: string, title: string): Promise<string> {
  const created = await inTenant(() =>
    withTransaction(pool, (client) =>
      createSubpageWithClient(client, { parent: { itemId: parentItemId }, title }, "user"),
    ),
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing created page");
  return page.pageItemId;
}

describe("computeDeleteImpact (issue #1856)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(pool));
    databases.clear();
    for (const db of await inTenant(() => cp.listDatabases())) if (db.key !== null) databases.set(db.key, db);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool.end();
  });

  describe("related", () => {
    it("counts the tasks, files and events of a project, Tasks included although the related panel omits them", async () => {
      const project = await make("projects");
      for (const task of [await make("tasks"), await make("tasks")]) await link(task, "project", project);
      const file = await make("files");
      await link(file, "projects", project);
      for (const event of [
        await make("events", { date: "2026-10-16" }),
        await make("events", { date: "2026-10-17" }),
      ]) {
        await link(event, "project", project);
      }
      // Records of the same databases that are not connected to the project.
      await make("tasks");
      await make("files");

      const result = await impact(project.id);

      expect(result.related).toEqual([
        { databaseKey: "events", count: 2 },
        { databaseKey: "files", count: 1 },
        { databaseKey: "tasks", count: 2 },
      ]);
      expect(result.subtreeItemCount).toBe(0);
      expect(result.subtreePageCount).toBe(0);
      // The shipped link rule gives the file a link to the project's company, with the project as its source.
      expect(result.linksToOwn).toEqual([{ itemId: file.id, propertyKey: "companies" }]);
    });

    it("leaves a soft-deleted connected record out of the count", async () => {
      const project = await make("projects");
      const kept = await make("tasks");
      const trashed = await make("tasks");
      await link(kept, "project", project);
      await link(trashed, "project", project);
      await inTenant(() => cp.softDeleteItem(trashed.databaseId, trashed.id));

      expect(relatedCounts(await impact(project.id))).toEqual({ tasks: 1 });
    });

    it("returns an empty list for an item with no connected record", async () => {
      expect((await impact((await make("projects")).id)).related).toEqual([]);
    });
  });

  describe("subtreeItemCount", () => {
    it("counts the three records of an inline database and not the item itself", async () => {
      const project = await make("projects");
      await inlineDatabase(project, 3);

      expect((await impact(project.id)).subtreeItemCount).toBe(3);
    });

    it("counts the records of inline databases nested at every depth", async () => {
      const project = await make("projects");
      const first = await inlineDatabase(project, 3);
      const second = await inlineDatabase(first.rows[0]!, 2);
      await inlineDatabase(second.rows[0]!, 1);

      expect((await impact(project.id)).subtreeItemCount).toBe(6);
      // Below the first record only its own nested databases count.
      expect((await impact(first.rows[0]!.id)).subtreeItemCount).toBe(3);
    });

    it("counts the live records below a record in the Trash, and not the trashed ones", async () => {
      const project = await make("projects");
      const first = await inlineDatabase(project, 2);
      const nested = await inlineDatabase(first.rows[0]!, 2);
      // The cascade trashes the record and its nested records; one nested record is restored on its own.
      await inTenant(() => cp.softDeleteItem(first.db.id, first.rows[0]!.id));
      await inTenant(() => cp.restoreItem(nested.db.id, nested.rows[0]!.id));

      expect((await impact(project.id)).subtreeItemCount).toBe(2);
    });
  });

  describe("subtreePageCount", () => {
    it("is 0 for a page without a subpage and 1 for a page with one subpage", async () => {
      const host = await make("projects");
      const page = await subpage(host.id, "Plan");
      expect((await impact(page)).subtreePageCount).toBe(0);

      await subpage(page, "Step");

      expect((await impact(page)).subtreePageCount).toBe(1);
    });

    it("is 3 for a page with two subpages, one of which has a nested page", async () => {
      const host = await make("projects");
      const page = await subpage(host.id, "Plan");
      const first = await subpage(page, "A");
      await subpage(page, "B");
      await subpage(first, "Nested under A");

      expect((await impact(page)).subtreePageCount).toBe(3);
    });

    it("counts every page below a host, the page of the host included", async () => {
      const host = await make("projects");
      const page = await subpage(host.id, "Plan");
      await subpage(page, "A");
      await subpage(page, "B");

      expect((await impact(host.id)).subtreePageCount).toBe(3);
    });

    it("leaves a subpage in the Trash out of the count", async () => {
      const host = await make("projects");
      const page = await subpage(host.id, "Plan");
      await subpage(page, "Kept");
      const trashed = await subpage(page, "Trashed");
      const trashedItem = await inTenant(() => cp.findItem(trashed));
      if (!trashedItem) throw new Error("Missing page item");
      await inTenant(() => cp.softDeleteItem(trashedItem.databaseId, trashed));

      expect((await impact(page)).subtreePageCount).toBe(1);
    });
  });

  describe("linksToOwn", () => {
    /** Two files whose `companies` value is inherited from the project's company through the shipped link rule. */
    async function projectWithLinkedFiles() {
      const company = await make("companies");
      const project = await make("projects");
      await link(project, "company", company);
      const first = await make("files");
      const second = await make("files");
      await link(first, "projects", project);
      await link(second, "projects", project);
      return { company, project, files: [first, second].sort((a, b) => (a.id < b.id ? -1 : 1)) };
    }

    it("lists each item whose value is taken over from the item, with its property key", async () => {
      const { project, files } = await projectWithLinkedFiles();

      expect((await impact(project.id)).linksToOwn).toEqual(
        files.map((file) => ({ itemId: file.id, propertyKey: "companies" })),
      );
    });

    it("lists nothing for an item no value is taken over from, the holder of a link included", async () => {
      const { company, files } = await projectWithLinkedFiles();

      expect((await impact(files[0]!.id)).linksToOwn).toEqual([]);
      expect((await impact(company.id)).linksToOwn).toEqual([]);
    });

    it("still lists a link its holder has unlinked, and lists a holder with two sources naming the item once", async () => {
      const { project, files } = await projectWithLinkedFiles();
      await inTenant(() => cp.unlinkValue({ itemId: files[0]!.id, propertyKey: "companies" }, "user"));
      const holder = await make("files");
      // No shipped rule gives one link two sources that name the same item; the store's insert builds that state.
      await inTenant(() =>
        withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: holder.id,
            propertyKey: "projects",
            ruleKey: "test.twoSources",
            sources: [
              { kind: "item", sourceItemId: project.id, sourcePropertyKey: "company" },
              { kind: "item", sourceItemId: project.id, sourcePropertyKey: "area" },
            ],
          }),
        ),
      );

      const listed = (await impact(project.id)).linksToOwn;

      expect(listed).toHaveLength(3);
      expect(listed).toEqual(
        expect.arrayContaining([
          { itemId: files[0]!.id, propertyKey: "companies" },
          { itemId: files[1]!.id, propertyKey: "companies" },
          { itemId: holder.id, propertyKey: "projects" },
        ]),
      );
    });

    it("leaves a holder in the Trash out", async () => {
      const { project, files } = await projectWithLinkedFiles();
      await inTenant(() => cp.softDeleteItem(files[0]!.databaseId, files[0]!.id));

      expect((await impact(project.id)).linksToOwn).toEqual([{ itemId: files[1]!.id, propertyKey: "companies" }]);
    });
  });

  describe("not found", () => {
    it("answers null for an unknown id, an item in the Trash and an item of another tenant alike", async () => {
      const project = await make("projects");
      const trashed = await make("projects");
      await inTenant(() => cp.softDeleteItem(trashed.databaseId, trashed.id));
      const otherTenant = await createTestTenant(admin);
      await inTenant(() => seedSystem(pool), otherTenant);

      expect(await impactOrNull(randomUUID())).toBeNull();
      expect(await impactOrNull(trashed.id)).toBeNull();
      expect(await impactOrNull(project.id, undefined, otherTenant)).toBeNull();
      // The owner still reads its item.
      expect(await impactOrNull(project.id)).not.toBeNull();
    });

    it("sees nothing of another tenant's links, pages and records", async () => {
      const mine = await make("projects");
      const otherTenant = await createTestTenant(admin);
      await inTenant(() => seedSystem(pool), otherTenant);
      const theirs = await inTenant(async () => {
        const dbs = await cp.listDatabases();
        const projects = dbs.find((candidate) => candidate.key === "projects");
        if (!projects) throw new Error("Missing the projects database of the other tenant");
        const item = await cp.createItem({ databaseId: projects.id, properties: { name: "theirs" } });
        const inline = await cp.createInlineDatabase({ name: "Theirs inline", parentItemId: item.id });
        await cp.createItem({ databaseId: inline.id, properties: {} });
        return item;
      }, otherTenant);

      expect(await impactOrNull(theirs.id)).toBeNull();
      expect((await impact(mine.id)).subtreeItemCount).toBe(0);
      expect((await impactOrNull(theirs.id, undefined, otherTenant))?.subtreeItemCount).toBe(1);
    });
  });

  describe("a reader", () => {
    let agentProject: string;

    beforeEach(async () => {
      agentProject = await inTenant(() => createTestProjectItem(pool));
    });

    function setAccess(databaseId: string, access: "none" | "read") {
      return inTenant(() =>
        withTransaction(pool, (client) =>
          setAgentDatabaseGrant(client, { projectItemId: agentProject, databaseId, access }),
        ),
      );
    }

    it("counts the records of an inline database it may read, and not those of one it may not", async () => {
      const project = await make("projects");
      await inlineDatabase(project, 2);
      const closed = await inlineDatabase(project, 3);
      await setAccess(closed.db.id, "none");

      expect((await impact(project.id, agentProject)).subtreeItemCount).toBe(2);
      // A person reads every database regardless of any grant.
      expect((await impact(project.id)).subtreeItemCount).toBe(5);

      await setAccess(closed.db.id, "read");
      expect((await impact(project.id, agentProject)).subtreeItemCount).toBe(5);
    });

    it("leaves a collection it may not read out of related", async () => {
      const project = await make("projects");
      const notes = await inTenant(() => cp.createDatabase({ name: "Notes" }));
      const { property } = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: notes.id,
          key: "project",
          name: "Project",
          targetDatabaseId: project.databaseId,
        }),
      );
      const note = await inTenant(() => cp.createItem({ databaseId: notes.id, properties: {} }));
      await inTenant(() =>
        cp.createRelation({ relationPropertyId: property.id, callerItemId: note.id, targetItemId: project.id }),
      );

      expect(relatedCounts(await impact(project.id, agentProject))).toEqual({ "(user database)": 1 });
      await setAccess(notes.id, "none");
      expect((await impact(project.id, agentProject)).related).toEqual([]);
      expect(relatedCounts(await impact(project.id))).toEqual({ "(user database)": 1 });
    });

    it("leaves a holder in a database it may not read out of linksToOwn", async () => {
      const project = await make("projects");
      const notes = await inTenant(() => cp.createDatabase({ name: "Notes" }));
      const holder = await inTenant(() => cp.createItem({ databaseId: notes.id, properties: {} }));
      // No shipped rule writes a link onto an item of a user-created database; the store's insert builds that state.
      await inTenant(() =>
        withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: holder.id,
            propertyKey: "name",
            ruleKey: "test.userDatabaseHolder",
            sources: [{ kind: "item", sourceItemId: project.id, sourcePropertyKey: "name" }],
          }),
        ),
      );
      const listed = [{ itemId: holder.id, propertyKey: "name" }];
      expect((await impact(project.id, agentProject)).linksToOwn).toEqual(listed);

      await setAccess(notes.id, "none");

      expect((await impact(project.id, agentProject)).linksToOwn).toEqual([]);
      expect((await impact(project.id)).linksToOwn).toEqual(listed);
    });

    it("is refused an item of a database it may not read, and an external client one of a sensitive database", async () => {
      const notes = await inTenant(() => cp.createDatabase({ name: "Notes" }));
      const note = await inTenant(() => cp.createItem({ databaseId: notes.id, properties: {} }));
      await setAccess(notes.id, "none");
      const healthRecord = await make("healthRecords");

      await expect(impact(note.id, agentProject)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(impact(healthRecord.id, { externalClient: true })).rejects.toBeInstanceOf(ForbiddenError);
      expect(await impactOrNull(note.id)).not.toBeNull();
      expect(await impactOrNull(healthRecord.id)).not.toBeNull();
    });
  });

  it("changes no row", async () => {
    const project = await make("projects");
    await inlineDatabase(project, 2);
    await subpage(project.id, "Plan");
    const countRows = async () => {
      const { rows } = await admin.query<{ items: string; links: string; pages: string }>(
        `SELECT (SELECT count(*) FROM items)::text AS items, (SELECT count(*) FROM value_links)::text AS links,
                (SELECT count(*) FROM doc_updates)::text AS pages`,
      );
      return rows;
    };
    const before = await countRows();

    await impact(project.id);

    expect(await countRows()).toEqual(before);
  });
});
