import type { Pool, PoolClient } from "pg";
import { ValidationError } from "../errors.js";
import {
  revokePushSubscriptionForUser,
  upsertApnsSubscription,
  upsertWebPushSubscription,
} from "./pushSubscriptionsStore.js";
import {
  APNS_ENVIRONMENTS,
  PUSH_CHANNELS,
  type ApnsEnvironment,
  type PushChannel,
  type PushSubscriptionRow,
} from "./types.js";
import { validateWebPushEndpoint } from "./webPushEndpointValidation.js";

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`'${field}' must be a non-empty string`);
  }
  return value;
}

export interface RegisterPushSubscriptionInput {
  userId: string;
  sessionId: string | null;
  channel: unknown;
  platform: unknown;
  endpoint?: unknown;
  p256dh?: unknown;
  authSecret?: unknown;
  deviceToken?: unknown;
  apnsEnvironment?: unknown;
}

function isPushChannel(value: unknown): value is PushChannel {
  return typeof value === "string" && (PUSH_CHANNELS as readonly string[]).includes(value);
}

function isApnsEnvironment(value: unknown): value is ApnsEnvironment {
  return typeof value === "string" && (APNS_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Mirrors the schema's CHECKs up front so a malformed request is a specific 400, not a constraint 500. */
export async function registerPushSubscription(
  client: Pool | PoolClient,
  input: RegisterPushSubscriptionInput,
): Promise<PushSubscriptionRow> {
  if (!isPushChannel(input.channel)) {
    throw new ValidationError(`'channel' must be one of: ${PUSH_CHANNELS.join(", ")}`);
  }

  if (input.channel === "web_push") {
    if (input.platform !== "web") {
      throw new ValidationError("'platform' must be 'web' for the 'web_push' channel");
    }
    if (input.deviceToken !== undefined || input.apnsEnvironment !== undefined) {
      throw new ValidationError("'deviceToken'/'apnsEnvironment' are not valid for the 'web_push' channel");
    }
    return upsertWebPushSubscription(client, {
      userId: input.userId,
      sessionId: input.sessionId,
      endpoint: validateWebPushEndpoint(nonEmptyString(input.endpoint, "endpoint")),
      p256dh: nonEmptyString(input.p256dh, "p256dh"),
      authSecret: nonEmptyString(input.authSecret, "authSecret"),
    });
  }

  const platform = input.platform;
  if (platform !== "ios" && platform !== "macos") {
    throw new ValidationError("'platform' must be 'ios' or 'macos' for the 'apns' channel");
  }
  if (input.endpoint !== undefined || input.p256dh !== undefined || input.authSecret !== undefined) {
    throw new ValidationError("'endpoint'/'p256dh'/'authSecret' are not valid for the 'apns' channel");
  }
  if (!isApnsEnvironment(input.apnsEnvironment)) {
    throw new ValidationError(`'apnsEnvironment' must be one of: ${APNS_ENVIRONMENTS.join(", ")}`);
  }
  return upsertApnsSubscription(client, {
    userId: input.userId,
    sessionId: input.sessionId,
    platform,
    deviceToken: nonEmptyString(input.deviceToken, "deviceToken"),
    apnsEnvironment: input.apnsEnvironment,
  });
}

/** `false` for unknown and foreign ids alike. */
export async function revokePushSubscription(client: Pool | PoolClient, userId: string, id: string): Promise<boolean> {
  return revokePushSubscriptionForUser(client, id, userId);
}
