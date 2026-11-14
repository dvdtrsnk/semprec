import type { PoolClient } from "pg";
import * as Y from "yjs";
import { z } from "zod";
import { currentTenantScope, type HiddenRelationTarget, type SempMessageRef } from "@semprec/shared";
import { requireManagedTransaction } from "../db/pool.js";
import { getItemsByIds, getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { projectItemsForRead } from "../chokePoint/itemReadProjection.js";
import { getDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { getBlock, listBlocks } from "../docs/blocks.js";
import { readRefDocumentStates } from "../docs/docsStore.js";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { itemIdsLinkedToDatabases } from "../agentGrants/inheritedSensitivity.js";
import { getTaskRecurrenceBySeriesId, publicTaskRecurrenceTemplate } from "../tasks/taskRecurrenceStore.js";
import { getApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { getBlob } from "../blobs/blobsStore.js";
import { resolveMailThreadRefTargets } from "../mail/mailThreadRef.js";
import { loadBlobMetadataForItems } from "../blobs/blobMetadata.js";
import { listTranscriptSpeakers } from "../transcription/transcriptionSpeakerEdges.js";
import { expandTranscriptSegmentRef } from "../transcription/transcriptSegmentRef.js";
import type { BlobRow, ItemRow } from "../types.js";
import { readSleepNightContext } from "./sempSleepNightContext.js";

/** Ephemeral tenant-scoped data; never persist this projection in a run or event. */
export interface SempRefContext {
  label: string;
  state: "active" | "trashed";
  details: unknown;
  blob: { id: string; storageKey: string; mimeType: string; byteSize: string } | null;
}

const segmentsSchema = z.array(
  z.object({ speaker: z.string(), text: z.string(), startsAt: z.number(), endsAt: z.number() }),
);
const RELATED_KEYS = new Set(["project", "projects", "company", "companies", "people", "sourceInbox", "proposals"]);
/** A task's attachments are its `files` relation (issue #1771); other databases keep the common set. */
const TASK_RELATED_KEYS = new Set([...RELATED_KEYS, "files"]);
const MAX_RELATION_TARGETS = 200;

function blobProjection(blob: BlobRow | null): SempRefContext["blob"] {
  return blob ? { id: blob.id, storageKey: blob.storageKey, mimeType: blob.mimeType, byteSize: blob.byteSize } : null;
}

async function itemTitle(client: PoolClient, item: ItemRow): Promise<string> {
  const title = (await listPropertiesByDatabase(client, item.databaseId)).find((property) => property.type === "title");
  const value = title ? item.properties[title.key] : null;
  return typeof value === "string" ? value.slice(0, 500) : "";
}

/**
 * The names of the items an item relates to through the given relation keys. A target in a database of
 * `unreadableDatabaseIds` (the databases the reading agent's project may not read, issue #1849), or a Files,
 * Transcripts or Inbox item linked to one of them (issue #1999), contributes its id under `hidden` as
 * `{ id, hidden: true }` and no name.
 */
async function relatedNames(
  client: PoolClient,
  item: ItemRow,
  keys: ReadonlySet<string> = RELATED_KEYS,
  unreadableDatabaseIds: ReadonlySet<string> = new Set(),
) {
  const result: Record<string, { names: string[]; truncated: boolean; hidden?: HiddenRelationTarget[] }> = {};
  for (const property of await listPropertiesByDatabase(client, item.databaseId)) {
    if (property.type !== "relation" || !keys.has(property.key)) continue;
    const definition = await getRelationDefinitionByPropertyId(client, property.id);
    if (!definition) continue;
    const { rows } = await client.query<{ item_a: string; item_b: string }>(
      `SELECT item_a, item_b FROM item_relations WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)
       ORDER BY id LIMIT $3`,
      [definition.id, item.id, MAX_RELATION_TARGETS + 1],
    );
    const targets = await getItemsByIds(
      client,
      rows.slice(0, MAX_RELATION_TARGETS).map((edge) => (edge.item_a === item.id ? edge.item_b : edge.item_a)),
    );
    // A Files, Transcripts or Inbox target linked to a sensitive database the project may not read is as hidden as an
    // item of that database (issue #1999); with nothing unreadable the lookup does not query.
    const linkedToUnreadable = await itemIdsLinkedToDatabases(
      client,
      targets.map((target) => target.id),
      unreadableDatabaseIds,
    );
    const isHidden = (target: ItemRow) =>
      unreadableDatabaseIds.has(target.databaseId) || linkedToUnreadable.has(target.id);
    const readable = targets.filter((target) => !isHidden(target));
    const hidden = targets.filter(isHidden).map((target): HiddenRelationTarget => ({ id: target.id, hidden: true }));
    result[property.key] = {
      names: await Promise.all(readable.map((target) => itemTitle(client, target))),
      truncated: rows.length > MAX_RELATION_TARGETS,
      ...(hidden.length > 0 ? { hidden } : {}),
    };
  }
  return result;
}

async function inboxRelatedItems(client: PoolClient, item: ItemRow, owner: string | null) {
  if (owner !== "inbox" && owner !== "processingProposals") return [];
  const proposals = await getDatabaseByModuleId(client, "processingProposals");
  if (!proposals) return [];
  const property = (await listPropertiesByDatabase(client, proposals.id)).find((entry) => entry.key === "sourceInbox");
  const definition = property ? await getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!definition) return [];
  const { rows } = await client.query<{ item_a: string; item_b: string }>(
    `SELECT item_a, item_b FROM item_relations WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)
     ORDER BY id LIMIT $3`,
    [definition.id, item.id, MAX_RELATION_TARGETS + 1],
  );
  const ids = rows.slice(0, MAX_RELATION_TARGETS).map((edge) => (edge.item_a === item.id ? edge.item_b : edge.item_a));
  const related = await projectItemsForRead(client, await getItemsByIds(client, ids));
  return {
    items: related.map((entry) => ({ id: entry.id, properties: entry.properties })),
    truncated: rows.length > MAX_RELATION_TARGETS,
  };
}

async function mailThreadMessages(client: PoolClient, itemId: string) {
  const { rows } = await client.query<{ item_id: string }>(
    `SELECT m.item_id FROM mail_message_meta source
       JOIN mail_message_meta m ON m.tenant_id = source.tenant_id AND m.thread_id = source.thread_id
       JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
      WHERE source.item_id = $1 AND source.thread_id IS NOT NULL AND i.deleted_at IS NULL
      ORDER BY COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at) DESC, i.id DESC
      LIMIT 101`,
    [itemId],
  );
  const selected = rows.slice(0, 100);
  const projected = await projectItemsForRead(
    client,
    await getItemsByIds(
      client,
      selected.map((row) => row.item_id),
    ),
  );
  const byId = new Map(projected.map((item) => [item.id, item]));
  return {
    messages: selected.flatMap((row) => {
      const item = byId.get(row.item_id);
      return item ? [{ id: item.id, properties: item.properties }] : [];
    }),
    truncated: rows.length > 100,
  };
}

async function itemBlob(client: PoolClient, item: ItemRow): Promise<SempRefContext["blob"]> {
  const metadata = (await loadBlobMetadataForItems(client, [item])).get(item.id);
  if (!metadata) return null;
  const first = Object.values(metadata)[0];
  return first ? blobProjection(await getBlob(client, first.blobId)) : null;
}

async function blockDetails(client: PoolClient, itemId: string, blockId: string): Promise<unknown> {
  const state = (await readRefDocumentStates(client, [itemId]))[0];
  if (!state) return null;
  const doc = new Y.Doc();
  try {
    if (state.snapshot) Y.applyUpdate(doc, state.snapshot);
    for (const update of state.updates) Y.applyUpdate(doc, update);
    const block = getBlock(doc, blockId);
    if (!block) return null;
    const blocks = listBlocks(doc);
    const parent = blocks.find(
      (candidate) => Array.isArray(candidate["sys:children"]) && candidate["sys:children"].includes(blockId),
    );
    const siblings =
      parent && Array.isArray(parent["sys:children"])
        ? parent["sys:children"]
            .flatMap((id: unknown) => (typeof id === "string" ? [getBlock(doc, id)] : []))
            .filter((entry) => entry !== null)
        : [];
    return { block, parent: parent ?? null, siblings };
  } finally {
    doc.destroy();
  }
}

const SERIES_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A future occurrence of a repeating task (issue #1771): the series template, the day and the relations of the series'
 * current instance, which carries the series' project, people and attachments. A series the tenant does not hold
 * (deleted since the message was sent, or never there), one whose owner item is deleted, and one whose row has no template
 * are unavailable.
 */
async function readTaskOccurrenceContext(
  client: PoolClient,
  seriesId: string,
  occurrenceDate: string,
  unreadableDatabaseIds: ReadonlySet<string>,
): Promise<SempRefContext | null> {
  // `series_id` is a uuid column: a string of any other shape names no series, and must not reach the cast.
  if (!SERIES_ID_SHAPE.test(seriesId)) return null;
  const series = await getTaskRecurrenceBySeriesId(client, seriesId.toLowerCase());
  if (!series?.template) return null;
  // Soft deletion keeps the recurrence row until the purge: a series whose current owner item is gone is unavailable.
  const [instance] = await getItemsByIds(client, [series.itemId]);
  if (!instance) return null;
  const template = publicTaskRecurrenceTemplate(series.template);
  return {
    label: Array.from(template.name ?? "")
      .slice(0, 500)
      .join(""),
    state: "active",
    details: {
      series: { seriesId: seriesId.toLowerCase(), mode: series.mode, rule: series.rule, anchorDate: series.anchorDate },
      template,
      occurrenceDate,
      relations: await relatedNames(client, instance, TASK_RELATED_KEYS, unreadableDatabaseIds),
    },
    blob: null,
  };
}

/** Who the context is read for. */
export interface SempRefReader {
  /**
   * The Projects item of the agent the context is built for (issue #1849). The names of relation targets that lie in a
   * database this project may not read are left out and listed as `{ id, hidden: true }`. Without a reader every target
   * is named.
   */
  agentProjectItemId: string;
}

/** What the read knows about the turn that asks for it. */
export interface SempRefReadOptions {
  /**
   * True when the refs are those of the message of the turn that is starting. Only a `sleepNight` ref depends on it
   * (issue #1853): its sleep databases are sensitive, so the night is read under the reader's database grants, or
   * because the turn attached it. Every other kind is read because the user attached it, whatever the turn.
   */
  attachedThisTurn?: boolean;
}

/**
 * Composes existing tenant readers for exactly the reference carried by this turn. The referenced item itself is
 * read because the user attached it; the items it relates to are read only as far as `reader` may read them.
 *
 * A `sleepNight` ref is read in a REPEATABLE READ transaction (the caller opens it; any other level throws an `Error`)
 * and throws a `ForbiddenError` when neither a grant of `reader` nor `options.attachedThisTurn` allows it.
 */
export async function readSempRefContext(
  client: PoolClient,
  ref: SempMessageRef,
  reader?: SempRefReader,
  options: SempRefReadOptions = {},
): Promise<SempRefContext | null> {
  requireManagedTransaction(client);
  if (currentTenantScope()?.kind !== "tenant") throw new Error("Semp reference read requires tenant scope");
  if (ref.kind === "sleepNight") {
    return readSleepNightContext(client, ref.night, {
      agentProjectItemId: reader?.agentProjectItemId,
      attachedThisTurn: options.attachedThisTurn === true,
    });
  }
  if (ref.kind === "transcriptSegment") {
    const expansion = await expandTranscriptSegmentRef(client, ref);
    return expansion && { ...expansion, blob: null };
  }
  if (ref.kind === "agentRun") {
    const run = await getAgentRun(client, ref.agentRunId);
    if (!run) return null;
    const { rows } = await client.query<{ kind: string; payload: string; truncated: boolean }>(
      `SELECT kind, left(payload::text, 8000) AS payload, length(payload::text) > 8000 AS truncated
       FROM agent_run_events WHERE agent_run_id = $1 AND kind IN ('tool_use', 'tool_result') ORDER BY id LIMIT 101`,
      [run.id],
    );
    return {
      label: Array.from(run.task).slice(0, 120).join(""),
      state: "active",
      details: { task: run.task, status: run.status, steps: rows.slice(0, 100), truncated: rows.length > 100 },
      blob: null,
    };
  }
  if (ref.kind === "approvalRequest") {
    const request = await getApprovalRequest(client, ref.approvalRequestId);
    if (!request) return null;
    return {
      label: request.description?.key ?? "",
      state: "active",
      details: { description: request.description, status: request.status, reason: request.reason },
      blob: null,
    };
  }
  if (ref.kind === "mailAttachment") {
    const { rows } = await client.query<{ filename: string; content_type: string; byte_size: string; blob_id: string }>(
      "SELECT filename, content_type, byte_size, blob_id FROM mail_attachments WHERE id = $1",
      [ref.attachmentId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      label: row.filename,
      state: "active",
      details: { filename: row.filename, contentType: row.content_type, byteSize: row.byte_size },
      blob: blobProjection(await getBlob(client, row.blob_id)),
    };
  }
  if (ref.kind === "mailThread") {
    // The agent is handed the thread the id leads to now, which `mail.thread.get` reads; a purged thread is unavailable.
    const [target] = await resolveMailThreadRefTargets(client, [ref.threadId]);
    if (!target) return null;
    return {
      label: Array.from(target.label ?? "")
        .slice(0, 500)
        .join(""),
      state: target.state,
      details: { threadId: target.currentThreadId },
      blob: null,
    };
  }
  const unreadableDatabaseIds = reader
    ? await listUnreadableDatabaseIds(client, reader.agentProjectItemId)
    : new Set<string>();
  if (ref.kind === "taskOccurrence")
    return readTaskOccurrenceContext(client, ref.seriesId, ref.occurrenceDate, unreadableDatabaseIds);
  const [raw] = await getItemsByIdsIncludingDeleted(client, [ref.itemId]);
  if (!raw || ((ref.kind === "item" || ref.kind === "taskTrace") && raw.databaseId !== ref.databaseId.toLowerCase()))
    return null;
  // A trace names a live task: a task deleted since the message was sent is unavailable, not a trashed marker.
  if (ref.kind === "taskTrace" && raw.deletedAt) return null;
  const item = (await projectItemsForRead(client, [raw]))[0];
  if (!item) return null;
  const database = await getDatabase(client, item.databaseId);
  if (!database) return null;
  // A deleted task is unavailable, like a deleted trace; other trashed items keep the trashed marker.
  if (ref.kind === "item" && item.deletedAt && database.ownerModuleId === "tasks") return null;
  const label = await itemTitle(client, item);
  const state = item.deletedAt ? "trashed" : "active";
  if (ref.kind === "taskTrace") {
    if (database.ownerModuleId !== "tasks") return null;
    return {
      label,
      state,
      details: {
        properties: item.properties,
        relations: await relatedNames(client, item, TASK_RELATED_KEYS, unreadableDatabaseIds),
        traceDay: ref.traceDay,
      },
      blob: null,
    };
  }
  if (ref.kind === "block") {
    const block = await blockDetails(client, item.id, ref.blockId);
    return block === null ? null : { label, state, details: { page: item.properties, ...{ block } }, blob: null };
  }
  if (database.ownerModuleId === "transcripts") {
    const segments = segmentsSchema.parse(item.computed.segments ?? []);
    const speakers = item.deletedAt ? [] : await listTranscriptSpeakers(client, item.id, item);
    return {
      label,
      state,
      details: { properties: item.properties, summary: item.computed.summary ?? null, segments, speakers },
      blob: null,
    };
  }
  return {
    label,
    state,
    details: {
      properties: item.properties,
      relations: await relatedNames(
        client,
        item,
        database.ownerModuleId === "tasks" ? TASK_RELATED_KEYS : RELATED_KEYS,
        unreadableDatabaseIds,
      ),
      inboxRelated: await inboxRelatedItems(client, item, database.ownerModuleId),
      ...(database.ownerModuleId === "emails" ? { thread: await mailThreadMessages(client, item.id) } : {}),
    },
    blob: database.ownerModuleId === "files" ? await itemBlob(client, item) : null,
  };
}
