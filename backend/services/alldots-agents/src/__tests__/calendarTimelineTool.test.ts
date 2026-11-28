import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModuleRegistry } from "@alldots/module-registry";
import { runInTenant } from "@alldots/shared";
import {
  createAgentRun,
  createCalendarTimelineRouteHandler,
  createChokePoint,
  createSempChatThread,
  createUser,
  seedSystem,
  withTransaction,
} from "@alldots/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@alldots/data/testSupport";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import * as piSession from "../piAgentSession.js";

/** Offered to a run whose project owns the calendar databases; answers like `GET /api/calendar/timeline`, with no approval. */

const calendarManifestHref = new URL(
  "../../../../packages/data/src/calendar/calendarModuleManifest.js",
  import.meta.url,
).href;
const TOOL = "calendar_timeline";
const DAY = "2026-10-16";

let admin: Pool;
let runtime: Pool;
let registry: ModuleRegistry;
let tenant: string;

interface Session {
  runId: string;
  tools: AgentTool[];
  eventsId: string;
}

/** The range and the items of a timeline given as JSON text; anything else is a failure of the test. */
function timelineOf(text: string): { from: unknown; to: unknown; items: unknown[] } {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("The timeline is no object");
  const items: unknown = Reflect.get(parsed, "items");
  if (!Array.isArray(items)) throw new Error("The timeline has no items");
  return { from: Reflect.get(parsed, "from"), to: Reflect.get(parsed, "to"), items };
}

/** The id of an item of a timeline, `undefined` when the value is no object. */
function idOf(item: unknown): unknown {
  return typeof item === "object" && item !== null ? Reflect.get(item, "id") : undefined;
}

/** The kind of an item of a timeline, `undefined` when the value is no object. */
function kindOf(item: unknown): unknown {
  return typeof item === "object" && item !== null ? Reflect.get(item, "kind") : undefined;
}

/** A tenant with its system databases and a user; the run is in the project that owns the calendar databases or in another. */
async function openSession(options: { inOtherProject?: boolean } = {}): Promise<Session> {
  return runInTenant(tenant, async () => {
    await seedSystem(runtime);
    const chokePoint = createChokePoint(runtime);
    const databases = await chokePoint.listDatabases();
    const database = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const calendarProject = database("calendars").ownerProjectItemId;
    if (!calendarProject) throw new Error("The calendars database has no owner project");
    const project = options.inOtherProject
      ? (await chokePoint.createItem({ databaseId: database("projects").id, properties: { name: "Other project" } })).id
      : calendarProject;
    const user = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
    });
    const threadId = await withTransaction(runtime, (client) => createSempChatThread(client));
    const run = await createAgentRun(runtime, {
      projectItemId: project,
      userId: user.id,
      threadId,
      triggeredBy: "user",
      task: "calendar",
    });
    let tools: AgentTool[] = [];
    const spy = vi.spyOn(piSession, "createPiAgentSessionFactory").mockImplementation((factoryOptions) => {
      tools = factoryOptions.tools;
      return () => ({ async *messages() {} });
    });
    try {
      const faux = fauxProvider();
      await createAgentSessionFactoryForRun(
        runtime,
        registry,
        {
          model: faux.getModel(),
          streamFn: (model, context, streamOptions) => faux.provider.streamSimple(model, context, streamOptions),
          isBudgetRefusal: () => false,
        },
        run,
      );
    } finally {
      spy.mockRestore();
    }
    return { runId: run.id, tools, eventsId: database("events").id };
  });
}

function callTimeline(session: Session, toolCallId: string, args: Record<string, unknown>) {
  const tool = session.tools.find((candidate) => candidate.name === TOOL);
  if (!tool) throw new Error(`Tool ${TOOL} is not in the session`);
  return runInTenant(tenant, () => tool.execute(toolCallId, args));
}

async function approvalRequestCount(session: Session): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM approval_requests WHERE agent_run_id = $1",
    [session.runId],
  );
  return rows[0]?.n ?? Number.NaN;
}

describe("calendar.timeline in an agent session (issue gh-1952)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    registry = new ModuleRegistry(() => new Set(["calendar"]));
    await registry.loadModule(calendarManifestHref);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the tool to a run whose project owns the calendar databases", async () => {
    const session = await openSession();
    expect(session.tools.map((tool) => tool.name)).toContain(TOOL);
  });

  it("offers it to no run of another project, so a call cannot be named", async () => {
    const session = await openSession({ inOtherProject: true });
    expect(session.tools.map((tool) => tool.name)).not.toContain(TOOL);
  });

  it("answers the items the route returns for the range, with no approval request", async () => {
    const session = await openSession();
    const created = await runInTenant(tenant, () =>
      createChokePoint(runtime).createItem({
        databaseId: session.eventsId,
        properties: { name: "Standup", date: DAY, timeFrom: "09:00" },
      }),
    );

    const result = await callTimeline(session, "call-1", { from: DAY, to: DAY });

    expect(result.details).toEqual({ error: false });
    const text = result.content[0];
    if (text?.type !== "text") throw new Error("The tool answered no text");
    const timeline = timelineOf(text.text);
    expect([timeline.from, timeline.to]).toEqual([DAY, DAY]);
    expect(timeline.items.map(idOf)).toContain(created.id);
    const { body } = await runInTenant(tenant, () =>
      createCalendarTimelineRouteHandler(runtime)({ req: { url: `/api/calendar/timeline?from=${DAY}&to=${DAY}` } }),
    );
    // Without a grant on the sensitive sleep databases, the tool leaves out the nights the route returns.
    const routeItems = timelineOf(JSON.stringify(body)).items;
    expect(routeItems.some((item) => kindOf(item) === "sleep")).toBe(true);
    expect(timeline.items).toEqual(routeItems.filter((item) => kindOf(item) !== "sleep"));
    expect(await approvalRequestCount(session)).toBe(0);
  });

  it.each([
    ["a range longer than 93 days", { from: "2026-01-01", to: "2026-04-04" }],
    ["a malformed date", { from: "2026-02-30", to: "2026-03-01" }],
  ])("answers %s as invalid arguments", async (_name, args) => {
    const session = await openSession();

    const result = await callTimeline(session, "call-1", args);

    expect(result.details).toEqual({ error: true });
    expect(result.content).toEqual([{ type: "text", text: "Invalid tool arguments." }]);
    expect(await approvalRequestCount(session)).toBe(0);
  });
});
