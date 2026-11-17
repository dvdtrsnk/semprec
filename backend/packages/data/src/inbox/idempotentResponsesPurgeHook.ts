import type { ItemPurgeHook } from "../chokePoint/hooks.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { deleteExpiredIdempotentResponses } from "./idempotentResponsesStore.js";

/**
 * The rows do not name the card, so purging a Processing proposals card is only the moment to sweep one batch of the
 * tenant's expired rows, in the purge's transaction.
 */
export const idempotentResponsesPurgeHook: ItemPurgeHook = async ({ client, database }) => {
  if (!database.system || database.ownerModuleId !== PROCESSING_PROPOSALS_MODULE_ID) return;
  await deleteExpiredIdempotentResponses(client);
};
