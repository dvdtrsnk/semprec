// Owns the Inbox module's item purge hook (issue gh-1894): the permanent deletion of a card sweeps the expired
// stored responses of its tenant, in the purge's transaction.
// Constrained by: docs/adr/2026-11-10-item-purge-domain-hooks.md,
// docs/adr/2026-11-13-card-actions-replay-the-stored-response-of-an-idempotency-key.md
import type { ItemPurgeHook } from "../chokePoint/hooks.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { deleteExpiredIdempotentResponses } from "./idempotentResponsesStore.js";

/**
 * The Inbox module's item purge hook, registered by `../domainWriteHooks.ts`. For a card of the tenant's system
 * Processing proposals database it deletes one batch of the tenant's expired `idempotent_responses` rows through
 * their store; the rows do not name the card, so the purge is only the moment of the sweep. For an item of any other
 * database it returns before its first statement.
 */
export const idempotentResponsesPurgeHook: ItemPurgeHook = async ({ client, database }) => {
  if (!database.system || database.ownerModuleId !== PROCESSING_PROPOSALS_MODULE_ID) return;
  await deleteExpiredIdempotentResponses(client);
};
