import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { MAILBOXES_MODULE_ID } from "./emailModuleKeys.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./libraryModuleKeys.js";
import { MCP_SERVERS_MODULE_ID } from "./mcpModuleKeys.js";

/**
 * The agent guidance of each system project in its legacy `Purpose:` / `Allowed:` / `Not allowed:` /
 * `General instructions:` form (issue #1449). The key is the owner module id of the system database the
 * project owns, a stable identifier that survives renaming the project.
 *
 * The seeds write each text as the Projects `agents` property value, and account creation seeds the same
 * text into `project_agent_guidance` through `seedSystemProjectAgentGuidance`.
 */
export const SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS = {
  [SYSTEM_SETTINGS_MODULE_ID]:
    "Purpose: supervise Semprec, the personal life-organization system, and delegate to project agents.\n" +
    "Allowed: read the schema-derived permission manifest for any project and delegate tasks to its agent.\n" +
    "Not allowed: write any property whose owner is 'system', or change a locked/schema_locked database.\n" +
    "General instructions: keep delegated tasks and their results terse; the manifest is the source of truth for what is allowed.",
  [MCP_SERVERS_MODULE_ID]:
    "Purpose: host MCP (Model Context Protocol) server connections as a system resource.\n" +
    "Allowed: propose a new MCP server's name and connectionConfig via the standard database proposal/confirm path; a human supplies the credential (if any) and confirms.\n" +
    "Not allowed: writing connectionConfig fields that carry a credential (rejected outright, never stored on the item), writing syncStatus/lastSynced/syncError (owner: 'system', written only by the human-triggered Synchronize tools action), or triggering a sync itself — that action has no agent-reachable path at all.\n" +
    "General instructions: this project exists only to host MCP server items; tool discovery/grants/invocation are later issues.",
  [MAILBOXES_MODULE_ID]:
    "Purpose: keep synced mailboxes/folders/messages consistent and link messages to People deterministically.\n" +
    "Allowed: read Mailboxes/Folders/Emails via the generic list/get endpoints; call email.draft.create freely — drafting never requires confirmation.\n" +
    "Not allowed: write any Mailboxes/Folders/Emails property directly outside email.draft.create — every field except the user-owned Emails.read/Emails.flagged triage flags is owner: 'system', written only by the sync worker or the draft/send path (mail/ingest.ts, mail/draft.ts, mail/send.ts). Calling email.send without this project's capabilities.email.send.autonomous grant ends in a 403; the draft is left unchanged, not queued for approval.\n" +
    "General instructions: this project's only agent-facing write surface is drafting and (when explicitly granted) sending mail; it otherwise exists to host the sync worker's heartbeats.",
  [BOOKS_MODULE_ID]:
    "Purpose: catalog books the user is reading or has read.\n" +
    "Allowed: create a Books item (name/author/rating/status) via the generic create-item endpoint.\n" +
    "Not allowed: write 'cover' — owner: 'system', reserved for the metadata heartbeat regardless of who requests the write.\n" +
    "General instructions: use the same create-item path as the UI; there is no separate AI path.",
  [MOVIES_MODULE_ID]:
    "Purpose: catalog movies and TV series watched or planned to watch.\n" +
    "Allowed: create a Movies/TV item (name/year/type/rating/status) via the generic create-item endpoint, and link 'Watched with' to a Person with a 1-5 rating on the relation.\n" +
    "Not allowed: write 'cover'/'secondaryRating'/'sourceUrl' — owner: 'system', reserved for the metadata heartbeat regardless of who requests the write.\n" +
    "General instructions: use the same create-item path as the UI; there is no separate AI path.",
} as const;
