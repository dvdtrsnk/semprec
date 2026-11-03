import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ensureMailFolderSyncState, recordReconcile } from "../mail/mailFolderSyncStateStore.js";
import { EMAILS_RELATION_CONTEXT } from "../mail/emailsRelationContext.js";
import {
  claimMailMoveStep,
  checkpointMailMoveStep,
  listPendingMoves,
  markMailMoveUncertain,
  markMoveAttemptFailed,
  markMoveConfirmed,
  recordDesiredMailMessageMove,
} from "../mail/mailMessageMoveSyncStore.js";
import {
  createRuntimeRolePool,
  createTestModuleItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let a: string;
let b: string;

async function fixture(
  tenantId: string,
): Promise<{ mailboxItemId: string; messageItemId: string; source: { provider: "gmail"; providerMessageId: string } }> {
  return runInTenant(tenantId, async () => {
    const mailboxItemId = await createTestModuleItem(pool, "mailboxes");
    const messageItemId = await createTestModuleItem(pool, "emails");
    const providerMessageId = `fake-${randomUUID()}`;
    await withTransaction(pool, (client) =>
      upsertMailMessageMeta(client, {
        itemId: messageItemId,
        mailboxItemId,
        messageId: `<${randomUUID()}@example.test>`,
        providerMessageId,
        envelope: {},
      }),
    );
    return { mailboxItemId, messageItemId, source: { provider: "gmail", providerMessageId } };
  });
}

describe("mail move intent store", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    a = await createTestTenant(admin);
    b = await createTestTenant(admin);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("tracks revisions, refuses foreign identities and confirms only the current revision", async () => {
    const own = await fixture(a);
    const other = await fixture(b);
    const first = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" })),
    );
    const second = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "inbox" })),
    );
    expect(first.desired_revision).toBe("1");
    expect(second.desired_revision).toBe("2");
    await expect(
      runInTenant(b, () =>
        withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "trash" })),
      ),
    ).rejects.toThrow("Mail message is not available in this mailbox");
    expect(
      await runInTenant(b, () => withTransaction(pool, (client) => listPendingMoves(client, other.mailboxItemId))),
    ).toEqual([]);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMoveConfirmed(client, own.messageItemId, first.desired_revision)),
      ),
    ).toBe(false);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMoveConfirmed(client, own.messageItemId, second.desired_revision)),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
  });

  it("stops retrying a definite missing message at its attempt limit", async () => {
    const own = await fixture(a);
    const move = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "trash" })),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        await runInTenant(a, () =>
          withTransaction(pool, (client) =>
            markMoveAttemptFailed(client, own.messageItemId, move.desired_revision, "messageMissing"),
          ),
        ),
      ).toBe(true);
    }
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          markMoveAttemptFailed(client, own.messageItemId, move.desired_revision, "messageMissing"),
        ),
      ),
    ).toBe(false);
  });

  it("allows one claim and preserves an uncertain operation across A-B-A desires", async () => {
    const own = await fixture(a);
    const first = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" })),
    );
    const tokens = [randomUUID(), randomUUID()];
    const evidence = { provider: "gmail" as const, messageId: "fake-provider-id", inTrash: false, inInbox: true };
    const claims = await Promise.all(
      tokens.map((token) =>
        runInTenant(a, () =>
          withTransaction(pool, (client) =>
            claimMailMoveStep(client, {
              messageItemId: own.messageItemId,
              revision: first.desired_revision,
              token,
              step: "modify_labels",
              evidence,
            }),
          ),
        ),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = tokens[claims.findIndex(Boolean)]!;
    await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "trash" })),
    );
    const latest = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" })),
    );
    expect(latest.desired_revision).toBe("3");
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMailMoveUncertain(client, own.messageItemId, winner)),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMoveConfirmed(client, own.messageItemId, latest.desired_revision)),
      ),
    ).toBe(false);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: latest.desired_revision,
            token: randomUUID(),
            step: "modify_labels",
            evidence,
          }),
        ),
      ),
    ).toBe(false);
    const [pending] = await runInTenant(a, () =>
      withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId)),
    );
    expect(pending).toMatchObject({
      desired_revision: "3",
      captured_revision: "1",
      operation_token: winner,
      operation_phase: "uncertain",
    });
  });

  it("resumes only the acknowledged checkpoint with its captured evidence", async () => {
    const own = await fixture(a);
    const move = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "inbox" })),
    );
    const token = randomUUID();
    const before = { provider: "gmail" as const, messageId: "fake-provider-id", inTrash: true, inInbox: false };
    const after = { ...before, inTrash: false };
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token,
            step: "untrash",
            evidence: before,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          checkpointMailMoveStep(client, {
            messageItemId: own.messageItemId,
            token,
            nextStep: "modify_labels",
            evidence: after,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token,
            step: "modify_labels",
            evidence: before,
          }),
        ),
      ),
    ).toBe(false);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token,
            step: "modify_labels",
            evidence: after,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token,
            step: "modify_labels",
            evidence: after,
          }),
        ),
      ),
    ).toBe(false);
  });

  it("requires a verified IMAP source before the local edge changes and preserves it on later desires", async () => {
    await runInTenant(a, () => seedSystem(pool));
    const fixture = await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        const mailboxDb = await getDatabaseByModuleId(client, "mailboxes");
        const emailDb = await getDatabaseByModuleId(client, "emails");
        const folderDb = await getDatabaseByModuleId(client, "folders");
        if (!mailboxDb || !emailDb || !folderDb) throw new Error("Missing mail databases");
        const emailFolder = await getPropertyByKey(client, emailDb.id, "folder");
        const folderMailbox = await getPropertyByKey(client, folderDb.id, "mailbox");
        if (!emailFolder || !folderMailbox) throw new Error("Missing mail relation properties");
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxDb.id,
          properties: { name: "Mailbox" },
        });
        const message = await createItemWithClient(
          client,
          { databaseId: emailDb.id, properties: { name: "Message" } },
          { allowedSystemKeys: ["name"] },
        );
        await upsertMailMessageMeta(client, {
          itemId: message.id,
          mailboxItemId: mailbox.id,
          messageId: `<${randomUUID()}@example.test>`,
          envelope: {},
        });
        const folderId = await ensureFolderItem(client, {
          foldersDatabaseId: folderDb.id,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: folderMailbox.id,
          providerId: "INBOX",
          name: "Inbox",
          behavior: "folder",
          specialPurpose: "inbox",
        });
        await ensureMailFolderSyncState(client, folderId);
        await recordReconcile(client, { itemId: folderId, uidvalidity: "42", uidnext: "8", highestmodseq: null });
        await createRelationWithClient(
          client,
          {
            relationPropertyId: emailFolder.id,
            callerItemId: message.id,
            targetItemId: folderId,
            metadata: { uid: 7 },
          },
          EMAILS_RELATION_CONTEXT,
        );
        return { mailboxItemId: mailbox.id, messageItemId: message.id, folderId, propertyId: emailFolder.id };
      }),
    );
    const source = {
      provider: "imap" as const,
      folderItemId: fixture.folderId,
      path: "INBOX",
      uid: 7,
      uidValidity: "42",
    };
    await expect(
      runInTenant(a, () =>
        withTransaction(pool, (client) =>
          recordDesiredMailMessageMove(client, { ...fixture, desiredPurpose: "archive" }),
        ),
      ),
    ).rejects.toThrow();
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxItemId))),
    ).toEqual([]);
    await expect(
      runInTenant(a, () =>
        withTransaction(pool, (client) =>
          recordDesiredMailMessageMove(client, {
            ...fixture,
            desiredPurpose: "archive",
            source: { ...source, uid: 8 },
          }),
        ),
      ),
    ).rejects.toThrow("Mail move source is not verified");
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxItemId))),
    ).toEqual([]);
    await expect(
      runInTenant(a, () =>
        withTransaction(pool, async (client) => {
          await recordDesiredMailMessageMove(client, { ...fixture, desiredPurpose: "archive", source });
          throw new Error("abort source capture");
        }),
      ),
    ).rejects.toThrow("abort source capture");
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxItemId))),
    ).toEqual([]);
    const first = await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        const result = await recordDesiredMailMessageMove(client, { ...fixture, desiredPurpose: "archive", source });
        await deleteRelationWithClient(
          client,
          {
            relationPropertyId: fixture.propertyId,
            callerItemId: fixture.messageItemId,
            targetItemId: fixture.folderId,
          },
          EMAILS_RELATION_CONTEXT,
        );
        return result;
      }),
    );
    const next = await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        recordDesiredMailMessageMove(client, {
          ...fixture,
          desiredPurpose: "inbox",
          source: { ...source, uid: 999 },
        }),
      ),
    );
    expect(first.source_evidence).toEqual(source);
    expect(next.source_evidence).toEqual(source);
    expect(next.desired_revision).toBe("2");
  });
});
