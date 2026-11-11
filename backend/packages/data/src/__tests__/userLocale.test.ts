import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant } from "../testSupport/tenantFixtures.js";
import type { SupportedLocale } from "../auth/locales.js";
import type { UserRow } from "../auth/types.js";
import { createUser, getUserById, updateUserLocale } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";

interface Account {
  tenantId: string;
  user: UserRow;
}

let adminPool: Pool;
let pool: Pool;

async function makeAccount(locale?: SupportedLocale): Promise<Account> {
  const tenantId = await createTestTenant(adminPool);
  const user = await createUser(adminPool, {
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    tenantId,
    locale,
  });
  return { tenantId, user };
}

/** Calls `updateUserLocale` on the runtime-role pool, in a transaction of the account's tenant, as the profile route does. */
function setLocale(account: Account, userId: string, locale: SupportedLocale): Promise<UserRow | null> {
  return runInTenant(account.tenantId, () =>
    withTransaction(pool, (client) => updateUserLocale(client, userId, locale)),
  );
}

async function storedUser(userId: string): Promise<UserRow> {
  const user = await getUserById(adminPool, userId);
  if (!user) throw new Error(`no user ${userId}`);
  return user;
}

/** `xmin` names the transaction that wrote the row version, so an unchanged value means no statement rewrote the row. */
async function rowVersionOf(userId: string): Promise<string> {
  const { rows } = await adminPool.query<{ version: string }>("SELECT xmin::text AS version FROM users WHERE id = $1", [
    userId,
  ]);
  const row = rows[0];
  if (!row) throw new Error(`no user ${userId}`);
  return row.version;
}

/** Rejects naming `what` when `work` has not settled within `ms`; the timer is cleared either way. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once exactly one backend waits for a lock in a locale update. */
async function oneLocaleUpdateWaits(): Promise<void> {
  await vi.waitFor(
    async () => {
      const { rows } = await adminPool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query LIKE 'UPDATE users SET locale%'`,
      );
      expect(rows[0]?.waiting).toBe(1);
    },
    { timeout: 10_000, interval: 50 },
  );
}

describe("updateUserLocale (issue #1704)", () => {
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
  });

  it("stores the new locale, returns the updated row and leaves another tenant's user as it was", async () => {
    const other = await makeAccount();
    const account = await makeAccount();
    expect(account.user.locale).toBe("cs");

    const updated = await setLocale(account, account.user.id, "en");

    expect(updated).toEqual({ ...account.user, locale: "en" });
    expect(await storedUser(account.user.id)).toEqual({ ...account.user, locale: "en" });
    expect(await storedUser(other.user.id)).toEqual(other.user);
  });

  it("changes an English locale back to Czech", async () => {
    const account = await makeAccount("en");

    const updated = await setLocale(account, account.user.id, "cs");

    expect(updated).toEqual({ ...account.user, locale: "cs" });
    expect(await storedUser(account.user.id)).toEqual({ ...account.user, locale: "cs" });
  });

  it.each<SupportedLocale>(["cs", "en"])(
    "returns null and does not rewrite the row when the stored locale already is %s",
    async (locale) => {
      const account = await makeAccount(locale);
      const versionBefore = await rowVersionOf(account.user.id);

      const updated = await setLocale(account, account.user.id, locale);

      expect(updated).toBeNull();
      expect(await rowVersionOf(account.user.id)).toBe(versionBefore);
      expect(await storedUser(account.user.id)).toEqual(account.user);
    },
  );

  it("returns null for an id no user has and changes no user", async () => {
    const account = await makeAccount();
    const other = await makeAccount();

    const updated = await setLocale(account, randomUUID(), "en");

    expect(updated).toBeNull();
    expect(await storedUser(account.user.id)).toEqual(account.user);
    expect(await storedUser(other.user.id)).toEqual(other.user);
  });

  it("returns the row to only one of two overlapping changes to the same locale once the first commits", async () => {
    const account = await makeAccount();
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstUpdated!: () => void;
    const firstUpdated = new Promise<void>((resolve) => {
      markFirstUpdated = resolve;
    });
    // The first transaction has updated the row and has not committed.
    const first = runInTenant(account.tenantId, () =>
      withTransaction(pool, async (client) => {
        const updated = await updateUserLocale(client, account.user.id, "en");
        markFirstUpdated();
        await firstHeld;
        return updated;
      }),
    );
    // Awaited below; observed here too, so an early failure is never an unhandled rejection.
    first.catch(() => undefined);
    await within(firstUpdated, 10_000, "The first update");

    const second = setLocale(account, account.user.id, "en");
    second.catch(() => undefined);
    try {
      await oneLocaleUpdateWaits();
    } finally {
      releaseFirst();
    }

    expect(await within(first, 10_000, "The first change")).toEqual({ ...account.user, locale: "en" });
    expect(await within(second, 10_000, "The second change")).toBeNull();
    expect(await storedUser(account.user.id)).toEqual({ ...account.user, locale: "en" });
  });

  it("returns the row to the second of two overlapping changes when the first rolls back", async () => {
    const account = await makeAccount();
    const rolledBack = new Error("rolled back by the test");
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstUpdated!: () => void;
    const firstUpdated = new Promise<void>((resolve) => {
      markFirstUpdated = resolve;
    });
    const first = runInTenant(account.tenantId, () =>
      withTransaction(pool, async (client) => {
        await updateUserLocale(client, account.user.id, "en");
        markFirstUpdated();
        await firstHeld;
        throw rolledBack;
      }),
    );
    first.catch(() => undefined);
    await within(firstUpdated, 10_000, "The first update");

    const second = setLocale(account, account.user.id, "en");
    second.catch(() => undefined);
    try {
      await oneLocaleUpdateWaits();
    } finally {
      releaseFirst();
    }

    await expect(within(first, 10_000, "The first change")).rejects.toBe(rolledBack);
    expect(await within(second, 10_000, "The second change")).toEqual({ ...account.user, locale: "en" });
    expect(await storedUser(account.user.id)).toEqual({ ...account.user, locale: "en" });
  });
});
