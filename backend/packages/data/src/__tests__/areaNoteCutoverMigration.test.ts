import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { deleteBlocks, readPageBlocks, writeBlock } from "@semprec/block-model";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { runAreaNoteCutoverMigration } from "../docs/areaNoteCutoverMigration.js";
import { loadDoc, mutateDoc } from "../docs/docPersistence.js";
import { getDocByItemId, getOrCreateDoc } from "../docs/docsStore.js";
import { handleItemSearchPageTextTask } from "../search/pageTextJob.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let areas: string;
let cp: ChokePoint;

const NOTE = "Klientské zakázky a vlastní produkty. Pátky bez schůzek.";

async function areasDatabaseId(tenantId: string): Promise<string> {
  const { rows } = await runInTenant(tenantId, () =>
    pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'areas'"),
  );
  if (!rows[0]) throw new Error("Areas database missing");
  return rows[0].id;
}

function createArea(tenantId: string, databaseId: string, properties: Record<string, unknown>) {
  return runInTenant(tenantId, () => cp.createItem({ databaseId, properties: { name: "Work", ...properties } }));
}

/** The area page's block texts in order, and its conversion marker; null when the area has no doc. */
async function page(tenantId: string, areaId: string) {
  return runInTenant(tenantId, async () => {
    const doc = await getDocByItemId(pool, areaId);
    if (!doc) return null;
    const ydoc = await loadDoc(pool, doc.id);
    const blocks = readPageBlocks(ydoc).filter((block) => !block.synthetic);
    const meta = ydoc.getMap<unknown>("meta");
    return {
      docId: doc.id,
      texts: blocks.map((block) => block.text.map((run) => run.insert).join("")),
      ids: blocks.map((block) => block.id),
      marker: { source: meta.get("legacyNoteSource"), blockIds: meta.get("legacyNoteBlockIds") },
    };
  });
}

async function docUpdateCount(docId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM doc_history_updates WHERE doc_id = $1",
    [docId],
  );
  return rows[0]?.n ?? 0;
}

const runCutovers = () => runAsSystem("test:area-note", () => runTenantCutoverMigrations(pool));

const pidResult = z.object({ rows: z.tuple([z.object({ pid: z.number() })]) });
const blockersResult = z.object({ rows: z.tuple([z.object({ blockers: z.array(z.number()) })]) });
const queryText = z.union([z.string(), z.object({ text: z.string() }).transform((query) => query.text)]);
const lockNotAvailable = z.object({ code: z.literal("55P03") });

/**
 * A dedicated runtime-role pool for one participant of a concurrency test. Each client it hands out reads its own
 * backend PID once (`pg_backend_pid()`) and runs `before` ahead of every statement; every statement is still sent to
 * the server unchanged and its real result returned. The client's own `query` is restored before the pool takes it
 * back.
 */
async function observedPool(before?: (sql: string) => Promise<void>): Promise<{ pool: Pool; pids: Set<number> }> {
  const observed = await createRuntimeRolePool(admin, "semprec_data");
  const pids = new Set<number>();
  const restore = new Map<object, PropertyDescriptor | undefined>();
  observed.on("acquire", (client) => {
    const delegate: unknown = Reflect.get(client, "query");
    if (typeof delegate !== "function") throw new Error("A pg client without query");
    restore.set(client, Object.getOwnPropertyDescriptor(client, "query"));
    let identified = false;
    Object.defineProperty(client, "query", {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        if (!identified) {
          identified = true;
          const own = pidResult.parse(await Reflect.apply(delegate, client, ["SELECT pg_backend_pid() AS pid"]));
          pids.add(own.rows[0].pid);
        }
        await before?.(queryText.parse(args[0]));
        return Reflect.apply(delegate, client, args);
      },
    });
  });
  observed.on("release", (_error, client) => {
    const own = restore.get(client);
    restore.delete(client);
    if (own) Object.defineProperty(client, "query", own);
    else Reflect.deleteProperty(client, "query");
  });
  return { pool: observed, pids };
}

/** A one-shot hold: `reached` resolves when `hold` is first awaited, which then waits for `release`. */
function barrier() {
  let reachedNow!: () => void;
  const reached = new Promise<void>((resolve) => (reachedNow = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let used = false;
  return {
    reached,
    release,
    async hold(): Promise<void> {
      if (used) return;
      used = true;
      reachedNow();
      await released;
    },
  };
}

/** Rejects when `promise` has not settled within `ms`, naming what the test waited for. */
async function bounded<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls, at most 200 times 25 ms apart, until every participant has a backend whose blocking PIDs are not empty and
 * all belong to this test (`owned`). Waits are matched by PID, never by a role-wide count.
 */
async function waitUntilBlocked(participants: ReadonlyArray<ReadonlySet<number>>, owned: () => ReadonlySet<number>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const ours = owned();
    let blocked = 0;
    for (const pids of participants) {
      for (const pid of pids) {
        const result = blockersResult.parse(await admin.query("SELECT pg_blocking_pids($1) AS blockers", [pid]));
        const { blockers } = result.rows[0];
        if (blockers.length > 0 && blockers.every((blocker) => ours.has(blocker))) {
          blocked++;
          break;
        }
      }
    }
    if (blocked === participants.length) return;
    await sleep(25);
  }
  throw new Error("The test's participants did not all wait on the test's own backends");
}

/** Waits for every started participant and ends every owned pool; the test's own failure is rethrown first. */
async function settle(failure: { error: unknown } | undefined, started: Promise<unknown>[], pools: Pool[]) {
  await Promise.allSettled(started);
  const cleanup: unknown[] = [];
  for (const owned of pools) {
    try {
      await owned.end();
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (failure && cleanup.length > 0) throw new AggregateError([failure.error, ...cleanup], "Test and cleanup failed");
  if (failure) throw failure.error;
  if (cleanup.length > 0) throw new AggregateError(cleanup, "Owned pool cleanup failed");
}

const ensurePage = (areaId: string) =>
  runInTenant(tenant, () => withTransaction(pool, (client) => getOrCreateDoc(client, areaId, "page")));

describe("area note cutover (issue #1619)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    areas = await areasDatabaseId(tenant);
    cp = createChokePoint(pool);
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("puts the note text into the area page, and a second run neither duplicates nor rewrites it", async () => {
    const area = await createArea(tenant, areas, { note: NOTE });
    await runCutovers();
    const first = await page(tenant, area.id);
    expect(first?.texts).toEqual([NOTE]);
    expect(first?.marker).toEqual({ source: NOTE, blockIds: first?.ids });
    const updates = await docUpdateCount(first!.docId);
    expect(updates).toBe(1);

    await runCutovers();
    expect(await page(tenant, area.id)).toEqual(first);
    expect(await docUpdateCount(first!.docId)).toBe(updates);
    expect((await runInTenant(tenant, () => cp.getItem(areas, area.id)))?.properties.note).toBe(NOTE);
  });

  it("replaces only the generated blocks after an old client changes the note, keeping hand-added blocks", async () => {
    const area = await createArea(tenant, areas, { note: "First version" });
    await runCutovers();
    const converted = await page(tenant, area.id);
    await runInTenant(tenant, async () => {
      await mutateDoc(pool, converted!.docId, "user", (ydoc) =>
        writeBlock(ydoc, { id: randomUUID(), type: "text", text: "Written by hand" }),
      );
      await cp.updateItem({ databaseId: areas, itemId: area.id, propertiesPatch: { note: "Second version" } });
    });

    await runCutovers();
    const reconciled = await page(tenant, area.id);
    expect(reconciled?.texts).toEqual(["Second version", "Written by hand"]);
    expect(reconciled?.marker).toEqual({ source: "Second version", blockIds: [reconciled?.ids[0]] });
    expect(reconciled?.ids).not.toContain(converted?.ids[0]);
    expect((await runInTenant(tenant, () => cp.getItem(areas, area.id)))?.properties.note).toBe("Second version");
  });

  it("writes the text once when two runs overlap", async () => {
    const area = await createArea(tenant, areas, { note: NOTE });
    const doc = await ensurePage(area.id);
    const holder = await observedPool();
    const runA = await observedPool();
    const runB = await observedPool();
    const hold = barrier();
    const started: Promise<unknown>[] = [];
    let failure: { error: unknown } | undefined;
    try {
      const blocker = runInTenant(tenant, () =>
        withTransaction(holder.pool, async (client) => {
          await client.query("SELECT 1 FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE", [doc.id]);
          await hold.hold();
        }),
      );
      started.push(blocker);
      await bounded(hold.reached, "the holder's document lock");
      const runs = [runA, runB].map((run) => runInTenant(tenant, () => runAreaNoteCutoverMigration(run.pool)));
      started.push(...runs);
      await waitUntilBlocked([runA.pids, runB.pids], () => new Set([...holder.pids, ...runA.pids, ...runB.pids]));
      hold.release();
      await bounded(blocker, "the holder");
      await bounded(Promise.all(runs), "both runs");
      expect((await page(tenant, area.id))?.texts).toEqual([NOTE]);
      expect(await docUpdateCount(doc.id)).toBe(1);
    } catch (error) {
      failure = { error };
    }
    hold.release();
    await settle(failure, started, [holder.pool, runA.pool, runB.pool]);
  });

  it("converts the note read under the document lock, so an older read cannot overwrite a newer conversion", async () => {
    const area = await createArea(tenant, areas, { note: "Old note" });
    // The page doc exists, so run A inserts no docs row while it is held; with a new doc, run B's insert could wait on
    // the unique-index arbitration with run A's uncommitted row.
    const doc = await ensurePage(area.id);
    const hold = barrier();
    const runA = await observedPool(async (sql) => {
      if (sql.startsWith("SELECT 1 FROM doc_snapshots")) await hold.hold();
    });
    const started: Promise<unknown>[] = [];
    let failure: { error: unknown } | undefined;
    try {
      const held = runInTenant(tenant, () => runAreaNoteCutoverMigration(runA.pool));
      started.push(held);
      // Run A has read the area with "Old note" and waits before taking the document lock.
      await bounded(hold.reached, "run A before the document lock");
      await runInTenant(tenant, () =>
        cp.updateItem({ databaseId: areas, itemId: area.id, propertiesPatch: { note: "New note" } }),
      );
      await runInTenant(tenant, () => runAreaNoteCutoverMigration(pool));
      const converted = await page(tenant, area.id);
      expect(converted?.texts).toEqual(["New note"]);
      expect(converted?.marker).toEqual({ source: "New note", blockIds: converted?.ids });
      const updates = await docUpdateCount(doc.id);
      hold.release();
      await bounded(held, "run A");
      expect(await page(tenant, area.id)).toEqual(converted);
      expect(await docUpdateCount(doc.id)).toBe(updates);
    } catch (error) {
      failure = { error };
    }
    hold.release();
    await settle(failure, started, [runA.pool]);
  });

  it("fails only the area whose row a writer holds, without waiting for it, and converts it on the next run", async () => {
    const contended = await createArea(tenant, areas, { note: "Before" });
    const fine = await createArea(tenant, areas, { note: NOTE });
    // The page doc exists before the run, so its content and update count can be compared after the refused run.
    const contendedDoc = await ensurePage(contended.id);
    const pageBefore = await page(tenant, contended.id);
    const updatesBefore = await docUpdateCount(contendedDoc.id);
    const hold = barrier();
    const started: Promise<unknown>[] = [];
    let failure: { error: unknown } | undefined;
    try {
      const writer = runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          await updateItemWithClient(client, {
            databaseId: areas,
            itemId: contended.id,
            propertiesPatch: { note: "Writer note" },
          });
          await hold.hold();
        }),
      );
      started.push(writer);
      await bounded(hold.reached, "the writer holding the area row");
      const outcome = await bounded(
        runInTenant(tenant, () => runAreaNoteCutoverMigration(pool)).then(
          () => null,
          (error: unknown) => error,
        ),
        "the cutover while the writer holds the area",
      );
      expect(outcome).toBeInstanceOf(AggregateError);
      const errors = outcome instanceof AggregateError ? outcome.errors : [];
      expect(errors).toHaveLength(1);
      expect(lockNotAvailable.safeParse(errors[0]).success).toBe(true);
      const message = outcome instanceof Error ? outcome.message : "";
      expect(message).toContain(contended.id);
      expect(message).not.toContain(fine.id);
      expect(await page(tenant, contended.id)).toEqual(pageBefore);
      expect(await docUpdateCount(contendedDoc.id)).toBe(updatesBefore);
      expect((await page(tenant, fine.id))?.texts).toEqual([NOTE]);
      hold.release();
      await bounded(writer, "the writer");
      await runInTenant(tenant, () => runAreaNoteCutoverMigration(pool));
      expect((await page(tenant, contended.id))?.texts).toEqual(["Writer note"]);
    } catch (error) {
      failure = { error };
    }
    hold.release();
    await settle(failure, started, []);
  });

  it("waits for a page-text job holding the document lock, and both complete", async () => {
    const area = await createArea(tenant, areas, { note: NOTE });
    await ensurePage(area.id);
    const hold = barrier();
    // The job has locked doc_snapshots through loadDocWithClient and is held before indexItem locks the area row.
    const job = await observedPool(async (sql) => {
      if (sql.includes("FOR UPDATE OF i")) await hold.hold();
    });
    const conversion = await observedPool();
    const started: Promise<unknown>[] = [];
    let failure: { error: unknown } | undefined;
    try {
      const indexing = runInTenant(tenant, () => handleItemSearchPageTextTask(job.pool, { itemId: area.id }));
      started.push(indexing);
      await bounded(hold.reached, "the page-text job before its item lock");
      const converting = runInTenant(tenant, () => runAreaNoteCutoverMigration(conversion.pool));
      started.push(converting);
      await waitUntilBlocked([conversion.pids], () => new Set([...job.pids, ...conversion.pids]));
      hold.release();
      await bounded(Promise.all([indexing, converting]), "the job and the conversion");
      expect((await page(tenant, area.id))?.texts).toEqual([NOTE]);
    } catch (error) {
      failure = { error };
    }
    hold.release();
    await settle(failure, started, [job.pool, conversion.pool]);
  });

  it("makes a page-text job wait while it holds its source reservation, and both complete", async () => {
    const area = await createArea(tenant, areas, { note: NOTE });
    await ensurePage(area.id);
    const hold = barrier();
    let reserved = false;
    // Held after the area row was reserved, before the document is loaded for the mutation.
    const conversion = await observedPool(async (sql) => {
      if (sql.includes("FOR UPDATE NOWAIT")) reserved = true;
      else if (reserved && sql.startsWith("SELECT state FROM doc_snapshots")) await hold.hold();
    });
    const job = await observedPool();
    const started: Promise<unknown>[] = [];
    let failure: { error: unknown } | undefined;
    try {
      const converting = runInTenant(tenant, () => runAreaNoteCutoverMigration(conversion.pool));
      started.push(converting);
      await bounded(hold.reached, "the conversion holding its source reservation");
      const indexing = runInTenant(tenant, () => handleItemSearchPageTextTask(job.pool, { itemId: area.id }));
      started.push(indexing);
      await waitUntilBlocked([job.pids], () => new Set([...job.pids, ...conversion.pids]));
      hold.release();
      await bounded(Promise.all([converting, indexing]), "the conversion and the job");
      expect((await page(tenant, area.id))?.texts).toEqual([NOTE]);
    } catch (error) {
      failure = { error };
    }
    hold.release();
    await settle(failure, started, [conversion.pool, job.pool]);
  });

  it("appends the first conversion after blocks written by hand", async () => {
    const area = await createArea(tenant, areas, { note: "Converted text" });
    const doc = await ensurePage(area.id);
    await runInTenant(tenant, () =>
      mutateDoc(pool, doc.id, "user", (ydoc) => {
        writeBlock(ydoc, { id: randomUUID(), type: "text", text: "Hand one" });
        writeBlock(ydoc, { id: randomUUID(), type: "text", text: "Hand two" });
      }),
    );
    const handIds = (await page(tenant, area.id))?.ids;
    await runCutovers();
    const converted = await page(tenant, area.id);
    expect(converted?.texts).toEqual(["Hand one", "Hand two", "Converted text"]);
    expect(converted?.ids.slice(0, 2)).toEqual(handIds);
    expect(converted?.marker).toEqual({ source: "Converted text", blockIds: [converted?.ids[2]] });
  });

  it("replaces the generated block that is left when one was removed by hand, keeping hand blocks and order", async () => {
    const area = await createArea(tenant, areas, { note: "First paragraph\n\nSecond paragraph" });
    const doc = await ensurePage(area.id);
    await runInTenant(tenant, () =>
      mutateDoc(pool, doc.id, "user", (ydoc) => writeBlock(ydoc, { id: randomUUID(), type: "text", text: "Before" })),
    );
    await runCutovers();
    const first = await page(tenant, area.id);
    expect(first?.texts).toEqual(["Before", "First paragraph", "Second paragraph"]);
    const [beforeId, removedId, keptId] = first?.ids ?? [];
    if (!beforeId || !removedId || !keptId) throw new Error("Expected three blocks");
    await runInTenant(tenant, async () => {
      await mutateDoc(pool, doc.id, "user", (ydoc) => {
        deleteBlocks(ydoc, [removedId]);
        writeBlock(ydoc, { id: randomUUID(), type: "text", text: "After" });
      });
      await cp.updateItem({ databaseId: areas, itemId: area.id, propertiesPatch: { note: "Replacement" } });
    });
    await runCutovers();
    const replaced = await page(tenant, area.id);
    expect(replaced?.texts).toEqual(["Before", "Replacement", "After"]);
    expect(replaced?.ids[0]).toBe(beforeId);
    expect(replaced?.ids).not.toContain(keptId);
    expect(replaced?.marker).toEqual({ source: "Replacement", blockIds: [replaced?.ids[1]] });
  });

  it("gives an area with an empty, blank or absent note no doc and no error, and skips a trashed area", async () => {
    const empty = await createArea(tenant, areas, { note: "" });
    const blank = await createArea(tenant, areas, { note: "  \n " });
    const absent = await createArea(tenant, areas, {});
    const trashed = await createArea(tenant, areas, { note: NOTE });
    await runInTenant(tenant, () => cp.softDeleteItem(areas, trashed.id));
    await runCutovers();
    for (const area of [empty, blank, absent, trashed]) expect(await page(tenant, area.id)).toBeNull();
    expect((await runInTenant(tenant, () => cp.getItem(areas, blank.id)))?.properties.note).toBe("  \n ");
  });

  it("is a no-op for a tenant without Areas", async () => {
    const bare = await createTestTenant(admin);
    await expect(runInTenant(bare, () => runAreaNoteCutoverMigration(pool))).resolves.toBeUndefined();
    const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM docs WHERE tenant_id = $1", [
      bare,
    ]);
    expect(rows[0]?.n).toBe(0);
  });

  it("converts a suspended tenant", async () => {
    const suspended = await createTestTenant(admin, { status: "suspended" });
    await runInTenant(suspended, () => seedSystem(pool));
    const area = await createArea(suspended, await areasDatabaseId(suspended), { note: NOTE });
    await runCutovers();
    expect((await page(suspended, area.id))?.texts).toEqual([NOTE]);
  });

  it("converts the other areas when one fails, then reports the failed areas without changing them", async () => {
    const pageLink = await createArea(tenant, areas, { note: `[Sub](semprec://page/${randomUUID()})` });
    const unknownType = await createArea(tenant, areas, {
      note: "<!-- semprec:block id=u1 type=callout indent=0 -->\nHeads up",
    });
    const fine = await createArea(tenant, areas, { note: NOTE });
    const badMarker = await createArea(tenant, areas, { note: "Marked" });
    const doc = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => getOrCreateDoc(client, badMarker.id, "page")),
    );
    await runInTenant(tenant, () =>
      mutateDoc(pool, doc.id, "user", (ydoc) => ydoc.getMap<unknown>("meta").set("legacyNoteSource", 5)),
    );

    const failure = await runInTenant(tenant, () => runAreaNoteCutoverMigration(pool)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const message = failure instanceof Error ? failure.message : "";
    for (const area of [pageLink, unknownType, badMarker]) expect(message).toContain(area.id);
    expect(message).not.toContain(fine.id);
    expect((await page(tenant, fine.id))?.texts).toEqual([NOTE]);
    for (const area of [pageLink, unknownType]) expect(await page(tenant, area.id)).toBeNull();
    expect((await page(tenant, badMarker.id))?.texts).toEqual([]);
  });
});
