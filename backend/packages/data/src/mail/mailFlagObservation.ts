import type { PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
import { convergeObservedEmailFlagsWithClient, lockItemForObservedMailFlags } from "../chokePoint/itemWrites.js";
import { recordObservedMailMessageFlags, type MailMessageFlagKey } from "./mailMessageFlagSyncStore.js";
import { FLAGGED_PROPERTY_KEY, READ_PROPERTY_KEY, messageFlagProperties } from "./messageFlags.js";

export interface ApplyObservedMailMessageFlagsInput {
  emailsDatabaseId: string;
  messageItemId: string;
  flags: readonly string[];
}

/**
 * Folds a provider flag observation into the Emails item and `mail_message_flag_sync_state`, in the caller's
 * transaction. For `read`/`flagged`, the item is patched through `convergeObservedEmailFlagsWithClient` (the module's
 * narrow ownership handoff for these user-owned fields) only when no write-back is pending, so a pending user change
 * survives. `recordObservedMailMessageFlags` then records the observation for both flags.
 *
 * Locks the items row before the sync-state row, the order the user write path takes; the reverse order would
 * deadlock against a concurrent user flag update (40P01).
 */
export async function applyObservedMailMessageFlags(
  client: PoolClient,
  input: ApplyObservedMailMessageFlagsInput,
): Promise<void> {
  const item = await lockItemForObservedMailFlags(client, input.emailsDatabaseId, input.messageItemId);
  if (!item) throw new NotFoundError(`Emails item ${input.messageItemId} not found`);

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
