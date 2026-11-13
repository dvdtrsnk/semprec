import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { closeIdleThreadSessions } from "@semprec/agent-runtime";
import { runInTenant, type LabeledSempMessageRef } from "@semprec/shared";
import {
  createChokePoint,
  createUser,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
  sendSempMessage,
  withTransaction,
  type ItemRow,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  startTaskSeries,
} from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createInFlightAgentRuns, type InFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";
import { expandSempRefs } from "../refExpansion.js";
import { createSempMessageTask } from "../sempMessageTask.js";
import { readAllowedItemIds } from "../sempTurnReadAllowances.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let registry: ModuleRegistry;
let healthDatabaseId: string;
let semprecProjectItemId: string;

const inTenant = <T>(fn: () => Promise<T>) => runInTenant(tenant, fn);

function gatewayOf(faux: ReturnType<typeof fauxProvider>): GatewayModel {
  return {
    model: faux.getModel(),
    streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
    isBudgetRefusal: () => false,
  };
}

function newHealthRecord(name: string): Promise<ItemRow> {
  return inTenant(() => createChokePoint(runtime).createItem({ databaseId: healthDatabaseId, properties: { name } }));
}

function itemRef(item: ItemRow, label: string): LabeledSempMessageRef {
  return { kind: "item", itemId: item.id, databaseId: item.databaseId, label };
}

const toolCall = (name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

/** Queues a user message with the refs, like the send route does. */
function queueTurn(
  text: string,
  context: LabeledSempMessageRef[],
  threadId?: string,
): Promise<{ threadId: string; assistantMessageId: string }> {
  return inTenant(() =>
    withTransaction(runtime, (client) =>
      sendSempMessage(client, { text, context, hasContext: context.length > 0, ...(threadId ? { threadId } : {}) }),
    ),
  );
}

function runTask(
  task: ReturnType<typeof createSempMessageTask>,
  turn: { threadId: string; assistantMessageId: string },
) {
  return inTenant(() =>
    task({ threadId: turn.threadId, assistantMessageId: turn.assistantMessageId }, { job: { id: randomUUID() } }),
  );
}

async function replyOf(assistantMessageId: string): Promise<{ status: string; runId: string | null }> {
  const { rows } = await inTenant(() =>
    runtime.query<{ status: string; agent_run_id: string | null }>(
      "SELECT status, agent_run_id FROM semp_messages WHERE id = $1",
      [assistantMessageId],
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("The reply message is missing");
  return { status: row.status, runId: row.agent_run_id };
}

/** Queues a user message with the refs and runs its task once, like the queue does. */
async function runTurn(
  task: ReturnType<typeof createSempMessageTask>,
  text: string,
  context: LabeledSempMessageRef[],
  threadId?: string,
): Promise<{ threadId: string; assistantMessageId: string; status: string; runId: string | null }> {
  const turn = await queueTurn(text, context, threadId);
  await runTask(task, turn);
  return { ...turn, ...(await replyOf(turn.assistantMessageId)) };
}

/** How many allowance rows the run holds; read as the table owner, so row-level security cannot hide a row. */
async function allowanceCount(runId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM agent_run_read_allowances WHERE agent_run_id = $1 AND tenant_id = $2",
    [runId, tenant],
  );
  return rows[0]?.n ?? 0;
}

async function totalAllowanceCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM agent_run_read_allowances WHERE tenant_id = $1",
    [tenant],
  );
  return rows[0]?.n ?? 0;
}

interface ToolOutcome {
  isError: boolean;
  text: string;
}

async function toolOutcome(runId: string, toolCallId: string): Promise<ToolOutcome> {
  const { rows } = await inTenant(() =>
    runtime.query<{ is_error: string | null; text: string | null }>(
      `SELECT payload #>> '{result,details,error}' AS is_error, payload #>> '{result,content,0,text}' AS text
       FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_result' AND payload->>'toolCallId' = $2`,
      [runId, toolCallId],
    ),
  );
  const row = rows[0];
  if (!row) throw new Error(`No tool result for ${toolCallId}`);
  return { isError: row.is_error === "true", text: row.text ?? "" };
}

describe("one-turn read allowances of a Semp turn (issue #1849)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await inTenant(() => seedSystem(runtime));
    registry = await loadFullModuleRegistry();
    const databases = await inTenant(async () => ({
      health: await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "healthRecords")),
      inbox: await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "inbox")),
    }));
    if (!databases.health || !databases.inbox?.ownerProjectItemId) throw new Error("System databases are missing");
    healthDatabaseId = databases.health.id;
    semprecProjectItemId = databases.inbox.ownerProjectItemId;
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await closeIdleThreadSessions(runtime);
    } catch (error) {
      errors.push(error);
    }
    try {
      await runtime?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Allowance test cleanup failed", { cause: errors[0] });
  });

  describe("which refs allow a read", () => {
    const itemId = randomUUID();
    const databaseId = randomUUID();

    it.each([
      { name: "an item ref", ref: { kind: "item", itemId, databaseId }, ids: [itemId] },
      { name: "a block ref", ref: { kind: "block", itemId, blockId: randomUUID() }, ids: [itemId] },
      {
        name: "a transcript segment ref",
        ref: { kind: "transcriptSegment", itemId, startsAt: 1, endsAt: 2 },
        ids: [itemId],
      },
      { name: "a labeled item ref", ref: { kind: "item", itemId, databaseId, label: "Record" }, ids: [itemId] },
      {
        name: "an item ref with an upper-case id",
        ref: { kind: "item", itemId: itemId.toUpperCase(), databaseId },
        ids: [itemId],
      },
      { name: "a mail attachment ref", ref: { kind: "mailAttachment", attachmentId: randomUUID() }, ids: [] },
      { name: "an agent run ref", ref: { kind: "agentRun", agentRunId: randomUUID() }, ids: [] },
      { name: "an approval request ref", ref: { kind: "approvalRequest", approvalRequestId: randomUUID() }, ids: [] },
      {
        name: "a task occurrence ref",
        ref: { kind: "taskOccurrence", seriesId: "series", occurrenceDate: "2026-01-01" },
        ids: [],
      },
      { name: "a task trace ref", ref: { kind: "taskTrace", itemId, databaseId, traceDay: "2026-01-01" }, ids: [] },
      { name: "an entry that is not a ref", ref: { kind: "item", itemId: "not-a-uuid", databaseId }, ids: [] },
    ])("takes the item ids of $name", ({ ref, ids }) => {
      expect(readAllowedItemIds([ref])).toEqual(ids);
    });

    it("names an item once however often the message refs it, and nothing for a context that is not a list", () => {
      const second = randomUUID();
      expect(
        readAllowedItemIds([
          { kind: "item", itemId, databaseId },
          { kind: "block", itemId, blockId: randomUUID() },
          { kind: "item", itemId: second, databaseId },
        ]),
      ).toEqual([itemId, second]);
      expect(readAllowedItemIds(null)).toEqual([]);
      expect(readAllowedItemIds({ kind: "item", itemId, databaseId })).toEqual([]);
    });
  });

  describe("a turn that attaches a health record", () => {
    it("lets the agent read the attached record in that turn without a grant, refuses another record of the database, refuses the attached one in the next turn without the ref, and leaves no row", async () => {
      const [attached, sibling] = [await newHealthRecord("Attached record"), await newHealthRecord("Sibling record")];
      const faux = fauxProvider();
      faux.setResponses([
        toolCall("item_get", { itemId: attached.id }, "read-attached"),
        toolCall("item_get", { itemId: sibling.id }, "read-sibling"),
        fauxAssistantMessage("first done"),
        toolCall("item_get", { itemId: attached.id }, "read-again"),
        fauxAssistantMessage("second done"),
      ]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());

      const first = await runTurn(task, "look at this", [itemRef(attached, "Attached record")]);
      expect(first.status).toBe("done");
      const runId = first.runId;
      if (!runId) throw new Error("The first turn has no run");
      const read = await toolOutcome(runId, "read-attached");
      expect(read.isError).toBe(false);
      expect(read.text).toContain("Attached record");
      const refused = await toolOutcome(runId, "read-sibling");
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("forbidden");
      expect(refused.text).not.toContain("Sibling record");
      expect(await allowanceCount(runId)).toBe(0);

      const second = await runTurn(task, "and now?", [], first.threadId);
      expect(second.status).toBe("done");
      expect(second.runId).toBe(runId);
      const again = await toolOutcome(runId, "read-again");
      expect(again.isError).toBe(true);
      expect(again.text).toContain("forbidden");
      expect(await allowanceCount(runId)).toBe(0);
    });

    it("answers 403 to item_patch of the attached record without a write grant and leaves the record unchanged", async () => {
      const attached = await newHealthRecord("Before");
      const faux = fauxProvider();
      faux.setResponses([
        toolCall(
          "item_patch",
          { itemId: attached.id, properties: { name: "After" }, ifVersion: attached.updatedAt },
          "patch-attached",
        ),
        fauxAssistantMessage("done"),
      ]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());

      const turn = await runTurn(task, "change it", [itemRef(attached, "Before")]);
      expect(turn.status).toBe("done");
      if (!turn.runId) throw new Error("The turn has no run");
      const patch = await toolOutcome(turn.runId, "patch-attached");
      expect(patch.isError).toBe(true);
      expect(patch.text).toContain("forbidden");
      const stored = await inTenant(() => createChokePoint(runtime).findItem(attached.id));
      expect(stored?.properties.name).toBe("Before");
    });
  });

  describe("when the turn does not end well", () => {
    it("removes the rows after a failed turn", async () => {
      const attached = await newHealthRecord("Attached for a failure");
      const faux = fauxProvider();
      let during: number | undefined;
      let runIdDuring: string | undefined;
      faux.setResponses([
        async () => {
          const { rows } = await admin.query<{ agent_run_id: string }>(
            "SELECT agent_run_id FROM agent_run_read_allowances WHERE tenant_id = $1 AND item_id = $2",
            [tenant, attached.id],
          );
          runIdDuring = rows[0]?.agent_run_id;
          during = rows.length;
          throw new Error("provider exploded");
        },
      ]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());

      const turn = await runTurn(task, "fail", [itemRef(attached, "Attached for a failure")]);
      expect(turn.status).toBe("error");
      expect(during).toBe(1);
      expect(turn.runId).toBe(runIdDuring);
      expect(runIdDuring).toBeDefined();
      expect(await totalAllowanceCount()).toBe(0);
    });

    it("removes the rows after a cancelled turn", async () => {
      const attached = await newHealthRecord("Attached for a cancel");
      const inFlight: InFlightAgentRuns = createInFlightAgentRuns();
      const faux = fauxProvider();
      let entered: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      faux.setResponses([
        async (_context, options) => {
          const signal = options?.signal;
          if (!signal) throw new Error("Missing provider abort signal");
          entered();
          return new Promise((_, reject) => {
            if (signal.aborted) reject(new Error("provider aborted"));
            else signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
          });
        },
      ]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), inFlight);
      const running = runTurn(task, "cancel me", [itemRef(attached, "Attached for a cancel")]);
      await started;
      expect(await totalAllowanceCount()).toBe(1);

      expect(inFlight.abortTenant(tenant)).toBe(1);
      const turn = await running;
      expect(turn.status).toBe("error");
      expect(await totalAllowanceCount()).toBe(0);
    });

    it("clears a row a crashed turn left behind when the next turn of the run starts", async () => {
      const [attached, leftover] = [await newHealthRecord("Attached"), await newHealthRecord("Leftover of a crash")];
      const faux = fauxProvider();
      let rowsAtStart: number | undefined;
      let runId: string | null = null;
      const steps: FauxResponseStep[] = [
        fauxAssistantMessage("first done"),
        async () => {
          rowsAtStart = runId ? await allowanceCount(runId) : undefined;
          return toolCall("item_get", { itemId: leftover.id }, "read-leftover");
        },
        fauxAssistantMessage("second done"),
      ];
      faux.setResponses(steps);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());

      const first = await runTurn(task, "attach", [itemRef(attached, "Attached")]);
      runId = first.runId;
      if (!runId) throw new Error("The first turn has no run");
      expect(await allowanceCount(runId)).toBe(0);
      // A crash between the start and the end of a turn leaves its rows: a state the turn's own code cannot produce.
      await admin.query(
        "INSERT INTO agent_run_read_allowances (tenant_id, agent_run_id, item_id) VALUES ($1, $2, $3)",
        [tenant, runId, leftover.id],
      );
      expect(await allowanceCount(runId)).toBe(1);

      const second = await runTurn(task, "next", [], first.threadId);
      expect(second.runId).toBe(runId);
      expect(rowsAtStart).toBe(0);
      const read = await toolOutcome(runId, "read-leftover");
      expect(read.isError).toBe(true);
      expect(read.text).toContain("forbidden");
      expect(await allowanceCount(runId)).toBe(0);
    });
  });

  describe("when the rows cannot be removed", () => {
    /**
     * Makes the delete of one item's allowance row fail until the returned function drops the trigger. The delete at the
     * start of a turn matches no row, so only the end of the turn fails. The id embedded in the function body is a
     * UUID that the check below has just matched against the UUID shape.
     */
    async function failDeleteOf(itemId: string): Promise<() => Promise<void>> {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(itemId)) throw new Error("Invalid fixture item UUID");
      const name = `test_allowance_delete_${randomUUID().replaceAll("-", "")}`;
      await admin.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.item_id = '${itemId}'::uuid THEN RAISE EXCEPTION 'allowance fixture failure'; END IF; RETURN OLD; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER ${name} BEFORE DELETE ON agent_run_read_allowances FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      return async () => {
        await admin.query(`DROP TRIGGER ${name} ON agent_run_read_allowances`);
        await admin.query(`DROP FUNCTION ${name}()`);
      };
    }

    function aggregateOf(error: unknown): AggregateError {
      if (!(error instanceof AggregateError)) throw new Error("Expected an AggregateError");
      return error;
    }

    it("stores the error state and reports the cleanup failure next to the turn error when the turn failed", async () => {
      const attached = await newHealthRecord("Attached for a failed cleanup");
      const faux = fauxProvider();
      faux.setResponses([
        () => {
          throw new Error("provider exploded");
        },
      ]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());
      const dropTrigger = await failDeleteOf(attached.id);
      try {
        const turn = await queueTurn("fail twice", [itemRef(attached, "Attached for a failed cleanup")]);
        const error = aggregateOf(
          await runTask(task, turn).then(
            () => undefined,
            (reason: unknown) => reason,
          ),
        );
        expect(error.message).toBe("Semp turn and read allowance cleanup failed");
        expect(error.cause).toBe(error.errors[0]);
        expect(error.errors).toHaveLength(2);
        expect(String(error.errors[1])).toContain("allowance fixture failure");
        expect((await replyOf(turn.assistantMessageId)).status).toBe("error");
      } finally {
        await dropTrigger();
        await admin.query("DELETE FROM agent_run_read_allowances WHERE tenant_id = $1 AND item_id = $2", [
          tenant,
          attached.id,
        ]);
      }
    });

    it("keeps the cleanup failure in the aggregate when the error state cannot be stored either", async () => {
      const attached = await newHealthRecord("Attached for two failures");
      const faux = fauxProvider();
      faux.setResponses([
        () => {
          throw new Error("provider exploded");
        },
      ]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());
      const turn = await queueTurn("fail thrice", [itemRef(attached, "Attached for two failures")]);
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(turn.assistantMessageId))
        throw new Error("Invalid fixture message UUID");
      // The id embedded in the function body is a UUID that the check above has just matched against the UUID shape.
      const name = `test_allowance_status_${randomUUID().replaceAll("-", "")}`;
      await admin.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${turn.assistantMessageId}'::uuid AND NEW.status = 'error' THEN RAISE EXCEPTION 'status fixture failure'; END IF; RETURN NEW; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER ${name} BEFORE UPDATE ON semp_messages FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      const dropAllowanceTrigger = await failDeleteOf(attached.id);
      try {
        const error = aggregateOf(
          await runTask(task, turn).then(
            () => undefined,
            (reason: unknown) => reason,
          ),
        );
        expect(error.message).toBe("Semp turn and error persistence failed");
        expect(error.cause).toBe(error.errors[0]);
        expect(error.errors).toHaveLength(3);
        expect(String(error.errors[1])).toContain("status fixture failure");
        expect(String(error.errors[2])).toContain("allowance fixture failure");
      } finally {
        await dropAllowanceTrigger();
        await admin.query(`DROP TRIGGER ${name} ON semp_messages`);
        await admin.query(`DROP FUNCTION ${name}()`);
        await admin.query("DELETE FROM agent_run_read_allowances WHERE tenant_id = $1 AND item_id = $2", [
          tenant,
          attached.id,
        ]);
      }
    });

    it("fails a turn whose model run succeeded when its rows cannot be removed, instead of completing it", async () => {
      const attached = await newHealthRecord("Attached for a failed end");
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("answer")]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());
      const dropTrigger = await failDeleteOf(attached.id);
      try {
        const turn = await queueTurn("succeed", [itemRef(attached, "Attached for a failed end")]);
        const error = aggregateOf(
          await runTask(task, turn).then(
            () => undefined,
            (reason: unknown) => reason,
          ),
        );
        expect(error.message).toBe("Semp turn and read allowance cleanup failed");
        expect(String(error.errors[0])).toContain("allowance fixture failure");
        expect((await replyOf(turn.assistantMessageId)).status).toBe("error");
      } finally {
        await dropTrigger();
        await admin.query("DELETE FROM agent_run_read_allowances WHERE tenant_id = $1 AND item_id = $2", [
          tenant,
          attached.id,
        ]);
      }
    });
  });

  describe("related items in databases the agent's project cannot read", () => {
    interface RelatedFixture {
      note: ItemRow;
      record: ItemRow;
    }

    /** A note in a user-created database, related through its `people` relation to a health record. */
    async function newNoteRelatedToRecord(): Promise<RelatedFixture> {
      const chokePoint = createChokePoint(runtime);
      return inTenant(async () => {
        const notes = await chokePoint.createDatabase({ name: `Notes ${randomUUID()}` });
        await chokePoint.createProperty({ databaseId: notes.id, key: "name", name: "Name", type: "title" });
        const toRecord = await chokePoint.createRelationProperty({
          sourceDatabaseId: notes.id,
          key: "people",
          name: "People",
          targetDatabaseId: healthDatabaseId,
        });
        const note = await chokePoint.createItem({ databaseId: notes.id, properties: { name: "Attached note" } });
        const record = await chokePoint.createItem({
          databaseId: healthDatabaseId,
          properties: { name: "Hidden title" },
        });
        await chokePoint.createRelation({
          relationPropertyId: toRecord.property.id,
          callerItemId: note.id,
          targetItemId: record.id,
        });
        return { note, record };
      });
    }

    // The user-only admin store of the grants is not exported from `@semprec/data`, so a fixture writes the decision directly.
    const setHealthAccess = (projectItemId: string, access: "none" | "read") =>
      inTenant(() =>
        withTransaction(runtime, (client) =>
          client.query(
            `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
            [projectItemId, healthDatabaseId, access],
          ),
        ),
      );

    it("names the related record only when the project may read its database, and otherwise lists it as { id, hidden: true }", async () => {
      const { note, record } = await newNoteRelatedToRecord();
      const expand = (agentProjectItemId?: string) =>
        inTenant(() =>
          expandSempRefs(runtime, [itemRef(note, "Attached note")], undefined, undefined, agentProjectItemId),
        );

      const hiddenFromProject = (await expand(semprecProjectItemId)).text;
      expect(hiddenFromProject).toContain("Attached note");
      expect(hiddenFromProject).toContain(`"hidden":[{"id":"${record.id}","hidden":true}]`);
      expect(hiddenFromProject).toContain('"names":[]');
      expect(hiddenFromProject).not.toContain("Hidden title");

      const withoutProject = (await expand()).text;
      expect(withoutProject).toContain("Hidden title");
      expect(withoutProject).not.toContain('"hidden"');

      await setHealthAccess(semprecProjectItemId, "read");
      try {
        const granted = (await expand(semprecProjectItemId)).text;
        expect(granted).toContain("Hidden title");
        expect(granted).not.toContain('"hidden"');
      } finally {
        await setHealthAccess(semprecProjectItemId, "none");
      }
    });

    /**
     * A dated task, the head of a repeating series, related through its `people` relation to a person. The People database
     * ships open to every project, so the test marks it sensitive for its duration (`setPeopleSensitive`) to make the
     * person's database one the Semprec project cannot read.
     */
    async function newTaskRelatedToPerson() {
      const chokePoint = createChokePoint(runtime);
      return inTenant(async () => {
        const [tasks, people] = await withTransaction(runtime, async (client) => [
          await getDatabaseByModuleId(client, "tasks"),
          await getDatabaseByModuleId(client, "people"),
        ]);
        if (!tasks || !people) throw new Error("System databases are missing");
        const property = (await chokePoint.listProperties(tasks.id)).find(
          (entry) => entry.key === "people" && entry.type === "relation",
        );
        if (!property) throw new Error("Missing the people relation of Tasks");
        const task = await chokePoint.createItem({
          databaseId: tasks.id,
          properties: { name: "Attached task", date: "2026-11-02" },
        });
        const person = await chokePoint.createItem({
          databaseId: people.id,
          properties: { name: "Hidden task title" },
        });
        await chokePoint.createRelation({
          relationPropertyId: property.id,
          callerItemId: task.id,
          targetItemId: person.id,
        });
        const seriesId = await startTaskSeries(runtime, {
          databaseId: tasks.id,
          itemId: task.id,
          mode: "fixed",
          rule: { kind: "weekdays", days: ["mon"] },
        });
        return { task, tasksId: tasks.id, person, seriesId };
      });
    }

    const setPeopleSensitive = (sensitive: boolean) =>
      admin.query("UPDATE databases SET sensitive = $2 WHERE tenant_id = $1 AND owner_module_id = 'people'", [
        tenant,
        sensitive,
      ]);

    it("hides the related person of a task trace and of a task occurrence ref, and names it while the database is open", async () => {
      const { task, tasksId, person, seriesId } = await newTaskRelatedToPerson();
      const refs: LabeledSempMessageRef[] = [
        { kind: "taskTrace", itemId: task.id, databaseId: tasksId, traceDay: "2026-11-02", label: "Trace" },
        { kind: "taskOccurrence", seriesId, occurrenceDate: "2026-11-16", label: "Occurrence" },
      ];
      const expand = (agentProjectItemId?: string) =>
        inTenant(() => expandSempRefs(runtime, refs, undefined, undefined, agentProjectItemId));

      const open = (await expand(semprecProjectItemId)).text;
      expect(open.split("Hidden task title")).toHaveLength(3);
      expect(open).not.toContain('"hidden"');

      await setPeopleSensitive(true);
      try {
        const hidden = (await expand(semprecProjectItemId)).text;
        expect(hidden).toContain("taskTrace: Attached task");
        expect(hidden).toContain("taskOccurrence: Attached task");
        expect(hidden.split(`"hidden":[{"id":"${person.id}","hidden":true}]`)).toHaveLength(3);
        expect(hidden).not.toContain("Hidden task title");

        // A reader that is not an agent project still names the person.
        expect((await expand()).text.split("Hidden task title")).toHaveLength(3);
      } finally {
        await setPeopleSensitive(false);
      }
    });

    it("hides the related record in the prompt of the turn and of a later turn that wakes the stored history", async () => {
      const { note, record } = await newNoteRelatedToRecord();
      const faux = fauxProvider();
      const prompts: string[] = [];
      const record_ =
        (answer: string): FauxResponseStep =>
        (context) => {
          prompts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(answer);
        };
      faux.setResponses([record_("first"), record_("second")]);

      const first = await runTurn(
        createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns()),
        "what is related?",
        [itemRef(note, "Attached note")],
      );
      expect(first.status).toBe("done");
      // A task of its own has no live session for the thread, so the next turn wakes a run and rebuilds the history.
      const second = await runTurn(
        createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns()),
        "and again?",
        [],
        first.threadId,
      );
      expect(second.status).toBe("done");
      expect(second.runId).not.toBe(first.runId);

      expect(prompts).toHaveLength(2);
      for (const prompt of prompts) {
        expect(prompt).toContain("Attached note");
        expect(prompt).toContain(record.id);
        expect(prompt).not.toContain("Hidden title");
      }
    });
  });
});
