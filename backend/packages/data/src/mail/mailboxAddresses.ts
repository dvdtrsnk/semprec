import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { ValidationError } from "../errors.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";

const MAILBOX_ADDRESSES_ALLOWED_KEYS = ["addresses"] as const;

export interface WriteMailboxAddressesInput {
  mailboxesDatabaseId: string;
  mailboxItemId: string;
  /** Normalized and written first. */
  address: string;
  /** Normalized, de-duplicated, empty entries dropped. */
  aliases?: readonly string[];
}

/**
 * The sanctioned writer of `Mailboxes.addresses`, which is `owner: 'system'` and so refused by the
 * generic write path. It replaces the whole list, so a flow that keeps existing aliases must pass them.
 */
export async function writeMailboxAddresses(client: PoolClient, input: WriteMailboxAddressesInput): Promise<void> {
  const primary = normalizeEmailAddress(input.address);
  if (primary.length === 0) {
    throw new ValidationError("A mailbox address must not be empty", { field: "addresses" });
  }
  const aliases = (input.aliases ?? []).map(normalizeEmailAddress).filter((alias) => alias.length > 0);
  const addresses = [...new Set([primary, ...aliases])];
  await updateItemWithClient(
    client,
    {
      databaseId: input.mailboxesDatabaseId,
      itemId: input.mailboxItemId,
      propertiesPatch: { addresses: addresses.join("\n") },
    },
    { allowedSystemKeys: MAILBOX_ADDRESSES_ALLOWED_KEYS },
  );
}

export interface MailboxAddressHoldersInput {
  mailboxesDatabaseId: string;
  addresses: readonly string[];
  /** The mailbox the question is asked for, which does not count. */
  exceptItemId?: string;
}

/**
 * Whether another mailbox holds one of `addresses`, compared after normalization: a sync state row records it as
 * the provider account address, or a live Mailboxes item's `addresses` list names it. A trashed mailbox has no sync
 * state row (its removal deletes it), so only live mailboxes count. The reads take no row lock.
 */
export async function mailboxHoldsAnyAddress(client: PoolClient, input: MailboxAddressHoldersInput): Promise<boolean> {
  const wanted = new Set(input.addresses.map(normalizeEmailAddress).filter((address) => address.length > 0));
  if (wanted.size === 0) return false;
  const except = input.exceptItemId ?? null;
  const recorded = await client.query<{ item_id: string }>(
    `SELECT item_id FROM mail_account_sync_state
      WHERE provider_account_address = ANY($1::text[]) AND ($2::uuid IS NULL OR item_id <> $2::uuid)
      LIMIT 1`,
    [[...wanted], except],
  );
  if (recorded.rows.length > 0) return true;
  const listed = await client.query<{ addresses: string | null }>(
    `SELECT properties->>'addresses' AS addresses FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [input.mailboxesDatabaseId, except],
  );
  return listed.rows.some((row) =>
    parseAddressListProperty(row.addresses).some((entry) => wanted.has(normalizeEmailAddress(entry))),
  );
}
