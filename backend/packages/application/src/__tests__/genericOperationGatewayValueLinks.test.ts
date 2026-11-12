import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { CollectionMetadataResolver } from "@semprec/data";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  ApprovalRequiredError,
  ApprovalRequiredForWrite,
  SYSTEM_WRITER,
  createAgentRun,
  createChokePoint,
  createUser as createAuthUser,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  insertValueLink,
  isGenericOperationApprovalRequestPayload,
  listApprovalRequestsQueue,
  seedSystem,
  toApprovalRequestDecisionView,
  createViewTypeRegistry,
  ValidationError,
  withTransaction,
  type ApprovalRequest,
  type ChokePoint,
} from "@semprec/data";
import {
  CAPABILITY_IDS,
  runInTenant,
  type AuthenticatedActor,
  type GenericOperationName,
  type InputByOperation,
} from "@semprec/shared";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "../genericOperationGateway.js";

/** Issue #1758: an agent write that would end a value link waits for approval, and the replay revalidates the link. */

const metadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};
const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const LOCALE = "en";

let pool: Pool;
let cp: ChokePoint;

function readCatalog(): Record<string, string> {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../../../data/src/seed/i18n/en.json", import.meta.url), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null) throw new Error("Malformed catalog");
  const entries = Object.entries(parsed).map(([key, value]): [string, string] => {
    if (typeof value !== "string") throw new Error(`Malformed catalog entry ${key}`);
    return [key, value];
  });
  return Object.fromEntries(entries);
}

const catalog = readCatalog();

function render(key: string, params: Record<string, string | number | null>): string {
  const template = catalog[key];
  if (template === undefined) throw new Error(`No template ${key}`);
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]));
}

/** Tasks feed Files: a file's `project` relation and its `title` are inherited from its task. */
async function fixture(client: ChokePoint = cp) {
  const tasks = await client.createDatabase({ name: "Tasks" });
  await client.createProperty({ databaseId: tasks.id, key: "name", name: "Name", type: "text" });
  const projects = await client.createDatabase({ name: "Projects" });
  await client.createProperty({ databaseId: projects.id, key: "name", name: "Name", type: "text" });
  const files = await client.createDatabase({ name: "Files" });
  await client.createProperty({ databaseId: files.id, key: "name", name: "Name", type: "text" });
  await client.createProperty({ databaseId: files.id, key: "title", name: "Title", type: "text" });
  await client.createProperty({ databaseId: files.id, key: "note", name: "Note", type: "text" });
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
  await client.createRelation(
    { relationPropertyId: projectProperty.id, callerItemId: file.id, targetItemId: alpha.id },
    SYSTEM_WRITER,
  );
  return { files, projects, filesProperty, projectProperty, task, alpha, beta, file };
}

async function link(
  runtime: Pool,
  itemId: string,
  propertyKey: string,
  sourceItemId: string,
  sourcePropertyKey: string,
): Promise<void> {
  await withTransaction(runtime, (client) =>
    insertValueLink(client, {
      itemId,
      propertyKey,
      ruleKey: "test",
      sources: [{ kind: "item", sourceItemId, sourcePropertyKey }],
    }),
  );
}

async function linkState(runtime: Pool, itemId: string, propertyKey: string) {
  const { rows } = await runtime.query<{ state: string; broken_by: string | null }>(
    "SELECT state, broken_by FROM value_links WHERE item_id = $1 AND property_key = $2",
    [itemId, propertyKey],
  );
  return rows[0] ?? null;
}

async function versionOf(itemId: string): Promise<string> {
  const item = await cp.findItem(itemId);
  if (!item) throw new Error("Item not found");
  return item.updatedAt;
}

async function agent(runtime: Pool): Promise<AuthenticatedActor> {
  const projectItemId = randomUUID();
  const run = await createAgentRun(runtime, { projectItemId, triggeredBy: "user", task: "tidy files" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

async function request<K extends GenericOperationName>(
  gateway: ReturnType<typeof createGenericOperationGateway>,
  runtime: Pool,
  operation: K,
  actor: AuthenticatedActor,
  input: InputByOperation[K],
): Promise<ApprovalRequest> {
  const outcome = await gateway.invoke(operation, actor, ALL_CAPABILITIES, input).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ApprovalRequiredError)) {
    throw new Error("Expected the write to wait for approval", { cause: outcome });
  }
  const created = await getApprovalRequest(runtime, outcome.details.approvalRequestId);
  if (!created) throw new Error("The request was not stored");
  return created;
}

function decide(runtime: Pool, requestId: string, actor: AuthenticatedActor, decision: "approved" | "rejected") {
  return withTransaction(runtime, (client) =>
    decideAndEnqueueApprovalRequest(client, { approvalRequestId: requestId, decision, decidedByUserId: actor.userId }),
  );
}

async function replay(runtime: Pool, requestId: string) {
  const stored = await getApprovalRequest(runtime, requestId);
  if (!stored || !isGenericOperationApprovalRequestPayload(stored.payload)) throw new Error("Expected generic request");
  return replayApprovedGenericOperation(runtime, { ...stored, payload: stored.payload });
}

describe("agent writes that would end a value link wait for approval (issue #1758)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    cp ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createTenantZeroUser(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("defers an agent changing the project of a file that follows a task and leaves file and link unchanged", () =>
    inTenantZero(async () => {
      const { projectProperty, task, alpha, beta, file } = await fixture();
      await link(pool, file.id, "project", task.id, "project");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);

      const created = await request(gateway, pool, "relation.set", actor, {
        relationPropertyId: projectProperty.id,
        callerItemId: file.id,
        targetItemId: beta.id,
      });

      expect(created.riskClass).toBe("breaksLink");
      expect(created.status).toBe("pending");
      expect(created.description?.breaksLinks).toEqual([
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
      expect(created.description?.endsInheritance).toEqual([]);
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: alpha.id }]);
      expect(await linkState(pool, file.id, "project")).toEqual({ state: "on", broken_by: null });
    }));

  it("renders a description that names the write of the file's project relation and the task it stops following", () =>
    inTenantZero(async () => {
      const { projectProperty, task, beta, file } = await fixture();
      await link(pool, file.id, "project", task.id, "project");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);

      const created = await request(gateway, pool, "relation.set", actor, {
        relationPropertyId: projectProperty.id,
        callerItemId: file.id,
        targetItemId: beta.id,
      });

      expect(created.description?.key).toBe("approval.breaksLink");
      const text = render("approval.breaksLink", created.description?.params ?? {});
      expect(text).toBe(
        'Set Project of "a.pdf" (null) to "Beta". This ends the link to "Plan trip" (null); the item stops following it.',
      );
      expect(text).not.toMatch(/change/i);
    }));

  it("carries the same breaksLinks and endsInheritance on the queue entry and on the single-request view", () =>
    inTenantZero(async () => {
      const { files, projectProperty, task, beta, file } = await fixture();
      const copy = await cp.createItem({ databaseId: files.id, properties: { name: "copy.pdf", title: "Old title" } });
      await link(pool, file.id, "project", task.id, "project");
      await link(pool, copy.id, "project", file.id, "project");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);

      const created = await request(gateway, pool, "relation.set", actor, {
        relationPropertyId: projectProperty.id,
        callerItemId: file.id,
        targetItemId: beta.id,
      });

      const [entry] = await listApprovalRequestsQueue(pool, actor.userId, LOCALE);
      const view = await toApprovalRequestDecisionView(pool, created, LOCALE);
      expect(entry?.riskLevel).toBe("breaksLink");
      expect(entry?.breaksLinks).toHaveLength(1);
      expect(entry?.endsInheritance).toEqual([{ itemId: copy.id, propertyKey: "project", sourceName: "a.pdf" }]);
      expect(view.breaksLinks).toEqual(entry?.breaksLinks);
      expect(view.endsInheritance).toEqual(entry?.endsInheritance);
    }));

  it("executes the approved write once and breaks the link with broken_by agent", () =>
    inTenantZero(async () => {
      const { projectProperty, task, beta, file } = await fixture();
      await link(pool, file.id, "project", task.id, "project");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);
      const created = await request(gateway, pool, "relation.set", actor, {
        relationPropertyId: projectProperty.id,
        callerItemId: file.id,
        targetItemId: beta.id,
      });
      await decide(pool, created.id, actor, "approved");

      const first = await replay(pool, created.id);
      const second = await replay(pool, created.id);

      expect(first.error).toBe(false);
      expect(second.error).toBe(false);
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: beta.id }]);
      expect(await linkState(pool, file.id, "project")).toEqual({ state: "broken", broken_by: "agent" });
      expect((await getApprovalRequest(pool, created.id))?.executionStatus).toBe("succeeded");
    }));

  it.each([
    ["the user removed the link", (file: { id: string }) => cpUnlink(file.id, "project")],
    [
      "the source was deleted",
      (_file: { id: string }, task: { id: string; databaseId: string }) =>
        cp.softDeleteItem(task.databaseId, task.id, undefined, SYSTEM_WRITER),
    ],
  ] as const)("ends as a conflict, writing nothing, when %s before approval", (_name, interfere) =>
    inTenantZero(async () => {
      const { projectProperty, task, alpha, beta, file } = await fixture();
      await link(pool, file.id, "project", task.id, "project");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);
      const created = await request(gateway, pool, "relation.set", actor, {
        relationPropertyId: projectProperty.id,
        callerItemId: file.id,
        targetItemId: beta.id,
      });
      await decide(pool, created.id, actor, "approved");
      await interfere(file, task);

      const outcome = await replay(pool, created.id);

      expect(outcome.error).toBe(true);
      expect((await getApprovalRequest(pool, created.id))?.executionStatus).toBe("conflict");
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: alpha.id }]);
    }),
  );

  it("ends an item.patch as a conflict when the linked value differs at approval time", () =>
    inTenantZero(async () => {
      const { files, task, file } = await fixture();
      await link(pool, file.id, "title", task.id, "name");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);
      const created = await request(gateway, pool, "item.patch", actor, {
        itemId: file.id,
        properties: { title: "Agent title" },
        ifVersion: await versionOf(file.id),
      });
      await decide(pool, created.id, actor, "approved");
      // A system writer changes the value without ending the link, so only the value differs.
      await cp.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { title: "Inherited elsewhere" } },
        actor.userId,
        undefined,
        SYSTEM_WRITER,
      );

      const outcome = await replay(pool, created.id);

      expect(outcome.error).toBe(true);
      expect((await getApprovalRequest(pool, created.id))?.executionStatus).toBe("conflict");
      expect((await cp.findItem(file.id))?.properties.title).toBe("Inherited elsewhere");
      expect(await linkState(pool, file.id, "title")).toEqual({ state: "on", broken_by: null });
    }));

  it("defers an agent item.patch of a linked property and writes it once when approved", () =>
    inTenantZero(async () => {
      const { task, file } = await fixture();
      await link(pool, file.id, "title", task.id, "name");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);

      const created = await request(gateway, pool, "item.patch", actor, {
        itemId: file.id,
        properties: { title: "Agent title" },
        ifVersion: await versionOf(file.id),
      });

      expect(created.riskClass).toBe("breaksLink");
      expect(created.description).toMatchObject({
        key: "approval.breaksLink",
        params: { propertyName: "Title", newValueName: "Agent title", sourceItemName: "Plan trip" },
      });
      expect((await cp.findItem(file.id))?.properties.title).toBe("Old title");
      expect(await linkState(pool, file.id, "title")).toEqual({ state: "on", broken_by: null });
      await decide(pool, created.id, actor, "approved");
      expect((await replay(pool, created.id)).error).toBe(false);
      expect((await cp.findItem(file.id))?.properties.title).toBe("Agent title");
      expect(await linkState(pool, file.id, "title")).toEqual({ state: "broken", broken_by: "agent" });
    }));

  it("defers an agent link.unlink and ends the link with broken_by agent when approved", () =>
    inTenantZero(async () => {
      const { task, file } = await fixture();
      await link(pool, file.id, "title", task.id, "name");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);

      const created = await request(gateway, pool, "link.unlink", actor, { itemId: file.id, propertyKey: "title" });

      expect(created.riskClass).toBe("breaksLink");
      expect(created.description?.breaksLinks).toMatchObject([
        { itemId: file.id, propertyKey: "title", sourceItemName: "Plan trip", newValueName: "Old title" },
      ]);
      expect(await linkState(pool, file.id, "title")).toEqual({ state: "on", broken_by: null });
      await decide(pool, created.id, actor, "approved");
      expect((await replay(pool, created.id)).error).toBe(false);
      expect(await linkState(pool, file.id, "title")).toEqual({ state: "broken", broken_by: "agent" });
    }));

  describe("relation.put on a linked relation", () => {
    /** A file with no project yet whose project follows the task: any edge put onto it ends the link. */
    async function linkedFreshFile(parts: Awaited<ReturnType<typeof fixture>>) {
      const fresh = await cp.createItem({ databaseId: parts.files.id, properties: { name: "fresh.pdf" } });
      await link(pool, fresh.id, "project", parts.task.id, "project");
      return fresh;
    }

    it("defers an agent putting the edge from the file side, names the write and leaves the relation unchanged", () =>
      inTenantZero(async () => {
        const parts = await fixture();
        const fresh = await linkedFreshFile(parts);
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        const created = await request(gateway, pool, "relation.put", actor, {
          relationPropertyId: parts.projectProperty.id,
          callerItemId: fresh.id,
          targetItemId: parts.beta.id,
        });

        expect(created.riskClass).toBe("breaksLink");
        expect(created.description?.key).toBe("approval.breaksLink");
        expect(created.description?.breaksLinks).toEqual([
          {
            itemId: fresh.id,
            itemName: "fresh.pdf",
            propertyKey: "project",
            sourceItemId: parts.task.id,
            sourceItemName: "Plan trip",
            sourceDatabaseKey: null,
            newValueName: "Beta",
          },
        ]);
        expect(await cp.listItemRelations(fresh.id, parts.projectProperty.id)).toEqual([]);
        expect(await linkState(pool, fresh.id, "project")).toEqual({ state: "on", broken_by: null });
      }));

    it("defers the same edge put through the other side of the relation and names the project it sets", () =>
      inTenantZero(async () => {
        const parts = await fixture();
        const fresh = await linkedFreshFile(parts);
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        const created = await request(gateway, pool, "relation.put", actor, {
          relationPropertyId: parts.filesProperty.id,
          callerItemId: parts.beta.id,
          targetItemId: fresh.id,
        });

        expect(created.riskClass).toBe("breaksLink");
        expect(created.description?.breaksLinks).toMatchObject([
          { itemId: fresh.id, propertyKey: "project", sourceItemName: "Plan trip", newValueName: "Beta" },
        ]);
        expect(await cp.listItemRelations(fresh.id, parts.projectProperty.id)).toEqual([]);
        expect(await linkState(pool, fresh.id, "project")).toEqual({ state: "on", broken_by: null });
      }));

    it("replays the approved put once and breaks the link with broken_by agent", () =>
      inTenantZero(async () => {
        const parts = await fixture();
        const fresh = await linkedFreshFile(parts);
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);
        const created = await request(gateway, pool, "relation.put", actor, {
          relationPropertyId: parts.projectProperty.id,
          callerItemId: fresh.id,
          targetItemId: parts.beta.id,
        });
        await decide(pool, created.id, actor, "approved");

        const first = await replay(pool, created.id);
        const second = await replay(pool, created.id);

        expect(first.error).toBe(false);
        expect(second.error).toBe(false);
        expect(await cp.listItemRelations(fresh.id, parts.projectProperty.id)).toMatchObject([
          { targetItemId: parts.beta.id },
        ]);
        expect(await linkState(pool, fresh.id, "project")).toEqual({ state: "broken", broken_by: "agent" });
        expect((await getApprovalRequest(pool, created.id))?.executionStatus).toBe("succeeded");
      }));

    it("ends as a conflict, writing nothing, when the user removed the link before approval", () =>
      inTenantZero(async () => {
        const parts = await fixture();
        const fresh = await linkedFreshFile(parts);
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);
        const created = await request(gateway, pool, "relation.put", actor, {
          relationPropertyId: parts.projectProperty.id,
          callerItemId: fresh.id,
          targetItemId: parts.beta.id,
        });
        await decide(pool, created.id, actor, "approved");
        await cpUnlink(fresh.id, "project");

        const outcome = await replay(pool, created.id);

        expect(outcome.error).toBe(true);
        expect((await getApprovalRequest(pool, created.id))?.executionStatus).toBe("conflict");
        expect(await cp.listItemRelations(fresh.id, parts.projectProperty.id)).toEqual([]);
      }));

    it("lets an agent put an edge that already exists, which ends no link", () =>
      inTenantZero(async () => {
        const { projectProperty, task, alpha, file } = await fixture();
        await link(pool, file.id, "project", task.id, "project");
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        await gateway.invoke("relation.put", actor, ALL_CAPABILITIES, {
          relationPropertyId: projectProperty.id,
          callerItemId: file.id,
          targetItemId: alpha.id,
        });

        expect(await linkState(pool, file.id, "project")).toEqual({ state: "on", broken_by: null });
        expect((await pool.query("SELECT 1 FROM approval_requests")).rowCount).toBe(0);
      }));
  });

  describe("item.create with initial relations onto a linked target", () => {
    async function creation(parts: Awaited<ReturnType<typeof fixture>>) {
      const fresh = await cp.createItem({ databaseId: parts.files.id, properties: { name: "fresh.pdf" } });
      await link(pool, fresh.id, "project", parts.task.id, "project");
      return {
        fresh,
        input: {
          databaseId: parts.projects.id,
          properties: { name: "Gamma" },
          relations: [{ propertyKey: "files", targetItemIds: [fresh.id] }],
        },
      };
    }

    it("refuses an agent under a run with a defined error, creating nothing and ending no link", () =>
      inTenantZero(async () => {
        const parts = await fixture();
        const { fresh, input } = await creation(parts);
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        const error = await gateway.invoke("item.create", actor, ALL_CAPABILITIES, input).then(
          () => null,
          (cause: unknown) => cause,
        );

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).not.toBeInstanceOf(ApprovalRequiredForWrite);
        expect(error).toMatchObject({
          code: "validation_failed",
          details: { reasons: [{ kind: "breaksLinks", links: [{ itemId: fresh.id, propertyKey: "project" }] }] },
        });
        expect(
          (
            await pool.query("SELECT 1 FROM items WHERE database_id = $1 AND properties->>'name' = 'Gamma'", [
              parts.projects.id,
            ])
          ).rowCount,
        ).toBe(0);
        expect(await cp.listItemRelations(fresh.id, parts.projectProperty.id)).toEqual([]);
        expect(await linkState(pool, fresh.id, "project")).toEqual({ state: "on", broken_by: null });
        expect((await pool.query("SELECT 1 FROM approval_requests")).rowCount).toBe(0);
      }));

    it("still creates the item for an /mcp call with a human session, which ends the link as agent", () =>
      inTenantZero(async () => {
        const parts = await fixture();
        const { fresh, input } = await creation(parts);
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        await gateway.invoke("item.create", { userId: actor.userId }, ALL_CAPABILITIES, input);

        expect(await cp.listItemRelations(fresh.id, parts.projectProperty.id)).toHaveLength(1);
        expect(await linkState(pool, fresh.id, "project")).toEqual({ state: "broken", broken_by: "agent" });
      }));

    it("creates the item for an agent under a run when the target has no active link", () =>
      inTenantZero(async () => {
        const parts = await fixture();
        const plain = await cp.createItem({ databaseId: parts.files.id, properties: { name: "plain.pdf" } });
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        await gateway.invoke("item.create", actor, ALL_CAPABILITIES, {
          databaseId: parts.projects.id,
          properties: { name: "Gamma" },
          relations: [{ propertyKey: "files", targetItemIds: [plain.id] }],
        });

        expect(await cp.listItemRelations(plain.id, parts.projectProperty.id)).toHaveLength(1);
      }));
  });

  it("leaves the value and the link unchanged when the request is rejected", () =>
    inTenantZero(async () => {
      const { projectProperty, task, alpha, beta, file } = await fixture();
      await link(pool, file.id, "project", task.id, "project");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);
      const created = await request(gateway, pool, "relation.set", actor, {
        relationPropertyId: projectProperty.id,
        callerItemId: file.id,
        targetItemId: beta.id,
      });

      await decide(pool, created.id, actor, "rejected");

      const stored = await getApprovalRequest(pool, created.id);
      expect(stored).toMatchObject({ status: "rejected", executionStatus: "not_approved" });
      expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: alpha.id }]);
      expect(await linkState(pool, file.id, "project")).toEqual({ state: "on", broken_by: null });
    }));

  it("keeps relation.delete a destructive request and adds the link lists to it", () =>
    inTenantZero(async () => {
      const { projectProperty, task, alpha, file } = await fixture();
      await link(pool, file.id, "project", task.id, "project");
      const actor = await agent(pool);
      const gateway = createGenericOperationGateway(pool, metadataResolver);

      const created = await request(gateway, pool, "relation.delete", actor, {
        relationPropertyId: projectProperty.id,
        callerItemId: file.id,
        targetItemId: alpha.id,
      });

      expect(created.riskClass).toBe("destructive");
      expect(created.description?.key).toBe("approval.relationDelete");
      expect(created.description?.breaksLinks).toMatchObject([
        { itemId: file.id, propertyKey: "project", sourceItemName: "Plan trip", newValueName: null },
      ]);
    }));

  describe("writes that stay immediate", () => {
    it("lets an agent write a property that has no link", () =>
      inTenantZero(async () => {
        const { task, file } = await fixture();
        await link(pool, file.id, "title", task.id, "name");
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId: file.id,
          properties: { note: "x" },
          ifVersion: await versionOf(file.id),
        });

        expect((await cp.findItem(file.id))?.properties.note).toBe("x");
        expect(await linkState(pool, file.id, "title")).toEqual({ state: "on", broken_by: null });
        expect((await pool.query("SELECT 1 FROM approval_requests")).rowCount).toBe(0);
      }));

    it("lets an agent relation.set onto an empty relation, which removes no value", () =>
      inTenantZero(async () => {
        const { projectProperty, task, beta, files } = await fixture();
        const fresh = await cp.createItem({ databaseId: files.id, properties: { name: "fresh.pdf" } });
        await link(pool, fresh.id, "project", task.id, "project");
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        await gateway.invoke("relation.set", actor, ALL_CAPABILITIES, {
          relationPropertyId: projectProperty.id,
          callerItemId: fresh.id,
          targetItemId: beta.id,
        });

        expect(await cp.listItemRelations(fresh.id, projectProperty.id)).toMatchObject([{ targetItemId: beta.id }]);
        expect((await pool.query("SELECT 1 FROM approval_requests")).rowCount).toBe(0);
      }));

    it("lets an agent relation.set replace an edge of a relation without an active link", () =>
      inTenantZero(async () => {
        const { projectProperty, beta, file } = await fixture();
        const actor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        await gateway.invoke("relation.set", actor, ALL_CAPABILITIES, {
          relationPropertyId: projectProperty.id,
          callerItemId: file.id,
          targetItemId: beta.id,
        });

        expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: beta.id }]);
        expect((await pool.query("SELECT 1 FROM approval_requests")).rowCount).toBe(0);
      }));

    it.each([
      ["a user", { restSession: true as const }, "user"],
      ["an /mcp call with a human session", {}, "agent"],
    ])("executes the same write at once for %s and records who broke the link", (_name, flags, brokenBy) =>
      inTenantZero(async () => {
        const { projectProperty, task, beta, file } = await fixture();
        await link(pool, file.id, "project", task.id, "project");
        const agentActor = await agent(pool);
        const gateway = createGenericOperationGateway(pool, metadataResolver);

        await gateway.invoke("relation.set", { userId: agentActor.userId, ...flags }, ALL_CAPABILITIES, {
          relationPropertyId: projectProperty.id,
          callerItemId: file.id,
          targetItemId: beta.id,
        });

        expect(await cp.listItemRelations(file.id, projectProperty.id)).toMatchObject([{ targetItemId: beta.id }]);
        expect(await linkState(pool, file.id, "project")).toEqual({ state: "broken", broken_by: brokenBy });
        expect((await pool.query("SELECT 1 FROM approval_requests")).rowCount).toBe(0);
      }),
    );
  });

  it("keeps each tenant's requests and link names to itself, through the runtime role", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const gateway = createGenericOperationGateway(runtime, metadataResolver);
      const tenants = [await createTestTenant(pool), await createTestTenant(pool)] as const;
      const made = [];
      for (const tenant of tenants) {
        made.push(
          await runInTenant(tenant, async () => {
            await createAuthUser(pool, { email: `${tenant}@example.test`, passwordHash: "test", tenantId: tenant });
            const own = createChokePoint(runtime);
            const parts = await fixture(own);
            await link(runtime, parts.file.id, "project", parts.task.id, "project");
            const actor = await agent(runtime);
            const created = await request(gateway, runtime, "relation.set", actor, {
              relationPropertyId: parts.projectProperty.id,
              callerItemId: parts.file.id,
              targetItemId: parts.beta.id,
            });
            return { tenant, actor, created, fileId: parts.file.id, taskId: parts.task.id };
          }),
        );
      }
      const [a, b] = made;
      if (!a || !b) throw new Error("Expected two tenants");

      const seenByA = await runInTenant(a.tenant, () => listApprovalRequestsQueue(runtime, a.actor.userId, LOCALE));
      const foreignRead = await runInTenant(a.tenant, () => getApprovalRequest(runtime, b.created.id));

      expect(seenByA.map((entry) => entry.id)).toEqual([a.created.id]);
      expect(seenByA[0]?.breaksLinks).toMatchObject([{ itemId: a.fileId, sourceItemId: a.taskId }]);
      expect(JSON.stringify(seenByA)).not.toContain(b.fileId);
      expect(foreignRead).toBeNull();
    } finally {
      await runtime.end();
    }
  });
});

/** The user's own unlink, outside any agent run. */
function cpUnlink(itemId: string, propertyKey: string) {
  return cp.unlinkValue({ itemId, propertyKey }, "user");
}
