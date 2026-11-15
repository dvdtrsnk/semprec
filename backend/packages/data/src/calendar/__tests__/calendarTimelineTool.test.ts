import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setAgentDatabaseGrant } from "../../agentGrants/agentDatabaseGrantsAdminStore.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import {
  resolveModuleAgentToolsForRun,
  resolveModuleAgentToolsForUser,
  type ResolvedHumanModuleAgentTool,
  type ResolvedModuleAgentTool,
} from "../../agentTools/moduleAgentTools.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../../seed/sleepModuleKeys.js";
import { EVENTS_MODULE_ID, PROJECTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createEventInCalendar } from "../defaultCalendarCreateHook.js";
import { createCalendarTimelineTool } from "../calendarTimelineTool.js";
import { createCalendarTimelineRouteHandler } from "../timelineRouteHandler.js";
import { hideSleepInCalendar } from "./hideSleepInCalendar.js";

/**
 * The read tool `calendar.timeline` (issue gh-1952), on the runtime role pool and in tenants of their own. The tool runs
 * as `ResolvedModuleAgentTool.invoke`, the entry an agent session and `/mcp` use, so its argument schema is in the path.
 * The route runs on the same pool for the expected answers.
 */

const TIMELINE = "calendar.timeline";
const DAY = "2026-10-16";

interface Tenant {
  id: string;
  userId: string;
  /** The project that owns the calendar databases: the project of a run that holds `calendar.read`. */
  calendarProjectId: string;
  tasksId: string;
  eventsId: string;
  calendarsId: string;
  runId: string;
  /** The ids of the three sleep databases: settings, plans and nights. */
  sleepDatabaseIds: string[];
}

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
let home: Tenant;
let foreign: Tenant;
/** A tenant whose seeded sleep settings show the nights in the calendar, as a seeded tenant has them by default. */
let sleepy: Tenant;

const timelineSchema = z.looseObject({
  timezone: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.string(),
      title: z.string().optional(),
      calendarId: z.string().nullable().optional(),
    }),
  ),
});

async function seededTenant(options: { showSleep?: boolean } = {}): Promise<Tenant> {
  const id = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId: id,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(id, () => seedSystem(runtime));
  // The sleep nights of a seeded tenant have their own tests (issue #1806); these keep to Events and Tasks.
  if (options.showSleep !== true) await hideSleepInCalendar(runtime, id);
  return runInTenant(id, async () => {
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const sleepDatabaseIds = [SLEEP_SETTINGS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_NIGHTS_MODULE_ID].map(
      (key) => db(key).id,
    );
    const calendarProjectId = db(CALENDARS_MODULE_ID).ownerProjectItemId;
    if (!calendarProjectId) throw new Error("The calendars database has no owner project");
    const run = await createAgentRun(runtime, {
      projectItemId: calendarProjectId,
      userId: user.id,
      triggeredBy: "user",
      task: "calendar work",
    });
    return {
      id,
      userId: user.id,
      calendarProjectId,
      tasksId: db(TASKS_MODULE_ID).id,
      eventsId: db(EVENTS_MODULE_ID).id,
      calendarsId: db(CALENDARS_MODULE_ID).id,
      runId: run.id,
      sleepDatabaseIds,
    };
  });
}

/** The tools the run of `tenant` is offered as an agent session resolves them, or as `/mcp` does with `effective`. */
function toolsOf(
  tenant: Tenant,
  options: { includeApprovalGated?: boolean; projectItemId?: string; runId?: string } = {},
  mcp?: { effective: string[] },
): Promise<ResolvedModuleAgentTool[]> {
  return runInTenant(tenant.id, () =>
    resolveModuleAgentToolsForRun(
      runtime,
      registry,
      options.runId ?? tenant.runId,
      options.projectItemId ?? tenant.calendarProjectId,
      mcp === undefined ? undefined : new Set(mcp.effective),
      {
        ...(options.includeApprovalGated === undefined ? {} : { includeApprovalGated: options.includeApprovalGated }),
        ...(mcp === undefined ? {} : { mcpExposure: true }),
      },
    ),
  );
}

async function timelineTool(tenant: Tenant): Promise<ResolvedModuleAgentTool> {
  const found = (await toolsOf(tenant)).find((candidate) => candidate.name === TIMELINE);
  if (!found) throw new Error(`Tool ${TIMELINE} is not offered`);
  return found;
}

/** Calls the tool of `tenant`'s run as an agent session does, inside the tenant, and parses the answer. */
async function callTimeline(tenant: Tenant, args: unknown) {
  const resolved = await timelineTool(tenant);
  const answer = await runInTenant(tenant.id, () => resolved.invoke(args));
  expect(answer.error).toBe(false);
  return timelineSchema.parse(JSON.parse(answer.result));
}

/** The route's answer for `from`..`to`, as JSON carries it. */
async function routeTimeline(tenant: Tenant, from: string, to: string) {
  const { body } = await runInTenant(tenant.id, () =>
    createCalendarTimelineRouteHandler(runtime)({ req: { url: `/api/calendar/timeline?from=${from}&to=${to}` } }),
  );
  return timelineSchema.parse(JSON.parse(JSON.stringify(body)));
}

async function create(tenant: Tenant, databaseId: string, properties: Record<string, unknown>): Promise<string> {
  return (await runInTenant(tenant.id, () => cp.createItem({ databaseId, properties }))).id;
}

async function calendarNamed(tenant: Tenant, name: string): Promise<string> {
  const { items } = await runInTenant(tenant.id, () => cp.listItems(tenant.calendarsId, { limit: 50 }));
  const found = items.find((item) => item.properties.name === name);
  if (!found) throw new Error(`Missing calendar ${name}`);
  return found.id;
}

/** An Event in the calendar `calendarId`, written the way the app writes it: through the create hook of the calendar module. */
async function eventInCalendar(tenant: Tenant, calendarId: string, properties: Record<string, unknown>) {
  const created = await runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) =>
      createEventInCalendar(client, { properties }, calendarId, {
        writer: { writerKind: "user" },
        actingUserId: tenant.userId,
        humanWriterUserId: tenant.userId,
      }),
    ),
  );
  return created.id;
}

async function itemCount(): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM items");
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

describe("calendar.timeline (issue gh-1952)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(runtime);
    registry = await loadFullModuleRegistry();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    home = await seededTenant();
    foreign = await seededTenant();
    sleepy = await seededTenant({ showSleep: true });
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("the declaration", () => {
    it("is offered to a run whose project owns the calendar databases, as a read that needs no approval", async () => {
      for (const includeApprovalGated of [false, true]) {
        const tools = await toolsOf(home, { includeApprovalGated });
        const offered = tools.filter((candidate) => candidate.name === TIMELINE);
        expect(offered.map((candidate) => [candidate.requiresApproval, candidate.riskClass])).toEqual([
          [false, "read"],
        ]);
      }
    });

    it("is left out for a run whose project does not own the calendar databases", async () => {
      const other = await runInTenant(home.id, async () => {
        const databases = await cp.listDatabases();
        const projects = databases.find((row) => row.ownerModuleId === PROJECTS_MODULE_ID);
        if (!projects) throw new Error("Missing Projects");
        return cp.createItem({ databaseId: projects.id, properties: { name: "Other project" } });
      });
      const run = await runInTenant(home.id, () =>
        createAgentRun(runtime, {
          projectItemId: other.id,
          userId: home.userId,
          triggeredBy: "user",
          task: "other work",
        }),
      );
      const names = (await toolsOf(home, { projectItemId: other.id, runId: run.id })).map((entry) => entry.name);
      expect(names).not.toContain(TIMELINE);
    });

    it("is offered over /mcp only to a credential whose list names calendar.read", async () => {
      const offered = async (effective: string[]) =>
        (await toolsOf(home, { includeApprovalGated: true }, { effective }))
          .map((entry) => entry.name)
          .filter((name) => name.startsWith("calendar."));

      expect(await offered(["core.item.read", "calendar.read"])).toEqual([TIMELINE]);
      // The write capability does not stand for the read one, and a list of core ids only exposes no module tool.
      expect(await offered(["core.item.read", "calendar.write"])).not.toContain(TIMELINE);
      expect(await offered(["core.item.read"])).not.toContain(TIMELINE);
    });

    it("refuses arguments the tool does not accept, before any handler runs", async () => {
      const resolved = await timelineTool(home);
      expect(resolved.acceptsArguments({ from: DAY, to: DAY })).toBe(true);
      expect(resolved.acceptsArguments({ from: DAY, to: DAY, extra: true })).toBe(false);
      expect(resolved.acceptsArguments({ from: DAY })).toBe(false);
      await expect(runInTenant(home.id, () => resolved.invoke({ from: DAY }))).rejects.toThrow(
        "Invalid tool arguments.",
      );
    });

    it("describes its range to the model in its argument schema", async () => {
      const resolved = await timelineTool(home);
      expect(resolved.argumentSchema).toMatchObject({
        type: "object",
        required: ["from", "to"],
        properties: { from: { type: "string" }, to: { type: "string" } },
      });
    });
  });

  describe("the answer", () => {
    it("returns the items the route returns for the same range", async () => {
      const personal = await calendarNamed(home, "Personal");
      await eventInCalendar(home, personal, { name: "Standup", date: DAY, timeFrom: "09:00", timeTo: "09:30" });
      await eventInCalendar(home, personal, { name: "Trip", date: "2026-10-15", endDate: "2026-10-17" });
      await create(home, home.eventsId, { name: "Dentist", date: "2026-10-18" });
      await create(home, home.tasksId, { name: "Pay rent", date: DAY });
      await create(home, home.tasksId, { name: "Out of range", date: "2026-11-30" });

      const answer = await callTimeline(home, { from: "2026-10-15", to: "2026-10-18" });
      const route = await routeTimeline(home, "2026-10-15", "2026-10-18");

      expect(answer.items.map((item) => item.title)).toEqual(
        expect.arrayContaining(["Standup", "Trip", "Dentist", "Pay rent"]),
      );
      expect(answer.items.map((item) => item.title)).not.toContain("Out of range");
      expect(answer.items).toEqual(route.items);
      expect({ timezone: answer.timezone, from: answer.from, to: answer.to }).toEqual({
        timezone: route.timezone,
        from: "2026-10-15",
        to: "2026-10-18",
      });
    });

    it("returns the items of a hidden calendar", async () => {
      const hidden = await calendarNamed(home, "Personal");
      await runInTenant(home.id, () =>
        cp.updateItem({ databaseId: home.calendarsId, itemId: hidden, propertiesPatch: { hidden: true } }),
      );
      const inHidden = await eventInCalendar(home, hidden, { name: "In a hidden calendar", date: DAY });

      const answer = await callTimeline(home, { from: DAY, to: DAY });

      expect(answer.items.map((item) => [item.id, item.calendarId])).toEqual([[inHidden, hidden]]);
      expect((await routeTimeline(home, DAY, DAY)).items).toEqual(answer.items);
    });

    it("answers a range of 93 days like the route and refuses one of 94 where the route refuses it", async () => {
      const first = await create(home, home.eventsId, { name: "First day", date: "2026-01-01" });
      const last = await create(home, home.eventsId, { name: "Last day", date: "2026-04-03" });
      const after = await create(home, home.eventsId, { name: "After", date: "2026-04-04" });

      // 1 January to 3 April 2026 is 31 + 28 + 31 + 3 = 93 days, both included.
      const answer = await callTimeline(home, { from: "2026-01-01", to: "2026-04-03" });
      // The range also holds the public holidays of the tenant's calendar, which the route returns too.
      const ids = answer.items.map((item) => item.id);
      expect(ids).toEqual(expect.arrayContaining([first, last]));
      expect(ids).not.toContain(after);
      expect(answer.items).toEqual((await routeTimeline(home, "2026-01-01", "2026-04-03")).items);

      const resolved = await timelineTool(home);
      expect(resolved.acceptsArguments({ from: "2026-01-01", to: "2026-04-04" })).toBe(false);
      await expect(routeTimeline(home, "2026-01-01", "2026-04-04")).rejects.toMatchObject({ status: 400 });
    });

    it.each([
      ["a range longer than 93 days", { from: "2026-01-01", to: "2026-04-04" }],
      ["an inverted range", { from: "2026-10-17", to: DAY }],
      ["a from that is no date", { from: "abc", to: DAY }],
      ["a from that does not exist", { from: "2026-02-30", to: "2026-03-01" }],
      ["a from with a time", { from: `${DAY}T10:00`, to: DAY }],
      ["a to in another notation", { from: DAY, to: "16.10.2026" }],
      ["a to that is no string", { from: DAY, to: 20261016 }],
      ["a missing to", { from: DAY }],
      ["no arguments", {}],
      ["an argument it does not know", { from: DAY, to: DAY, shape: "compact" }],
    ])("fails %s as a validation error and reads nothing", async (_name, args) => {
      const resolved = await timelineTool(home);
      expect(resolved.acceptsArguments(args)).toBe(false);
      await expect(runInTenant(home.id, () => resolved.invoke(args))).rejects.toThrow("Invalid tool arguments.");
    });

    it("never returns another tenant's items, and returns that tenant's own to it", async () => {
      const own = await create(home, home.eventsId, { name: "Mine", date: DAY });
      const theirs = await create(foreign, foreign.eventsId, { name: "Theirs", date: DAY });
      const theirTask = await create(foreign, foreign.tasksId, { name: "Their task", date: DAY });

      const answer = await callTimeline(home, { from: DAY, to: DAY });
      expect(answer.items.map((item) => item.id)).toEqual([own]);
      const raw = JSON.stringify(answer);
      expect(raw).not.toContain(theirs);
      expect(raw).not.toContain(theirTask);

      const theirAnswer = await callTimeline(foreign, { from: DAY, to: DAY });
      expect(theirAnswer.items.map((item) => item.id).sort()).toEqual([theirs, theirTask].sort());
    });

    it("writes nothing", async () => {
      await create(home, home.eventsId, { name: "Standup", date: DAY });
      const before = await itemCount();

      await callTimeline(home, { from: DAY, to: DAY });

      expect(await itemCount()).toBe(before);
    });
  });

  describe("a human /mcp session (the human handler)", () => {
    async function sessionTools(tenant: Tenant): Promise<ResolvedHumanModuleAgentTool[]> {
      return runInTenant(tenant.id, () => resolveModuleAgentToolsForUser(runtime, registry, tenant.userId, {}));
    }

    async function sessionTimeline(tenant: Tenant, args: unknown) {
      const found = (await sessionTools(tenant)).find((candidate) => candidate.name === TIMELINE);
      if (!found) throw new Error(`Tool ${TIMELINE} is not offered to a session`);
      return runInTenant(tenant.id, () => found.invoke(args));
    }

    it("is offered with no approval flag", async () => {
      const offered = (await sessionTools(home)).filter((candidate) => candidate.name === TIMELINE);
      expect(offered).toHaveLength(1);
      expect(offered[0]).not.toHaveProperty("requiresApproval");
    });

    it("returns the items the route returns, and none of another tenant", async () => {
      const own = await create(home, home.eventsId, { name: "Mine", date: DAY });
      await create(foreign, foreign.eventsId, { name: "Theirs", date: DAY });

      const answer = await sessionTimeline(home, { from: DAY, to: DAY });

      expect(answer.error).toBe(false);
      const parsed = timelineSchema.parse(JSON.parse(answer.result));
      expect(parsed.items.map((item) => item.id)).toEqual([own]);
      expect(parsed.items).toEqual((await routeTimeline(home, DAY, DAY)).items);
    });

    it("refuses a range over 93 days as a validation error", async () => {
      await expect(sessionTimeline(home, { from: "2026-01-01", to: "2026-04-04" })).rejects.toThrow(
        "Invalid tool arguments.",
      );
    });
  });

  describe("the sleep nights of the timeline (sensitive sleep databases)", () => {
    const RANGE = { from: "2026-10-12", to: "2026-10-18" };
    // The seeded plans cover every night, and the source also reads the night before the range that ends inside it.
    const NIGHTS = 8;

    /** Gives the project of the calendar databases `access` on the sleep databases `databaseIds` of `tenant`. */
    async function grantSleep(
      tenant: Tenant,
      access: "read" | "write" | "none",
      databaseIds = tenant.sleepDatabaseIds,
    ) {
      await runInTenant(tenant.id, () =>
        withTransaction(runtime, async (client) => {
          for (const databaseId of databaseIds) {
            await setAgentDatabaseGrant(client, { projectItemId: tenant.calendarProjectId, databaseId, access });
          }
        }),
      );
    }

    async function runAnswer(tenant: Tenant) {
      const resolved = await timelineTool(tenant);
      const answer = await runInTenant(tenant.id, () => resolved.invoke(RANGE));
      expect(answer.error).toBe(false);
      return { answer, timeline: timelineSchema.parse(JSON.parse(answer.result)) };
    }

    const sleepOf = (timeline: z.infer<typeof timelineSchema>) =>
      timeline.items.filter((item) => item.kind === "sleep");

    it("is shown by the route of the tenant, so the cases below leave out something that exists", async () => {
      expect(sleepOf(await routeTimeline(sleepy, RANGE.from, RANGE.to))).toHaveLength(NIGHTS);
    });

    it("leaves the nights out of a run whose project holds no grant on the sleep databases, and does not mark the answer", async () => {
      const { answer, timeline } = await runAnswer(sleepy);

      expect(sleepOf(timeline)).toEqual([]);
      expect(answer.sensitive).toBeUndefined();
      expect(answer.result).not.toContain("bedTime");
    });

    it("gives a run the same nights as the route once its project may read all three sleep databases, and marks the answer", async () => {
      await grantSleep(sleepy, "read");

      const { answer, timeline } = await runAnswer(sleepy);

      expect(answer.sensitive).toBe(true);
      expect(sleepOf(timeline)).toHaveLength(NIGHTS);
      expect(timeline.items).toEqual((await routeTimeline(sleepy, RANGE.from, RANGE.to)).items);
    });

    it.each([
      ["settings", 0],
      ["plans", 1],
      ["nights", 2],
    ])("leaves the nights out when the %s database is the one without a read grant", async (_name, missing) => {
      await grantSleep(
        sleepy,
        "read",
        sleepy.sleepDatabaseIds.filter((_id, index) => index !== missing),
      );

      const { answer, timeline } = await runAnswer(sleepy);

      expect(sleepOf(timeline)).toEqual([]);
      expect(answer.sensitive).toBeUndefined();
    });

    it("leaves the nights out again after the user revokes the grant", async () => {
      await grantSleep(sleepy, "read");
      expect(sleepOf((await runAnswer(sleepy)).timeline)).toHaveLength(NIGHTS);

      await grantSleep(sleepy, "none");

      const { answer, timeline } = await runAnswer(sleepy);
      expect(sleepOf(timeline)).toEqual([]);
      expect(answer.sensitive).toBeUndefined();
    });

    it("does not mark an answer that holds no sleep night, also for a project that holds the grant", async () => {
      await grantSleep(home, "read");

      const { answer, timeline } = await runAnswer(home);

      expect(sleepOf(timeline)).toEqual([]);
      expect(answer.sensitive).toBeUndefined();
    });

    it("keeps the other items of the route when it leaves the nights out", async () => {
      const own = await create(sleepy, sleepy.eventsId, { name: "Mine", date: DAY });

      const { timeline } = await runAnswer(sleepy);

      const route = await routeTimeline(sleepy, RANGE.from, RANGE.to);
      expect(timeline.items).toEqual(route.items.filter((item) => item.kind !== "sleep"));
      expect(timeline.items.map((item) => item.id)).toContain(own);
    });

    it("never gives a human /mcp session a sleep night, and does not mark its answer", async () => {
      // Even a grant of the calendar project does not reach a session: it is an external AI client with no project.
      await grantSleep(sleepy, "read");
      const found = (
        await runInTenant(sleepy.id, () => resolveModuleAgentToolsForUser(runtime, registry, sleepy.userId, {}))
      ).find((candidate) => candidate.name === TIMELINE);
      if (!found) throw new Error(`Tool ${TIMELINE} is not offered to a session`);

      const answer = await runInTenant(sleepy.id, () => found.invoke(RANGE));

      expect(answer.error).toBe(false);
      expect(answer.sensitive).toBeUndefined();
      const timeline = timelineSchema.parse(JSON.parse(answer.result));
      expect(sleepOf(timeline)).toEqual([]);
      expect(timeline.items).toEqual(
        (await routeTimeline(sleepy, RANGE.from, RANGE.to)).items.filter((item) => item.kind !== "sleep"),
      );
    });

    it("answers a run without a project as the other calendar tools do, and reads nothing", async () => {
      const run = await runInTenant(sleepy.id, () =>
        createAgentRun(runtime, {
          projectItemId: null,
          userId: sleepy.userId,
          triggeredBy: "user",
          task: "no project",
        }),
      );

      // The resolver offers the tool only to a run of a project, so the handler is called directly.
      const answer = await runInTenant(sleepy.id, () => createCalendarTimelineTool(runtime)(run.id, RANGE));

      expect(answer.error).toBe(true);
      expect(answer.sensitive).toBeUndefined();
      expect(JSON.parse(answer.result)).toMatchObject({ status: 403, error: "forbidden" });
      expect(answer.result).not.toContain("bedTime");
    });

    it("answers a run that does not exist with a 404", async () => {
      const answer = await runInTenant(sleepy.id, () => createCalendarTimelineTool(runtime)(randomUUID(), RANGE));

      expect(answer.error).toBe(true);
      expect(JSON.parse(answer.result)).toMatchObject({ status: 404 });
    });
  });
});
