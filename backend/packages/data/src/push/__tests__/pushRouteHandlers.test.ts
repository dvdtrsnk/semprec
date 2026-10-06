import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { hashPassword } from "../../auth/passwordHash.js";
import { createUser } from "../../auth/usersStore.js";
import { login } from "../../auth/authActions.js";
import {
  createRegisterPushSubscriptionRouteHandler,
  createRevokePushSubscriptionRouteHandler,
} from "../pushRouteHandlers.js";
import { ValidationError } from "../../errors.js";

let pool: Pool;

async function makeIdentity(email = "person@example.com", bound = true) {
  await createUser(pool, {
    ...(bound ? { tenantId: getTenantZeroId() } : {}),
    email,
    passwordHash: await hashPassword("s3cret-password"),
  });
  const session = await login(pool, { email, password: "s3cret-password", platform: "web", ip: "1.2.3.4" });
  return { user: { id: session.user.id }, session: { id: session.session.id } };
}

/**
 * Issue #239's `schemaCore`-owned push-subscription custom-route handler factories, exercised
 * directly against the real functions they thinly wrap (#150's `registerPushSubscription`/
 * `revokePushSubscription`).
 */
describe("push subscription custom route handlers (issue #239)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("registers a web_push subscription bound to the caller's own session", async () => {
    const identity = await makeIdentity();
    const handler = createRegisterPushSubscriptionRouteHandler(pool);

    const result = await handler({
      params: {},
      identity,
      body: {
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/abc",
        p256dh: "key",
        authSecret: "secret",
      },
    });

    expect(result.status).toBe(200);
    const body = result.body as { subscription: { userId: string; sessionId: string | null } };
    expect(body.subscription.userId).toBe(identity.user.id);
    expect(body.subscription.sessionId).toBe(identity.session.id);
  });

  it("revokes the caller's own subscription", async () => {
    const identity = await makeIdentity();
    const registerHandler = createRegisterPushSubscriptionRouteHandler(pool);
    const registered = await registerHandler({
      params: {},
      identity,
      body: {
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/abc",
        p256dh: "key",
        authSecret: "secret",
      },
    });
    const subscriptionId = (registered.body as { subscription: { id: string } }).subscription.id;

    const revokeHandler = createRevokePushSubscriptionRouteHandler(pool);
    const result = await revokeHandler({ params: { id: subscriptionId }, identity, body: {} });

    expect(result.status).toBe(200);
    expect((result.body as { revoked: boolean }).revoked).toBe(true);
  });

  it("returns revoked: false for a subscription owned by someone else", async () => {
    const owner = await makeIdentity("owner@example.com");
    const registerHandler = createRegisterPushSubscriptionRouteHandler(pool);
    const registered = await registerHandler({
      params: {},
      identity: owner,
      body: {
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/abc",
        p256dh: "key",
        authSecret: "secret",
      },
    });
    const subscriptionId = (registered.body as { subscription: { id: string } }).subscription.id;

    const attacker = await makeIdentity("attacker@example.com", false);
    const revokeHandler = createRevokePushSubscriptionRouteHandler(pool);
    const result = await revokeHandler({ params: { id: subscriptionId }, identity: attacker, body: {} });

    expect((result.body as { revoked: boolean }).revoked).toBe(false);
  });

  it("rejects a malformed (non-UUID) subscription id with a ValidationError naming 'id', not a raw Postgres error", async () => {
    const identity = await makeIdentity();
    const revokeHandler = createRevokePushSubscriptionRouteHandler(pool);

    const result = revokeHandler({ params: { id: "foo" }, identity, body: {} });

    await expect(result).rejects.toThrow(ValidationError);
    await expect(result).rejects.toMatchObject({ code: "validation_failed", details: { field: "id" } });
  });
});
