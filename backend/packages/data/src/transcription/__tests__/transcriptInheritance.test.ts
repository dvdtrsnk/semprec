import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { addValueLinkItemSource, insertValueLink, lockValueLink } from "../../chokePoint/valueLinksStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../../inbox/proposalActions.js";
import { findInvalidLinkRuleReferences } from "../../manifest/driftCheck.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import { matchTranscriptToEvent } from "../transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import { createTranscriptDetailRouteHandler } from "../transcriptionRouteHandlers.js";

const RECORDING_START = "2024-03-01T12:00:00.000Z";
const USER: WriterIdentity = { writerKind: "user" };
const SEMP: WriterIdentity = { writerKind: "agent" };
const ACTING_USER_ID = "7c0e2f6a-58a1-4d0e-9d55-2f1c6f7c9b01";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;

type DatabaseKey = "companies" | "events" | "people" | "processingProposals" | "projects" | "transcripts";

/** The database and relation property ids of one seeded tenant. */
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

/** One tenant's people, companies and projects, and the Event "client meeting" with its transcript. */
interface World {
  tenant: string;
  schema: Schema;
  me: string;
  alice: string;
  bob: string;
  novak: string;
  siko: string;
  web: string;
  bathroom: string;
  event: string;
  transcript: string;
}

async function seedTenant(): Promise<{ tenant: string; schema: Schema }> {
  const tenant = await createTestTenant(admin);
  return runInTenant(tenant, async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const databases = await cp.listDatabases();
    const db = (moduleId: DatabaseKey): string => {
      const found = databases.find((database) => database.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing database ${moduleId}`);
      return found.id;
    };
    const property = async (databaseId: string, key: string): Promise<string> => {
      const found = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
      if (!found) throw new Error(`Missing property ${key}`);
      return found.id;
    };
    const ids: Record<DatabaseKey, string> = {
      companies: db("companies"),
      events: db("events"),
      people: db("people"),
      processingProposals: db("processingProposals"),
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

/** Runs `fn` in the tenant, as every request and job of that tenant does. */
function inTenant<T>(world: Pick<World, "tenant">, fn: () => Promise<T>): Promise<T> {
  return runInTenant(world.tenant, fn);
}

async function item(scope: Pick<World, "tenant">, databaseId: string, properties: Record<string, unknown>) {
  return (await inTenant(scope, () => cp.createItem({ databaseId, properties }))).id;
}

/** A Transcripts row as the transcription process creates it, with the recording time as its `date`. */
async function createTranscript(scope: Pick<World, "tenant" | "schema">, name: string): Promise<string> {
  const created = await inTenant(scope, () =>
    withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: scope.schema.db.transcripts, properties: { name, date: RECORDING_START } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      ),
    ),
  );
  return created.id;
}

function link(
  scope: Pick<World, "tenant">,
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
  writer: WriterIdentity = USER,
): Promise<unknown> {
  return inTenant(scope, () => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, writer));
}

function unlink(
  scope: Pick<World, "tenant">,
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
  writer: WriterIdentity = USER,
): Promise<unknown> {
  return inTenant(scope, () => cp.deleteRelation({ relationPropertyId, callerItemId, targetItemId }, writer));
}

/**
 * The Event "client meeting" of the project Web for client (company Novak Web s.r.o.) with the
 * organizer (the tenant's own person), Alice and Bob as participants, and a transcript that has no
 * Event, project, company or people yet.
 */
async function buildWorld(): Promise<World> {
  const { tenant, schema } = await seedTenant();
  const scope = { tenant, schema };
  const me = await item(scope, schema.db.people, { name: "Me Myself" });
  const alice = await item(scope, schema.db.people, { name: "Alice Novak" });
  const bob = await item(scope, schema.db.people, { name: "Bob Dvorak" });
  await inTenant(scope, () => withTransaction(pool, (client) => setSelfPersonId(client, me)));
  const novak = await item(scope, schema.db.companies, { name: "Novak Web s.r.o." });
  const siko = await item(scope, schema.db.companies, { name: "Siko Koupelny a.s." });
  const web = await item(scope, schema.db.projects, { name: "Web for client" });
  const bathroom = await item(scope, schema.db.projects, { name: "Bathroom renovation" });
  await link(scope, schema.projectCompany, web, novak);
  await link(scope, schema.projectCompany, bathroom, siko);
  const event = await item(scope, schema.db.events, { name: "client meeting", type: "meeting", date: RECORDING_START });
  await link(scope, schema.eventProject, event, web);
  for (const person of [me, alice, bob]) await link(scope, schema.eventPeople, event, person);
  const transcript = await createTranscript(scope, "Recording 1");
  return { tenant, schema, me, alice, bob, novak, siko, web, bathroom, event, transcript };
}

/** The items a transcript's relation points to, sorted. */
async function related(world: World, relationPropertyId: string, transcriptId = world.transcript): Promise<string[]> {
  const edges = await inTenant(world, () => cp.listItemRelations(transcriptId, relationPropertyId));
  return (edges ?? []).map((edge) => edge.targetItemId).sort();
}

/**
 * The items the relation of `relationPropertyId` stores an edge to for `itemId`, sorted, read through the runtime
 * role inside the tenant. Unlike `related` it includes an item that is in the Trash.
 */
async function storedEdges(world: World, relationPropertyId: string, itemId = world.transcript): Promise<string[]> {
  return inTenant(world, async () => {
    const { rows } = await pool.query<{ other: string }>(
      `SELECT CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END AS other
       FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE (d.property_id_a = $1 OR d.property_id_b = $1) AND (r.item_a = $2 OR r.item_b = $2)
       ORDER BY other`,
      [relationPropertyId, itemId],
    );
    return rows.map((row) => row.other);
  });
}

async function values(world: World, transcriptId = world.transcript) {
  return {
    project: await related(world, world.schema.transcriptProject, transcriptId),
    company: await related(world, world.schema.transcriptCompany, transcriptId),
    people: await related(world, world.schema.transcriptPeople, transcriptId),
  };
}

async function linksOf(world: World, transcriptId = world.transcript) {
  return (await inTenant(world, () => cp.getValueLinksForItems([transcriptId]))).get(transcriptId) ?? {};
}

interface LinkRow {
  property_key: string;
  rule_key: string;
  state: string;
}

/** The stored link rows of a transcript, read through the runtime role inside the tenant. */
async function linkRows(world: World, transcriptId = world.transcript): Promise<LinkRow[]> {
  return inTenant(world, async () => {
    const { rows } = await pool.query<LinkRow>(
      "SELECT property_key, rule_key, state FROM value_links WHERE item_id = $1 ORDER BY property_key",
      [transcriptId],
    );
    return rows;
  });
}

const ALL_LINKS_ON: LinkRow[] = [
  { property_key: "company", rule_key: "transcriptCompanyFromProject", state: "on" },
  { property_key: "people", rule_key: "transcriptPeopleFromEvent", state: "on" },
  { property_key: "project", rule_key: "transcriptProjectFromEvent", state: "on" },
];

/**
 * Runs the queued value-link propagation jobs through the registered worker task until none is left.
 * One `runOnce` pass does not empty a tenant's lane, so the passes repeat; a queue that never empties
 * fails the test instead of letting an assertion about an unchanged value pass by accident.
 */
async function runPropagation(): Promise<void> {
  const taskName = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
  const handler = createCoreTaskList(pool, createActionRegistry())[taskName];
  if (!handler) throw new Error("Propagation handler missing");
  for (let pass = 0; pass < 40; pass++) {
    await runOnce({ pgPool: pool, taskList: { [taskName]: handler } });
    const remaining = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
      [taskName],
    );
    if (remaining.rows[0]?.count === "0") return;
  }
  throw new Error("Propagation queue did not drain");
}

/** Replaces the single edge of a one-valued relation, as a user changing the value does. */
async function replace(
  world: World,
  relationPropertyId: string,
  callerItemId: string,
  from: string,
  to: string,
  writer: WriterIdentity = USER,
): Promise<void> {
  await unlink(world, relationPropertyId, callerItemId, from, writer);
  await link(world, relationPropertyId, callerItemId, to, writer);
}

const sorted = (ids: string[]): string[] => [...ids].sort();

/**
 * Removes the relation whose inverse side is the Transcripts property `propertyId`, both properties and the
 * definition: the schema of a tenant before the cutover that adds the pair has run. Raw SQL on the admin pool,
 * because no API removes a property of a system database. The relation must hold no edge.
 */
async function removeRelationPair(propertyId: string): Promise<void> {
  const definition = await admin.query<{ other: string }>(
    "DELETE FROM relation_definitions WHERE property_id_b = $1 RETURNING property_id_a AS other",
    [propertyId],
  );
  expect(definition.rowCount).toBe(1);
  const removed = await admin.query("DELETE FROM properties WHERE id = ANY($1::uuid[])", [
    [propertyId, definition.rows[0]?.other],
  ]);
  expect(removed.rowCount).toBe(2);
}

/** Records the invalidations `fn` publishes; the hook is cleared again afterwards. */
async function capturingInvalidations(fn: () => Promise<unknown>): Promise<InvalidationEvent[]> {
  const events: InvalidationEvent[] = [];
  setInvalidationHook((event) => events.push(event));
  try {
    await fn();
  } finally {
    setInvalidationHook(() => {});
  }
  return events;
}

const itemUpdatesOf = (events: InvalidationEvent[], itemId: string): InvalidationEvent[] =>
  events.filter((event) => event.scope === "item" && event.op === "update" && event.itemId === itemId);

/** Chooses, changes or clears the tenant's own person as `PUT /api/auth/self-person` does. */
function setOwnPerson(world: World, personId: string | null): Promise<void> {
  return inTenant(world, () =>
    withTransaction(pool, (client) => setSelfPersonId(client, personId, USER, ACTING_USER_ID)),
  );
}

/** The System settings row and its `selfPerson` relation property, for a write through the generic relation endpoint. */
async function ownPersonRelation(world: World): Promise<{ relationPropertyId: string; callerItemId: string }> {
  return inTenant(world, async () => {
    const settings = (await cp.listDatabases()).find((database) => database.ownerModuleId === "systemSettings");
    if (!settings) throw new Error("Missing System settings");
    const property = (await cp.listProperties(settings.id)).find((entry) => entry.key === "selfPerson");
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [settings.id]);
    if (!property || rows.length !== 1 || !rows[0]) throw new Error("Missing System settings selfPerson");
    return { relationPropertyId: property.id, callerItemId: rows[0].id };
  });
}

/** How many propagation jobs are queued, for any tenant. */
async function queuedPropagationJobs(): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
    [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
  );
  return Number(rows[0]?.count);
}

/**
 * Runs the propagation jobs the fixture's own writes queued (every Events `people` or `project` edge queues one),
 * so that a later `runPropagation` runs only what the step under test queued.
 */
async function settleFixture(): Promise<void> {
  await runPropagation();
  expect(await queuedPropagationJobs()).toBe(0);
}

/**
 * Runs `work` in a tenant transaction that stays open until `release` is called. `ready` resolves with the
 * transaction's backend pid once `work` is done, and rejects if the transaction ends before that.
 */
function holdTransaction(world: World, work: (client: PoolClient) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal!: (pid: number) => void;
  const reached = new Promise<number>((resolve) => {
    signal = resolve;
  });
  const done = inTenant(world, () =>
    withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      if (!rows[0]) throw new Error("Missing holder pid");
      await work(client);
      signal(rows[0].pid);
      await gate;
    }),
  );
  const ready = Promise.race([
    reached,
    done.then(() => {
      throw new Error("The holding transaction ended before its barrier");
    }),
  ]);
  return { ready, release, done };
}

/** Waits until some backend is blocked by a lock the backend `holderPid` holds. */
async function expectBlockedBy(holderPid: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const { rows } = await admin.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                        WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked`,
        [holderPid],
      );
      expect(rows[0]?.blocked).toBe(true);
    },
    { timeout: 10_000, interval: 50 },
  );
}

/**
 * Holds `first` open in its own transaction, starts `second` and requires it to wait for a lock of the first,
 * then lets both finish. A failure of either, or `second` not waiting, fails the caller.
 */
async function runSecondBehindFirst(
  world: World,
  first: (client: PoolClient) => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<void> {
  const holder = holdTransaction(world, first);
  let waiting: Promise<unknown> | undefined;
  try {
    const holderPid = await holder.ready;
    waiting = second();
    await expectBlockedBy(holderPid);
  } finally {
    holder.release();
    await Promise.allSettled([holder.done, waiting]);
  }
  await holder.done;
  await waiting;
}

describe("a transcript inherits its project, company and people from its Event (issue #1697)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("declares the three rules, with the own-person filter on the people rule, valid against the seeded schema", async () => {
    const registry = await loadFullModuleRegistry();
    expect(() => registry.validateLinkRules()).not.toThrow();
    const rules = (await registry.getLinkRules()).filter((rule) => rule.key.startsWith("transcript"));
    expect(rules).toEqual([
      {
        moduleId: "systemDatabases",
        key: "transcriptProjectFromEvent",
        source: { databaseKey: "events", propertyKey: "project" },
        target: { databaseKey: "transcripts", propertyKey: "project" },
        via: { databaseKey: "transcripts", relationKey: "event" },
      },
      {
        moduleId: "systemDatabases",
        key: "transcriptPeopleFromEvent",
        source: { databaseKey: "events", propertyKey: "people" },
        target: { databaseKey: "transcripts", propertyKey: "people" },
        via: { databaseKey: "transcripts", relationKey: "event" },
        valueFilter: { omit: { databaseKey: "systemSettings", propertyKey: "selfPerson" } },
      },
      {
        moduleId: "systemDatabases",
        key: "transcriptCompanyFromProject",
        source: { databaseKey: "projects", propertyKey: "company" },
        target: { databaseKey: "transcripts", propertyKey: "company" },
        via: { databaseKey: "transcripts", relationKey: "project" },
      },
    ]);
    const scope = await seedTenant();
    const findings = await inTenant(scope, () =>
      withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry)),
    );
    expect(findings).toEqual([]);
  });

  describe("whichever process writes the Transcripts event edge", () => {
    const writers: Array<[name: string, write: (world: World) => Promise<void>]> = [
      [
        "the match step of the transcription worker",
        async (world) => {
          const outcome = await inTenant(world, () =>
            withTransaction(pool, (client) =>
              matchTranscriptToEvent(client, { transcriptId: world.transcript, durationSeconds: 3600 }),
            ),
          );
          expect(outcome).toBe("linked");
        },
      ],
      [
        "the generic relation endpoint",
        async (world) => {
          await inTenant(world, () =>
            cp.createRelation(
              {
                relationPropertyId: world.schema.transcriptEvent,
                callerItemId: world.transcript,
                targetItemId: world.event,
              },
              USER,
              ACTING_USER_ID,
            ),
          );
        },
      ],
      [
        "a Semp relation.put",
        async (world) => {
          // What the generic operation gateway runs for `relation.put` under an agent writer.
          await inTenant(world, () =>
            withTransaction(pool, (client) =>
              createRelationWithClient(
                client,
                {
                  relationPropertyId: world.schema.transcriptEvent,
                  callerItemId: world.transcript,
                  targetItemId: world.event,
                },
                undefined,
                SEMP,
              ),
            ),
          );
        },
      ],
    ];

    it.each(writers)(
      "%s gives the transcript the Event's project, the project's company and the participants without the organizer, all inherited",
      async (_name, write) => {
        const world = await buildWorld();
        await write(world);

        expect(await related(world, world.schema.transcriptEvent)).toEqual([world.event]);
        expect(await values(world)).toEqual({
          project: [world.web],
          company: [world.novak],
          people: sorted([world.alice, world.bob]),
        });
        expect(await linkRows(world)).toEqual(ALL_LINKS_ON);
        const links = await linksOf(world);
        const fromEvent = (propertyKey: string) => [
          { kind: "item", itemId: world.event, databaseKey: "events", title: "client meeting", propertyKey },
        ];
        expect(links.project).toEqual({
          valueKind: "inherited",
          sources: fromEvent("project"),
          brokenBy: null,
          brokenAt: null,
        });
        expect(links.people).toEqual({
          valueKind: "inherited",
          sources: fromEvent("people"),
          brokenBy: null,
          brokenAt: null,
        });
        expect(links.company).toEqual({
          valueKind: "inherited",
          sources: [
            {
              kind: "item",
              itemId: world.web,
              databaseKey: "projects",
              title: "Web for client",
              propertyKey: "company",
            },
          ],
          brokenBy: null,
          brokenAt: null,
        });
      },
    );
  });

  it("writes the values and the link rows in the transaction that writes the edge, and they roll back with it", async () => {
    const world = await buildWorld();
    const failure = new Error("fixture rollback");
    await expect(
      inTenant(world, () =>
        withTransaction(pool, async (client) => {
          await createRelationWithClient(
            client,
            {
              relationPropertyId: world.schema.transcriptEvent,
              callerItemId: world.transcript,
              targetItemId: world.event,
            },
            undefined,
            USER,
          );
          // Before the commit, on the writer's own connection: the three links and their values exist.
          const links = await client.query<LinkRow>(
            "SELECT property_key, rule_key, state FROM value_links WHERE item_id = $1 ORDER BY property_key",
            [world.transcript],
          );
          expect(links.rows).toEqual(ALL_LINKS_ON);
          const edges = await client.query<{ item: string }>(
            `SELECT CASE WHEN item_a = $1 THEN item_b ELSE item_a END AS item FROM item_relations
             WHERE item_a = $1 OR item_b = $1`,
            [world.transcript],
          );
          expect(edges.rows.map((row) => row.item).sort()).toEqual(
            sorted([world.event, world.web, world.novak, world.alice, world.bob]),
          );
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    expect(await related(world, world.schema.transcriptEvent)).toEqual([]);
    expect(await values(world)).toEqual({ project: [], company: [], people: [] });
    expect(await linkRows(world)).toEqual([]);
  });

  describe("while the transcript follows its Event", () => {
    it("takes the Event's new project through the propagation job", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      // The source edge change only queues the propagation; the transcript is unchanged until the job runs.
      expect((await values(world)).project).toEqual([world.web]);
      await runPropagation();

      expect((await values(world)).project).toEqual([world.bathroom]);
      const links = await linksOf(world);
      expect(links.project?.valueKind).toBe("inherited");
      expect(links.project?.sources.map((source) => (source.kind === "item" ? source.itemId : ""))).toEqual([
        world.event,
      ]);
    });

    it("takes the new project's company when the Event's project changes, and keeps following that project", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      await runPropagation();

      expect(await values(world)).toMatchObject({ project: [world.bathroom], company: [world.siko] });
      expect(await linkRows(world)).toEqual(ALL_LINKS_ON);
      const company = (await linksOf(world)).company;
      expect(company?.valueKind).toBe("inherited");
      expect(company?.sources.map((source) => (source.kind === "item" ? source.itemId : ""))).toEqual([world.bathroom]);

      // The company link names the new project: a change of that project's company reaches the transcript.
      const agency = await item(world, world.schema.db.companies, { name: "Nova Agency" });
      await replace(world, world.schema.projectCompany, world.bathroom, world.siko, agency);
      await runPropagation();
      expect((await values(world)).company).toEqual([agency]);
    });

    it("loses the company with the project when the Event loses its project, and takes both from a project the Event gets later", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      await unlink(world, world.schema.eventProject, world.event, world.web);
      await runPropagation();
      expect(await storedEdges(world, world.schema.transcriptProject)).toEqual([]);
      expect(await storedEdges(world, world.schema.transcriptCompany)).toEqual([]);
      // The project still follows the Event; the company link went with the project edge it followed.
      expect(await linkRows(world)).toEqual([
        { property_key: "people", rule_key: "transcriptPeopleFromEvent", state: "on" },
        { property_key: "project", rule_key: "transcriptProjectFromEvent", state: "on" },
      ]);

      await link(world, world.schema.eventProject, world.event, world.bathroom);
      await runPropagation();
      expect(await values(world)).toMatchObject({ project: [world.bathroom], company: [world.siko] });
      expect(await linkRows(world)).toEqual(ALL_LINKS_ON);
    });

    it("keeps a company the user changed by hand when the Event's project changes", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      const agency = await item(world, world.schema.db.companies, { name: "Nova Agency" });
      await replace(world, world.schema.transcriptCompany, world.transcript, world.novak, agency);
      expect((await linksOf(world)).company?.valueKind).toBe("inheritedBroken");

      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      await runPropagation();

      expect(await values(world)).toMatchObject({ project: [world.bathroom], company: [agency] });
      expect((await linksOf(world)).company?.valueKind).toBe("inheritedBroken");
    });

    it("keeps the company as an own value when the user replaces the transcript's project by hand", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      await replace(world, world.schema.transcriptProject, world.transcript, world.web, world.bathroom);

      // A disconnect by the user is not a replaced inherited value: the company stays and its link ends.
      expect(await values(world)).toMatchObject({ project: [world.bathroom], company: [world.novak] });
      expect(await linkRows(world)).toEqual([
        { property_key: "people", rule_key: "transcriptPeopleFromEvent", state: "on" },
        { property_key: "project", rule_key: "transcriptProjectFromEvent", state: "broken" },
      ]);
    });

    it("moves a company that follows a project the user chose when the user relinks the project to the Event", async () => {
      const world = await buildWorld();
      // The Event's project has no company, so the transcript's company is empty when the user picks a project.
      await unlink(world, world.schema.projectCompany, world.web, world.novak);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await replace(world, world.schema.transcriptProject, world.transcript, world.web, world.bathroom);
      expect(await values(world)).toMatchObject({ project: [world.bathroom], company: [world.siko] });
      expect(await linkRows(world)).toEqual([
        { property_key: "company", rule_key: "transcriptCompanyFromProject", state: "on" },
        { property_key: "people", rule_key: "transcriptPeopleFromEvent", state: "on" },
        { property_key: "project", rule_key: "transcriptProjectFromEvent", state: "broken" },
      ]);

      const relinked = await inTenant(world, () =>
        cp.relinkValue({ itemId: world.transcript, propertyKey: "project" }, ACTING_USER_ID),
      );

      expect(relinked.valueKind).toBe("inherited");
      expect(await storedEdges(world, world.schema.transcriptProject)).toEqual([world.web]);
      expect(await storedEdges(world, world.schema.transcriptCompany)).toEqual([]);
      expect(await linkRows(world)).toEqual(ALL_LINKS_ON);
      // The company follows the Event's project again: a company that project gets reaches the transcript.
      await link(world, world.schema.projectCompany, world.web, world.novak);
      await runPropagation();
      expect((await values(world)).company).toEqual([world.novak]);
    });

    it("takes over added and removed participants of the Event, still without the organizer", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });

      await unlink(world, world.schema.eventPeople, world.event, world.alice);
      await link(world, world.schema.eventPeople, world.event, carol);
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob]));
      await runPropagation();

      expect((await values(world)).people).toEqual(sorted([world.bob, carol]));
      expect((await linksOf(world)).people?.valueKind).toBe("inherited");
    });

    it("takes the new company when the company of the transcript's project changes", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      const agency = await item(world, world.schema.db.companies, { name: "Nova Agency" });

      await replace(world, world.schema.projectCompany, world.web, world.novak, agency);
      expect((await values(world)).company).toEqual([world.novak]);
      await runPropagation();

      expect((await values(world)).company).toEqual([agency]);
      expect((await linksOf(world)).company?.valueKind).toBe("inherited");
      expect(await linkRows(world)).toEqual(ALL_LINKS_ON);
    });

    it("stops following the Event's project once the user changed the transcript's project by hand", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      const garden = await item(world, world.schema.db.projects, { name: "Garden" });

      await replace(world, world.schema.transcriptProject, world.transcript, world.web, world.bathroom);
      const broken = (await linksOf(world)).project;
      expect(broken?.valueKind).toBe("inheritedBroken");
      expect(broken?.brokenBy).toBe("user");

      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      await replace(world, world.schema.eventProject, world.event, world.web, garden);
      await link(world, world.schema.eventPeople, world.event, carol);
      await runPropagation();
      expect((await values(world)).project).toEqual([world.bathroom]);
      expect((await linksOf(world)).project?.valueKind).toBe("inheritedBroken");
      // The same propagation run still reaches the people, whose link the user did not touch.
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob, carol]));
    });

    it("stops following the Event's participants once Semp changed the transcript's people", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const dave = await item(world, world.schema.db.people, { name: "Dave Kral" });

      await link(world, world.schema.transcriptPeople, world.transcript, carol, SEMP);
      const broken = (await linksOf(world)).people;
      expect(broken?.valueKind).toBe("inheritedBroken");
      expect(broken?.brokenBy).toBe("agent");

      await link(world, world.schema.eventPeople, world.event, dave);
      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      await runPropagation();
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob, carol]));
      // The same propagation run still reaches the project, whose link Semp did not touch.
      expect((await values(world)).project).toEqual([world.bathroom]);
    });
  });

  describe("the tenant's own person", () => {
    it("is left out when it is the Event's only participant, and a later participant is still copied", async () => {
      const world = await buildWorld();
      for (const person of [world.alice, world.bob]) await unlink(world, world.schema.eventPeople, world.event, person);

      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      expect((await values(world)).people).toEqual([]);
      expect((await linksOf(world)).people?.valueKind).toBe("inherited");

      await link(world, world.schema.eventPeople, world.event, world.alice);
      await runPropagation();
      expect((await values(world)).people).toEqual([world.alice]);
    });

    it("is left out when the propagation job copies an Event it was added to later", async () => {
      const world = await buildWorld();
      await unlink(world, world.schema.eventPeople, world.event, world.me);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob]));

      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      await link(world, world.schema.eventPeople, world.event, world.me);
      await link(world, world.schema.eventPeople, world.event, carol);
      await runPropagation();
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob, carol]));
    });

    it("is copied like every other participant while the tenant has chosen no own person", async () => {
      const world = await buildWorld();
      await inTenant(world, () => withTransaction(pool, (client) => setSelfPersonId(client, null)));

      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      expect((await values(world)).people).toEqual(sorted([world.me, world.alice, world.bob]));
    });

    it("leaves the transcript's people once it is chosen after the transcript was linked", async () => {
      const world = await buildWorld();
      await setOwnPerson(world, null);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await settleFixture();
      expect((await values(world)).people).toEqual(sorted([world.me, world.alice, world.bob]));

      await setOwnPerson(world, world.me);
      // Choosing the person only queues the recomputation; the transcript is unchanged until the job runs.
      expect(await queuedPropagationJobs()).toBe(1);
      expect((await values(world)).people).toEqual(sorted([world.me, world.alice, world.bob]));
      await runPropagation();

      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob]));
      expect(await linkRows(world)).toEqual(ALL_LINKS_ON);
    });

    it("follows a change of the own person and its removal: the previous one returns and the new one leaves", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await settleFixture();
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob]));

      await setOwnPerson(world, world.alice);
      await runPropagation();
      expect((await values(world)).people).toEqual(sorted([world.me, world.bob]));

      await setOwnPerson(world, null);
      await runPropagation();
      expect((await values(world)).people).toEqual(sorted([world.me, world.alice, world.bob]));
      expect((await linksOf(world)).people?.valueKind).toBe("inherited");
    });

    it("leaves the transcript's people when it is chosen through the generic relation endpoint", async () => {
      const world = await buildWorld();
      await setOwnPerson(world, null);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await settleFixture();
      const ownPerson = await ownPersonRelation(world);

      await inTenant(world, () => cp.createRelation({ ...ownPerson, targetItemId: world.me }, USER, ACTING_USER_ID));
      await runPropagation();

      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob]));
    });

    it("queues nothing for people the user had changed by hand, which stay as they are", async () => {
      const world = await buildWorld();
      await setOwnPerson(world, null);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.transcriptPeople, world.transcript, world.bob);
      expect((await linksOf(world)).people?.valueKind).toBe("inheritedBroken");
      await settleFixture();

      await setOwnPerson(world, world.me);

      // A broken link is the user's own value: its source is not queued and the engine never writes it.
      expect(await queuedPropagationJobs()).toBe(0);
      expect((await values(world)).people).toEqual(sorted([world.me, world.alice]));
    });

    it("is read after a change of it that is in flight: a link written meanwhile waits and leaves the new person out", async () => {
      const world = await buildWorld();
      await setOwnPerson(world, null);
      await settleFixture();

      await runSecondBehindFirst(
        world,
        (client) => setSelfPersonId(client, world.me, USER, ACTING_USER_ID),
        () => link(world, world.schema.transcriptEvent, world.transcript, world.event),
      );

      // The copy read the own person the first transaction committed: it is right without any recomputation.
      expect(await queuedPropagationJobs()).toBe(0);
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob]));
    });

    it("waits, when it is chosen, for a link that is being written, and then removes the person from it", async () => {
      const world = await buildWorld();
      await setOwnPerson(world, null);
      await settleFixture();
      const ownPerson = await ownPersonRelation(world);

      await runSecondBehindFirst(
        world,
        (client) =>
          createRelationWithClient(
            client,
            {
              relationPropertyId: world.schema.transcriptEvent,
              callerItemId: world.transcript,
              targetItemId: world.event,
            },
            undefined,
            USER,
          ),
        () => inTenant(world, () => cp.createRelation({ ...ownPerson, targetItemId: world.me }, USER, ACTING_USER_ID)),
      );

      // The link committed first, with the person; the choice saw that link and queued its recomputation.
      expect((await values(world)).people).toEqual(sorted([world.me, world.alice, world.bob]));
      await runPropagation();
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob]));
    });

    it("is left out again when the user relinks people they had changed by hand", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.transcriptPeople, world.transcript, world.bob);
      expect((await linksOf(world)).people?.valueKind).toBe("inheritedBroken");

      const relinked = await inTenant(world, () =>
        cp.relinkValue({ itemId: world.transcript, propertyKey: "people" }, ACTING_USER_ID),
      );
      expect(relinked.valueKind).toBe("inherited");
      expect((await values(world)).people).toEqual(sorted([world.alice, world.bob]));
    });
  });

  it("keeps a project chosen on the recording card when an Event with another project is linked, and fills the empty people", async () => {
    const world = await buildWorld();
    // The create step of the transcription worker writes the recording's project as a system writer (issue #1696).
    await inTenant(world, () =>
      withTransaction(pool, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: world.schema.transcriptProject,
          callerItemId: world.transcript,
          targetItemId: world.bathroom,
        }),
      ),
    );
    expect(await linkRows(world)).toEqual([
      { property_key: "company", rule_key: "transcriptCompanyFromProject", state: "on" },
    ]);

    await link(world, world.schema.transcriptEvent, world.transcript, world.event);

    expect(await values(world)).toEqual({
      project: [world.bathroom],
      company: [world.siko],
      people: sorted([world.alice, world.bob]),
    });
    const links = await linksOf(world);
    expect(links.project).toBeUndefined();
    expect(links.people?.valueKind).toBe("inherited");
    // A later change of the Event's project does not reach the own project, while its new participant arrives.
    const garden = await item(world, world.schema.db.projects, { name: "Garden" });
    const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
    await replace(world, world.schema.eventProject, world.event, world.web, garden);
    await link(world, world.schema.eventPeople, world.event, carol);
    await runPropagation();
    expect((await values(world)).project).toEqual([world.bathroom]);
    expect((await values(world)).people).toEqual(sorted([world.alice, world.bob, carol]));
  });

  describe("a value that is in the Trash", () => {
    const trash = (world: World, databaseId: string, itemId: string) =>
      inTenant(world, () => cp.softDeleteItem(databaseId, itemId, ACTING_USER_ID, USER));

    it("is left out when the match step links an Event whose project and one participant are in the Trash", async () => {
      const world = await buildWorld();
      await trash(world, world.schema.db.projects, world.web);
      await trash(world, world.schema.db.people, world.bob);
      // The Trash kept the Event's edges to both.
      expect(await storedEdges(world, world.schema.eventPeople, world.event)).toEqual(
        sorted([world.me, world.alice, world.bob]),
      );
      expect(await storedEdges(world, world.schema.eventProject, world.event)).toEqual([world.web]);

      const outcome = await inTenant(world, () =>
        withTransaction(pool, (client) =>
          matchTranscriptToEvent(client, { transcriptId: world.transcript, durationSeconds: 3600 }),
        ),
      );

      expect(outcome).toBe("linked");
      expect(await related(world, world.schema.transcriptEvent)).toEqual([world.event]);
      // Stored edges, not only the live ones a read returns.
      expect(await storedEdges(world, world.schema.transcriptProject)).toEqual([]);
      expect(await storedEdges(world, world.schema.transcriptCompany)).toEqual([]);
      expect(await storedEdges(world, world.schema.transcriptPeople)).toEqual([world.alice]);
      // The project link is on with no value; without a project edge there is no company link.
      expect(await linkRows(world)).toEqual([
        { property_key: "people", rule_key: "transcriptPeopleFromEvent", state: "on" },
        { property_key: "project", rule_key: "transcriptProjectFromEvent", state: "on" },
      ]);
    });

    it("does not fail the write of a recording-card project whose company is in the Trash", async () => {
      const world = await buildWorld();
      await trash(world, world.schema.db.companies, world.siko);

      // The write the create step of the transcription worker makes for the recording's project (issue #1696).
      await inTenant(world, () =>
        withTransaction(pool, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: world.schema.transcriptProject,
            callerItemId: world.transcript,
            targetItemId: world.bathroom,
          }),
        ),
      );

      expect(await storedEdges(world, world.schema.transcriptProject)).toEqual([world.bathroom]);
      expect(await storedEdges(world, world.schema.transcriptCompany)).toEqual([]);
      expect(await linkRows(world)).toEqual([
        { property_key: "company", rule_key: "transcriptCompanyFromProject", state: "on" },
      ]);
    });

    it("is not added by the propagation job, and leaves a transcript that held it", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const dave = await item(world, world.schema.db.people, { name: "Dave Kral" });
      await link(world, world.schema.eventPeople, world.event, dave);
      await trash(world, world.schema.db.people, world.bob);
      await trash(world, world.schema.db.people, dave);

      await link(world, world.schema.eventPeople, world.event, carol);
      await runPropagation();

      // Stored edges, not only the live ones a read returns: Bob's edge is gone and Dave's was never written.
      expect(await storedEdges(world, world.schema.transcriptPeople)).toEqual(sorted([world.alice, carol]));
      expect((await linksOf(world)).people?.valueKind).toBe("inherited");
    });

    it("is left out when the user relinks people they had changed by hand", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.transcriptPeople, world.transcript, world.alice);
      await trash(world, world.schema.db.people, world.alice);

      const relinked = await inTenant(world, () =>
        cp.relinkValue({ itemId: world.transcript, propertyKey: "people" }, ACTING_USER_ID),
      );

      expect(relinked.valueKind).toBe("inherited");
      expect(await storedEdges(world, world.schema.transcriptPeople)).toEqual([world.bob]);
    });
  });

  describe("when the Event goes", () => {
    /**
     * After the release: later changes of the old sources reach a second transcript that is linked to the
     * Event now, and do not reach the released one, which has no link row.
     */
    async function expectValuesStayOwn(world: World): Promise<void> {
      const following = await createTranscript(world, "Following recording");
      await link(world, world.schema.transcriptEvent, following, world.event);
      const agency = await item(world, world.schema.db.companies, { name: "Nova Agency" });
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      await replace(world, world.schema.projectCompany, world.web, world.novak, agency);
      await link(world, world.schema.eventPeople, world.event, carol);
      await runPropagation();
      expect(await values(world, following)).toEqual({
        project: [world.web],
        company: [agency],
        people: sorted([world.alice, world.bob, carol]),
      });
      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      await runPropagation();
      expect((await values(world, following)).project).toEqual([world.bathroom]);

      expect(await values(world)).toEqual({
        project: [world.web],
        company: [world.novak],
        people: sorted([world.alice, world.bob]),
      });
      expect(await linkRows(world)).toEqual([]);
      expect(await linksOf(world)).toEqual({});
    }

    it("keeps project, company and people as own values after the user disconnects the Event", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      await unlink(world, world.schema.transcriptEvent, world.transcript, world.event);

      expect(await values(world)).toEqual({
        project: [world.web],
        company: [world.novak],
        people: sorted([world.alice, world.bob]),
      });
      expect(await linkRows(world)).toEqual([]);
      await expectValuesStayOwn(world);
    });

    it("keeps them as own values after the Event is moved to the Trash, and restoring the Event reconnects nothing", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      await inTenant(world, () => cp.softDeleteItem(world.schema.db.events, world.event, ACTING_USER_ID, USER));
      expect(await values(world)).toEqual({
        project: [world.web],
        company: [world.novak],
        people: sorted([world.alice, world.bob]),
      });
      expect(await linkRows(world)).toEqual([]);

      const restored = await inTenant(world, () =>
        cp.restoreItem(world.schema.db.events, world.event, ACTING_USER_ID, USER),
      );
      expect(restored?.deletedAt).toBeNull();
      // The edge to the restored Event is still there; no link came back with it.
      expect(await related(world, world.schema.transcriptEvent)).toEqual([world.event]);
      expect(await linkRows(world)).toEqual([]);
      await expectValuesStayOwn(world);
    });

    it("ends the company link of every transcript of a trashed Event and of no other Event's transcript", async () => {
      const world = await buildWorld();
      const second = await createTranscript(world, "Recording 2");
      const elsewhere = await createTranscript(world, "Recording 3");
      const otherEvent = await item(world, world.schema.db.events, {
        name: "other meeting",
        type: "meeting",
        date: RECORDING_START,
      });
      await link(world, world.schema.eventProject, otherEvent, world.bathroom);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await link(world, world.schema.transcriptEvent, second, world.event);
      await link(world, world.schema.transcriptEvent, elsewhere, otherEvent);

      const events = await capturingInvalidations(() =>
        inTenant(world, () => cp.softDeleteItem(world.schema.db.events, world.event, ACTING_USER_ID, USER)),
      );

      expect(await linkRows(world)).toEqual([]);
      expect(await linkRows(world, second)).toEqual([]);
      expect((await values(world, second)).company).toEqual([world.novak]);
      expect((await linkRows(world, elsewhere)).map((row) => row.property_key)).toEqual([
        "company",
        "people",
        "project",
      ]);
      // Each released transcript is announced to the acting user; the other Event's transcript is not.
      for (const transcriptId of [world.transcript, second]) {
        const announced = itemUpdatesOf(events, transcriptId);
        expect(announced.length).toBeGreaterThan(0);
        expect(announced.every((event) => event.userId === ACTING_USER_ID)).toBe(true);
      }
      expect(itemUpdatesOf(events, elsewhere)).toEqual([]);
    });

    it("announces the transcript after the commit of the disconnect, and not at all when the disconnect rolls back", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      const edge = {
        relationPropertyId: world.schema.transcriptEvent,
        callerItemId: world.transcript,
        targetItemId: world.event,
      };
      const failure = new Error("fixture rollback");
      const rolledBack = await capturingInvalidations(() =>
        expect(
          inTenant(world, () =>
            withTransaction(pool, async (client) => {
              await deleteRelationWithClient(client, edge, undefined, USER);
              throw failure;
            }),
          ),
        ).rejects.toBe(failure),
      );
      expect(rolledBack).toEqual([]);
      expect(await linkRows(world)).toEqual(ALL_LINKS_ON);

      const committed = await capturingInvalidations(() => inTenant(world, () => cp.deleteRelation(edge, USER)));
      expect(itemUpdatesOf(committed, world.transcript)).toHaveLength(1);
    });

    it("leaves a transcript without a company link alone and announces nothing for it", async () => {
      const world = await buildWorld();
      await unlink(world, world.schema.eventProject, world.event, world.web);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      // The Event has no project, so the transcript's project link is on with no value and no company link exists.
      expect((await linkRows(world)).map((row) => row.property_key)).toEqual(["people", "project"]);

      const events = await capturingInvalidations(() =>
        unlink(world, world.schema.transcriptEvent, world.transcript, world.event),
      );
      expect(itemUpdatesOf(events, world.transcript)).toEqual([]);
      expect(await linkRows(world)).toEqual([]);
    });

    it("keeps the company link when another relation of the transcript loses an edge", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      await unlink(world, world.schema.transcriptPeople, world.transcript, world.bob);

      expect(await linkRows(world)).toEqual([
        { property_key: "company", rule_key: "transcriptCompanyFromProject", state: "on" },
        { property_key: "people", rule_key: "transcriptPeopleFromEvent", state: "broken" },
        { property_key: "project", rule_key: "transcriptProjectFromEvent", state: "on" },
      ]);
    });

    it("keeps the company link when the transcript itself, not its Event, is moved to the Trash", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      await inTenant(world, () =>
        cp.softDeleteItem(world.schema.db.transcripts, world.transcript, ACTING_USER_ID, USER),
      );

      expect(await linkRows(world)).toEqual(ALL_LINKS_ON);
    });

    it("also ends a company link the user had broken, so the company reads as own", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await replace(world, world.schema.transcriptCompany, world.transcript, world.novak, world.siko);
      expect((await linksOf(world)).company?.valueKind).toBe("inheritedBroken");

      await unlink(world, world.schema.transcriptEvent, world.transcript, world.event);

      expect((await values(world)).company).toEqual([world.siko]);
      expect(await linkRows(world)).toEqual([]);
    });

    const relink = (world: World, propertyKey: string) =>
      inTenant(world, () => cp.relinkValue({ itemId: world.transcript, propertyKey }, ACTING_USER_ID));
    const sourceItemIds = async (world: World, propertyKey: string): Promise<string[]> =>
      ((await linksOf(world))[propertyKey]?.sources ?? []).map((source) =>
        source.kind === "item" ? source.itemId : "",
      );

    it("ends a project link and a people link the user had changed, so a relink after the disconnect is refused", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await replace(world, world.schema.transcriptProject, world.transcript, world.web, world.bathroom);
      await unlink(world, world.schema.transcriptPeople, world.transcript, world.bob);
      expect(await linkRows(world)).toEqual([
        { property_key: "people", rule_key: "transcriptPeopleFromEvent", state: "broken" },
        { property_key: "project", rule_key: "transcriptProjectFromEvent", state: "broken" },
      ]);

      const events = await capturingInvalidations(() =>
        unlink(world, world.schema.transcriptEvent, world.transcript, world.event),
      );

      expect(await linkRows(world)).toEqual([]);
      expect(itemUpdatesOf(events, world.transcript)).toHaveLength(1);
      for (const propertyKey of ["project", "people"])
        await expect(relink(world, propertyKey)).rejects.toMatchObject({ status: 409, code: "value_link_conflict" });
      // The refused relinks wrote nothing, and a later change of the Event reaches nothing.
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const garden = await item(world, world.schema.db.projects, { name: "Garden" });
      await link(world, world.schema.eventPeople, world.event, carol);
      await replace(world, world.schema.eventProject, world.event, world.web, garden);
      await runPropagation();
      expect(await values(world)).toEqual({ project: [world.bathroom], company: [world.novak], people: [world.alice] });
      expect(await linkRows(world)).toEqual([]);
    });

    it("announces the transcript once when the disconnect ends a changed people link and the company link", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.transcriptPeople, world.transcript, world.bob);

      const events = await capturingInvalidations(() =>
        unlink(world, world.schema.transcriptEvent, world.transcript, world.event),
      );

      expect(await linkRows(world)).toEqual([]);
      expect(itemUpdatesOf(events, world.transcript)).toHaveLength(1);
    });

    it("leaves no link that names a trashed Event either, a people link the user had changed included", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.transcriptPeople, world.transcript, world.bob);

      await inTenant(world, () => cp.softDeleteItem(world.schema.db.events, world.event, ACTING_USER_ID, USER));

      expect(await linkRows(world)).toEqual([]);
      await expect(relink(world, "people")).rejects.toMatchObject({ status: 409, code: "value_link_conflict" });
      expect((await values(world)).people).toEqual([world.alice]);
    });

    it("takes the people of an Event linked after the disconnect into people the user had emptied", async () => {
      const world = await buildWorld();
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const otherEvent = await item(world, world.schema.db.events, {
        name: "other meeting",
        type: "meeting",
        date: RECORDING_START,
      });
      await link(world, world.schema.eventPeople, otherEvent, carol);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      for (const person of [world.alice, world.bob])
        await unlink(world, world.schema.transcriptPeople, world.transcript, person);
      await unlink(world, world.schema.transcriptEvent, world.transcript, world.event);

      await link(world, world.schema.transcriptEvent, world.transcript, otherEvent);

      // The broken link went with the first Event, so the empty people are an empty own value again.
      expect((await values(world)).people).toEqual([carol]);
      expect(await sourceItemIds(world, "people")).toEqual([otherEvent]);
      // The project and the company the first Event gave stay as own values.
      expect(await values(world)).toMatchObject({ project: [world.web], company: [world.novak] });
    });

    it("keeps a link another source still feeds, and leaves a link that does not name the removed Event alone", async () => {
      const world = await buildWorld();
      const otherEvent = await item(world, world.schema.db.events, {
        name: "other meeting",
        type: "meeting",
        date: RECORDING_START,
      });
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.transcriptPeople, world.transcript, world.bob);
      // A transcript has one Event, so no rule gives its people link a second one: the store fixture adds the source.
      await inTenant(world, () =>
        withTransaction(pool, async (client) => {
          const people = await lockValueLink(client, world.transcript, "people");
          if (!people) throw new Error("People link missing");
          expect(await addValueLinkItemSource(client, people.id, otherEvent, "people")).toBe(true);
        }),
      );

      await unlink(world, world.schema.transcriptEvent, world.transcript, world.event);
      expect(await linkRows(world)).toEqual([
        { property_key: "people", rule_key: "transcriptPeopleFromEvent", state: "broken" },
      ]);
      expect(await sourceItemIds(world, "people")).toEqual([otherEvent]);

      // Linked again, the broken link gets no new source from the engine, so it does not name this Event.
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      const events = await capturingInvalidations(() =>
        unlink(world, world.schema.transcriptEvent, world.transcript, world.event),
      );
      expect(itemUpdatesOf(events, world.transcript)).toEqual([]);
      expect(await sourceItemIds(world, "people")).toEqual([otherEvent]);
    });

    it("fails the disconnect and rolls it back when the company link keeps a source it cannot remove", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.eventProject, world.event, world.web);
      await runPropagation();
      expect((await linkRows(world)).map((row) => row.property_key)).toEqual(["people", "project"]);
      // No rule gives a transcript's company a sender-domain source, so the store fixture writes the row directly.
      await inTenant(world, () =>
        withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: world.transcript,
            propertyKey: "company",
            ruleKey: "transcriptCompanyFromProject",
            sources: [{ kind: "senderDomain", domain: "example.test", sourcePropertyKey: "company" }],
          }),
        ),
      );

      await expect(unlink(world, world.schema.transcriptEvent, world.transcript, world.event)).rejects.toThrow(
        "Transcript company link kept a source during its release",
      );

      expect(await related(world, world.schema.transcriptEvent)).toEqual([world.event]);
      expect((await linkRows(world)).map((row) => row.property_key)).toEqual(["company", "people", "project"]);
    });
  });

  describe("the release hooks in a tenant without the Transcripts schema", () => {
    it("let an edge of another relation be removed in a tenant that was never seeded", async () => {
      const tenant = await createTestTenant(admin);
      await runInTenant(tenant, async () => {
        const database = await cp.createDatabase({ name: "Notes" });
        await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
        const relation = await cp.createRelationProperty({
          sourceDatabaseId: database.id,
          key: "related",
          name: "Related",
          targetDatabaseId: database.id,
          cardinality: "many_to_many",
        });
        const first = await cp.createItem({ databaseId: database.id, properties: { name: "First" } });
        const second = await cp.createItem({ databaseId: database.id, properties: { name: "Second" } });
        const edge = { relationPropertyId: relation.property.id, callerItemId: first.id, targetItemId: second.id };
        await cp.createRelation(edge, USER);

        expect(await cp.deleteRelation(edge, USER)).not.toBeNull();
        expect(await cp.listItemRelations(first.id, relation.property.id)).toEqual([]);
      });
    });

    it("let an Event be trashed in a tenant whose Transcripts database has no event relation", async () => {
      const world = await buildWorld();
      await removeRelationPair(world.schema.transcriptEvent);

      const trashed = await inTenant(world, () =>
        cp.softDeleteItem(world.schema.db.events, world.event, ACTING_USER_ID, USER),
      );
      expect(trashed?.deletedAt).not.toBeNull();
    });
  });

  describe("the transcript detail", () => {
    // Strict shapes: a field the response adds or drops fails the parse instead of passing unnoticed.
    const linkStateShape = { valueKind: z.string(), sources: z.array(z.record(z.string(), z.unknown())) };
    const valueSchema = z.strictObject({ id: z.string(), name: z.string().nullable(), ...linkStateShape });
    const detailSchema = z.object({
      context: z.strictObject({
        project: valueSchema.nullable(),
        company: valueSchema.nullable(),
        people: z.array(z.strictObject({ personId: z.string(), name: z.string().nullable(), ...linkStateShape })),
      }),
    });

    const detail = async (world: World, transcriptId = world.transcript) => {
      const response = await inTenant(world, () =>
        createTranscriptDetailRouteHandler(pool)({
          params: { id: transcriptId },
          identity: { user: { locale: "en" } },
        }),
      );
      expect(response.status).toBe(200);
      return detailSchema.parse(response.body);
    };

    it("returns project, company and people with their link state and the name of their source", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      const fromEvent = (propertyKey: string) => [
        { kind: "item", itemId: world.event, databaseKey: "events", title: "client meeting", propertyKey },
      ];
      expect((await detail(world)).context).toEqual({
        project: { id: world.web, name: "Web for client", valueKind: "inherited", sources: fromEvent("project") },
        company: {
          id: world.novak,
          name: "Novak Web s.r.o.",
          valueKind: "inherited",
          sources: [
            {
              kind: "item",
              itemId: world.web,
              databaseKey: "projects",
              title: "Web for client",
              propertyKey: "company",
            },
          ],
        },
        people: [
          { personId: world.alice, name: "Alice Novak", valueKind: "inherited", sources: fromEvent("people") },
          { personId: world.bob, name: "Bob Dvorak", valueKind: "inherited", sources: fromEvent("people") },
        ],
      });
    });

    it("returns a value the user changed as inheritedBroken and, after the Event is disconnected, every value as own", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.transcriptPeople, world.transcript, world.alice);

      const changed = (await detail(world)).context;
      expect(changed.people).toEqual([
        {
          personId: world.bob,
          name: "Bob Dvorak",
          valueKind: "inheritedBroken",
          sources: [
            {
              kind: "item",
              itemId: world.event,
              databaseKey: "events",
              title: "client meeting",
              propertyKey: "people",
            },
          ],
        },
      ]);
      expect(changed.project?.valueKind).toBe("inherited");

      await unlink(world, world.schema.transcriptEvent, world.transcript, world.event);
      // The disconnect also ended the people link the user had broken, so no value names the Event any more.
      expect((await detail(world)).context).toEqual({
        project: { id: world.web, name: "Web for client", valueKind: "own", sources: [] },
        company: { id: world.novak, name: "Novak Web s.r.o.", valueKind: "own", sources: [] },
        people: [{ personId: world.bob, name: "Bob Dvorak", valueKind: "own", sources: [] }],
      });
    });

    it("returns no project, no company and no people for a transcript without them", async () => {
      const world = await buildWorld();
      expect((await detail(world)).context).toEqual({ project: null, company: null, people: [] });
    });

    it("leaves out a project, a company and a person that are in the Trash", async () => {
      const world = await buildWorld();
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);
      await unlink(world, world.schema.transcriptEvent, world.transcript, world.event);
      for (const [databaseId, itemId] of [
        [world.schema.db.projects, world.web],
        [world.schema.db.companies, world.novak],
        [world.schema.db.people, world.alice],
      ] as const)
        await inTenant(world, () => cp.softDeleteItem(databaseId, itemId, ACTING_USER_ID, USER));

      expect((await detail(world)).context).toEqual({
        project: null,
        company: null,
        people: [{ personId: world.bob, name: "Bob Dvorak", valueKind: "own", sources: [] }],
      });
    });

    it("orders people by name and then by id, with a person stored without a name first and named null", async () => {
      const world = await buildWorld();
      const twin = await item(world, world.schema.db.people, { name: "Alice Novak" });
      const nameless = await item(world, world.schema.db.people, { name: "Historical" });
      // A row without a title is a historical state the item writer no longer produces: raw SQL on the admin pool.
      const stripped = await admin.query("UPDATE items SET properties = properties - 'name' WHERE id = $1", [nameless]);
      expect(stripped.rowCount).toBe(1);
      for (const person of [twin, nameless]) await link(world, world.schema.eventPeople, world.event, person);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      const people = (await detail(world)).context.people;
      expect(people.map((person) => [person.personId, person.name])).toEqual([
        [nameless, null],
        ...sorted([world.alice, twin]).map((id) => [id, "Alice Novak"]),
        [world.bob, "Bob Dvorak"],
      ]);
    });

    it("reads a relation the tenant's Transcripts database does not have yet as no value", async () => {
      const world = await buildWorld();
      await removeRelationPair(world.schema.transcriptCompany);
      await link(world, world.schema.transcriptEvent, world.transcript, world.event);

      const context = (await detail(world)).context;
      expect(context.company).toBeNull();
      expect(context.project?.id).toBe(world.web);
    });
  });

  it("creates no value while an Event card is only validated, and inherits when the card is confirmed", async () => {
    const world = await buildWorld();
    // A transcript outside every Event's time window gets a card instead of an edge.
    const transcript = await inTenant(world, () =>
      withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: world.schema.db.transcripts, properties: { name: "Late", date: "2024-06-01T08:00:00.000Z" } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      ),
    );
    const outcome = await inTenant(world, () =>
      withTransaction(pool, (client) =>
        matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 60 }),
      ),
    );
    expect(outcome).toBe("suggested");
    const cards = await inTenant(world, () =>
      pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript'", [
        world.schema.db.processingProposals,
      ]),
    );
    expect(cards.rows).toHaveLength(1);
    const cardId = cards.rows[0]?.id ?? "";
    const config = { processingProposalsDatabaseId: world.schema.db.processingProposals };

    await inTenant(world, () =>
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, config, cardId, {
          message: "It was the client meeting",
          entityKind: "relation",
          target: world.event,
          properties: { propertyKey: "event" },
        }),
      ),
    );
    expect(await related(world, world.schema.transcriptEvent, transcript.id)).toEqual([]);
    expect(await values(world, transcript.id)).toEqual({ project: [], company: [], people: [] });
    expect(await linkRows(world, transcript.id)).toEqual([]);

    await inTenant(world, () => withTransaction(pool, (client) => confirmProposalWithClient(client, config, cardId)));
    expect(await values(world, transcript.id)).toEqual({
      project: [world.web],
      company: [world.novak],
      people: sorted([world.alice, world.bob]),
    });
    expect(await linkRows(world, transcript.id)).toEqual(ALL_LINKS_ON);
  });

  it("keeps two tenants apart: each leaves out its own person, and one tenant's Event change reaches only its transcript", async () => {
    const a = await buildWorld();
    const b = await buildWorld();
    await link(a, a.schema.transcriptEvent, a.transcript, a.event);
    await link(b, b.schema.transcriptEvent, b.transcript, b.event);
    expect((await values(a)).people).toEqual(sorted([a.alice, a.bob]));
    expect((await values(b)).people).toEqual(sorted([b.alice, b.bob]));

    await unlink(a, a.schema.transcriptEvent, a.transcript, a.event);
    await inTenant(a, () => cp.softDeleteItem(a.schema.db.events, a.event, ACTING_USER_ID, USER));

    expect(await linkRows(a)).toEqual([]);
    expect(await linkRows(b)).toEqual(ALL_LINKS_ON);
    expect(await values(b)).toEqual({ project: [b.web], company: [b.novak], people: sorted([b.alice, b.bob]) });
    // Tenant A sees neither tenant B's transcript nor its links, and cannot end them.
    expect(await linkRows({ ...a, transcript: b.transcript })).toEqual([]);
    await expect(
      inTenant(a, () =>
        createTranscriptDetailRouteHandler(pool)({
          params: { id: b.transcript },
          identity: { user: { locale: "en" } },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("recomputes only the tenant's own transcripts when that tenant changes its own person", async () => {
    const a = await buildWorld();
    const b = await buildWorld();
    await link(a, a.schema.transcriptEvent, a.transcript, a.event);
    await link(b, b.schema.transcriptEvent, b.transcript, b.event);
    await settleFixture();

    await setOwnPerson(a, a.alice);

    // One job, for tenant A's Event. Tenant B's Event feeds a people link that is on as well, and is not queued.
    expect(await queuedPropagationJobs()).toBe(1);
    await runPropagation();
    expect((await values(a)).people).toEqual(sorted([a.me, a.bob]));
    expect((await values(b)).people).toEqual(sorted([b.alice, b.bob]));
  });
});
