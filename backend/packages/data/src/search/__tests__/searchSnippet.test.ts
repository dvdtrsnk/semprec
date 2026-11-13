import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, type Pool } from "pg";
import {
  runInTenant,
  SEARCH_ITEM_GROUP_TYPES,
  type SearchGroup,
  type SearchGroupType,
  type SearchItemGroup,
  type SearchItemResult,
  type SearchOutput,
} from "@semprec/shared";
import "../../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { createInboxItemWithClient } from "../../inbox/inboxStore.js";
import { recomputeJournalInboxDay } from "../../inbox/journalInboxCompute.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { writePageTextBlocks } from "../../testSupport/pageFixtures.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { buildItemSearchQuery } from "../itemSearchQuery.js";
import { logger } from "../logger.js";
import { handleItemSearchPageTextTask } from "../pageTextJob.js";
import { buildSearchSnippetSql } from "../searchSnippet.js";
import { searchItemGroups, type SearchItemGroupsInput } from "../searchItemsQuery.js";

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

const ITEM_SCOPE: SearchGroupType[] = [...SEARCH_ITEM_GROUP_TYPES];

/** Searches in tenant zero as a person, unless the input says otherwise. */
function search(q: string, input: Partial<Omit<SearchItemGroupsInput, "q">> = {}): Promise<SearchOutput> {
  return runInTenant(tenant, () => searchItemGroups(pool, { q, scope: ITEM_SCOPE, perGroupLimit: 4, ...input }));
}

function isItemGroup(group: SearchGroup): group is SearchItemGroup {
  return (SEARCH_ITEM_GROUP_TYPES as readonly SearchGroupType[]).includes(group.type);
}

function groupOf(output: SearchOutput, type: SearchGroupType): SearchItemGroup {
  const group = output.groups.find((candidate) => candidate.type === type);
  if (!group || !isItemGroup(group)) throw new Error(`No ${type} group in the answer`);
  return group;
}

function resultOf(output: SearchOutput, type: SearchGroupType, itemId: string): SearchItemResult {
  const result = groupOf(output, type).items.find((item) => item.itemId === itemId);
  if (!result) throw new Error(`No result ${itemId} in the ${type} group`);
  return result;
}

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

/** Writes the page of an item through the production doc path and runs the page-text job's handler for it. */
async function writePage(itemId: string, texts: string[]): Promise<void> {
  await runInTenant(tenant, async () => {
    await writePageTextBlocks(pool, itemId, texts);
    await handleItemSearchPageTextTask(pool, { itemId });
  });
}

/** The Journal day 2026-10-16 with one Inbox entry, whose text the day's index body holds. */
async function journalDayWithEntry(text: string): Promise<string> {
  return runInTenant(tenant, async () => {
    const journalId = await dbId("journal");
    const inboxDatabaseId = await dbId("inbox");
    const day = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-10-16T12:00:00Z"), "UTC"),
    );
    await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId, date: "2026-10-16", time: "12:00", text }),
    );
    await recomputeJournalInboxDay(pool, day.id);
    return day.id;
  });
}

interface RecordedStatement {
  text: string;
  values: unknown[];
}

/** Records every statement a pooled client sends from now on, until the mocks are restored after the test. */
function recordStatements(): RecordedStatement[] {
  const recorded: RecordedStatement[] = [];
  // Called back with the receiving client below, so the unbound reference is safe.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalQuery: (this: Client, ...args: unknown[]) => unknown = Client.prototype.query;
  vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
    const [statement, values] = args;
    // A statement is sent as its text or as a query config that carries the text.
    const text: unknown =
      typeof statement === "object" && statement !== null && "text" in statement ? statement.text : statement;
    if (typeof text === "string") recorded.push({ text, values: Array.isArray(values) ? values : [] });
    return originalQuery.apply(this, args);
  });
  return recorded;
}

/** Makes every statement whose text holds `fragment` fail with `error` from now on, until the mocks are restored. */
function failStatementsContaining(fragment: string, error: Error): void {
  // Called back with the receiving client below, so the unbound reference is safe.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalQuery: (this: Client, ...args: unknown[]) => unknown = Client.prototype.query;
  vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
    const [statement] = args;
    const text: unknown =
      typeof statement === "object" && statement !== null && "text" in statement ? statement.text : statement;
    if (typeof text === "string" && text.includes(fragment)) return Promise.reject(error);
    return originalQuery.apply(this, args);
  });
}

/** Records every logger call of every level, until the mocks are restored after the test. */
function recordLogCalls(): unknown[][] {
  const calls: unknown[][] = [];
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      calls.push([level, ...args]);
    });
  }
  return calls;
}

describe("the excerpt SQL fragment (issue #1996)", () => {
  it("refers to the bind parameters of the query words and never carries a word of the query", () => {
    const query = buildItemSearchQuery("rozpočet 'schválený", 3);
    const sql = buildSearchSnippetSql(query, 3);

    expect(query.params).toEqual(["rozpočet", "schválený"]);
    expect(sql).toContain("to_tsquery('czech_simple', $3 || ':*') && to_tsquery('czech_simple', $4 || ':*')");
    expect(sql).toContain(`@@ ${query.sql}`);
    expect(sql).toContain('\'StartSel="", StopSel="", MaxFragments=1, MaxWords=25, MinWords=8\'');
    expect(sql).toContain("left(ts_headline('czech_simple', body, ");
    expect(sql).not.toMatch(/rozpo|schv/);
    expect([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))).toSatisfy((positions: number[]) =>
      positions.every((position) => position === 3 || position === 4),
    );
  });

  it("refuses a query without a word and a bind position that is no position", () => {
    expect(() => buildSearchSnippetSql(buildItemSearchQuery("& | ! :", 3), 3)).toThrow(RangeError);
    const query = buildItemSearchQuery("rozpočet", 3);
    expect(() => buildSearchSnippetSql(query, 0)).toThrow(RangeError);
    expect(() => buildSearchSnippetSql(query, 1.5)).toThrow(RangeError);
  });

  it("words the refusal of a query it cannot build an excerpt for without a word of the query", () => {
    const failures: unknown[] = [];
    for (const attempt of [
      () => buildSearchSnippetSql(buildItemSearchQuery("& | ! : '", 3), 3),
      () => buildSearchSnippetSql(buildItemSearchQuery("rozpočet", 3), 0),
      () => buildSearchSnippetSql(buildItemSearchQuery("rozpočet", 3), 1.5),
    ]) {
      try {
        attempt();
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(RangeError);
      expect(JSON.stringify([(failure as Error).message, (failure as Error).stack])).not.toMatch(/rozpo/);
    }
  });
});

describe("the snippet of an item-backed search result (issue #1996)", () => {
  it("gives a Journal day found through the text of its Inbox entry an excerpt that shows the words", async () => {
    const day = await journalDayWithEntry("Standup v pohodě, klient schválil rozsah druhé fáze");

    const answer = await search("klient schválil");

    expect(answer.groups.map((group) => group.type)).toEqual(["journal"]);
    const { snippet } = resultOf(answer, "journal", day);
    expect(snippet).toContain("klient schválil");
    expect(snippet!.length).toBeLessThanOrEqual(160);
  });

  it("gives a project found through its page an excerpt with the accented word, and reports the page in no other group", async () => {
    const project = await create("projects", { name: "Semprec iOS" });
    await writePage(project, ["rozpočet schválený"]);

    const answer = await search("rozpocet");

    expect(answer.groups.map((group) => group.type)).toEqual(["project"]);
    expect(resultOf(answer, "project", project).snippet).toContain("rozpočet");
  });

  it("gives an item without a page no excerpt", async () => {
    const task = await create("tasks", { name: "Odeslat fakturu" });

    const answer = await search("faktur");

    expect(resultOf(answer, "task", task).snippet).toBeNull();
  });

  it("gives a result found only through its title no excerpt, although its page has other text", async () => {
    const project = await create("projects", { name: "Rozpočet domu" });
    await writePage(project, ["Zkontrolovat okna a dveře"]);

    expect(resultOf(await search("rozpocet"), "project", project).snippet).toBeNull();
  });

  it("gives a result whose words are split between its title and its page no excerpt, because the page alone does not match", async () => {
    const project = await create("projects", { name: "Faktura" });
    await writePage(project, ["Rozpočet schválený"]);

    const answer = await search("faktura rozpocet");

    expect(resultOf(answer, "project", project).snippet).toBeNull();
  });

  it("returns the excerpt as plain text of at most 160 characters, built from one fragment of a long page", async () => {
    const task = await create("tasks", { name: "Poznámky" });
    const filler = Array.from({ length: 80 }, (_, index) => `slovo${index}`).join(" ");
    await writePage(task, [`${filler} rozpočet schválený ${filler}`]);

    const { snippet } = resultOf(await search("rozpocet"), "task", task);

    expect(snippet).toContain("rozpočet");
    expect(snippet!.length).toBeLessThanOrEqual(160);
    expect(snippet).not.toMatch(/<\/?b>/);
    expect(snippet).not.toContain(" ... ");
  });

  it("returns no highlight markup for a short page, and keeps the page's own text as it is", async () => {
    const task = await create("tasks", { name: "Poznámky" });
    await writePage(task, ["Zaplatit fakturu do pátku"]);

    expect(resultOf(await search("faktur"), "task", task).snippet).toBe("Zaplatit fakturu do pátku");
  });

  it("fills the excerpt in every item group", async () => {
    const ids = {
      task: await create("tasks", { name: "Úkol" }),
      event: await create("events", { name: "Schůzka", date: "2026-10-16" }),
      project: await create("projects", { name: "Projekt" }),
      area: await create("areas", { name: "Oblast" }),
      contact: await create("people", { name: "Novák" }),
      file: await create("files", { name: "Soubor" }),
    };
    for (const id of Object.values(ids)) await writePage(id, ["Zeměpisná poznámka k věci"]);
    const day = await journalDayWithEntry("Zeměpisná poznámka z deníku");

    const answer = await search("zemepisna");

    for (const [type, id] of Object.entries(ids)) {
      expect(resultOf(answer, type as SearchGroupType, id).snippet, type).toContain("Zeměpisná poznámka");
    }
    expect(resultOf(answer, "journal", day).snippet).toContain("Zeměpisná poznámka");
  });

  it("fills the excerpt of every page of a group, also from a cursor, and for the returned rows only", async () => {
    const tasks: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      tasks.push(await create("tasks", { name: `Úkol ${n}` }));
      await writePage(tasks[n]!, [`Zaplatit fakturu číslo ${n}`]);
    }
    const statements = recordStatements();

    const first = await search("faktur", { scope: ["task"], perGroupLimit: 2 });
    const group = groupOf(first, "task");
    const second = await search("faktur", { scope: ["task"], perGroupLimit: 2, cursor: group.nextCursor! });

    expect(group.items.map((item) => item.snippet)).toEqual(group.items.map(() => expect.stringContaining("fakturu")));
    expect(groupOf(second, "task").items).toHaveLength(2);
    for (const item of groupOf(second, "task").items) expect(item.snippet).toContain("fakturu");
    // The excerpt statement is given the two returned items of each page, not the five matches.
    const excerptStatements = statements.filter((statement) => statement.text.includes("ts_headline"));
    expect(excerptStatements.map((statement) => (statement.values[1] as unknown[]).length)).toEqual([2, 2]);
  });

  it("answers a query full of tsquery syntax without an error, and builds no SQL from the query text", async () => {
    const task = await create("tasks", { name: "Poznámky" });
    await writePage(task, ["Zkontrolovat rozpočet projektu"]);
    const statements = recordStatements();

    const answer = await search("(rozpocet & | ! : ' projektu)");

    expect(resultOf(answer, "task", task).snippet).toContain("rozpočet projektu");
    expect(statements.filter((statement) => statement.text.includes("ts_headline"))).toHaveLength(1);
    for (const statement of statements) expect(statement.text).not.toMatch(/rozpocet|projektu/);
  });

  it("neither logs nor puts the query text into a cursor refusal", async () => {
    const task = await create("tasks", { name: "Poznámky" });
    await writePage(task, ["Zeměpis a dějepis"]);
    const calls = recordLogCalls();

    const answer = await search("zeměpis");
    const failure = await search("zeměpis", { scope: ["task"], cursor: "not a token!" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(resultOf(answer, "task", task).snippet).toContain("Zeměpis");
    expect(failure).toMatchObject({ details: { field: "cursor" } });
    expect(JSON.stringify(failure)).not.toContain("zeměpis");
    expect(JSON.stringify(calls)).not.toContain("zeměpis");
  });

  it("neither logs nor puts the query text into the error of a failed excerpt statement", async () => {
    const task = await create("tasks", { name: "Poznámky" });
    await writePage(task, ["Zeměpis a dějepis"]);
    // What Postgres says of a statement that is cancelled: its text and values are not part of the message.
    const cancelled = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    failStatementsContaining("ts_headline", cancelled);
    const calls = recordLogCalls();

    const failure = await search("zeměpis", { scope: ["task"] }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The excerpt statement ran and failed, and the failure left the search as it came, with nothing added to it.
    expect(failure).toBe(cancelled);
    expect(JSON.stringify([failure, (failure as Error).message, (failure as Error).stack])).not.toContain("zeměpis");
    expect(JSON.stringify(calls)).not.toContain("zeměpis");
    expect(JSON.stringify(calls)).not.toContain("Zeměpis");
  });
});
