// What a mail draft holds as attachments (issue gh-1895): the list the draft's view shows, the Emails items that
// hold a Files item through `Emails.attachments`, and the soft delete of a discarded draft's own files. Read by
// `draft.ts` (the view and the discard) and by `mailDraftAttachments.ts` (attach and detach); it imports neither,
// so the two can import it. It writes only through the choke point's item delete.
import type { PoolClient } from "pg";
import { z } from "zod";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";

/** One file attached to a draft, as the draft's view lists it. */
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

/**
 * The live Files items attached to the Emails item `$1` through `Emails.attachments`, with the blob each holds
 * (`$2` is the Emails database, `$3` the Files database). The edge is read from the Emails side of its definition,
 * and a Files item whose blob is unknown is not listed: an attachment is only ever created over a stored blob.
 * Fixed SQL; the parameters are ids.
 */
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

/** The files attached to draft `draftItemId`, oldest first. */
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

/**
 * The Emails items that hold the Files item `fileItemId` through `Emails.attachments`, trashed ones included: a
 * trashed email keeps its edge, and the relation allows a Files item one email only. Fixed SQL.
 */
const ATTACHMENT_OWNERS_SQL = `
SELECT (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END)::text AS "emailItemId"
FROM properties p
JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
  AND (CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END) = $1::uuid
WHERE p.tenant_id = app_tenant_default() AND p.database_id = $2::uuid AND p.key = 'attachments'`;

/** The ids of the Emails items the file is attached to, which are none for a file that is attached nowhere. */
export async function listAttachmentOwners(
  client: PoolClient,
  emailsDatabaseId: string,
  fileItemId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ emailItemId: string }>(ATTACHMENT_OWNERS_SQL, [fileItemId, emailsDatabaseId]);
  return rows.map((row) => row.emailItemId);
}

/**
 * Which of the files in `$2` have a relation edge to an item other than `$1`: an email, a project, a task or
 * anything else. Fixed SQL; the parameters are ids.
 */
const FILES_RELATED_ELSEWHERE_SQL = `
SELECT DISTINCT x.id::text AS "fileItemId"
FROM unnest($2::uuid[]) AS x(id)
JOIN item_relations r ON r.tenant_id = app_tenant_default()
  AND ((r.item_a = x.id AND r.item_b <> $1::uuid) OR (r.item_b = x.id AND r.item_a <> $1::uuid))`;

/**
 * Which of the files in `$2` were created before the Emails item `$1`: a file that existed before the draft was not
 * uploaded for it, and neither is a copy, which `attachFileToDraft` makes after the draft exists. Fixed SQL; the
 * parameters are ids.
 */
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
 * Soft-deletes the files attached to the draft that belong to it alone, in the caller's transaction: a file
 * the user uploaded for the draft, or a file `attachFileToDraft` created over another message's blob. Both are
 * created after the draft, so a file created before it is one the user already had, and is kept. So is a file that
 * has a relation edge to any item other than the draft, an email, a project or anything else. Files that are not attached to the draft are not listed and are never touched. Each delete goes through the choke point
 * (`itemDeleteWithClient`). Returns the ids it deleted. The draft's own edges are not removed; the draft is trashed
 * by the caller. Decided in
 * docs/adr/2026-11-14-a-mail-draft-attaches-copies-of-held-files-and-trashes-the-files-that-are-its-own.md.
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
