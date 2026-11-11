import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { ValidationError } from "../errors.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";

/** The one key this writer may set on a Mailboxes item: `addresses`, `owner: 'system'` since issue #1454. */
const MAILBOX_ADDRESSES_ALLOWED_KEYS = ["addresses"] as const;

export interface WriteMailboxAddressesInput {
  /** The Mailboxes database of the tenant the write runs in. */
  mailboxesDatabaseId: string;
  mailboxItemId: string;
  /** The address the provider verified for the account. Normalized and written first. */
  address: string;
  /** Alias addresses the flow appends after `address`. Normalized, de-duplicated, empty entries dropped. */
  aliases?: readonly string[];
}

/**
 * The sanctioned writer of `Mailboxes.addresses` (issue #1454). The property is `owner: 'system'`, so
 * the generic item write path refuses it with `owner_violation`. The OAuth connect flow (issue
 * gh-1686, `mailOauthRouteHandlers.ts`) calls this instead, passing the aliases it keeps, and the
 * password connect flow (issue gh-1736, `mailboxPasswordRouteHandlers.ts`) calls it without aliases.
 * It replaces the whole list, so a flow that keeps existing aliases must pass them in `aliases`. The
 * write runs in the caller's transaction through the choke point's update path.
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
