import {
  deleteBlocks,
  insertBlocks,
  isBlockType,
  parseMarkdown,
  readPageBlocks,
  type NewBlockInput,
} from "@semprec/block-model";
import type { Pool, PoolClient } from "pg";
import type * as Y from "yjs";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { AREAS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { mutateDocWithClient } from "./docPersistence.js";
import { getOrCreateDoc } from "./docsStore.js";
import { logger } from "./logger.js";

/** The root map of an area page that records what the conversion wrote (issue #1619). */
const META_MAP_NAME = "meta";
const SOURCE_KEY = "legacyNoteSource";
const BLOCK_IDS_KEY = "legacyNoteBlockIds";

const markerSchema = z.object({ source: z.string(), blockIds: z.array(z.string()) });
type Marker = z.infer<typeof markerSchema>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The note text of an area, or null when it is absent or blank. */
function noteOf(properties: Record<string, unknown>): string | null {
  const note = properties.note;
  return typeof note === "string" && note.trim() !== "" ? note : null;
}

/** The conversion marker of a page doc: absent (null) when neither key is set; any other shape is refused. */
function readMarker(ydoc: Y.Doc): Marker | null {
  const meta = ydoc.getMap<unknown>(META_MAP_NAME);
  const source = meta.get(SOURCE_KEY);
  const blockIds = meta.get(BLOCK_IDS_KEY);
  if (source === undefined && blockIds === undefined) return null;
  const parsed = markerSchema.safeParse({ source, blockIds });
  if (!parsed.success) throw new Error("Malformed legacy note marker in the area page");
  return parsed.data;
}

/** The note as page blocks, by the canonical Markdown parser (#1608); ids are assigned on insert. */
function noteBlocks(note: string): NewBlockInput[] {
  return parseMarkdown(note, { allowPage: false }).map((block) => {
    if (!isBlockType(block.type)) throw new Error("The area note parses to an unknown block type");
    return {
      type: block.type,
      indent: block.indent,
      ...(block.done !== undefined ? { done: block.done } : {}),
      ...(block.text !== undefined ? { text: block.text } : {}),
    };
  });
}

/**
 * Applies the marker rules of issue #1619 to one loaded page doc, inside `mutateDocWithClient`'s transact, so the
 * blocks and the marker form one doc update: no marker appends the note's blocks after the page's last block; a
 * marker for other text replaces only those of its generated blocks that still exist (the new blocks go where the
 * first of them was, or at the end when none is left) and leaves every other block as it is; a marker for the same
 * text changes nothing.
 */
function convertNote(ydoc: Y.Doc, note: string): void {
  const marker = readMarker(ydoc);
  if (marker?.source === note) return;
  const order = readPageBlocks(ydoc).flatMap((block) => (block.synthetic || block.id === null ? [] : [block.id]));
  const stale = new Set(marker?.blockIds ?? []);
  const firstStale = order.findIndex((id) => stale.has(id));
  const afterId = firstStale === -1 ? (order.at(-1) ?? null) : (order[firstStale - 1] ?? null);
  const blockIds = insertBlocks(ydoc, afterId, noteBlocks(note));
  const remove = order.filter((id) => stale.has(id));
  if (remove.length > 0) deleteBlocks(ydoc, remove);
  const meta = ydoc.getMap<unknown>(META_MAP_NAME);
  meta.set(SOURCE_KEY, note);
  meta.set(BLOCK_IDS_KEY, blockIds);
}

/**
 * Converts one area's note in its own transaction (docs/adr/2026-11-07-area-note-cutover-reserves-source-without-waiting.md).
 * An unlocked read decides only whether to go on: a trashed area or an empty note is left without a doc. The page doc
 * is then ensured and the document lock shared by document writes (the `doc_snapshots` row) and the `docs` row are
 * taken with `FOR UPDATE`, in that order, so a concurrent second run waits for this one and then reads its marker.
 * Only after that is the area row reserved with `lockItemByIdNowait`, and the note converted is the one read from that
 * reserved row, never the unlocked read: a note written while this run waited for the document lock is the one it
 * converts. A row another transaction holds raises PostgreSQL's lock-not-available error instead of waiting while the
 * document locks are held; it rolls this area back and reaches the caller. When the reserved row is trashed or its
 * note is empty by then, nothing is converted, and the page doc ensured in this transaction is kept empty.
 */
async function convertArea(client: PoolClient, databaseId: string, areaId: string): Promise<void> {
  const discovered = await itemsStore.getItemById(client, databaseId, areaId);
  if (!discovered || discovered.deletedAt || noteOf(discovered.properties) === null) return;
  const doc = await getOrCreateDoc(client, areaId, "page");
  await client.query("SELECT 1 FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE", [doc.id]);
  await client.query("SELECT id FROM docs WHERE id = $1 FOR UPDATE", [doc.id]);
  const area = await itemsStore.lockItemByIdNowait(client, databaseId, areaId);
  const note = area && !area.deletedAt ? noteOf(area.properties) : null;
  if (note === null) return;
  await mutateDocWithClient(client, doc.id, "system", (ydoc) => convertNote(ydoc, note));
}

/**
 * Per-tenant step of issue #1619 (expand phase; app code because it writes Yjs documents,
 * docs/adr/2026-09-10-app-code-post-migration-steps.md): puts each live area's `note` text into the area's page doc,
 * once, and reconciles later edits that old clients make to `note`. The `note` property is never modified, and an
 * area with an empty or absent note gets no doc. A tenant without an Areas database is a no-op.
 *
 * Each area runs in its own transaction, so one area failing neither rolls back nor stops the others. Every failure,
 * a lock-not-available error on an area row another transaction holds included, is logged with the area id and,
 * after all areas ran, rethrown together as one `AggregateError` carrying the original errors, so the tenant's cutover
 * reports it. Nothing is retried; the next run converts what is left.
 */
export async function runAreaNoteCutoverMigration(pool: Pool): Promise<void> {
  const areaIds = await withTransaction(pool, async (client) => {
    const areas = await getDatabaseByModuleId(client, AREAS_MODULE_ID);
    if (!areas) return null;
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL
         AND jsonb_typeof(properties->'note') = 'string' AND btrim(properties->>'note') <> ''
       ORDER BY id`,
      [areas.id],
    );
    return { databaseId: areas.id, ids: rows.map((row) => row.id) };
  });
  if (!areaIds) return;
  const failed: string[] = [];
  const errors: unknown[] = [];
  for (const areaId of areaIds.ids) {
    try {
      await withTransaction(pool, (client) => convertArea(client, areaIds.databaseId, areaId));
    } catch (error) {
      logger.error({ errorName: errorName(error), areaId }, "Area note conversion failed");
      failed.push(areaId);
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `${errors.length} of ${areaIds.ids.length} area notes failed: ${failed.join(", ")}`,
    );
  }
}
