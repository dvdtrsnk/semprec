import type { PoolClient } from "pg";
import * as Y from "yjs";
import { messageRefKey, type SempMessageRef } from "@semprec/shared";
import { requireManagedTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getBlock } from "../docs/blocks.js";
import { readRefDocumentStates } from "../docs/docsStore.js";

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
  const segments = refs.flatMap((ref, index) => (ref.kind === "transcriptSegment" ? [{ ...ref, index }] : []));
  if (segments.length) {
    const { rows } = await client.query<{ ordinal: number }>(
      `SELECT r.ordinal::int FROM unnest($1::uuid[]) WITH ORDINALITY AS r(item_id, ordinal)
       JOIN items i ON i.id = r.item_id JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
       WHERE d.owner_module_id = 'transcripts'`,
      [segments.map((ref) => ref.itemId)],
    );
    for (const row of rows) {
      const entry = segments[row.ordinal - 1];
      if (!entry) throw new Error("Invalid reference ordinal");
      valid.add(entry.index);
    }
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
  const seen = new Set<string>();
  return refs.filter((ref, index) => {
    if (!valid.has(index)) throw new ValidationError("Invalid reference", { field: `context[${index}]` });
    const key = messageRefKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
