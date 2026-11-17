// Draft attachment queries and the discard-time file delete. Imports neither draft.ts nor
// mailDraftAttachments.ts so both can import it.
import type { PoolClient } from "pg";
import { z } from "zod";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";

export interface DraftAttachment {
  fileItemId: string;
  blobId: string;
  filename: string;
  byteSize: number;
}

const attachmentRow = z.object({
  fileItemId: z.uuid(),
  blobId: z.uuid(),
  filename: z.string().nullable(),
  byteSize: z.string().regex(/^[0-9]{1,15}$/),
});

/** `$1` Emails item, `$2` Emails database, `$3` Files database. Files without a known blob are not listed. */
const DRAFT_ATTACHMENTS_SQL = `
SELECT f.id AS "fileItemId", b.id AS "blobId", f.properties->>'name' AS filename, b.byte_size::text AS "byteSize"
FROM properties p
JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
  AND (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END) = $1::uuid
JOIN items f ON f.tenant_id = p.tenant_id AND f.database_id = $3::uuid
  AND f.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END AND f.deleted_at IS NULL
JOIN blobs b ON b.tenant_id = p.tenant_id AND b.id::text = f.properties->'file'->>'blobId'
WHERE p.tenant_id = app_tenant_default() AND p.database_id = $2::uuid AND p.key = 'attachments'
ORDER BY f.created_at, f.id`;

export async function listDraftAttachments(
  client: PoolClient,
  ids: { emailsDatabaseId: string; filesDatabaseId: string },
  draftItemId: string,
): Promise<DraftAttachment[]> {
  const { rows } = await client.query<Record<string, unknown>>(DRAFT_ATTACHMENTS_SQL, [
    draftItemId,
    ids.emailsDatabaseId,
    ids.filesDatabaseId,
  ]);
  return rows.map((row) => {
    const parsed = attachmentRow.parse(row);
    return {
      fileItemId: parsed.fileItemId,
      blobId: parsed.blobId,
      filename: parsed.filename ?? "",
      byteSize: Number(parsed.byteSize),
    };
  });
}

/** Trashed emails included: a trashed email keeps its edge, and a file belongs to one email only. */
const ATTACHMENT_OWNERS_SQL = `
SELECT (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END)::text AS "emailItemId"
FROM properties p
JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
  AND (CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END) = $1::uuid
WHERE p.tenant_id = app_tenant_default() AND p.database_id = $2::uuid AND p.key = 'attachments'`;

export async function listAttachmentOwners(
  client: PoolClient,
  emailsDatabaseId: string,
  fileItemId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ emailItemId: string }>(ATTACHMENT_OWNERS_SQL, [fileItemId, emailsDatabaseId]);
  return rows.map((row) => row.emailItemId);
}

/** Files in `$2` with a relation edge to any item other than `$1`. */
const FILES_RELATED_ELSEWHERE_SQL = `
SELECT DISTINCT x.id::text AS "fileItemId"
FROM unnest($2::uuid[]) AS x(id)
JOIN item_relations r ON r.tenant_id = app_tenant_default()
  AND ((r.item_a = x.id AND r.item_b <> $1::uuid) OR (r.item_b = x.id AND r.item_a <> $1::uuid))`;

/** Files in `$2` created before draft `$1`, so not uploaded or copied for it. */
const FILES_OLDER_THAN_DRAFT_SQL = `
SELECT x.id::text AS "fileItemId"
FROM unnest($2::uuid[]) AS x(id)
JOIN items f ON f.tenant_id = app_tenant_default() AND f.id = x.id
JOIN items draft ON draft.tenant_id = f.tenant_id AND draft.id = $1::uuid
WHERE f.created_at < draft.created_at`;

export interface DiscardedDraftFilesContext {
  writer: WriterIdentity;
  actingUserId?: string;
  queueAffinity: ActionQueueAffinity;
}

/**
 * Soft-deletes, in the caller's transaction, the draft's attached files that are its own: created
 * after the draft and related to no other item. Older or otherwise-related files are kept. Returns
 * the deleted ids; the caller trashes the draft (see docs/architecture/domain-mail-and-inbox.md#drafts).
 */
export async function deleteFilesOfDiscardedDraft(
  client: PoolClient,
  ids: { emailsDatabaseId: string; filesDatabaseId: string },
  draftItemId: string,
  context: DiscardedDraftFilesContext,
): Promise<string[]> {
  const attached = await listDraftAttachments(client, ids, draftItemId);
  if (attached.length === 0) return [];
  const fileItemIds = attached.map((attachment) => attachment.fileItemId);
  const related = await client.query<{ fileItemId: string }>(FILES_RELATED_ELSEWHERE_SQL, [draftItemId, fileItemIds]);
  const older = await client.query<{ fileItemId: string }>(FILES_OLDER_THAN_DRAFT_SQL, [draftItemId, fileItemIds]);
  const kept = new Set([...related.rows, ...older.rows].map((row) => row.fileItemId));
  const deleted: string[] = [];
  for (const { fileItemId } of attached) {
    if (kept.has(fileItemId)) continue;
    const trashed = await itemDeleteWithClient(client, ids.filesDatabaseId, fileItemId, {
      queueAffinity: context.queueAffinity,
      actingUserId: context.actingUserId,
      writer: context.writer,
    });
    // The file was live in the listing above and the draft that holds it is locked, so the trash finds it.
    if (trashed === null) throw new Error(`File ${fileItemId} disappeared while its draft was discarded`);
    deleted.push(fileItemId);
  }
  return deleted;
}
