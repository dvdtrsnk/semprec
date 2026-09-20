import type { PoolClient } from "pg";
import { requireAffectedRows, type Queryable } from "../db/pool.js";
import { FLAGGED_PROPERTY_KEY, READ_PROPERTY_KEY, type WritableImapFlag } from "./messageFlags.js";

export type MailMessageFlagKey = typeof READ_PROPERTY_KEY | typeof FLAGGED_PROPERTY_KEY;

export interface PendingImapFlagWrite {
  messageItemId: string;
  propertyKey: MailMessageFlagKey;
  desiredState: boolean;
  folderPath: string;
  uid: number;
}

function isMailMessageFlagKey(value: string): value is MailMessageFlagKey {
  return value === READ_PROPERTY_KEY || value === FLAGGED_PROPERTY_KEY;
}

/** Records a user/agent-originated desired state inside the generic item's transaction. */
export async function recordDesiredMailMessageFlags(
  client: PoolClient,
  messageItemId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  for (const [propertyKey, value] of Object.entries(patch)) {
    if (!isMailMessageFlagKey(propertyKey) || typeof value !== "boolean") continue;
    await client.query(
      `INSERT INTO mail_message_flag_sync_state (message_item_id, property_key, desired_state)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_item_id, property_key) DO UPDATE
       SET desired_state = EXCLUDED.desired_state, updated_at = now()`,
      [messageItemId, propertyKey, value],
    );
  }
}

/** Records flags observed from a provider without replacing a pending user request. */
export async function recordObservedMailMessageFlags(
  client: PoolClient,
  messageItemId: string,
  flags: Readonly<Record<MailMessageFlagKey, boolean>>,
): Promise<void> {
  for (const [propertyKey, value] of Object.entries(flags)) {
    if (!isMailMessageFlagKey(propertyKey)) continue;
    await client.query(
      `INSERT INTO mail_message_flag_sync_state (message_item_id, property_key, desired_state, current_state)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (message_item_id, property_key) DO UPDATE
       SET current_state = EXCLUDED.current_state, updated_at = now()`,
      [messageItemId, propertyKey, value],
    );
  }
}

/** Maps an IMAP flag-state write back to the persisted provider-confirmed state. */
export async function recordConfirmedMailMessageFlag(
  client: PoolClient,
  messageItemId: string,
  propertyKey: MailMessageFlagKey,
  currentState: boolean,
): Promise<void> {
  const result = await client.query(
    `UPDATE mail_message_flag_sync_state
     SET current_state = $3, updated_at = now()
     WHERE message_item_id = $1 AND property_key = $2`,
    [messageItemId, propertyKey, currentState],
  );
  requireAffectedRows(result, "mail message flag confirmation");
}

/** Pending IMAP writes are resolved through the message's folder-edge UID metadata. */
export async function listPendingImapFlagWrites(
  client: Queryable,
  input: { folderRelationDefinitionId: string; mailboxFolderRelationDefinitionId: string; mailboxItemId: string },
): Promise<PendingImapFlagWrite[]> {
  const { rows } = await client.query<{
    message_item_id: string;
    property_key: string;
    desired_state: boolean;
    folder_path: string;
    uid: string;
  }>(
    `SELECT DISTINCT ON (state.message_item_id, state.property_key)
       state.message_item_id, state.property_key, state.desired_state,
       folder.properties ->> 'providerId' AS folder_path, email_folder.metadata ->> 'uid' AS uid
     FROM mail_message_flag_sync_state state
     JOIN item_relations email_folder
       ON email_folder.relation_definition_id = $1
      AND (email_folder.item_a = state.message_item_id OR email_folder.item_b = state.message_item_id)
     JOIN items folder
       ON folder.id = CASE WHEN email_folder.item_a = state.message_item_id THEN email_folder.item_b ELSE email_folder.item_a END
     JOIN item_relations mailbox_folder
       ON mailbox_folder.relation_definition_id = $2
      AND (mailbox_folder.item_a = folder.id OR mailbox_folder.item_b = folder.id)
      AND (mailbox_folder.item_a = $3 OR mailbox_folder.item_b = $3)
     WHERE state.current_state IS DISTINCT FROM state.desired_state
       AND folder.deleted_at IS NULL
       AND email_folder.metadata ->> 'uid' ~ '^[0-9]+$'
       AND folder.properties ->> 'providerId' IS NOT NULL
     ORDER BY state.message_item_id, state.property_key, folder.id`,
    [input.folderRelationDefinitionId, input.mailboxFolderRelationDefinitionId, input.mailboxItemId],
  );
  return rows.flatMap((row) => {
    if (!isMailMessageFlagKey(row.property_key)) return [];
    const uid = Number(row.uid);
    if (!Number.isSafeInteger(uid) || uid < 1) return [];
    return [
      {
        messageItemId: row.message_item_id,
        propertyKey: row.property_key,
        desiredState: row.desired_state,
        folderPath: row.folder_path,
        uid,
      },
    ];
  });
}

export function imapFlagForProperty(propertyKey: MailMessageFlagKey): WritableImapFlag {
  return propertyKey === READ_PROPERTY_KEY ? "\\Seen" : "\\Flagged";
}
