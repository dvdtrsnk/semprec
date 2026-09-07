import type { SystemRelationWriteContext } from "../chokePoint/chokePoint.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";

/**
 * Shared by every Emails-module writer of an Emails-side relation edge (folder, attachments,
 * senderPeople, recipientsPeople) — ingest, draft, send, attachments, folderDiscovery's
 * reconcilers, and personLinkingActions. These relation properties are seeded
 * `owner: 'system', ownerProcess: EMAILS_MODULE_ID` (seed/seedEmailModule.ts), so every write
 * through them must present this exact context or be rejected `owner_violation`.
 */
export const EMAILS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: EMAILS_MODULE_ID };
