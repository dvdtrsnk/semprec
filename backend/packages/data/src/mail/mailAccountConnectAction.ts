import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { ensureMailAccountSyncState, defaultSyncModeForProvider } from "./mailAccountSyncStateStore.js";

export const MAIL_CONNECT_ACCOUNT_ACTION_ID = "mail.connectAccount";

export interface MailConnectAccountActionConfig {
  mailboxesDatabaseId: string;
}

/**
 * Registered as an `onItemEvent` ('create') heartbeat action on the Mailboxes database
 * (issue #26's "Provider strategy" decision): `sync_mode` is "defaulted by `provider`... but
 * manually switchable" — this is the one place that initial default gets chosen, the moment a
 * Mailbox row exists. Idempotent (`ensureMailAccountSyncState` is itself a no-op past the
 * first call), so a heartbeat retry after a transient failure can't clobber a mode the user
 * already switched via `setSyncMode`. Deliberately does not itself enqueue the first sync: a
 * freshly created Mailbox has no stored credential yet (connecting one is a later step this
 * issue doesn't own the UI for — see issue #27) and `handleSyncMailAccountTask` would just fail
 * immediately; the newly inserted row's `next_expected_activity_at` is NULL, so
 * `listAccountsDueForSync` already picks it up on the next periodic sweep once a credential
 * exists, with no separate "credential connected" trigger needed.
 */
export function createMailAccountConnectAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    const config = actionConfig as unknown as MailConnectAccountActionConfig;
    await withTransaction(pool, async (client) => {
      const mailbox = await itemsStore.getItemById(client, config.mailboxesDatabaseId, context.itemId as string);
      if (!mailbox || mailbox.deletedAt) return;
      const provider = typeof mailbox.properties.provider === "string" ? mailbox.properties.provider : "generic";
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: defaultSyncModeForProvider(provider) });
    });
  };
}
