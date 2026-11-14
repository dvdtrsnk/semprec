import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import {
  createItemWithRelationsWithClient,
  type InitialItemRelation,
} from "../../chokePoint/itemCreateWithRelations.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../../chokePoint/valueLinkWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { CardinalityViolationError, ChokePointError } from "../../errors.js";
import { createInboxItemWithClient } from "../../inbox/inboxStore.js";
import {
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  type ProposalComputationResult,
} from "../../inbox/inboxTickAction.js";
import { createInboxTypeWithClient } from "../../inbox/inboxTypesStore.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../../inbox/proposalActions.js";
import { findInvalidLinkRuleReferences } from "../../manifest/driftCheck.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { ItemRow } from "../../types.js";
import { createCoreTaskList } from "../../worker.js";

const USER: WriterIdentity = { writerKind: "user" };
const SEMP: WriterIdentity = { writerKind: "agent" };
const ACTING_USER_ID = "7c0e2f6a-58a1-4d0e-9d55-2f1c6f7c9b01";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;

type DatabaseKey = "events" | "inbox" | "inboxItemTypes" | "people" | "processingProposals" | "projects" | "tasks";

/** The database and relation property ids of one seeded tenant. */
interface Schema {
  db: Record<DatabaseKey, string>;
  eventProject: string;
  eventPeople: string;
  eventActionItems: string;
  projectTasks: string;
  taskSourceEvents: string;
  taskProject: string;
  taskPeople: string;
}

/** One tenant's people and projects, and the Event "Meeting with the client". */
interface World {
  tenant: string;
  schema: Schema;
  me: string;
  alice: string;
  bob: string;
  web: string;
  bathroom: string;
  event: string;
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
      events: db("events"),
      inbox: db("inbox"),
      inboxItemTypes: db("inboxItemTypes"),
      people: db("people"),
      processingProposals: db("processingProposals"),
      projects: db("projects"),
      tasks: db("tasks"),
    };
    const schema: Schema = {
      db: ids,
      eventProject: await property(ids.events, "project"),
      eventPeople: await property(ids.events, "people"),
      eventActionItems: await property(ids.events, "actionItems"),
      projectTasks: await property(ids.projects, "tasks"),
      taskSourceEvents: await property(ids.tasks, "sourceEvents"),
      taskProject: await property(ids.tasks, "project"),
      taskPeople: await property(ids.tasks, "people"),
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
): Promise<unknown> {
  return inTenant(scope, () => cp.deleteRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

/** Replaces the single edge of a one-valued relation, as a user changing the value does. */
async function replace(
  world: World,
  relationPropertyId: string,
  callerItemId: string,
  from: string,
  to: string,
): Promise<void> {
  await unlink(world, relationPropertyId, callerItemId, from);
  await link(world, relationPropertyId, callerItemId, to);
}

/** An Event with a project and participants, as a user fills it in. */
async function createEvent(
  scope: Pick<World, "tenant" | "schema">,
  name: string,
  project: string,
  people: string[],
): Promise<string> {
  const event = await item(scope, scope.schema.db.events, { name, type: "meeting", date: "2024-03-01T12:00:00.000Z" });
  await link(scope, scope.schema.eventProject, event, project);
  for (const person of people) await link(scope, scope.schema.eventPeople, event, person);
  return event;
}

/**
 * The Event "Meeting with the client" of the project Web for client, with the tenant's own person, Alice
 * and Bob as participants. The project Bathroom renovation has no Event.
 */
async function buildWorld(): Promise<World> {
  const { tenant, schema } = await seedTenant();
  const scope = { tenant, schema };
  const me = await item(scope, schema.db.people, { name: "Me Myself" });
  const alice = await item(scope, schema.db.people, { name: "Alice Novak" });
  const bob = await item(scope, schema.db.people, { name: "Bob Dvorak" });
  await inTenant(scope, () => withTransaction(pool, (client) => setSelfPersonId(client, me)));
  const web = await item(scope, schema.db.projects, { name: "Web for client" });
  const bathroom = await item(scope, schema.db.projects, { name: "Bathroom renovation" });
  const event = await createEvent(scope, "Meeting with the client", web, [me, alice, bob]);
  return { tenant, schema, me, alice, bob, web, bathroom, event };
}

/** One entry of the item create's `relations` (issue #1590), resolved to the tenant's property. */
function relation(relationPropertyId: string, targetItemId: string): InitialItemRelation {
  return { kind: "resolved", relationPropertyId, targetItemIds: [targetItemId] };
}

/** `relations: [{ propertyKey: "sourceEvents", targetItemIds: [event] }]` of the item create. */
function fromEvent(world: World, eventId = world.event): InitialItemRelation {
  return relation(world.schema.taskSourceEvents, eventId);
}

/**
 * Creates a task as `item.create` with `relations` does for a signed-in user: one request with an
 * `Idempotency-Key`. Without `relations` it is the task of an action item of the world's Event.
 */
async function createTask(
  world: World,
  name: string,
  idempotencyKey: string,
  relations: InitialItemRelation[] = [fromEvent(world)],
): Promise<string> {
  const created = await inTenant(world, () =>
    cp.createItemWithRelations(
      { databaseId: world.schema.db.tasks, properties: { name }, idempotencyKey, relations },
      ACTING_USER_ID,
      ACTING_USER_ID,
      USER,
    ),
  );
  return created.id;
}

/** The items a relation of `itemId` points to, sorted. */
async function related(world: World, relationPropertyId: string, itemId: string): Promise<string[]> {
  const edges = await inTenant(world, () => cp.listItemRelations(itemId, relationPropertyId));
  return (edges ?? []).map((edge) => edge.targetItemId).sort();
}

async function values(world: World, taskId: string) {
  return {
    project: await related(world, world.schema.taskProject, taskId),
    people: await related(world, world.schema.taskPeople, taskId),
  };
}

async function linksOf(world: World, taskId: string) {
  return (await inTenant(world, () => cp.getValueLinksForItems([taskId]))).get(taskId) ?? {};
}

interface LinkRow {
  property_key: string;
  rule_key: string;
  state: string;
}

const LINK_ROWS_OF_ITEM =
  "SELECT property_key, rule_key, state FROM value_links WHERE item_id = $1 ORDER BY property_key";

/** The stored link rows of a task, read through the runtime role inside the tenant. */
async function linkRows(world: World, taskId: string): Promise<LinkRow[]> {
  return inTenant(world, async () => (await pool.query<LinkRow>(LINK_ROWS_OF_ITEM, [taskId])).rows);
}

const PEOPLE_LINK_ON: LinkRow = { property_key: "people", rule_key: "taskPeopleFromEvent", state: "on" };
const PROJECT_LINK_ON: LinkRow = { property_key: "project", rule_key: "taskProjectFromEvent", state: "on" };
const BOTH_LINKS_ON: LinkRow[] = [PEOPLE_LINK_ON, PROJECT_LINK_ON];

/**
 * What the tenant holds that a task create can add to: its Tasks items (the Trash included), its value-link
 * rows and its relation edges, each read through the runtime role inside the tenant.
 */
async function writtenState(world: World): Promise<{ tasks: string[]; links: number; edges: number }> {
  return inTenant(world, async () => {
    const tasks = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
      world.schema.db.tasks,
    ]);
    const links = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM value_links");
    const edges = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations");
    if (!links.rows[0] || !edges.rows[0]) throw new Error("Missing count");
    return { tasks: tasks.rows.map((row) => row.id), links: links.rows[0].count, edges: edges.rows[0].count };
  });
}

/** How many propagation jobs are queued, for any tenant. */
async function queuedPropagationJobs(): Promise<number> {
  const { rows } = await admin.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
    [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
  );
  if (!rows[0]) throw new Error("Missing job count");
  return rows[0].count;
}

/**
 * Runs the queued value-link propagation jobs through the registered worker task, in repeated passes until
 * none is left. A queue that never empties fails the test instead of letting an assertion about an unchanged
 * value pass by accident.
 */
async function runPropagation(): Promise<void> {
  const taskName = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
  const handler = createCoreTaskList(pool, createActionRegistry())[taskName];
  if (!handler) throw new Error("Propagation handler missing");
  for (let pass = 0; pass < 40; pass++) {
    await runOnce({ pgPool: pool, taskList: { [taskName]: handler } });
    if ((await queuedPropagationJobs()) === 0) return;
  }
  throw new Error("Propagation queue did not drain");
}

/**
 * A proposal card for an Inbox note through the production path: an active Inbox type that targets Tasks, an
 * Inbox item of that type and one tick whose computation answers `result`, so the card holds the envelope as
 * the tick validated and stored it.
 */
async function createTaskCard(world: World, result: ProposalComputationResult): Promise<ItemRow> {
  const { db } = world.schema;
  return inTenant(world, async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: db.inboxItemTypes,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const note = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: db.inbox,
        date: "2024-03-01",
        time: "14:00",
        text: "Send the offer after the meeting with the client",
        type: type.id,
      }),
    );
    await createSemprecTickAction(pool, async () => result)(
      {
        inboxDatabaseId: db.inbox,
        inboxItemTypesDatabaseId: db.inboxItemTypes,
        processingProposalsDatabaseId: db.processingProposals,
      },
      { heartbeatId: "hb", projectItemId: "proj", itemId: note.id },
    );
    return withTransaction(pool, async (client) => {
      const sourceInbox = await propertiesStore.getPropertyByKey(client, db.processingProposals, "sourceInbox");
      if (!sourceInbox) throw new Error("The proposals database has no sourceInbox property");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInbox.id);
      if (!definition) throw new Error("The sourceInbox property has no relation definition");
      const [edge] = await relationsStore.listRelationsForItem(client, definition.id, note.id);
      if (!edge) throw new Error("The tick stored no proposal card");
      const card = await itemsStore.getItemById(
        client,
        db.processingProposals,
        relationsStore.otherSide(edge, note.id),
      );
      if (!card) throw new Error("The proposal card is missing");
      return card;
    });
  });
}

const sorted = (ids: string[]): string[] => [...ids].sort();

/** The source list of a link that names one Event as the source of `propertyKey`. */
function eventSource(eventId: string, title: string, propertyKey: string) {
  return [{ kind: "item", itemId: eventId, databaseKey: "events", title, propertyKey }];
}

/** The ids of the items a task's link of `propertyKey` names as its sources, sorted; empty without a link. */
async function sourceIds(world: World, taskId: string, propertyKey: "people" | "project"): Promise<string[]> {
  const sources = (await linksOf(world, taskId))[propertyKey]?.sources ?? [];
  return sorted(sources.map((source) => (source.kind === "item" ? source.itemId : "")));
}

/** `POST /api/items/:id/links/:propertyKey/relink` of a signed-in user. */
function relink(world: World, taskId: string, propertyKey: "people" | "project"): Promise<unknown> {
  return inTenant(world, () => cp.relinkValue({ itemId: taskId, propertyKey }, ACTING_USER_ID));
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

/**
 * Removes the relation whose inverse side is the Tasks property `propertyId`, both properties and the
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

describe("a task from an Event's action item inherits the Event's project and people (issue #1724)", () => {
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

  it("declares the two rules, with the own-person filter on the people rule, valid against the seeded schema", async () => {
    const registry = await loadFullModuleRegistry();
    expect(() => registry.validateLinkRules()).not.toThrow();
    const rules = (await registry.getLinkRules()).filter(
      (rule) => rule.moduleId === "systemDatabases" && rule.key.startsWith("task"),
    );
    expect(rules).toEqual([
      {
        moduleId: "systemDatabases",
        key: "taskProjectFromEvent",
        source: { databaseKey: "events", propertyKey: "project" },
        target: { databaseKey: "tasks", propertyKey: "project" },
        via: { databaseKey: "tasks", relationKey: "sourceEvents" },
      },
      {
        moduleId: "systemDatabases",
        key: "taskPeopleFromEvent",
        source: { databaseKey: "events", propertyKey: "people" },
        target: { databaseKey: "tasks", propertyKey: "people" },
        via: { databaseKey: "tasks", relationKey: "sourceEvents" },
        valueFilter: { omit: { databaseKey: "systemSettings", propertyKey: "selfPerson" } },
      },
    ]);
    const scope = await seedTenant();
    const findings = await inTenant(scope, () =>
      withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry)),
    );
    expect(findings).toEqual([]);
  });

  describe("a task created with a sourceEvents relation", () => {
    it("has the Event's project and its participants without the tenant's own person, all inherited with the Event as source", async () => {
      const world = await buildWorld();

      const task = await createTask(world, "Send the offer", "action-item-1");

      expect(await related(world, world.schema.taskSourceEvents, task)).toEqual([world.event]);
      expect(await values(world, task)).toEqual({ project: [world.web], people: sorted([world.alice, world.bob]) });
      expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
      const links = await linksOf(world, task);
      expect(links.project).toEqual({
        valueKind: "inherited",
        sources: eventSource(world.event, "Meeting with the client", "project"),
        brokenBy: null,
        brokenAt: null,
      });
      expect(links.people).toEqual({
        valueKind: "inherited",
        sources: eventSource(world.event, "Meeting with the client", "people"),
        brokenBy: null,
        brokenAt: null,
      });
    });

    it("is written with its values and links in one transaction: they exist before the commit and roll back with the task", async () => {
      const world = await buildWorld();
      const before = await writtenState(world);
      expect(before.tasks).toEqual([]);
      const failure = new Error("fixture rollback");

      await expect(
        inTenant(world, () =>
          withTransaction(pool, async (client) => {
            const created = await createItemWithRelationsWithClient(
              client,
              {
                databaseId: world.schema.db.tasks,
                properties: { name: "Send the offer" },
                idempotencyKey: "action-item-rolled-back",
                relations: [fromEvent(world)],
              },
              { writer: USER, actingUserId: ACTING_USER_ID, humanWriterUserId: ACTING_USER_ID },
            );
            // Before the commit, on the writer's own connection: the task, both links and their values exist.
            expect((await client.query<LinkRow>(LINK_ROWS_OF_ITEM, [created.id])).rows).toEqual(BOTH_LINKS_ON);
            const edges = await client.query<{ item: string }>(
              `SELECT CASE WHEN item_a = $1 THEN item_b ELSE item_a END AS item FROM item_relations
               WHERE item_a = $1 OR item_b = $1`,
              [created.id],
            );
            expect(edges.rows.map((row) => row.item).sort()).toEqual(
              sorted([world.event, world.web, world.alice, world.bob]),
            );
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);

      expect(await writtenState(world)).toEqual(before);
    });

    it("leaves no task, value or link when a later relation of the same request is refused", async () => {
      const world = await buildWorld();
      const before = await writtenState(world);

      // The project is inherited when the source edge is written, so a project named after it is a second
      // value of the one-valued `Tasks.project`.
      const refused = createTask(world, "Send the offer", "action-item-refused", [
        fromEvent(world),
        relation(world.schema.taskProject, world.bathroom),
      ]);

      await expect(refused).rejects.toBeInstanceOf(CardinalityViolationError);
      await expect(refused).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });
      expect(await writtenState(world)).toEqual(before);
    });

    it("takes a project named after the source event when the Event has none, as a user change of the link just created", async () => {
      const world = await buildWorld();
      await unlink(world, world.schema.eventProject, world.event, world.web);
      await runPropagation();

      // The source edge links the empty project to the Event, and the project named next ends that link.
      const task = await createTask(world, "Order the tiles", "action-item-own-project", [
        fromEvent(world),
        relation(world.schema.taskProject, world.bathroom),
      ]);

      expect(await values(world, task)).toEqual({
        project: [world.bathroom],
        people: sorted([world.alice, world.bob]),
      });
      expect(await linkRows(world, task)).toEqual([PEOPLE_LINK_ON, { ...PROJECT_LINK_ON, state: "broken" }]);
      expect((await linksOf(world, task)).project).toMatchObject({
        valueKind: "inheritedBroken",
        sources: eventSource(world.event, "Meeting with the client", "project"),
        brokenBy: "user",
      });
    });

    it("creates no second task and writes nothing more when the same Idempotency-Key is sent again", async () => {
      const world = await buildWorld();
      const first = await createTask(world, "Send the offer", "action-item-1");
      const committed = await writtenState(world);
      expect(committed.tasks).toEqual([first]);

      const replayed = await createTask(world, "Send the offer", "action-item-1");

      expect(replayed).toBe(first);
      expect(await writtenState(world)).toEqual(committed);
      expect(await values(world, first)).toEqual({ project: [world.web], people: sorted([world.alice, world.bob]) });
      expect(await linkRows(world, first)).toEqual(BOTH_LINKS_ON);
    });

    it("does not link the task to the Event again when the request is replayed after the user removed the source edge", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "action-item-1");
      await unlink(world, world.schema.taskSourceEvents, task, world.event);
      expect(await linkRows(world, task)).toEqual([]);

      expect(await createTask(world, "Send the offer", "action-item-1")).toBe(task);

      expect(await related(world, world.schema.taskSourceEvents, task)).toEqual([]);
      expect(await linkRows(world, task)).toEqual([]);
    });

    it("inherits the same when the Event's side of the relation, actionItems, links an existing task", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "plain-task", []);
      expect(await linkRows(world, task)).toEqual([]);

      await link(world, world.schema.eventActionItems, world.event, task);

      expect(await related(world, world.schema.taskSourceEvents, task)).toEqual([world.event]);
      expect(await values(world, task)).toEqual({ project: [world.web], people: sorted([world.alice, world.bob]) });
      expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
      expect((await linksOf(world, task)).project?.sources).toEqual(
        eventSource(world.event, "Meeting with the client", "project"),
      );
    });
  });

  describe("a value the task had before the source edge", () => {
    it("is kept without a link when the project is named before the source event in the same request, and the people are still inherited", async () => {
      const world = await buildWorld();

      const task = await createTask(world, "Order the tiles", "action-item-own-project", [
        relation(world.schema.taskProject, world.bathroom),
        fromEvent(world),
      ]);

      expect(await values(world, task)).toEqual({
        project: [world.bathroom],
        people: sorted([world.alice, world.bob]),
      });
      expect(await linkRows(world, task)).toEqual([PEOPLE_LINK_ON]);
      expect((await linksOf(world, task)).project).toBeUndefined();

      // The own project does not follow the Event; the inherited people do.
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const garden = await item(world, world.schema.db.projects, { name: "Garden" });
      await replace(world, world.schema.eventProject, world.event, world.web, garden);
      await link(world, world.schema.eventPeople, world.event, carol);
      await runPropagation();
      expect(await values(world, task)).toEqual({
        project: [world.bathroom],
        people: sorted([world.alice, world.bob, carol]),
      });
    });

    it("is kept without a link when an existing task with people of its own becomes an action item, and the project is still inherited", async () => {
      const world = await buildWorld();
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const task = await createTask(world, "Call Carol", "plain-task", [relation(world.schema.taskPeople, carol)]);

      await link(world, world.schema.taskSourceEvents, task, world.event);

      expect(await values(world, task)).toEqual({ project: [world.web], people: [carol] });
      expect(await linkRows(world, task)).toEqual([PROJECT_LINK_ON]);
      expect((await linksOf(world, task)).people).toBeUndefined();
    });
  });

  describe("while the task follows its Event", () => {
    it("takes the Event's new project through the propagation job, except a task whose project the user changed by hand", async () => {
      const world = await buildWorld();
      const first = await createTask(world, "Send the offer", "action-item-1");
      const second = await createTask(world, "Prepare the contract", "action-item-2");
      const changedOnTask = await createTask(world, "Book the room", "action-item-3");
      const changedOnProject = await createTask(world, "Order the tiles", "action-item-4");
      const garden = await item(world, world.schema.db.projects, { name: "Garden" });
      // By hand, once from the task (`Tasks.project`) and once from the project (`Projects.tasks`, its inverse).
      await replace(world, world.schema.taskProject, changedOnTask, world.web, world.bathroom);
      await unlink(world, world.schema.projectTasks, world.web, changedOnProject);
      await link(world, world.schema.projectTasks, world.bathroom, changedOnProject);
      for (const task of [changedOnTask, changedOnProject]) {
        const broken = (await linksOf(world, task)).project;
        expect(broken?.valueKind).toBe("inheritedBroken");
        expect(broken?.brokenBy).toBe("user");
      }

      await replace(world, world.schema.eventProject, world.event, world.web, garden);
      // The source edge change only queues the propagation; no task changes until the job runs.
      expect((await values(world, first)).project).toEqual([world.web]);
      await runPropagation();

      for (const task of [first, second]) {
        expect((await values(world, task)).project).toEqual([garden]);
        expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
        expect((await linksOf(world, task)).project?.sources).toEqual(
          eventSource(world.event, "Meeting with the client", "project"),
        );
      }
      for (const task of [changedOnTask, changedOnProject]) {
        expect((await values(world, task)).project).toEqual([world.bathroom]);
        expect(await linkRows(world, task)).toEqual([PEOPLE_LINK_ON, { ...PROJECT_LINK_ON, state: "broken" }]);
      }
    });

    it("takes a participant added to the Event and loses one removed from it, still without the own person", async () => {
      const world = await buildWorld();
      const first = await createTask(world, "Send the offer", "action-item-1");
      const second = await createTask(world, "Prepare the contract", "action-item-2");
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });

      await link(world, world.schema.eventPeople, world.event, carol);
      await unlink(world, world.schema.eventPeople, world.event, world.alice);
      expect((await values(world, first)).people).toEqual(sorted([world.alice, world.bob]));
      await runPropagation();

      for (const task of [first, second]) {
        expect((await values(world, task)).people).toEqual(sorted([world.bob, carol]));
        expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
      }
    });

    it("stops following the Event's participants once Semp changed the task's people, and still follows its project", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "action-item-1");
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const dave = await item(world, world.schema.db.people, { name: "Dave Kral" });

      await link(world, world.schema.taskPeople, task, carol, SEMP);
      const broken = (await linksOf(world, task)).people;
      expect(broken?.valueKind).toBe("inheritedBroken");
      expect(broken?.brokenBy).toBe("agent");

      await link(world, world.schema.eventPeople, world.event, dave);
      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      await runPropagation();

      expect(await values(world, task)).toEqual({
        project: [world.bathroom],
        people: sorted([world.alice, world.bob, carol]),
      });
      expect(await linkRows(world, task)).toEqual([{ ...PEOPLE_LINK_ON, state: "broken" }, PROJECT_LINK_ON]);
    });

    it("loses a participant once the tenant chooses that person as its own, and gets the previous own person back", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "action-item-1");
      await runPropagation();
      expect((await values(world, task)).people).toEqual(sorted([world.alice, world.bob]));

      await inTenant(world, () =>
        withTransaction(pool, (client) => setSelfPersonId(client, world.alice, USER, ACTING_USER_ID)),
      );
      // The choice only queues the recomputation; the task is unchanged until the job runs.
      expect((await values(world, task)).people).toEqual(sorted([world.alice, world.bob]));
      await runPropagation();

      expect((await values(world, task)).people).toEqual(sorted([world.me, world.bob]));
      expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
    });

    it("unites the participants of a second source Event and keeps the one project it already has", async () => {
      const world = await buildWorld();
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const followUp = await createEvent(world, "Follow-up call", world.bathroom, [world.me, world.bob, carol]);
      const task = await createTask(world, "Send the offer", "action-item-1");

      await link(world, world.schema.taskSourceEvents, task, followUp);

      expect(await related(world, world.schema.taskSourceEvents, task)).toEqual(sorted([world.event, followUp]));
      // `Tasks.project` holds one value, so the two Events' different projects do not replace the first.
      expect(await values(world, task)).toEqual({
        project: [world.web],
        people: sorted([world.alice, world.bob, carol]),
      });
      expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
      expect(await sourceIds(world, task, "people")).toEqual(sorted([world.event, followUp]));
      expect(await sourceIds(world, task, "project")).toEqual(sorted([world.event, followUp]));
    });
  });

  describe("when the source edge is removed", () => {
    const removals: Array<[side: string, remove: (world: World, task: string) => Promise<unknown>]> = [
      ["the task's sourceEvents", (world, task) => unlink(world, world.schema.taskSourceEvents, task, world.event)],
      ["the Event's actionItems", (world, task) => unlink(world, world.schema.eventActionItems, world.event, task)],
    ];

    it.each(removals)(
      "through %s, the task keeps the project and the people as its own values and no longer follows the Event",
      async (_side, remove) => {
        const world = await buildWorld();
        const task = await createTask(world, "Send the offer", "action-item-1");
        const inherited = { project: [world.web], people: sorted([world.alice, world.bob]) };
        expect(await values(world, task)).toEqual(inherited);

        await remove(world, task);

        expect(await related(world, world.schema.taskSourceEvents, task)).toEqual([]);
        expect(await values(world, task)).toEqual(inherited);
        expect(await linkRows(world, task)).toEqual([]);
        expect(await linksOf(world, task)).toEqual({});

        const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
        await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
        await link(world, world.schema.eventPeople, world.event, carol);
        await runPropagation();
        expect(await values(world, task)).toEqual(inherited);
      },
    );

    const REFUSED_RELINK = { status: 409, code: "value_link_conflict" };

    it.each(removals)(
      "through %s, also ends a project link the user had changed and a people link Semp had changed, so a relink is refused",
      async (_side, remove) => {
        const world = await buildWorld();
        const task = await createTask(world, "Send the offer", "action-item-1");
        const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
        await replace(world, world.schema.taskProject, task, world.web, world.bathroom);
        await link(world, world.schema.taskPeople, task, carol, SEMP);
        // Both links are ended and still name the Event: removing an edge of another relation detaches nothing.
        const ended = await linksOf(world, task);
        expect(ended.project).toMatchObject({
          valueKind: "inheritedBroken",
          sources: eventSource(world.event, "Meeting with the client", "project"),
          brokenBy: "user",
        });
        expect(ended.people).toMatchObject({
          valueKind: "inheritedBroken",
          sources: eventSource(world.event, "Meeting with the client", "people"),
          brokenBy: "agent",
        });
        const own = { project: [world.bathroom], people: sorted([world.alice, world.bob, carol]) };

        const events = await capturingInvalidations(() => remove(world, task));

        expect(await related(world, world.schema.taskSourceEvents, task)).toEqual([]);
        expect(await values(world, task)).toEqual(own);
        expect(await linkRows(world, task)).toEqual([]);
        expect(await linksOf(world, task)).toEqual({});
        expect(itemUpdatesOf(events, task)).toHaveLength(1);
        await expect(relink(world, task, "project")).rejects.toMatchObject(REFUSED_RELINK);
        await expect(relink(world, task, "people")).rejects.toMatchObject(REFUSED_RELINK);

        // The refused relinks wrote nothing, and a later change of the Event reaches nothing.
        const dave = await item(world, world.schema.db.people, { name: "Dave Kral" });
        const garden = await item(world, world.schema.db.projects, { name: "Garden" });
        await replace(world, world.schema.eventProject, world.event, world.web, garden);
        await link(world, world.schema.eventPeople, world.event, dave);
        await runPropagation();
        expect(await values(world, task)).toEqual(own);
        expect(await linkRows(world, task)).toEqual([]);
      },
    );

    it("also ends a link the user ended without changing the value", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "action-item-1");
      await inTenant(world, () => cp.unlinkValue({ itemId: task, propertyKey: "project" }, "user", ACTING_USER_ID));
      expect(await linkRows(world, task)).toEqual([PEOPLE_LINK_ON, { ...PROJECT_LINK_ON, state: "broken" }]);

      await unlink(world, world.schema.taskSourceEvents, task, world.event);

      expect(await values(world, task)).toEqual({ project: [world.web], people: sorted([world.alice, world.bob]) });
      expect(await linkRows(world, task)).toEqual([]);
      await expect(relink(world, task, "project")).rejects.toMatchObject(REFUSED_RELINK);
    });

    it("publishes no item update for a task whose links were both on, so the engine alone deleted them", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "action-item-1");

      const events = await capturingInvalidations(() =>
        unlink(world, world.schema.taskSourceEvents, task, world.event),
      );

      expect(await linkRows(world, task)).toEqual([]);
      expect(itemUpdatesOf(events, task)).toEqual([]);
    });

    it("keeps an ended link that another source Event still feeds, naming that Event only, until its edge goes too", async () => {
      const world = await buildWorld();
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const followUp = await createEvent(world, "Follow-up call", world.bathroom, [world.me, world.bob, carol]);
      const task = await createTask(world, "Send the offer", "action-item-1");
      await link(world, world.schema.taskSourceEvents, task, followUp);
      const garden = await item(world, world.schema.db.projects, { name: "Garden" });
      await replace(world, world.schema.taskProject, task, world.web, garden);
      await unlink(world, world.schema.taskPeople, task, carol);
      const bothEnded = [
        { ...PEOPLE_LINK_ON, state: "broken" },
        { ...PROJECT_LINK_ON, state: "broken" },
      ];
      expect(await linkRows(world, task)).toEqual(bothEnded);
      expect(await sourceIds(world, task, "project")).toEqual(sorted([world.event, followUp]));
      expect(await sourceIds(world, task, "people")).toEqual(sorted([world.event, followUp]));

      const events = await capturingInvalidations(() =>
        unlink(world, world.schema.eventActionItems, world.event, task),
      );

      expect(await linkRows(world, task)).toEqual(bothEnded);
      expect(await sourceIds(world, task, "project")).toEqual([followUp]);
      expect(await sourceIds(world, task, "people")).toEqual([followUp]);
      expect(await values(world, task)).toEqual({ project: [garden], people: sorted([world.alice, world.bob]) });
      expect(itemUpdatesOf(events, task)).toHaveLength(1);

      // A relink takes the values of the Event the task still has an edge to, and of no other.
      await relink(world, task, "project");
      await relink(world, task, "people");
      expect(await values(world, task)).toEqual({ project: [world.bathroom], people: sorted([world.bob, carol]) });
      expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);

      await unlink(world, world.schema.taskPeople, task, carol);
      await unlink(world, world.schema.taskSourceEvents, task, followUp);
      expect(await linkRows(world, task)).toEqual([]);
      expect(await values(world, task)).toEqual({ project: [world.bathroom], people: [world.bob] });
    });

    it("leaves an ended link alone when the removed Event is not among its sources", async () => {
      const world = await buildWorld();
      const followUp = await createEvent(world, "Follow-up call", world.bathroom, [world.me, world.bob]);
      const task = await createTask(world, "Send the offer", "action-item-1");
      const garden = await item(world, world.schema.db.projects, { name: "Garden" });
      await replace(world, world.schema.taskProject, task, world.web, garden);
      // An ended link takes no new source from the engine, so the second Event feeds the people link only.
      await link(world, world.schema.taskSourceEvents, task, followUp);
      expect(await sourceIds(world, task, "project")).toEqual([world.event]);
      expect(await sourceIds(world, task, "people")).toEqual(sorted([world.event, followUp]));

      const events = await capturingInvalidations(() => unlink(world, world.schema.taskSourceEvents, task, followUp));

      expect(await linkRows(world, task)).toEqual([PEOPLE_LINK_ON, { ...PROJECT_LINK_ON, state: "broken" }]);
      expect(await sourceIds(world, task, "project")).toEqual([world.event]);
      expect(await sourceIds(world, task, "people")).toEqual([world.event]);
      expect(await values(world, task)).toEqual({ project: [garden], people: sorted([world.alice, world.bob]) });
      expect(itemUpdatesOf(events, task)).toEqual([]);
    });

    it("leaves a link that is on to the engine, which takes back the participants only the removed Event gave", async () => {
      const world = await buildWorld();
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const followUp = await createEvent(world, "Follow-up call", world.web, [world.me, world.bob, carol]);
      const task = await createTask(world, "Send the offer", "action-item-1");
      await link(world, world.schema.taskSourceEvents, task, followUp);
      expect((await values(world, task)).people).toEqual(sorted([world.alice, world.bob, carol]));

      await unlink(world, world.schema.taskSourceEvents, task, followUp);

      // The engine's hook ran before the detach: it found the Event among the sources and recomputed the people.
      expect(await values(world, task)).toEqual({ project: [world.web], people: sorted([world.alice, world.bob]) });
      expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
      expect(await sourceIds(world, task, "people")).toEqual([world.event]);
      expect(await sourceIds(world, task, "project")).toEqual([world.event]);
    });

    it("takes the people of an Event linked after the removal into people the user had emptied", async () => {
      const world = await buildWorld();
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      const followUp = await createEvent(world, "Follow-up call", world.bathroom, [world.me, carol]);
      const task = await createTask(world, "Send the offer", "action-item-1");
      for (const person of [world.alice, world.bob]) await unlink(world, world.schema.taskPeople, task, person);
      await unlink(world, world.schema.taskSourceEvents, task, world.event);

      await link(world, world.schema.taskSourceEvents, task, followUp);

      // The ended link went with the first Event, so the empty people are an empty own value again.
      expect((await values(world, task)).people).toEqual([carol]);
      expect(await sourceIds(world, task, "people")).toEqual([followUp]);
      // The project the first Event gave stays as the task's own value.
      expect((await values(world, task)).project).toEqual([world.web]);
      expect(await linkRows(world, task)).toEqual([PEOPLE_LINK_ON]);
    });

    it("also detaches the Event from the links of a task in the Trash, so the restored task does not follow it", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "action-item-1");
      await inTenant(world, () => cp.softDeleteItem(world.schema.db.tasks, task, ACTING_USER_ID, USER));
      // The Trash keeps the task's edges and links.
      expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);

      const events = await capturingInvalidations(() =>
        unlink(world, world.schema.eventActionItems, world.event, task),
      );

      expect(await linkRows(world, task)).toEqual([]);
      // A task in the Trash is not announced.
      expect(itemUpdatesOf(events, task)).toEqual([]);

      await inTenant(world, () => cp.restoreItem(world.schema.db.tasks, task, ACTING_USER_ID, USER));
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      await link(world, world.schema.eventPeople, world.event, carol);
      await runPropagation();
      expect(await related(world, world.schema.taskSourceEvents, task)).toEqual([]);
      expect(await values(world, task)).toEqual({ project: [world.web], people: sorted([world.alice, world.bob]) });
      expect(await linkRows(world, task)).toEqual([]);
    });

    it("reads from the relation definition which item of the edge is the task", async () => {
      const world = await buildWorld();
      // Every tenant has the pair as the seed declares it, from `Events.actionItems`, so the Event is the first
      // item of each edge. No API or migration turns the definition around; raw SQL on the admin pool does it
      // here, before any edge exists, to show that the hook takes the side from the definition.
      const turned = await admin.query(
        `UPDATE relation_definitions SET property_id_a = property_id_b, property_id_b = property_id_a
         WHERE property_id_b = $1`,
        [world.schema.taskSourceEvents],
      );
      expect(turned.rowCount).toBe(1);
      const task = await createTask(world, "Send the offer", "action-item-1");
      expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
      await replace(world, world.schema.taskProject, task, world.web, world.bathroom);

      await unlink(world, world.schema.taskSourceEvents, task, world.event);

      expect(await linkRows(world, task)).toEqual([]);
      expect(await values(world, task)).toEqual({
        project: [world.bathroom],
        people: sorted([world.alice, world.bob]),
      });
    });

    it("leaves the links as they were and announces nothing when the removal rolls back", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "action-item-1");
      await replace(world, world.schema.taskProject, task, world.web, world.bathroom);
      const failure = new Error("fixture rollback");

      const events = await capturingInvalidations(() =>
        expect(
          inTenant(world, () =>
            withTransaction(pool, async (client) => {
              await deleteRelationWithClient(
                client,
                { relationPropertyId: world.schema.taskSourceEvents, callerItemId: task, targetItemId: world.event },
                undefined,
                USER,
              );
              // Before the commit, on the writer's own connection: both links are gone.
              expect((await client.query<LinkRow>(LINK_ROWS_OF_ITEM, [task])).rows).toEqual([]);
              throw failure;
            }),
          ),
        ).rejects.toBe(failure),
      );

      expect(itemUpdatesOf(events, task)).toEqual([]);
      expect(await related(world, world.schema.taskSourceEvents, task)).toEqual([world.event]);
      expect(await linkRows(world, task)).toEqual([PEOPLE_LINK_ON, { ...PROJECT_LINK_ON, state: "broken" }]);
      expect(await sourceIds(world, task, "project")).toEqual([world.event]);
    });
  });

  describe("the removal of an edge in a tenant without the Tasks sourceEvents relation", () => {
    it("lets an edge of another relation be removed in a tenant that was never seeded", async () => {
      const tenant = await createTestTenant(admin);
      await runInTenant(tenant, async () => {
        const database = await cp.createDatabase({ name: "Notes" });
        await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
        const { property } = await cp.createRelationProperty({
          sourceDatabaseId: database.id,
          key: "related",
          name: "Related",
          targetDatabaseId: database.id,
          cardinality: "many_to_many",
        });
        const first = await cp.createItem({ databaseId: database.id, properties: { name: "First" } });
        const second = await cp.createItem({ databaseId: database.id, properties: { name: "Second" } });
        const edge = { relationPropertyId: property.id, callerItemId: first.id, targetItemId: second.id };
        await cp.createRelation(edge, USER);

        expect(await cp.deleteRelation(edge, USER)).not.toBeNull();
        expect(await cp.listItemRelations(first.id, property.id)).toEqual([]);
      });
    });

    it("lets a task's project be removed in a tenant whose Tasks database has no sourceEvents relation", async () => {
      const world = await buildWorld();
      await removeRelationPair(world.schema.taskSourceEvents);
      const task = await createTask(world, "Order the tiles", "own-values-task", [
        relation(world.schema.taskProject, world.web),
      ]);

      await unlink(world, world.schema.taskProject, task, world.web);

      expect(await values(world, task)).toEqual({ project: [], people: [] });
      expect(await linkRows(world, task)).toEqual([]);
    });
  });

  describe("a task created without a source event", () => {
    it("has no project, no people and no link, and the Event's later changes reach only the action item beside it", async () => {
      const world = await buildWorld();
      const actionItem = await createTask(world, "Send the offer", "action-item-1");

      const plain = await createTask(world, "Buy milk", "plain-task", []);

      expect(await related(world, world.schema.taskSourceEvents, plain)).toEqual([]);
      expect(await values(world, plain)).toEqual({ project: [], people: [] });
      expect(await linkRows(world, plain)).toEqual([]);
      expect(await linksOf(world, plain)).toEqual({});
      expect(await linkRows(world, actionItem)).toEqual(BOTH_LINKS_ON);

      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      await link(world, world.schema.eventPeople, world.event, carol);
      await runPropagation();
      expect(await values(world, actionItem)).toEqual({
        project: [world.bathroom],
        people: sorted([world.alice, world.bob, carol]),
      });
      expect(await values(world, plain)).toEqual({ project: [], people: [] });
      expect(await linkRows(world, plain)).toEqual([]);
    });

    it("keeps the project and the people of its own request as own values without a link, and does not follow the Event", async () => {
      const world = await buildWorld();
      const actionItem = await createTask(world, "Send the offer", "action-item-1");

      const own = await createTask(world, "Order the tiles", "own-values-task", [
        relation(world.schema.taskProject, world.web),
        relation(world.schema.taskPeople, world.alice),
      ]);

      expect(await values(world, own)).toEqual({ project: [world.web], people: [world.alice] });
      expect(await linkRows(world, own)).toEqual([]);
      expect(await linksOf(world, own)).toEqual({});

      // The same project and person as the Event's, but nothing links them to it.
      await replace(world, world.schema.eventProject, world.event, world.web, world.bathroom);
      await unlink(world, world.schema.eventPeople, world.event, world.alice);
      await runPropagation();
      expect(await values(world, actionItem)).toEqual({ project: [world.bathroom], people: [world.bob] });
      expect(await values(world, own)).toEqual({ project: [world.web], people: [world.alice] });
    });
  });

  describe("the handoff of Tasks.project and Tasks.people to the valueLinks process", () => {
    const AS_VALUE_LINKS = { ownerProcess: VALUE_LINKS_OWNER_PROCESS };
    const REFUSED = { status: 403, code: "owner_violation" };

    it("refuses the process on the project and the people of a task that no source event links", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Order the tiles", "own-values-task", [
        relation(world.schema.taskProject, world.web),
        relation(world.schema.taskPeople, world.alice),
      ]);

      await expect(
        inTenant(world, () =>
          withTransaction(pool, (client) =>
            deleteRelationWithClient(
              client,
              { relationPropertyId: world.schema.taskProject, callerItemId: task, targetItemId: world.web },
              AS_VALUE_LINKS,
            ),
          ),
        ),
      ).rejects.toMatchObject(REFUSED);
      await expect(
        inTenant(world, () =>
          withTransaction(pool, (client) =>
            createRelationWithClient(
              client,
              { relationPropertyId: world.schema.taskPeople, callerItemId: task, targetItemId: world.bob },
              AS_VALUE_LINKS,
            ),
          ),
        ),
      ).rejects.toMatchObject(REFUSED);

      expect(await values(world, task)).toEqual({ project: [world.web], people: [world.alice] });
      expect(await linkRows(world, task)).toEqual([]);
    });

    it("refuses the process on a project whose link the user ended, and still admits it on the people that follow the Event", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Send the offer", "action-item-1");
      const carol = await item(world, world.schema.db.people, { name: "Carol Svobodova" });
      await replace(world, world.schema.taskProject, task, world.web, world.bathroom);

      await expect(
        inTenant(world, () =>
          withTransaction(pool, (client) =>
            deleteRelationWithClient(
              client,
              { relationPropertyId: world.schema.taskProject, callerItemId: task, targetItemId: world.bathroom },
              AS_VALUE_LINKS,
            ),
          ),
        ),
      ).rejects.toMatchObject(REFUSED);
      await inTenant(world, () =>
        withTransaction(pool, (client) =>
          createRelationWithClient(
            client,
            { relationPropertyId: world.schema.taskPeople, callerItemId: task, targetItemId: carol },
            AS_VALUE_LINKS,
          ),
        ),
      );

      expect(await values(world, task)).toEqual({
        project: [world.bathroom],
        people: sorted([world.alice, world.bob, carol]),
      });
      // A system write ends no link: the people still follow the Event.
      expect(await linkRows(world, task)).toEqual([PEOPLE_LINK_ON, { ...PROJECT_LINK_ON, state: "broken" }]);
    });
  });

  it("creates no value while an action-item proposal is only validated, by the Inbox tick and by a revision, and inherits when the card is confirmed", async () => {
    const world = await buildWorld();
    await runPropagation();
    expect(await writtenState(world)).toMatchObject({ tasks: [], links: 0 });
    const config = { processingProposalsDatabaseId: world.schema.db.processingProposals };
    /** What a validation must leave untouched: no task, no link, no action-item edge and no propagation job. */
    const expectNothingInherited = async (): Promise<void> => {
      expect(await writtenState(world)).toMatchObject({ tasks: [], links: 0 });
      expect(await related(world, world.schema.eventActionItems, world.event)).toEqual([]);
      expect(await queuedPropagationJobs()).toBe(0);
    };

    const card = await createTaskCard(world, {
      properties: { name: "Send the offer" },
      relations: { sourceEvents: [world.event] },
    });

    // The card holds the action item with its source Event as the tick validated it.
    expect(parseStoredProposalEnvelope(card.properties.proposal, card.id)).toMatchObject({
      entityKind: "database",
      target: world.schema.db.tasks,
      relations: { sourceEvents: [world.event] },
    });
    await expectNothingInherited();

    await inTenant(world, () =>
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, config, card.id, {
          message: "Send it to the client",
          entityKind: "database",
          target: world.schema.db.tasks,
          properties: { name: "Send the offer to the client" },
          relations: { sourceEvents: [world.event] },
        }),
      ),
    );
    await expectNothingInherited();

    const confirmed = await inTenant(world, () =>
      withTransaction(pool, (client) => confirmProposalWithClient(client, config, card.id, undefined, ACTING_USER_ID)),
    );

    const task = confirmed.properties.resultItemId;
    if (typeof task !== "string") throw new Error("The confirmed card names no result item");
    expect((await writtenState(world)).tasks).toEqual([task]);
    expect(await related(world, world.schema.taskSourceEvents, task)).toEqual([world.event]);
    expect(await values(world, task)).toEqual({ project: [world.web], people: sorted([world.alice, world.bob]) });
    expect(await linkRows(world, task)).toEqual(BOTH_LINKS_ON);
  });

  it("keeps two tenants apart: each task inherits from its own tenant's Event, and another tenant's Event is refused like an unknown one", async () => {
    const a = await buildWorld();
    const b = await buildWorld();
    // The same Idempotency-Key in two tenants names two requests.
    const taskA = await createTask(a, "Send the offer", "action-item-1");
    const taskB = await createTask(b, "Send the offer", "action-item-1");
    expect(taskB).not.toBe(taskA);
    expect(await values(a, taskA)).toEqual({ project: [a.web], people: sorted([a.alice, a.bob]) });
    expect(await values(b, taskB)).toEqual({ project: [b.web], people: sorted([b.alice, b.bob]) });

    // Tenant B names tenant A's Event as the source: the answer is that of an id that exists nowhere.
    const outcome = async (eventId: string, key: string) => {
      const error: unknown = await createTask(b, "Take it over", key, [fromEvent(b, eventId)]).then(
        () => null,
        (reason: unknown) => reason,
      );
      if (!(error instanceof ChokePointError)) throw new Error("The source Event was not refused");
      return {
        status: error.status,
        code: error.code,
        details: error.details,
        message: error.message.replaceAll(eventId, "<event>"),
      };
    };
    const stateB = await writtenState(b);
    const foreign = await outcome(a.event, "foreign-event");
    expect(foreign).toEqual(await outcome(randomUUID(), "unknown-event"));
    expect(foreign.status).toBe(400);
    expect(await writtenState(b)).toEqual(stateB);
    expect(await related(a, a.schema.eventActionItems, a.event)).toEqual([taskA]);

    // Tenant A's Event change reaches tenant A's task only, and tenant B reads none of that task's links.
    await replace(a, a.schema.eventProject, a.event, a.web, a.bathroom);
    await runPropagation();
    expect((await values(a, taskA)).project).toEqual([a.bathroom]);
    expect((await values(b, taskB)).project).toEqual([b.web]);
    expect(await linkRows(b, taskA)).toEqual([]);
    expect(await linksOf(b, taskA)).toEqual({});
    expect(await linkRows(a, taskA)).toEqual(BOTH_LINKS_ON);
  });
});
