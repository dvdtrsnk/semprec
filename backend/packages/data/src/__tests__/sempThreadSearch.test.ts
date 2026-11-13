import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant, type SearchGroup, type SearchGroupType, type SearchOutput } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser, updateUserLocale } from "../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { logger } from "../search/logger.js";
import { searchItemGroups, type SearchItemGroupsInput } from "../search/searchItemsQuery.js";
import { seedSystem } from "../seed/seedSystem.js";
import { finishTickRunWithMessage, getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import { createSempChatThread, sendSempMessage } from "../sempThreads/sempThreadsStore.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../systemSettings.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let other: string;

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  cp = createChokePoint(pool);
  const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
}, 120_000);
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  other = await createTestTenant(admin);
  await runInTenant(tenant, () => seedSystem(pool));
  await runInTenant(other, () => seedSystem(pool));
}, 120_000);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

const ALL_SCOPE: SearchGroupType[] = ["task", "event", "project", "area", "contact", "journal", "file", "mail", "chat"];

/** Searches as a person of `tenantId` (tenant zero by default), unless the input says otherwise. */
function search(
  q: string,
  input: Partial<Omit<SearchItemGroupsInput, "q">> = {},
  tenantId: string = tenant,
): Promise<SearchOutput> {
  return runInTenant(tenantId, () =>
    searchItemGroups(pool, { q, scope: ALL_SCOPE, perGroupLimit: 4, humanActor: true, ...input }),
  );
}

/** The thread-backed groups share one schema member, so the group is narrowed by its `type` at run time. */
type ChatGroup = Extract<SearchGroup, { type: "mail" | "chat" }>;

function chatGroupOf(output: SearchOutput): ChatGroup {
  const group = output.groups.find((candidate): candidate is ChatGroup => candidate.type === "chat");
  if (!group) throw new Error("No chat group in the answer");
  return group;
}

const threadIdsOf = (group: ChatGroup): string[] => group.items.map((item) => item.threadId);

/** The ids of the chat threads a person of `tenantId` finds for `q`; none when the answer has no chat group. */
async function found(q: string, tenantId: string = tenant): Promise<string[]> {
  const group = (await search(q, { scope: ["chat"], perGroupLimit: 50 }, tenantId)).groups[0];
  return group?.type === "chat" ? threadIdsOf(group) : [];
}

interface ThreadOptions {
  /** The stored title; only a chat thread has one. */
  title?: string;
  /** The user messages sent to the thread, oldest first. */
  messages?: readonly string[];
  /** `last_activity_at`, set after the messages. */
  lastActivityAt?: string;
}

/** A chat thread whose user messages are written through the production send path. */
async function chatThread(options: ThreadOptions = {}, tenantId: string = tenant): Promise<string> {
  const threadId = await runInTenant(tenantId, () => withTransaction(pool, (client) => createSempChatThread(client)));
  for (const text of options.messages ?? []) {
    await runInTenant(tenantId, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { threadId, text, context: [], hasContext: false })),
    );
  }
  await shapeThread(threadId, options);
  return threadId;
}

/** Raw SQL: only the title job writes a chat title, through a model call, and no write sets `last_activity_at` to a chosen instant. */
async function shapeThread(threadId: string, options: ThreadOptions): Promise<void> {
  if (options.title !== undefined) {
    await admin.query("UPDATE semp_threads SET title = $2 WHERE id = $1", [threadId, options.title]);
  }
  if (options.lastActivityAt !== undefined) {
    await admin.query("UPDATE semp_threads SET last_activity_at = $2::timestamptz WHERE id = $1", [
      threadId,
      options.lastActivityAt,
    ]);
  }
}

async function inboxDatabaseId(tenantId: string): Promise<string> {
  const inbox = await runInTenant(tenantId, () =>
    withTransaction(pool, (client) => getDatabaseByModuleId(client, "inbox")),
  );
  if (!inbox) throw new Error("Missing seeded Inbox database");
  return inbox.id;
}

/** An Inbox item with `text` and the item thread that discusses it, written through the production send path. */
async function itemThread(
  text: string,
  options: ThreadOptions = {},
  tenantId: string = tenant,
): Promise<{ threadId: string; inboxItemId: string }> {
  const databaseId = await inboxDatabaseId(tenantId);
  const inboxItemId = (
    await runInTenant(tenantId, () =>
      withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId, properties: { date: "2026-01-01", time: "12:00", text } }),
      ),
    )
  ).id;
  const sent = await runInTenant(tenantId, () =>
    withTransaction(pool, (client) =>
      sendSempMessage(client, {
        subject: { inboxItemId },
        text: options.messages?.[0] ?? "Co s tím?",
        context: [],
        hasContext: false,
      }),
    ),
  );
  await shapeThread(sent.threadId, options);
  return { threadId: sent.threadId, inboxItemId };
}

/** The user of tenant zero, whom a run is attributed to and whose `users.locale` titles the threads. */
async function createTenantUser(): Promise<string> {
  return (await createUser(admin, { tenantId: tenant, email: "chat-search@example.test", passwordHash: "unused" })).id;
}

/** The tick thread (automatic task log) of a heartbeat called `name`, holding the reply `text` of a finished run. */
async function tickThread(name: string, text: string): Promise<string> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const inbox = await getDatabaseByModuleId(client, "inbox");
      if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
      const heartbeat = await createHeartbeat(client, {
        projectItemId: inbox.ownerProjectItemId,
        name,
        rule: { kind: "interval", minutes: 10 },
        actionId: "core.agentRun",
      });
      const thread = await getOrCreateTickThread(client, heartbeat.id);
      const run = await createAgentRun(client, {
        projectItemId: inbox.ownerProjectItemId,
        heartbeatId: heartbeat.id,
        triggeredBy: "heartbeat",
        task: "tick",
      });
      await finishTickRunWithMessage(client, {
        thread,
        agentRunId: run.id,
        outcome: { status: "done", result: text },
      });
      return thread.id;
    }),
  );
}

async function createTask(name: string): Promise<string> {
  return runInTenant(tenant, async () => {
    const tasks = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks"));
    if (!tasks) throw new Error("Missing seeded Tasks database");
    return (await cp.createItem({ databaseId: tasks.id, properties: { name } })).id;
  });
}

async function setTimezone(timezone: string): Promise<void> {
  await runInTenant(tenant, async () => {
    const settings = await withTransaction(pool, async (client) => ({
      databaseId: await getSystemSettingsDatabaseId(client),
      itemId: await getSystemSettingsItemId(client),
    }));
    await cp.updateItem({ ...settings, propertiesPatch: { timezone } });
  });
}

describe("the chat group of global search (issue #1854)", () => {
  describe("what matches", () => {
    it("returns a thread whose title matches with its id, title, snippet null and last activity as date and time parts", async () => {
      const threadId = await chatThread({
        title: "Plánování dovolené",
        messages: ["Ahoj"],
        lastActivityAt: "2026-10-16T08:30:00.000000Z",
      });
      await chatThread({ title: "Daňové přiznání", messages: ["Ahoj"] });

      const answer = await search("plánování");

      expect(answer.groups.map((group) => group.type)).toEqual(["chat"]);
      expect(chatGroupOf(answer)).toEqual({
        type: "chat",
        total: 1,
        items: [
          {
            threadId,
            title: "Plánování dovolené",
            subtitleParts: [
              { kind: "date", value: "2026-10-16" },
              { kind: "time", value: "10:30" },
            ],
            snippet: null,
          },
        ],
        nextCursor: null,
      });
    });

    it("writes the last activity in the user's time zone, so it can fall on another day than in UTC", async () => {
      const threadId = await chatThread({ title: "Večerní plán", lastActivityAt: "2026-10-16T23:30:00.000000Z" });
      const subtitleOf = async () =>
        chatGroupOf(await search("plán")).items.find((item) => item.threadId === threadId)?.subtitleParts;

      expect(await subtitleOf()).toEqual([
        { kind: "date", value: "2026-10-17" },
        { kind: "time", value: "01:30" },
      ]);
      await setTimezone("America/New_York");
      expect(await subtitleOf()).toEqual([
        { kind: "date", value: "2026-10-16" },
        { kind: "time", value: "19:30" },
      ]);
    });

    it("finds a thread by a word that only its preview holds, the last message with text, and not by an earlier message", async () => {
      const previewed = await chatThread({ title: "Nákupy", messages: ["Zaplatit fakturu", "Objednat vstupenky"] });

      expect(await found("vstupenky")).toEqual([previewed]);
      // The earlier message is not the preview: message text is a separate search (issue #1783).
      expect(await found("fakturu")).toEqual([]);
    });

    it("searches the first 140 code points of the preview and no further", async () => {
      const inside = "a".repeat(100);
      const threadId = await chatThread({ messages: [`${inside} blizko ${"b".repeat(60)} daleko`] });

      expect(await found("blizko")).toEqual([threadId]);
      expect(await found("daleko")).toEqual([]);
    });

    it("matches without diacritics, by the start of a word and on every word of the query", async () => {
      const threadId = await chatThread({ title: "Účetnictví a daňové přiznání" });

      expect(await found("ucetnictvi")).toEqual([threadId]);
      expect(await found("dan")).toEqual([threadId]);
      expect(await found("UCETNIC prizn")).toEqual([threadId]);
      expect(await found("ucetnictvi dovolena")).toEqual([]);
    });

    it("takes the title and the preview each alone, as the thread list does, so words split between them do not match", async () => {
      await chatThread({ title: "Dovolená", messages: ["Itálie"] });

      expect(await found("dovolena")).toHaveLength(1);
      expect(await found("italie")).toHaveLength(1);
      expect(await found("dovolena italie")).toEqual([]);
    });

    it("treats query syntax as text and finds nothing for a query without a searchable word", async () => {
      const threadId = await chatThread({ title: "Plán dovolené" });

      expect(await found("(plán & | ! : ' dovolené)")).toEqual([threadId]);
      expect(await found("& | ! : ' ()")).toEqual([]);
    });

    it("finds an Inbox item thread by the text of its Inbox item, titled by the user's locale, and not by the words of the template", async () => {
      const { threadId } = await itemThread("Koupit mléko");

      expect(await found("mleko")).toEqual([threadId]);
      expect(await found("uprava")).toEqual([]);
      // No user is bound to tenant zero yet, so the title is in the locale column default.
      expect(chatGroupOf(await search("mleko")).items.map((item) => item.title)).toEqual(["Úprava: Koupit mléko"]);

      await updateUserLocale(admin, await createTenantUser(), "en");
      expect(chatGroupOf(await search("mleko")).items.map((item) => item.title)).toEqual(["Edit: Koupit mléko"]);
    });

    it("gives an Inbox item thread whose item is in the trash no title, and still finds it by its preview", async () => {
      const { threadId, inboxItemId } = await itemThread("Koupit mléko", { messages: ["Pošli to dál"] });
      await runInTenant(tenant, async () => {
        await cp.softDeleteItem(await inboxDatabaseId(tenant), inboxItemId);
      });

      expect(await found("mleko")).toEqual([]);
      const group = chatGroupOf(await search("posli"));
      expect(group.items).toMatchObject([{ threadId, title: "" }]);
    });

    it("gives a thread without a stored title an empty title when its preview matches", async () => {
      const threadId = await chatThread({ messages: ["Zavolat Petrovi"] });

      expect(chatGroupOf(await search("petrovi")).items).toMatchObject([{ threadId, title: "" }]);
    });

    it("searches only the start of a very long title, because the whole text is too big to index", async () => {
      // Distinct words: about 1.3 million characters would exceed the 1 MiB limit of a tsvector if all were indexed.
      const title = Array.from({ length: 200_000 }, (_, index) => `w${index}`).join(" ");
      const threadId = await chatThread({ title });

      expect(await found("w5")).toEqual([threadId]);
      expect(await found("w199999")).toEqual([]);
    });
  });

  describe("what is never returned", () => {
    it("leaves out a tick thread, which the thread list hides by default, and returns a chat thread of the same words", async () => {
      await createTenantUser();
      await tickThread("Ranní kontrola", "Kontrola proběhla bez nálezu");
      const chat = await chatThread({ messages: ["Kontrola proběhla bez nálezu"] });

      expect(await found("nalezu")).toEqual([chat]);
    });

    it("never returns another tenant's threads, whichever tenant searches", async () => {
      const mine = await chatThread({ title: "Společná dovolená" });
      const theirs = await chatThread({ title: "Společná dovolená" }, other);
      const theirItem = await itemThread("Společná dovolená", {}, other);

      expect(await found("dovolena")).toEqual([mine]);
      expect((await found("dovolena", other)).sort()).toEqual([theirs, theirItem.threadId].sort());
      const total = (tenantId: string) =>
        search("dovolena", { scope: ["chat"] }, tenantId).then((answer) => chatGroupOf(answer).total);
      expect([await total(tenant), await total(other)]).toEqual([1, 2]);
    });

    it("gives the chat group only to a person, and returns it to a person in the same search", async () => {
      const threadId = await chatThread({ title: "Plánování dovolené" });

      expect(threadIdsOf(chatGroupOf(await search("plánování")))).toEqual([threadId]);
      for (const actor of [{ humanActor: false }, { humanActor: undefined }] as const) {
        expect((await search("plánování", actor)).groups).toEqual([]);
        expect((await search("plánování", { ...actor, scope: ["chat"] })).groups).toEqual([]);
      }
    });

    it("gives no chat group to a person whose scope leaves it out, and leaves the item groups alone when it is in", async () => {
      await chatThread({ title: "Faktura za byt" });
      const taskId = await createTask("Faktura");

      const withoutChat = await runInTenant(tenant, () =>
        searchItemGroups(pool, { q: "faktura", scope: ["task"], perGroupLimit: 4, humanActor: true }),
      );
      expect(withoutChat.groups.map((group) => group.type)).toEqual(["task"]);
      const both = await runInTenant(tenant, () =>
        searchItemGroups(pool, { q: "faktura", scope: ["chat", "task"], perGroupLimit: 4, humanActor: true }),
      );
      expect(both.groups.map((group) => group.type)).toEqual(["task", "chat"]);
      expect(both.groups[0]).toMatchObject({ items: [{ itemId: taskId }] });
    });
  });

  describe("paging", () => {
    it("lists the matches of scope chat newest first, in pages that follow nextCursor, with the total on every page", async () => {
      const ids: string[] = [];
      for (const [index, day] of ["10", "12", "14", "16", "18"].entries()) {
        ids.push(await chatThread({ title: `Dovolená ${index}`, lastActivityAt: `2026-10-${day}T10:00:00.000000Z` }));
      }
      const expected = [...ids].reverse();

      const seen: string[] = [];
      let cursor: string | undefined;
      const sizes: number[] = [];
      do {
        const group = chatGroupOf(await search("dovolena", { scope: ["chat"], perGroupLimit: 2, cursor }));
        expect(group.total).toBe(5);
        seen.push(...threadIdsOf(group));
        sizes.push(group.items.length);
        cursor = group.nextCursor ?? undefined;
      } while (cursor !== undefined && sizes.length < 10);

      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(expected);
    });

    it("breaks a tie of last activity by thread id, and the cursor continues across the tie", async () => {
      const same = "2026-10-16T10:00:00.123456Z";
      const ids = [
        await chatThread({ title: "Dovolená A", lastActivityAt: same }),
        await chatThread({ title: "Dovolená B", lastActivityAt: same }),
        await chatThread({ title: "Dovolená C", lastActivityAt: same }),
      ];

      const paged: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const group = chatGroupOf(await search("dovolena", { scope: ["chat"], perGroupLimit: 1, cursor }));
        paged.push(...threadIdsOf(group));
        cursor = group.nextCursor ?? undefined;
        if (cursor === undefined) break;
      }

      expect(paged).toEqual([...ids].sort().reverse());
    });

    it("without a scope shows at most perGroupLimit threads and the real total, and nothing follows the last page", async () => {
      for (let n = 0; n < 6; n += 1) await chatThread({ title: `Dovolená ${n}` });

      const group = chatGroupOf(await search("dovolena"));
      expect([group.total, group.items.length]).toEqual([6, 4]);
      expect(group.nextCursor).toEqual(expect.any(String));
      const all = chatGroupOf(await search("dovolena", { scope: ["chat"], perGroupLimit: 50 }));
      expect([all.total, all.items.length, all.nextCursor]).toEqual([6, 6, null]);
    });

    it("answers a cursor past the last thread with the total and no items", async () => {
      await chatThread({ title: "Dovolená", lastActivityAt: "2026-10-16T10:00:00.000000Z" });
      const first = chatGroupOf(await search("dovolena", { scope: ["chat"], perGroupLimit: 1 }));
      const beyond = Buffer.from("2000-01-01T00:00:00.000000Z|00000000-0000-0000-0000-000000000000").toString(
        "base64url",
      );

      const group = chatGroupOf(await search("dovolena", { scope: ["chat"], perGroupLimit: 1, cursor: beyond }));

      expect(first.nextCursor).toBeNull();
      expect([group.total, group.items, group.nextCursor]).toEqual([1, [], null]);
    });

    it("refuses a cursor that is not a thread-list cursor for the chat scope, and a chat cursor for another scope", async () => {
      await chatThread({ title: "Dovolená" });
      await createTask("Dovolená 1");
      await createTask("Dovolená 2");
      const itemCursor = (await search("dovolena", { scope: ["task"], perGroupLimit: 1 })).groups[0]?.nextCursor;
      if (!itemCursor) throw new Error("The task group has no cursor");
      const chatCursor = Buffer.from("2026-10-16T10:00:00.000000Z|00000000-0000-0000-0000-000000000000").toString(
        "base64url",
      );

      await expect(search("dovolena", { scope: ["chat"], cursor: itemCursor })).rejects.toMatchObject({
        details: { field: "cursor" },
      });
      await expect(search("dovolena", { scope: ["chat"], cursor: "not a token!" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(search("dovolena", { scope: ["task"], cursor: chatCursor })).rejects.toMatchObject({
        details: { field: "cursor" },
      });
      await expect(search("dovolena", { scope: ["chat", "task"], cursor: chatCursor })).rejects.toMatchObject({
        details: { field: "cursor" },
      });
    });

    it("refuses a cursor that is not a thread-list cursor for the chat scope whoever asks and whatever the query says", async () => {
      await chatThread({ title: "Dovolená" });

      for (const actor of [{ humanActor: false }, { humanActor: undefined }, { humanActor: true }] as const) {
        for (const q of ["dovolena", "& | ! :", "zzzneexistuje"]) {
          await expect(search(q, { ...actor, scope: ["chat"], cursor: "not a token!" })).rejects.toMatchObject({
            details: { field: "cursor" },
          });
        }
      }
    });
  });

  describe("the query text", () => {
    it("is not logged or echoed in a refusal, and the log line counts the chat results", async () => {
      await chatThread({ title: "Zeměpis dopis" });
      const calls: unknown[][] = [];
      for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
        vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          calls.push([level, ...args]);
        });
      }

      await search("zeměpis");
      const failure = await search("zeměpis", { scope: ["chat"], cursor: "not a token!" }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ValidationError);
      expect(JSON.stringify(failure)).not.toContain("zeměpis");
      expect((failure as Error).message).not.toContain("zeměpis");
      expect(calls).toEqual([
        ["info", { queryLength: 7, groupCount: 1, resultCount: 1, totalMatches: 1 }, "Global search completed"],
      ]);
      expect(JSON.stringify(calls)).not.toContain("zeměpis");
    });
  });
});
