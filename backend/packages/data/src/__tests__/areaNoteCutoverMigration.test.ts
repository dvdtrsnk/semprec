import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { readPageBlocks, writeBlock } from "@semprec/block-model";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { runAreaNoteCutoverMigration } from "../docs/areaNoteCutoverMigration.js";
import { loadDoc, mutateDoc } from "../docs/docPersistence.js";
import { getDocByItemId, getOrCreateDoc } from "../docs/docsStore.js";
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
    const doc = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => getOrCreateDoc(client, area.id, "page")),
    );
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const blocker = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        await client.query("SELECT 1 FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE", [doc.id]);
        locked();
        await released;
      }),
    );
    await holding;
    const runs = [1, 2].map(() => runInTenant(tenant, () => runAreaNoteCutoverMigration(pool)));
    let waiting = 0;
    for (let attempt = 0; attempt < 200 && waiting < 2; attempt++) {
      const { rows } = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'semprec_data' AND wait_event_type = 'Lock'",
      );
      waiting = rows[0]?.n ?? 0;
      if (waiting < 2) await sleep(25);
    }
    expect(waiting).toBe(2);
    release();
    await blocker;
    await Promise.all(runs);
    expect((await page(tenant, area.id))?.texts).toEqual([NOTE]);
    expect(await docUpdateCount(doc.id)).toBe(1);
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
