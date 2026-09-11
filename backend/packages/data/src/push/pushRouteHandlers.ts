import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { registerPushSubscription, revokePushSubscription } from "./pushSubscriptionActions.js";
import { ValidationError } from "../errors.js";

/**
 * The custom-route handler shape this file's exports are cast to by `semprec-api`'s mount
 * (issue #239) — duck-typed here, same as `inboxRouteHandlers.ts`, so this package has no
 * reason to import that service's HTTP types.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string }; session: { id: string } };
}

type CustomRouteResult = { status: number; body: unknown };

function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`Missing required path parameter '${name}'`, { field: name });
  }
  return value;
}

function requireBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/**
 * `POST /api/push-subscriptions` (issue #239's custom-route registration of #150's
 * `registerPushSubscription`) — a cross-database write binding the new row to the caller's own
 * session in one transaction, the "transactional semantics" justification. Thin mapping only:
 * every validation/channel rule lives in `registerPushSubscription` itself.
 */
export function createRegisterPushSubscriptionRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const body = requireBodyObject(ctx.body);
    const subscription = await withTransaction(pool, (client) =>
      registerPushSubscription(client, {
        userId: ctx.identity.user.id,
        sessionId: ctx.identity.session.id,
        channel: body.channel,
        platform: body.platform,
        endpoint: body.endpoint,
        p256dh: body.p256dh,
        authSecret: body.authSecret,
        deviceToken: body.deviceToken,
        apnsEnvironment: body.apnsEnvironment,
      }),
    );
    return { status: 200, body: { subscription } };
  };
}

/**
 * `POST /api/push-subscriptions/:id/revoke` (issue #239's custom-route registration of #150's
 * `revokePushSubscription`) — an explicit revocation scoped to the caller's own subscriptions,
 * committed in its own transaction.
 */
export function createRevokePushSubscriptionRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const subscriptionId = requireParam(ctx.params, "id");
    const revoked = await withTransaction(pool, (client) =>
      revokePushSubscription(client, ctx.identity.user.id, subscriptionId),
    );
    return { status: 200, body: { revoked } };
  };
}
