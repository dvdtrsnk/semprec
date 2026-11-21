import type { PoolClient } from "pg";
import { z } from "zod";

/** One attachment of a message as the thread detail and the content route list it. */
export const mailMessageAttachmentSchema = z.object({
  attachmentId: z.uuid(),
  /** Whether the bytes are stored; an index message's attachment has no blob and no Files item. */
  stored: z.boolean(),
  fileItemId: z.uuid().nullable(),
  blobId: z.uuid().nullable(),
  filename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
});

export type MailMessageAttachment = z.infer<typeof mailMessageAttachmentSchema>;

/**
 * The CTEs `MAIL_MESSAGE_ATTACHMENTS_LATERAL` reads: the Files database and the Emails `attachments` relation
 * definition of the current tenant.
 */
export const MAIL_MESSAGE_ATTACHMENTS_CTES = `attachment_files AS (
  SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'files'
), attachment_relation AS (
  SELECT rd.id, rd.property_id_a = p.id AS email_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.key = 'attachments'
    AND p.database_id = (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'emails')
)`;

/**
 * `attachments.value`: the `mail_attachments` rows of the Emails item `d.item_id` as a JSON array of
 * `mailMessageAttachmentSchema`, each with the live Files item the Email links over `attachments` for the same blob
 * and name (the n-th row of a blob and name pairs with the n-th such item), ordered by name. NULL for none. Needs
 * `MAIL_MESSAGE_ATTACHMENTS_CTES` in the statement's WITH clause.
 */
export const MAIL_MESSAGE_ATTACHMENTS_LATERAL = `LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('attachmentId', a.id, 'stored', a.blob_id IS NOT NULL,
    'fileItemId', f.id, 'blobId', a.blob_id, 'filename', a.filename,
    'contentType', a.content_type, 'byteSize', a.byte_size) ORDER BY a.filename, a.blob_id, a.n) AS value
  FROM (
    SELECT a.*, row_number() OVER (PARTITION BY a.blob_id, a.filename ORDER BY a.id) AS n
    FROM mail_attachments a WHERE a.tenant_id = app_tenant_default() AND a.message_item_id = d.item_id
  ) a
  LEFT JOIN (
    SELECT file.id, file.properties->'file'->>'blobId' AS blob_id, file.properties->>'name' AS name,
      row_number() OVER (PARTITION BY file.properties->'file'->>'blobId', file.properties->>'name' ORDER BY file.id) AS n
    FROM attachment_relation er JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = er.id
      AND (CASE WHEN er.email_is_a THEN r.item_a ELSE r.item_b END) = d.item_id
    JOIN items file ON file.tenant_id = app_tenant_default() AND file.database_id = (SELECT id FROM attachment_files)
      AND file.id = CASE WHEN er.email_is_a THEN r.item_b ELSE r.item_a END AND file.deleted_at IS NULL
  ) f ON f.blob_id = a.blob_id::text AND f.name = a.filename AND f.n = a.n
) attachments ON true`;

const MESSAGE_ATTACHMENTS_SQL = `
WITH ${MAIL_MESSAGE_ATTACHMENTS_CTES}
SELECT COALESCE(attachments.value, '[]'::jsonb) AS attachments
FROM (SELECT $1::uuid AS item_id) d
${MAIL_MESSAGE_ATTACHMENTS_LATERAL}
`;

/** The attachments of one Emails item, read as the thread detail reads them. */
export async function readMailMessageAttachments(
  client: PoolClient,
  emailId: string,
): Promise<MailMessageAttachment[]> {
  const { rows } = await client.query<{ attachments: unknown }>(MESSAGE_ATTACHMENTS_SQL, [emailId]);
  return z.array(mailMessageAttachmentSchema).parse(rows[0]?.attachments);
}
