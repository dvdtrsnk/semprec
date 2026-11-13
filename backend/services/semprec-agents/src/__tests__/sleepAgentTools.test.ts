import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createUser,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import * as piSession from "../piAgentSession.js";
import type { PiAgentSessionFactoryOptions } from "../piAgentSession.js";

// A seeded tenant has the Sleep system project, which owns the three sleep databases, and the Semprec project, which
// owns the Inbox. A session of the Sleep project is offered the two sleep tools; the user's grants on the sensitive
// sleep databases decide whether a call may read or write. 2026-10-16 is a Friday, so its night is a weekend night.

const NIGHT = "2026-10-16";

type SleepModule = "sleepSettings" | "sleepPlans" | "sleepNights";

/** The status and the error code of a refusal result, narrowed from the JSON text of the tool result. */
function refusalOf(text: string): { status: unknown; error: unknown } {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("status" in parsed) || !("error" in parsed)) {
    throw new Error("The tool result is not a refusal");
  }
  return { status: parsed.status, error: parsed.error };
}

let admin: Pool;
let pool: Pool;
let tenant: string;
let userId: string;
let sleepProjectId: string;
let semprecProjectId: string;
let databaseIds: Record<SleepModule, string>;

/** The grant of the user for the Sleep project, stored with the statement of `setAgentDatabaseGrant` (not exported). */
async function grantSleep(access: "read" | "write", modules: readonly SleepModule[]) {
  await withTenantTransaction(pool, tenant, async (client) => {
    for (const module of modules) {
      await client.query(
        `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
        [sleepProjectId, databaseIds[module], access],
      );
    }
  });
}

async function nightExceptions(): Promise<Record<string, unknown>[]> {
  const { rows } = await admin.query<{ properties: Record<string, unknown> }>(
    "SELECT properties FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
    [databaseIds.sleepNights],
  );
  return rows.map((row) => row.properties);
}

async function resyncKeys(): Promise<string[]> {
  const { rows } = await admin.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'sleep.resync' ORDER BY key",
  );
  return rows.map((row) => row.key);
}

/** The options a session of `projectItemId`'s run is composed with, captured from the pi session factory. */
async function composeSession(projectItemId: string): Promise<PiAgentSessionFactoryOptions> {
  const registry = await loadFullModuleRegistry();
  const run = await createAgentRun(pool, { projectItemId, userId, triggeredBy: "user", task: "sleep" });
  let captured: PiAgentSessionFactoryOptions | undefined;
  const spy = vi.spyOn(piSession, "createPiAgentSessionFactory").mockImplementation((value) => {
    captured = value;
    return () => ({ async *messages() {} });
  });
  try {
    const faux = fauxProvider();
    await createAgentSessionFactoryForRun(
      pool,
      registry,
      {
        model: faux.getModel(),
        streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
        isBudgetRefusal: () => false,
      },
      run,
    );
  } finally {
    spy.mockRestore();
  }
  if (!captured) throw new Error("Session was not composed");
  return captured;
}

async function executeTool(options: PiAgentSessionFactoryOptions, name: string, params: Record<string, unknown>) {
  const tool = options.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} is not in the session`);
  return tool.execute(randomUUID(), params);
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => block.text ?? "").join("");
}

describe("the sleep tools in an agent session (issue gh-1840)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    userId = (await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "x" }))
      .id;
    await runInTenant(tenant, async () => {
      await seedSystem(pool);
      await withTransaction(pool, async (client) => {
        const settings = await getDatabaseByModuleId(client, "sleepSettings");
        const plans = await getDatabaseByModuleId(client, "sleepPlans");
        const nights = await getDatabaseByModuleId(client, "sleepNights");
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!settings || !plans || !nights?.ownerProjectItemId || !inbox?.ownerProjectItemId) {
          throw new Error("Missing sleep or Inbox setup");
        }
        databaseIds = { sleepSettings: settings.id, sleepPlans: plans.id, sleepNights: nights.id };
        sleepProjectId = nights.ownerProjectItemId;
        semprecProjectId = inbox.ownerProjectItemId;
      });
    });
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("offers both tools to a session of the project that owns the sleep databases and none to the Semprec project", async () => {
    await runInTenant(tenant, async () => {
      const sleep = await composeSession(sleepProjectId);
      const semprec = await composeSession(semprecProjectId);

      expect(sleep.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["sleepNightsGet", "sleepNightSet"]));
      expect(sleep.moduleToolNames?.has("sleepNightSet")).toBe(true);
      expect(sleep.moduleToolNames?.has("sleepNightsGet")).toBe(true);
      expect(semprec.tools.map((tool) => tool.name)).not.toContain("sleepNightSet");
      expect(semprec.tools.map((tool) => tool.name)).not.toContain("sleepNightsGet");
    });
  });

  it("runs sleepNightSet at once with the grants: the night is 00:00 to 07:00 with an alarm, no approval request exists, and the result is marked sensitive", async () => {
    await grantSleep("read", ["sleepSettings", "sleepPlans"]);
    await grantSleep("write", ["sleepNights"]);
    await runInTenant(tenant, async () => {
      const session = await composeSession(sleepProjectId);

      const answer = await executeTool(session, "sleepNightSet", { night: NIGHT, wakeTime: "07:00", alarm: true });

      expect(answer.details).toMatchObject({ error: false, sensitive: true });
      expect(JSON.parse(textOf(answer.content))).toMatchObject({
        night: { night: NIGHT, bedTime: "00:00", wakeTime: "07:00", alarm: true, changed: true },
      });
    });
    expect(await nightExceptions()).toEqual([{ night: NIGHT, wakeTime: "07:00", alarm: true }]);
    expect(await resyncKeys()).toEqual([`sleep-resync:${tenant}`]);
    expect((await admin.query("SELECT 1 FROM approval_requests WHERE tenant_id = $1", [tenant])).rowCount).toBe(0);
  });

  it("reads the nights with sleepNightsGet after the model's own sleepNightSet call in one session", async () => {
    await grantSleep("read", ["sleepSettings", "sleepPlans"]);
    await grantSleep("write", ["sleepNights"]);
    await runInTenant(tenant, async () => {
      const registry = await loadFullModuleRegistry();
      const run = await createAgentRun(pool, {
        projectItemId: sleepProjectId,
        userId,
        triggeredBy: "user",
        task: "sleep",
      });
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("sleepNightSet", { night: NIGHT, wakeTime: "07:00", alarm: true }, { id: "set-call" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxToolCall("sleepNightsGet", { from: NIGHT, to: NIGHT }, { id: "get-call" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      const factory = await createAgentSessionFactoryForRun(
        pool,
        registry,
        {
          model: faux.getModel(),
          streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
          isBudgetRefusal: () => false,
        },
        run,
      );

      const results: Record<string, unknown> = {};
      for await (const event of factory({ task: "move the alarm" }).messages()) {
        if (event.kind === "tool_result" && typeof event.toolCallId === "string") results[event.toolCallId] = event;
      }

      expect(results["set-call"]).toMatchObject({ name: "sleepNightSet", isError: false });
      expect(results["get-call"]).toMatchObject({ name: "sleepNightsGet", isError: false });
      expect(JSON.stringify(results["get-call"])).toContain("07:00");
    });
  });

  it("answers a 403 forbidden for both tools without a grant to the sleep databases, and writes nothing", async () => {
    await runInTenant(tenant, async () => {
      const session = await composeSession(sleepProjectId);

      const written = await executeTool(session, "sleepNightSet", { night: NIGHT, wakeTime: "07:00", alarm: true });
      const read = await executeTool(session, "sleepNightsGet", { from: NIGHT, to: NIGHT });

      for (const answer of [written, read]) {
        expect(answer.details).toMatchObject({ error: true });
        expect(answer.details).not.toHaveProperty("sensitive");
        expect(refusalOf(textOf(answer.content))).toMatchObject({
          status: 403,
          error: "forbidden",
        });
      }
    });
    expect(await nightExceptions()).toEqual([]);
    expect(await resyncKeys()).toEqual([]);
  });

  it("reports an invalid night or time as an error result and writes nothing", async () => {
    await grantSleep("read", ["sleepSettings", "sleepPlans"]);
    await grantSleep("write", ["sleepNights"]);
    await runInTenant(tenant, async () => {
      const session = await composeSession(sleepProjectId);

      const badNight = await executeTool(session, "sleepNightSet", { night: "2026-13-01", wakeTime: "07:00" });
      const badTime = await executeTool(session, "sleepNightSet", { night: NIGHT, wakeTime: "7:5" });
      const unknownKey = await executeTool(session, "sleepNightSet", { night: NIGHT, wake: "07:00" });

      expect(refusalOf(textOf(badNight.content))).toMatchObject({ status: 400 });
      expect(refusalOf(textOf(badTime.content))).toMatchObject({ status: 400 });
      expect(textOf(unknownKey.content)).toBe("Invalid tool arguments.");
      for (const answer of [badNight, badTime, unknownKey]) expect(answer.details).toMatchObject({ error: true });
    });
    expect(await nightExceptions()).toEqual([]);
    expect(await resyncKeys()).toEqual([]);
  });
});
