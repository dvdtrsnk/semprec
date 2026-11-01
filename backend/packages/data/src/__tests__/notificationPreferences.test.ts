import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { ValidationError } from "../errors.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  withTenantTransaction,
} from "../testSupport/tenantFixtures.js";
import {
  getNotificationPreferences,
  patchNotificationPreferences,
  type NotificationPreferences,
} from "../notifications/notificationPreferencesStore.js";
import {
  createGetNotificationPreferencesRouteHandler,
  createPatchNotificationPreferencesRouteHandler,
  parseNotificationPreferencesPatch,
} from "../notifications/notificationPreferencesRoutes.js";

// Issue #1441: per-user notification preferences. The store and the two custom-route handlers are
// exercised against the real database; isolation runs on the runtime-role pool with two tenants.
let adminPool: Pool;
let runtimePool: Pool;

const DEFAULTS = {
  approvals: true,
  invites: true,
  reminders: true,
  problemsLevel: "critical",
  problemsSummary: true,
  badgeApprovals: true,
  badgeInvites: true,
  badgeInbox: false,
  updatedAt: null,
};

beforeAll(async () => {
  adminPool = getTestPool();
  runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(adminPool);
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
});

/** A user account in `tenantId`; a tenant holds exactly one user (`users.tenant_id` is unique). */
async function userIn(tenantId: string): Promise<string> {
  const user = await createUser(adminPool, { email: `${randomUUID()}@example.com`, passwordHash: "unused", tenantId });
  return user.id;
}

/** Calls the GET handler the way the adapter does: the request runs inside the caller's tenant. */
function getPreferences(tenantId: string, userId: string) {
  return runInTenant(tenantId, () =>
    createGetNotificationPreferencesRouteHandler(runtimePool)({ body: undefined, identity: { user: { id: userId } } }),
  );
}

/** Calls the PATCH handler the way the adapter does, with the parsed JSON body the adapter would pass. */
function patchPreferences(tenantId: string, userId: string, body: unknown) {
  return runInTenant(tenantId, () =>
    createPatchNotificationPreferencesRouteHandler(runtimePool)({ body, identity: { user: { id: userId } } }),
  );
}

/** Counts the rows of one user through the superuser pool, which sees every row regardless of tenant. */
async function countRowsFor(userId: string): Promise<number> {
  const { rows } = await adminPool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM notification_preferences WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.n ?? -1;
}

describe("notification preferences (issue #1441)", () => {
  it("answers the defaults for a user without a row, and reading writes no row", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);

    const answer = await getPreferences(tenant, user);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(DEFAULTS);
    expect(await countRowsFor(user)).toBe(0);
  });

  it("changes only the field a PATCH names, and the column defaults fill the rest of a new row", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);

    const patched = await patchPreferences(tenant, user, { approvals: false });

    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ ...DEFAULTS, approvals: false, updatedAt: expect.any(String) });
    expect((await getPreferences(tenant, user)).body).toEqual(patched.body);
    expect(await countRowsFor(user)).toBe(1);
  });

  it("keeps the other stored fields when a later PATCH sets a different field", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);
    await patchPreferences(tenant, user, { approvals: false });

    const later = await patchPreferences(tenant, user, { problemsLevel: "all" });

    expect(later.body).toEqual({ ...DEFAULTS, approvals: false, problemsLevel: "all", updatedAt: expect.any(String) });
  });

  it("stores and returns every field and every problemsLevel value", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);
    const every = {
      approvals: false,
      invites: false,
      reminders: false,
      problemsLevel: "off",
      problemsSummary: false,
      badgeApprovals: false,
      badgeInvites: false,
      badgeInbox: true,
    };

    const first = await patchPreferences(tenant, user, every);
    expect(first.body).toEqual({ ...every, updatedAt: expect.any(String) });

    const second = await patchPreferences(tenant, user, { problemsLevel: "all" });
    expect(second.body).toEqual({ ...every, problemsLevel: "all", updatedAt: expect.any(String) });
  });

  it("changes nothing for an empty PATCH: no row for a user without one, the same answer for a user with one", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);

    const empty = await patchPreferences(tenant, user, {});
    expect(empty.body).toEqual(DEFAULTS);
    expect(await countRowsFor(user)).toBe(0);

    const before = await patchPreferences(tenant, user, { badgeInbox: true });
    const after = await patchPreferences(tenant, user, {});
    expect(after.body).toEqual(before.body);
  });

  it("refuses a field it does not know, a non-boolean boolean, or a problemsLevel outside the set, naming the field and writing nothing", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);
    const refused: [unknown, string][] = [
      [{ approvals: "yes" }, "approvals"],
      [{ badgeInbox: 1 }, "badgeInbox"],
      [{ problemsLevel: "none" }, "problemsLevel"],
      [{ problemsLevel: 3 }, "problemsLevel"],
      [{ mute: true }, "body"],
      // A valid field next to an unknown key still refuses the whole request: nothing is written.
      [{ approvals: false, updatedAt: "2026-01-01T00:00:00.000Z" }, "body"],
    ];

    for (const [body, field] of refused) {
      await expect(patchPreferences(tenant, user, body), JSON.stringify(body)).rejects.toMatchObject({
        status: 400,
        details: { field },
      });
    }
    await expect(patchPreferences(tenant, user, { approvals: false, mute: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await countRowsFor(user)).toBe(0);
    expect((await getPreferences(tenant, user)).body).toEqual(DEFAULTS);
  });

  it("omits an unknown key and value from the validation error without writing mixed input", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);
    const before = await patchPreferences(tenant, user, { approvals: true });
    const key = "private-key-sentinel";
    const value = "private-value-sentinel";
    let caught: unknown;
    try {
      await patchPreferences(tenant, user, { approvals: false, [key]: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    if (!(caught instanceof ValidationError)) throw new Error("Expected validation error");
    expect(caught.details).toEqual({ field: "body" });
    const exposed = `${caught.message} ${JSON.stringify(caught.details)}`;
    expect(exposed).not.toContain(key);
    expect(exposed).not.toContain(value);
    expect((await getPreferences(tenant, user)).body).toEqual(before.body);
  });

  it("refuses a body that is not a JSON object", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);

    for (const body of [null, [], "approvals", 5, undefined]) {
      await expect(patchPreferences(tenant, user, body), String(body)).rejects.toThrow(
        "Request body must be a JSON object",
      );
    }
    expect(await countRowsFor(user)).toBe(0);
  });

  it("parses a PATCH body into only the fields it names", () => {
    expect(parseNotificationPreferencesPatch({})).toEqual({});
    expect(parseNotificationPreferencesPatch({ approvals: false, problemsLevel: "off" })).toEqual({
      approvals: false,
      problemsLevel: "off",
    });
  });

  it("lets two users in two tenants read and change only their own preferences", async () => {
    const tenantA = getTenantZeroId();
    const userA = await userIn(tenantA);
    const tenantB = await createTestTenant(adminPool);
    const userB = await userIn(tenantB);

    await patchPreferences(tenantA, userA, { approvals: false, badgeInbox: true });
    const foreignDefaults = await getPreferences(tenantB, userB);
    expect(foreignDefaults.body).toEqual(DEFAULTS);

    await patchPreferences(tenantB, userB, { invites: false });

    const ownA = await getPreferences(tenantA, userA);
    expect(ownA.body).toEqual({
      ...DEFAULTS,
      approvals: false,
      badgeInbox: true,
      updatedAt: expect.any(String),
    });
    const ownB = await getPreferences(tenantB, userB);
    expect(ownB.body).toEqual({ ...DEFAULTS, invites: false, updatedAt: expect.any(String) });

    // Through the runtime role, each tenant's scope sees only its own row, whatever user id it names.
    const rowsSeenByB = await withTenantTransaction(runtimePool, tenantB, (client) =>
      client.query<{ user_id: string; tenant_id: string }>("SELECT user_id, tenant_id FROM notification_preferences"),
    );
    expect(rowsSeenByB.rows.map((row) => row.user_id)).toEqual([userB]);
    expect(rowsSeenByB.rows.map((row) => row.tenant_id)).toEqual([tenantB]);
  });

  it("refuses a change that names another tenant's user, because the composite key is checked against the tenant", async () => {
    const tenantA = getTenantZeroId();
    const userA = await userIn(tenantA);
    const tenantB = await createTestTenant(adminPool);

    await expect(
      withTenantTransaction(runtimePool, tenantB, (client) =>
        patchNotificationPreferences(client, userA, { approvals: false }),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await countRowsFor(userA)).toBe(0);
  });

  it("returns the stored answer through the store read, which never writes", async () => {
    const tenant = getTenantZeroId();
    const user = await userIn(tenant);
    const read: NotificationPreferences = await withTenantTransaction(runtimePool, tenant, (client) =>
      getNotificationPreferences(client, user),
    );

    expect(read).toEqual(DEFAULTS);
    expect(await countRowsFor(user)).toBe(0);
  });
});
