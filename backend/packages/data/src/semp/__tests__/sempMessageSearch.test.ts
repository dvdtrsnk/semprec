import { copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { createUser } from "../../auth/usersStore.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createPool, withTransaction } from "../../db/pool.js";
import { runMigrations } from "../../db/migrate.js";
import { createHeartbeat } from "../../scheduler/schedulerStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createSempChatThread, sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { ensureQueueSchema } from "@alldots/queue";
import { claimSempMessage, finishSempMessageTurn } from "../sempMessagesStore.js";
import { buildSempThreadMessageSearch, sempMessageSearchVectorSql } from "../sempMessageSearch.js";
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

function inTenant<T>(tenant: string, fn: (client: PoolClient) => Promise<T>, pool: Pool = data): Promise<T> {
  return runInTenant(tenant, () => withTransaction(pool, fn));
}

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

async function insertSystemMessageWithText(
  tenant: string,
  threadId: string,
  text: string,
  withVector: boolean,
): Promise<string> {
  return inTenant(tenant, async (client) => {
    // Raw SQL: no production writer gives a system message text or a vector, but the table allows both.
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

async function queuedAssistantIds(tenant: string, threadId: string): Promise<string[]> {
  const messages = await storedMessages(tenant, threadId);
  return messages.filter((message) => message.role === "assistant").map((message) => message.id);
}

/**
 * ~900,000 characters of distinct words, more than a tsvector can hold. "pocatecni" is first, "w00rs" inside the
 * indexed prefix, "zaverecne" last, far beyond it.
 */
const HUGE_TEXT = [
  "pocatecni",
  ...Array.from({ length: 150_000 }, (_, n) => `w${n.toString(36).padStart(4, "0")}`),
  "zaverecne",
].join(" ");

/** Filler longer than the 140 code points of the preview window, so a word after it is not in the preview. */
const PAST_PREVIEW = "vyplnek ".repeat(20);

/** Tick-thread heartbeats need a user and the system seed. */
async function seedOwnTenant(): Promise<void> {
  await createUser(admin, { tenantId: own, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
  await runInTenant(own, () => seedSystem(data));
}

async function startTickRun(name: string) {
  return inTenant(own, async (client) => {
    const inbox = await getDatabaseByModuleId(client, "inbox");
    if (!inbox?.ownerProjectItemId) throw new Error("Missing Alldots project");
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
    data = await createRuntimeRolePool(admin, "alldots_data");
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
        expect(await finishSempMessageTurn(client, failedId, { status: "error" })).toBe(true);
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
  });

  describe("matching in the thread list", () => {
    it("finds a thread by a word without its diacritics and by a prefix", async () => {
      // A later message follows each text, so only the message rule can find these words.
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
      // The preview reads the last message, so a message follows each system message and only the message rule is left.
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
      // Planned on the superuser pool: under RLS Postgres evaluates the tenant policy before non-leakproof operators
      // like `@@`, so it never uses them as index conditions. This only checks the statement is index-shaped; other
      // scans are turned off because the cost-based choice depends on sampled statistics.
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

  async function activateHunspell(pool: Pool): Promise<boolean> {
    const { rows } = await pool.query<{ active: boolean }>("SELECT activate_czech_hunspell_search() AS active");
    if (!rows[0]) throw new Error("activate_czech_hunspell_search() returned no row");
    return rows[0].active;
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
          expect(await activateHunspell(pool)).toBe(true);
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
});
