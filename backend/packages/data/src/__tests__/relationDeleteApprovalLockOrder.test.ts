import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import {
  computeDestructiveResourceProjection,
  type DestructiveOperationCheck,
} from "../chokePoint/destructiveProjection.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import {
  createRelationWithClient,
  deleteRelationWithClient,
  setRelationWithClient,
} from "../chokePoint/relationOps.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ApprovalResourceBusyError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { handleLinkPropagation } from "../valueLinks/linkPropagation.js";

// The replay of an approved agent relation operation races a link rule's propagation job while a third
// transaction holds the transcript row. The `relation.delete` check locks the edge's endpoint rows NOWAIT
// before reserving value links, so the replay is refused as busy instead of holding the `project` link while
// it waits. Each participant has its own `application_name` so `pg_blocking_pids` tells them apart.

const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: "00000000-0000-4000-8000-000000000003" };
const USER: WriterIdentity = { writerKind: "user" };
const RECORDING_START = "2024-03-01T12:00:00.000Z";
const PROJECT_RULE = "transcriptProjectFromEvent";

interface Participant {
  name: string;
  pool: Pool;
  cp: ChokePoint;
}

let admin: Pool;
let fixture: Participant;
let holder: Participant;
let propagation: Participant;
let replay: Participant;

async function participant(name: string): Promise<Participant> {
  const pool = await createRuntimeRolePool(admin, "alldots_data");
  // Set before the pool opens its first connection, so every backend of this participant carries the name.
  pool.options.application_name = name;
  return { name, pool, cp: createChokePoint(pool) };
}

interface World {
  tenant: string;
  eventProject: string;
  transcriptsDatabase: string;
  transcriptProject: string;
  web: string;
  bathroom: string;
  bare: string;
  event: string;
  transcript: string;
}

function inTenant<T>(world: Pick<World, "tenant">, fn: () => Promise<T>): Promise<T> {
  return runInTenant(world.tenant, fn);
}

/** Built through the choke point: the link rules copy the Event's project into the transcript with an `on` value link. */
async function buildWorld(): Promise<World> {
  const tenant = await createTestTenant(admin);
  const scope = { tenant };
  const { databases, property } = await runInTenant(tenant, async () => {
    await seedSystem(fixture.pool, createViewTypeRegistry());
    const listed = await fixture.cp.listDatabases();
    const db = (moduleId: string): string => {
      const found = listed.find((database) => database.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing database ${moduleId}`);
      return found.id;
    };
    const ids = {
      companies: db("companies"),
      events: db("events"),
      projects: db("projects"),
      transcripts: db("transcripts"),
    };
    const propertyOf = async (databaseId: string, key: string): Promise<string> => {
      const found = (await fixture.cp.listProperties(databaseId)).find((entry) => entry.key === key);
      if (!found) throw new Error(`Missing property ${key}`);
      return found.id;
    };
    return {
      databases: ids,
      property: {
        eventProject: await propertyOf(ids.events, "project"),
        projectCompany: await propertyOf(ids.projects, "company"),
        transcriptEvent: await propertyOf(ids.transcripts, "event"),
        transcriptProject: await propertyOf(ids.transcripts, "project"),
      },
    };
  });
  const item = async (databaseId: string, properties: Record<string, unknown>): Promise<string> =>
    (await inTenant(scope, () => fixture.cp.createItem({ databaseId, properties }))).id;
  const link = (relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<unknown> =>
    inTenant(scope, () => fixture.cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, USER));

  const novak = await item(databases.companies, { name: "Novak Web s.r.o." });
  const siko = await item(databases.companies, { name: "Siko Koupelny a.s." });
  const web = await item(databases.projects, { name: "Web for client" });
  const bathroom = await item(databases.projects, { name: "Bathroom renovation" });
  const bare = await item(databases.projects, { name: "Internal notes" });
  await link(property.projectCompany, web, novak);
  await link(property.projectCompany, bathroom, siko);
  const event = await item(databases.events, { name: "client meeting", type: "meeting", date: RECORDING_START });
  await link(property.eventProject, event, web);
  const transcript = (
    await inTenant(scope, () =>
      withTransaction(fixture.pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: databases.transcripts, properties: { name: "Recording 1", date: RECORDING_START } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      ),
    )
  ).id;
  await link(property.transcriptEvent, transcript, event);
  return {
    tenant,
    eventProject: property.eventProject,
    transcriptsDatabase: databases.transcripts,
    transcriptProject: property.transcriptProject,
    web,
    bathroom,
    bare,
    event,
    transcript,
  };
}

async function changeEventProject(world: World): Promise<void> {
  await inTenant(world, async () => {
    const edge = { relationPropertyId: world.eventProject, callerItemId: world.event };
    await fixture.cp.deleteRelation({ ...edge, targetItemId: world.web }, USER);
    await fixture.cp.createRelation({ ...edge, targetItemId: world.bathroom }, USER);
  });
}

interface LinkState {
  state: string;
  brokenBy: string | null;
}

interface TranscriptState {
  project: string[];
  links: Record<string, LinkState>;
}

async function transcriptState(world: World): Promise<TranscriptState> {
  return inTenant(world, async () => {
    const edges = (await fixture.cp.listItemRelations(world.transcript, world.transcriptProject)) ?? [];
    const { rows } = await fixture.pool.query<{ property_key: string; state: string; broken_by: string | null }>(
      "SELECT property_key, state, broken_by FROM value_links WHERE item_id = $1 ORDER BY property_key",
      [world.transcript],
    );
    return {
      project: edges.map((edge) => edge.targetItemId).sort(),
      links: Object.fromEntries(rows.map((row) => [row.property_key, { state: row.state, brokenBy: row.broken_by }])),
    };
  });
}

/** How a production call ended: committed, PostgreSQL's deadlock error, or the busy refusal of the approval check. */
type Outcome = "committed" | "deadlock" | "approvalBusy";

async function outcomeOf(operation: Promise<unknown>): Promise<Outcome> {
  try {
    await operation;
    return "committed";
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "40P01") return "deadlock";
    if (error instanceof ApprovalResourceBusyError) return "approvalBusy";
    throw error;
  }
}

interface Step {
  participant: Participant;
  call: (participant: Participant) => Promise<unknown>;
}

interface Running {
  participant: Participant;
  outcome: Promise<Outcome>;
  settled: () => boolean;
}

function start(world: World, step: Step): Running {
  let done = false;
  const outcome = outcomeOf(inTenant(world, () => step.call(step.participant))).finally(() => {
    done = true;
  });
  return { participant: step.participant, outcome, settled: () => done };
}

/** Returns the blocking participants by `application_name`, or `null` when the call ended without waiting. */
async function blockersOrEnd(running: Running): Promise<string[] | null> {
  let blockers: string[] | null = null;
  await vi.waitFor(
    async () => {
      if (running.settled()) {
        blockers = null;
        return;
      }
      const { rows } = await admin.query<{ blocker: string }>(
        `SELECT DISTINCT blocker.application_name AS blocker
         FROM pg_stat_activity waiter
         JOIN pg_stat_activity blocker ON blocker.pid = ANY(pg_blocking_pids(waiter.pid))
         WHERE waiter.datname = current_database() AND waiter.application_name = $1
         ORDER BY blocker`,
        [running.participant.name],
      );
      expect(rows.length).toBeGreaterThan(0);
      blockers = rows.map((row) => row.blocker);
    },
    { timeout: 10_000, interval: 25 },
  );
  return blockers;
}

function holdTranscript(world: World) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal!: () => void;
  const locked = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const done = inTenant(world, () =>
    withTransaction(holder.pool, async (client: PoolClient) => {
      if (!(await lockItemById(client, world.transcriptsDatabase, world.transcript)))
        throw new Error("The row to hold does not exist");
      signal();
      await gate;
    }),
  );
  const ready = Promise.race([
    locked,
    done.then(() => {
      throw new Error("The holding transaction ended before it locked the row");
    }),
  ]);
  return { ready, release, done };
}

interface ScheduleResult {
  blockedBy: Array<string[] | null>;
  outcomes: Outcome[];
}

/** Starts each step only after the previous one waits or ended, while the transcript row is held; then releases it. */
async function behindHeldTranscript(world: World, steps: Step[]): Promise<ScheduleResult> {
  const hold = holdTranscript(world);
  const running: Running[] = [];
  const blockedBy: Array<string[] | null> = [];
  try {
    await hold.ready;
    for (const step of steps) {
      const call = start(world, step);
      running.push(call);
      blockedBy.push(await blockersOrEnd(call));
    }
  } finally {
    hold.release();
    await Promise.allSettled([hold.done, ...running.map((call) => call.outcome)]);
  }
  await hold.done;
  return { blockedBy, outcomes: await Promise.all(running.map((call) => call.outcome)) };
}

function propagateEventProject(world: World): Step {
  return {
    participant: propagation,
    call: ({ pool }) => handleLinkPropagation(pool, { ruleKey: PROJECT_RULE, sourceItemId: world.event, hop: 1 }),
  };
}

/** The destructive projection check, then the write, in one transaction as `replayApprovedGenericOperation` runs them. */
function replayOf(
  world: World,
  operation: "relation.delete" | "relation.put" | "relation.set",
  targetItemId: string,
): Step {
  const input = { relationPropertyId: world.transcriptProject, callerItemId: world.transcript, targetItemId };
  const check: DestructiveOperationCheck = { operation, input };
  return {
    participant: replay,
    call: ({ pool }) =>
      withTransaction(pool, async (client) => {
        await computeDestructiveResourceProjection(client, check);
        if (operation === "relation.delete") await deleteRelationWithClient(client, input, undefined, AGENT);
        else if (operation === "relation.put") await createRelationWithClient(client, input, undefined, AGENT);
        else await setRelationWithClient(client, input, AGENT);
      }),
  };
}

const ON: LinkState = { state: "on", brokenBy: null };
/** The transcript's three value links, all on: the Event feeds `project` and `people`, the project feeds `company`. */
const LINKS_ON = { company: ON, people: ON, project: ON };

describe("the replay of an approved relation operation against the propagation of a link rule", () => {
  beforeAll(async () => {
    admin = getTestPool();
    fixture = await participant("approvalLockOrder:fixture");
    holder = await participant("approvalLockOrder:holder");
    propagation = await participant("approvalLockOrder:propagation");
    replay = await participant("approvalLockOrder:replay");
    for (const { pool } of [fixture, holder, propagation, replay]) {
      const role = await runAsSystem("test:role", () =>
        pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }
  });

  beforeEach(async () => {
    await resetDatabase(admin);
  });

  afterAll(async () => {
    for (const entry of [fixture, holder, propagation, replay]) await entry?.pool.end();
    await admin?.end();
  });

  describe("the propagation of the Event's project waits for the transcript row first", () => {
    it("refuses the replay of a relation.delete as busy and commits the propagation, with no deadlock", async () => {
      const world = await buildWorld();
      await changeEventProject(world);

      const result = await behindHeldTranscript(world, [
        propagateEventProject(world),
        replayOf(world, "relation.delete", world.web),
      ]);

      // The replay's check meets the held row at once and does not wait, so it holds no link row the propagation needs.
      expect(result).toEqual({ blockedBy: [[holder.name], null], outcomes: ["committed", "approvalBusy"] });
      // Nothing the replay wrote is stored: the propagation replaced the project and the link is still on.
      expect(await transcriptState(world)).toEqual({ project: [world.bathroom], links: LINKS_ON });
    });

    it("refuses the replay of a relation.put as busy and commits the propagation, as before", async () => {
      const world = await buildWorld();
      await changeEventProject(world);

      const result = await behindHeldTranscript(world, [
        propagateEventProject(world),
        replayOf(world, "relation.put", world.bare),
      ]);

      expect(result).toEqual({ blockedBy: [[holder.name], null], outcomes: ["committed", "approvalBusy"] });
      expect(await transcriptState(world)).toEqual({ project: [world.bathroom], links: LINKS_ON });
    });

    it("refuses the replay of a relation.set as busy and commits the propagation, as before", async () => {
      const world = await buildWorld();
      await changeEventProject(world);

      const result = await behindHeldTranscript(world, [
        propagateEventProject(world),
        replayOf(world, "relation.set", world.bare),
      ]);

      expect(result).toEqual({ blockedBy: [[holder.name], null], outcomes: ["committed", "approvalBusy"] });
      expect(await transcriptState(world)).toEqual({ project: [world.bathroom], links: LINKS_ON });
    });
  });

  it("commits the replay of a relation.delete and ends the edge and its link when nothing is held", async () => {
    const world = await buildWorld();
    expect(await transcriptState(world)).toEqual({ project: [world.web], links: LINKS_ON });

    const running = start(world, replayOf(world, "relation.delete", world.web));

    expect(await running.outcome).toBe("committed");
    expect(await transcriptState(world)).toEqual({
      project: [],
      // The link engine released the company the project had given the transcript when the project edge ended.
      links: { people: ON, project: { state: "broken", brokenBy: "agent" } },
    });
  });
});
