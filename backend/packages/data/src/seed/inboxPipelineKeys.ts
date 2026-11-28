/** `databases.owner_module_id` values of the Inbox pipeline. */
export const INBOX_MODULE_ID = "inbox";
export const INBOX_ITEM_TYPES_MODULE_ID = "inboxItemTypes";
export const PROCESSING_PROPOSALS_MODULE_ID = "processingProposals";

/**
 * Databases the Alldots project owns but its agent may not write: the agent's only write surface is
 * Processing proposals. Used by the permission manifest and by `assertValidProposalEnvelope`, which is
 * the actual enforcement: a user `revise` could otherwise target one of these and `confirm` would write
 * it, since nothing before the choke point reads the manifest's `writable: false`.
 */
export const ALLDOTS_READ_ONLY_MODULE_IDS: readonly string[] = [INBOX_MODULE_ID, INBOX_ITEM_TYPES_MODULE_ID];
