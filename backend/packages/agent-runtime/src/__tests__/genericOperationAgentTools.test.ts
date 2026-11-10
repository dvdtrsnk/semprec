import type { CollectionMetadataResolver } from "@semprec/data";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as application from "@semprec/application";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  runMailboxAddressesOwnerCutoverMigration,
  upsertMailMessageMeta,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createItemWithClient,
  createChokePoint,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  updateItemWithClient,
  type ChokePoint,
} from "@semprec/data";
import { ModuleRegistry } from "@semprec/module-registry";
import { GENERIC_OPERATION_NAMES, runInTenant } from "@semprec/shared";
import {
  TOOL_CHANGE_VALUE_MAX_LENGTH,
  createGenericOperationAgentTools,
  listGrantedGenericOperationAgentTools,
} from "../tools/generic/genericOperationAgentTools.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry: ModuleRegistry = await loadFullModuleRegistry();

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

async function projectsDatabaseId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'projects'`);
  if (!rows[0]) throw new Error("Projects database was not seeded");
  return rows[0].id;
}

async function createProjectItem(): Promise<string> {
  const projectsDbId = await projectsDatabaseId();
  const item = await chokePoint.createItem({ databaseId: projectsDbId, properties: {} });
  return item.id;
}

function parseSuccess<T>(outcome: { error: boolean; result: string }): T {
  expect(outcome.error).toBe(false);
  return JSON.parse(outcome.result) as T;
}

describe("generic operation AgentTools (issue #220)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("createGenericOperationAgentTools", () => {
    it("validates Inbox capture and type creation through the agent tool", async () => {
      const inbox = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "inbox"));
      const types = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "inboxItemTypes"));
      if (!inbox || !types) throw new Error("Inbox databases were not seeded");
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "create inbox items" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const count = async (databaseId: string) => {
        const { rows } = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
          [databaseId],
        );
        return rows[0]?.count ?? 0;
      };
      for (const [databaseId, properties] of [
        [inbox.id, { date: "2026-02-30", time: "12:00" }],
        [inbox.id, { date: "2026-10-16", time: "24:00" }],
        [types.id, { name: "Invalid", processingMethod: "database", targetDatabase: "journal" }],
        [types.id, { name: "Invalid", processingMethod: "database", targetDatabase: "transcripts" }],
        [types.id, { name: "Invalid", processingMethod: "database", targetDatabase: "nonsense" }],
      ] as const) {
        const before = await count(databaseId);
        const rejected = await tools["item.create"](run.id, { databaseId, properties });
        expect(rejected.error).toBe(true);
        expect(rejected.result).toMatch(/^validation_failed:/);
        expect(await count(databaseId)).toBe(before);
      }
      for (const [databaseId, properties] of [
        [inbox.id, { date: "2026-10-16", time: "12:00" }],
        [types.id, { name: "Valid", processingMethod: "database", targetDatabase: "tasks" }],
      ] as const) {
        const before = await count(databaseId);
        const accepted = await tools["item.create"](run.id, { databaseId, properties });
        expect(accepted.error).toBe(false);
        expect(await count(databaseId)).toBe(before + 1);
      }
      const validType = (await chokePoint.listItems(types.id)).items.find((item) => item.properties.name === "Valid");
      if (!validType) throw new Error("Missing valid Inbox type");
      for (const targetDatabase of ["journal", "transcripts", "nonsense"]) {
        const rejected = await tools["item.patch"](run.id, {
          itemId: validType.id,
          properties: { targetDatabase },
          ifVersion: validType.updatedAt,
        });
        expect(rejected.error).toBe(true);
        expect(rejected.result).toMatch(/^validation_failed:/);
        const unchanged = await chokePoint.getItem(types.id, validType.id);
        expect(unchanged?.properties.targetDatabase).toBe("tasks");
      }
      const { rows } = await pool.query<{ period: string }>(
        `SELECT day.properties->>'period' AS period FROM item_relations r
         JOIN relation_definitions d ON d.id = r.relation_definition_id
         JOIN properties p ON p.id = d.property_id_a
         JOIN items source ON source.id = r.item_a
         JOIN items day ON day.id = r.item_b
         WHERE p.database_id = $1 AND p.key = 'journalDay' AND source.properties->>'date' = $2`,
        [inbox.id, "2026-10-16"],
      );
      expect(rows).toEqual([{ period: "2026-10-16" }]);
    });

    it("projects Emails body on agent item.get but leaves stored and other-module HTML unchanged", async () => {
      const emails = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "emails"));
      if (!emails) throw new Error("Emails database was not seeded");
      const raw = '<p onclick="evil()">safe</p><script>evil()</script><img src="https://tracker.example/pixel">';
      const email = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: emails.id, properties: { body: raw } },
          { allowedSystemKeys: ["body"] },
        ),
      );
      const other = await chokePoint.createDatabase({ name: "Other" });
      await chokePoint.createProperty({ databaseId: other.id, key: "body", name: "Body", type: "longText" });
      const otherItem = await chokePoint.createItem({ databaseId: other.id, properties: { body: raw } });
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "read emails" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const projected = await tools["item.get"](run.id, { itemId: email.id });
      expect(projected.error).toBe(false);
      expect(projected.result).toContain("safe");
      expect(projected.result).not.toMatch(/<script|onclick|https:\/\/tracker/i);
      const unchanged = await tools["item.get"](run.id, { itemId: otherItem.id });
      expect(unchanged.error).toBe(false);
      expect(unchanged.result).toContain("tracker.example");
      const { rows } = await pool.query<{ body: string }>(
        "SELECT properties->>'body' AS body FROM items WHERE database_id = $1 AND id = $2",
        [emails.id, email.id],
      );
      expect(rows[0]?.body).toBe(raw);
    });

    it("refuses mailbox address edits in fresh and cut-over tenants through the agent tool", async () =>
      runInTenant(getTenantZeroId(), async () => {
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        const failures: unknown[] = [];
        try {
          const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
            "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
          );
          expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
          const fixture = await withTransaction(runtime, async (client) => {
            const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
            const projects = await getDatabaseByModuleId(client, "projects");
            if (!mailboxes || !projects) throw new Error("Missing mailboxes or projects");
            const mailbox = await createItemWithClient(client, {
              databaseId: mailboxes.id,
              properties: { name: "Before" },
            });
            await updateItemWithClient(
              client,
              { databaseId: mailboxes.id, itemId: mailbox.id, propertiesPatch: { addresses: "owner@example.test" } },
              { allowedSystemKeys: ["addresses"] },
            );
            const { rows } = await client.query<{ id: string }>(
              "SELECT id FROM items WHERE database_id = $1 AND properties->>'name' = 'Email'",
              [projects.id],
            );
            if (!rows[0]) throw new Error("Missing Email project");
            return { mailboxId: mailbox.id, databaseId: mailboxes.id, projectId: rows[0].id };
          });
          const run = await createAgentRun(runtime, {
            projectItemId: fixture.projectId,
            triggeredBy: "user",
            task: "edit mailbox",
          });
          const tools = createGenericOperationAgentTools(runtime, moduleRegistry, testMetadataResolver);
          for (const phase of ["fresh", "cutover"] as const) {
            if (phase === "cutover") {
              // Restore the historical property owner before the actual tenant cutover.
              await pool.query("UPDATE properties SET owner = 'user' WHERE database_id = $1 AND key = 'addresses'", [
                fixture.databaseId,
              ]);
              await runMailboxAddressesOwnerCutoverMigration(runtime);
            }
            const before = await createChokePoint(runtime).getItem(fixture.databaseId, fixture.mailboxId);
            if (!before) throw new Error("Mailbox missing");
            const refused = await tools["item.patch"](run.id, {
              itemId: fixture.mailboxId,
              properties: { addresses: "bad@example.test" },
              ifVersion: before.updatedAt,
            });
            expect(refused.error).toBe(true);
            expect(refused.result).toMatch(/^owner_violation:/);
            expect(await createChokePoint(runtime).getItem(fixture.databaseId, fixture.mailboxId)).toEqual(before);
            const allowed = await tools["item.patch"](run.id, {
              itemId: fixture.mailboxId,
              properties: { name: `Allowed ${phase}` },
              ifVersion: before.updatedAt,
            });
            expect(allowed.error).toBe(false);
            expect(
              (await createChokePoint(runtime).getItem(fixture.databaseId, fixture.mailboxId))?.properties,
            ).toMatchObject({ name: `Allowed ${phase}`, addresses: "owner@example.test" });
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          await runtime.end();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Agent test and settlement failed");
      }));

    it("queues one mailbox sync for agent flag patches of two messages", async () =>
      runInTenant(getTenantZeroId(), async () => {
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        try {
          const emails = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "emails"));
          const mailboxes = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "mailboxes"));
          if (!emails || !mailboxes) throw new Error("Mail databases were not seeded");
          const fixture = await withTransaction(runtime, async (client) => {
            const mailbox = await createItemWithClient(client, {
              databaseId: mailboxes.id,
              properties: { name: "Work", provider: "generic" },
            });
            const first = await createItemWithClient(client, { databaseId: emails.id, properties: {} });
            const second = await createItemWithClient(client, { databaseId: emails.id, properties: {} });
            for (const [item, messageId] of [
              [first, "<first@example.test>"],
              [second, "<second@example.test>"],
            ] as const) {
              await upsertMailMessageMeta(client, {
                itemId: item.id,
                mailboxItemId: mailbox.id,
                messageId,
                envelope: {},
              });
            }
            return { mailbox, first, second };
          });
          const projects = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects"));
          if (!projects) throw new Error("Projects database was not seeded");
          const projectItemId = (
            await createChokePoint(runtime).createItem({ databaseId: projects.id, properties: {} })
          ).id;
          const run = await createAgentRun(runtime, { projectItemId, triggeredBy: "user", task: "flag messages" });
          const tools = createGenericOperationAgentTools(runtime, moduleRegistry, testMetadataResolver);
          for (const [item, properties] of [
            [fixture.first, { read: true }],
            [fixture.second, { flagged: true }],
          ] as const) {
            const result = await tools["item.patch"](run.id, {
              itemId: item.id,
              properties,
              ifVersion: item.updatedAt,
            });
            expect(result.error).toBe(false);
          }
          const { rows } = await pool.query<{ key: string | null }>(
            "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1",
            ["mailAccountSync"],
          );
          expect(rows).toEqual([{ key: `mail-account-sync:${fixture.mailbox.id}` }]);
        } finally {
          await runtime.end();
        }
      }));

    it("refuses a Journal item without type or period through the agent tool without creating a row", async () => {
      const journal = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
      if (!journal) throw new Error("Journal database was not seeded");
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "create a journal entry" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);

      const outcome = await tools["item.create"](run.id, { databaseId: journal.id, properties: {} });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^forbidden:/);
      const { rows } = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
        [journal.id],
      );
      expect(rows[0]?.count).toBe(0);
    });

    it("gives an Event created through the agent tool its UID and sequence 0, and a time patch sequence 1 (issue #1599)", async () => {
      const events = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "events"));
      if (!events) throw new Error("Events database was not seeded");
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "plan a meeting" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@semprec$/;
      /** The item a successful tool call returned, narrowed from its JSON text. */
      const returnedItem = (outcome: { error: boolean; result: string }) => {
        expect(outcome.error).toBe(false);
        const value: unknown = JSON.parse(outcome.result);
        if (
          typeof value !== "object" ||
          value === null ||
          !("id" in value) ||
          typeof value.id !== "string" ||
          !("updatedAt" in value) ||
          typeof value.updatedAt !== "string" ||
          !("properties" in value) ||
          typeof value.properties !== "object" ||
          value.properties === null
        )
          throw new Error("Unexpected item result");
        return {
          id: value.id,
          updatedAt: value.updatedAt,
          properties: Object.fromEntries(Object.entries(value.properties)),
        };
      };

      const created = returnedItem(
        await tools["item.create"](run.id, {
          databaseId: events.id,
          properties: { name: "Client meeting", date: "2026-10-16", timeFrom: "9:00" },
        }),
      );
      expect(created.properties.icalUid).toMatch(UID_PATTERN);
      expect(created.properties.icalSequence).toBe(0);
      expect((await chokePoint.getItem(events.id, created.id))?.properties).toMatchObject({
        icalUid: created.properties.icalUid,
        icalSequence: 0,
        timeFrom: "09:00",
      });

      const patched = returnedItem(
        await tools["item.patch"](run.id, {
          itemId: created.id,
          properties: { timeFrom: "8:30" },
          ifVersion: created.updatedAt,
        }),
      );
      expect(patched.properties).toMatchObject({
        icalUid: created.properties.icalUid,
        icalSequence: 1,
        timeFrom: "08:30",
      });
      expect((await chokePoint.getItem(events.id, created.id))?.properties).toMatchObject({
        icalUid: created.properties.icalUid,
        icalSequence: 1,
      });
    });

    it("returns owner_violation, never touching the choke point, for a currentRunId that doesn't exist", async () => {
      const tools = createGenericOperationAgentTools(pool, undefined, testMetadataResolver);

      const outcome = await tools["item.get"](randomUUID(), { itemId: randomUUID() });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^owner_violation:/);
    });

    it("returns owner_violation for a run whose project_item_id is NULL", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "no project" });
      const tools = createGenericOperationAgentTools(pool, undefined, testMetadataResolver);

      const outcome = await tools["item.get"](run.id, { itemId: randomUUID() });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^owner_violation:/);
    });

    it("derives the actor exclusively from the persisted run — a spoofed identity-shaped field in args is rejected, and a legitimate call attributes the write to the run's own project", async () => {
      const projectItemId = await createProjectItem();
      const otherProjectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "make a view" });
      const database = await chokePoint.createDatabase({ name: "Tools DB" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);

      // Every generic-operation input schema is a strict zod object with none of these field
      // names (see AuthenticatedActor's own doc comment) — an attempt to smuggle a different
      // identity in through `args` fails validation rather than silently being ignored.
      const spoofed = await tools["view.create"](run.id, {
        databaseId: database.id,
        type: "table",
        name: "Stolen view",
        agentProjectItemId: otherProjectItemId,
        runId: randomUUID(),
        userId: randomUUID(),
      });
      expect(spoofed.error).toBe(true);

      const legit = await tools["view.create"](run.id, {
        databaseId: database.id,
        type: "table",
        name: "Legit view",
      });
      const view = parseSuccess<{ id: string; creatorProjectItemId: string | null }>(legit);
      expect(view.creatorProjectItemId).toBe(projectItemId);
      expect(view.creatorProjectItemId).not.toBe(otherProjectItemId);
    });

    it("a destructive operation, granted, returns a synthetic-success result and creates exactly one pending approval request, without executing", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a view" });
      // Owned by this same agent identity (issue #89's preflight now runs the destructive
      // command's own `assertViewWritable` ownership check before ever creating the approval
      // row) — a view owned by someone else is exactly what that preflight must reject outright,
      // not synthesize a pending approval for, so this fixture has to match the calling agent.
      const view = await chokePoint.createView(
        { type: "list", name: "Scratch", config: { membership: "manual" } },
        { type: "ai_agent", agentProjectItemId: projectItemId },
      );
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);

      const outcome = await tools["view.delete"](run.id, { viewId: view.id });

      expect(outcome.error).toBe(false);
      expect(outcome.result).toContain("requires human approval");

      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM approval_requests WHERE agent_run_id = $1`,
        [run.id],
      );
      expect(rows[0]!.count).toBe(1);
      expect(await chokePoint.getView(view.id)).not.toBeNull();
    });

    it("returns the id of the approval request it created as approvalRequestId, with the same text", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a view" });
      const view = await chokePoint.createView(
        { type: "list", name: "Scratch", config: { membership: "manual" } },
        { type: "ai_agent", agentProjectItemId: projectItemId },
      );
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);

      const outcome = await tools["view.delete"](run.id, { viewId: view.id });

      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM approval_requests WHERE agent_run_id = $1`, [
        run.id,
      ]);
      expect(outcome.approvalRequestId).toBe(rows[0]!.id);
      expect(outcome.result).toContain(`Approval request ${rows[0]!.id} has been created`);
      expect(outcome.changes).toBeUndefined();
    });
  });

  describe("item.patch changes", () => {
    it("preserves write classification through the actual registered email projection", async () => {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "emails"));
      if (!database) throw new Error("Emails not seeded");
      const item = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: database.id,
            properties: { body: "<p>safe</p><script>projection-sentinel</script>", read: false },
          },
          { allowedSystemKeys: ["body"] },
        ),
      );
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const outcome = await tools["item.patch"](run.id, {
        itemId: item.id,
        properties: { read: true },
        ifVersion: item.updatedAt,
      });
      expect(outcome.error).toBe(false);
      expect(outcome.result).toContain("safe");
      expect(outcome.result).not.toContain("projection-sentinel");
      expect(outcome.changes).toEqual([{ key: "read", before: false, after: true }]);
    });
    async function patchFixture() {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
      const database = await chokePoint.createDatabase({ name: "Tasks for changes" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });
      await chokePoint.createProperty({ databaseId: database.id, key: "due", name: "Due", type: "text" });
      await chokePoint.createProperty({ databaseId: database.id, key: "body", name: "Body", type: "longText" });
      const item = await chokePoint.createItem({
        databaseId: database.id,
        properties: { title: "Write", due: "2026-10-21T14:00", body: "secret old body" },
      });
      return { run, item, tools: createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver) };
    }

    it("reports the previous and new value of a changed property", async () => {
      const { run, item, tools } = await patchFixture();

      const outcome = await tools["item.patch"](run.id, {
        itemId: item.id,
        properties: { due: "2026-10-22T09:00" },
        ifVersion: item.updatedAt,
      });

      expect(outcome.error).toBe(false);
      expect(outcome.changes).toEqual([{ key: "due", before: "2026-10-21T14:00", after: "2026-10-22T09:00" }]);
      expect(outcome.approvalRequestId).toBeUndefined();
    });

    it("keeps a changed key without before when the operation output omits its previous value", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
      const database = await chokePoint.createDatabase({ name: "Missing previous" });
      await chokePoint.createProperty({ databaseId: database.id, key: "due", name: "Due", type: "text" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { due: "old" } });
      const originalFactory = application.createGenericOperationGateway;
      const factorySpy = vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
        const gateway = originalFactory(...args);
        const invoke = gateway.invoke.bind(gateway);
        vi.spyOn(gateway, "invoke").mockImplementation(async (...call) => {
          const output = await invoke(...call);
          if (call[0] === "item.patch") Object.defineProperty(output, "previous", { value: {} });
          return output;
        });
        return gateway;
      });
      try {
        const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
        const outcome = await tools["item.patch"](run.id, {
          itemId: item.id,
          properties: { due: "new" },
          ifVersion: item.updatedAt,
        });
        expect(outcome.error).toBe(false);
        expect(outcome.changes).toEqual([{ key: "due", after: "new" }]);
        expect(outcome.changes?.[0]).not.toHaveProperty("before");
      } finally {
        factorySpy.mockRestore();
        vi.restoreAllMocks();
      }
    });

    it("shortens long string values and stores no content of a longText property", async () => {
      const { run, item, tools } = await patchFixture();
      const long = "x".repeat(TOOL_CHANGE_VALUE_MAX_LENGTH + 50);

      const outcome = await tools["item.patch"](run.id, {
        itemId: item.id,
        properties: { title: long, body: "secret new body" },
        ifVersion: item.updatedAt,
      });

      expect(outcome.error).toBe(false);
      expect(outcome.changes).toEqual([
        { key: "title", before: "Write", after: "x".repeat(TOOL_CHANGE_VALUE_MAX_LENGTH) },
        { key: "body" },
      ]);
      expect(JSON.stringify(outcome.changes)).not.toContain("secret");
    });

    it.each(["type change", "deletion"] as const)(
      "keeps longText values private after a post-write %s",
      async (change) => {
        const projectItemId = await createProjectItem();
        const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
        const database = await chokePoint.createDatabase({ name: "Redaction" });
        const property = await chokePoint.createProperty({
          databaseId: database.id,
          key: "body",
          name: "Body",
          type: "longText",
        });
        const item = await chokePoint.createItem({ databaseId: database.id, properties: { body: "old secret" } });
        const originalFactory = application.createGenericOperationGateway;
        const factorySpy = vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
          const gateway = originalFactory(...args);
          const invoke = gateway.invoke.bind(gateway);
          vi.spyOn(gateway, "invoke").mockImplementation(async (...call) => {
            const output = await invoke(...call);
            if (call[0] === "item.patch") {
              if (change === "type change") {
                // The public conversion catalog has no longText-to-text path; simulate the committed schema change directly.
                const updated = await withTransaction(pool, (client) =>
                  client.query("UPDATE properties SET type = 'text' WHERE id = $1", [property.id]),
                );
                expect(updated.rowCount).toBe(1);
              } else await chokePoint.deleteProperty(property.id);
            }
            return output;
          });
          return gateway;
        });
        try {
          const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
          const result = await tools["item.patch"](run.id, {
            itemId: item.id,
            properties: { body: "new secret" },
            ifVersion: item.updatedAt,
          });
          expect(result.error).toBe(false);
          expect(result.changes).toEqual([{ key: "body" }]);
          expect(JSON.stringify(result.changes)).not.toContain("secret");
        } finally {
          factorySpy.mockRestore();
          vi.restoreAllMocks();
        }
      },
    );

    it.each(["missing", "invalid"] as const)(
      "fails closed when an item.patch classification carrier is %s",
      async (mode) => {
        const { run, item } = await patchFixture();
        const originalFactory = application.createGenericOperationGateway;
        const factorySpy = vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
          const gateway = originalFactory(...args);
          const invoke = gateway.invoke.bind(gateway);
          vi.spyOn(gateway, "invoke").mockImplementation(async (...call) => {
            const output = await invoke(...call);
            if (call[0] === "item.patch") {
              if (output === null || typeof output !== "object") throw new Error("Expected item.patch object output");
              const symbols = Object.getOwnPropertySymbols(output);
              expect(symbols).toHaveLength(1);
              if (mode === "missing") Reflect.deleteProperty(output, symbols[0]!);
              else Object.defineProperty(output, symbols[0]!, { value: "invalid" });
            }
            return output;
          });
          return gateway;
        });
        try {
          const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
          const result = await tools["item.patch"](run.id, {
            itemId: item.id,
            properties: { due: "new" },
            ifVersion: item.updatedAt,
          });
          expect(result.error).toBe(false);
          expect(result.changes).toEqual([{ key: "due" }]);
        } finally {
          factorySpy.mockRestore();
          vi.restoreAllMocks();
        }
      },
    );

    it("stores no changes for a failed patch or for a read", async () => {
      const { run, item, tools } = await patchFixture();

      const failed = await tools["item.patch"](run.id, {
        itemId: item.id,
        properties: { due: "later" },
        ifVersion: "2000-01-01T00:00:00.000Z",
      });
      const read = await tools["item.get"](run.id, { itemId: item.id });

      expect(failed.error).toBe(true);
      expect(failed.changes).toBeUndefined();
      expect(read.error).toBe(false);
      expect(read.changes).toBeUndefined();
      expect(read.approvalRequestId).toBeUndefined();
    });
  });

  describe("listGrantedGenericOperationAgentTools", () => {
    it("intersects admitted module strings with the closed core capability catalog", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "check capabilities" });
      for (const key of ["ownedOne", "ownedTwo"]) {
        await chokePoint.createDatabase({ name: null, key, system: true, ownerProjectItemId: projectItemId });
      }
      const registry = new ModuleRegistry(() => new Set(["schemaCore", "ownedTools"]));
      await registry.loadModule(
        new URL("../../../data/src/chokePoint/schemaCoreModuleManifest.js", import.meta.url).href,
      );
      await registry.loadModule(
        new URL("../../../module-registry/src/__tests__/fixtures/ownedAgentToolsModule.js", import.meta.url).href,
      );
      const original = application.createGenericOperationGateway;
      let seen: ReadonlySet<string> | undefined;
      const spy = vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
        const gateway = original(...args);
        const list = gateway.listOperations.bind(gateway);
        vi.spyOn(gateway, "listOperations").mockImplementation((capabilities) => {
          seen = capabilities;
          return list(capabilities);
        });
        return gateway;
      });
      try {
        const granted = await listGrantedGenericOperationAgentTools(pool, registry, run.id, testMetadataResolver);
        const excluded = ["page.get", "page.ensure", "page.restoreVersion", "page.insert", "page.changes"];
        expect(granted.sort()).toEqual([...GENERIC_OPERATION_NAMES].filter((name) => !excluded.includes(name)).sort());
        for (const name of excluded) expect(granted).not.toContain(name);
        expect(seen?.has("owned.read")).toBe(false);
        expect(seen?.has("core.item.read")).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
    it("returns [] for a run with no project context", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "no project" });

      const granted = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id, testMetadataResolver);

      expect(granted).toEqual([]);
    });

    it("returns [] when no moduleRegistry is supplied — an ungranted operation is absent, never present-but-forbidden", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "check tools" });

      const granted = await listGrantedGenericOperationAgentTools(pool, undefined, run.id, testMetadataResolver);

      expect(granted).toEqual([]);
    });

    it("returns all operations except page operations under the project grant policy", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "check tools" });

      const granted = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id, testMetadataResolver);

      const excluded = ["page.get", "page.ensure", "page.restoreVersion", "page.insert", "page.changes"];
      expect(granted.sort()).toEqual([...GENERIC_OPERATION_NAMES].filter((name) => !excluded.includes(name)).sort());
      for (const name of excluded) expect(granted).not.toContain(name);
    });
  });
});
