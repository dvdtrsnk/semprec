import type { PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
import { convergeObservedEmailFlagsWithClient, lockItemForObservedMailFlags } from "../chokePoint/itemWrites.js";
import { recordObservedMailMessageFlags, type MailMessageFlagKey } from "./mailMessageFlagSyncStore.js";
import { FLAGGED_PROPERTY_KEY, READ_PROPERTY_KEY, messageFlagProperties } from "./messageFlags.js";

export interface ApplyObservedMailMessageFlagsInput {
  emailsDatabaseId: string;
  messageItemId: string;
  /** The folder whose copy the flags were observed on. */
  folderItemId: string;
  flags: readonly string[];
}

/**
 * An IMAP server keeps mail to oneself twice: the Sent copy (appended `\Seen`) and the delivered one. The item's flags
 * follow the delivered copy, so a Sent copy's observation is ignored while the item has a copy with a UID elsewhere.
 */
async function isSentCopyBesideDeliveredCopy(client: PoolClient, input: ApplyObservedMailMessageFlagsInput) {
  const { rows } = await client.query<{ ignored: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM items observed
       WHERE observed.tenant_id = app_tenant_default() AND observed.id = $3
         AND observed.properties->>'specialPurpose' = 'sent'
     ) AND EXISTS (
       SELECT 1 FROM properties p
       JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
       JOIN item_relations edge ON edge.tenant_id = p.tenant_id AND edge.relation_definition_id = rd.id
         AND (edge.item_a = $2 OR edge.item_b = $2) AND edge.metadata ? 'uid'
       JOIN items folder ON folder.tenant_id = p.tenant_id AND folder.deleted_at IS NULL
         AND folder.id = CASE WHEN edge.item_a = $2 THEN edge.item_b ELSE edge.item_a END
       WHERE p.tenant_id = app_tenant_default() AND p.database_id = $1 AND p.key = 'folder'
         AND COALESCE(folder.properties->>'specialPurpose', 'none') <> 'sent'
     ) AS ignored`,
    [input.emailsDatabaseId, input.messageItemId, input.folderItemId],
  );
  return rows[0]?.ignored === true;
}

/**
 * Folds a provider flag observation into the Emails item and `mail_message_flag_sync_state`, in the caller's
 * transaction. For `read`/`flagged`, the item is patched through `convergeObservedEmailFlagsWithClient` (the module's
 * narrow ownership handoff for these user-owned fields) only when no write-back is pending, so a pending user change
 * survives. `recordObservedMailMessageFlags` then records the observation for both flags.
 *
 * Locks the items row before the sync-state row, the order the user write path takes; the reverse order would
 * deadlock against a concurrent user flag update (40P01). The Sent copy of mail to oneself is not observed while its
 * delivered copy is known.
 */
export async function applyObservedMailMessageFlags(
  client: PoolClient,
  input: ApplyObservedMailMessageFlagsInput,
): Promise<void> {
  const item = await lockItemForObservedMailFlags(client, input.emailsDatabaseId, input.messageItemId);
  if (!item) throw new NotFoundError(`Emails item ${input.messageItemId} not found`);
  if (await isSentCopyBesideDeliveredCopy(client, input)) return;

  const { rows } = await client.query<{
    property_key: string;
    desired_state: boolean;
    current_state: boolean | null;
  }>(
    `SELECT property_key, desired_state, current_state FROM mail_message_flag_sync_state
     WHERE message_item_id = $1 FOR UPDATE`,
    [input.messageItemId],
  );
  const stateByKey = new Map(rows.map((row) => [row.property_key, row]));
  const observed = messageFlagProperties(input.flags);

  const propertiesPatch: Record<string, boolean> = {};
  for (const propertyKey of [READ_PROPERTY_KEY, FLAGGED_PROPERTY_KEY] as const) {
    const observedValue = observed[propertyKey] ?? false;
    const state = stateByKey.get(propertyKey);
    const pending = state !== undefined && state.current_state !== state.desired_state;
    if (!pending && item.properties[propertyKey] !== observedValue) {
      propertiesPatch[propertyKey] = observedValue;
    }
  }

  if (Object.keys(propertiesPatch).length > 0) {
    await convergeObservedEmailFlagsWithClient(client, {
      databaseId: input.emailsDatabaseId,
      itemId: input.messageItemId,
      propertiesPatch,
    });
  }

  const observedFlags: Record<MailMessageFlagKey, boolean> = {
    read: observed.read ?? false,
    flagged: observed.flagged ?? false,
  };
  await recordObservedMailMessageFlags(client, input.messageItemId, observedFlags);
}
