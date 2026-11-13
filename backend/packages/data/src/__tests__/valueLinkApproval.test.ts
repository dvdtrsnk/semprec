import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { inTenantZero } from "../testSupport/tenantFixtures.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { computeDestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { registerItemPatchApprovalContribution } from "../chokePoint/hooks.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import {
  createRelationWithClient,
  deleteRelationWithClient,
  setRelationWithClient,
} from "../chokePoint/relationOps.js";
import { reserveBreakingLinks } from "../chokePoint/valueLinkApproval.js";
import { changeValueLinkWithClient } from "../chokePoint/valueLinkOps.js";
import { insertValueLink, listValueLinksByItemIds, type ValueLinkSourceInput } from "../chokePoint/valueLinksStore.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { describeBreakingLinks } from "../mcp/approvalBreaksLink.js";
import { withTransaction } from "../db/pool.js";
import { ApprovalRequiredForWrite, ApprovalResourceBusyError, ConflictError } from "../errors.js";

/** Issue #1758: an agent under a run asks for approval before a write ends a value link. */
const USER_ID = "00000000-0000-4000-8000-000000000003";
const RUN_WRITER = {
  writerKind: "agent",
  agentRunId: randomUUID(),
  agentProjectItemId: randomUUID(),
  onBehalfOfUserId: USER_ID,
} as const satisfies WriterIdentity;
const NO_RUN_AGENT = { writerKind: "agent", onBehalfOfUserId: USER_ID } as const satisfies WriterIdentity;
const USER = { writerKind: "user" } as const satisfies WriterIdentity;
const APPROVED = { ...RUN_WRITER, approvedRequestId: randomUUID() } as const satisfies WriterIdentity;

let pool: Pool;
let cp: ChokePoint;

/** Tasks feed Files: a file's `title` and `project` are inherited from its task. */
async function setup(client: ChokePoint = cp) {
  const tasks = await client.createDatabase({ name: "Tasks" });
  await client.createProperty({ databaseId: tasks.id, key: "name", name: "Name", type: "text" });
  const projects = await client.createDatabase({ name: "Projects" });
  await client.createProperty({ databaseId: projects.id, key: "name", name: "Name", type: "text" });
  const files = await client.createDatabase({ name: "Files" });
  await client.createProperty({ databaseId: files.id, key: "name", name: "Name", type: "text" });
  await client.createProperty({ databaseId: files.id, key: "title", name: "Title", type: "text" });
  await client.createProperty({ databaseId: files.id, key: "note", name: "Note", type: "text" });
  // Projects.files is the many side, Files.project the single-valued side.
  const { property: filesProperty, inverseProperty } = await client.createRelationProperty({
    sourceDatabaseId: projects.id,
    key: "files",
    name: "Files",
    targetDatabaseId: files.id,
    cardinality: "one_to_many",
    inverse: { key: "project", name: "Project" },
  });
  const projectProperty = inverseProperty!;
  const task = await client.createItem({ databaseId: tasks.id, properties: { name: "Plan trip" } });
  const alpha = await client.createItem({ databaseId: projects.id, properties: { name: "Alpha" } });
  const beta = await client.createItem({ databaseId: projects.id, properties: { name: "Beta" } });
  const file = await client.createItem({ databaseId: files.id, properties: { name: "a.pdf", title: "Old title" } });
  return { tasks, projects, files, filesProperty, projectProperty, task, alpha, beta, file };
}

async function link(
  itemId: string,
  propertyKey: string,
  sources: ValueLinkSourceInput[] = [],
  state?: "broken",
): Promise<void> {
  await withTransaction(pool, (client) =>
    insertValueLink(client, {
      itemId,
      propertyKey,
      ruleKey: "test",
      ...(state ? { state, brokenBy: "user" as const, brokenAt: new Date("2026-01-01T00:00:00Z") } : {}),
      sources,
    }),
  );
}

async function linkOf(itemId: string, propertyKey: string) {
  const links = await withTransaction(pool, (client) => listValueLinksByItemIds(client, [itemId]));
  return links.find((candidate) => candidate.propertyKey === propertyKey);
}

async function caught(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectDeferral(error: unknown, links: Array<{ itemId: string; propertyKey: string }>): void {
  expect(error).toBeInstanceOf(ApprovalRequiredForWrite);
  if (!(error instanceof ApprovalRequiredForWrite)) return;
  expect(error.reasons).toEqual([{ kind: "breaksLinks", links }]);
}

function patch(itemId: string, databaseId: string, properties: Record<string, unknown>, writer: WriterIdentity) {
  return withTransaction(pool, (client) =>
    updateItemWithClient(client, { databaseId, itemId, propertiesPatch: properties }, { writer }),
  );
}

describe("agent writes that would end a value link (issue #1758)", () => {
  beforeAll(() => {
    pool = getTestPool();
    cp = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  describe("item.patch", () => {
    it("defers an agent under a run that changes a linked value and writes nothing", async () => {
      const { files, file, task } = await setup();
      await link(file.id, "title", [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "name" }]);

      const error = await caught(patch(file.id, files.id, { title: "New title" }, RUN_WRITER));

      expectDeferral(error, [{ itemId: file.id, propertyKey: "title" }]);
      expect((await cp.findItem(file.id))?.properties.title).toBe("Old title");
      expect(await linkOf(file.id, "title")).toMatchObject({ state: "on", brokenBy: null });
    });

    it("lets the same value through and leaves the link on", async () => {
      const { files, file } = await setup();
      await link(file.id, "title");

      await patch(file.id, files.id, { title: "Old title" }, RUN_WRITER);

      expect(await linkOf(file.id, "title")).toMatchObject({ state: "on" });
    });

    it("writes immediately to a property that has no link, next to a linked one it leaves alone", async () => {
      const { files, file } = await setup();
      await link(file.id, "title");

      await patch(file.id, files.id, { note: "Remember" }, RUN_WRITER);

      expect((await cp.findItem(file.id))?.properties.note).toBe("Remember");
      expect(await linkOf(file.id, "title")).toMatchObject({ state: "on" });
    });

    it("writes immediately when the link is already broken", async () => {
      const { files, file } = await setup();
      await link(file.id, "title", [], "broken");

      await patch(file.id, files.id, { title: "New title" }, RUN_WRITER);

      expect((await cp.findItem(file.id))?.properties.title).toBe("New title");
      expect(await linkOf(file.id, "title")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it.each([
      ["a user", USER, "user"],
      ["an agent without a run (an /mcp call with a human session)", NO_RUN_AGENT, "agent"],
    ] as const)("writes immediately for %s and records who broke the link", async (_name, writer, brokenBy) => {
      const { files, file } = await setup();
      await link(file.id, "title");

      await patch(file.id, files.id, { title: "New title" }, writer);

      expect((await cp.findItem(file.id))?.properties.title).toBe("New title");
      expect(await linkOf(file.id, "title")).toMatchObject({ state: "broken", brokenBy });
    });

    it("keeps a system write immediate and the link on", async () => {
      const { files, file } = await setup();
      await link(file.id, "title");

      await patch(file.id, files.id, { title: "New title" }, SYSTEM_WRITER);

      expect(await linkOf(file.id, "title")).toMatchObject({ state: "on" });
    });

    it("executes the approved replay and breaks the link with brokenBy agent", async () => {
      const { files, file } = await setup();
      await link(file.id, "title");

      await patch(file.id, files.id, { title: "New title" }, APPROVED);

      expect((await cp.findItem(file.id))?.properties.title).toBe("New title");
      expect(await linkOf(file.id, "title")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });
  });

  describe("relation.put", () => {
    it("defers a new edge on a linked relation and leaves no edge", async () => {
      const { file, alpha, projectProperty } = await setup();
      await link(file.id, "project");

      const error = await caught(
        withTransaction(pool, (client) =>
          createRelationWithClient(
            client,
            { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
            undefined,
            RUN_WRITER,
          ),
        ),
      );

      expectDeferral(error, [{ itemId: file.id, propertyKey: "project" }]);
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toEqual([]);
      expect(await linkOf(file.id, "project")).toMatchObject({ state: "on" });
    });

    it("defers the same edge put through the other side of the relation", async () => {
      const { file, alpha, filesProperty } = await setup();
      await link(file.id, "project");

      const error = await caught(
        withTransaction(pool, (client) =>
          createRelationWithClient(
            client,
            { relationPropertyId: filesProperty.id, callerItemId: alpha.id, targetItemId: file.id },
            undefined,
            RUN_WRITER,
          ),
        ),
      );

      expectDeferral(error, [{ itemId: file.id, propertyKey: "project" }]);
      expect(await cp.listItemRelations(file.id)).toEqual([]);
    });

    it("writes immediately when the edge already exists", async () => {
      const { file, alpha, projectProperty } = await setup();
      await cp.createRelation(
        { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      await link(file.id, "project");

      await withTransaction(pool, (client) =>
        createRelationWithClient(
          client,
          { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
          undefined,
          RUN_WRITER,
        ),
      );

      expect(await linkOf(file.id, "project")).toMatchObject({ state: "on" });
    });

    it("writes immediately on a relation that has no link", async () => {
      const { file, alpha, projectProperty } = await setup();

      await withTransaction(pool, (client) =>
        createRelationWithClient(
          client,
          { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
          undefined,
          RUN_WRITER,
        ),
      );

      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: alpha.id }]);
    });

    it("executes the approved replay and breaks the link with brokenBy agent", async () => {
      const { file, alpha, projectProperty } = await setup();
      await link(file.id, "project");

      await withTransaction(pool, (client) =>
        createRelationWithClient(
          client,
          { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
          undefined,
          APPROVED,
        ),
      );

      expect(await linkOf(file.id, "project")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("writes immediately for a user and an agent without a run", async () => {
      const { file, alpha, beta, projectProperty } = await setup();
      await link(file.id, "project");
      const put = (targetItemId: string, writer: WriterIdentity) =>
        withTransaction(pool, (client) =>
          createRelationWithClient(
            client,
            { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId },
            undefined,
            writer,
          ),
        );

      await put(alpha.id, NO_RUN_AGENT);
      expect(await linkOf(file.id, "project")).toMatchObject({ state: "broken", brokenBy: "agent" });
      await expect(put(beta.id, USER)).rejects.toMatchObject({ code: "cardinality_violation" });
    });
  });

  describe("relation.set", () => {
    async function withProject() {
      const fixture = await setup();
      await cp.createRelation(
        {
          relationPropertyId: fixture.projectProperty.id,
          callerItemId: fixture.file.id,
          targetItemId: fixture.alpha.id,
        },
        SYSTEM_WRITER,
      );
      return fixture;
    }

    const set = (
      relationPropertyId: string,
      callerItemId: string,
      targetItemId: string | null,
      writer: WriterIdentity,
    ) =>
      withTransaction(pool, (client) =>
        setRelationWithClient(client, { relationPropertyId, callerItemId, targetItemId }, writer),
      );

    it("defers replacing a different edge on a linked relation and leaves the edge", async () => {
      const { file, alpha, beta, projectProperty } = await withProject();
      await link(file.id, "project");

      const error = await caught(set(projectProperty.id, file.id, beta.id, RUN_WRITER));

      expectDeferral(error, [{ itemId: file.id, propertyKey: "project" }]);
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: alpha.id }]);
      expect(await linkOf(file.id, "project")).toMatchObject({ state: "on" });
    });

    it("defers clearing a linked relation", async () => {
      const { file, projectProperty } = await withProject();
      await link(file.id, "project");

      const error = await caught(set(projectProperty.id, file.id, null, RUN_WRITER));

      expectDeferral(error, [{ itemId: file.id, propertyKey: "project" }]);
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toHaveLength(1);
    });

    it("writes immediately onto an empty relation, which removes no value, and breaks the link as agent", async () => {
      const { file, alpha, projectProperty } = await setup();
      await link(file.id, "project");

      await set(projectProperty.id, file.id, alpha.id, RUN_WRITER);

      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: alpha.id }]);
      expect(await linkOf(file.id, "project")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("writes immediately when the replaced edge has no active link", async () => {
      const { file, beta, projectProperty } = await withProject();
      await link(file.id, "project", [], "broken");

      await set(projectProperty.id, file.id, beta.id, RUN_WRITER);

      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: beta.id }]);
    });

    it("writes immediately when the relation has no link row at all", async () => {
      const { file, beta, projectProperty } = await withProject();

      await set(projectProperty.id, file.id, beta.id, RUN_WRITER);

      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: beta.id }]);
    });

    it("changes nothing when the edge is already the target", async () => {
      const { file, alpha, projectProperty } = await withProject();
      await link(file.id, "project");

      await set(projectProperty.id, file.id, alpha.id, RUN_WRITER);

      expect(await linkOf(file.id, "project")).toMatchObject({ state: "on" });
    });

    it("defers when only the added edge's other side has an active link", async () => {
      const { file, alpha, beta, projectProperty } = await withProject();
      await link(beta.id, "files");

      const error = await caught(set(projectProperty.id, file.id, beta.id, RUN_WRITER));

      expectDeferral(error, [{ itemId: beta.id, propertyKey: "files" }]);
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: alpha.id }]);
    });

    it("executes the approved replay once and breaks the link with brokenBy agent", async () => {
      const { file, beta, projectProperty } = await withProject();
      await link(file.id, "project");

      await set(projectProperty.id, file.id, beta.id, APPROVED);

      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: beta.id }]);
      expect(await linkOf(file.id, "project")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("writes immediately for a user and an agent without a run", async () => {
      const { file, alpha, beta, projectProperty } = await withProject();
      await link(file.id, "project");

      await set(projectProperty.id, file.id, beta.id, NO_RUN_AGENT);
      expect(await linkOf(file.id, "project")).toMatchObject({ state: "broken", brokenBy: "agent" });
      await set(projectProperty.id, file.id, alpha.id, USER);
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: alpha.id }]);
    });
  });

  describe("relation.delete", () => {
    it("adds no trigger at the choke point: the gateway already defers every delete", async () => {
      const { file, alpha, projectProperty } = await setup();
      await cp.createRelation(
        { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      await link(file.id, "project");

      await withTransaction(pool, (client) =>
        deleteRelationWithClient(
          client,
          { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
          undefined,
          RUN_WRITER,
        ),
      );

      expect(await cp.listItemRelations(file.id, projectProperty.id)).toEqual([]);
      expect(await linkOf(file.id, "project")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });
  });

  describe("link.unlink", () => {
    const unlink = (itemId: string, writer: WriterIdentity & { writerKind: "user" | "agent" }) =>
      withTransaction(pool, (client) =>
        changeValueLinkWithClient(client, { itemId, propertyKey: "title" }, "unlink", writer),
      );

    it("defers an agent under a run that ends an active link", async () => {
      const { file } = await setup();
      await link(file.id, "title");

      const error = await caught(unlink(file.id, RUN_WRITER));

      expectDeferral(error, [{ itemId: file.id, propertyKey: "title" }]);
      expect(await linkOf(file.id, "title")).toMatchObject({ state: "on", brokenBy: null });
    });

    it("leaves unlinking a link that is already broken the idempotent no-op", async () => {
      const { file } = await setup();
      await link(file.id, "title", [], "broken");

      const result = await unlink(file.id, RUN_WRITER);

      expect(result).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
    });

    it.each([
      ["a user", { writerKind: "user" }, "user"],
      ["an agent without a run", { writerKind: "agent", onBehalfOfUserId: USER_ID }, "agent"],
    ] as const)("ends the link at once for %s", async (_name, writer, brokenBy) => {
      const { file } = await setup();
      await link(file.id, "title");

      await unlink(file.id, writer);

      expect(await linkOf(file.id, "title")).toMatchObject({ state: "broken", brokenBy });
    });

    it("ends the link with brokenBy agent on the approved replay", async () => {
      const { file } = await setup();
      await link(file.id, "title");

      await unlink(file.id, APPROVED);

      expect(await linkOf(file.id, "title")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });
  });

  describe("approval snapshot", () => {
    function project(check: Parameters<typeof computeDestructiveResourceProjection>[1]) {
      return inTenantZero(() => withTransaction(pool, (client) => computeDestructiveResourceProjection(client, check)));
    }

    it("covers the link and its sources, and is deterministic until either changes", async () => {
      const { file, task } = await setup();
      await link(file.id, "title", [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "name" }]);
      const check = {
        operation: "item.patch",
        input: { itemId: file.id, properties: { title: "New title" } },
      } as const;

      const first = await project(check);
      const second = await project(check);

      expect(first.snapshot).toEqual(second.snapshot);
      expect(first.valueLinks?.links).toMatchObject([
        { itemId: file.id, propertyKey: "title", sources: [{ kind: "item", sourceItemId: task.id }] },
      ]);
      await cp.unlinkValue({ itemId: file.id, propertyKey: "title" }, "user");
      const afterUnlink = await project(check);
      expect(afterUnlink.valueLinks).toBeUndefined();
      expect(afterUnlink.snapshot.sha256).not.toBe(first.snapshot.sha256);
    });

    it("covers the current value of the linked property instead of the item version", async () => {
      const { files, file } = await setup();
      await link(file.id, "title");
      const check = {
        operation: "item.patch",
        input: { itemId: file.id, properties: { title: "New title" } },
      } as const;
      const first = await project(check);

      await cp.updateItem({ databaseId: files.id, itemId: file.id, propertiesPatch: { note: "unrelated" } });
      const afterUnrelated = await project(check);
      await cp.updateItem({ databaseId: files.id, itemId: file.id, propertiesPatch: { title: "Changed elsewhere" } });
      const afterValue = await project(check);

      expect(afterUnrelated.snapshot.sha256).toBe(first.snapshot.sha256);
      expect(afterValue.snapshot.sha256).not.toBe(first.snapshot.sha256);
    });

    it("reports no links for a patch of an unlinked or unchanged property", async () => {
      const { file } = await setup();
      await link(file.id, "title");

      const unlinked = await project({
        operation: "item.patch",
        input: { itemId: file.id, properties: { note: "x" } },
      });
      const unchanged = await project({
        operation: "item.patch",
        input: { itemId: file.id, properties: { title: "Old title" } },
      });

      expect(unlinked.valueLinks).toBeUndefined();
      expect(unchanged.valueLinks).toBeUndefined();
    });

    it("tells a relation.set that replaces an edge from one onto an empty relation", async () => {
      const { file, alpha, beta, projectProperty } = await setup();
      await link(file.id, "project");
      const check = {
        operation: "relation.set",
        input: { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: beta.id },
      } as const;
      const onEmpty = await project(check);
      await cp.createRelation(
        { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      const replacing = await project(check);
      const same = await project({
        operation: "relation.set",
        input: { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
      });

      expect(onEmpty.valueLinks).toBeUndefined();
      expect(replacing.valueLinks?.links).toMatchObject([{ itemId: file.id, propertyKey: "project" }]);
      expect(same.valueLinks).toBeUndefined();
    });

    it("tells a relation.put of a new edge from a repeat of an existing one, from either side", async () => {
      const { files, file, alpha, beta, projectProperty, filesProperty } = await setup();
      const fresh = await cp.createItem({ databaseId: files.id, properties: { name: "fresh.pdf" } });
      await link(fresh.id, "project");
      await link(file.id, "project");
      await cp.createRelation(
        { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      const newEdge = {
        operation: "relation.put",
        input: { relationPropertyId: projectProperty.id, callerItemId: fresh.id, targetItemId: beta.id },
      } as const;

      const fromFileSide = await project(newEdge);
      const fromProjectSide = await project({
        operation: "relation.put",
        input: { relationPropertyId: filesProperty.id, callerItemId: beta.id, targetItemId: fresh.id },
      });
      const repeat = await project({
        operation: "relation.put",
        input: { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
      });

      expect(fromFileSide.snapshot.kind).toBe("relation_put");
      expect(fromFileSide.valueLinks?.links).toMatchObject([{ itemId: fresh.id, propertyKey: "project" }]);
      expect(fromProjectSide.valueLinks?.links).toMatchObject([{ itemId: fresh.id, propertyKey: "project" }]);
      expect(repeat.valueLinks).toBeUndefined();
      await cp.unlinkValue({ itemId: fresh.id, propertyKey: "project" }, "user");
      const afterUnlink = await project(newEdge);
      expect(afterUnlink.valueLinks).toBeUndefined();
      expect(afterUnlink.snapshot.sha256).not.toBe(fromFileSide.snapshot.sha256);
    });

    it("keeps the item and its version in the hash when the owning module contributes a patch snapshot", async () => {
      registerItemPatchApprovalContribution("linkContributionFixture", async () => ({
        snapshot: { command: "fixture" },
        description: { key: "approval.fixture", params: {} },
      }));
      const owned = await cp.createDatabase({ name: "Owned", ownerModuleId: "linkContributionFixture" });
      await cp.createProperty({ databaseId: owned.id, key: "name", name: "Name", type: "text" });
      await cp.createProperty({ databaseId: owned.id, key: "title", name: "Title", type: "text" });
      await cp.createProperty({ databaseId: owned.id, key: "note", name: "Note", type: "text" });
      const item = await cp.createItem({ databaseId: owned.id, properties: { name: "x", title: "Old" } });
      await link(item.id, "title");
      const check = { operation: "item.patch", input: { itemId: item.id, properties: { title: "New" } } } as const;
      const first = await project(check);

      await cp.updateItem({ databaseId: owned.id, itemId: item.id, propertiesPatch: { note: "unrelated" } });
      const afterUnrelated = await project(check);
      await cp.unlinkValue({ itemId: item.id, propertyKey: "title" }, "user");
      const afterUnlink = await project(check);

      expect(first.valueLinks?.links).toMatchObject([{ itemId: item.id, propertyKey: "title" }]);
      expect(first.currentResource).toMatchObject({ approvalDescription: { key: "approval.fixture" } });
      // Unlike an item without a contribution, an unrelated change to the item moves the hash.
      expect(afterUnrelated.snapshot.sha256).not.toBe(first.snapshot.sha256);
      expect(afterUnlink.valueLinks).toBeUndefined();
    });

    it("reports the links of a relation.delete without covering them in its snapshot", async () => {
      const { file, alpha, projectProperty } = await setup();
      await cp.createRelation(
        { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      await link(file.id, "project");
      const check = {
        operation: "relation.delete",
        input: { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
      } as const;
      const before = await project(check);

      await cp.unlinkValue({ itemId: file.id, propertyKey: "project" }, "user");
      const after = await project(check);

      expect(before.valueLinks?.links).toMatchObject([{ itemId: file.id, propertyKey: "project" }]);
      expect(after.valueLinks).toBeUndefined();
      expect(after.snapshot).toEqual(before.snapshot);
    });

    it("projects a link.unlink and refuses one whose link is no longer active", async () => {
      const { file } = await setup();
      await link(file.id, "title");
      const check = { operation: "link.unlink", input: { itemId: file.id, propertyKey: "title" } } as const;

      const projection = await project(check);
      await cp.unlinkValue({ itemId: file.id, propertyKey: "title" }, "user");

      expect(projection.snapshot.kind).toBe("link_unlink");
      expect(projection.valueLinks?.links).toHaveLength(1);
      await expect(project(check)).rejects.toBeInstanceOf(ConflictError);
    });

    it("refuses a projection while another transaction holds the link", async () => {
      const { file } = await setup();
      await link(file.id, "title");
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM value_links WHERE item_id = $1 FOR UPDATE", [file.id]);

        await expect(
          project({ operation: "item.patch", input: { itemId: file.id, properties: { title: "New title" } } }),
        ).rejects.toBeInstanceOf(ApprovalResourceBusyError);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });
  });

  describe("description of the links", () => {
    function describeLinks(check: Parameters<typeof describeBreakingLinks>[1]) {
      return inTenantZero(() =>
        withTransaction(pool, async (client) => {
          const projection = await computeDestructiveResourceProjection(client, check);
          if (!projection.valueLinks) throw new Error("Expected links");
          return describeBreakingLinks(client, check, projection.valueLinks);
        }),
      );
    }

    it("names the file's project write and the task the file stops following", async () => {
      const { file, task, alpha, beta, projectProperty } = await setup();
      await cp.createRelation(
        { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      await link(file.id, "project", [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "project" }]);

      const approval = await describeLinks({
        operation: "relation.set",
        input: { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: beta.id },
      });

      expect(approval.description).toEqual({
        key: "approval.breaksLink",
        params: {
          itemName: "a.pdf",
          databaseKey: null,
          propertyName: "Project",
          sourceItemName: "Plan trip",
          sourceDatabaseKey: null,
          newValueName: "Beta",
        },
      });
      expect(approval.breaksLinks).toEqual([
        {
          itemId: file.id,
          itemName: "a.pdf",
          propertyKey: "project",
          sourceItemId: task.id,
          sourceItemName: "Plan trip",
          sourceDatabaseKey: null,
          newValueName: "Beta",
        },
      ]);
    });

    it("lists the links that follow the broken property as ending inheritance", async () => {
      const { files, file, task } = await setup();
      const copy = await cp.createItem({ databaseId: files.id, properties: { name: "copy.pdf", title: "Old title" } });
      await link(file.id, "title", [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "name" }]);
      await link(copy.id, "title", [{ kind: "item", sourceItemId: file.id, sourcePropertyKey: "title" }]);

      const approval = await describeLinks({
        operation: "item.patch",
        input: { itemId: file.id, properties: { title: "New title" } },
      });

      expect(approval.endsInheritance).toEqual([{ itemId: copy.id, propertyKey: "title", sourceName: "a.pdf" }]);
      expect(approval.description.params).toMatchObject({ propertyName: "Title", newValueName: "New title" });
    });

    it("names a sender-domain source by its domain and a link without sources by null", async () => {
      const { file, files } = await setup();
      const other = await cp.createItem({ databaseId: files.id, properties: { name: "b.pdf", title: "Old title" } });
      await link(file.id, "title", [{ kind: "senderDomain", domain: "example.test", sourcePropertyKey: "domain" }]);
      await link(other.id, "title");

      const byDomain = await describeLinks({
        operation: "item.patch",
        input: { itemId: file.id, properties: { title: "New title" } },
      });
      const bare = await describeLinks({
        operation: "item.patch",
        input: { itemId: other.id, properties: { title: "New title" } },
      });

      expect(byDomain.breaksLinks).toMatchObject([
        { sourceItemId: null, sourceItemName: "example.test", sourceDatabaseKey: null },
      ]);
      expect(bare.breaksLinks).toMatchObject([{ sourceItemId: null, sourceItemName: null, sourceDatabaseKey: null }]);
    });

    it("describes an unlink by the value the property keeps", async () => {
      const { file, task } = await setup();
      await link(file.id, "title", [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "name" }]);

      const approval = await describeLinks({
        operation: "link.unlink",
        input: { itemId: file.id, propertyKey: "title" },
      });

      expect(approval.description.params).toMatchObject({
        propertyName: "Title",
        sourceItemName: "Plan trip",
        newValueName: "Old title",
      });
    });
  });

  describe("tenants", () => {
    it("never reserves the links of another tenant, through the runtime role", async () => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const tenantA = await createTestTenant(pool);
        const tenantB = await createTestTenant(pool);
        const foreign = await runInTenant(tenantB, async () => {
          const bCp = createChokePoint(runtime);
          const fixture = await setup(bCp);
          await withTransaction(runtime, (client) =>
            insertValueLink(client, { itemId: fixture.file.id, propertyKey: "title", ruleKey: "test", sources: [] }),
          );
          return fixture.file.id;
        });

        const fromB = await runInTenant(tenantB, () =>
          withTransaction(runtime, (client) =>
            reserveBreakingLinks(client, [{ itemId: foreign, propertyKey: "title" }]),
          ),
        );
        const fromA = await runInTenant(tenantA, () =>
          withTransaction(runtime, (client) =>
            reserveBreakingLinks(client, [{ itemId: foreign, propertyKey: "title" }]),
          ),
        );

        expect(fromB.links).toHaveLength(1);
        expect(fromA.links).toEqual([]);
      } finally {
        await runtime.end();
      }
    });
  });
});
