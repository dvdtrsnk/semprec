import { copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createPool, withTransaction } from "../../db/pool.js";
import { runMigrations } from "../../db/migrate.js";
import { activateCzechHunspellSearch } from "../../mail/czechHunspellSearch.js";
import { createHeartbeat } from "../../scheduler/schedulerStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createSempChatThread, sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { ensureQueueSchema } from "@semprec/queue";
import { claimSempMessage, finishSempMessageTurn } from "../sempMessagesStore.js";
import {
  buildSempThreadMessageSearch,
  reindexSempMessageSearch,
  sempMessageSearchVectorSql,
} from "../sempMessageSearch.js";
import { listSempThreads } from "../sempThreadsListStore.js";
import { finishTickRunWithMessage, getOrCreateTickThread } from "../sempTickThreadStore.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "__tests__",
  "fixtures",
  "czech-hunspell",
);
const ASSET_FILES = ["cs_cz.dict", "cs_cz.affix"];
// A database of its own is created and migrated per Hunspell test; that can take well past 30 s.
const FRESH_DATABASE_TEST_TIMEOUT_MS = 120_000;

let admin: Pool;
let data: Pool;
let own: string;
let foreign: string;

/** Runs `fn` in a managed transaction of the runtime-role pool, scoped to `tenant`. */
function inTenant<T>(tenant: string, fn: (client: PoolClient) => Promise<T>, pool: Pool = data): Promise<T> {
  return runInTenant(tenant, () => withTransaction(pool, fn));
}

/** The ids of the threads the list returns for `search`, newest activity first. */
async function findThreads(tenant: string, search: string, pool: Pool = data): Promise<string[]> {
  const page = await inTenant(
    tenant,
    (client) =>
      listSempThreads(client, {
        kinds: ["chat", "item", "tick"],
        subjectInboxItemId: null,
        search,
        cursor: null,
        limit: 100,
        locale: "en",
      }),
    pool,
  );
  return page.rows.map((row) => row.id);
}

async function sendMessage(tenant: string, threadId: string, text: string, pool: Pool = data): Promise<void> {
  await inTenant(tenant, (client) => sendSempMessage(client, { threadId, text, context: [], hasContext: false }), pool);
}

/** A chat thread whose user messages say `texts`, written through the production send path. */
async function startThread(tenant: string, texts: readonly string[], pool: Pool = data): Promise<string> {
  const threadId = await inTenant(tenant, (client) => createSempChatThread(client), pool);
  for (const text of texts) await sendMessage(tenant, threadId, text, pool);
  return threadId;
}

interface StoredMessage {
  id: string;
  role: string;
  text: string | null;
  has_vector: boolean;
}

async function storedMessages(tenant: string, threadId: string, pool: Pool = data): Promise<StoredMessage[]> {
  return inTenant(
    tenant,
    async (client) =>
      (
        await client.query<StoredMessage>(
          `SELECT id, role, text, search_vector IS NOT NULL AS has_vector FROM semp_messages
            WHERE thread_id = $1 ORDER BY created_at, id`,
          [threadId],
        )
      ).rows,
    pool,
  );
}

async function vectorText(tenant: string, messageId: string, pool: Pool = data): Promise<string | null> {
  const rows = await inTenant(
    tenant,
    async (client) =>
      (
        await client.query<{ vector: string | null }>(
          "SELECT search_vector::text AS vector FROM semp_messages WHERE id = $1",
          [messageId],
        )
      ).rows,
    pool,
  );
  if (!rows[0]) throw new Error(`Message ${messageId} is missing`);
  return rows[0].vector;
}

/** Inserts a system message that carries text. */
async function insertSystemMessageWithText(
  tenant: string,
  threadId: string,
  text: string,
  withVector: boolean,
): Promise<string> {
  return inTenant(tenant, async (client) => {
    // Raw SQL: no production writer gives a system message text or a vector; the table allows both,
    // and this is the state the "system messages are not matched" rule has to hold against.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO semp_messages (thread_id, role, system_key, system_params, text, search_vector)
       VALUES ($1, 'system', 'test.system', '{}'::jsonb, $2::text,
               CASE WHEN $3::boolean THEN to_tsvector('simple', $2::text) END)
       RETURNING id`,
      [threadId, text, withVector],
    );
    if (!rows[0]) throw new Error("No system message inserted");
    return rows[0].id;
  });
}

/** The assistant message the send path queued for the thread, in the order it was written. */
async function queuedAssistantIds(tenant: string, threadId: string): Promise<string[]> {
  const messages = await storedMessages(tenant, threadId);
  return messages.filter((message) => message.role === "assistant").map((message) => message.id);
}

/**
 * A text far longer than a tsvector can hold: about 900,000 characters of distinct five-character
 * words, which makes Postgres refuse a vector of the whole text ("string is too long for
 * tsvector"). "pocatecni" is the first word, "w00rs" lies inside the indexed prefix, and "zaverecne"
 * is the last word, far beyond it.
 */
const HUGE_TEXT = [
  "pocatecni",
  ...Array.from({ length: 150_000 }, (_, n) => `w${n.toString(36).padStart(4, "0")}`),
  "zaverecne",
].join(" ");

/** Filler longer than the 140 code points of the preview window, so a word after it is not in the preview. */
const PAST_PREVIEW = "vyplnek ".repeat(20);

/** Gives the own tenant a user and the system seed, which the heartbeats of tick threads need. */
async function seedOwnTenant(): Promise<void> {
  await createUser(admin, { tenantId: own, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
  await runInTenant(own, () => seedSystem(data));
}

/** A heartbeat with its tick thread and an open agent run, ready for `finishTickRunWithMessage`. */
async function startTickRun(name: string) {
  return inTenant(own, async (client) => {
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
    return { thread, runId: run.id };
  });
}

describe("Semp message search vector", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:semp-message-search-role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    own = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
  });
  afterAll(async () => {
    const results = await Promise.allSettled([data.end(), admin.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Semp message search cleanup failed", { cause: errors[0] });
  });

  describe("maintenance on every write of message text", () => {
    it("sets the vector of a user message and leaves the queued assistant message without one", async () => {
      const threadId = await startThread(own, ["Zaplatit fakturu", "Hotovo"]);
      const messages = await storedMessages(own, threadId);
      expect(messages.map((message) => [message.role, message.text, message.has_vector])).toEqual([
        ["user", "Zaplatit fakturu", true],
        ["assistant", null, false],
        ["user", "Hotovo", true],
        ["assistant", null, false],
      ]);
      expect(await findThreads(own, "zaplatit")).toEqual([threadId]);
    });

    it("makes the thread findable by the text of an assistant message once the worker writes it", async () => {
      const threadId = await startThread(own, ["Co je nového"]);
      const [assistantId] = await queuedAssistantIds(own, threadId);
      if (!assistantId) throw new Error("No queued assistant message");
      expect(await findThreads(own, "pondeli")).toEqual([]);
      expect(
        await inTenant(own, async (client) => {
          expect(await claimSempMessage(client, threadId, assistantId)).toBe(true);
          return finishSempMessageTurn(client, assistantId, {
            status: "done",
            text: `${PAST_PREVIEW}Schůzka je v pondělí`,
            lastEventId: "1",
          });
        }),
      ).toBe(true);
      expect(await vectorText(own, assistantId)).toContain("'pondeli'");
      expect(await findThreads(own, "pondeli")).toEqual([threadId]);
    });

    it("keeps no vector for an assistant message that finishes without text or in error", async () => {
      const finishedEmpty = await startThread(own, ["Ahoj"]);
      const failed = await startThread(own, ["Ahoj znovu"]);
      const [emptyId] = await queuedAssistantIds(own, finishedEmpty);
      const [failedId] = await queuedAssistantIds(own, failed);
      if (!emptyId || !failedId) throw new Error("No queued assistant message");
      await inTenant(own, async (client) => {
        expect(await claimSempMessage(client, finishedEmpty, emptyId)).toBe(true);
        expect(await finishSempMessageTurn(client, emptyId, { status: "done", text: null, lastEventId: "1" })).toBe(
          true,
        );
        expect(await claimSempMessage(client, failed, failedId)).toBe(true);
        expect(await finishSempMessageTurn(client, failedId, { status: "error", interrupted: false })).toBe(true);
      });
      expect(await vectorText(own, emptyId)).toBeNull();
      expect(await vectorText(own, failedId)).toBeNull();
    });

    it("sets the vector of a tick reply and leaves a failed run's message without one", async () => {
      await seedOwnTenant();
      const ok = await startTickRun("Tick done");
      const failed = await startTickRun("Tick failed");
      expect(
        await inTenant(own, (client) =>
          finishTickRunWithMessage(client, {
            thread: ok.thread,
            agentRunId: ok.runId,
            outcome: { status: "done", result: `${PAST_PREVIEW}Kontrola prosla bez nalezu` },
          }),
        ),
      ).toBe(true);
      expect(
        await inTenant(own, (client) =>
          finishTickRunWithMessage(client, {
            thread: failed.thread,
            agentRunId: failed.runId,
            outcome: { status: "error", errorCode: "modelError" },
          }),
        ),
      ).toBe(true);
      expect((await storedMessages(own, ok.thread.id)).map((message) => message.has_vector)).toEqual([true]);
      expect(
        (await storedMessages(own, failed.thread.id)).map((message) => [message.text, message.has_vector]),
      ).toEqual([[null, false]]);
      expect(await findThreads(own, "nalezu")).toEqual([ok.thread.id]);
      expect(await findThreads(own, "spojeni")).toEqual([]);
    });
  });

  describe("a message longer than a tsvector can hold", () => {
    /** The words the huge text can be found by: inside the indexed prefix, and beyond it. */
    async function expectIndexedPrefixOnly(threadId: string): Promise<void> {
      expect(await findThreads(own, "pocatecni")).toEqual([threadId]);
      expect(await findThreads(own, "w00rs")).toEqual([threadId]);
      expect(await findThreads(own, "zaverecne")).toEqual([]);
    }

    it("uses a text that Postgres cannot make one vector of, so the cases below test the bound", async () => {
      await expect(
        data.query("SELECT to_tsvector('czech', $1::text) || to_tsvector('czech_simple', $1::text)", [HUGE_TEXT]),
      ).rejects.toThrow(/too long for tsvector/);
      const bounded = await data.query<{ indexed: boolean }>(
        `SELECT ${sempMessageSearchVectorSql("$1::text")} IS NOT NULL AS indexed`,
        [HUGE_TEXT],
      );
      expect(bounded.rows).toEqual([{ indexed: true }]);
    });

    it("stores a user message whole and indexes its first code points", async () => {
      const threadId = await startThread(own, [HUGE_TEXT]);
      const [user] = await storedMessages(own, threadId);
      expect(user?.text).toBe(HUGE_TEXT);
      expect(user?.has_vector).toBe(true);
      await expectIndexedPrefixOnly(threadId);
    });

    it("stores the text of an assistant message whole and indexes its first code points", async () => {
      const threadId = await startThread(own, ["Co je nového"]);
      const [assistantId] = await queuedAssistantIds(own, threadId);
      if (!assistantId) throw new Error("No queued assistant message");
      await inTenant(own, async (client) => {
        expect(await claimSempMessage(client, threadId, assistantId)).toBe(true);
        expect(
          await finishSempMessageTurn(client, assistantId, { status: "done", text: HUGE_TEXT, lastEventId: "1" }),
        ).toBe(true);
      });
      const assistant = (await storedMessages(own, threadId)).find((message) => message.id === assistantId);
      expect(assistant?.text).toBe(HUGE_TEXT);
      expect(assistant?.has_vector).toBe(true);
      await expectIndexedPrefixOnly(threadId);
    });

    it("closes a tick run with a reply longer than the limit", async () => {
      await seedOwnTenant();
      const tick = await startTickRun("Tick with a huge reply");
      expect(
        await inTenant(own, (client) =>
          finishTickRunWithMessage(client, {
            thread: tick.thread,
            agentRunId: tick.runId,
            outcome: { status: "done", result: HUGE_TEXT },
          }),
        ),
      ).toBe(true);
      const [reply] = await storedMessages(own, tick.thread.id);
      expect(reply?.text).toBe(HUGE_TEXT);
      expect(reply?.has_vector).toBe(true);
      await expectIndexedPrefixOnly(tick.thread.id);
    });

    it("reindexes a message longer than the limit together with the others of its batch", async () => {
      const threadId = await startThread(own, []);
      await inTenant(own, async (client) => {
        // Raw SQL: messages as the migration found them, text without a vector.
        await client.query(
          "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', $2), ($1, 'user', 'Kratka faktura')",
          [threadId, HUGE_TEXT],
        );
      });
      expect(
        await inTenant(own, (client) => reindexSempMessageSearch(client, { limit: 10, onlyMissing: true })),
      ).not.toBeNull();
      expect((await storedMessages(own, threadId)).map((message) => message.has_vector)).toEqual([true, true]);
      await expectIndexedPrefixOnly(threadId);
      expect(await findThreads(own, "faktura")).toEqual([threadId]);
    });
  });

  describe("matching in the thread list", () => {
    it("finds a thread by a word without its diacritics and by a prefix", async () => {
      // A later message follows each text, so the words below are in no preview and only the message
      // rule of this issue can find them.
      const receipt = await startThread(own, ["Nezapomenout účtenka z kavárny", "Posledni zprava"]);
      const other = await startThread(own, ["Něco úplně jiného", "Posledni zprava"]);
      expect(await findThreads(own, "uctenka")).toEqual([receipt]);
      expect(await findThreads(own, "ÚČTENKA")).toEqual([receipt]);
      expect(await findThreads(own, "uctenk")).toEqual([receipt]);
      expect(await findThreads(own, "kavarny")).toEqual([receipt]);
      expect(await findThreads(own, "uplne")).toEqual([other]);
    });

    it("matches a thread by the whole text of a message, not only the preview window", async () => {
      const text = `${"vyplnek ".repeat(40)}rarita na konci`;
      const threadId = await startThread(own, [text]);
      await startThread(own, ["jina zprava"]);
      expect(await findThreads(own, "rarita")).toEqual([threadId]);
    });

    it("returns the thread when the words of the query are in one message or in different messages", async () => {
      const same = await startThread(own, ["Faktura a smlouva v jedne zprave"]);
      const different = await startThread(own, ["Faktura prisla", "Smlouva ceka"]);
      const onlyOne = await startThread(own, ["Faktura prisla", "Nic dalsiho"]);
      expect(new Set(await findThreads(own, "faktura smlouva"))).toEqual(new Set([same, different]));
      expect(await findThreads(own, "faktura")).toHaveLength(3);
      expect(await findThreads(own, "faktura smlouva")).not.toContain(onlyOne);
    });

    it("does not combine the words of a query from two different threads", async () => {
      const first = await startThread(own, ["Faktura prisla"]);
      const second = await startThread(own, ["Smlouva ceka"]);
      expect(await findThreads(own, "faktura smlouva")).toEqual([]);
      expect(await findThreads(own, "faktura")).toEqual([first]);
      expect(await findThreads(own, "smlouva")).toEqual([second]);
    });

    it("matches the words of a query given in any order and with a repeated word", async () => {
      const threadId = await startThread(own, ["Smlouva ceka", "Faktura prisla"]);
      expect(await findThreads(own, "faktura smlouva")).toEqual([threadId]);
      expect(await findThreads(own, "smlouva faktura faktura")).toEqual([threadId]);
    });

    it("never matches a thread by a system message, with or without a vector, or by a message without text", async () => {
      const threadId = await startThread(own, ["Neutralni zprava"]);
      await insertSystemMessageWithText(own, threadId, "pokladna uzavrena", false);
      const poisoned = await startThread(own, ["Dalsi neutralni zprava"]);
      await insertSystemMessageWithText(own, poisoned, "pokladna otevrena", true);
      // The preview rule of the list reads the text of the last message, so a message follows each
      // system message and only the message rule of this issue is left to find the word.
      for (const id of [threadId, poisoned]) await sendMessage(own, id, "Posledni zprava");
      expect(await findThreads(own, "pokladna")).toEqual([]);
      const textless = await storedMessages(own, threadId);
      expect(textless.filter((message) => message.text === null).map((message) => message.has_vector)).toEqual([
        false,
        false,
      ]);
      expect(await findThreads(own, "neutralni")).toHaveLength(2);
    });

    it("keeps the title and preview rules: a thread matches when either rule does", async () => {
      const titled = await startThread(own, ["Bez zajimaveho slova"]);
      await inTenant(own, async (client) => {
        // Raw SQL: the title is generated by the model gateway, which this test does not run.
        await client.query("UPDATE semp_threads SET title = 'Rozpocet 2027' WHERE id = $1", [titled]);
      });
      const byMessage = await startThread(own, ["Rozpocet je hotovy"]);
      expect(new Set(await findThreads(own, "rozpocet"))).toEqual(new Set([titled, byMessage]));
      // A search without a word has no message rule, and the substring rule of the preview still applies.
      const symbols = await startThread(own, ["Cena je 100%!"]);
      expect(await findThreads(own, "%!")).toEqual([symbols]);
    });

    it("never matches another tenant's messages and never lists another tenant's thread", async () => {
      const mine = await startThread(own, ["Moje faktura"]);
      const theirs = await startThread(foreign, ["Jejich faktura", "Jejich smlouva"]);
      expect(await findThreads(own, "faktura")).toEqual([mine]);
      expect(await findThreads(foreign, "faktura")).toEqual([theirs]);
      // The second word exists only in the other tenant, so the first tenant has no thread with both.
      expect(await findThreads(own, "faktura smlouva")).toEqual([]);
      expect(await findThreads(foreign, "faktura smlouva")).toEqual([theirs]);
      // Without a tenant scope the runtime role sees no message at all.
      const unscoped = await data.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages");
      expect(unscoped.rows).toEqual([{ count: "0" }]);
    });

    it("can answer the message rule of the list query from the GIN index of the vector", async () => {
      const threadId = await startThread(own, ["Prvni zprava"]);
      await inTenant(own, async (client) => {
        // Raw SQL: volume for the planner. The production write path writes one message per call.
        await client.query(
          `INSERT INTO semp_messages (thread_id, role, text, search_vector)
           SELECT $1, 'user', 'slovo' || n::text || ' dalsi text',
                  ${sempMessageSearchVectorSql("'slovo' || n::text || ' dalsi text'")}
             FROM generate_series(1, 40000) AS n`,
          [threadId],
        );
      });
      // The table owner analyzes; the runtime role does not own the table.
      await admin.query("ANALYZE semp_messages");
      // The statement the list runs, recorded from a real call through the runtime role.
      const statements: { text: string; values: unknown[] }[] = [];
      await inTenant(own, async (client) => {
        const recording = new Proxy(client, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (property !== "query" || typeof value !== "function") return value;
            return (...args: unknown[]) => {
              const [text, values] = args;
              if (typeof text === "string" && text.includes("FROM semp_threads t") && Array.isArray(values)) {
                statements.push({ text, values });
              }
              return Reflect.apply(value, target, args);
            };
          },
        });
        await listSempThreads(recording, {
          kinds: ["chat"],
          subjectInboxItemId: null,
          search: "slovo3999 slovo3998",
          cursor: null,
          limit: 10,
          locale: "en",
        });
      });
      const listing = statements[0];
      if (!listing) throw new Error("The list query was not recorded");
      // Planned on the superuser pool, as the plan checks of the scheduler do. A runtime role is
      // subject to row-level security, and then Postgres evaluates the tenant policy before any
      // operator that is not leakproof, `@@` among them, so it never uses that operator as an index
      // condition. This check shows that the statement is shaped for the index. Which plan wins on
      // cost depends on sampled statistics, so the other scans are turned off and the question left
      // is whether the vector condition can be a bitmap index condition at all.
      const client = await admin.connect();
      let plan: string;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        await client.query("SET LOCAL enable_indexscan = off");
        await client.query("SET LOCAL enable_indexonlyscan = off");
        const explained = await client.query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (FORMAT JSON) ${listing.text}`,
          listing.values,
        );
        plan = JSON.stringify(explained.rows);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(plan).toContain("semp_messages_search_vector_idx");
      expect(plan).toContain("Bitmap Index Scan");
    });
  });

  describe("buildSempThreadMessageSearch", () => {
    it("returns null for a text without a word", () => {
      expect(buildSempThreadMessageSearch("  !?%  ", 10)).toBeNull();
    });

    it("binds each word as one parameter from the given position and never carries the text in the SQL", () => {
      const built = buildSempThreadMessageSearch("faktura'; DROP TABLE x; --", 10);
      if (!built) throw new Error("No search built");
      expect(built.params).toEqual(["faktura", "DROP", "TABLE", "x"]);
      expect(built.sql).not.toContain("DROP");
      for (const position of [10, 11, 12, 13]) expect(built.sql).toContain(`$${position}`);
      expect(built.sql).not.toContain("$14");
    });

    it("keeps a phone number as the single term the shared builder makes of it", () => {
      const built = buildSempThreadMessageSearch("tel +420 123 456 789 ok", 1);
      if (!built) throw new Error("No search built");
      expect(built.params).toEqual(["tel", "420123456789", "ok"]);
      const plain = buildSempThreadMessageSearch("tel 123 456 789 ok", 1);
      expect(plain?.params).toEqual(["tel", "420123456789", "ok"]);
      // One placeholder per term, at the position of its parameter, whatever the term is.
      for (const position of [1, 2, 3]) expect(built.sql).toContain(`$${position}`);
      expect(built.sql).not.toContain("$4");
    });

    it("makes the SQL of a term from its position alone, for a word, a long number and a prefix of digits alike", () => {
      const sqlOf = (text: string) => buildSempThreadMessageSearch(text, 7)?.sql;
      const word = sqlOf("faktura");
      expect(word).toBeDefined();
      expect(sqlOf("+420 123 456 789")).toBe(word);
      expect(sqlOf("123456789012")).toBe(word);
      expect(sqlOf("123")).toBe(word);
      expect(word).toContain("$7");
      expect(word).not.toContain("$8");
    });
  });

  describe("reindexSempMessageSearch", () => {
    /** Messages as the migration found them: text without a vector. */
    async function insertLegacyMessages(tenant: string, threadId: string, texts: readonly (string | null)[]) {
      return inTenant(tenant, async (client) => {
        const ids: string[] = [];
        for (const text of texts) {
          // Raw SQL: the production writers now set the vector; this is the state of rows written before
          // the column existed, which the backfill is for.
          const { rows } = await client.query<{ id: string }>(
            "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', $2) RETURNING id",
            [threadId, text],
          );
          if (!rows[0]) throw new Error("No legacy message inserted");
          ids.push(rows[0].id);
        }
        return ids;
      });
    }

    async function loop(
      tenant: string,
      options: { limit: number; onlyMissing: boolean; afterMessageId?: string },
    ): Promise<string[]> {
      const returned: string[] = [];
      let cursor = options.afterMessageId;
      for (let round = 0; round < 50; round += 1) {
        const last = await inTenant(tenant, (client) =>
          reindexSempMessageSearch(client, {
            limit: options.limit,
            onlyMissing: options.onlyMissing,
            ...(cursor === undefined ? {} : { afterMessageId: cursor }),
          }),
        );
        if (last === null) return returned;
        returned.push(last);
        cursor = last;
      }
      throw new Error("The reindexing did not end");
    }

    it("indexes the existing non-system messages that have text, in id order, and returns the last id of each batch", async () => {
      const threadId = await startThread(own, []);
      const legacy = await insertLegacyMessages(own, threadId, ["Stara faktura", "Stara smlouva", "Stary dopis", null]);
      const system = await insertSystemMessageWithText(own, threadId, "pokladna", false);
      // The preview rule reads the last message, so a message with a vector follows the system message.
      await sendMessage(own, threadId, "Konec");
      expect(await findThreads(own, "stara")).toEqual([]);

      const withText = legacy.slice(0, 3).sort();
      const returned = await loop(own, { limit: 2, onlyMissing: true });
      expect(returned).toEqual([withText[1], withText[2]]);
      expect(await findThreads(own, "stara faktura")).toEqual([threadId]);
      expect(await findThreads(own, "dopis")).toEqual([threadId]);
      expect(await findThreads(own, "pokladna")).toEqual([]);
      const messages = await storedMessages(own, threadId);
      expect(
        messages
          .filter((message) => message.has_vector && message.text !== "Konec")
          .map((message) => message.id)
          .sort(),
      ).toEqual(withText);
      expect(messages.find((message) => message.id === system)?.has_vector).toBe(false);
      expect(messages.find((message) => message.id === legacy[3])?.has_vector).toBe(false);
      // Run again, every message with text has a vector, so nothing is left.
      expect(await loop(own, { limit: 2, onlyMissing: true })).toEqual([]);
    });

    it("restricts onlyMissing to messages without a vector and recomputes the rest otherwise", async () => {
      const threadId = await startThread(own, []);
      const [first, second] = await insertLegacyMessages(own, threadId, ["Prvni text", "Druhy text"]);
      if (!first || !second) throw new Error("Missing legacy messages");
      await inTenant(own, async (client) => {
        // Raw SQL: a vector made from other text stands for one that an older configuration made.
        await client.query("UPDATE semp_messages SET search_vector = to_tsvector('simple', 'puvodni') WHERE id = $1", [
          first,
        ]);
      });
      await loop(own, { limit: 10, onlyMissing: true });
      expect(await vectorText(own, first)).toBe("'puvodni':1");
      expect(await vectorText(own, second)).toContain("'druhy'");
      await loop(own, { limit: 10, onlyMissing: false });
      expect(await vectorText(own, first)).toContain("'prvni'");
      expect(await vectorText(own, first)).not.toContain("puvodni");
    });

    it("starts after the cursor and leaves updated_at alone", async () => {
      const threadId = await startThread(own, []);
      const ids = (await insertLegacyMessages(own, threadId, ["Jedna", "Dve", "Tri"])).sort();
      const before = await inTenant(
        own,
        async (client) =>
          (
            await client.query<{ id: string; updated_at: Date }>(
              "SELECT id, updated_at FROM semp_messages WHERE thread_id = $1",
              [threadId],
            )
          ).rows,
      );
      const returned = await loop(own, { limit: 10, onlyMissing: true, afterMessageId: ids[0] });
      expect(returned).toEqual([ids[2]]);
      const messages = await storedMessages(own, threadId);
      expect(messages.find((message) => message.id === ids[0])?.has_vector).toBe(false);
      expect(messages.find((message) => message.id === ids[1])?.has_vector).toBe(true);
      const after = await inTenant(
        own,
        async (client) =>
          (
            await client.query<{ id: string; updated_at: Date }>(
              "SELECT id, updated_at FROM semp_messages WHERE thread_id = $1",
              [threadId],
            )
          ).rows,
      );
      const stamp = (rows: { id: string; updated_at: Date }[]) =>
        rows.map((row) => `${row.id}:${row.updated_at.toISOString()}`).sort();
      expect(stamp(after)).toEqual(stamp(before));
    });

    it("processes only the messages of the caller's tenant", async () => {
      const mine = await startThread(own, []);
      const theirs = await startThread(foreign, []);
      await insertLegacyMessages(own, mine, ["Moje faktura"]);
      const [foreignMessage] = await insertLegacyMessages(foreign, theirs, ["Jejich faktura"]);
      if (!foreignMessage) throw new Error("Missing foreign message");
      await loop(own, { limit: 10, onlyMissing: true });
      expect(await findThreads(own, "faktura")).toEqual([mine]);
      expect(await vectorText(foreign, foreignMessage)).toBeNull();
      await loop(foreign, { limit: 10, onlyMissing: true });
      expect(await findThreads(foreign, "faktura")).toEqual([theirs]);
    });

    it("processes only the messages of the scope's tenant even on a pool that row-level security does not bind", async () => {
      const mine = await startThread(own, []);
      const theirs = await startThread(foreign, []);
      const [mineId] = await insertLegacyMessages(own, mine, ["Moje faktura"]);
      const [theirId] = await insertLegacyMessages(foreign, theirs, ["Jejich faktura"]);
      if (!mineId || !theirId) throw new Error("Missing legacy messages");
      // The superuser pool bypasses row-level security, so only the tenant condition of the statement
      // keeps the foreign message out.
      const last = await inTenant(
        own,
        (client) => reindexSempMessageSearch(client, { limit: 10, onlyMissing: true }),
        admin,
      );
      expect(last).toBe(mineId);
      expect(await vectorText(own, mineId)).toContain("'faktura'");
      expect(await vectorText(foreign, theirId)).toBeNull();
    });

    it("rejects options outside the domain of the columns", async () => {
      for (const limit of [0, -1, 1.5, 2_147_483_648]) {
        await expect(
          inTenant(own, (client) => reindexSempMessageSearch(client, { limit, onlyMissing: true })),
          String(limit),
        ).rejects.toThrow();
      }
      await expect(
        inTenant(own, (client) =>
          reindexSempMessageSearch(client, { limit: 1, onlyMissing: true, afterMessageId: "not-a-uuid" }),
        ),
      ).rejects.toThrow();
    });

    it("refuses to run outside a managed transaction and outside a tenant scope", async () => {
      const client = await data.connect();
      try {
        await expect(
          runInTenant(own, () => reindexSempMessageSearch(client, { limit: 1, onlyMissing: true })),
        ).rejects.toThrow(/managed transaction/i);
      } finally {
        client.release();
      }
      await expect(
        runAsSystem("test:reindex-without-tenant", () =>
          withTransaction(data, (txClient) => reindexSempMessageSearch(txClient, { limit: 1, onlyMissing: true })),
        ),
      ).rejects.toThrow(/tenant scope/);
    });
  });
});

describe("Semp message search with the Hunspell configuration", () => {
  /** A database of its own: activation rewrites the `czech` configuration every other search reads. */
  async function withFreshDatabase(fn: (pool: Pool, tenantId: string) => Promise<void>): Promise<void> {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) throw new Error("TEST_DATABASE_URL is not set");
    // A generated hex name, so it needs no quoting beyond the identifier quotes.
    const name = `semp_search_${randomUUID().replaceAll("-", "")}`;
    const root = createPool(baseUrl);
    let failure: { error: unknown } | undefined;
    let pool: Pool | undefined;
    try {
      await root.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
      const url = new URL(baseUrl);
      url.pathname = `/${name}`;
      pool = createPool(url.toString());
      await removeAssets(pool);
      await runMigrations(pool);
      await ensureQueueSchema(pool);
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM tenants");
      const tenantId = rows[0]?.id;
      if (!tenantId) throw new Error("The scratch database has no tenant");
      await fn(pool, tenantId);
    } catch (error) {
      failure = { error };
    }
    const cleanup = [
      () => pool?.end(),
      () => root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      () => root.end(),
    ];
    for (const step of cleanup) {
      try {
        await step();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  async function sharedirTsearchData(pool: Pool): Promise<string> {
    const { rows } = await pool.query<{ setting: string }>("SELECT setting FROM pg_config WHERE name = 'SHAREDIR'");
    if (!rows[0]) throw new Error("pg_config reported no SHAREDIR");
    return path.join(rows[0].setting, "tsearch_data");
  }

  async function installAssets(pool: Pool): Promise<void> {
    const dir = await sharedirTsearchData(pool);
    for (const file of ASSET_FILES) await copyFile(path.join(FIXTURE_DIR, file), path.join(dir, file));
  }

  async function removeAssets(pool: Pool): Promise<void> {
    const dir = await sharedirTsearchData(pool);
    for (const file of ASSET_FILES) await rm(path.join(dir, file), { force: true });
  }

  it(
    "finds faktura by faktury once Hunspell is active, and uctenka by účtenka in both modes",
    async () => {
      await withFreshDatabase(async (pool, tenantId) => {
        // The účtenka message comes first and another follows it, so only the message rule finds it.
        const before = await startThread(
          tenantId,
          ["Nezapomenout účtenka z kavárny", "Poslat faktura zakaznikovi"],
          pool,
        );
        // Without the dictionary there is no stemming; the fallback still ignores diacritics.
        expect(await findThreads(tenantId, "faktury", pool)).toEqual([]);
        expect(await findThreads(tenantId, "uctenka", pool)).toEqual([before]);

        await installAssets(pool);
        try {
          expect(await activateCzechHunspellSearch(pool)).toBe(true);
          const after = await startThread(tenantId, ["Nova účtenka", "Druha faktura pro odberatele"], pool);
          expect(new Set(await findThreads(tenantId, "faktury", pool))).toEqual(new Set([before, after]));
          expect(new Set(await findThreads(tenantId, "uctenka", pool))).toEqual(new Set([before, after]));
          expect(new Set(await findThreads(tenantId, "účtenka", pool))).toEqual(new Set([before, after]));
          expect(await findThreads(tenantId, "faktury odberatele", pool)).toEqual([after]);
        } finally {
          await removeAssets(pool);
        }
      });
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the lemmas of earlier messages until they are reindexed with onlyMissing false",
    async () => {
      await withFreshDatabase(async (pool, tenantId) => {
        const early = await startThread(tenantId, ["Faktury prisly"], pool);
        const [message] = (await storedMessages(tenantId, early, pool)).filter((row) => row.role === "user");
        if (!message) throw new Error("Missing early message");
        expect(await vectorText(tenantId, message.id, pool)).toContain("'faktury'");

        await installAssets(pool);
        try {
          expect(await activateCzechHunspellSearch(pool)).toBe(true);
          // The stored vector still has the form the unaccent/simple configuration made of the word.
          expect(await findThreads(tenantId, "fakturu", pool)).toEqual([]);
          const missingOnly = await inTenant(
            tenantId,
            (client) => reindexSempMessageSearch(client, { limit: 10, onlyMissing: true }),
            pool,
          );
          expect(missingOnly).toBeNull();
          expect(await findThreads(tenantId, "fakturu", pool)).toEqual([]);

          const last = await inTenant(
            tenantId,
            (client) => reindexSempMessageSearch(client, { limit: 10, onlyMissing: false }),
            pool,
          );
          expect(last).toBe(message.id);
          expect(await vectorText(tenantId, message.id, pool)).toContain("'faktura'");
          expect(await findThreads(tenantId, "fakturu", pool)).toEqual([early]);
        } finally {
          await removeAssets(pool);
        }
      });
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );
});
