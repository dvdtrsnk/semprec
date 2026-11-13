import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { registerItemPurgeHook, registerRelationEdgeDeleteHook } from "../../chokePoint/hooks.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../../chokePoint/itemTrash.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { NotFoundError } from "../../errors.js";
import type { ProposalEnvelope } from "../../inbox/inboxTickAction.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../../inbox/proposalActions.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionQueueAffinity, createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import { readTranscriptEventEdges, releaseTrashedEventEdges } from "../transcriptEventEdges.js";
import { matchTranscriptToEvent } from "../transcriptEventMatch.js";
import { proposeSpeakerMappings } from "../transcriptSpeakerSuggestion.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";

const RECORDING_START = "2024-03-01T12:00:00.000Z";
/** Inside the hour-long recording's window, so an Event starting then is a match candidate. */
const IN_WINDOW_START = "2024-03-01T12:10:00.000Z";
const USER: WriterIdentity = { writerKind: "user" };
const ACTING_USER_ID = "7c0e2f6a-58a1-4d0e-9d55-2f1c6f7c9b01";
/** A purge cutoff every trashed row is older than, so a trashed Event needs no backdating to be purged. */
const EVERYTHING_EXPIRED = new Date("2999-01-01T00:00:00Z");

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;

/**
 * A test's stop inside the choke point's edge removal: the edge-delete hooks run before the edge is deleted,
 * and this one runs the stop a test has set, once. The hook registry has no removal, so the hook stays
 * registered for the rest of this file and does nothing while no stop is set.
 */
let beforeEdgeRemoval: (() => Promise<void>) | undefined;
registerRelationEdgeDeleteHook(async () => {
  const stop = beforeEdgeRemoval;
  beforeEdgeRemoval = undefined;
  await stop?.();
});

/**
 * A test's stop inside the permanent purge: the item purge hooks run in the purge's transaction after the row
 * and its edges were deleted, and this one runs the stop a test has set, once, with the purge's client. Like
 * the hook above it stays registered for the rest of this file and does nothing while no stop is set.
 */
let afterItemPurged: ((client: PoolClient) => Promise<void>) | undefined;
registerItemPurgeHook(async ({ client }) => {
  const stop = afterItemPurged;
  afterItemPurged = undefined;
  await stop?.(client);
});

type DatabaseKey = "companies" | "events" | "people" | "processingProposals" | "projects" | "transcripts";

/** The database and relation property ids of one seeded tenant. */
interface Schema {
  db: Record<DatabaseKey, string>;
  eventProject: string;
  eventPeople: string;
  eventTranscript: string;
  projectCompany: string;
  transcriptEvent: string;
  transcriptProject: string;
  transcriptCompany: string;
  transcriptPeople: string;
  transcriptSpeakers: string;
}

/**
 * One tenant: the Event "client meeting" of the project Web for client (company Novak Web s.r.o.) with the
 * tenant's own person, Alice and Bob as participants, and its transcript, linked by the match step. The
 * second project and company and Carol belong to no Event yet.
 */
interface World {
  tenant: string;
  schema: Schema;
  alice: string;
  bob: string;
  carol: string;
  novak: string;
  siko: string;
  web: string;
  bathroom: string;
  event: string;
  transcript: string;
}

type Scope = Pick<World, "tenant" | "schema">;

async function seedTenant(): Promise<Scope> {
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
      eventTranscript: await property(ids.events, "transcript"),
      projectCompany: await property(ids.projects, "company"),
      transcriptEvent: await property(ids.transcripts, "event"),
      transcriptProject: await property(ids.transcripts, "project"),
      transcriptCompany: await property(ids.transcripts, "company"),
      transcriptPeople: await property(ids.transcripts, "people"),
      transcriptSpeakers: await property(ids.transcripts, "speakers"),
    };
    return { tenant, schema };
  });
}

/** Runs `fn` in the tenant, as every request and job of that tenant does. */
function inTenant<T>(scope: Pick<World, "tenant">, fn: () => Promise<T>): Promise<T> {
  return runInTenant(scope.tenant, fn);
}

async function item(scope: Scope, databaseId: string, properties: Record<string, unknown>): Promise<string> {
  return (await inTenant(scope, () => cp.createItem({ databaseId, properties }))).id;
}

/** A Transcripts row as the transcription process creates it, with the recording time as its `date`. */
async function createTranscript(scope: Scope, name: string): Promise<string> {
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

function link(scope: Scope, relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<unknown> {
  return inTenant(scope, () => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

function unlink(
  scope: Scope,
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
): Promise<unknown> {
  return inTenant(scope, () => cp.deleteRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

/** The match step of the transcription worker, in its own transaction. */
type MatchResult = Awaited<ReturnType<typeof matchTranscriptToEvent>>;

function match(scope: Scope, transcriptId: string): Promise<MatchResult> {
  return inTenant(scope, () =>
    withTransaction(pool, (client) => matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 })),
  );
}

async function buildWorld(): Promise<World> {
  const scope = await seedTenant();
  const { schema } = scope;
  const me = await item(scope, schema.db.people, { name: "Me Myself" });
  const alice = await item(scope, schema.db.people, { name: "Alice Novak" });
  const bob = await item(scope, schema.db.people, { name: "Bob Dvorak" });
  const carol = await item(scope, schema.db.people, { name: "Carol Svobodova" });
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
  expect(await match(scope, transcript)).toBe("linked");
  return { ...scope, alice, bob, carol, novak, siko, web, bathroom, event, transcript };
}

function trashEvent(world: World, eventId = world.event) {
  return inTenant(world, () => cp.softDeleteItem(world.schema.db.events, eventId, ACTING_USER_ID, USER));
}

function restoreEvent(world: World, eventId = world.event) {
  return inTenant(world, () => cp.restoreItem(world.schema.db.events, eventId, ACTING_USER_ID, USER));
}

/** A second meeting inside the recording's window, of the other project and with Carol: a match candidate. */
async function createCandidateEvent(world: World): Promise<string> {
  const eventId = await item(world, world.schema.db.events, {
    name: "follow-up meeting",
    type: "meeting",
    date: IN_WINDOW_START,
  });
  await link(world, world.schema.eventProject, eventId, world.bathroom);
  await link(world, world.schema.eventPeople, eventId, world.carol);
  return eventId;
}

/** An Event without a type and a start: never a match candidate, only a card can link it. */
function createUnmatchedEvent(world: World): Promise<string> {
  return item(world, world.schema.db.events, { name: "Planning", date: "2024-03-01" });
}

/**
 * The items the relation of `relationPropertyId` stores an edge to for `itemId`, sorted, read through the
 * runtime role inside the tenant. It includes an item that is in the Trash.
 */
async function storedEdges(world: World, relationPropertyId: string, itemId: string): Promise<string[]> {
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

/** The stored edges of the Transcripts <-> Events relation for the transcript, or for the Event `itemId`. */
function storedEventEdges(world: World, itemId = world.transcript): Promise<string[]> {
  return storedEdges(world, world.schema.transcriptEvent, itemId);
}

/** The id of the tenant's Transcripts <-> Events relation definition. */
async function eventRelationDefinitionId(world: World): Promise<string> {
  return inTenant(world, async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
      [world.schema.transcriptEvent],
    );
    if (!rows[0]) throw new Error("Missing the Transcripts event relation definition");
    return rows[0].id;
  });
}

/** The ids of every Events row of the tenant, trashed ones included, sorted. */
async function eventIds(world: World): Promise<string[]> {
  return inTenant(world, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
      world.schema.db.events,
    ]);
    return rows.map((row) => row.id);
  });
}

/** The live items a transcript's relation points to, sorted, as the relation read of the choke point returns them. */
async function related(world: World, relationPropertyId: string): Promise<string[]> {
  const edges = await inTenant(world, () => cp.listItemRelations(world.transcript, relationPropertyId));
  return (edges ?? []).map((edge) => edge.targetItemId).sort();
}

async function values(world: World) {
  return {
    project: await related(world, world.schema.transcriptProject),
    company: await related(world, world.schema.transcriptCompany),
    people: await related(world, world.schema.transcriptPeople),
  };
}

const sorted = (ids: string[]): string[] => [...ids].sort();

/** What the transcript took over from the Event "client meeting". */
const inheritedValues = (world: World) => ({
  project: [world.web],
  company: [world.novak],
  people: sorted([world.alice, world.bob]),
});

interface LinkRow {
  property_key: string;
  rule_key: string;
  state: string;
}

/** The stored value-link rows of the transcript, read through the runtime role inside the tenant. */
async function linkRows(world: World): Promise<LinkRow[]> {
  return inTenant(world, async () => {
    const { rows } = await pool.query<LinkRow>(
      "SELECT property_key, rule_key, state FROM value_links WHERE item_id = $1 ORDER BY property_key",
      [world.transcript],
    );
    return rows;
  });
}

/**
 * Runs the queued value-link propagation jobs through the registered worker task until none is left. A queue
 * that never empties fails the test instead of letting an assertion about an unchanged value pass by accident.
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

interface Card {
  id: string;
  properties: Record<string, unknown>;
}

/** Every `kind = 'transcript'` card of the tenant, trashed ones included. */
async function transcriptCards(world: World): Promise<Card[]> {
  return inTenant(world, async () => {
    const { rows } = await pool.query<Card>(
      "SELECT id, properties FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript' ORDER BY id",
      [world.schema.db.processingProposals],
    );
    return rows;
  });
}

/** The one pairing card the match step created for the tenant's transcript. */
async function pairingCard(world: World): Promise<Card> {
  const cards = await transcriptCards(world);
  const [card] = cards;
  if (cards.length !== 1 || !card) throw new Error(`Expected one transcript card, found ${cards.length}`);
  return card;
}

const proposalConfig = (world: World) => ({ processingProposalsDatabaseId: world.schema.db.processingProposals });

function confirmWithClient(client: PoolClient, world: World, cardId: string) {
  return confirmProposalWithClient(client, proposalConfig(world), cardId, undefined, ACTING_USER_ID);
}

/** `POST /api/proposals/:id/confirm` by the acting user, in its own transaction. */
function confirm(world: World, cardId: string) {
  return inTenant(world, () => withTransaction(pool, (client) => confirmWithClient(client, world, cardId)));
}

function revise(world: World, cardId: string, envelope: ProposalEnvelope) {
  return inTenant(world, () =>
    withTransaction(pool, (client) =>
      reviseProposalWithClient(client, proposalConfig(world), cardId, { message: "Revised by user.", ...envelope }),
    ),
  );
}

function linkExisting(eventId: string): ProposalEnvelope {
  return { entityKind: "relation", target: eventId, properties: { propertyKey: "event" } };
}

/**
 * Moves the transcript's Event to the Trash and runs the match again: with no other Event in the window it
 * creates the pairing card. Returns that card.
 */
async function trashEventAndSuggest(world: World): Promise<Card> {
  await trashEvent(world);
  expect(await match(world, world.transcript)).toBe("suggested");
  return pairingCard(world);
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
 * then lets both finish and returns what `second` resolved with. A failure of either, or `second` not
 * waiting, fails the caller.
 */
async function runSecondBehindFirst<T>(
  world: World,
  first: (client: PoolClient) => Promise<unknown>,
  second: () => Promise<T>,
): Promise<T> {
  const holder = holdTransaction(world, first);
  let waiting: Promise<T> | undefined;
  try {
    const holderPid = await holder.ready;
    waiting = second();
    await expectBlockedBy(holderPid);
  } finally {
    holder.release();
    await Promise.allSettled([holder.done, waiting]);
  }
  await holder.done;
  if (waiting === undefined) throw new Error("The second operation was never started");
  return waiting;
}

/**
 * Holds `first` open in its own transaction and requires `second` to finish while it is still open, then lets
 * the first finish and returns what `second` resolved with. A `second` that has not finished after ten
 * seconds is taken to wait for the first, which fails the caller.
 */
async function runSecondBesideFirst<T>(
  world: World,
  first: (client: PoolClient) => Promise<unknown>,
  second: () => Promise<T>,
): Promise<T> {
  const holder = holdTransaction(world, first);
  let running: Promise<T> | undefined;
  let finished: { value: T } | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await holder.ready;
    running = second();
    finished = await Promise.race([
      running.then((value) => ({ value })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    holder.release();
    await Promise.allSettled([holder.done, running]);
  }
  await holder.done;
  if (finished === undefined) throw new Error("The second operation waited for the first");
  return finished.value;
}

describe("a transcript whose Event is in the Trash (issue #1743)", () => {
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

  it("keeps project, company and people as own values without a value link, and a restore of the Event reconnects nothing", async () => {
    const world = await buildWorld();
    expect(await values(world)).toEqual(inheritedValues(world));
    expect((await linkRows(world)).map((row) => [row.property_key, row.state])).toEqual([
      ["company", "on"],
      ["people", "on"],
      ["project", "on"],
    ]);

    await trashEvent(world);
    expect(await values(world)).toEqual(inheritedValues(world));
    expect(await linkRows(world)).toEqual([]);
    const links = await inTenant(world, () => cp.getValueLinksForItems([world.transcript]));
    expect(links.get(world.transcript) ?? {}).toEqual({});

    const restored = await restoreEvent(world);
    expect(restored?.deletedAt).toBeNull();
    // The edge was not replaced, so it is in effect again: the transcript shows its Event and is not matched anew.
    expect(await related(world, world.schema.transcriptEvent)).toEqual([world.event]);
    expect(await match(world, world.transcript)).toBe("alreadyLinked");
    expect(await linkRows(world)).toEqual([]);

    // Later changes of the restored Event and of its project no longer reach the transcript.
    await unlink(world, world.schema.eventProject, world.event, world.web);
    await link(world, world.schema.eventProject, world.event, world.bathroom);
    await link(world, world.schema.eventPeople, world.event, world.carol);
    await unlink(world, world.schema.projectCompany, world.web, world.novak);
    await link(world, world.schema.projectCompany, world.web, world.siko);
    await runPropagation();
    expect(await values(world)).toEqual(inheritedValues(world));
    expect(await linkRows(world)).toEqual([]);
  });

  describe("the match step", () => {
    it("does not return alreadyLinked: it links the one candidate, deletes the edge to the trashed Event and keeps the own values", async () => {
      const world = await buildWorld();
      await trashEvent(world);
      const candidate = await createCandidateEvent(world);
      expect(await storedEventEdges(world)).toEqual([world.event]);

      expect(await match(world, world.transcript)).toBe("linked");

      expect(await storedEventEdges(world)).toEqual([candidate]);
      expect(await storedEventEdges(world, world.event)).toEqual([]);
      expect(await transcriptCards(world)).toEqual([]);
      // The values taken over from the trashed Event are the transcript's own: the new Event fills none of them.
      await runPropagation();
      expect(await values(world)).toEqual(inheritedValues(world));
      expect(await linkRows(world)).toEqual([]);

      // A restore of the replaced Event brings its edge back to nobody.
      expect((await restoreEvent(world))?.deletedAt).toBeNull();
      expect(await storedEventEdges(world)).toEqual([candidate]);
      expect(await storedEventEdges(world, world.event)).toEqual([]);
      expect(await related(world, world.schema.transcriptEvent)).toEqual([candidate]);
    });

    it("does not return alreadyLinked when no Event matches: it creates the pairing card and leaves the edge to the trashed Event", async () => {
      const world = await buildWorld();
      await trashEvent(world);

      expect(await match(world, world.transcript)).toBe("suggested");

      expect(await storedEventEdges(world)).toEqual([world.event]);
      const card = await pairingCard(world);
      expect(card.properties).toMatchObject({
        status: "proposed",
        proposal: { entityKind: "database", target: world.schema.db.events },
      });
      // The card is the transcript's one suggestion: a further run converges on it.
      expect(await match(world, world.transcript)).toBe("alreadySuggested");
      expect(await storedEventEdges(world)).toEqual([world.event]);
    });

    it("ends a company link that followed a project chosen by hand after the trash: the company stays as an own value", async () => {
      const world = await buildWorld();
      await trashEvent(world);
      // The user empties the company and chooses another project, so the empty company follows that project.
      await unlink(world, world.schema.transcriptCompany, world.transcript, world.novak);
      await unlink(world, world.schema.transcriptProject, world.transcript, world.web);
      await link(world, world.schema.transcriptProject, world.transcript, world.bathroom);
      expect(await linkRows(world)).toEqual([
        { property_key: "company", rule_key: "transcriptCompanyFromProject", state: "on" },
      ]);
      await createCandidateEvent(world);

      expect(await match(world, world.transcript)).toBe("linked");

      // Deleting the stale edge is a removal of the Transcripts `event` edge, so the release of issue #1697 runs.
      expect(await linkRows(world)).toEqual([]);
      expect(await values(world)).toEqual({
        project: [world.bathroom],
        company: [world.siko],
        people: sorted([world.alice, world.bob]),
      });
    });

    it("rolls the removal of the stale edge back with the transaction that linked the candidate", async () => {
      const world = await buildWorld();
      await trashEvent(world);
      const candidate = await createCandidateEvent(world);
      const failure = new Error("rollback after the match");

      await expect(
        inTenant(world, () =>
          withTransaction(pool, async (client) => {
            const outcome = await matchTranscriptToEvent(client, {
              transcriptId: world.transcript,
              durationSeconds: 3600,
            });
            expect(outcome).toBe("linked");
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);

      expect(await storedEventEdges(world)).toEqual([world.event]);
      expect(await storedEventEdges(world, candidate)).toEqual([]);
    });
  });

  describe("the confirm of a pairing card", () => {
    it("creates the Event of a create-Event card and links it without cardinality_violation; the stale edge is gone", async () => {
      const world = await buildWorld();
      const card = await trashEventAndSuggest(world);

      const confirmed = await confirm(world, card.id);

      const createdEventId = confirmed.properties.resultItemId;
      if (typeof createdEventId !== "string") throw new Error("Missing confirmed Event");
      expect(confirmed.properties.status).toBe("confirmed");
      expect(createdEventId).not.toBe(world.event);
      expect(await storedEventEdges(world)).toEqual([createdEventId]);
      expect(await storedEventEdges(world, world.event)).toEqual([]);
      expect(await values(world)).toEqual(inheritedValues(world));
      expect(await linkRows(world)).toEqual([]);
    });

    it("links the existing Event of a link-existing card without cardinality_violation, and announces the Event that lost its transcript for the confirming user", async () => {
      const world = await buildWorld();
      const card = await trashEventAndSuggest(world);
      const planning = await createUnmatchedEvent(world);
      await revise(world, card.id, linkExisting(planning));

      let confirmedStatus: unknown;
      const events = await capturingInvalidations(async () => {
        confirmedStatus = (await confirm(world, card.id)).properties.status;
      });

      expect(confirmedStatus).toBe("confirmed");
      expect(await storedEventEdges(world)).toEqual([planning]);
      expect(await storedEventEdges(world, world.event)).toEqual([]);
      // One announcement per item and relation key: the transcript's removed edge and its new one share a key, and
      // the later `put` stands for both.
      const announced = events.filter(
        (event) => event.scope === "relation" && [world.transcript, world.event].includes(event.itemId),
      );
      expect(announced).toHaveLength(2);
      expect(announced).toEqual(
        expect.arrayContaining([
          {
            scope: "relation",
            databaseId: world.schema.db.transcripts,
            itemId: world.transcript,
            propertyKey: "event",
            op: "put",
            userId: ACTING_USER_ID,
          },
          {
            scope: "relation",
            databaseId: world.schema.db.events,
            itemId: world.event,
            propertyKey: "transcript",
            op: "delete",
            userId: ACTING_USER_ID,
          },
        ]),
      );
    });

    it.each([
      ["a create-Event card", false],
      ["a link-existing card", true],
    ] as const)(
      "rolls the removal of the stale edge back with a confirm of %s that does not commit, and announces nothing",
      async (_name, linksExistingEvent) => {
        const world = await buildWorld();
        const card = await trashEventAndSuggest(world);
        if (linksExistingEvent) await revise(world, card.id, linkExisting(await createUnmatchedEvent(world)));
        const eventsBefore = await eventIds(world);
        const failure = new Error("rollback after the confirm");

        const events = await capturingInvalidations(async () => {
          await expect(
            inTenant(world, () =>
              withTransaction(pool, async (client) => {
                const confirmed = await confirmWithClient(client, world, card.id);
                expect(confirmed.properties.status).toBe("confirmed");
                throw failure;
              }),
            ),
          ).rejects.toBe(failure);
        });

        expect(events).toEqual([]);
        expect(await storedEventEdges(world)).toEqual([world.event]);
        expect((await pairingCard(world)).properties.status).toBe("proposed");
        expect(await eventIds(world)).toEqual(eventsBefore);
      },
    );

    it("goes on when the user removes the stale edge after the confirm read it: the confirm's own removal finds nothing", async () => {
      const world = await buildWorld();
      const card = await trashEventAndSuggest(world);
      const planning = await createUnmatchedEvent(world);
      await revise(world, card.id, linkExisting(planning));
      let reachRemoval!: () => void;
      const atRemoval = new Promise<void>((resolve) => {
        reachRemoval = resolve;
      });
      let proceed!: () => void;
      const released = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      beforeEdgeRemoval = async () => {
        reachRemoval();
        await released;
      };

      const confirming = confirm(world, card.id);
      let removedByUser: unknown;
      try {
        await Promise.race([
          atRemoval,
          confirming.then(() => {
            throw new Error("The confirm ended before it removed an edge");
          }),
        ]);
        removedByUser = await unlink(world, world.schema.transcriptEvent, world.transcript, world.event);
      } finally {
        beforeEdgeRemoval = undefined;
        proceed();
        await Promise.allSettled([confirming]);
      }

      // The user's removal deleted the edge, so the one of the confirm had nothing left to delete.
      expect(removedByUser).toMatchObject({ itemB: world.transcript });
      expect((await confirming).properties.status).toBe("confirmed");
      expect(await storedEventEdges(world)).toEqual([planning]);
      expect(await storedEventEdges(world, world.event)).toEqual([]);
    });

    it("still fails with cardinality_violation while the transcript's Event is not in the Trash, and removes nothing", async () => {
      const world = await buildWorld();
      const card = await trashEventAndSuggest(world);
      const planning = await createUnmatchedEvent(world);
      await revise(world, card.id, linkExisting(planning));
      expect((await restoreEvent(world))?.deletedAt).toBeNull();

      await expect(confirm(world, card.id)).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });

      expect(await storedEventEdges(world)).toEqual([world.event]);
      expect(await storedEventEdges(world, planning)).toEqual([]);
      expect((await pairingCard(world)).properties.status).toBe("proposed");
    });
  });

  describe("a speaker card", () => {
    const SEGMENTS = ["SPEAKER_01", "SPEAKER_02", "SPEAKER_03"].map((speaker, index) => ({
      speaker,
      text: `Sentence of speaker ${index + 1}`,
      startsAt: index,
      endsAt: index + 1,
    }));

    /** The people the transcript's `speakers` relation stores an edge to, a person in the Trash included. */
    const storedSpeakerIds = (world: World): Promise<string[]> =>
      storedEdges(world, world.schema.transcriptSpeakers, world.transcript);

    it("leaves the transcript's speaker edge to a person in the Trash when it links a person and when it creates one", async () => {
      const world = await buildWorld();
      // The Event goes first, so the confirms below add no participant to an Event.
      await unlink(world, world.schema.transcriptEvent, world.transcript, world.event);
      await inTenant(world, () =>
        withTransaction(pool, (client) =>
          writeComputed(client, world.schema.db.transcripts, world.transcript, "segments", SEGMENTS),
        ),
      );
      await inTenant(world, () =>
        cp.createRelation(
          {
            relationPropertyId: world.schema.transcriptSpeakers,
            callerItemId: world.transcript,
            targetItemId: world.alice,
            metadata: { speaker: "SPEAKER_01" },
          },
          USER,
        ),
      );
      await inTenant(world, () => cp.softDeleteItem(world.schema.db.people, world.alice, ACTING_USER_ID, USER));
      await inTenant(world, () =>
        withTransaction(pool, (client) =>
          proposeSpeakerMappings(client, { transcriptId: world.transcript, suggestions: [] }),
        ),
      );
      const cards = await transcriptCards(world);
      const cardOf = (speaker: string): string => {
        const found = cards.find((card) => {
          const context = card.properties.context;
          return typeof context === "object" && context !== null && "speaker" in context && context.speaker === speaker;
        });
        if (!found) throw new Error(`Missing the card of ${speaker}`);
        return found.id;
      };

      await revise(world, cardOf("SPEAKER_02"), {
        entityKind: "relation",
        target: world.bob,
        properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_02" } },
      });
      expect((await confirm(world, cardOf("SPEAKER_02"))).properties.status).toBe("confirmed");
      expect(await storedSpeakerIds(world)).toEqual(sorted([world.alice, world.bob]));

      await revise(world, cardOf("SPEAKER_03"), {
        entityKind: "database",
        target: world.schema.db.people,
        properties: { name: "Dana Mala" },
      });
      const created = (await confirm(world, cardOf("SPEAKER_03"))).properties.resultItemId;
      if (typeof created !== "string") throw new Error("Missing created person");
      expect(await storedSpeakerIds(world)).toEqual(sorted([world.alice, world.bob, created]));
    });
  });

  it("keeps answering a PUT of the edge with cardinality_violation, from either side, and leaves the stale edge", async () => {
    const world = await buildWorld();
    await trashEvent(world);
    const candidate = await createCandidateEvent(world);

    await expect(
      inTenant(world, () =>
        cp.createRelation(
          { relationPropertyId: world.schema.transcriptEvent, callerItemId: world.transcript, targetItemId: candidate },
          USER,
          ACTING_USER_ID,
        ),
      ),
    ).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });
    await expect(
      inTenant(world, () =>
        cp.createRelation(
          { relationPropertyId: world.schema.eventTranscript, callerItemId: candidate, targetItemId: world.transcript },
          USER,
          ACTING_USER_ID,
        ),
      ),
    ).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });

    expect(await storedEventEdges(world)).toEqual([world.event]);
    expect(await storedEventEdges(world, candidate)).toEqual([]);
  });

  describe("against a concurrent restore or trash of the Event", () => {
    it.each([
      [
        "the match that links another Event",
        async (world: World) => {
          const candidate = await createCandidateEvent(world);
          return {
            target: candidate,
            replace: async (client: PoolClient) => {
              const outcome = await matchTranscriptToEvent(client, {
                transcriptId: world.transcript,
                durationSeconds: 3600,
              });
              expect(outcome).toBe("linked");
            },
          };
        },
      ],
      [
        "the confirm of a pairing card",
        async (world: World) => {
          expect(await match(world, world.transcript)).toBe("suggested");
          const card = await pairingCard(world);
          const planning = await createUnmatchedEvent(world);
          await revise(world, card.id, linkExisting(planning));
          return {
            target: planning,
            replace: async (client: PoolClient) => {
              expect((await confirmWithClient(client, world, card.id)).properties.status).toBe("confirmed");
            },
          };
        },
      ],
    ] as const)(
      "%s holds the trashed Event until it commits: the restore waits and then brings no edge back",
      async (_name, prepare) => {
        const world = await buildWorld();
        await trashEvent(world);
        const { target, replace } = await prepare(world);

        const restored = await runSecondBehindFirst(world, replace, () => restoreEvent(world));

        expect(restored?.deletedAt).toBeNull();
        expect(await storedEventEdges(world)).toEqual([target]);
        expect(await storedEventEdges(world, world.event)).toEqual([]);
      },
    );

    it("a match that meets a restore in flight waits for it and then finds the Event live: alreadyLinked, nothing removed", async () => {
      const world = await buildWorld();
      await trashEvent(world);
      const candidate = await createCandidateEvent(world);

      const outcome = await runSecondBehindFirst(
        world,
        (client) =>
          restoreItemWithClient(
            client,
            world.schema.db.events,
            world.event,
            createActionQueueAffinity(),
            ACTING_USER_ID,
            USER,
          ),
        () => match(world, world.transcript),
      );

      expect(outcome).toBe("alreadyLinked");
      expect(await storedEventEdges(world)).toEqual([world.event]);
      expect(await storedEventEdges(world, candidate)).toEqual([]);
      expect(await transcriptCards(world)).toEqual([]);
    });

    it("takes no lock on a live Event: the Event is trashed while the transaction of an alreadyLinked match is still open", async () => {
      const world = await buildWorld();

      const trashed = await runSecondBesideFirst(
        world,
        async (client) => {
          const outcome = await matchTranscriptToEvent(client, {
            transcriptId: world.transcript,
            durationSeconds: 3600,
          });
          expect(outcome).toBe("alreadyLinked");
        },
        () => trashEvent(world),
      );

      expect(trashed?.deletedAt).not.toBeNull();
      expect(await storedEventEdges(world)).toEqual([world.event]);
    });

    it("reads an Event whose trash has not committed yet as live: alreadyLinked, without waiting for that trash", async () => {
      const world = await buildWorld();
      const candidate = await createCandidateEvent(world);

      const outcome = await runSecondBesideFirst(
        world,
        (client) =>
          itemDeleteWithClient(client, world.schema.db.events, world.event, {
            queueAffinity: createActionQueueAffinity(),
            actingUserId: ACTING_USER_ID,
            writer: USER,
          }),
        () => match(world, world.transcript),
      );

      expect(outcome).toBe("alreadyLinked");
      expect(await storedEventEdges(world)).toEqual([world.event]);
      expect(await storedEventEdges(world, candidate)).toEqual([]);
    });
  });

  describe("against a purge of the trashed Event", () => {
    it("a match that meets a purge in flight waits for it and then finds no Event: it links its candidate instead of answering alreadyLinked", async () => {
      const world = await buildWorld();
      await trashEvent(world);
      const candidate = await createCandidateEvent(world);
      let reachPurged!: (purgePid: number) => void;
      const purged = new Promise<number>((resolve) => {
        reachPurged = resolve;
      });
      let proceed!: () => void;
      const released = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      afterItemPurged = async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (!rows[0]) throw new Error("Missing purge pid");
        reachPurged(rows[0].pid);
        await released;
      };

      const purging = inTenant(world, () => cp.purgeExpiredTrashSubtree(world.event, EVERYTHING_EXPIRED));
      let matching: Promise<MatchResult> | undefined;
      try {
        const purgePid = await Promise.race([
          purged,
          purging.then(() => {
            throw new Error("The purge ended before it removed the Event");
          }),
        ]);
        // The Event's row and its edge are deleted and not committed: the match still reads both.
        matching = match(world, world.transcript);
        await expectBlockedBy(purgePid);
      } finally {
        afterItemPurged = undefined;
        proceed();
        await Promise.allSettled([purging, matching]);
      }

      expect((await purging).purgedItemIds).toEqual([world.event]);
      if (matching === undefined) throw new Error("The match was never started");
      expect(await matching).toBe("linked");
      expect(await eventIds(world)).toEqual([candidate]);
      expect(await storedEventEdges(world)).toEqual([candidate]);
      expect(await transcriptCards(world)).toEqual([]);
    });

    it("a match that read the Event as trashed holds it until it commits: a purge of that Event waits and then removes it with its edge", async () => {
      const world = await buildWorld();
      await trashEvent(world);

      const purge = await runSecondBehindFirst(
        world,
        async (client) => {
          const outcome = await matchTranscriptToEvent(client, {
            transcriptId: world.transcript,
            durationSeconds: 3600,
          });
          // No other Event is in the window: the match creates the card and leaves the edge to the trashed Event.
          expect(outcome).toBe("suggested");
        },
        () => inTenant(world, () => cp.purgeExpiredTrashSubtree(world.event, EVERYTHING_EXPIRED)),
      );

      expect(purge.purgedItemIds).toEqual([world.event]);
      expect(await eventIds(world)).toEqual([]);
      expect(await storedEventEdges(world)).toEqual([]);
      expect((await pairingCard(world)).properties.status).toBe("proposed");
    });

    it("counts an edge whose Event has no row any more as no link: neither live nor trashed, and the match creates the pairing card", async () => {
      const world = await buildWorld();
      await trashEvent(world);
      const definition = await eventRelationDefinitionId(world);
      // Raw SQL: the purge deletes an Event's row and its edges in one transaction, so no production write leaves
      // the edge without the row. A match reads exactly this when that purge commits between its two reads.
      await admin.query("DELETE FROM items WHERE database_id = $1 AND id = $2", [world.schema.db.events, world.event]);
      expect(await eventIds(world)).toEqual([]);
      expect(await storedEventEdges(world)).toEqual([world.event]);

      const edges = await inTenant(world, () =>
        withTransaction(pool, (client) => readTranscriptEventEdges(client, definition, world.transcript)),
      );

      expect(edges).toEqual({ liveEventIds: [], trashedEventIds: [] });
      expect(await match(world, world.transcript)).toBe("suggested");
      expect((await pairingCard(world)).properties.status).toBe("proposed");
    });
  });

  describe("between two tenants", () => {
    it("reads and removes only the own tenant's edges: the other tenant's transcript keeps its edge to its trashed Event", async () => {
      const a = await buildWorld();
      const b = await buildWorld();
      await trashEvent(a);
      await trashEvent(b);
      const candidateA = await createCandidateEvent(a);
      const candidateB = await createCandidateEvent(b);
      const definitionA = await eventRelationDefinitionId(a);
      const definitionB = await eventRelationDefinitionId(b);
      expect(definitionB).not.toBe(definitionA);

      // Each tenant stores its edge under its own relation definition. Tenant B's edge is there when tenant B
      // reads it, and the same read, with tenant B's definition and transcript, finds no row inside tenant A.
      const readIn = (scope: World, definitionId: string, transcriptId: string) =>
        inTenant(scope, () =>
          withTransaction(pool, (client) => readTranscriptEventEdges(client, definitionId, transcriptId)),
        );
      expect(await readIn(a, definitionA, a.transcript)).toEqual({ liveEventIds: [], trashedEventIds: [a.event] });
      expect(await readIn(b, definitionB, b.transcript)).toEqual({ liveEventIds: [], trashedEventIds: [b.event] });
      expect(await readIn(a, definitionB, b.transcript)).toEqual({ liveEventIds: [], trashedEventIds: [] });

      // Tenant B's relation property is answered in tenant A like an id that does not exist, so a release that
      // names it is refused before it reads an edge. Tenant B's transcript is not found there either.
      await expect(
        inTenant(a, () =>
          withTransaction(pool, (client) =>
            releaseTrashedEventEdges(client, {
              eventPropertyId: b.schema.transcriptEvent,
              transcriptId: b.transcript,
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "validation_failed" });
      await expect(match(a, b.transcript)).rejects.toBeInstanceOf(NotFoundError);
      expect(await storedEventEdges(b)).toEqual([b.event]);

      expect(await match(a, a.transcript)).toBe("linked");
      expect(await storedEventEdges(a)).toEqual([candidateA]);
      expect(await storedEventEdges(b)).toEqual([b.event]);
      expect(await storedEventEdges(b, candidateB)).toEqual([]);

      expect(await match(b, b.transcript)).toBe("linked");
      expect(await storedEventEdges(b)).toEqual([candidateB]);
      expect(await storedEventEdges(a)).toEqual([candidateA]);
    });
  });
});
