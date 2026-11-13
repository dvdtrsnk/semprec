import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant, type SearchGroupType, type SearchOutput, type SearchThreadResult } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import {
  clearSearchGroupsForTests,
  registerItemSearchGroup,
  registerThreadSearchGroup,
  type ThreadSearchGroup,
  type ThreadSearchRequest,
} from "../search/searchGroupRegistry.js";
import { searchItemGroups, type SearchItemGroupsInput } from "../search/searchItemsQuery.js";
import { seedSystem } from "../seed/seedSystem.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

// A search over groups that the test registers itself (`clearSearchGroupsForTests` first), on the runtime-role pool
// with two tenants. The groups of the composition root are exercised by `searchItemsQuery.test.ts` and
// `sempThreadSearch.test.ts`; this file proves the seam they stand on.

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let other: string;

const ALL_SCOPE: SearchGroupType[] = ["task", "event", "project", "area", "contact", "journal", "file", "mail", "chat"];

/** What a fixture thread group saw: the token `prepare` got and the request each run got. */
interface Recorder {
  prepared: Array<string | undefined>;
  requests: ThreadSearchRequest[];
  isolations: string[];
}

function newRecorder(): Recorder {
  return { prepared: [], requests: [], isolations: [] };
}

function fixtureThreads(prefix: string, count: number): SearchThreadResult[] {
  return Array.from({ length: count }, (_, index) => ({
    threadId: randomUUID(),
    title: `${prefix} ${index}`,
    subtitleParts: [],
    snippet: null,
  }));
}

/**
 * A thread group over fixed entries. Its cursor is `offset:<n>`: `prepare` refuses any other token with the
 * `ValidationError` a real group throws, and the run it returns lists the entries from the parsed offset.
 */
function fixtureGroup(
  type: ThreadSearchGroup["type"],
  entries: readonly SearchThreadResult[],
  recorder: Recorder,
): ThreadSearchGroup {
  return {
    type,
    prepare(cursor) {
      recorder.prepared.push(cursor);
      const match = cursor === undefined ? null : /^offset:(\d{1,6})$/.exec(cursor);
      if (cursor !== undefined && match === null) {
        throw new ValidationError("Invalid fixture cursor", { field: "cursor" });
      }
      const offset = match?.[1] === undefined ? 0 : Number(match[1]);
      return async (client, request) => {
        recorder.requests.push(request);
        const { rows } = await client.query<{ isolation: string }>(
          "SELECT current_setting('transaction_isolation') AS isolation",
        );
        recorder.isolations.push(rows[0]?.isolation ?? "");
        const end = offset + request.limit;
        return {
          total: entries.length,
          items: entries.slice(offset, end),
          nextCursor: end < entries.length ? `offset:${end}` : null,
        };
      };
    },
  };
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  cp = createChokePoint(pool);
}, 120_000);
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  other = await createTestTenant(admin);
  await runInTenant(tenant, () => seedSystem(pool));
  await runInTenant(other, () => seedSystem(pool));
  clearSearchGroupsForTests();
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

type SearchItemsInputWithoutQuery = Omit<SearchItemGroupsInput, "q">;

function search(
  q: string,
  input: Partial<SearchItemsInputWithoutQuery> = {},
  tenantId: string = tenant,
): Promise<SearchOutput> {
  return runInTenant(tenantId, () =>
    searchItemGroups(pool, { q, scope: ALL_SCOPE, perGroupLimit: 4, humanActor: true, ...input }),
  );
}

async function createTask(name: string, tenantId: string = tenant): Promise<string> {
  return runInTenant(tenantId, async () => {
    const databaseId = await withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
      if (!database) throw new Error("Missing fixture database: tasks");
      return database.id;
    });
    return (await cp.createItem({ databaseId, properties: { name } })).id;
  });
}

const typesOf = (output: SearchOutput): string[] => output.groups.map((group) => group.type);

function itemIdsOf(output: SearchOutput): string[] {
  return output.groups.flatMap((group) => group.items.flatMap((item) => ("itemId" in item ? [item.itemId] : [])));
}

describe("search groups contributed through the registry", () => {
  it("returns a registered mail group after the item groups and before chat, with its own total and perGroupLimit, whatever the order of registration", async () => {
    const mailEntries = fixtureThreads("Faktura mail", 5);
    const chatEntries = fixtureThreads("Faktura chat", 3);
    registerThreadSearchGroup(fixtureGroup("chat", chatEntries, newRecorder()));
    registerThreadSearchGroup(fixtureGroup("mail", mailEntries, newRecorder()));
    registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
    await createTask("Faktura úkol");

    const answer = await search("faktura", { perGroupLimit: 2 });

    expect(typesOf(answer)).toEqual(["task", "mail", "chat"]);
    const mail = answer.groups[1];
    expect(mail).toEqual({ type: "mail", total: 5, items: mailEntries.slice(0, 2), nextCursor: "offset:2" });
    expect(answer.groups[2]).toEqual({
      type: "chat",
      total: 3,
      items: chatEntries.slice(0, 2),
      nextCursor: "offset:2",
    });
  });

  it("omits a thread group that answers a total of zero", async () => {
    registerThreadSearchGroup(fixtureGroup("mail", [], newRecorder()));
    registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
    await createTask("Faktura úkol");

    expect(typesOf(await search("faktura"))).toEqual(["task"]);
  });

  it("runs the thread group in the transaction of the item groups, a repeatable-read one", async () => {
    const recorder = newRecorder();
    registerThreadSearchGroup(fixtureGroup("mail", fixtureThreads("Faktura", 1), recorder));

    await search("faktura", { scope: ["mail"] });

    expect(recorder.isolations).toEqual(["repeatable read"]);
  });

  it("gives the group the search text, the limit, the builder and the actor facts exactly as the search had them", async () => {
    const recorder = newRecorder();
    registerThreadSearchGroup(fixtureGroup("mail", fixtureThreads("Faktura", 1), recorder));
    const agentProject = await runInTenant(tenant, async () => {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      if (!database) throw new Error("Missing fixture database: projects");
      return (await cp.createItem({ databaseId: database.id, properties: { name: "Agent project" } })).id;
    });

    await search("faktura", { perGroupLimit: 3 });
    await search("faktura", { perGroupLimit: 7, humanActor: false, agentProjectItemId: agentProject });
    await search("faktura", { humanActor: undefined });

    expect(
      recorder.requests.map(({ q, limit, humanActor, agentProjectItemId }) => ({
        q,
        limit,
        humanActor,
        agentProjectItemId,
      })),
    ).toEqual([
      { q: "faktura", limit: 3, humanActor: true, agentProjectItemId: undefined },
      { q: "faktura", limit: 7, humanActor: false, agentProjectItemId: agentProject },
      { q: "faktura", limit: 4, humanActor: false, agentProjectItemId: undefined },
    ]);
    // The builder is the shared one: it binds the searchable words of the query from the position it is given.
    expect(recorder.requests[0]?.buildQuery(5).params).toEqual(["faktura"]);
    expect(recorder.requests[0]?.buildQuery(5).sql).toContain("$5");
  });

  it("contributes nothing for a requested type without a registration, and no error", async () => {
    registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
    await createTask("Faktura úkol");

    expect(typesOf(await search("faktura"))).toEqual(["task"]);
    expect(await search("faktura", { scope: ["mail", "chat", "event"] })).toEqual({ groups: [] });
  });

  it("never returns an item of another tenant's data from a registered item group, whichever tenant asks", async () => {
    registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
    const mine = await createTask("Faktura úkol");
    const theirs = await createTask("Faktura jiného uživatele", other);

    const asMe = await search("faktura");
    const asThem = await search("faktura", {}, other);

    expect(itemIdsOf(asMe)).toContain(mine);
    expect(itemIdsOf(asMe)).not.toContain(theirs);
    expect(itemIdsOf(asThem)).toContain(theirs);
    expect(itemIdsOf(asThem)).not.toContain(mine);
  });
});

describe("the cursor of a thread group", () => {
  it("hands the token to prepare and the parsed cursor to the run for the scope of exactly that group, and a token of no other scope", async () => {
    const entries = fixtureThreads("Faktura", 6);
    const recorder = newRecorder();
    registerThreadSearchGroup(fixtureGroup("mail", entries, recorder));
    registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });

    const page = await search("faktura", { scope: ["mail"], perGroupLimit: 2, cursor: "offset:2" });

    expect(recorder.prepared).toEqual(["offset:2"]);
    expect(page).toEqual({ groups: [{ type: "mail", total: 6, items: entries.slice(2, 4), nextCursor: "offset:4" }] });

    recorder.prepared.length = 0;
    await search("faktura");
    await search("faktura", { scope: ["mail", "task"] });
    expect(recorder.prepared).toEqual([undefined, undefined]);
    recorder.prepared.length = 0;
    await search("faktura", { scope: ["task"] });
    expect(recorder.prepared).toEqual([]);
  });

  it("refuses a token the group's prepare refuses for a person, for an agent and for a query without a searchable word, and runs nothing", async () => {
    const recorder = newRecorder();
    registerThreadSearchGroup(fixtureGroup("mail", fixtureThreads("Faktura", 3), recorder));
    registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
    await createTask("Faktura úkol");
    const attempts: Array<[string, Partial<SearchItemsInputWithoutQuery>]> = [
      ["faktura", { humanActor: true }],
      ["faktura", { humanActor: false }],
      ["& | ! : ' ()", { humanActor: true }],
    ];

    for (const [q, actor] of attempts) {
      const failure = await search(q, { ...actor, scope: ["mail"], cursor: "not an offset" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, q).toBeInstanceOf(ValidationError);
      expect(failure).toMatchObject({ message: "Invalid fixture cursor", details: { field: "cursor" } });
    }
    expect(recorder.prepared).toEqual(["not an offset", "not an offset", "not an offset"]);
    expect(recorder.requests).toEqual([]);
  });

  it("accepts a token of the group for a query without a searchable word and answers no groups, running nothing", async () => {
    const recorder = newRecorder();
    registerThreadSearchGroup(fixtureGroup("mail", fixtureThreads("Faktura", 3), recorder));

    expect(await search("& | ! : ' ()", { scope: ["mail"], cursor: "offset:1" })).toEqual({ groups: [] });
    expect(recorder.prepared).toEqual(["offset:1"]);
    expect(recorder.requests).toEqual([]);
  });

  it("refuses a cursor with a scope of more than one group, even a valid item cursor, and runs nothing", async () => {
    const recorder = newRecorder();
    registerThreadSearchGroup(fixtureGroup("mail", fixtureThreads("Faktura", 3), recorder));
    registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
    await createTask("Faktura jedna");
    await createTask("Faktura dvě");
    const first = await search("faktura", { scope: ["task"], perGroupLimit: 1 });
    const itemCursor = first.groups[0]?.nextCursor;
    if (itemCursor === null || itemCursor === undefined) throw new Error("Expected a cursor");
    recorder.prepared.length = 0;

    await expect(search("faktura", { scope: ["task", "mail"], cursor: itemCursor })).rejects.toMatchObject({
      message: "cursor requires a scope of exactly one type",
      details: { field: "cursor" },
    });
    expect(recorder.requests).toEqual([]);
    // The item group still continues from its own cursor when it is the only scope.
    expect(
      (await search("faktura", { scope: ["task"], perGroupLimit: 1, cursor: itemCursor })).groups[0]?.items,
    ).toHaveLength(1);
    expect(recorder.prepared).toEqual([]);
  });

  it("checks the token of a scope of exactly one type without a registration in the item cursor shape", async () => {
    await expect(search("faktura", { scope: ["mail"], cursor: "not a token!" })).rejects.toMatchObject({
      message: "cursor is not a valid search cursor",
      details: { field: "cursor" },
    });
  });
});
