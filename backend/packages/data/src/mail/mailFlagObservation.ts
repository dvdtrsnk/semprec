import type { PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { convergeObservedEmailFlagsWithClient } from "../chokePoint/itemWrites.js";
import { recordObservedMailMessageFlags, type MailMessageFlagKey } from "./mailMessageFlagSyncStore.js";
import { FLAGGED_PROPERTY_KEY, READ_PROPERTY_KEY, messageFlagProperties } from "./messageFlags.js";

export interface ApplyObservedMailMessageFlagsInput {
  emailsDatabaseId: string;
  messageItemId: string;
  flags: readonly string[];
}

/**
 * Folds a provider flag observation (a full IMAP re-fetch of a known UID, or the flags an
 * already-known message carries on a later sync pass) into both the Emails item and
 * `mail_message_flag_sync_state`, called inside the caller's own transaction.
 *
 * For each of `read`/`flagged`: when the sync-state row is absent or converged (no pending
 * write-back), and the observed value differs from what the item currently stores, the item is
 * patched through `convergeObservedEmailFlagsWithClient` (`itemWrites.ts`) — this module's own
 * declared, narrow ownership handoff for these two owner:'user' fields, not the generic
 * `updateItemWithClient` a user-initiated PATCH goes through (see that function's doc comment
 * for why the distinction matters). When the row is pending (a user change is still awaiting
 * write-back), the item is left alone so the pending write survives. Either way,
 * `recordObservedMailMessageFlags` runs once for both flags afterwards to set `current_state`
 * and, for a converged row, `desired_state` too (`mailMessageFlagSyncStore.ts`'s own
 * converged/pending check), so the two calls agree regardless of ordering.
 */
export async function applyObservedMailMessageFlags(
  client: PoolClient,
  input: ApplyObservedMailMessageFlagsInput,
): Promise<void> {
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

  const item = await getItemById(client, input.emailsDatabaseId, input.messageItemId);
  if (!item) throw new NotFoundError(`Emails item ${input.messageItemId} not found`);

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
