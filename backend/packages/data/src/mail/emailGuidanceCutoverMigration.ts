// Issue gh-1941: rewrites the guidance of the Email project of a tenant seeded before this issue, which names tools that
// do not exist (`email.draft.create`, `email.send`), to the seeded text that names the real ones. A guidance that the
// owner edited stays as it is.
import type { Pool } from "pg";
import { composeProjectAgentGuidanceMarkdown } from "@semprec/shared";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { legacyAgentsTextToSections } from "../projectAgentGuidance/legacyAgentsConversion.js";
import { projectAgentGuidanceStore } from "../projectAgentGuidanceStore.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "../seed/systemProjectAgentGuidance.js";

const PURPOSE =
  "Purpose: keep synced mailboxes/folders/messages consistent and link messages to People deterministically.\n";
const ALLOWED =
  "Allowed: read Mailboxes/Folders/Emails via the generic list/get endpoints; call email.draft.create freely — drafting never requires confirmation.\n";
const NOT_ALLOWED_BEFORE_THE_SEND_APPROVAL =
  "Not allowed: write any Mailboxes/Folders/Emails property directly outside email.draft.create — every field except the user-owned Emails.read/Emails.flagged triage flags is owner: 'system', written only by the sync worker or the draft/send path (mail/ingest.ts, mail/draft.ts, mail/send.ts). Calling email.send without this project's capabilities.email.send.autonomous grant ends in a 403; the draft is left unchanged, not queued for approval.\n";
const NOT_ALLOWED_AFTER_THE_SEND_APPROVAL =
  "Not allowed: write any Mailboxes/Folders/Emails property directly outside email.draft.create — every field except the user-owned Emails.read/Emails.flagged triage flags is owner: 'system', written only by the sync worker or the draft/send path (mail/ingest.ts, mail/draft.ts, mail/send.ts). Calling email.send never sends: every agent send, whatever capabilities.email.send.autonomous says, is queued as an approval request and the mail leaves only after the user approves it; a rejected request leaves the draft unchanged.\n";

/**
 * The two texts the Email project's guidance was seeded with before issue gh-1941, which this cutover replaces: the
 * original one, which promised a 403 for a send without the autonomous grant, and the one issue gh-1913 made true of the
 * approval requirement, which still named `email.draft.create` and `email.send`.
 */
const PREVIOUS_EMAIL_GUIDANCE_SEED_TEXTS: readonly string[] = [
  PURPOSE +
    ALLOWED +
    NOT_ALLOWED_BEFORE_THE_SEND_APPROVAL +
    "General instructions: this project's only agent-facing write surface is drafting and (when explicitly granted) sending mail; it otherwise exists to host the sync worker's heartbeats.",
  PURPOSE +
    ALLOWED +
    NOT_ALLOWED_AFTER_THE_SEND_APPROVAL +
    "General instructions: this project's only agent-facing write surface is drafting and requesting the user's approval to send mail; it otherwise exists to host the sync worker's heartbeats.",
];

/** The guidance document a seeded legacy text becomes in `project_agent_guidance` (`seedProjectAgentGuidanceFromLegacyText`). */
function storedConversionOf(text: string): string {
  return composeProjectAgentGuidanceMarkdown(legacyAgentsTextToSections(text));
}

/**
 * Replaces the guidance of the tenant's Email project (the owner project of the Mailboxes database, found by the
 * database's stable module id, never by the project's name) with the conversion of the current seeded text, when it equals
 * the stored conversion of one of `PREVIOUS_EMAIL_GUIDANCE_SEED_TEXTS`. A guidance that differs in any way, a project
 * without a guidance row and a tenant without the Mailboxes database are left alone, so a repeated run changes nothing.
 * The row is read and written under its revision lock in one transaction, as the guidance routes do, and the owner of the
 * row stays. Runs in the caller's tenant scope, after the guidance cutover of issue #1449 that creates the rows.
 */
export async function runEmailGuidanceCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
    if (!mailboxes?.ownerProjectItemId) return;
    const current = await projectAgentGuidanceStore.loadForUpdate(client, mailboxes.ownerProjectItemId);
    if (current === null) return;
    if (!PREVIOUS_EMAIL_GUIDANCE_SEED_TEXTS.some((text) => storedConversionOf(text) === current.markdown)) return;
    await projectAgentGuidanceStore.upsert(client, {
      projectItemId: current.projectItemId,
      ownerUserId: current.ownerUserId,
      markdown: storedConversionOf(SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[MAILBOXES_MODULE_ID]),
    });
  });
}
