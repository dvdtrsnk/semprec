-- Issue #198: the Microsoft Graph webhook receiver's own authenticity check. Every
-- subscription this app registers carries a per-account secret (`clientState`) that Graph
-- echoes back unchanged on every validation/change notification POST — the receiver rejects
-- anything whose `clientState` doesn't match what was persisted at registration time, since
-- `subscriptionId` alone is guessable/enumerable and not itself proof the request came from
-- Graph. Nullable and purely additive (expand step): an account with no subscription registered
-- yet simply has no client state to check against.
ALTER TABLE mail_account_sync_state ADD COLUMN graph_client_state text;

-- The webhook receiver's only way to map an inbound notification's `subscriptionId` back to
-- the account it belongs to (mailAccountSyncStateStore.ts's
-- `getMailAccountSyncStateByGraphSubscriptionId`). Unique and partial: Graph subscription ids
-- are globally unique once assigned, and most rows have none yet (`graph_client_state`'s own
-- NULL case above).
CREATE UNIQUE INDEX mail_account_sync_state_graph_subscription_id_uq
  ON mail_account_sync_state (graph_subscription_id) WHERE graph_subscription_id IS NOT NULL;
