import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { login } from "../auth/authActions.js";
import type { UserRole } from "../auth/types.js";
import { getOrCreateTenantDataKey } from "../credentials/tenantKeysStore.js";
import type { TenantStatus } from "../tenancy/tenantsStore.js";
import { TENANT_STATUS_CHANNEL } from "../tenancy/tenantStatusSignal.js";
import { handleTenantPurgeTask, replayTenantDeletions, type TenantPurgeDirs } from "../tenancy/tenantPurgeJob.js";

// Lets one test make the last-admin guard fail with something other than `LastAdminError`.
const guardHook = vi.hoisted(() => ({ failWith: null as null | Error }));
vi.mock("../tenancy/accountsAdminStore.js", async (importActual) => {
  const actual = await importActual<typeof import("../tenancy/accountsAdminStore.js")>();
  return {
    ...actual,
    assertAnotherActiveAdminRemains: async (...args: Parameters<typeof actual.assertAnotherActiveAdminRemains>) => {
      if (guardHook.failWith) throw guardHook.failWith;
      await actual.assertAnotherActiveAdminRemains(...args);
    },
  };
});

const PASSWORD = "s3cret-password";

interface Account {
  userId: string;
  email: string;
  tenantId: string;
}

let adminPool: Pool;
let pool: Pool;
let listener: PoolClient;
let notified: string[];
let dirs: TenantPurgeDirs;

async function makeAccount(role: UserRole, status: TenantStatus = "active"): Promise<Account> {
  const tenantId = await createTestTenant(adminPool, { status });
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId, role });
  return { userId: user.id, email, tenantId };
}

async function signIn(account: Account): Promise<void> {
  await login(adminPool, { email: account.email, password: PASSWORD, platform: "ios", ip: "10.1.2.3" });
}

async function seedTenantKey(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => withTenantTransaction(adminPool, tenantId, (c) => getOrCreateTenantDataKey(c)));
}

async function statusOf(tenantId: string): Promise<string | undefined> {
  const { rows } = await adminPool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
  return rows[0]?.status;
}

async function count(sql: string, id: string): Promise<number> {
  const { rows } = await adminPool.query<{ n: string }>(sql, [id]);
  return Number(rows[0]?.n);
}

const activeSessions = (userId: string) =>
  count("SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL", userId);
const keys = (tenantId: string) => count("SELECT count(*) AS n FROM tenant_keys WHERE tenant_id = $1", tenantId);
const tombstones = (tenantId: string) =>
  count("SELECT count(*) AS n FROM tenant_deletions WHERE tenant_id = $1", tenantId);

function replay(ids: string[]) {
  return runAsSystem("tenantDeletionReplay.test", () => replayTenantDeletions(pool, ids));
}

describe("replayTenantDeletions (issue #1078)", () => {
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
    guardHook.failWith = null;
    notified = [];
    const root = join(tmpdir(), `semprec-test-replay-${randomUUID()}`);
    dirs = { files: join(root, "files"), mailAttachments: join(root, "mail") };
    listener = await adminPool.connect();
    listener.on("notification", (msg) => {
      if (msg.channel === TENANT_STATUS_CHANNEL && msg.payload) notified.push(msg.payload);
    });
    await listener.query(`LISTEN ${TENANT_STATUS_CHANNEL}`);
  });

  afterEach(() => {
    listener.release(true);
  });

  it("marks B, which the purge then erases with a tombstone, and reports absent and deleting ids without changing them", async () => {
    const a = await makeAccount("admin");
    const b = await makeAccount("admin");
    const deleting = await makeAccount("admin", "deleting");
    const absent = randomUUID();
    await signIn(a);
    await signIn(b);
    await signIn(b);
    await seedTenantKey(a.tenantId);
    await seedTenantKey(b.tenantId);

    const result = await replay([b.tenantId, absent, deleting.tenantId]);

    expect(result).toEqual({
      marked: [b.tenantId],
      alreadyDeleting: [deleting.tenantId],
      absent: [absent],
      refused: [],
    });
    expect(await statusOf(b.tenantId)).toBe("deleting");
    expect(await activeSessions(b.userId)).toBe(0);
    expect(await keys(b.tenantId)).toBe(0);
    await listener.query("SELECT 1");
    expect(notified.map((payload) => JSON.parse(payload) as unknown)).toEqual([{ tenantId: b.tenantId }]);
    expect(await statusOf(deleting.tenantId)).toBe("deleting");
    expect(await statusOf(absent)).toBeUndefined();
    expect(await tombstones(absent)).toBe(0);
    expect(await statusOf(a.tenantId)).toBe("active");
    expect(await activeSessions(a.userId)).toBe(1);
    expect(await keys(a.tenantId)).toBe(1);

    await handleTenantPurgeTask(pool, dirs);

    expect(await statusOf(b.tenantId)).toBeUndefined();
    expect(await tombstones(b.tenantId)).toBe(1);
    expect(await statusOf(a.tenantId)).toBe("active");
  });

  it("refuses the only active admin's tenant as lastAdmin, leaves it unchanged and still marks the others", async () => {
    const onlyAdmin = await makeAccount("admin");
    const member = await makeAccount("member");
    await signIn(onlyAdmin);
    await seedTenantKey(onlyAdmin.tenantId);

    const result = await replay([onlyAdmin.tenantId, member.tenantId]);

    expect(result).toEqual({
      marked: [member.tenantId],
      alreadyDeleting: [],
      absent: [],
      refused: [{ tenantId: onlyAdmin.tenantId, reason: "lastAdmin" }],
    });
    expect(await statusOf(onlyAdmin.tenantId)).toBe("active");
    expect(await activeSessions(onlyAdmin.userId)).toBe(1);
    expect(await keys(onlyAdmin.tenantId)).toBe(1);
    expect(await statusOf(member.tenantId)).toBe("deleting");
    await listener.query("SELECT 1");
    expect(notified).toHaveLength(1);
  });

  it("lets an admin's tenant go when another active admin remains, in the same replay", async () => {
    const first = await makeAccount("admin");
    const second = await makeAccount("admin");

    const result = await replay([first.tenantId, second.tenantId]);

    expect(result.marked).toEqual([first.tenantId]);
    expect(result.refused).toEqual([{ tenantId: second.tenantId, reason: "lastAdmin" }]);
    expect(await statusOf(second.tenantId)).toBe("active");
  });

  it("marks a suspended tenant without applying the last-admin guard", async () => {
    await makeAccount("admin");
    const suspended = await makeAccount("admin", "suspended");

    const result = await replay([suspended.tenantId]);

    expect(result.marked).toEqual([suspended.tenantId]);
    expect(await statusOf(suspended.tenantId)).toBe("deleting");
  });

  it("refuses a provisioning tenant as unexpectedStatus and leaves it unchanged", async () => {
    const provisioning = await makeAccount("member", "provisioning");

    const result = await replay([provisioning.tenantId]);

    expect(result).toEqual({
      marked: [],
      alreadyDeleting: [],
      absent: [],
      refused: [{ tenantId: provisioning.tenantId, reason: "unexpectedStatus" }],
    });
    expect(await statusOf(provisioning.tenantId)).toBe("provisioning");
    await listener.query("SELECT 1");
    expect(notified).toEqual([]);
  });

  it("propagates a guard failure that is not LastAdminError and leaves the tenant active", async () => {
    await makeAccount("admin");
    const target = await makeAccount("admin");
    guardHook.failWith = new Error("guard unavailable");

    await expect(replay([target.tenantId])).rejects.toThrow("guard unavailable");

    expect(await statusOf(target.tenantId)).toBe("active");
    await listener.query("SELECT 1");
    expect(notified).toEqual([]);
  });
});
