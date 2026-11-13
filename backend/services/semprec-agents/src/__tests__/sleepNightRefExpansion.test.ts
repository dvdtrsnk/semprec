import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
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
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";
import { expandSempRefs } from "../refExpansion.js";
import { MAX_REF_CONTEXT_CHARS } from "../refExpansionLimits.js";
import { createSempHistoryReconstruction } from "../sempHistoryReconstruction.js";
import { createSempMessageTask } from "../sempMessageTask.js";
import { readAllowedItemIds, readAttachedSleepNights } from "../sempTurnReadAllowances.js";

// A seeded tenant has the weekdays plan (mon to fri, 23:00 to 06:45, alarm) and the weekend plan (sat and sun, 00:00 to
// 08:30, no alarm), in Europe/Prague. 2026-10-16 is a Friday, so its night belongs to the Saturday morning and the
// weekend plan. The weekend plan is renamed to a sentinel so that its text can be searched for.

const USER = { writerKind: "user" } as const;
const NIGHT = "2026-10-16";
const SENTINEL = "WEEKEND_PLAN_SENTINEL_1853";
const SLEEP_MODULES = ["sleepSettings", "sleepPlans", "sleepNights"] as const;

interface SleepTenant {
  id: string;
  /** The Semprec project item. */
  projectItemId: string;
  databaseIds: Record<(typeof SLEEP_MODULES)[number], string>;
  settingsItemId: string;
  weekendPlanId: string;
  weekdaysPlanId: string;
}

let admin: Pool;
let runtime: Pool;
let main: SleepTenant;
let registry: ModuleRegistry;

const inTenant = <T>(t: SleepTenant, fn: () => Promise<T>) => runInTenant(t.id, fn);

function gatewayOf(faux: ReturnType<typeof fauxProvider>): GatewayModel {
  return {
    model: faux.getModel(),
    streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
    isBudgetRefusal: () => false,
  };
}

async function seededTenant(): Promise<SleepTenant> {
  const id = await createTestTenant(admin);
  await createUser(admin, { tenantId: id, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
  await runInTenant(id, () => seedSystem(runtime));
  const found = await runInTenant(id, () =>
    withTransaction(runtime, async (client) => {
      const databases = await Promise.all([...SLEEP_MODULES, "inbox"].map((key) => getDatabaseByModuleId(client, key)));
      const [settings, plans, nights, inbox] = databases;
      if (!settings || !plans || !nights || !inbox?.ownerProjectItemId) throw new Error("System databases are missing");
      const items = await client.query<{ id: string; database_id: string; properties: { wakeDays?: string[] } }>(
        "SELECT id, database_id, properties FROM items WHERE database_id = ANY($1::uuid[]) AND deleted_at IS NULL",
        [[settings.id, plans.id]],
      );
      const plan = (day: string) => items.rows.find((row) => row.properties.wakeDays?.includes(day))?.id;
      const settingsItemId = items.rows.find((row) => row.database_id === settings.id)?.id;
      const weekendPlanId = plan("sat");
      const weekdaysPlanId = plan("mon");
      if (!settingsItemId || !weekendPlanId || !weekdaysPlanId) throw new Error("The sleep items are missing");
      return {
        id,
        projectItemId: inbox.ownerProjectItemId,
        databaseIds: { sleepSettings: settings.id, sleepPlans: plans.id, sleepNights: nights.id },
        settingsItemId,
        weekendPlanId,
        weekdaysPlanId,
      };
    }),
  );
  return found;
}

function renamePlan(t: SleepTenant, name: string): Promise<unknown> {
  return inTenant(t, () =>
    createChokePoint(runtime).updateItem(
      { databaseId: t.databaseIds.sleepPlans, itemId: t.weekendPlanId, propertiesPatch: { name } },
      undefined,
      undefined,
      USER,
    ),
  );
}

function createNightException(t: SleepTenant, night: string, bedTime: string): Promise<string> {
  return inTenant(t, async () => {
    const item = await createChokePoint(runtime).createItem(
      { databaseId: t.databaseIds.sleepNights, properties: { night, bedTime } },
      undefined,
      undefined,
      USER,
    );
    return item.id;
  });
}

/** The user-only admin store of the grants is not exported from `@semprec/data`, so a fixture writes the decision. */
function grantSleep(
  t: SleepTenant,
  access: "none" | "read",
  modules: readonly (typeof SLEEP_MODULES)[number][] = SLEEP_MODULES,
) {
  return inTenant(t, () =>
    withTransaction(runtime, async (client) => {
      for (const module of modules) {
        await client.query(
          `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
          [t.projectItemId, t.databaseIds[module], access],
        );
      }
    }),
  );
}

const nightRef = (night: string, label = night): LabeledSempMessageRef => ({ kind: "sleepNight", night, label });
/** The ref as the message endpoint stores it, before the expander captures a label. */
const storedNight = (night: string) => ({ kind: "sleepNight", night });

function expand(t: SleepTenant, refs: unknown[], options: { project?: string | null; attached?: boolean }) {
  const project = options.project === undefined ? t.projectItemId : (options.project ?? undefined);
  return inTenant(t, () =>
    expandSempRefs(runtime, refs, undefined, undefined, project, { attachedThisTurn: options.attached === true }),
  );
}

/** Queues a user message with the refs and runs its task once, like the queue does. */
async function runTurn(
  t: SleepTenant,
  task: ReturnType<typeof createSempMessageTask>,
  text: string,
  context: LabeledSempMessageRef[],
  threadId?: string,
): Promise<{ threadId: string; assistantMessageId: string; status: string; runId: string | null }> {
  const turn = await inTenant(t, () =>
    withTransaction(runtime, (client) =>
      sendSempMessage(client, { text, context, hasContext: context.length > 0, ...(threadId ? { threadId } : {}) }),
    ),
  );
  await inTenant(t, () =>
    task({ threadId: turn.threadId, assistantMessageId: turn.assistantMessageId }, { job: { id: randomUUID() } }),
  );
  const { rows } = await inTenant(t, () =>
    runtime.query<{ status: string; agent_run_id: string | null }>(
      "SELECT status, agent_run_id FROM semp_messages WHERE id = $1",
      [turn.assistantMessageId],
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("The reply message is missing");
  return { ...turn, status: row.status, runId: row.agent_run_id };
}

async function allowedItemIds(t: SleepTenant, runId: string): Promise<string[]> {
  const { rows } = await admin.query<{ item_id: string }>(
    "SELECT item_id FROM agent_run_read_allowances WHERE agent_run_id = $1 AND tenant_id = $2 ORDER BY item_id",
    [runId, t.id],
  );
  return rows.map((row) => row.item_id);
}

async function toolOutcome(
  t: SleepTenant,
  runId: string,
  toolCallId: string,
): Promise<{ isError: boolean; text: string }> {
  const { rows } = await inTenant(t, () =>
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

const toolCall = (name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

describe("a sleepNight reference in the agent turn (issue #1853)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    registry = await loadFullModuleRegistry();
    main = await seededTenant();
    await renamePlan(main, SENTINEL);
  });

  beforeEach(async () => {
    // Every case starts without any grant of the Semprec project on the sleep databases.
    await admin.query("DELETE FROM agent_database_grants WHERE tenant_id = $1", [main.id]);
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
    if (errors.length) throw new AggregateError(errors, "Sleep night test cleanup failed", { cause: errors[0] });
  });

  describe("which items the attachment opens", () => {
    it("takes the nights of the sleepNight refs, each once, labeled or not, and no item id", () => {
      const stored = [
        nightRef(NIGHT),
        { kind: "sleepNight", night: NIGHT },
        { kind: "sleepNight", night: "2026-10-17" },
        { kind: "sleepNight", night: "2026-13-01" },
        { kind: "agentRun", agentRunId: randomUUID() },
      ];

      expect(readAttachedSleepNights(stored)).toEqual([NIGHT, "2026-10-17"]);
      expect(readAllowedItemIds(stored)).toEqual([]);
      expect(readAttachedSleepNights(null)).toEqual([]);
      expect(readAttachedSleepNights({ kind: "sleepNight", night: NIGHT })).toEqual([]);
    });
  });

  describe("the prompt of the turn that attaches the night", () => {
    it("renders the night 00:00 to 08:30 of the weekend plan without an alarm, with the plan and exception ids", async () => {
      const exceptionId = await createNightException(main, "2026-10-20", "02:00");

      const expanded = await expand(main, [storedNight(NIGHT)], { attached: true });

      expect(expanded.context).toEqual([nightRef(NIGHT)]);
      expect(expanded.text).toContain(`sleepNight: ${NIGHT}\n`);
      const details = JSON.parse(expanded.text.slice(expanded.text.indexOf("{"))) as Record<string, unknown>;
      expect(details).toEqual({
        night: NIGHT,
        planName: SENTINEL,
        bedTime: "00:00",
        wakeTime: "08:30",
        alarm: false,
        changed: false,
        durationMinutes: 510,
        prepReminderAt: "2026-10-16T23:30:00+02:00",
        planItemId: main.weekendPlanId,
        exceptionItemId: null,
      });
      expect(expanded.text).not.toContain(exceptionId);
    });

    it("renders that no sleep is planned for a night with neither a plan nor an exception", async () => {
      const bare = await seededTenant();
      for (const planId of [bare.weekendPlanId, bare.weekdaysPlanId]) {
        await inTenant(bare, () =>
          createChokePoint(runtime).softDeleteItem(bare.databaseIds.sleepPlans, planId, undefined, USER),
        );
      }

      const expanded = await expand(bare, [nightRef(NIGHT)], { attached: true });

      expect(expanded.text).toContain("no sleep planned for this night");
      expect(expanded.text).not.toContain("bedTime");
    });

    it("bounds the section at the size of one reference", async () => {
      const crowded = await seededTenant();
      await renamePlan(crowded, "L".repeat(MAX_REF_CONTEXT_CHARS * 2));

      const expanded = await expand(crowded, [nightRef(NIGHT)], { attached: true });

      expect(expanded.text).toHaveLength(MAX_REF_CONTEXT_CHARS);
      expect(expanded.text).toMatch(/\[truncated\]$/);
    });

    it("reads the night of the own tenant only", async () => {
      const other = await seededTenant();
      await createNightException(other, NIGHT, "05:05");

      const own = await expand(main, [nightRef(NIGHT)], { attached: true });
      const foreign = await expand(other, [nightRef(NIGHT)], { attached: true });

      expect(own.text).not.toContain("05:05");
      expect(foreign.text).toContain("05:05");
      expect(foreign.text).not.toContain(SENTINEL);
    });
  });

  describe("a night that is not attached by the turn", () => {
    it("is unavailable without a grant, expands nothing from the sleep databases and leaves the other refs and the turn alone", async () => {
      const missingRun: LabeledSempMessageRef = { kind: "agentRun", agentRunId: randomUUID(), label: "Gone" };

      const expanded = await expand(main, [storedNight(NIGHT), missingRun], {});

      expect(expanded.text).toBe(
        "sleepNight: unavailable (no access).\n\nagentRun: no longer exists or is unavailable.",
      );
      expect(expanded.text).not.toContain(SENTINEL);
      expect(expanded.text).not.toContain("08:30");
      expect(expanded.context).toEqual([nightRef(NIGHT, ""), missingRun]);
    });

    it("is unavailable when no agent project is known", async () => {
      const expanded = await expand(main, [nightRef(NIGHT)], { project: null });

      expect(expanded.text).toBe("sleepNight: unavailable (no access).");
    });

    it("is unavailable to a project whose grant is none, and when one of the three databases is not granted", async () => {
      await grantSleep(main, "none");
      expect((await expand(main, [nightRef(NIGHT)], {})).text).toBe("sleepNight: unavailable (no access).");

      await grantSleep(main, "read", ["sleepSettings", "sleepPlans"]);
      expect((await expand(main, [nightRef(NIGHT)], {})).text).toBe("sleepNight: unavailable (no access).");
    });

    it("is read with the grant of the project on the three sleep databases", async () => {
      await grantSleep(main, "read");

      const expanded = await expand(main, [nightRef(NIGHT)], {});

      expect(expanded.text).toContain(SENTINEL);
      expect(expanded.text).toContain('"bedTime":"00:00","wakeTime":"08:30","alarm":false');
      expect(expanded.context).toEqual([nightRef(NIGHT)]);
    });

    it("is rebuilt for a later turn from the history under the same rule", async () => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("noted")]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());
      const turn = await runTurn(main, task, "about last night", [nightRef(NIGHT)]);
      expect(turn.status).toBe("done");
      const reconstruct = createSempHistoryReconstruction();
      const rebuild = async () => {
        const history = await inTenant(main, () =>
          reconstruct(runtime, { threadId: turn.threadId, projectItemId: main.projectItemId }),
        );
        return history?.entries.flatMap((entry) => (entry.message.kind === "user_message" ? [entry.message.text] : []));
      };

      const withoutGrant = await rebuild();
      expect(withoutGrant).toHaveLength(1);
      expect(withoutGrant?.[0]).toContain("sleepNight: unavailable (no access).");
      expect(withoutGrant?.[0]).not.toContain(SENTINEL);

      await grantSleep(main, "read");
      const withGrant = await rebuild();
      expect(withGrant?.[0]).toContain(SENTINEL);
      expect(withGrant?.[0]).not.toContain("unavailable");
    });
  });

  describe("a turn that attaches a night", () => {
    it("shows the model the night, lets the run read the settings, the plans and that night's exception but nothing else, and leaves no row", async () => {
      const exceptionId = await createNightException(main, NIGHT, "01:30");
      const otherNightId = await createNightException(main, "2026-10-21", "03:30");
      const faux = fauxProvider();
      let promptSeen = "";
      let rowsDuring: string[] = [];
      let runIdDuring: string | undefined;
      faux.setResponses([
        async (context) => {
          promptSeen = JSON.stringify(context.messages);
          const { rows } = await admin.query<{ agent_run_id: string; item_id: string }>(
            "SELECT agent_run_id, item_id FROM agent_run_read_allowances WHERE tenant_id = $1",
            [main.id],
          );
          runIdDuring = rows[0]?.agent_run_id;
          rowsDuring = rows.map((row) => row.item_id).sort();
          return toolCall("item_get", { itemId: main.weekendPlanId }, "read-plan");
        },
        toolCall("item_get", { itemId: exceptionId }, "read-exception"),
        toolCall("item_get", { itemId: main.settingsItemId }, "read-settings"),
        toolCall("item_get", { itemId: otherNightId }, "read-other-night"),
        toolCall(
          "item_patch",
          { itemId: main.weekendPlanId, properties: { name: "Changed" }, ifVersion: new Date().toISOString() },
          "patch-plan",
        ),
        fauxAssistantMessage("done"),
      ]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());

      const turn = await runTurn(main, task, "how did I sleep", [nightRef(NIGHT)]);

      expect(turn.status).toBe("done");
      const runId = turn.runId;
      if (!runId) throw new Error("The turn has no run");
      expect(promptSeen).toContain(SENTINEL);
      expect(promptSeen).toContain("08:30");
      expect(promptSeen).toContain(exceptionId);
      expect(runIdDuring).toBe(runId);
      expect(rowsDuring).toEqual([main.settingsItemId, main.weekdaysPlanId, main.weekendPlanId, exceptionId].sort());
      for (const call of ["read-plan", "read-exception", "read-settings"]) {
        expect((await toolOutcome(main, runId, call)).isError).toBe(false);
      }
      for (const call of ["read-other-night", "patch-plan"]) {
        const refused = await toolOutcome(main, runId, call);
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("forbidden");
      }
      expect(await allowedItemIds(main, runId)).toEqual([]);
    });

    it("keeps the expanded text out of agent_runs.task and out of the run events", async () => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("fine")]);
      const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());

      const turn = await runTurn(main, task, "how did I sleep", [nightRef(NIGHT)]);

      expect(turn.status).toBe("done");
      const runId = turn.runId;
      if (!runId) throw new Error("The turn has no run");
      const stored = await inTenant(main, async () => ({
        run: await runtime.query<{ task: string }>("SELECT task FROM agent_runs WHERE id = $1", [runId]),
        events: await runtime.query<{ payload: unknown }>(
          "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id",
          [runId],
        ),
      }));
      expect(stored.run.rows).toEqual([{ task: "how did I sleep" }]);
      const events = JSON.stringify(stored.events.rows);
      expect(events).not.toContain(SENTINEL);
      expect(events).not.toContain("08:30");
      expect(events).not.toContain("sleepNight: ");
      // The reference itself is kept, as it is for any other kind.
      expect(events).toContain(`"night":"${NIGHT}"`);
    });
  });
});
