import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";
import {
  claimMailMoveStep,
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

async function fixture(tenantId: string): Promise<{ mailboxItemId: string; messageItemId: string }> {
  return runInTenant(tenantId, async () => {
    const mailboxItemId = await createTestModuleItem(pool, "mailboxes");
    const messageItemId = await createTestModuleItem(pool, "emails");
    await withTransaction(pool, (client) =>
      upsertMailMessageMeta(client, {
        itemId: messageItemId,
        mailboxItemId,
        messageId: `<${randomUUID()}@example.test>`,
        envelope: {},
      }),
    );
    return { mailboxItemId, messageItemId };
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
});
