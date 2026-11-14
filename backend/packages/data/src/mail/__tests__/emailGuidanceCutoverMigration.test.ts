import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { composeProjectAgentGuidanceMarkdown, runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../../auth/usersStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { legacyAgentsTextToSections } from "../../projectAgentGuidance/legacyAgentsConversion.js";
import { seedSystemProjectAgentGuidance } from "../../projectAgentGuidance/seedSystemProjectAgentGuidance.js";
import { projectAgentGuidanceStore } from "../../projectAgentGuidanceStore.js";
import { MAILBOXES_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "../../seed/systemProjectAgentGuidance.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { runEmailGuidanceCutoverMigration } from "../emailGuidanceCutoverMigration.js";

// The two texts the Email project was seeded with before issue gh-1941, written out here so that the test does not
// depend on the constants of the migration it checks.
const SEEDED_BEFORE_THE_SEND_APPROVAL = [
  "Purpose: keep synced mailboxes/folders/messages consistent and link messages to People deterministically.",
  "Allowed: read Mailboxes/Folders/Emails via the generic list/get endpoints; call email.draft.create freely — drafting never requires confirmation.",
  "Not allowed: write any Mailboxes/Folders/Emails property directly outside email.draft.create — every field except the user-owned Emails.read/Emails.flagged triage flags is owner: 'system', written only by the sync worker or the draft/send path (mail/ingest.ts, mail/draft.ts, mail/send.ts). Calling email.send without this project's capabilities.email.send.autonomous grant ends in a 403; the draft is left unchanged, not queued for approval.",
  "General instructions: this project's only agent-facing write surface is drafting and (when explicitly granted) sending mail; it otherwise exists to host the sync worker's heartbeats.",
].join("\n");
const SEEDED_WITH_THE_SEND_APPROVAL = [
  "Purpose: keep synced mailboxes/folders/messages consistent and link messages to People deterministically.",
  "Allowed: read Mailboxes/Folders/Emails via the generic list/get endpoints; call email.draft.create freely — drafting never requires confirmation.",
  "Not allowed: write any Mailboxes/Folders/Emails property directly outside email.draft.create — every field except the user-owned Emails.read/Emails.flagged triage flags is owner: 'system', written only by the sync worker or the draft/send path (mail/ingest.ts, mail/draft.ts, mail/send.ts). Calling email.send never sends: every agent send, whatever capabilities.email.send.autonomous says, is queued as an approval request and the mail leaves only after the user approves it; a rejected request leaves the draft unchanged.",
  "General instructions: this project's only agent-facing write surface is drafting and requesting the user's approval to send mail; it otherwise exists to host the sync worker's heartbeats.",
].join("\n");

const markdownOf = (text: string) => composeProjectAgentGuidanceMarkdown(legacyAgentsTextToSections(text));
const CURRENT_MARKDOWN = markdownOf(SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[MAILBOXES_MODULE_ID]);

interface Tenant {
  tenantId: string;
  userId: string;
  emailProjectId: string;
}

interface GuidanceRow {
  owner_user_id: string;
  markdown: string;
  updated_at: Date;
}

let admin: Pool;
let runtime: Pool;
let tenant: Tenant;
let other: Tenant;

/** A tenant whose system projects have their guidance rows, as account creation seeds them. */
async function seededTenant(): Promise<Tenant> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
  return runInTenant(tenantId, async () => {
    await seedSystem(runtime);
    return withTransaction(runtime, async (client) => {
      await seedSystemProjectAgentGuidance(client, user.id);
      const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
      if (!mailboxes?.ownerProjectItemId) throw new Error("The Mailboxes database has no owner project");
      return { tenantId, userId: user.id, emailProjectId: mailboxes.ownerProjectItemId };
    });
  });
}

/** Writes the Email project's guidance row through the guidance store, as a person's edit or an earlier seed would. */
function writeGuidance(t: Tenant, markdown: string): Promise<unknown> {
  return runInTenant(t.tenantId, () =>
    withTransaction(runtime, (client) =>
      projectAgentGuidanceStore.upsert(client, {
        projectItemId: t.emailProjectId,
        ownerUserId: t.userId,
        markdown,
      }),
    ),
  );
}

async function guidanceOf(t: Tenant): Promise<GuidanceRow | undefined> {
  const { rows } = await admin.query<GuidanceRow>(
    "SELECT owner_user_id, markdown, updated_at FROM project_agent_guidance WHERE tenant_id = $1 AND project_item_id = $2",
    [t.tenantId, t.emailProjectId],
  );
  return rows[0];
}

const migrate = (t: Tenant) => runInTenant(t.tenantId, () => runEmailGuidanceCutoverMigration(runtime));

describe("the Email guidance cutover (issue gh-1941)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    other = await seededTenant();
  });

  it("seeds the Email guidance with the real tool names", () => {
    expect(CURRENT_MARKDOWN).toContain("mail.draft.create");
    expect(CURRENT_MARKDOWN).toContain("mail.draft.update");
    expect(CURRENT_MARKDOWN).toContain("mail.draft.send");
    expect(CURRENT_MARKDOWN).toContain("sending without project permission becomes an approval request");
    expect(CURRENT_MARKDOWN).not.toContain("email.draft.create");
    expect(CURRENT_MARKDOWN).not.toContain("Calling email.send");
    expect(CURRENT_MARKDOWN).not.toContain("403");
  });

  it.each([
    ["the text seeded before the send approval", SEEDED_BEFORE_THE_SEND_APPROVAL],
    ["the text seeded with the send approval", SEEDED_WITH_THE_SEND_APPROVAL],
  ])("rewrites the stored conversion of %s to the current text and keeps the owner", async (_name, text) => {
    await writeGuidance(tenant, markdownOf(text));
    const before = await guidanceOf(tenant);
    expect(before?.markdown).not.toBe(CURRENT_MARKDOWN);

    await migrate(tenant);

    const after = await guidanceOf(tenant);
    expect(after).toMatchObject({ owner_user_id: tenant.userId, markdown: CURRENT_MARKDOWN });
    expect(after?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? Infinity);
  });

  it("leaves a guidance that the owner edited, in any way, as it is", async () => {
    for (const edited of [
      `${markdownOf(SEEDED_WITH_THE_SEND_APPROVAL)}\n## Extra\nAlways answer in Czech.\n`,
      markdownOf(SEEDED_BEFORE_THE_SEND_APPROVAL).replace("keep synced", "keep my synced"),
      "## General instructions\nSomething of my own.\n",
    ]) {
      await writeGuidance(tenant, edited);
      const before = await guidanceOf(tenant);

      await migrate(tenant);

      expect(await guidanceOf(tenant)).toEqual(before);
    }
  });

  it("changes nothing on a second run, and nothing for a guidance that already is the current text", async () => {
    await writeGuidance(tenant, markdownOf(SEEDED_WITH_THE_SEND_APPROVAL));
    await migrate(tenant);
    const migrated = await guidanceOf(tenant);

    await migrate(tenant);

    expect(await guidanceOf(tenant)).toEqual(migrated);
    expect(migrated?.markdown).toBe(CURRENT_MARKDOWN);
  });

  it("writes no row for an Email project that has none", async () => {
    await runInTenant(tenant.tenantId, () =>
      withTransaction(runtime, (client) => projectAgentGuidanceStore.delete(client, tenant.emailProjectId)),
    );

    await migrate(tenant);

    expect(await guidanceOf(tenant)).toBeUndefined();
  });

  it("changes only the tenant it runs in", async () => {
    await writeGuidance(tenant, markdownOf(SEEDED_WITH_THE_SEND_APPROVAL));
    await writeGuidance(other, markdownOf(SEEDED_WITH_THE_SEND_APPROVAL));
    const otherBefore = await guidanceOf(other);

    await migrate(tenant);

    expect((await guidanceOf(tenant))?.markdown).toBe(CURRENT_MARKDOWN);
    expect(await guidanceOf(other)).toEqual(otherBefore);
  });

  it("runs with the tenant cutovers, once for every tenant", async () => {
    await writeGuidance(tenant, markdownOf(SEEDED_BEFORE_THE_SEND_APPROVAL));
    await writeGuidance(other, markdownOf(SEEDED_WITH_THE_SEND_APPROVAL));

    await runAsSystem("Email guidance cutover test", () => runTenantCutoverMigrations(runtime));

    expect((await guidanceOf(tenant))?.markdown).toBe(CURRENT_MARKDOWN);
    expect((await guidanceOf(other))?.markdown).toBe(CURRENT_MARKDOWN);
  });
});
