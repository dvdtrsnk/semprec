import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";

/**
 * Emails-side relation properties are seeded `owner: 'system', ownerProcess: EMAILS_MODULE_ID`,
 * so every write through them must present this context or be rejected `owner_violation`.
 */
export const EMAILS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: EMAILS_MODULE_ID };
