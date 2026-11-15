import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { lockValueLink } from "../chokePoint/valueLinksStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";

// The lock order of the trash of an Event against the removal of a transcript's `event` edge. The trash detaches the
// value links the Event feeds (`valueLinkSourceDeleteHook`) in the order of their item id, the position of their rule
// in the catalog and their link id; the release of a removed `event` edge takes the transcript's `project` link and then
// its `people` link. See
// docs/adr/2026-11-15-the-trash-of-an-event-locks-the-value-links-it-feeds-in-item-order-then-rule-order.md.
// Every call is a production call on a pool of the runtime role `semprec_data`, one pool per participant.

const USER: WriterIdentity = { writerKind: "user" };
const RECORDING_START = "2024-03-01T12:00:00.000Z";

interface Participant {
  name: string;
  pool: Pool;
  cp: ChokePoint;
}

let admin: Pool;
let fixture: Participant;
let holder: Participant;
let edgeWriter: Participant;
let trasher: Participant;

async function participant(name: string): Promise<Participant> {
  const pool = await createRuntimeRolePool(admin, "semprec_data");
  // Set before the pool opens its first connection, so every backend of this participant carries the name.
  pool.options.application_name = name;
  return { name, pool, cp: createChokePoint(pool) };
}

/** One tenant with the Event "client meeting", its project and participant, and a transcript linked to that Event. */
interface World {
  tenant: string;
  eventsDatabase: string;
  transcriptEventProperty: string;
  transcriptProjectProperty: string;
  transcriptCompanyProperty: string;
  project: string;
  company: string;
  event: string;
  transcript: string;
}

async function buildWorld(): Promise<World> {
  const tenant = await createTestTenant(admin);
  return runInTenant(tenant, async () => {
    await seedSystem(fixture.pool, createViewTypeRegistry());
    const databases = await fixture.cp.listDatabases();
    const database = (moduleId: string): string => {
      const found = databases.find((entry) => entry.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing database ${moduleId}`);
      return found.id;
    };
    const property = async (databaseId: string, key: string): Promise<string> => {
      const found = (await fixture.cp.listProperties(databaseId)).find((entry) => entry.key === key);
      if (!found) throw new Error(`Missing property ${key}`);
      return found.id;
    };
    const [companies, events, people, projects, transcripts] = [
      database("companies"),
      database("events"),
      database("people"),
      database("projects"),
      database("transcripts"),
    ];
    const item = async (databaseId: string, properties: Record<string, unknown>): Promise<string> =>
      (await fixture.cp.createItem({ databaseId, properties })).id;
    const link = (relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<unknown> =>
      fixture.cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, USER);

    const alice = await item(people, { name: "Alice Novak" });
    const company = await item(companies, { name: "Novak Web s.r.o." });
    const project = await item(projects, { name: "Web for client" });
    await link(await property(projects, "company"), project, company);
    const event = await item(events, { name: "client meeting", type: "meeting", date: RECORDING_START });
    await link(await property(events, "project"), event, project);
    await link(await property(events, "people"), event, alice);
    const transcriptEventProperty = await property(transcripts, "event");
    // The transcript is linked to the Event last, so the link rules give it an `on` link for each of its project,
    // people and company.
    const transcript = (
      await withTransaction(fixture.pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: transcripts, properties: { name: "Recording 1", date: RECORDING_START } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      )
    ).id;
    await link(transcriptEventProperty, transcript, event);
    return {
      tenant,
      eventsDatabase: events,
      transcriptEventProperty,
      transcriptProjectProperty: await property(transcripts, "project"),
      transcriptCompanyProperty: await property(transcripts, "company"),
      project,
      company,
      event,
      transcript,
    };
  });
}

/**
 * Gives the transcript's value links the ids `[project, people, company]`. Raw SQL for a state the store cannot
 * produce, since it generates the link ids: the ids are rewritten on the admin pool, with foreign keys off, in
 * `value_links` and in `value_link_sources` together (the foreign key has no ON UPDATE CASCADE).
 */
async function rewriteLinkIds(world: World, ids: { project: string; people: string; company: string }): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const propertyKey of ["project", "people", "company"] as const) {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM value_links WHERE item_id = $1 AND property_key = $2",
        [world.transcript, propertyKey],
      );
      const oldId = rows[0]?.id;
      if (!oldId) throw new Error(`The transcript has no ${propertyKey} link`);
      await client.query("UPDATE value_links SET id = $2 WHERE id = $1", [oldId, ids[propertyKey]]);
      await client.query("UPDATE value_link_sources SET link_id = $2 WHERE link_id = $1", [oldId, ids[propertyKey]]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const SMALL_ID = "00000000-0000-4000-8000-000000000001";
const MIDDLE_ID = "00000000-0000-4000-8000-000000000002";
const LARGE_ID = "00000000-0000-4000-8000-000000000003";

type Outcome = "committed" | "deadlock";

async function outcomeOf(operation: Promise<unknown>): Promise<Outcome> {
  try {
    await operation;
    return "committed";
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "40P01") return "deadlock";
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
  const outcome = outcomeOf(runInTenant(world.tenant, () => step.call(step.participant))).finally(() => {
    done = true;
  });
  return { participant: step.participant, outcome, settled: () => done };
}

/**
 * Waits until the call has either ended or one of its participant's backends waits for a lock. Returns the
 * participants whose backends block it, by `application_name`, or `null` when the call ended without waiting.
 */
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

/**
 * Starts the steps one after the other while a third transaction holds the transcript's `project` link row, each
 * only after the one before it waits for a lock or has ended, then releases the row and lets every call end.
 */
async function behindHeldProjectLink(
  world: World,
  steps: Step[],
): Promise<{ blockedBy: Array<string[] | null>; outcomes: Outcome[] }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal!: () => void;
  const locked = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const held = runInTenant(world.tenant, () =>
    withTransaction(holder.pool, async (client: PoolClient) => {
      if (!(await lockValueLink(client, world.transcript, "project"))) throw new Error("The project link is missing");
      signal();
      await gate;
    }),
  );
  const running: Running[] = [];
  const blockedBy: Array<string[] | null> = [];
  try {
    await Promise.race([
      locked,
      held.then(() => {
        throw new Error("The holding transaction ended before it locked the link");
      }),
    ]);
    for (const step of steps) {
      const call = start(world, step);
      running.push(call);
      blockedBy.push(await blockersOrEnd(call));
    }
  } finally {
    release();
    await Promise.allSettled([held, ...running.map((call) => call.outcome)]);
  }
  await held;
  return { blockedBy, outcomes: await Promise.all(running.map((call) => call.outcome)) };
}

const removesEventEdge = (world: World): Step => ({
  participant: edgeWriter,
  call: ({ cp }) =>
    cp.deleteRelation(
      { relationPropertyId: world.transcriptEventProperty, callerItemId: world.transcript, targetItemId: world.event },
      USER,
    ),
});

const trashesEvent = (world: World): Step => ({
  participant: trasher,
  call: ({ cp }) => cp.softDeleteItem(world.eventsDatabase, world.event, undefined, USER),
});

/** The transcript's edges and value link rows and the Event's trash state, read through the runtime role. */
async function settledState(world: World) {
  return runInTenant(world.tenant, async () => {
    const targets = async (relationPropertyId: string): Promise<string[]> =>
      ((await fixture.cp.listItemRelations(world.transcript, relationPropertyId)) ?? []).map(
        (edge) => edge.targetItemId,
      );
    const links = await fixture.pool.query<{ property_key: string }>(
      "SELECT property_key FROM value_links WHERE item_id = $1 ORDER BY property_key",
      [world.transcript],
    );
    const event = await fixture.pool.query<{ trashed: boolean }>(
      "SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1",
      [world.event],
    );
    return {
      eventEdge: await targets(world.transcriptEventProperty),
      projectEdge: await targets(world.transcriptProjectProperty),
      companyEdge: await targets(world.transcriptCompanyProperty),
      linkKeys: links.rows.map((row) => row.property_key),
      eventTrashed: event.rows[0]?.trashed,
    };
  });
}

describe("the trash of an Event against the removal of a transcript's event edge", () => {
  beforeAll(async () => {
    admin = getTestPool();
    fixture = await participant("eventTrashLockOrder:fixture");
    holder = await participant("eventTrashLockOrder:holder");
    edgeWriter = await participant("eventTrashLockOrder:edgeRemoval");
    trasher = await participant("eventTrashLockOrder:eventTrash");
    for (const { pool } of [fixture, holder, edgeWriter, trasher]) {
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }
  });

  beforeEach(async () => {
    await resetDatabase(admin);
  });

  afterAll(async () => {
    for (const entry of [fixture, holder, edgeWriter, trasher]) await entry?.pool.end();
    await admin?.end();
  });

  // With a third transaction holding the transcript's `project` link row, whichever call started first waits for it.
  // The edge removal takes `project` and then `people`. The trash used to take them in the order of their link ids,
  // so it took `people` first when that link had the smaller id.
  const idOrders = [
    {
      name: "project link has the smaller id",
      ids: { project: SMALL_ID, people: MIDDLE_ID, company: LARGE_ID },
    },
    {
      name: "people link has the smaller id",
      ids: { project: MIDDLE_ID, people: SMALL_ID, company: LARGE_ID },
    },
  ];
  const startOrders = [
    { name: "the edge removal starts first", order: (world: World) => [removesEventEdge(world), trashesEvent(world)] },
    { name: "the trash starts first", order: (world: World) => [trashesEvent(world), removesEventEdge(world)] },
  ];

  for (const { name: startName, order } of startOrders) {
    for (const { name: idName, ids } of idOrders) {
      it(`commits both when ${startName} and the ${idName}`, async () => {
        const world = await buildWorld();
        await rewriteLinkIds(world, ids);

        const result = await behindHeldProjectLink(world, order(world));

        expect(result.outcomes).toEqual(["committed", "committed"]);
        // The first call waits for the held link; the second waits for a lock too, so the two were interleaved.
        expect(result.blockedBy[0]).toEqual([holder.name]);
        expect(result.blockedBy[1]).not.toBeNull();
        expect(await settledState(world)).toEqual({
          eventEdge: [],
          projectEdge: [world.project],
          companyEdge: [world.company],
          linkKeys: [],
          eventTrashed: true,
        });
      });
    }
  }
});
