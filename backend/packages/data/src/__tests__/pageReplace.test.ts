import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { deleteBlocks, insertBlocks, readPageBlocks, writeBlock } from "@semprec/block-model";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../chokePoint/itemTrash.js";
import { ValidationError } from "../errors.js";
import { createDocStore, type DocStore } from "../docs/docStore.js";
import { loadDoc, loadDocWithClient, mutateDoc, mutateDocWithClient } from "../docs/docPersistence.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import {
  docEtag,
  insertPageMarkdown,
  PageVersionConflictError,
  readPageMarkdown,
  replacePageMarkdown,
  type ReplacePageMarkdownInput,
} from "../docs/pageMarkdown.js";
import { PAGES_MODULE_ID } from "../docs/pagesDatabase.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { setDocUpdateHook } from "../realtimeHook.js";

let pool: Pool;
let chokePoint: ChokePoint;
let docStore: DocStore;

const USER_WRITER = { writerKind: "user" } as const;

async function makeHost() {
  const database = await chokePoint.createDatabase({ name: `Hosts ${randomUUID()}` });
  return chokePoint.createItem({ databaseId: database.id, properties: {} });
}

async function hostWithText(markdown: string) {
  const host = await makeHost();
  await append(host.id, markdown);
  return host;
}

function append(itemId: string, markdown: string) {
  return withTransaction(pool, (client) =>
    insertPageMarkdown(client, itemId, { placement: "end", markdown, origin: "user" }),
  );
}

/** A replace with the token the page has when it starts, unless `overrides` names another. */
function replace(itemId: string, markdown: string, overrides: Partial<ReplacePageMarkdownInput> = {}) {
  return withTransaction(pool, async (client) =>
    replacePageMarkdown(client, itemId, {
      markdown,
      expectedEtag: (await readPageMarkdown(client, itemId)).etag,
      origin: "user",
      writer: USER_WRITER,
      actingUserId: randomUUID(),
      ...overrides,
    }),
  );
}

async function markdownOf(itemId: string): Promise<string> {
  return (await withTransaction(pool, (client) => readPageMarkdown(client, itemId))).markdown;
}

async function blocksOf(itemId: string) {
  const doc = await docStore.getDoc(itemId);
  if (!doc) return [];
  const loaded = await loadDoc(pool, doc.id);
  try {
    return readPageBlocks(loaded).filter((block) => !block.synthetic);
  } finally {
    loaded.destroy();
  }
}

async function updateAuthors(itemId: string): Promise<string[]> {
  const { rows } = await pool.query<{ created_by: string }>(
    `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
    [itemId],
  );
  return rows.map((row) => row.created_by);
}

/** What a refused replace must leave as it found it. */
async function footprint() {
  const { rows } = await pool.query<{ docs: number; updates: number; live_items: number }>(
    `SELECT (SELECT count(*)::int FROM docs) AS docs, (SELECT count(*)::int FROM doc_updates) AS updates,
            (SELECT count(*)::int FROM items WHERE deleted_at IS NULL) AS live_items`,
  );
  return rows[0];
}

async function isLive(itemId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM items WHERE id = $1 AND deleted_at IS NULL`, [itemId]);
  return rows.length === 1;
}

async function titleOf(itemId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ title: string }>(
    `SELECT properties->>'title' AS title FROM items WHERE id = $1`,
    [itemId],
  );
  return rows[0]?.title;
}

async function subpageOf(parentId: string, title: string) {
  const page = (await docStore.createSubpage({ parent: { itemId: parentId }, title }, "user")).pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

async function pagesDatabaseId(): Promise<string> {
  const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, PAGES_MODULE_ID));
  if (!database) throw new Error("Missing Pages database");
  return database.id;
}

/** A direct trash of a subpage, as the Trash view does it, outside any replace. */
async function trashPage(pageItemId: string): Promise<void> {
  const databaseId = await pagesDatabaseId();
  await withTransaction(pool, (client) =>
    itemDeleteWithClient(client, databaseId, pageItemId, {
      queueAffinity: createActionQueueAffinity(),
      writer: USER_WRITER,
    }),
  );
}

/** The restore of a trashed subpage (Undo), which puts its block back into the parent's document. */
async function restorePage(pageItemId: string): Promise<void> {
  const databaseId = await pagesDatabaseId();
  await withTransaction(pool, (client) =>
    restoreItemWithClient(client, databaseId, pageItemId, createActionQueueAffinity(), undefined, USER_WRITER),
  );
}

function link(page: { pageItemId: string }, caption: string): string {
  return `[${caption}](semprec://page/${page.pageItemId})`;
}

describe("replace a page from Markdown (issue #1765)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);
    await resetDatabase(pool);
    setDocUpdateHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("refuses a stale token with the current one and writes nothing", async () => {
    const host = await hostWithText("One");
    const stale = (await withTransaction(pool, (client) => readPageMarkdown(client, host.id))).etag;
    await append(host.id, "Two");
    const current = (await withTransaction(pool, (client) => readPageMarkdown(client, host.id))).etag;
    const before = await footprint();

    const error = await replace(host.id, "Overwritten", { expectedEtag: stale }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PageVersionConflictError);
    expect(error).toMatchObject({ status: 409, code: "version_conflict", currentEtag: current });
    expect(await footprint()).toEqual(before);
    expect(await markdownOf(host.id)).toBe("One\n\nTwo");
  });

  it("refuses an item that holds a canvas document, as one that cannot host a page", async () => {
    const host = await makeHost();
    await docStore.getOrCreateDoc(host.id, "canvas");

    const error = await replace(host.id, "Text", { expectedEtag: docEtag(new Y.Doc()) }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { reason: "not_a_page_host" } });
  });

  it("aborts the whole write for an invalid item link, lazy document creation included", async () => {
    const host = await makeHost();
    const before = await footprint();

    const error = await replace(host.id, `See [it](semprec://items/${randomUUID()})`).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { field: "markdown" } });
    expect(await footprint()).toEqual(before);
    expect(before?.docs).toBe(0);
  });

  it("authors every update it stores, the trash of a vanished page and the rename of another included, as the origin named", async () => {
    const host = await hostWithText("Intro");
    const kept = await subpageOf(host.id, "Kept");
    const dropped = await subpageOf(host.id, "Dropped");
    const before = (await updateAuthors(host.id)).length;

    const result = await replace(host.id, `Intro, reworded\n\n${link(kept, "Kept, renamed")}`, {
      origin: "ai_agent",
      writer: { writerKind: "agent", onBehalfOfUserId: randomUUID() },
    });

    expect(result.trashedPages).toEqual([{ pageItemId: dropped.pageItemId, title: "Dropped" }]);
    // The trash's removal of the block, the rename's retitle and the diff itself: three updates, all by the agent.
    expect((await updateAuthors(host.id)).slice(before)).toEqual(["ai_agent", "ai_agent", "ai_agent"]);
  });

  it("keeps a subpage live that no block of the page names, and links it again when the Markdown does", async () => {
    const host = await hostWithText("Intro");
    const page = await subpageOf(host.id, "Linked later");
    // A collaborator deleted the page's block in the editor; the page itself is still a live subpage.
    const docId = (await docStore.getDoc(host.id))?.id ?? "";
    await mutateDoc(pool, docId, "user", (ydoc) => deleteBlocks(ydoc, [page.blockId]));
    expect(await markdownOf(host.id)).toBe("Intro");

    const untouched = await replace(host.id, "Intro, reworded");
    expect(untouched.trashedPages).toEqual([]);
    expect(await isLive(page.pageItemId)).toBe(true);

    const linked = await replace(host.id, `Intro, reworded\n\n${link(page, "Linked later")}`);
    expect(linked.trashedPages).toEqual([]);
    expect(await markdownOf(host.id)).toBe(`Intro, reworded\n\n${link(page, "Linked later")}`);
    expect(await isLive(page.pageItemId)).toBe(true);
  });

  it("trashes a page once when several blocks name it and none is in the new Markdown, and not at all when one stays", async () => {
    const host = await hostWithText("Intro");
    const page = await subpageOf(host.id, "Twice");
    const docId = (await docStore.getDoc(host.id))?.id ?? "";
    await mutateDoc(pool, docId, "user", (ydoc) =>
      writeBlock(ydoc, { id: "second-link", type: "page", pageId: page.pageItemId, text: "Twice again" }),
    );
    expect((await blocksOf(host.id)).filter((block) => block.type === "page")).toHaveLength(2);

    const kept = await replace(host.id, `Intro\n\n${link(page, "Twice")}`);
    expect(kept.trashedPages).toEqual([]);
    expect(await isLive(page.pageItemId)).toBe(true);
    expect((await blocksOf(host.id)).filter((block) => block.type === "page")).toHaveLength(1);

    await mutateDoc(pool, docId, "user", (ydoc) =>
      writeBlock(ydoc, { id: "third-link", type: "page", pageId: page.pageItemId, text: "Twice yet again" }),
    );
    const dropped = await replace(host.id, "Intro");
    expect(dropped.trashedPages).toEqual([{ pageItemId: page.pageItemId, title: "Twice" }]);
    expect(await isLive(page.pageItemId)).toBe(false);
    expect((await blocksOf(host.id)).map((block) => block.type)).toEqual(["text"]);
  });

  it("does not trash a page whose link line only moved, and gives the moved block a fresh id", async () => {
    const host = await hostWithText("First\n\nSecond");
    const page = await subpageOf(host.id, "Mover");
    const [first, second] = (await blocksOf(host.id)).map((block) => block.id);

    const result = await replace(host.id, `${link(page, "Mover")}\n\nFirst\n\nSecond`);

    expect(result.trashedPages).toEqual([]);
    expect(await isLive(page.pageItemId)).toBe(true);
    const blocks = await blocksOf(host.id);
    expect(blocks.map((block) => block.type)).toEqual(["page", "text", "text"]);
    expect(blocks.slice(1).map((block) => block.id)).toEqual([first, second]);
    expect(blocks[0]?.id).not.toBe(page.blockId);
  });

  it("reads each page link's caption from its own line, whatever comment, line ending or blanks surround it", async () => {
    const host = await hostWithText("Intro");
    const one = await subpageOf(host.id, "One");
    const two = await subpageOf(host.id, "Two");
    const three = await subpageOf(host.id, "Three");

    await replace(
      host.id,
      [
        "Intro",
        "",
        "<!-- semprec:block id=ignored type=text indent=2 -->",
        link(one, "One \\*renamed\\*"),
        "",
        `\u00a0${link(two, "Two, with a leading no-break space")}`,
        "",
        "- a list line",
        link(three, "Three"),
      ].join("\r\n"),
    );

    expect([await titleOf(one.pageItemId), await titleOf(two.pageItemId), await titleOf(three.pageItemId)]).toEqual([
      "One *renamed*",
      "Two, with a leading no-break space",
      "Three",
    ]);
  });

  it("renames a page to the empty title when its caption is empty", async () => {
    const host = await hostWithText("Intro");
    const page = await subpageOf(host.id, "Named");

    await replace(host.id, `Intro\n\n[](semprec://page/${page.pageItemId})`);

    expect(await titleOf(page.pageItemId)).toBe("");
  });

  describe("restoring a trashed subpage after the replace deleted the block that stood before its link", () => {
    it("puts the block after the block that replaced its reworded neighbor, for the page this request trashed", async () => {
      const host = await hostWithText("Intro\n\nOutro");
      const [intro] = await blocksOf(host.id);
      const page = (
        await docStore.createSubpage(
          { parent: { itemId: host.id }, title: "Checklist", afterBlockId: intro?.id ?? "" },
          "user",
        )
      ).pages[0];
      if (!page) throw new Error("Missing page");

      const result = await replace(host.id, "Intro, reworded\n\nOutro");
      expect(result.trashedPages).toEqual([{ pageItemId: page.pageItemId, title: "Checklist" }]);
      await restorePage(page.pageItemId);

      expect(await markdownOf(host.id)).toBe(`Intro, reworded\n\n${link(page, "Checklist")}\n\nOutro`);
    });

    it("moves the position of a page trashed before the request as well", async () => {
      const host = await hostWithText("Intro\n\nOutro");
      const [intro] = await blocksOf(host.id);
      const page = (
        await docStore.createSubpage(
          { parent: { itemId: host.id }, title: "Earlier", afterBlockId: intro?.id ?? "" },
          "user",
        )
      ).pages[0];
      if (!page) throw new Error("Missing page");
      await trashPage(page.pageItemId);

      await replace(host.id, "Intro, reworded\n\nOutro");
      await restorePage(page.pageItemId);

      expect(await markdownOf(host.id)).toBe(`Intro, reworded\n\n${link(page, "Earlier")}\n\nOutro`);
    });

    it("puts the block at the start when the request removed the block before its link and every block before that", async () => {
      const host = await hostWithText("First\n\nSecond\n\nOutro");
      const second = (await blocksOf(host.id))[1];
      const page = (
        await docStore.createSubpage(
          { parent: { itemId: host.id }, title: "Checklist", afterBlockId: second?.id ?? "" },
          "user",
        )
      ).pages[0];
      if (!page) throw new Error("Missing page");

      await replace(host.id, "Outro");
      await restorePage(page.pageItemId);

      expect(await markdownOf(host.id)).toBe(`${link(page, "Checklist")}\n\nOutro`);
    });

    it("puts the block after the block before the removed neighbor when nothing replaced it", async () => {
      const host = await hostWithText("First\n\nSecond\n\nOutro");
      const second = (await blocksOf(host.id))[1];
      const page = (
        await docStore.createSubpage(
          { parent: { itemId: host.id }, title: "Checklist", afterBlockId: second?.id ?? "" },
          "user",
        )
      ).pages[0];
      if (!page) throw new Error("Missing page");

      await replace(host.id, "First\n\nOutro");
      await restorePage(page.pageItemId);

      expect(await markdownOf(host.id)).toBe(`First\n\n${link(page, "Checklist")}\n\nOutro`);
    });
  });

  describe("when a later step of the request fails", () => {
    /**
     * Runs `run` with a trigger that makes the trash of any item titled "Poison" fail. The trigger body is a fixed
     * text; it is dropped again whatever `run` does.
     */
    async function withPoisonedTrash<T>(run: () => Promise<T>): Promise<T> {
      await pool.query(`
        CREATE FUNCTION test_fail_poison_trash() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.properties->>'title' = 'Poison' THEN
            RAISE EXCEPTION 'test failure injected into the trash of an item';
          END IF;
          RETURN NEW;
        END
        $fn$`);
      await pool.query(
        `CREATE TRIGGER test_fail_poison_trash BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION test_fail_poison_trash()`,
      );
      try {
        return await run();
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS test_fail_poison_trash ON items`);
        await pool.query(`DROP FUNCTION IF EXISTS test_fail_poison_trash()`);
      }
    }

    it("rolls the first vanished page's trash and block removal back when the second page's trash fails", async () => {
      const host = await hostWithText("Intro");
      const first = await subpageOf(host.id, "Goes first");
      const poisoned = await subpageOf(host.id, "Poison");
      const renamed = await subpageOf(host.id, "Stays");
      const markdownBefore = await markdownOf(host.id);
      const before = await footprint();

      const error = await withPoisonedTrash(() =>
        replace(host.id, `Intro, reworded\n\n${link(renamed, "Stays, renamed")}`).catch((caught: unknown) => caught),
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("test failure injected");
      expect(await footprint()).toEqual(before);
      expect(await markdownOf(host.id)).toBe(markdownBefore);
      for (const page of [first, poisoned, renamed]) expect(await isLive(page.pageItemId)).toBe(true);
      expect(await titleOf(renamed.pageItemId)).toBe("Stays");
    });
  });

  describe("lock order", () => {
    /** Polls until a backend with this `application_name` waits for a lock held by another transaction. */
    async function waitUntilBlocked(applicationName: string): Promise<void> {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`,
          [applicationName],
        );
        if (rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`${applicationName} never waited for a lock`);
    }

    /** Runs `work` in a managed transaction whose backend is listed in `pg_stat_activity` as `applicationName`. */
    function transactionNamed<T>(applicationName: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
      return withTransaction(pool, async (client) => {
        await client.query(`SELECT set_config('application_name', $1, true)`, [applicationName]);
        return work(client);
      });
    }

    it("refuses with the current token when a document with content appears for an item without one before the write", async () => {
      const host = await makeHost();
      const emptyToken = (await withTransaction(pool, (client) => readPageMarkdown(client, host.id))).etag;
      expect(await docStore.getDoc(host.id)).toBeNull();

      // A writer that creates the item's first document and edits it, and has not committed yet.
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding: () => void = () => undefined;
      const holdsDocument = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const writer = transactionNamed("page-replace-creator", async (client) => {
        const row = await getOrCreateDoc(client, host.id, "page");
        await mutateDocWithClient(client, row.id, "user", (ydoc) =>
          insertBlocks(ydoc, null, [{ id: "written-by-the-creator", type: "text", text: "Written first" }]),
        );
        holding();
        await released;
      });
      try {
        await holdsDocument;

        // The replace finds no committed document, so its first comparison is against the empty one and passes. It
        // then waits for the creator's `docs` row, and on getting it must compare the token again.
        const replacing = transactionNamed("page-replace-latecomer", (client) =>
          replacePageMarkdown(client, host.id, {
            markdown: "Overwrites",
            expectedEtag: emptyToken,
            origin: "user",
            writer: USER_WRITER,
            actingUserId: randomUUID(),
          }),
        ).catch((caught: unknown) => caught);
        await waitUntilBlocked("page-replace-latecomer");

        release();
        await writer;

        const error = await replacing;
        expect(error).toBeInstanceOf(PageVersionConflictError);
        expect(await markdownOf(host.id)).toBe("Written first");
        expect((error as PageVersionConflictError).currentEtag).toBe(
          (await withTransaction(pool, (client) => readPageMarkdown(client, host.id))).etag,
        );
      } finally {
        release();
        await writer.catch(() => undefined);
      }
    });

    it("settles a direct trash of a subpage racing a replace that is waiting for the page's document, without a deadlock", async () => {
      const host = await hostWithText("Intro");
      const page = await subpageOf(host.id, "Contested");
      const docId = (await docStore.getDoc(host.id))?.id ?? "";
      const pagesDatabase = await withTransaction(pool, (client) => getDatabaseByModuleId(client, PAGES_MODULE_ID));
      if (!pagesDatabase) throw new Error("Missing Pages database");
      const etag = (await withTransaction(pool, (client) => readPageMarkdown(client, host.id))).etag;

      // A writer in the middle of its own update holds the document's row locks until the test lets it finish.
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding: () => void = () => undefined;
      const holdsLocks = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const holder = transactionNamed("page-replace-holder", async (client) => {
        (await loadDocWithClient(client, docId)).destroy();
        holding();
        await released;
      });
      try {
        await holdsLocks;

        const replacing = transactionNamed("page-replace-replacer", (client) =>
          replacePageMarkdown(client, host.id, {
            markdown: "Intro",
            expectedEtag: etag,
            origin: "user",
            writer: USER_WRITER,
            actingUserId: randomUUID(),
          }),
        ).catch((caught: unknown) => caught);
        await waitUntilBlocked("page-replace-replacer");

        // The replace already holds the subpage's row, so the trash waits for it instead of taking the document first.
        const trashing = transactionNamed("page-replace-trasher", (client) =>
          itemDeleteWithClient(client, pagesDatabase.id, page.pageItemId, {
            queueAffinity: createActionQueueAffinity(),
            writer: USER_WRITER,
          }),
        ).catch((caught: unknown) => caught);
        await waitUntilBlocked("page-replace-trasher");

        release();
        await holder;

        const [replaced, trashed] = await Promise.all([replacing, trashing]);
        expect(replaced).toMatchObject({ trashedPages: [{ pageItemId: page.pageItemId, title: "Contested" }] });
        expect(trashed).toMatchObject({ id: page.pageItemId });
        expect(await isLive(page.pageItemId)).toBe(false);
        expect(await markdownOf(host.id)).toBe("Intro");
      } finally {
        release();
        await holder.catch(() => undefined);
      }
    });
  });
});
