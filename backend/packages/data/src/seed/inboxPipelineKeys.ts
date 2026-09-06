/** Canonical `databases.owner_module_id` values for the Inbox pipeline (issue #101) — all three are the `canonical-keys` skill's established vocabulary. */
export const INBOX_MODULE_ID = "inbox";
export const INBOX_ITEM_TYPES_MODULE_ID = "inboxItemTypes";
export const PROCESSING_PROPOSALS_MODULE_ID = "processingProposals";

/**
 * The Semprec project's own two owned-but-read-only-to-the-agent databases (issue #105's
 * grant separation): the agent's one write surface is Processing proposals, never Inbox
 * or Inbox item types, even though the same project owns all three. Shared by
 * `manifest/permissionManifest.ts` (the declared grant) and
 * `inbox/inboxTickAction.ts`'s `assertValidProposalEnvelope` (enforcement at the point a
 * `database`-kind envelope's target is actually validated — a user-supplied `revise`
 * could otherwise name one of these as `target` and have `confirm` write to it, bypassing
 * the manifest's `writable: false` since nothing upstream of the choke-point call reads
 * that flag).
 */
export const SEMPREC_READ_ONLY_MODULE_IDS: readonly string[] = [INBOX_MODULE_ID, INBOX_ITEM_TYPES_MODULE_ID];
