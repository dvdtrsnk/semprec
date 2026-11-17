import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { registerPushSubscription, revokePushSubscription } from "./pushSubscriptionActions.js";
import { ValidationError } from "../errors.js";

/** Duck-typed custom-route context so this package need not import `semprec-api`'s HTTP types. */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string }; session: { id: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/** A malformed id must 400 here rather than reach Postgres as a `22P02` 500. */
const subscriptionIdSchema = z.string().uuid();

function requireBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** `POST /api/push-subscriptions`: thin mapping; binds the row to the caller's session in one transaction. */
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

/** `POST /api/push-subscriptions/:id/revoke`: scoped to the caller's own subscriptions. */
export function createRevokePushSubscriptionRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = subscriptionIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const subscriptionId = parsedId.data;
    const revoked = await withTransaction(pool, (client) =>
      revokePushSubscription(client, ctx.identity.user.id, subscriptionId),
    );
    return { status: 200, body: { revoked } };
  };
}
