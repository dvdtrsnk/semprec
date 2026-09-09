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
} from "../push/pushSubscriptionsStore.js";

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
});
