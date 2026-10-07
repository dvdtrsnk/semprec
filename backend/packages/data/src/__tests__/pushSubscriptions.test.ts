import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { hashPassword } from "../auth/passwordHash.js";
import { createUser } from "../auth/usersStore.js";
import { login, logout, revokeUserSession } from "../auth/authActions.js";
import { ValidationError } from "../errors.js";
import { registerPushSubscription, revokePushSubscription } from "../push/pushSubscriptionActions.js";
import {
  revokePushSubscriptionByProviderInvalidation,
  listPushSubscriptionsForUser,
  upsertApnsSubscription,
  upsertWebPushSubscription,
} from "../push/pushSubscriptionsStore.js";
import { withTransaction } from "../db/pool.js";

let pool: Pool;

async function makeUser(email = "person@example.com") {
  return createUser(pool, { email, passwordHash: await hashPassword("s3cret-password") });
}

async function makeSession(email: string, platform: "web" | "ios" | "macos" = "web") {
  return login(pool, { email, password: "s3cret-password", platform, ip: "1.2.3.4" });
}

describe("push subscriptions (issue #150)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("registration validation", () => {
    it("rejects an unknown channel", async () => {
      const user = await makeUser();
      await expect(
        registerPushSubscription(pool, {
          userId: user.id,
          sessionId: null,
          channel: "carrier_pigeon",
          platform: "web",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects web_push with a non-web platform", async () => {
      const user = await makeUser();
      await expect(
        registerPushSubscription(pool, {
          userId: user.id,
          sessionId: null,
          channel: "web_push",
          platform: "ios",
          endpoint: "https://push.example/1",
          p256dh: "key",
          authSecret: "secret",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects web_push missing a required field", async () => {
      const user = await makeUser();
      await expect(
        registerPushSubscription(pool, {
          userId: user.id,
          sessionId: null,
          channel: "web_push",
          platform: "web",
          endpoint: "https://push.example/1",
          p256dh: "key",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects apns with a web platform", async () => {
      const user = await makeUser();
      await expect(
        registerPushSubscription(pool, {
          userId: user.id,
          sessionId: null,
          channel: "apns",
          platform: "web",
          deviceToken: "abc",
          apnsEnvironment: "sandbox",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects an invalid apnsEnvironment", async () => {
      const user = await makeUser();
      await expect(
        registerPushSubscription(pool, {
          userId: user.id,
          sessionId: null,
          channel: "apns",
          platform: "ios",
          deviceToken: "abc",
          apnsEnvironment: "staging",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects apns fields on a web_push registration", async () => {
      const user = await makeUser();
      await expect(
        registerPushSubscription(pool, {
          userId: user.id,
          sessionId: null,
          channel: "web_push",
          platform: "web",
          endpoint: "https://push.example/1",
          p256dh: "key",
          authSecret: "secret",
          deviceToken: "abc",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a web_push endpoint pointing at a loopback IP and port, writing no row", async () => {
      const user = await makeUser();
      const registration = registerPushSubscription(pool, {
        userId: user.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://127.0.0.1:9000/minio",
        p256dh: "key",
        authSecret: "secret",
      });
      await expect(registration).rejects.toBeInstanceOf(ValidationError);
      await expect(registration).rejects.toMatchObject({ details: { field: "endpoint" } });
      const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM push_subscriptions");
      expect(rows[0]?.count).toBe(0);
    });
  });

  describe("registration and reactivation", () => {
    it("registers a web_push subscription bound to the caller's session", async () => {
      const user = await makeUser();
      const { session } = await makeSession(user.email);

      const subscription = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key",
        authSecret: "secret",
      });

      expect(subscription.channel).toBe("web_push");
      expect(subscription.sessionId).toBe(session.id);
      expect(subscription.revokedAt).toBeNull();
    });

    it("registers an apns subscription", async () => {
      const user = await makeUser();
      const { session } = await makeSession(user.email, "ios");

      const subscription = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "apns",
        platform: "ios",
        deviceToken: "device-token-1",
        apnsEnvironment: "sandbox",
      });

      expect(subscription.channel).toBe("apns");
      expect(subscription.deviceToken).toBe("device-token-1");
    });

    it("re-registering the same active endpoint updates the existing row rather than duplicating it", async () => {
      const user = await makeUser();
      const { session } = await makeSession(user.email);

      const first = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key-1",
        authSecret: "secret",
      });
      const second = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key-2",
        authSecret: "secret",
      });

      expect(second.id).toBe(first.id);
      expect(second.p256dh).toBe("key-2");
      expect(await listPushSubscriptionsForUser(pool, user.id)).toHaveLength(1);
    });

    it("a revoked endpoint can register again without violating active uniqueness", async () => {
      const user = await makeUser();
      const { session } = await makeSession(user.email);

      const first = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key-1",
        authSecret: "secret",
      });
      await revokePushSubscription(pool, user.id, first.id);

      const second = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key-2",
        authSecret: "secret",
      });

      expect(second.revokedAt).toBeNull();
      const rows = await listPushSubscriptionsForUser(pool, user.id);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    });

    it("rebinds an active web_push endpoint to the account registering it and revokes the previous owner's row", async () => {
      const a = await makeUser("a@example.com");
      const b = await makeUser("b@example.com");
      const { session: sessionA } = await makeSession(a.email);
      const { session: sessionB } = await makeSession(b.email);
      const original = await registerPushSubscription(pool, {
        userId: a.id,
        sessionId: sessionA.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/shared",
        p256dh: "key-a",
        authSecret: "secret-a",
      });

      const registered = await registerPushSubscription(pool, {
        userId: b.id,
        sessionId: sessionB.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/shared",
        p256dh: "key-b",
        authSecret: "secret-b",
      });

      expect(registered.id).not.toBe(original.id);
      expect(registered.userId).toBe(b.id);
      expect(registered.p256dh).toBe("key-b");
      expect(registered.revokedAt).toBeNull();
      const rowsA = await listPushSubscriptionsForUser(pool, a.id);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!.id).toBe(original.id);
      expect(rowsA[0]!.revokedAt).not.toBeNull();
      expect(rowsA[0]!.p256dh).toBe("key-a");
      expect(rowsA[0]!.authSecret).toBe("secret-a");
      const { rows } = await pool.query(
        "SELECT id FROM push_subscriptions WHERE endpoint = $1 AND revoked_at IS NULL",
        ["https://push.example/shared"],
      );
      expect(rows).toHaveLength(1);
    });

    it("keeps the previous web_push owner active when the new owner's insert fails, for a client and a bare pool", async () => {
      const a = await makeUser("a@example.com");
      const b = await makeUser("b@example.com");
      const original = await upsertWebPushSubscription(pool, {
        userId: a.id,
        sessionId: null,
        endpoint: "https://push.example/atomic",
        p256dh: "key-a",
        authSecret: "secret-a",
      });
      await pool.query(`
        CREATE FUNCTION push_test_reject_b() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.user_id = '${b.id}' THEN RAISE EXCEPTION 'forced failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER push_test_reject_b BEFORE INSERT ON push_subscriptions
          FOR EACH ROW EXECUTE FUNCTION push_test_reject_b();`);
      try {
        const input = {
          userId: b.id,
          sessionId: null,
          endpoint: "https://push.example/atomic",
          p256dh: "key-b",
          authSecret: "secret-b",
        };
        await expect(upsertWebPushSubscription(pool, input)).rejects.toThrow("forced failure");
        await expect(withTransaction(pool, (c) => upsertWebPushSubscription(c, input))).rejects.toThrow(
          "forced failure",
        );
      } finally {
        await pool.query("DROP TRIGGER push_test_reject_b ON push_subscriptions; DROP FUNCTION push_test_reject_b()");
      }

      const rowsA = await listPushSubscriptionsForUser(pool, a.id);
      expect(rowsA).toEqual([original]);
      expect(rowsA[0]!.revokedAt).toBeNull();
    });

    it("lets another user register a web_push endpoint once its owner has revoked it", async () => {
      const a = await makeUser("a@example.com");
      const b = await makeUser("b@example.com");
      const { session: sessionA } = await makeSession(a.email);
      const { session: sessionB } = await makeSession(b.email);
      const original = await registerPushSubscription(pool, {
        userId: a.id,
        sessionId: sessionA.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/shared",
        p256dh: "key-a",
        authSecret: "secret-a",
      });
      expect(await revokePushSubscription(pool, a.id, original.id)).toBe(true);

      const registered = await registerPushSubscription(pool, {
        userId: b.id,
        sessionId: sessionB.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/shared",
        p256dh: "key-b",
        authSecret: "secret-b",
      });

      expect(registered.id).not.toBe(original.id);
      expect(registered.userId).toBe(b.id);
      expect(registered.revokedAt).toBeNull();
      const rowsA = await listPushSubscriptionsForUser(pool, a.id);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!.id).toBe(original.id);
      expect(rowsA[0]!.revokedAt).not.toBeNull();
    });

    it("rebinds an active apns device token to the account registering it and revokes the previous owner's row", async () => {
      const a = await makeUser("a@example.com");
      const b = await makeUser("b@example.com");
      const { session: sessionA } = await makeSession(a.email, "ios");
      const { session: sessionB } = await makeSession(b.email, "ios");
      const original = await registerPushSubscription(pool, {
        userId: a.id,
        sessionId: sessionA.id,
        channel: "apns",
        platform: "ios",
        deviceToken: "shared-device-token",
        apnsEnvironment: "sandbox",
      });

      const registered = await registerPushSubscription(pool, {
        userId: b.id,
        sessionId: sessionB.id,
        channel: "apns",
        platform: "ios",
        deviceToken: "shared-device-token",
        apnsEnvironment: "production",
      });

      expect(registered.id).not.toBe(original.id);
      expect(registered.userId).toBe(b.id);
      expect(registered.apnsEnvironment).toBe("production");
      expect(registered.revokedAt).toBeNull();
      const rowsA = await listPushSubscriptionsForUser(pool, a.id);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!.id).toBe(original.id);
      expect(rowsA[0]!.revokedAt).not.toBeNull();
      expect(rowsA[0]!.apnsEnvironment).toBe("sandbox");
      const { rows } = await pool.query(
        "SELECT id FROM push_subscriptions WHERE device_token = $1 AND revoked_at IS NULL",
        ["shared-device-token"],
      );
      expect(rows).toHaveLength(1);
    });

    it("keeps the previous apns owner active when the new owner's insert fails, for a client and a bare pool", async () => {
      const a = await makeUser("a@example.com");
      const b = await makeUser("b@example.com");
      const original = await upsertApnsSubscription(pool, {
        userId: a.id,
        sessionId: null,
        platform: "ios",
        deviceToken: "atomic-token",
        apnsEnvironment: "sandbox",
      });
      await pool.query(`
        CREATE FUNCTION push_test_reject_b() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.user_id = '${b.id}' THEN RAISE EXCEPTION 'forced failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER push_test_reject_b BEFORE INSERT ON push_subscriptions
          FOR EACH ROW EXECUTE FUNCTION push_test_reject_b();`);
      try {
        const input = {
          userId: b.id,
          sessionId: null,
          platform: "ios" as const,
          deviceToken: "atomic-token",
          apnsEnvironment: "production" as const,
        };
        await expect(upsertApnsSubscription(pool, input)).rejects.toThrow("forced failure");
        await expect(withTransaction(pool, (c) => upsertApnsSubscription(c, input))).rejects.toThrow("forced failure");
      } finally {
        await pool.query("DROP TRIGGER push_test_reject_b ON push_subscriptions; DROP FUNCTION push_test_reject_b()");
      }

      const rowsA = await listPushSubscriptionsForUser(pool, a.id);
      expect(rowsA).toEqual([original]);
      expect(rowsA[0]!.revokedAt).toBeNull();
    });

    it("lets another user register an apns device token once its owner has revoked it", async () => {
      const a = await makeUser("a@example.com");
      const b = await makeUser("b@example.com");
      const { session: sessionA } = await makeSession(a.email, "ios");
      const { session: sessionB } = await makeSession(b.email, "ios");
      const original = await registerPushSubscription(pool, {
        userId: a.id,
        sessionId: sessionA.id,
        channel: "apns",
        platform: "ios",
        deviceToken: "shared-device-token",
        apnsEnvironment: "sandbox",
      });
      expect(await revokePushSubscription(pool, a.id, original.id)).toBe(true);

      const registered = await registerPushSubscription(pool, {
        userId: b.id,
        sessionId: sessionB.id,
        channel: "apns",
        platform: "ios",
        deviceToken: "shared-device-token",
        apnsEnvironment: "sandbox",
      });

      expect(registered.id).not.toBe(original.id);
      expect(registered.userId).toBe(b.id);
      expect(registered.revokedAt).toBeNull();
      const rowsA = await listPushSubscriptionsForUser(pool, a.id);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!.id).toBe(original.id);
      expect(rowsA[0]!.revokedAt).not.toBeNull();
    });
  });

  describe("explicit revocation", () => {
    it("revokes a subscription owned by the caller", async () => {
      const user = await makeUser();
      const { session } = await makeSession(user.email);
      const subscription = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key",
        authSecret: "secret",
      });

      expect(await revokePushSubscription(pool, user.id, subscription.id)).toBe(true);
      const [row] = await listPushSubscriptionsForUser(pool, user.id);
      expect(row!.revokedAt).not.toBeNull();
    });

    it("returns false for a subscription owned by someone else", async () => {
      const owner = await makeUser("owner@example.com");
      const other = await makeUser("other@example.com");
      const { session } = await makeSession(owner.email);
      const subscription = await registerPushSubscription(pool, {
        userId: owner.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key",
        authSecret: "secret",
      });

      expect(await revokePushSubscription(pool, other.id, subscription.id)).toBe(false);
    });
  });

  describe("session cascade", () => {
    it("logout revokes only registrations tied to that session, leaving other sessions' registrations active", async () => {
      const user = await makeUser();
      const first = await makeSession(user.email);
      const second = await makeSession(user.email);

      const subOnFirst = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: first.session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/first",
        p256dh: "key",
        authSecret: "secret",
      });
      const subOnSecond = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: second.session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/second",
        p256dh: "key",
        authSecret: "secret",
      });

      await logout(pool, first.session.id);

      const rows = await listPushSubscriptionsForUser(pool, user.id);
      expect(rows.find((r) => r.id === subOnFirst.id)!.revokedAt).not.toBeNull();
      expect(rows.find((r) => r.id === subOnSecond.id)!.revokedAt).toBeNull();
    });

    it("remote session revocation cascades to that session's registrations", async () => {
      const user = await makeUser();
      await makeSession(user.email);
      const second = await makeSession(user.email);

      const subOnSecond = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: second.session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/second",
        p256dh: "key",
        authSecret: "secret",
      });

      const revoked = await revokeUserSession(pool, user.id, second.session.id);
      expect(revoked).toBe(true);

      const [row] = await listPushSubscriptionsForUser(pool, user.id);
      expect(row!.id).toBe(subOnSecond.id);
      expect(row!.revokedAt).not.toBeNull();
    });
  });

  describe("provider invalidation", () => {
    it("revokes the exact web_push registration a provider reports gone", async () => {
      const user = await makeUser();
      const { session } = await makeSession(user.email);
      await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key",
        authSecret: "secret",
      });

      const revoked = await revokePushSubscriptionByProviderInvalidation(pool, {
        channel: "web_push",
        endpoint: "https://push.example/1",
      });
      expect(revoked).toBe(true);

      const [row] = await listPushSubscriptionsForUser(pool, user.id);
      expect(row!.revokedAt).not.toBeNull();
    });

    it("revokes the exact apns registration on a BadDeviceToken-equivalent invalidation", async () => {
      const user = await makeUser();
      const { session } = await makeSession(user.email, "ios");
      await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "apns",
        platform: "ios",
        deviceToken: "device-token-1",
        apnsEnvironment: "sandbox",
      });

      const revoked = await revokePushSubscriptionByProviderInvalidation(pool, {
        channel: "apns",
        deviceToken: "device-token-1",
      });
      expect(revoked).toBe(true);
    });

    it("is a no-op for a registration that doesn't exist", async () => {
      const revoked = await revokePushSubscriptionByProviderInvalidation(pool, {
        channel: "web_push",
        endpoint: "https://push.example/unknown",
      });
      expect(revoked).toBe(false);
    });
  });

  describe("session deletion (issue #784)", () => {
    it("orphans session_id to NULL instead of raising a foreign-key violation", async () => {
      const user = await makeUser();
      const { session } = await makeSession(user.email);
      const subscription = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/1",
        p256dh: "key",
        authSecret: "secret",
      });

      await pool.query("DELETE FROM sessions WHERE id = $1", [session.id]);

      const { rows } = await pool.query<{ id: string; session_id: string | null }>(
        "SELECT id, session_id FROM push_subscriptions WHERE id = $1",
        [subscription.id],
      );
      expect(rows).toEqual([{ id: subscription.id, session_id: null }]);
    });

    it("leaves other push_subscriptions rows unaffected when their session is deleted", async () => {
      const user = await makeUser();
      const sessionA = await makeSession(user.email);
      const sessionB = await makeSession(user.email);
      const subA = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: sessionA.session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/a",
        p256dh: "key",
        authSecret: "secret",
      });
      const subB = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: sessionB.session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/b",
        p256dh: "key",
        authSecret: "secret",
      });

      await pool.query("DELETE FROM sessions WHERE id = $1", [sessionA.session.id]);

      const [rowA] = await listPushSubscriptionsForUser(pool, user.id).then((rows) =>
        rows.filter((r) => r.id === subA.id),
      );
      const [rowB] = await listPushSubscriptionsForUser(pool, user.id).then((rows) =>
        rows.filter((r) => r.id === subB.id),
      );
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      expect(rowA!.sessionId).toBeNull();
      expect(rowB!.sessionId).toBe(sessionB.session.id);
    });
  });
});
