import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { CORE_TASK_NAMES } from "@alldots/queue";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import {
  clearHooksForTests,
  registerRelationEdgeBeforeLinkBreakHook,
  registerRelationEdgeChangedHook,
  type RelationEdgeChangedHookContext,
} from "../chokePoint/hooks.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { lockValueLink } from "../chokePoint/valueLinksStore.js";
import {
  createRelationIfAbsentWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
} from "../chokePoint/relationOps.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ApprovalRequiredForWrite, ValueLinkBusyError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { handleLinkPropagation } from "../valueLinks/linkPropagation.js";
import { linkRuleEdgeLockHook } from "../valueLinks/linkRuleEdgeHook.js";

// The lock order of a relation edge write on a link rule's via relation: it locks the rule's target item row right
// after the edge row and before any value link row (`linkRuleEdgeLockHook`, before-link-break registry of
// `chokePoint/hooks.ts`), as the propagation job and the engine's edge hook do. Every schedule runs production calls
// on `alldots_data` pools.

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: "00000000-0000-4000-8000-000000000003" };
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
let edgeWriter: Participant;
let setter: Participant;
let trasher: Participant;

async function participant(name: string): Promise<Participant> {
  const pool = await createRuntimeRolePool(admin, "alldots_data");
  // Set before the pool's first connection, so every backend of this participant carries the name.
  pool.options.application_name = name;
  return { name, pool, cp: createChokePoint(pool) };
}

type DatabaseKey = "companies" | "events" | "files" | "people" | "projects" | "transcripts";

interface Schema {
  db: Record<DatabaseKey, string>;
  eventProject: string;
  eventPeople: string;
  projectCompany: string;
  transcriptEvent: string;
  transcriptProject: string;
  transcriptCompany: string;
  transcriptPeople: string;
}

type EventProject = "web" | "bare" | "none";

interface World {
  tenant: string;
  schema: Schema;
  alice: string;
  novak: string;
  siko: string;
  web: string;
  bathroom: string;
  bare: string;
  event: string;
  transcript: string;
}

function inTenant<T>(world: Pick<World, "tenant">, fn: () => Promise<T>): Promise<T> {
  return runInTenant(world.tenant, fn);
}

async function seedTenant(): Promise<{ tenant: string; schema: Schema }> {
  const tenant = await createTestTenant(admin);
  return runInTenant(tenant, async () => {
    await seedSystem(fixture.pool, createViewTypeRegistry());
    const databases = await fixture.cp.listDatabases();
    const db = (moduleId: DatabaseKey): string => {
      const found = databases.find((database) => database.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing database ${moduleId}`);
      return found.id;
    };
    const property = async (databaseId: string, key: string): Promise<string> => {
      const found = (await fixture.cp.listProperties(databaseId)).find((entry) => entry.key === key);
      if (!found) throw new Error(`Missing property ${key}`);
      return found.id;
    };
    const ids: Record<DatabaseKey, string> = {
      companies: db("companies"),
      events: db("events"),
      files: db("files"),
      people: db("people"),
      projects: db("projects"),
      transcripts: db("transcripts"),
    };
    const schema: Schema = {
      db: ids,
      eventProject: await property(ids.events, "project"),
      eventPeople: await property(ids.events, "people"),
      projectCompany: await property(ids.projects, "company"),
      transcriptEvent: await property(ids.transcripts, "event"),
      transcriptProject: await property(ids.transcripts, "project"),
      transcriptCompany: await property(ids.transcripts, "company"),
      transcriptPeople: await property(ids.transcripts, "people"),
    };
    return { tenant, schema };
  });
}

/** The transcript is linked to the Event last, so the link rules copy project, company and participant into it. */
async function buildWorld(eventProject: EventProject): Promise<World> {
  const { tenant, schema } = await seedTenant();
  const scope = { tenant };
  const item = async (databaseId: string, properties: Record<string, unknown>): Promise<string> =>
    (await inTenant(scope, () => fixture.cp.createItem({ databaseId, properties }))).id;
  const link = (relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<unknown> =>
    inTenant(scope, () => fixture.cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, USER));

  const alice = await item(schema.db.people, { name: "Alice Novak" });
  const novak = await item(schema.db.companies, { name: "Novak Web s.r.o." });
  const siko = await item(schema.db.companies, { name: "Siko Koupelny a.s." });
  const web = await item(schema.db.projects, { name: "Web for client" });
  const bathroom = await item(schema.db.projects, { name: "Bathroom renovation" });
  const bare = await item(schema.db.projects, { name: "Internal notes" });
  await link(schema.projectCompany, web, novak);
  await link(schema.projectCompany, bathroom, siko);
  const event = await item(schema.db.events, { name: "client meeting", type: "meeting", date: RECORDING_START });
  if (eventProject !== "none") await link(schema.eventProject, event, eventProject === "web" ? web : bare);
  await link(schema.eventPeople, event, alice);
  const transcript = (
    await inTenant(scope, () =>
      withTransaction(fixture.pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: schema.db.transcripts, properties: { name: "Recording 1", date: RECORDING_START } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      ),
    )
  ).id;
  await link(schema.transcriptEvent, transcript, event);
  return { tenant, schema, alice, novak, siko, web, bathroom, bare, event, transcript };
}

interface LinkState {
  state: string;
  brokenBy: string | null;
}

interface TranscriptState {
  project: string[];
  company: string[];
  links: Record<string, LinkState>;
}

async function transcriptState(world: World): Promise<TranscriptState> {
  return inTenant(world, async () => {
    const related = async (relationPropertyId: string): Promise<string[]> =>
      ((await fixture.cp.listItemRelations(world.transcript, relationPropertyId)) ?? [])
        .map((edge) => edge.targetItemId)
        .sort();
    const { rows } = await fixture.pool.query<{ property_key: string; state: string; broken_by: string | null }>(
      "SELECT property_key, state, broken_by FROM value_links WHERE item_id = $1 ORDER BY property_key",
      [world.transcript],
    );
    return {
      project: await related(world.schema.transcriptProject),
      company: await related(world.schema.transcriptCompany),
      links: Object.fromEntries(rows.map((row) => [row.property_key, { state: row.state, brokenBy: row.broken_by }])),
    };
  });
}

const ON: LinkState = { state: "on", brokenBy: null };
const BROKEN_BY_USER: LinkState = { state: "broken", brokenBy: "user" };

/** Committed, PostgreSQL's deadlock error, or the relation admission's busy refusal. */
type Outcome = "committed" | "deadlock" | "busy";

async function outcomeOf(operation: Promise<unknown>): Promise<Outcome> {
  try {
    await operation;
    return "committed";
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "40P01") return "deadlock";
    if (error instanceof ValueLinkBusyError) return "busy";
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

/** Holds one row locked by the owning store's row-locking read until `release`; `ready` once locked. */
function holdRow(world: World, lock: (client: PoolClient) => Promise<unknown>) {
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
      if (!(await lock(client))) throw new Error("The row to hold does not exist");
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

/** Starts each step after the previous one waits or ended, runs `whileWaiting`, then releases the held row. */
async function behindHeldRow(
  world: World,
  lock: (client: PoolClient) => Promise<unknown>,
  steps: Step[],
  whileWaiting?: () => Promise<void>,
): Promise<ScheduleResult> {
  const hold = holdRow(world, lock);
  const running: Running[] = [];
  const blockedBy: Array<string[] | null> = [];
  try {
    await hold.ready;
    for (const step of steps) {
      const call = start(world, step);
      running.push(call);
      blockedBy.push(await blockersOrEnd(call));
    }
    await whileWaiting?.();
  } finally {
    hold.release();
    await Promise.allSettled([hold.done, ...running.map((call) => call.outcome)]);
  }
  await hold.done;
  return { blockedBy, outcomes: await Promise.all(running.map((call) => call.outcome)) };
}

async function changeEventProject(world: World, from: string, to: string): Promise<void> {
  await inTenant(world, async () => {
    const edge = { relationPropertyId: world.schema.eventProject, callerItemId: world.event };
    await fixture.cp.deleteRelation({ ...edge, targetItemId: from }, USER);
    await fixture.cp.createRelation({ ...edge, targetItemId: to }, USER);
  });
  const { rows } = await admin.query<{ key: string | null }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1",
    [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
  );
  expect(rows.map((row) => row.key)).toContain(`valueLinksPropagate:${world.tenant}:${PROJECT_RULE}:${world.event}:1`);
}

function propagateEventProject(world: World): Step {
  return {
    participant: propagation,
    call: ({ pool }) => handleLinkPropagation(pool, { ruleKey: PROJECT_RULE, sourceItemId: world.event, hop: 1 }),
  };
}

function userDeletes(world: World, relationPropertyId: string, targetItemId: string): Step {
  return {
    participant: edgeWriter,
    call: ({ cp }) => cp.deleteRelation({ relationPropertyId, callerItemId: world.transcript, targetItemId }, USER),
  };
}

function userCreates(world: World, relationPropertyId: string, targetItemId: string): Step {
  return {
    participant: edgeWriter,
    call: ({ cp }) => cp.createRelation({ relationPropertyId, callerItemId: world.transcript, targetItemId }, USER),
  };
}

function userSets(world: World, relationPropertyId: string, targetItemId: string): Step {
  return {
    participant: setter,
    call: ({ cp }) => cp.setRelation({ relationPropertyId, callerItemId: world.transcript, targetItemId }, USER),
  };
}

function transcriptRow(world: World): (client: PoolClient) => Promise<unknown> {
  return (client) => lockItemById(client, world.schema.db.transcripts, world.transcript);
}

async function expectTranscript(world: World, expected: TranscriptState): Promise<void> {
  expect(await transcriptState(world)).toEqual(expected);
}

interface EdgeHookCall {
  registry: "beforeLinkBreak" | "changed";
  op: RelationEdgeChangedHookContext["op"];
  relationDefinitionId: string;
  propertyId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
  writer: WriterIdentity;
  linkStates: Record<string, string>;
}

let hookCalls: EdgeHookCall[] = [];

function recorder(registry: EdgeHookCall["registry"]): (context: RelationEdgeChangedHookContext) => Promise<void> {
  return async ({ client, op, relationDefinitionId, propertyId, itemA, itemB, metadata, writer }) => {
    const { rows } = await client.query<{ item_id: string; property_key: string; state: string }>(
      "SELECT item_id, property_key, state FROM value_links WHERE item_id = ANY($1::uuid[]) ORDER BY property_key",
      [[itemA, itemB]],
    );
    hookCalls.push({
      registry,
      op,
      relationDefinitionId,
      propertyId,
      itemA,
      itemB,
      metadata,
      writer,
      linkStates: Object.fromEntries(rows.map((row) => [row.property_key, row.state])),
    });
  };
}

function startRecording(): void {
  hookCalls = [];
}

function callsOf(propertyId: string): EdgeHookCall[] {
  return hookCalls.filter((call) => call.propertyId === propertyId);
}

/** Locked on a separate connection, so it fails while a transaction holds one. */
async function lockLinksNowait(itemId: string): Promise<string[]> {
  const client = await admin.connect();
  let failed = true;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ property_key: string }>(
      "SELECT property_key FROM value_links WHERE item_id = $1 ORDER BY property_key FOR UPDATE NOWAIT",
      [itemId],
    );
    await client.query("ROLLBACK");
    failed = false;
    return rows.map((row) => row.property_key);
  } finally {
    client.release(failed);
  }
}

interface LinkBreak {
  state: string;
  brokenBy: string | null;
  brokenAt: string | null;
}

async function projectLinkOf(world: World): Promise<LinkBreak> {
  const { rows } = await admin.query<{ state: string; broken_by: string | null; broken_at: Date | null }>(
    "SELECT state, broken_by, broken_at FROM value_links WHERE item_id = $1 AND property_key = 'project'",
    [world.transcript],
  );
  const row = rows[0];
  if (!row) throw new Error("The transcript has no project link");
  return { state: row.state, brokenBy: row.broken_by, brokenAt: row.broken_at?.toISOString() ?? null };
}

async function transcriptRowOf(world: World): Promise<{ properties: unknown; updatedAt: string }> {
  const { rows } = await admin.query<{ properties: unknown; updated_at: Date }>(
    "SELECT properties, updated_at FROM items WHERE id = $1",
    [world.transcript],
  );
  const row = rows[0];
  if (!row) throw new Error("The transcript is missing");
  return { properties: row.properties, updatedAt: row.updated_at.toISOString() };
}

async function transcriptEdgeOf(
  world: World,
  relationPropertyId: string,
  otherItemId: string,
): Promise<{ relationDefinitionId: string; itemA: string; itemB: string }> {
  const { rows } = await admin.query<{ id: string; property_id_a: string }>(
    "SELECT id, property_id_a FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
    [relationPropertyId],
  );
  const definition = rows[0];
  if (!definition) throw new Error("The relation definition is missing");
  const transcriptIsA = definition.property_id_a === relationPropertyId;
  return {
    relationDefinitionId: definition.id,
    itemA: transcriptIsA ? world.transcript : otherItemId,
    itemB: transcriptIsA ? otherItemId : world.transcript,
  };
}

describe("the lock order of an ordinary edge write on a link rule's via relation", () => {
  beforeAll(async () => {
    admin = getTestPool();
    fixture = await participant("lockOrder:fixture");
    holder = await participant("lockOrder:holder");
    propagation = await participant("lockOrder:propagation");
    edgeWriter = await participant("lockOrder:edgeWrite");
    setter = await participant("lockOrder:relationSet");
    trasher = await participant("lockOrder:eventTrash");
    for (const { pool } of [fixture, holder, propagation, edgeWriter, setter, trasher]) {
      const role = await runAsSystem("test:role", () =>
        pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }
    // The recorders join the hooks `domainWriteHooks.ts` registered: the recording hook of each registry runs last.
    registerRelationEdgeBeforeLinkBreakHook(recorder("beforeLinkBreak"));
    registerRelationEdgeChangedHook(recorder("changed"));
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    hookCalls = [];
  });

  afterAll(async () => {
    clearHooksForTests();
    for (const entry of [fixture, holder, propagation, edgeWriter, setter, trasher]) await entry?.pool.end();
    await admin?.end();
  });

  describe("schedule A: the propagation of the Event's project and a user removing the transcript's project", () => {
    it("refuses the propagation as busy and commits the user's write when the propagation waits for the transcript row first", async () => {
      const world = await buildWorld("web");
      await changeEventProject(world, world.web, world.bathroom);

      const result = await behindHeldRow(world, transcriptRow(world), [
        propagateEventProject(world),
        userDeletes(world, world.schema.transcriptProject, world.web),
      ]);

      // The user's write waits for the row before holding a link row, so the propagation that gets the row first is
      // refused by its own relation write's nonblocking admission.
      expect(result.blockedBy).toEqual([[holder.name], [propagation.name]]);
      expect(result.outcomes).toEqual(["busy", "committed"]);
      const settled: TranscriptState = {
        project: [],
        company: [world.novak],
        links: { people: ON, project: BROKEN_BY_USER },
      };
      await expectTranscript(world, settled);

      const before = await transcriptRowOf(world);
      expect(await outcomeOf(inTenant(world, () => propagateEventProject(world).call(propagation)))).toBe("committed");
      expect(await transcriptRowOf(world)).toEqual(before);
      await expectTranscript(world, settled);
    });

    it("commits both and leaves the transcript as the user's write made it when the user's write waits for the row first", async () => {
      const world = await buildWorld("web");
      await changeEventProject(world, world.web, world.bathroom);

      const result = await behindHeldRow(world, transcriptRow(world), [
        userDeletes(world, world.schema.transcriptProject, world.web),
        propagateEventProject(world),
      ]);

      expect(result).toEqual({
        blockedBy: [[holder.name], [edgeWriter.name]],
        outcomes: ["committed", "committed"],
      });
      // The link was broken by the user, so neither the new project nor its company reached the transcript.
      await expectTranscript(world, {
        project: [],
        company: [world.novak],
        links: { people: ON, project: BROKEN_BY_USER },
      });
    });
  });

  describe("schedule B: a user's relation.set against a user's edge write of the same relation on the same transcript", () => {
    // Untested: when the set waits for the transcript row first and the write deletes or creates the edge, one of
    // them deadlocks (the set locks the row then the edge row; the write holds the edge row, then waits for the row
    // in the engine's hook).
    describe("project, the target of one rule and the via relation of another", () => {
      it("settles when the write that deletes the edge waits first", async () => {
        const world = await buildWorld("web");

        const result = await behindHeldRow(world, transcriptRow(world), [
          userDeletes(world, world.schema.transcriptProject, world.web),
          userSets(world, world.schema.transcriptProject, world.bathroom),
        ]);

        expect(result).toEqual({
          blockedBy: [[holder.name], [edgeWriter.name]],
          outcomes: ["committed", "committed"],
        });
        await expectTranscript(world, {
          project: [world.bathroom],
          company: [world.novak],
          links: { people: ON, project: BROKEN_BY_USER },
        });
      });

      it("settles when the write that creates the edge waits first", async () => {
        const world = await buildWorld("none");

        const result = await behindHeldRow(world, transcriptRow(world), [
          userCreates(world, world.schema.transcriptProject, world.bathroom),
          userSets(world, world.schema.transcriptProject, world.web),
        ]);

        expect(result).toEqual({
          blockedBy: [[holder.name], [edgeWriter.name]],
          outcomes: ["committed", "committed"],
        });
        await expectTranscript(world, {
          project: [world.web],
          company: [world.siko],
          links: { people: ON, project: BROKEN_BY_USER },
        });
      });
    });

    describe("company, the target of a rule and no rule's via relation", () => {
      it("settles when the set waits first and the write deletes the edge without waiting", async () => {
        const world = await buildWorld("web");

        const result = await behindHeldRow(world, transcriptRow(world), [
          userSets(world, world.schema.transcriptCompany, world.siko),
          userDeletes(world, world.schema.transcriptCompany, world.novak),
        ]);

        expect(result).toEqual({ blockedBy: [[holder.name], null], outcomes: ["committed", "committed"] });
        await expectTranscript(world, {
          project: [world.web],
          company: [world.siko],
          links: { company: BROKEN_BY_USER, people: ON, project: ON },
        });
      });

      it("settles when the write that deletes the edge runs first", async () => {
        const world = await buildWorld("web");

        const result = await behindHeldRow(world, transcriptRow(world), [
          userDeletes(world, world.schema.transcriptCompany, world.novak),
          userSets(world, world.schema.transcriptCompany, world.siko),
        ]);

        expect(result).toEqual({ blockedBy: [null, [holder.name]], outcomes: ["committed", "committed"] });
        await expectTranscript(world, {
          project: [world.web],
          company: [world.siko],
          links: { company: BROKEN_BY_USER, people: ON, project: ON },
        });
      });

      it("settles when the set waits first and the write creates the edge without waiting", async () => {
        const world = await buildWorld("bare");

        const result = await behindHeldRow(world, transcriptRow(world), [
          userSets(world, world.schema.transcriptCompany, world.novak),
          userCreates(world, world.schema.transcriptCompany, world.siko),
        ]);

        expect(result).toEqual({ blockedBy: [[holder.name], null], outcomes: ["committed", "committed"] });
        await expectTranscript(world, {
          project: [world.bare],
          company: [world.novak],
          links: { company: BROKEN_BY_USER, people: ON, project: ON },
        });
      });

      it("settles when the write that creates the edge runs first", async () => {
        const world = await buildWorld("bare");

        const result = await behindHeldRow(world, transcriptRow(world), [
          userCreates(world, world.schema.transcriptCompany, world.siko),
          userSets(world, world.schema.transcriptCompany, world.novak),
        ]);

        expect(result).toEqual({ blockedBy: [null, [holder.name]], outcomes: ["committed", "committed"] });
        await expectTranscript(world, {
          project: [world.bare],
          company: [world.novak],
          links: { company: BROKEN_BY_USER, people: ON, project: ON },
        });
      });
    });
  });

  // Trashing an Event locks its transcripts' link rows without their item rows: `project` and `people` first, then
  // `company`. An edge write taking `company` before `project` would deadlock with it. A third transaction holds
  // the `company` link row.
  describe("schedule C: the trash of the Event against a user removing the transcript's project", () => {
    const companyLinkRow = (world: World) => (client: PoolClient) => lockValueLink(client, world.transcript, "company");
    const userTrashesEvent = (world: World): Step => ({
      participant: trasher,
      call: ({ cp }) => cp.softDeleteItem(world.schema.db.events, world.event, undefined, USER),
    });

    it("settles when the user's write waits for the company link row first", async () => {
      const world = await buildWorld("web");

      const result = await behindHeldRow(world, companyLinkRow(world), [
        userDeletes(world, world.schema.transcriptProject, world.web),
        userTrashesEvent(world),
      ]);

      expect(result).toEqual({
        blockedBy: [[holder.name], [edgeWriter.name]],
        outcomes: ["committed", "committed"],
      });
      await expectTranscript(world, { project: [], company: [world.novak], links: {} });
    });

    it("settles when the trash waits for the company link row first", async () => {
      const world = await buildWorld("web");

      const result = await behindHeldRow(world, companyLinkRow(world), [
        userTrashesEvent(world),
        userDeletes(world, world.schema.transcriptProject, world.web),
      ]);

      expect(result).toEqual({
        blockedBy: [[holder.name], [trasher.name]],
        outcomes: ["committed", "committed"],
      });
      await expectTranscript(world, { project: [], company: [world.novak], links: {} });
    });
  });

  describe("an edge write that would end an `on` link takes the item row first", () => {
    const ALL_LINKS = ["company", "people", "project"];

    it("makes a user's write wait for the held transcript row while it holds no value link row", async () => {
      const world = await buildWorld("web");

      let linksFreeWhileWaiting: string[] = [];
      const result = await behindHeldRow(
        world,
        transcriptRow(world),
        [userDeletes(world, world.schema.transcriptProject, world.web)],
        async () => {
          linksFreeWhileWaiting = await lockLinksNowait(world.transcript);
        },
      );

      expect(result).toEqual({ blockedBy: [[holder.name]], outcomes: ["committed"] });
      expect(linksFreeWhileWaiting).toEqual(ALL_LINKS);
      await expectTranscript(world, {
        project: [],
        company: [world.novak],
        links: { people: ON, project: BROKEN_BY_USER },
      });
    });

    it("makes an agent's write that needs no approval wait for the held transcript row while it holds no value link row", async () => {
      const world = await buildWorld("web");

      let linksFreeWhileWaiting: string[] = [];
      const result = await behindHeldRow(
        world,
        transcriptRow(world),
        [
          {
            participant: edgeWriter,
            call: ({ cp }) =>
              cp.deleteRelation(
                {
                  relationPropertyId: world.schema.transcriptProject,
                  callerItemId: world.transcript,
                  targetItemId: world.web,
                },
                AGENT,
              ),
          },
        ],
        async () => {
          linksFreeWhileWaiting = await lockLinksNowait(world.transcript);
        },
      );

      expect(result).toEqual({ blockedBy: [[holder.name]], outcomes: ["committed"] });
      expect(linksFreeWhileWaiting).toEqual(ALL_LINKS);
      await expectTranscript(world, {
        project: [],
        company: [world.novak],
        links: { people: ON, project: { state: "broken", brokenBy: "agent" } },
      });
    });

    it("makes a user's write that creates the project edge wait for the held transcript row while it holds no value link row", async () => {
      // The Event has no project, so the transcript's `project` link is `on` and empty, and the new edge ends it.
      const world = await buildWorld("none");

      let linksFreeWhileWaiting: string[] = [];
      const result = await behindHeldRow(
        world,
        transcriptRow(world),
        [userCreates(world, world.schema.transcriptProject, world.bathroom)],
        async () => {
          linksFreeWhileWaiting = await lockLinksNowait(world.transcript);
        },
      );

      expect(result).toEqual({ blockedBy: [[holder.name]], outcomes: ["committed"] });
      expect(linksFreeWhileWaiting).toEqual(["people", "project"]);
      await expectTranscript(world, {
        project: [world.bathroom],
        company: [world.siko],
        links: { company: ON, people: ON, project: BROKEN_BY_USER },
      });
    });

    it("does the same for a file's projects, the via relation of the rule that gives the file its companies", async () => {
      const world = await buildWorld("web");
      const fileProjects = await inTenant(world, async () => {
        const properties = await fixture.cp.listProperties(world.schema.db.files);
        const property = properties.find((entry) => entry.key === "projects");
        if (!property) throw new Error("Missing Files.projects");
        return property.id;
      });
      const file = (
        await inTenant(world, () =>
          fixture.cp.createItem({ databaseId: world.schema.db.files, properties: { name: "contract.pdf" } }),
        )
      ).id;
      await inTenant(world, () =>
        fixture.cp.createRelation(
          { relationPropertyId: fileProjects, callerItemId: file, targetItemId: world.web },
          USER,
        ),
      );
      expect(await lockLinksNowait(file)).toEqual(["companies"]);

      let linksFreeWhileWaiting: string[] = [];
      const result = await behindHeldRow(
        world,
        (client) => lockItemById(client, world.schema.db.files, file),
        [
          {
            participant: edgeWriter,
            call: ({ cp }) =>
              cp.deleteRelation(
                { relationPropertyId: fileProjects, callerItemId: file, targetItemId: world.web },
                USER,
              ),
          },
        ],
        async () => {
          linksFreeWhileWaiting = await lockLinksNowait(file);
        },
      );

      expect(result).toEqual({ blockedBy: [[holder.name]], outcomes: ["committed"] });
      expect(linksFreeWhileWaiting).toEqual(["companies"]);
      // The engine's hook took the file's companies from the removed project, and the link went with its last source.
      expect(await inTenant(world, () => fixture.cp.listItemRelations(file, fileProjects))).toEqual([]);
    });

    it("does not make a user's write on a relation that is no rule's via relation wait for the held transcript row", async () => {
      const world = await buildWorld("web");

      const result = await behindHeldRow(world, transcriptRow(world), [
        userDeletes(world, world.schema.transcriptCompany, world.novak),
      ]);

      expect(result).toEqual({ blockedBy: [null], outcomes: ["committed"] });
      await expectTranscript(world, {
        project: [world.web],
        company: [],
        links: { company: BROKEN_BY_USER, people: ON, project: ON },
      });
    });

    it("keeps the first breaker of a link recorded when a later write of another writer kind removes and re-adds the edge", async () => {
      const world = await buildWorld("web");
      await inTenant(world, () =>
        fixture.cp.deleteRelation(
          {
            relationPropertyId: world.schema.transcriptProject,
            callerItemId: world.transcript,
            targetItemId: world.web,
          },
          USER,
        ),
      );
      const first = await projectLinkOf(world);
      expect(first).toMatchObject({ state: "broken", brokenBy: "user" });

      await inTenant(world, async () => {
        const edge = {
          relationPropertyId: world.schema.transcriptProject,
          callerItemId: world.transcript,
          targetItemId: world.bathroom,
        };
        await fixture.cp.createRelation(edge, AGENT);
        await fixture.cp.deleteRelation(edge, AGENT);
      });

      expect(await projectLinkOf(world)).toEqual(first);
    });
  });

  describe("the hooks of an ordinary edge write", () => {
    const projectEdge = (world: World, targetItemId: string) => ({
      relationPropertyId: world.schema.transcriptProject,
      callerItemId: world.transcript,
      targetItemId,
    });

    it("runs the before-link-break hooks once, before the link break and the edge-changed hooks, when a user deletes an edge", async () => {
      const world = await buildWorld("web");
      startRecording();

      const edge = await inTenant(world, () => fixture.cp.deleteRelation(projectEdge(world, world.web), USER));

      if (!edge) throw new Error("The edge to delete was missing");
      const expected = {
        op: "delete",
        relationDefinitionId: edge.relationDefinitionId,
        propertyId: world.schema.transcriptProject,
        itemA: edge.itemA,
        itemB: edge.itemB,
        metadata: edge.metadata,
        writer: USER,
      };
      expect(callsOf(world.schema.transcriptProject)).toEqual([
        { ...expected, registry: "beforeLinkBreak", linkStates: { company: "on", people: "on", project: "on" } },
        // The engine's hook ended the transcript's `company` link with its source, after the link break.
        { ...expected, registry: "changed", linkStates: { people: "on", project: "broken" } },
      ]);
    });

    it("runs them once, with the written edge, when a user creates an edge", async () => {
      const world = await buildWorld("none");
      startRecording();

      const edge = await inTenant(world, () =>
        fixture.cp.createRelation({ ...projectEdge(world, world.bathroom), metadata: { note: "kept" } }, USER),
      );

      const expected = {
        op: "create",
        relationDefinitionId: edge.relationDefinitionId,
        propertyId: world.schema.transcriptProject,
        itemA: edge.itemA,
        itemB: edge.itemB,
        metadata: { note: "kept" },
        writer: USER,
      };
      expect(callsOf(world.schema.transcriptProject)).toEqual([
        { ...expected, registry: "beforeLinkBreak", linkStates: { people: "on", project: "on" } },
        { ...expected, registry: "changed", linkStates: { company: "on", people: "on", project: "broken" } },
      ]);
    });

    it("runs them once, with the written edge, when the data layer inserts an absent edge", async () => {
      const world = await buildWorld("none");
      startRecording();

      const result = await inTenant(world, () =>
        withTransaction(fixture.pool, (client) =>
          createRelationIfAbsentWithClient(client, projectEdge(world, world.bathroom), undefined, USER),
        ),
      );

      expect(result.inserted).toBe(true);
      const expected = {
        op: "create",
        relationDefinitionId: result.edge.relationDefinitionId,
        propertyId: world.schema.transcriptProject,
        itemA: result.edge.itemA,
        itemB: result.edge.itemB,
        metadata: {},
        writer: USER,
      };
      expect(callsOf(world.schema.transcriptProject)).toEqual([
        { ...expected, registry: "beforeLinkBreak", linkStates: { people: "on", project: "on" } },
        { ...expected, registry: "changed", linkStates: { company: "on", people: "on", project: "broken" } },
      ]);
    });

    it("runs no before-link-break hook for a replayed create, an insert of an edge that exists or a delete of an absent edge", async () => {
      const world = await buildWorld("web");
      startRecording();

      await inTenant(world, async () => {
        await fixture.cp.createRelation(projectEdge(world, world.web), USER);
        const existing = await withTransaction(fixture.pool, (client) =>
          createRelationIfAbsentWithClient(client, projectEdge(world, world.web), undefined, USER),
        );
        expect(existing.inserted).toBe(false);
        expect(await fixture.cp.deleteRelation(projectEdge(world, world.bathroom), USER)).toBeNull();
      });

      // Only the replayed create ran the edge-changed hooks; the other two writes changed nothing.
      expect(callsOf(world.schema.transcriptProject).map((call) => [call.registry, call.op])).toEqual([
        ["changed", "create"],
      ]);
    });

    it("runs no before-link-break hook for a system writer, while the edge-changed hooks still run", async () => {
      const world = await buildWorld("web");
      startRecording();

      await inTenant(world, async () => {
        await withTransaction(fixture.pool, (client) =>
          deleteRelationWithClient(client, projectEdge(world, world.web), {
            ownerProcess: TRANSCRIPTION_OWNER_PROCESS,
          }),
        );
        await withTransaction(fixture.pool, (client) =>
          createRelationWithClient(client, projectEdge(world, world.bathroom), {
            ownerProcess: TRANSCRIPTION_OWNER_PROCESS,
          }),
        );
        await withTransaction(fixture.pool, (client) =>
          deleteRelationWithClient(client, projectEdge(world, world.bathroom), {
            ownerProcess: TRANSCRIPTION_OWNER_PROCESS,
          }),
        );
        await withTransaction(fixture.pool, (client) =>
          createRelationIfAbsentWithClient(client, projectEdge(world, world.web), {
            ownerProcess: TRANSCRIPTION_OWNER_PROCESS,
          }),
        );
      });

      expect(callsOf(world.schema.transcriptProject).map((call) => [call.registry, call.op])).toEqual([
        ["changed", "delete"],
        ["changed", "create"],
        ["changed", "delete"],
        ["changed", "create"],
      ]);
    });

    it("runs the before-link-break hooks of an agent under a run before its approval check refuses the write", async () => {
      const world = await buildWorld("web");
      const bob = (
        await inTenant(world, () =>
          fixture.cp.createItem({ databaseId: world.schema.db.people, properties: { name: "Bob Novak" } }),
        )
      ).id;
      const runWriter: WriterIdentity = {
        writerKind: "agent",
        agentRunId: randomUUID(),
        agentProjectItemId: await inTenant(world, () => createTestProjectItem(fixture.pool)),
        onBehalfOfUserId: "00000000-0000-4000-8000-000000000003",
      };
      startRecording();

      // The transcript's `people` link is `on`, so an edge added to `people` would end it and needs approval.
      await expect(
        inTenant(world, () =>
          fixture.cp.createRelation(
            { relationPropertyId: world.schema.transcriptPeople, callerItemId: world.transcript, targetItemId: bob },
            runWriter,
          ),
        ),
      ).rejects.toBeInstanceOf(ApprovalRequiredForWrite);

      expect(callsOf(world.schema.transcriptPeople).map((call) => [call.registry, call.op, call.writer])).toEqual([
        ["beforeLinkBreak", "create", runWriter],
      ]);
      const people = await inTenant(world, () =>
        fixture.cp.listItemRelations(world.transcript, world.schema.transcriptPeople),
      );
      expect(people?.map((edge) => edge.targetItemId)).toEqual([world.alice]);
    });
  });

  describe("linkRuleEdgeLockHook", () => {
    async function lockHookStep(
      world: World,
      relationPropertyId: string,
      otherItemId: string,
      overrides: Partial<Pick<RelationEdgeChangedHookContext, "op" | "writer">>,
    ): Promise<Step> {
      const edge = await transcriptEdgeOf(world, relationPropertyId, otherItemId);
      return {
        participant: edgeWriter,
        call: ({ pool }) =>
          withTransaction(pool, (client) =>
            linkRuleEdgeLockHook({
              client,
              op: "delete",
              propertyId: relationPropertyId,
              metadata: {},
              writer: USER,
              ...edge,
              ...overrides,
            }),
          ),
      };
    }

    it("waits for the target item of a rule whose via relation is the written one", async () => {
      const world = await buildWorld("web");

      const result = await behindHeldRow(world, transcriptRow(world), [
        await lockHookStep(world, world.schema.transcriptProject, world.web, {}),
      ]);

      expect(result).toEqual({ blockedBy: [[holder.name]], outcomes: ["committed"] });
    });

    it("waits for nothing for a system writer", async () => {
      const world = await buildWorld("web");

      const result = await behindHeldRow(world, transcriptRow(world), [
        await lockHookStep(world, world.schema.transcriptProject, world.web, { writer: { writerKind: "system" } }),
      ]);

      expect(result).toEqual({ blockedBy: [null], outcomes: ["committed"] });
    });

    it("waits for nothing for an update of the edge", async () => {
      const world = await buildWorld("web");

      const result = await behindHeldRow(world, transcriptRow(world), [
        await lockHookStep(world, world.schema.transcriptProject, world.web, { op: "update" }),
      ]);

      expect(result).toEqual({ blockedBy: [null], outcomes: ["committed"] });
    });

    it("waits for nothing for an edge of a relation that is no rule's via relation", async () => {
      const world = await buildWorld("web");

      const result = await behindHeldRow(world, transcriptRow(world), [
        await lockHookStep(world, world.schema.transcriptCompany, world.novak, {}),
      ]);

      expect(result).toEqual({ blockedBy: [null], outcomes: ["committed"] });
    });
  });
});
