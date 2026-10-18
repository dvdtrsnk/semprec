import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { sealSecret } from "@semprec/credentials";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { login } from "../auth/authActions.js";
import { recordLoginAttempt } from "../auth/loginAttemptsStore.js";
import { LOCKOUT_THRESHOLD } from "../auth/loginLockout.js";
import type { UserRole } from "../auth/types.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { getOrCreateTenantDataKey } from "../credentials/tenantKeysStore.js";
import { ChokePointError, NotFoundError, UnauthorizedError } from "../errors.js";
import { listPushSubscriptionsForUser } from "../push/pushSubscriptionsStore.js";
import { registerPushSubscription } from "../push/pushSubscriptionActions.js";
import { transitionTenantStatus, type TenantStatus } from "../tenancy/tenantsStore.js";
import { TENANT_STATUS_CHANNEL } from "../tenancy/tenantStatusSignal.js";
import { LastAdminError } from "../tenancy/accountsAdminStore.js";
import { withTransaction } from "../db/pool.js";
import {
  beginTenantDeletion,
  deleteAccountAsAdmin,
  deleteOwnAccount,
  ReauthenticationFailedError,
  SelfDeletionRequiresReauthenticationError,
} from "../tenancy/deleteAccount.js";

const PASSWORD = "s3cret-password";
const IP = "10.1.2.3";
const READ = { actorType: "sync_worker", purpose: "test" } as const;

interface Account {
  userId: string;
  email: string;
  tenantId: string;
}

let adminPool: Pool;
let pool: Pool;
let listener: PoolClient;
let notified: string[];

async function makeAccount(role: UserRole, status: TenantStatus = "active"): Promise<Account> {
  const tenantId = await createTestTenant(adminPool, { status });
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId, role });
  return { userId: user.id, email, tenantId };
}

async function signIn(account: Account): Promise<string> {
  const result = await login(adminPool, { email: account.email, password: PASSWORD, platform: "ios", ip: IP });
  return result.token;
}

async function tenantStatusOf(tenantId: string): Promise<string> {
  const { rows } = await adminPool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
  return rows[0]!.status;
}

async function activeSessionCount(userId: string): Promise<number> {
  const { rows } = await adminPool.query<{ n: string }>(
    "SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  return Number(rows[0]!.n);
}

async function keyCount(tenantId: string): Promise<number> {
  const { rows } = await adminPool.query<{ n: string }>("SELECT count(*) AS n FROM tenant_keys WHERE tenant_id = $1", [
    tenantId,
  ]);
  return Number(rows[0]!.n);
}

async function auditCount(): Promise<number> {
  const { rows } = await adminPool.query<{ n: string }>("SELECT count(*) AS n FROM admin_audit_log");
  return Number(rows[0]!.n);
}

async function failedAttempts(email: string): Promise<{ ip: string }[]> {
  const { rows } = await adminPool.query<{ ip: string }>(
    "SELECT host(ip) AS ip FROM login_attempts WHERE email = $1 AND succeeded = false",
    [email],
  );
  return rows;
}

/** Writes a `tenant` credential the way #1032's tests do: tenant key, sealSecret, raw insert (the API cannot yet seal under a tenant key). */
async function seedTenantCredential(tenantId: string): Promise<string> {
  const itemId = randomUUID();
  await runInTenant(tenantId, () =>
    withTenantTransaction(adminPool, tenantId, async (client) => {
      const { dataKey } = await getOrCreateTenantDataKey(client);
      const sealed = await sealSecret(
        "secret",
        dataKey,
        Buffer.from(`semprec:external-credential:v1:${tenantId}:${itemId}`, "utf8"),
      );
      await client.query(
        `INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, scheme)
       VALUES ($1, 'api_key', $2, $3, 'tenant')`,
        [itemId, sealed.ciphertext, sealed.nonce],
      );
    }),
  );
  return itemId;
}

async function readCredential(tenantId: string, itemId: string): Promise<string | null> {
  return runInTenant(tenantId, () =>
    withTenantTransaction(adminPool, tenantId, (c) => getDecryptedCredential(c, { itemId, ...READ })),
  );
}

function deleteOwn(account: Account, password = PASSWORD, ip = IP): Promise<void> {
  return runInTenant(account.tenantId, () =>
    deleteOwnAccount(pool, { userId: account.userId, tenantId: account.tenantId, password, ip }),
  );
}

function deleteAsAdmin(actor: Account, target: Account) {
  return runAsSystem("deleteAccount.test", () =>
    deleteAccountAsAdmin(pool, { actorUserId: actor.userId, targetUserId: target.userId }),
  );
}

/** The tenant ids of the deactivation notifications received so far. */
function notifiedTenants(): string[] {
  return notified.map((payload) => {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("tenantId" in parsed) ||
      typeof parsed.tenantId !== "string"
    ) {
      throw new Error("unexpected notification payload");
    }
    return parsed.tenantId;
  });
}

async function settle(): Promise<void> {
  // A NOTIFY is delivered to an idle listener once its own round trip completes.
  await listener.query("SELECT 1");
}

describe("account deletion (issue #1049)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    notified = [];
    listener = await adminPool.connect();
    listener.on("notification", (msg) => {
      if (msg.channel === TENANT_STATUS_CHANNEL && msg.payload) notified.push(msg.payload);
    });
    await listener.query(`LISTEN ${TENANT_STATUS_CHANNEL}`);
  });

  afterEach(() => {
    listener.release(true);
  });

  describe("deleteOwnAccount", () => {
    it("moves B to deleting, revokes sessions and push, shreds B's key and notifies; A is untouched", async () => {
      const a = await makeAccount("admin");
      const b = await makeAccount("admin");
      await signIn(a);
      await signIn(b);
      await signIn(b);
      await registerPushSubscription(adminPool, {
        userId: b.userId,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/b",
        p256dh: "key",
        authSecret: "secret",
      });
      const itemA = await seedTenantCredential(a.tenantId);
      const itemB = await seedTenantCredential(b.tenantId);
      expect(await readCredential(b.tenantId, itemB)).toBe("secret");

      await deleteOwn(b);

      expect(await tenantStatusOf(b.tenantId)).toBe("deleting");
      expect(await activeSessionCount(b.userId)).toBe(0);
      const push = await listPushSubscriptionsForUser(adminPool, b.userId);
      expect(push).toHaveLength(1);
      expect(push.every((row) => row.revokedAt !== null)).toBe(true);
      expect(await keyCount(b.tenantId)).toBe(0);
      await expect(readCredential(b.tenantId, itemB)).rejects.toThrow("No data key for this credential's tenant");
      await settle();
      expect(notifiedTenants()).toEqual([b.tenantId]);
      expect(await auditCount()).toBe(0);

      expect(await tenantStatusOf(a.tenantId)).toBe("active");
      expect(await activeSessionCount(a.userId)).toBe(1);
      expect(await keyCount(a.tenantId)).toBe(1);
      expect(await readCredential(a.tenantId, itemA)).toBe("secret");
    });

    it("deletes a suspended account whose tenant never stored a key", async () => {
      await makeAccount("admin");
      const b = await makeAccount("member", "suspended");

      await deleteOwn(b);

      expect(await tenantStatusOf(b.tenantId)).toBe("deleting");
      expect(await keyCount(b.tenantId)).toBe(0);
    });

    it("refuses a wrong password with 403, records a failed attempt for (email, ip) and changes nothing", async () => {
      await makeAccount("admin");
      const b = await makeAccount("member");
      await signIn(b);
      await seedTenantCredential(b.tenantId);

      const err = await deleteOwn(b, "wrong-password").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ReauthenticationFailedError);
      expect(err).toMatchObject({ status: 403, code: "reauthentication_failed" });
      expect(await failedAttempts(b.email)).toEqual([{ ip: IP }]);
      expect(await tenantStatusOf(b.tenantId)).toBe("active");
      expect(await activeSessionCount(b.userId)).toBe(1);
      expect(await keyCount(b.tenantId)).toBe(1);
      await settle();
      expect(notified).toEqual([]);
    });

    it("refuses even the correct password while the email+IP pair is locked out, and records that attempt too", async () => {
      await makeAccount("admin");
      const b = await makeAccount("member");
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await recordLoginAttempt(adminPool, { email: b.email, ip: IP, succeeded: false });
      }

      await expect(deleteOwn(b)).rejects.toBeInstanceOf(ReauthenticationFailedError);

      expect(await failedAttempts(b.email)).toHaveLength(LOCKOUT_THRESHOLD + 1);
      expect(await tenantStatusOf(b.tenantId)).toBe("active");
    });

    it("does not lock out a different IP for the same email", async () => {
      await makeAccount("admin");
      const b = await makeAccount("member");
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await recordLoginAttempt(adminPool, { email: b.email, ip: IP, succeeded: false });
      }

      await deleteOwn(b, PASSWORD, "10.9.9.9");

      expect(await tenantStatusOf(b.tenantId)).toBe("deleting");
    });

    it("refuses the only active admin with 409 last_admin and changes nothing", async () => {
      const only = await makeAccount("admin");
      await signIn(only);

      const err = await deleteOwn(only).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LastAdminError);
      expect(err).toMatchObject({ status: 409, code: "last_admin" });
      expect(await tenantStatusOf(only.tenantId)).toBe("active");
      expect(await activeSessionCount(only.userId)).toBe(1);
      await settle();
      expect(notified).toEqual([]);
    });

    it("lets an admin delete themselves when a second active admin exists", async () => {
      const first = await makeAccount("admin");
      await makeAccount("admin");

      await deleteOwn(first);

      expect(await tenantStatusOf(first.tenantId)).toBe("deleting");
    });

    it("answers 409 invalid_account_status when the account is already deleting", async () => {
      await makeAccount("admin");
      const b = await makeAccount("member");
      await deleteOwn(b);

      await expect(deleteOwn(b)).rejects.toMatchObject({ status: 409, code: "invalid_account_status" });
    });

    it("answers NotFoundError for an unknown user", async () => {
      const b = await makeAccount("member");

      await expect(
        runInTenant(b.tenantId, () =>
          deleteOwnAccount(pool, { userId: randomUUID(), tenantId: b.tenantId, password: PASSWORD, ip: IP }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses the deleted user's login with the same error as a wrong password", async () => {
      await makeAccount("admin");
      const b = await makeAccount("member");
      await deleteOwn(b);

      const correct = await login(adminPool, {
        email: b.email,
        password: PASSWORD,
        platform: "ios",
        ip: "10.7.7.7",
      }).catch((e: unknown) => e);
      const wrong = await login(adminPool, {
        email: b.email,
        password: "wrong-password",
        platform: "ios",
        ip: "10.7.7.8",
      }).catch((e: unknown) => e);

      expect(correct).toBeInstanceOf(UnauthorizedError);
      expect(wrong).toBeInstanceOf(UnauthorizedError);
      expect((correct as Error).message).toBe((wrong as Error).message);
    });
  });

  describe("deleteAccountAsAdmin", () => {
    it("deletes a member with the same effects, records one audit row and returns the summary", async () => {
      const actor = await makeAccount("admin");
      const b = await makeAccount("member");
      await signIn(b);
      const itemB = await seedTenantCredential(b.tenantId);

      const summary = await deleteAsAdmin(actor, b);

      expect(summary).toMatchObject({ userId: b.userId, status: "deleting", role: "member" });
      expect(await tenantStatusOf(b.tenantId)).toBe("deleting");
      expect(await activeSessionCount(b.userId)).toBe(0);
      expect(await keyCount(b.tenantId)).toBe(0);
      await expect(readCredential(b.tenantId, itemB)).rejects.toThrow("No data key for this credential's tenant");
      await settle();
      expect(notifiedTenants()).toEqual([b.tenantId]);
      const audit = await adminPool.query<{ actor_user_id: string; action: string; target_tenant_id: string }>(
        "SELECT actor_user_id, action, target_tenant_id FROM admin_audit_log",
      );
      expect(audit.rows).toEqual([
        { actor_user_id: actor.userId, action: "accountDeletionRequested", target_tenant_id: b.tenantId },
      ]);
      expect(await tenantStatusOf(actor.tenantId)).toBe("active");
    });

    it("refuses an admin's own id with 403 before any write, whether or not another admin exists", async () => {
      const actor = await makeAccount("admin");
      await signIn(actor);
      await makeAccount("admin");

      const err = await deleteAsAdmin(actor, actor).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SelfDeletionRequiresReauthenticationError);
      expect(err).toMatchObject({ status: 403, code: "self_deletion_requires_reauthentication" });
      expect(await tenantStatusOf(actor.tenantId)).toBe("active");
      expect(await activeSessionCount(actor.userId)).toBe(1);
      expect(await auditCount()).toBe(0);
      await settle();
      expect(notified).toEqual([]);
    });

    it("refuses deleting the only active admin from an admin whose tenant is not active", async () => {
      const only = await makeAccount("admin");
      const actor = await makeAccount("admin", "suspended");

      const err = await deleteAsAdmin(actor, only).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LastAdminError);
      expect(await tenantStatusOf(only.tenantId)).toBe("active");
      expect(await auditCount()).toBe(0);
      await settle();
      expect(notified).toEqual([]);
    });

    it("deletes an admin when a second active admin exists", async () => {
      const actor = await makeAccount("admin");
      const target = await makeAccount("admin");

      await deleteAsAdmin(actor, target);

      expect(await tenantStatusOf(target.tenantId)).toBe("deleting");
    });

    it("answers 409 invalid_account_status for a deleting account and writes no second audit row", async () => {
      const actor = await makeAccount("admin");
      const b = await makeAccount("member");
      await deleteAsAdmin(actor, b);

      await expect(deleteAsAdmin(actor, b)).rejects.toMatchObject({ status: 409, code: "invalid_account_status" });
      expect(await auditCount()).toBe(1);
    });

    it("answers NotFoundError for an unknown user", async () => {
      const actor = await makeAccount("admin");

      await expect(
        runAsSystem("deleteAccount.test", () =>
          deleteAccountAsAdmin(pool, { actorUserId: actor.userId, targetUserId: randomUUID() }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await auditCount()).toBe(0);
    });
  });

  describe("beginTenantDeletion", () => {
    it("throws before any write in a system scope", async () => {
      const b = await makeAccount("member");

      const err = await runAsSystem("deleteAccount.test", () =>
        withTransaction(pool, (client) => beginTenantDeletion(client, b.tenantId)),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ChokePointError);
      expect(await tenantStatusOf(b.tenantId)).toBe("active");
    });

    it("throws before any write in another tenant's scope", async () => {
      const a = await makeAccount("member");
      const b = await makeAccount("member");
      await signIn(b);
      await seedTenantCredential(b.tenantId);

      await expect(
        runInTenant(a.tenantId, () => withTransaction(pool, (client) => beginTenantDeletion(client, b.tenantId))),
      ).rejects.toThrow("beginTenantDeletion must run inside runInTenant");

      expect(await tenantStatusOf(b.tenantId)).toBe("active");
      expect(await activeSessionCount(b.userId)).toBe(1);
      expect(await keyCount(b.tenantId)).toBe(1);
      await settle();
      expect(notified).toEqual([]);
    });

    it("throws when the tenant is not active or suspended and rolls the transaction back", async () => {
      const b = await makeAccount("member");
      await runAsSystem("deleteAccount.test", () =>
        withTransaction(adminPool, (client) => transitionTenantStatus(client, b.tenantId, ["active"], "suspended")),
      );
      await seedTenantCredential(b.tenantId);
      await adminPool.query("UPDATE tenants SET status = 'provisioning' WHERE id = $1", [b.tenantId]);

      await expect(
        runInTenant(b.tenantId, () => withTransaction(pool, (client) => beginTenantDeletion(client, b.tenantId))),
      ).rejects.toMatchObject({ code: "invalid_account_status" });

      expect(await keyCount(b.tenantId)).toBe(1);
    });
  });
});
