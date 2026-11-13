import type { PoolClient } from "pg";
import * as Y from "yjs";
import { messageRefKey, type SempMessageRef } from "@semprec/shared";
import { requireManagedTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getBlock } from "../docs/blocks.js";
import { readRefDocumentStates } from "../docs/docsStore.js";
import { validateTranscriptSegmentRefs } from "../transcription/transcriptSegmentRef.js";

const SERIES_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates references against the tenant state observed by the send transaction. */
export async function validateSempMessageRefs(
  client: PoolClient,
  refs: readonly SempMessageRef[],
): Promise<SempMessageRef[]> {
  requireManagedTransaction(client);
  const valid = new Set<number>();
  const items = refs.flatMap((ref, index) => (ref.kind === "item" ? [{ ...ref, index }] : []));
  if (items.length) {
    const { rows } = await client.query<{ ordinal: number }>(
      `SELECT r.ordinal::int FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS r(item_id, database_id, ordinal)
       JOIN items i ON i.id = r.item_id AND i.database_id = r.database_id`,
      [items.map((ref) => ref.itemId), items.map((ref) => ref.databaseId)],
    );
    for (const row of rows) {
      const entry = items[row.ordinal - 1];
      if (!entry) throw new Error("Invalid reference ordinal");
      valid.add(entry.index);
    }
  }
  // A trace names a live Tasks item of this tenant; unlike a plain item ref a trashed item does not qualify.
  const traces = refs.flatMap((ref, index) => (ref.kind === "taskTrace" ? [{ ...ref, index }] : []));
  if (traces.length) {
    const { rows } = await client.query<{ ordinal: number }>(
      `SELECT r.ordinal::int FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS r(item_id, database_id, ordinal)
       JOIN items t ON t.id = r.item_id AND t.database_id = r.database_id AND t.deleted_at IS NULL
       JOIN databases d ON d.id = t.database_id AND d.tenant_id = t.tenant_id
       WHERE d.owner_module_id = 'tasks'`,
      [traces.map((ref) => ref.itemId), traces.map((ref) => ref.databaseId)],
    );
    for (const row of rows) {
      const entry = traces[row.ordinal - 1];
      if (!entry) throw new Error("Invalid reference ordinal");
      valid.add(entry.index);
    }
  }
  // An occurrence names a series of this tenant whose current owner item is live: soft deletion keeps the recurrence
  // row until the purge, so the owner is checked. The id is any string on the wire, but `series_id` is a uuid column, so
  // a string of another shape names no series and is never sent to the cast; a foreign series is simply not visible.
  const occurrences = refs.flatMap((ref, index) =>
    ref.kind === "taskOccurrence" && SERIES_ID_SHAPE.test(ref.seriesId) ? [{ id: ref.seriesId, index }] : [],
  );
  if (occurrences.length) {
    const { rows } = await client.query<{ ordinal: number }>(
      `SELECT r.ordinal::int FROM unnest($1::uuid[]) WITH ORDINALITY AS r(series_id, ordinal)
       JOIN task_recurrence t ON t.series_id = r.series_id
       JOIN items owner ON owner.id = t.item_id AND owner.deleted_at IS NULL`,
      [occurrences.map((entry) => entry.id)],
    );
    for (const row of rows) {
      const entry = occurrences[row.ordinal - 1];
      if (!entry) throw new Error("Invalid reference ordinal");
      valid.add(entry.index);
    }
  }
  // A segment ref names a transcript and a range `transcript.segment.get` could read (issue #1834); the kind's
  // validator decides each ref over one statement that reads the segments of every transcript named.
  const segments = refs.flatMap((ref, index) => (ref.kind === "transcriptSegment" ? [{ ref, index }] : []));
  if (segments.length) {
    const accepted = await validateTranscriptSegmentRefs(
      client,
      segments.map((entry) => entry.ref),
    );
    for (const [position, entry] of segments.entries()) if (accepted[position]) valid.add(entry.index);
  }
  const blocks = refs.flatMap((ref, index) => (ref.kind === "block" ? [{ ...ref, index }] : []));
  if (blocks.length) {
    const states = await readRefDocumentStates(
      client,
      blocks.map((ref) => ref.itemId),
    );
    for (const state of states) {
      const doc = new Y.Doc();
      try {
        if (state.snapshot) Y.applyUpdate(doc, state.snapshot);
        for (const update of state.updates) Y.applyUpdate(doc, update);
        for (const ref of blocks) {
          if (ref.itemId.toLowerCase() === state.itemId && getBlock(doc, ref.blockId)) valid.add(ref.index);
        }
      } finally {
        doc.destroy();
      }
    }
  }
  const attachments = refs.flatMap((ref, index) =>
    ref.kind === "mailAttachment" ? [{ id: ref.attachmentId, index }] : [],
  );
  const runs = refs.flatMap((ref, index) => (ref.kind === "agentRun" ? [{ id: ref.agentRunId, index }] : []));
  const approvals = refs.flatMap((ref, index) =>
    ref.kind === "approvalRequest" ? [{ id: ref.approvalRequestId, index }] : [],
  );
  for (const [table, entries] of [
    ["mail_attachments", attachments],
    ["agent_runs", runs],
    ["approval_requests", approvals],
  ] as const) {
    if (!entries.length) continue;
    // The interpolated table is selected exclusively from the closed literal list above.
    const { rows } = await client.query<{ ordinal: number }>(
      `SELECT r.ordinal::int FROM unnest($1::uuid[]) WITH ORDINALITY AS r(id, ordinal) JOIN ${table} t ON t.id = r.id`,
      [entries.map((entry) => entry.id)],
    );
    for (const row of rows) {
      const entry = entries[row.ordinal - 1];
      if (!entry) throw new Error("Invalid reference ordinal");
      valid.add(entry.index);
    }
  }
  // A sleep night is virtual: its date is validated by the ref schema and no row has to exist for it.
  for (const [index, ref] of refs.entries()) if (ref.kind === "sleepNight") valid.add(index);
  const seen = new Set<string>();
  return refs.filter((ref, index) => {
    if (!valid.has(index)) throw new ValidationError("Invalid reference", { field: `context[${index}]` });
    const key = messageRefKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
