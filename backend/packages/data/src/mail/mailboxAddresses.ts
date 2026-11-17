import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { ValidationError } from "../errors.js";
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
