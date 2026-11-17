import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { registerPushSubscription, revokePushSubscription } from "./pushSubscriptionActions.js";
import type { CustomRouteResult, RouteParams, RouteBody, RouteUser, RouteSession } from "../customRoute.js";
import { requireBodyObject, requireUuidParam } from "../customRoute.js";

/** `POST /api/push-subscriptions`: thin mapping; binds the row to the caller's session in one transaction. */
export function createRegisterPushSubscriptionRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser & RouteSession): Promise<CustomRouteResult> => {
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

/** `POST /api/push-subscriptions/:id/revoke`: scoped to the caller's own subscriptions. */
export function createRevokePushSubscriptionRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser & RouteSession): Promise<CustomRouteResult> => {
    const subscriptionId = requireUuidParam(ctx.params, "id");
    const revoked = await withTransaction(pool, (client) =>
      revokePushSubscription(client, ctx.identity.user.id, subscriptionId),
    );
    return { status: 200, body: { revoked } };
  };
}
