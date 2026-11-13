import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  runInTenant,
  SEARCH_ITEM_GROUP_TYPES,
  type SearchGroup,
  type SearchGroupType,
  type SearchItemGroup,
  type SearchItemResult,
  type SearchOutput,
} from "@semprec/shared";
import "../domainWriteHooks.js";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { recomputeJournalInboxDay } from "../inbox/journalInboxCompute.js";
import { logger } from "../search/logger.js";
import { searchItemGroups, type SearchItemGroupsInput } from "../search/searchItemsQuery.js";
import { seedSystem } from "../seed/seedSystem.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { startTaskSeries } from "../testSupport/taskSeriesFixtures.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  cp = createChokePoint(pool);
}, 120_000);
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(pool));
}, 120_000);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

const ALL_SCOPE: SearchGroupType[] = ["task", "event", "project", "area", "contact", "journal", "file", "mail", "chat"];

/** Searches in tenant zero as a person, unless the input says otherwise. */
function search(q: string, input: Partial<Omit<SearchItemGroupsInput, "q">> = {}): Promise<SearchOutput> {
  return runInTenant(tenant, () => searchItemGroups(pool, { q, scope: ALL_SCOPE, perGroupLimit: 4, ...input }));
}

function isItemGroup(group: SearchGroup): group is SearchItemGroup {
  return (SEARCH_ITEM_GROUP_TYPES as readonly SearchGroupType[]).includes(group.type);
}

function groupOf(output: SearchOutput, type: SearchGroupType): SearchItemGroup {
  const group = output.groups.find((candidate) => candidate.type === type);
  if (!group || !isItemGroup(group)) throw new Error(`No ${type} group in the answer`);
  return group;
}

const idsOf = (group: SearchItemGroup): string[] => group.items.map((item) => item.itemId);

async function dbId(key: string): Promise<string> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, key);
      if (!database) throw new Error(`Missing fixture database: ${key}`);
      return database.id;
    }),
  );
}

async function create(moduleKey: string, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(tenant, async () => (await cp.createItem({ databaseId: await dbId(moduleKey), properties })).id);
}

async function link(sourceModuleKey: string, key: string, itemId: string, targetId: string): Promise<void> {
  await runInTenant(tenant, async () => {
    const property = await withTransaction(pool, async (client) =>
      getPropertyByKey(client, await dbId(sourceModuleKey), key),
    );
    if (!property) throw new Error(`Missing fixture relation: ${key}`);
    await cp.createRelation({ relationPropertyId: property.id, callerItemId: itemId, targetItemId: targetId });
  });
}

/** Fixes `updated_at` on rows: no write sets it to a chosen instant, and the order under test depends on it. */
async function setUpdatedAt(itemIds: string[], updatedAt: string): Promise<void> {
  await admin.query("UPDATE items SET updated_at = $2::timestamptz WHERE id = ANY($1::uuid[])", [itemIds, updatedAt]);
}

describe("global search: groups, totals and paging", () => {
  it("returns at most perGroupLimit results per group with the real total, in the fixed group order, and omits empty groups", async () => {
    const tasks = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => create("tasks", { name: `Faktura úkol ${n}` })));
    const events = await Promise.all(
      [1, 2].map((n) => create("events", { name: `Faktura schůzka ${n}`, date: "2026-10-16" })),
    );
    const project = await create("projects", { name: "Faktura projekt" });
    const person = await create("people", { name: "Faktura Novák" });
    const company = await create("companies", { name: "Faktura s.r.o." });
    await create("areas", { name: "Domácnost" });

    const answer = await search("faktura");

    expect(answer.groups.map((group) => group.type)).toEqual(["task", "event", "project", "contact"]);
    const task = groupOf(answer, "task");
    expect(task.total).toBe(6);
    expect(task.items).toHaveLength(4);
    expect(idsOf(task).every((id) => tasks.includes(id))).toBe(true);
    expect(task.nextCursor).toEqual(expect.any(String));
    const event = groupOf(answer, "event");
    expect([event.total, idsOf(event).sort()]).toEqual([2, [...events].sort()]);
    expect(event.nextCursor).toBeNull();
    expect(idsOf(groupOf(answer, "project"))).toEqual([project]);
    const contact = groupOf(answer, "contact");
    expect([contact.total, idsOf(contact).sort()]).toEqual([2, [person, company].sort()]);
    expect(contact.items.map((item) => item.databaseKey).sort()).toEqual(["companies", "people"]);
    for (const item of task.items) expect(item).toMatchObject({ databaseKey: "tasks", snippet: null });
  });

  it("returns all matching tasks of scope task in pages that follow nextCursor, with the total on every page", async () => {
    const tasks = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => create("tasks", { name: `Faktura ${n}` })));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const answer = await search("faktura", { scope: ["task"], perGroupLimit: 3, cursor });
      const group = groupOf(answer, "task");
      expect(group.total).toBe(7);
      seen.push(...idsOf(group));
      cursor = group.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect([...seen].sort()).toEqual([...tasks].sort());
  });

  it("returns every task with perGroupLimit 50 and no nextCursor, and exactly one with perGroupLimit 1", async () => {
    const tasks = await Promise.all([1, 2, 3].map((n) => create("tasks", { name: `Faktura ${n}` })));
    const all = groupOf(await search("faktura", { scope: ["task"], perGroupLimit: 50 }), "task");
    expect([all.total, all.items.length, all.nextCursor]).toEqual([3, 3, null]);
    expect(idsOf(all).sort()).toEqual([...tasks].sort());
    const one = groupOf(await search("faktura", { scope: ["task"], perGroupLimit: 1 }), "task");
    expect([one.total, one.items.length]).toEqual([3, 1]);
    expect(one.nextCursor).toEqual(expect.any(String));
  });

  it("orders by relevance, then by newest update, then by item id, and the cursor continues that order across ties", async () => {
    const strong = await create("tasks", { name: "Faktura faktura faktura faktura" });
    const [first, second, third, fourth] = await Promise.all(
      [1, 2, 3, 4].map(() => create("tasks", { name: "Faktura" })),
    );
    const sameMoment = [first!, second!];
    await setUpdatedAt(sameMoment, "2026-10-01T10:00:00.123456Z");
    await setUpdatedAt([third!], "2026-10-02T10:00:00.000000Z");
    await setUpdatedAt([fourth!], "2026-09-01T10:00:00.000000Z");
    await setUpdatedAt([strong], "2026-01-01T10:00:00.000000Z");

    const full = idsOf(groupOf(await search("faktura", { scope: ["task"], perGroupLimit: 50 }), "task"));
    expect(full).toEqual([strong, third!, ...[...sameMoment].sort(), fourth!]);

    const paged: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const group = groupOf(await search("faktura", { scope: ["task"], perGroupLimit: 1, cursor }), "task");
      paged.push(...idsOf(group));
      cursor = group.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(paged).toEqual(full);
  });

  it("matches with accents folded, by prefix, on all words, and treats query syntax as text", async () => {
    const accounting = await create("projects", { name: "Účetnictví a faktury" });
    const send = await create("tasks", { name: "Odeslat fakturu" });
    const both = await create("tasks", { name: "Faktura koupelna" });
    expect(idsOf(groupOf(await search("ucetnictvi"), "project"))).toEqual([accounting]);
    expect(idsOf(groupOf(await search("odes fak"), "task"))).toEqual([send]);
    expect(idsOf(groupOf(await search("faktura koupelna"), "task"))).toEqual([both]);
    expect(idsOf(groupOf(await search("(faktura & | ! : ' koupelna)"), "task"))).toEqual([both]);
  });

  it("answers a query without a searchable word, and a scope of only mail and chat, with no groups", async () => {
    await create("tasks", { name: "Faktura" });
    expect(await search("& | ! : ' ()")).toEqual({ groups: [] });
    expect(await search("faktura", { scope: ["mail", "chat"] })).toEqual({ groups: [] });
  });

  it("finds the Journal day for the text of an Inbox entry and never an Inbox entry", async () => {
    const day = await runInTenant(tenant, async () => {
      const journalId = await dbId("journal");
      const inboxDatabaseId = await dbId("inbox");
      const created = await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journalId, "day", new Date("2026-10-16T12:00:00Z"), "UTC"),
      );
      await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId,
          date: "2026-10-16",
          time: "12:00",
          text: "Klient schválil nabídku",
        }),
      );
      await recomputeJournalInboxDay(pool, created.id);
      return created;
    });
    const answer = await search("klient schválil");
    expect(answer.groups.map((group) => group.type)).toEqual(["journal"]);
    const group = groupOf(answer, "journal");
    expect(idsOf(group)).toEqual([day.id]);
    expect(group.items[0]).toMatchObject({ databaseKey: "journal", subtitleParts: [] });
  });
});

describe("global search: what is never returned", () => {
  /** A task that proves the search ran: it matches, is live and is returned. */
  async function liveTask(): Promise<string> {
    return create("tasks", { name: "Faktura živá" });
  }

  it("leaves out an item in the trash", async () => {
    const live = await liveTask();
    const trashed = await create("tasks", { name: "Faktura v koši" });
    await runInTenant(tenant, async () => cp.softDeleteItem(await dbId("tasks"), trashed));
    const answer = await search("faktura");
    expect(idsOf(groupOf(answer, "task"))).toEqual([live]);
    expect(groupOf(answer, "task").total).toBe(1);
  });

  it("leaves out a project with systemActive and finds a user project", async () => {
    const visible = await create("projects", { name: "Faktura projekt" });
    const system = await runInTenant(tenant, async () =>
      withTransaction(
        pool,
        async (client) =>
          (
            await createItemWithClient(
              client,
              { databaseId: await dbId("projects"), properties: { name: "Faktura systém", systemActive: true } },
              { allowedSystemKeys: ["systemActive"] },
            )
          ).id,
      ),
    );
    const answer = groupOf(await search("faktura"), "project");
    expect(idsOf(answer)).toEqual([visible]);
    expect(answer.total).toBe(1);
    expect(JSON.stringify(answer)).not.toContain(system);
  });

  it("leaves out the items of an archived database", async () => {
    const live = await liveTask();
    const filed = await create("files", { name: "Faktura.pdf" });
    // Archiving a system database is not offered by the API; the fixture sets the column the archive sets.
    await admin.query("UPDATE databases SET archived_at = now() WHERE id = $1", [await dbId("files")]);
    const answer = await search("faktura");
    expect(answer.groups.map((group) => group.type)).toEqual(["task"]);
    expect(idsOf(groupOf(answer, "task"))).toEqual([live]);
    expect(JSON.stringify(answer)).not.toContain(filed);
  });

  it("leaves out the items of a user-created collection", async () => {
    const live = await liveTask();
    const collectionItem = await runInTenant(tenant, async () => {
      const database = await cp.createDatabase({ name: "Moje faktury" });
      await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
      return (await cp.createItem({ databaseId: database.id, properties: { name: "Faktura sbírka" } })).id;
    });
    const answer = await search("faktura");
    expect(answer.groups.map((group) => group.type)).toEqual(["task"]);
    expect(idsOf(groupOf(answer, "task"))).toEqual([live]);
    expect(JSON.stringify(answer)).not.toContain(collectionItem);
  });

  it("leaves out Health records, which are not part of global search", async () => {
    const live = await liveTask();
    const record = await create("healthRecords", { name: "Faktura od lékaře" });
    const answer = await search("faktura");
    expect(answer.groups.map((group) => group.type)).toEqual(["task"]);
    expect(idsOf(groupOf(answer, "task"))).toEqual([live]);
    expect(JSON.stringify(answer)).not.toContain(record);
  });

  it("finds nothing of another tenant and nothing in this tenant of the other's rows, through the runtime role", async () => {
    const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const own = await create("tasks", { name: "Faktura vlastní" });
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool));
    const foreign = await runInTenant(other, async () => {
      const tasks = await withTransaction(pool, async (client) => (await getDatabaseByModuleId(client, "tasks"))!.id);
      return (await cp.createItem({ databaseId: tasks, properties: { name: "Faktura cizí" } })).id;
    });

    const asOwner = await search("faktura");
    expect(idsOf(groupOf(asOwner, "task"))).toEqual([own]);
    expect(JSON.stringify(asOwner)).not.toContain(foreign);
    const asOther = await runInTenant(other, () =>
      searchItemGroups(pool, { q: "faktura", scope: ALL_SCOPE, perGroupLimit: 4 }),
    );
    expect(idsOf(groupOf(asOther, "task"))).toEqual([foreign]);
    expect(JSON.stringify(asOther)).not.toContain(own);
  });
});

describe("global search: the Journal period of a journal result (issue #1859)", () => {
  /** The Journal entry of a period, created the way the first write to it creates it. */
  async function journalEntry(type: "day" | "week", date: string): Promise<string> {
    return runInTenant(tenant, async () => {
      const journalId = await dbId("journal");
      return withTransaction(
        pool,
        async (client) =>
          (await getOrCreateJournalItem(client, journalId, type, new Date(`${date}T12:00:00Z`), "UTC")).id,
      );
    });
  }

  /** The `journal` of a result, or `undefined` when the result carries none. */
  function journalOf(item: SearchItemResult): unknown {
    return "journal" in item ? item.journal : undefined;
  }

  it("carries type day and the canonical period on a Journal day, and type week on a Journal week", async () => {
    const day = await journalEntry("day", "2026-10-16");
    const week = await journalEntry("week", "2026-10-16");

    const group = groupOf(await search("2026"), "journal");

    expect(group.total).toBe(2);
    const byId = new Map(group.items.map((item) => [item.itemId, journalOf(item)]));
    expect(byId.get(day)).toStrictEqual({ type: "day", period: "2026-10-16" });
    expect(byId.get(week)).toStrictEqual({ type: "week", period: "2026-W42" });
  });

  it("carries the period on a Journal day found through the text of an Inbox entry, and never returns the Inbox entry", async () => {
    const day = await journalEntry("day", "2026-10-16");
    const inboxEntry = await runInTenant(tenant, async () => {
      const inboxDatabaseId = await dbId("inbox");
      const created = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId,
          date: "2026-10-16",
          time: "12:00",
          text: "Rozpis dodávky klientovi",
        }),
      );
      await recomputeJournalInboxDay(pool, day);
      return created.id;
    });

    const answer = await search("rozpis dodávky");

    expect(answer.groups.map((group) => group.type)).toEqual(["journal"]);
    const group = groupOf(answer, "journal");
    expect(idsOf(group)).toEqual([day]);
    expect(journalOf(group.items[0]!)).toStrictEqual({ type: "day", period: "2026-10-16" });
    expect(JSON.stringify(answer)).not.toContain(inboxEntry);
  });

  it("leaves out a Journal entry in the trash and keeps its live sibling with its period", async () => {
    const live = await journalEntry("day", "2026-10-15");
    const trashed = await journalEntry("day", "2026-10-16");
    await runInTenant(tenant, async () => cp.softDeleteItem(await dbId("journal"), trashed));

    const group = groupOf(await search("2026"), "journal");

    expect(idsOf(group)).toEqual([live]);
    expect(group.total).toBe(1);
    expect(journalOf(group.items[0]!)).toStrictEqual({ type: "day", period: "2026-10-15" });
    expect(JSON.stringify(group)).not.toContain(trashed);
  });

  it("gives results of the other groups no journal field", async () => {
    const task = await create("tasks", { name: "Úkol 2026" });
    const event = await create("events", { name: "Schůzka 2026", date: "2026-10-16" });
    const project = await create("projects", { name: "Projekt 2026" });
    const day = await journalEntry("day", "2026-10-16");

    const answer = await search("2026");

    expect(answer.groups.map((group) => group.type)).toEqual(["task", "event", "project", "journal"]);
    for (const group of answer.groups) {
      for (const item of group.items) {
        expect("journal" in item, group.type).toBe(group.type === "journal");
      }
    }
    expect([task, event, project, day].every((id) => JSON.stringify(answer).includes(id))).toBe(true);
  });

  it("returns only the stored type and period, with no localised period label anywhere in the answer", async () => {
    await journalEntry("day", "2026-10-16");
    await journalEntry("week", "2026-10-16");

    const answer = await search("2026");
    const group = groupOf(answer, "journal");

    for (const item of group.items) {
      expect(Object.keys(journalOf(item) as object).sort()).toEqual(["period", "type"]);
      expect(Object.keys(item).sort()).toEqual([
        "databaseId",
        "databaseKey",
        "itemId",
        "journal",
        "snippet",
        "subtitleParts",
        "title",
      ]);
      expect(item.subtitleParts).toEqual([]);
    }
    // The label of 2026-10-16 in either language, composed with the same Intl API a client uses, is nowhere in the answer.
    const text = JSON.stringify(answer).toLowerCase();
    const instant = new Date("2026-10-16T12:00:00Z");
    for (const locale of ["cs", "en"]) {
      for (const options of [{ weekday: "long" }, { month: "long" }] as const) {
        const word = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(instant).toLowerCase();
        expect(text, `${locale} ${word}`).not.toContain(word);
      }
    }
  });

  describe("an entry whose type or period is missing or unknown", () => {
    /** Writes a state the Journal's own writes never produce (type and period are system keys it always sets), directly. */
    async function corrupt(itemId: string, statement: string): Promise<void> {
      await admin.query(`UPDATE items SET properties = ${statement} WHERE id = $1`, [itemId]);
    }

    it.each([
      ["an unknown type", `jsonb_set(properties, '{type}', '"decade"')`],
      ["no type", `properties - 'type'`],
      ["no period", `properties - 'period'`],
      ["an empty period", `jsonb_set(properties, '{period}', '""')`],
      ["a period that is not text", `jsonb_set(properties, '{period}', '2026')`],
    ])("drops an entry with %s from the group, from its total and from the answer", async (_label, statement) => {
      const valid = await journalEntry("day", "2026-10-15");
      const broken = await journalEntry("day", "2026-10-16");
      await corrupt(broken, statement);

      const answer = await search("2026");

      const group = groupOf(answer, "journal");
      expect(idsOf(group)).toEqual([valid]);
      expect(group.total).toBe(1);
      expect(JSON.stringify(answer)).not.toContain(broken);
    });

    it("answers no journal group when every matching entry is malformed", async () => {
      await corrupt(await journalEntry("day", "2026-10-16"), `properties - 'type'`);
      expect(await search("2026")).toEqual({ groups: [] });
    });

    it("pages over the valid entries only: the total and the cursor never count a dropped entry", async () => {
      const days = await Promise.all(["2026-10-13", "2026-10-14", "2026-10-15"].map((day) => journalEntry("day", day)));
      await corrupt(await journalEntry("day", "2026-10-16"), `properties - 'period'`);
      await corrupt(await journalEntry("day", "2026-10-17"), `jsonb_set(properties, '{type}', '"decade"')`);

      const first = groupOf(await search("2026", { scope: ["journal"], perGroupLimit: 2 }), "journal");
      expect([first.total, first.items.length]).toEqual([3, 2]);
      if (first.nextCursor === null) throw new Error("Expected a second page");
      const second = groupOf(
        await search("2026", { scope: ["journal"], perGroupLimit: 2, cursor: first.nextCursor }),
        "journal",
      );

      expect([second.total, second.items.length, second.nextCursor]).toEqual([3, 1, null]);
      expect([...idsOf(first), ...idsOf(second)].sort()).toEqual([...days].sort());
    });
  });
});

describe("global search: an agent's database grants (issue #1810)", () => {
  /** A Projects item standing for an agent's project. */
  const newAgentProject = () => create("projects", { name: "Agent project" });

  it("leaves out the items of a database the agent has no grant for, returns them with a read grant, and never filters a person", async () => {
    const file = await create("files", { name: "Faktura.pdf" });
    const task = await create("tasks", { name: "Faktura úkol" });
    const agent = await newAgentProject();
    // The seeded Files database is open to agents; the flag that makes it need a grant is set directly, since no API sets it on it.
    await admin.query("UPDATE databases SET sensitive = true WHERE id = $1", [await dbId("files")]);

    const denied = await search("faktura", { agentProjectItemId: agent });
    expect(denied.groups.map((group) => group.type)).toEqual(["task"]);
    expect(idsOf(groupOf(denied, "task"))).toEqual([task]);
    expect(JSON.stringify(denied)).not.toContain(file);

    const person = await search("faktura");
    expect(idsOf(groupOf(person, "file"))).toEqual([file]);

    await runInTenant(tenant, async () =>
      withTransaction(pool, async (client) =>
        setAgentDatabaseGrant(client, { projectItemId: agent, databaseId: await dbId("files"), access: "read" }),
      ),
    );
    const granted = await search("faktura", { agentProjectItemId: agent });
    expect(idsOf(groupOf(granted, "file"))).toEqual([file]);

    await runInTenant(tenant, async () =>
      withTransaction(pool, async (client) =>
        setAgentDatabaseGrant(client, { projectItemId: agent, databaseId: await dbId("files"), access: "none" }),
      ),
    );
    expect(JSON.stringify(await search("faktura", { agentProjectItemId: agent }))).not.toContain(file);
  });

  it("shows no linked item of a database the agent cannot read in a subtitle, counting nothing of it", async () => {
    const project = await create("projects", { name: "Skrytý projekt" });
    const task = await create("tasks", { name: "Faktura úkol", date: "2026-10-16" });
    await link("tasks", "project", task, project);
    const area = await create("areas", { name: "Faktura oblast" });
    await link("areas", "projects", area, project);
    const agent = await newAgentProject();
    await admin.query("UPDATE databases SET sensitive = true WHERE id = $1", [await dbId("projects")]);

    const asPerson = await search("faktura");
    expect(groupOf(asPerson, "task").items[0]?.subtitleParts.map((part) => part.kind)).toEqual(["date", "project"]);
    expect(groupOf(asPerson, "area").items[0]?.subtitleParts).toEqual([{ kind: "count", value: "1" }]);

    const asAgent = await search("faktura", { agentProjectItemId: agent });
    expect(groupOf(asAgent, "task").items[0]?.subtitleParts).toEqual([{ kind: "date", value: "2026-10-16" }]);
    expect(groupOf(asAgent, "area").items[0]?.subtitleParts).toEqual([{ kind: "count", value: "0" }]);
    expect(JSON.stringify(asAgent)).not.toContain(project);
  });
});

describe("global search: the structured subtitle", () => {
  it("shows a task with its date, time range and project, and no area", async () => {
    const area = await create("areas", { name: "Finance" });
    const project = await create("projects", { name: "Účetnictví a faktury" });
    await link("projects", "area", project, area);
    const task = await create("tasks", {
      name: "Odeslat fakturu",
      date: "2026-10-16",
      timeFrom: "14:00",
      timeTo: "15:30",
    });
    await link("tasks", "project", task, project);

    const item = groupOf(await search("odeslat fakturu"), "task").items[0];

    expect(item).toMatchObject({ itemId: task, title: "Odeslat fakturu", snippet: null });
    expect(item?.subtitleParts).toEqual([
      { kind: "date", value: "2026-10-16" },
      { kind: "timeRange", value: "14:00-15:30" },
      { kind: "project", value: "Účetnictví a faktury", itemId: project },
    ]);
  });

  it("shows only the start time as time, nothing for a task without date, time and project, and pads a single-digit hour", async () => {
    const withStart = await create("tasks", { name: "Telefonát klient", date: "2026-10-16", timeFrom: "9:30" });
    const bare = await create("tasks", { name: "Telefonát bez termínu" });
    const answer = groupOf(await search("telefonát"), "task");
    const byId = new Map(answer.items.map((item) => [item.itemId, item.subtitleParts]));
    expect(byId.get(withStart)).toEqual([
      { kind: "date", value: "2026-10-16" },
      { kind: "time", value: "09:30" },
    ]);
    expect(byId.get(bare)).toEqual([]);
  });

  it("shows the recurrence of a task as its preset, as the kind of a fixed rule, or as floating", async () => {
    const fixedTask = await create("tasks", { name: "Opakovat pravidelně", date: "2026-10-16" });
    const floatingTask = await create("tasks", { name: "Opakovat plovoucí", date: "2026-10-16" });
    const presetTask = await create("tasks", { name: "Opakovat denně", date: "2026-10-16" });
    const tasksId = await dbId("tasks");
    await runInTenant(tenant, () =>
      startTaskSeries(pool, {
        databaseId: tasksId,
        itemId: fixedTask,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon", "wed"] },
      }),
    );
    await runInTenant(tenant, () =>
      startTaskSeries(pool, {
        databaseId: tasksId,
        itemId: floatingTask,
        mode: "floating",
        rule: { unit: "weeks", n: 2 },
      }),
    );
    await runInTenant(tenant, () =>
      startTaskSeries(pool, {
        databaseId: tasksId,
        itemId: presetTask,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
      }),
    );
    // The recurrence route stores the preset a request named; the fixture series above stored none.
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: tasksId,
            itemId: presetTask,
            propertiesPatch: {
              recurrence: {
                preset: "daily",
                mode: "fixed",
                rule: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
              },
            },
          },
          { allowedSystemKeys: ["recurrence"], systemOwnerProcess: TASKS_MODULE_ID },
        ),
      ),
    );

    const answer = groupOf(await search("opakovat"), "task");
    const recurrenceOf = (id: string) =>
      answer.items.find((item) => item.itemId === id)?.subtitleParts.find((part) => part.kind === "recurrence")?.value;
    expect(recurrenceOf(fixedTask)).toBe("weekdays");
    expect(recurrenceOf(floatingTask)).toBe("floating");
    expect(recurrenceOf(presetTask)).toBe("daily");
  });

  it("shows an event with its date, time range, place and people, without a place part when it has none, and at most five people", async () => {
    const people = await Promise.all(
      ["Adam", "Božena", "Cyril", "Dana", "Emil", "Filip"].map((name) => create("people", { name: `${name} Host` })),
    );
    const meeting = await create("events", {
      name: "Porada",
      date: "2026-10-16",
      timeFrom: "09:00",
      timeTo: "10:30",
      place: "Brno",
    });
    const call = await create("events", {
      name: "Porada telefon",
      date: "2026-10-17",
      timeFrom: "11:00",
      timeTo: "12:00",
    });
    for (const person of people) await link("events", "people", meeting, person);
    await link("events", "people", call, people[0]!);

    const items = groupOf(await search("porada"), "event").items;
    const meetingParts = items.find((item) => item.itemId === meeting)?.subtitleParts;
    expect(meetingParts?.slice(0, 3)).toEqual([
      { kind: "date", value: "2026-10-16" },
      { kind: "timeRange", value: "09:00-10:30" },
      { kind: "place", value: "Brno" },
    ]);
    expect(meetingParts?.slice(3)).toEqual(
      ["Adam", "Božena", "Cyril", "Dana", "Emil"].map((name, index) => ({
        kind: "people",
        value: `${name} Host`,
        itemId: people[index],
      })),
    );
    expect(items.find((item) => item.itemId === call)?.subtitleParts).toEqual([
      { kind: "date", value: "2026-10-17" },
      { kind: "timeRange", value: "11:00-12:00" },
      { kind: "people", value: "Adam Host", itemId: people[0] },
    ]);
  });

  it("shows a project with its area and status, and an area with the count of its projects but not of system projects or the trash", async () => {
    const area = await create("areas", { name: "Domácnost" });
    const first = await create("projects", { name: "Domácnost rekonstrukce", status: "inProgress" });
    const second = await create("projects", { name: "Domácnost zahrada" });
    const trashed = await create("projects", { name: "Domácnost starý" });
    const system = await runInTenant(tenant, () =>
      withTransaction(
        pool,
        async (client) =>
          (
            await createItemWithClient(
              client,
              { databaseId: await dbId("projects"), properties: { name: "Domácnost systém", systemActive: true } },
              { allowedSystemKeys: ["systemActive"] },
            )
          ).id,
      ),
    );
    for (const project of [first, second, trashed, system]) await link("projects", "area", project, area);
    await runInTenant(tenant, async () => cp.softDeleteItem(await dbId("projects"), trashed));

    const answer = await search("domácnost");
    const project = groupOf(answer, "project").items.find((item) => item.itemId === first);
    expect(project?.subtitleParts).toEqual([
      { kind: "area", value: "Domácnost", itemId: area },
      { kind: "status", value: "inProgress" },
    ]);
    expect(groupOf(answer, "area").items.find((item) => item.itemId === area)?.subtitleParts).toEqual([
      { kind: "count", value: "2" },
    ]);
  });

  it("shows a person with relationship, project and first phone, a company with its marker, and a file with its project and date", async () => {
    const project = await create("projects", { name: "Nabídka" });
    const person = await create("people", {
      name: "Karel Klient",
      relationship: "client",
      phones: "\n777 123 456\n602 000 111",
    });
    const company = await create("companies", { name: "Klient s.r.o." });
    const file = await create("files", { name: "Klient smlouva.pdf", date: "2026-10-15" });
    await link("people", "projects", person, project);
    await link("files", "projects", file, project);

    const answer = await search("klient");
    expect(groupOf(answer, "contact").items.find((item) => item.itemId === person)?.subtitleParts).toEqual([
      { kind: "relationship", value: "client" },
      { kind: "project", value: "Nabídka", itemId: project },
      { kind: "phone", value: "777 123 456" },
    ]);
    expect(groupOf(answer, "contact").items.find((item) => item.itemId === company)?.subtitleParts).toEqual([
      { kind: "relationship", value: "company" },
    ]);
    expect(groupOf(answer, "file").items[0]?.subtitleParts).toEqual([
      { kind: "project", value: "Nabídka", itemId: project },
      { kind: "date", value: "2026-10-15" },
    ]);
    expect(idsOf(groupOf(await search("777123456"), "contact"))).toEqual([person]);
    expect(idsOf(groupOf(await search("777 123 456"), "contact"))).toEqual([person]);
  });

  it("omits the project of a task whose project is in the trash", async () => {
    const project = await create("projects", { name: "Zrušený projekt" });
    const task = await create("tasks", { name: "Faktura úkol" });
    await link("tasks", "project", task, project);
    await runInTenant(tenant, async () => cp.softDeleteItem(await dbId("projects"), project));
    expect(groupOf(await search("faktura úkol"), "task").items[0]?.subtitleParts).toEqual([]);
  });
});

describe("global search: refused input, and what is logged", () => {
  it("refuses a cursor that was not issued, whatever its shape, with a validation error naming cursor and not the query", async () => {
    await create("tasks", { name: "Faktura" });
    const secret = "tajny-dotaz-faktura";
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const tokens = [
      "not a token!",
      "e30",
      forged(null),
      forged({ r: 1, u: "1", i: "11111111-1111-1111-1111-111111111111", extra: true }),
      forged({ r: -1, u: "1", i: "11111111-1111-1111-1111-111111111111" }),
      forged({ r: "1", u: "1", i: "11111111-1111-1111-1111-111111111111" }),
      forged({ r: 1, u: "1; DROP TABLE items", i: "11111111-1111-1111-1111-111111111111" }),
      forged({ r: 1, u: "1", i: "not-a-uuid" }),
      Buffer.from("{broken", "utf8").toString("base64url"),
    ];
    for (const cursor of tokens) {
      const failure = await search(secret, { scope: ["task"], cursor }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, cursor).toBeInstanceOf(ValidationError);
      expect(failure).toMatchObject({ details: { field: "cursor" } });
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect((failure as Error).message).not.toContain(secret);
    }
  });

  it("refuses a cursor with a scope of two groups or of none in the data layer too", async () => {
    await create("tasks", { name: "Faktura 1" });
    await create("tasks", { name: "Faktura 2" });
    const cursor = groupOf(await search("faktura", { scope: ["task"], perGroupLimit: 1 }), "task").nextCursor;
    if (cursor === null) throw new Error("Expected a cursor");
    await expect(search("faktura", { scope: ["task", "event"], cursor })).rejects.toMatchObject({
      details: { field: "cursor" },
    });
    await expect(search("faktura", { scope: [], cursor })).rejects.toMatchObject({ details: { field: "cursor" } });
    // The same cursor with one scope type is accepted.
    expect(groupOf(await search("faktura", { scope: ["task"], perGroupLimit: 1, cursor }), "task").items).toHaveLength(
      1,
    );
  });

  it("logs only the query length and the counts, never the query", async () => {
    await create("tasks", { name: "Zeměpis faktura" });
    await create("tasks", { name: "Zeměpis dopis" });
    const calls: unknown[][] = [];
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        calls.push([level, ...args]);
      });
    }
    await search("zeměpis");
    await search("zeměpis", { scope: ["task"], cursor: "not a token!" }).catch(() => undefined);

    expect(calls).toEqual([
      ["info", { queryLength: 7, groupCount: 1, resultCount: 2, totalMatches: 2 }, "Global search completed"],
    ]);
    expect(JSON.stringify(calls)).not.toContain("zeměpis");
  });
});
