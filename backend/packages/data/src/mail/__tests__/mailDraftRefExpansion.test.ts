// Issue gh-1948: what `readSempRefContext` hands the agent for an `item` ref of an Emails item that has a `mail_drafts`
// row. Reads go through the runtime role pool in two tenants, as the agents process makes them.
import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { readSempRefContext } from "../../semp/sempRefReadContext.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { createEmailDraftInMailbox, discardEmailDraft, type EmailDraftView } from "../draft.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import {
  MAX_DRAFT_REF_BODY_CHARS,
  MAX_DRAFT_REF_DETAILS_CHARS,
  MAX_DRAFT_REF_RECIPIENT_CHARS,
} from "../mailDraftRefExpansion.js";
import { markMailDraftSent } from "../mailDraftsStore.js";
import { resolveMailModuleIds } from "../mailModuleIds.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";

const OWN_ADDRESS = "me@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };

interface MailTenant {
  tenantId: string;
  userId: string;
  emailsDatabaseId: string;
  mailboxId: string;
  inboxId: string;
}

let admin: Pool;
let runtime: Pool;
let storageRoot: string;
let tenant: MailTenant;
let other: MailTenant;

function inTenant<T>(t: MailTenant, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(t.tenantId, () => withTransaction(runtime, fn));
}

async function seededTenant(): Promise<MailTenant> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
  return inTenant({ tenantId } as MailTenant, async (client) => {
    const ids = await resolveMailModuleIds(client);
    const property = async (databaseId: string, key: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
        [databaseId, key],
      );
      if (!rows[0]) throw new Error(`Missing ${key} property`);
      return rows[0].id;
    };
    const mailbox = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "Personal", provider: "gmail" },
    });
    await writeMailboxAddresses(client, {
      mailboxesDatabaseId: ids.mailboxesDatabaseId,
      mailboxItemId: mailbox.id,
      address: OWN_ADDRESS,
      aliases: [],
    });
    const mailboxRelationPropertyId = await property(ids.foldersDatabaseId, "mailbox");
    const folder = (specialPurpose: string) =>
      ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId,
        providerId: specialPurpose.toUpperCase(),
        name: specialPurpose,
        behavior: "folder",
        specialPurpose,
      });
    // The draft operation files a draft in the Drafts folder, which a synced mailbox has.
    await folder("drafts");
    const inboxId = await folder("inbox");
    return {
      tenantId,
      userId: user.id,
      emailsDatabaseId: ids.emailsDatabaseId,
      mailboxId: mailbox.id,
      inboxId,
    };
  });
}

/** A draft written by a person, as the compose window does, through the draft operation. */
function userDraft(
  t: MailTenant,
  fields: { subject?: string; body?: string; threadId?: string | null; to?: { name: string; address: string }[] } = {},
): Promise<EmailDraftView> {
  return inTenant(t, (client) =>
    createEmailDraftInMailbox(
      client,
      {
        mailboxItemId: t.mailboxId,
        from: OWN_ADDRESS,
        to: fields.to ?? [PETR],
        cc: [],
        bcc: [],
        subject: fields.subject ?? "Offer",
        body: fields.body ?? "Dear Petr, the offer stands.",
        threadId: fields.threadId ?? null,
        mode: "new",
        sourceEmailItemId: null,
      },
      { writer: { writerKind: "user" }, actingUserId: t.userId },
    ),
  );
}

/** A received message, ingested as the sync worker does. */
function receivedMessage(t: MailTenant): Promise<string> {
  return inTenant(t, async (client) => {
    const ids = await resolveMailModuleIds(client);
    const property = async (key: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
        [ids.emailsDatabaseId, key],
      );
      if (!rows[0]) throw new Error(`Missing ${key} property`);
      return rows[0].id;
    };
    const { itemId } = await ingestEmailMessage(client, {
      emailsDatabaseId: ids.emailsDatabaseId,
      filesDatabaseId: ids.filesDatabaseId,
      folderRelationPropertyId: await property("folder"),
      attachmentsRelationPropertyId: await property("attachments"),
      mailboxItemId: t.mailboxId,
      folderItemId: t.inboxId,
      messageId: `<${randomUUID()}@example.test>`,
      subject: "Received",
      date: new Date("2026-10-01T09:00:00Z"),
      envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
      bodyText: "Hello",
      attachments: [],
      storage: new LocalFsBlobStorageWriter(storageRoot),
      storageKeyPrefix: "mail-draft-ref-fixtures",
    });
    return itemId;
  });
}

/** What `expandSempRefs` reads for the item ref, as the tenant's runtime role. */
function read(t: MailTenant, itemId: string, databaseId = t.emailsDatabaseId) {
  return inTenant(t, (client) => readSempRefContext(client, { kind: "item", itemId, databaseId }));
}

async function tenantState(t: MailTenant) {
  const { rows } = await runInTenant(t.tenantId, () =>
    runtime.query<{ items: number; drafts: number }>(
      `SELECT (SELECT count(*)::int FROM items WHERE tenant_id = app_tenant_default()) AS items,
              (SELECT count(*)::int FROM mail_drafts WHERE tenant_id = app_tenant_default()) AS drafts`,
    ),
  );
  return rows[0];
}

describe("the context of an item ref to a mail draft (issue gh-1948)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-draft-ref-"));
    tenant = await seededTenant();
    other = await seededTenant();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("hands the agent the draft's id, subject, recipients and body with the instruction to use mail.draft.update", async () => {
    const draft = await userDraft(tenant);
    const before = await tenantState(tenant);

    const context = await read(tenant, draft.id);

    expect(context).toEqual({
      label: "Offer",
      state: "active",
      details: {
        instruction: `This is an open draft. Change it with the mail.draft.update tool and draftId ${draft.id}; an update replaces the whole body, and the draft is not sent. If this reference ends with the line [truncated], it was cut and the body may be cut too, so do not rewrite it from the cut text.`,
        draft: {
          id: draft.id,
          subject: "Offer",
          mode: "new",
          threadId: null,
          lastEditedBy: "user",
          sentAt: null,
          body: "Dear Petr, the offer stands.",
          bodyTruncated: false,
          from: OWN_ADDRESS,
          to: [PETR],
          cc: [],
          bcc: [],
          recipientsOmitted: 0,
        },
      },
      blob: null,
    });
    expect(await tenantState(tenant)).toEqual(before);
  });

  it("tells the agent that a sent draft can no longer be changed, and still names its id and text", async () => {
    const draft = await userDraft(tenant, { subject: "Sent offer" });
    await inTenant(tenant, (client) => markMailDraftSent(client, draft.id));

    const context = await read(tenant, draft.id);

    expect(context?.state).toBe("active");
    expect(context?.details).toMatchObject({
      instruction: "This draft has been sent and can no longer be changed; mail.draft.update refuses it.",
      draft: { id: draft.id, subject: "Sent offer", body: "Dear Petr, the offer stands.", bodyTruncated: false },
    });
    expect(context?.details).toHaveProperty("draft.sentAt", expect.any(String));
  });

  it("cuts a long body at a code point and says in the instruction that the body is cut", async () => {
    const body = `${"a".repeat(MAX_DRAFT_REF_BODY_CHARS - 1)}😀tail`;
    const draft = await userDraft(tenant, { body });

    const context = await read(tenant, draft.id);

    expect(context?.details).toMatchObject({
      instruction: expect.stringContaining("the body below is cut"),
      draft: { body: `${"a".repeat(MAX_DRAFT_REF_BODY_CHARS - 1)}😀`, bodyTruncated: true },
    });
  });

  it("keeps a body of exactly the limit whole", async () => {
    const body = "b".repeat(MAX_DRAFT_REF_BODY_CHARS);
    const draft = await userDraft(tenant, { body });

    const context = await read(tenant, draft.id);

    expect(context?.details).toMatchObject({ draft: { body, bodyTruncated: false } });
  });

  it("keeps the serialized details within the budget for 100 recipients and a body near the cap, and flags a cut body", async () => {
    const recipients = Array.from({ length: 100 }, (_, index) => ({
      name: `Recipient number ${index}`,
      address: `recipient-${index}@example.test`,
    }));
    const draft = await userDraft(tenant, { to: recipients, body: "x".repeat(MAX_DRAFT_REF_BODY_CHARS - 100) });

    const context = await read(tenant, draft.id);

    const details = context?.details as { instruction: string; draft: Record<string, unknown> } | undefined;
    if (!details) throw new Error("The draft has no context");
    const serialized = JSON.stringify(details);
    expect(serialized.length).toBeLessThanOrEqual(MAX_DRAFT_REF_DETAILS_CHARS);
    const listed = (details.draft.to as unknown[]).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(100);
    expect(JSON.stringify(details.draft.to).length).toBeLessThanOrEqual(MAX_DRAFT_REF_RECIPIENT_CHARS);
    expect(details.draft.recipientsOmitted).toBe(100 - listed);
    // The body is cut because the recipients took their share, it is flagged, and the instruction says so.
    const body = details.draft.body as string;
    expect(body.length).toBeLessThan(MAX_DRAFT_REF_BODY_CHARS - 100);
    expect("x".repeat(body.length)).toBe(body);
    expect(details.draft.bodyTruncated).toBe(true);
    expect(details.instruction).toContain("the body below is cut");
    // The keys that decide whether the body may be rewritten come before the recipient lists.
    expect(serialized.indexOf('"bodyTruncated"')).toBeLessThan(serialized.indexOf('"to"'));
    expect(serialized.indexOf('"body"')).toBeLessThan(serialized.indexOf('"to"'));
  });

  it("budgets the escapes of the serialized body: newlines and quotes cost two units, so less of the body fits", async () => {
    const body = '"\n'.repeat(2_400);
    const draft = await userDraft(tenant, { body });

    const context = await read(tenant, draft.id);

    const details = context?.details as { instruction: string; draft: { body: string; bodyTruncated: boolean } };
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(MAX_DRAFT_REF_DETAILS_CHARS);
    expect(Array.from(details.draft.body).length).toBeLessThan(Array.from(body).length);
    expect(body.startsWith(details.draft.body)).toBe(true);
    expect(details.draft.bodyTruncated).toBe(true);
    expect(details.instruction).toContain("the body below is cut");
  });

  it("budgets the UTF-16 units of the body, so a body of emoji within 5000 code points is cut and flagged", async () => {
    const body = "😀".repeat(MAX_DRAFT_REF_BODY_CHARS);
    const draft = await userDraft(tenant, { body });

    const context = await read(tenant, draft.id);

    const details = context?.details as { draft: { body: string; bodyTruncated: boolean } };
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(MAX_DRAFT_REF_DETAILS_CHARS);
    expect(details.draft.bodyTruncated).toBe(true);
    expect(details.draft.body.length).toBeLessThan(body.length);
    // Only whole code points: no half of a surrogate pair is left.
    expect(details.draft.body).toBe("😀".repeat(Array.from(details.draft.body).length));
  });

  it("expands a discarded draft as a trashed Emails item without the draft instruction", async () => {
    const draft = await userDraft(tenant, { subject: "Discarded offer" });
    await inTenant(tenant, (client) =>
      discardEmailDraft(client, draft.id, { writer: { writerKind: "user" }, actingUserId: tenant.userId }),
    );

    const context = await read(tenant, draft.id);

    expect(context).toMatchObject({ label: "Discarded offer", state: "trashed" });
    expect(context?.details).not.toHaveProperty("draft");
    expect(context?.details).not.toHaveProperty("instruction");
    expect(JSON.stringify(context?.details)).not.toContain("mail.draft.update");
  });

  it("expands a received message, which has no draft row, as an ordinary Emails item", async () => {
    const received = await receivedMessage(tenant);

    const context = await read(tenant, received);

    expect(context).toMatchObject({
      label: "Received",
      state: "active",
      details: { properties: { name: "Received" } },
    });
    expect(context?.details).not.toHaveProperty("draft");
    expect(context?.details).not.toHaveProperty("instruction");
  });

  it("answers another tenant's draft, and an unknown id, with nothing", async () => {
    const foreignDraft = await userDraft(other, { subject: "Private offer" });

    expect(await read(tenant, foreignDraft.id)).toBeNull();
    expect(await read(tenant, foreignDraft.id, other.emailsDatabaseId)).toBeNull();
    expect(await read(tenant, randomUUID())).toBeNull();
    expect(await read(other, foreignDraft.id)).toMatchObject({ label: "Private offer" });
  });
});
