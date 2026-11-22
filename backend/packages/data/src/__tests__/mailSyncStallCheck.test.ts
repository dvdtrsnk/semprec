import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { withTransaction } from "../db/pool.js";
import { mailSyncProcessName, upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { IMAP_FULL_MESSAGES_PER_PASS } from "../mail/imapReconcile.js";
import { claimMailSyncPass } from "../mail/mailAccountSyncStateStore.js";
import { handleObservabilityCheckSystemTask } from "../observability/observabilityCheckSystem.js";
import { mailProblemKey } from "../semp/sourceProblemKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapAccount, type FakeImapCall } from "../testSupport/fakeImapAccount.js";
import {
  createImapMailboxFixture,
  plainMessage,
  PURELYMAIL_FOLDERS,
  type ImapMailboxFixture,
} from "../testSupport/imapMailboxFixture.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
const openHolds: Array<() => void> = [];

const checkRowSchema = z.object({ check_key: z.string(), status: z.enum(["ok", "alerting"]) });
const syncStateSchema = z.object({
  due: z.boolean(),
  backfilled: z.boolean(),
  leased: z.boolean(),
  queued: z.boolean(),
});
const problemRowSchema = z.object({ occurrence_count: z.number(), resolved_at: z.date().nullable() });

/** More recent messages than one pass ingests in full, so the first passes leave backfill behind. */
const BACKFILL_MESSAGES = 2 * IMAP_FULL_MESSAGES_PER_PASS + 5;

async function markFixedProcessesFresh(): Promise<void> {
  for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
    await upsertProcessHeartbeat(admin, { process, pid: 1, version: "1.0.0" }, new Date());
  }
}

/** The live-sync host stopped beating for the mailbox five minutes ago (stale after one minute). */
async function staleHeartbeat(mailboxId: string): Promise<void> {
  await upsertProcessHeartbeat(
    admin,
    { process: mailSyncProcessName(mailboxId), pid: 1, version: "1.0.0" },
    new Date(),
  );
  await admin.query("UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = $1", [
    mailSyncProcessName(mailboxId),
  ]);
}

function runCheck(): Promise<void> {
  return runAsSystem("test", () => handleObservabilityCheckSystemTask(runtime, { job: { id: randomUUID() } }));
}

async function checks(mailboxId: string): Promise<Array<z.infer<typeof checkRowSchema>>> {
  const { rows } = await admin.query<Record<string, unknown>>(
    `SELECT check_key, status FROM tenant_observability_checks
     WHERE tenant_id = $1 AND check_key IN ($2, $3) ORDER BY check_key`,
    [tenant, `mail:${mailboxId}`, `process:mailsync:${mailboxId}`],
  );
  return rows.map((row) => checkRowSchema.parse(row));
}

async function stallNotifications(mailboxId: string): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    `SELECT count(*) AS count FROM notifications
     WHERE tenant_id = $1 AND kind = 'mail_sync_stalled' AND payload->>'mailboxItemId' = $2`,
    [tenant, mailboxId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function problems(mailboxId: string): Promise<Array<z.infer<typeof problemRowSchema>>> {
  const { rows } = await admin.query<Record<string, unknown>>(
    "SELECT occurrence_count, resolved_at FROM semp_problems WHERE tenant_id = $1 AND dedupe_key = $2",
    [tenant, mailProblemKey(mailboxId)],
  );
  return rows.map((row) => problemRowSchema.parse(row));
}

async function syncState(mailboxId: string): Promise<z.infer<typeof syncStateSchema>> {
  const { rows } = await admin.query<Record<string, unknown>>(
    `SELECT next_expected_activity_at <= now() AS due,
            initial_sync_completed_at IS NOT NULL AS backfilled,
            pass_lease_token IS NOT NULL AS leased,
            EXISTS (SELECT 1 FROM graphile_worker.jobs WHERE task_identifier = 'mailAccountSync') AS queued
       FROM mail_account_sync_state WHERE tenant_id = $1 AND item_id = $2`,
    [tenant, mailboxId],
  );
  return syncStateSchema.parse(rows[0]);
}

/** Nothing of a stall reached the user: no notification, no Semp problem, both checks `ok`. */
async function expectNoStall(mailboxId: string): Promise<void> {
  expect(await checks(mailboxId)).toEqual([
    { check_key: `mail:${mailboxId}`, status: "ok" },
    { check_key: `process:mailsync:${mailboxId}`, status: "ok" },
  ]);
  expect(await stallNotifications(mailboxId)).toBe(0);
  expect(await problems(mailboxId)).toEqual([]);
}

/** A mailbox with `BACKFILL_MESSAGES` new messages in INBOX. */
async function backfillingMailbox(): Promise<{ account: FakeImapAccount; mailbox: ImapMailboxFixture }> {
  const account = new FakeImapAccount([...PURELYMAIL_FOLDERS], { condstore: true });
  for (let index = 0; index < BACKFILL_MESSAGES; index++) account.deliver("INBOX", plainMessage(`Backfill ${index}`));
  const mailbox = await runInTenant(tenant, () => createImapMailboxFixture(runtime));
  return { account, mailbox };
}

/** Holds the next pass at its folder listing until the returned release is called. */
function holdNextListing(account: FakeImapAccount): { reached: Promise<void>; release: () => void } {
  let reach: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  openHolds.push(release);
  account.gate = async (call: FakeImapCall) => {
    if (call.method !== "listFolders") return;
    account.gate = undefined;
    reach();
    await released;
  };
  return { reached, release };
}

/** A mailbox whose passes stopped: due an hour ago, no successful pass since, its heartbeat stale. */
async function stalledMailbox(): Promise<string> {
  const mailbox = await runInTenant(tenant, () => createImapMailboxFixture(runtime));
  // Fixture: an hour without passes cannot be produced through the sync job without waiting that hour.
  await admin.query(
    `UPDATE mail_account_sync_state
        SET next_expected_activity_at = now() - interval '1 hour', last_successful_sync_at = now() - interval '2 hours'
      WHERE item_id = $1`,
    [mailbox.mailboxId],
  );
  await staleHeartbeat(mailbox.mailboxId);
  return mailbox.mailboxId;
}

describe("mail sync stall check against running and recent passes", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await admin.query("DELETE FROM tenant_observability_checks");
    await admin.query("DELETE FROM observability_checks");
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await createUser(admin, {
      email: `${randomUUID()}@example.test`,
      passwordHash: await hashPassword("s3cret-password"),
      locale: "en",
      tenantId: tenant,
      role: "admin",
    });
    await markFixedProcessesFresh();
  });

  afterEach(() => {
    for (const release of openHolds.splice(0)) release();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("reports nothing right after a pass that left backfill and queued its follow-up, heartbeat stale", async () => {
    const { account, mailbox } = await backfillingMailbox();
    await staleHeartbeat(mailbox.mailboxId);

    await runInTenant(tenant, () => mailbox.sync(async () => account.client()));
    // The pass marked the account due at once and its release queued the follow-up, which no worker has run yet.
    expect(await syncState(mailbox.mailboxId)).toEqual({ due: true, backfilled: false, leased: false, queued: true });

    await runCheck();

    await expectNoStall(mailbox.mailboxId);
  });

  it("reports nothing while a pass holds the lease past an overdue time, nor once that pass finished", async () => {
    const { account, mailbox } = await backfillingMailbox();
    await runInTenant(tenant, () => mailbox.sync(async () => account.client()));
    // Fixture: the account was due long ago and last succeeded long ago, as if passes had stopped until this one.
    await admin.query(
      `UPDATE mail_account_sync_state
          SET next_expected_activity_at = now() - interval '1 hour', last_successful_sync_at = now() - interval '2 hours'
        WHERE item_id = $1`,
      [mailbox.mailboxId],
    );
    await staleHeartbeat(mailbox.mailboxId);

    const hold = holdNextListing(account);
    const running = runInTenant(tenant, () => mailbox.sync(async () => account.client()));
    await hold.reached;
    expect(await syncState(mailbox.mailboxId)).toMatchObject({ leased: true });

    await runCheck();
    await expectNoStall(mailbox.mailboxId);

    hold.release();
    await running;
    expect(await syncState(mailbox.mailboxId)).toMatchObject({ due: true, backfilled: false, leased: false });

    await runCheck();
    await expectNoStall(mailbox.mailboxId);
  });

  it("reports a mailbox whose passes stopped once, over repeated ticks, although a dead holder's lease remains", async () => {
    const mailboxId = await stalledMailbox();
    // A holder that died: its lease expired a minute ago and nothing renews it.
    expect(
      await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => claimMailSyncPass(client, mailboxId, randomUUID(), -60_000)),
      ),
    ).toBe("claimed");

    await runCheck();
    await runCheck();

    expect(await checks(mailboxId)).toEqual([
      { check_key: `mail:${mailboxId}`, status: "alerting" },
      { check_key: `process:mailsync:${mailboxId}`, status: "alerting" },
    ]);
    expect(await stallNotifications(mailboxId)).toBe(1);
    expect(await problems(mailboxId)).toEqual([{ occurrence_count: 1, resolved_at: null }]);
  });

  it("notifies once when the heartbeat stalls first and the account turns overdue on a later tick", async () => {
    const mailbox = await runInTenant(tenant, () => createImapMailboxFixture(runtime));
    await staleHeartbeat(mailbox.mailboxId);

    await runCheck();
    expect(await checks(mailbox.mailboxId)).toEqual([
      { check_key: `mail:${mailbox.mailboxId}`, status: "ok" },
      { check_key: `process:mailsync:${mailbox.mailboxId}`, status: "alerting" },
    ]);
    expect(await stallNotifications(mailbox.mailboxId)).toBe(1);

    // Fixture: the account's next activity is an hour overdue.
    await admin.query(
      "UPDATE mail_account_sync_state SET next_expected_activity_at = now() - interval '1 hour' WHERE item_id = $1",
      [mailbox.mailboxId],
    );
    await runCheck();

    expect((await checks(mailbox.mailboxId)).map((row) => row.status)).toEqual(["alerting", "alerting"]);
    expect(await stallNotifications(mailbox.mailboxId)).toBe(1);
    expect(await problems(mailbox.mailboxId)).toEqual([{ occurrence_count: 1, resolved_at: null }]);
  });

  it("writes one notification and one problem when check runs overlap on a stalled mailbox", async () => {
    const mailboxId = await stalledMailbox();

    await Promise.all([runCheck(), runCheck(), runCheck(), runCheck()]);

    expect(await stallNotifications(mailboxId)).toBe(1);
    expect(await problems(mailboxId)).toEqual([{ occurrence_count: 1, resolved_at: null }]);
  });

  it("writes one process_stale notification per admin when check runs overlap on a stale process", async () => {
    await admin.query("UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = 'api'");

    await Promise.all([runCheck(), runCheck(), runCheck(), runCheck()]);

    const { rows } = await admin.query<{ user_id: string; count: string }>(
      "SELECT user_id, count(*) AS count FROM notifications WHERE kind = 'process_stale' GROUP BY user_id",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => Number(row.count))).toEqual(rows.map(() => 1));
  });
});
