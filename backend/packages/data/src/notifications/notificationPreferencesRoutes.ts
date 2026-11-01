import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import {
  NOTIFICATION_PROBLEMS_LEVELS,
  getNotificationPreferences,
  patchNotificationPreferences,
  type NotificationPreferencesPatch,
} from "./notificationPreferencesStore.js";

/**
 * The custom-route handler shape this file's exports are cast to by `semprec-api`'s mount (issue
 * #239) — duck-typed here, same as `pushRouteHandlers.ts`, so this package has no reason to import
 * that service's HTTP types.
 */
interface CustomRouteRequestContext {
  body: unknown;
  identity: { user: { id: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/** The boolean fields a PATCH may set, by their API names. */
const BOOLEAN_FIELDS = [
  "approvals",
  "invites",
  "reminders",
  "problemsSummary",
  "badgeApprovals",
  "badgeInvites",
  "badgeInbox",
] as const;
type BooleanField = (typeof BOOLEAN_FIELDS)[number];

function isBooleanField(field: string): field is BooleanField {
  return (BOOLEAN_FIELDS as readonly string[]).includes(field);
}

function isProblemsLevel(value: unknown): value is (typeof NOTIFICATION_PROBLEMS_LEVELS)[number] {
  return typeof value === "string" && (NOTIFICATION_PROBLEMS_LEVELS as readonly string[]).includes(value);
}

/**
 * Parses a PATCH body into the fields it sets. Anything but a JSON object, an unknown key, a
 * non-boolean boolean field or a `problemsLevel` outside the closed set is a 400; known fields are named;
 * the request writes nothing in that case, because parsing happens before the store is called.
 */
export function parseNotificationPreferencesPatch(body: unknown): NotificationPreferencesPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const patch: NotificationPreferencesPatch = {};
  const entries: [string, unknown][] = Object.entries(body);
  for (const [field, value] of entries) {
    if (isBooleanField(field)) {
      if (typeof value !== "boolean") {
        throw new ValidationError(`'${field}' must be a boolean`, { field });
      }
      patch[field] = value;
    } else if (field === "problemsLevel") {
      if (!isProblemsLevel(value)) {
        throw new ValidationError(`'problemsLevel' must be one of: ${NOTIFICATION_PROBLEMS_LEVELS.join(", ")}`, {
          field,
        });
      }
      patch.problemsLevel = value;
    } else {
      throw new ValidationError("Unknown field in request body", { field: "body" });
    }
  }
  return patch;
}

/**
 * `GET /api/notification-preferences` (issue #1441) — the caller's own preferences, or the defaults
 * when the caller has no row. Shaped for exactly one consumer, the settings screen's notification
 * section, so it is the "single-consumer-read" justification. Reads nothing but the caller's row.
 */
export function createGetNotificationPreferencesRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const preferences = await getNotificationPreferences(pool, ctx.identity.user.id);
    return { status: 200, body: preferences };
  };
}

/**
 * `PATCH /api/notification-preferences` (issue #1441) — sets the fields the body names on the
 * caller's own row, creating it on the first change. The insert and the update commit together, so
 * the "transactional-semantics" justification applies. Validation runs before the transaction opens.
 */
export function createPatchNotificationPreferencesRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const patch = parseNotificationPreferencesPatch(ctx.body);
    const preferences = await withTransaction(pool, (client) =>
      patchNotificationPreferences(client, ctx.identity.user.id, patch),
    );
    return { status: 200, body: preferences };
  };
}
