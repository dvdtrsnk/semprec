import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { enqueueBadgeRefresh } from "../push/badgeRefreshEnqueue.js";
import {
  NOTIFICATION_PROBLEMS_LEVELS,
  getNotificationPreferences,
  patchNotificationPreferences,
  type NotificationPreferencesPatch,
} from "./notificationPreferencesStore.js";
import type { CustomRouteResult, RouteBody, RouteUser } from "../customRoute.js";
import { requireBodyObject } from "../customRoute.js";

const BOOLEAN_FIELDS = [
  "approvals",
  "invites",
  "reminders",
  "problemsSummary",
  "badgeApprovals",
  "badgeInvites",
  "badgeInbox",
  "calendarChanges",
] as const;
type BooleanField = (typeof BOOLEAN_FIELDS)[number];

function isBooleanField(field: string): field is BooleanField {
  return (BOOLEAN_FIELDS as readonly string[]).includes(field);
}

function isProblemsLevel(value: unknown): value is (typeof NOTIFICATION_PROBLEMS_LEVELS)[number] {
  return typeof value === "string" && (NOTIFICATION_PROBLEMS_LEVELS as readonly string[]).includes(value);
}

/** Runs before the store is called, so an invalid body writes nothing. */
export function parseNotificationPreferencesPatch(body: unknown): NotificationPreferencesPatch {
  const fields = requireBodyObject(body);
  const patch: NotificationPreferencesPatch = {};
  const entries: [string, unknown][] = Object.entries(fields);
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

/** `GET /api/notification-preferences`: a single-consumer read of the caller's own row. */
export function createGetNotificationPreferencesRouteHandler(pool: Pool) {
  return async (ctx: RouteBody & RouteUser): Promise<CustomRouteResult> => {
    const preferences = await getNotificationPreferences(pool, ctx.identity.user.id);
    return { status: 200, body: preferences };
  };
}

function patchesBadgeSwitch(patch: NotificationPreferencesPatch): boolean {
  return patch.badgeApprovals !== undefined || patch.badgeInvites !== undefined || patch.badgeInbox !== undefined;
}

/**
 * `PATCH /api/notification-preferences`. Naming a badge switch enqueues a badge refresh in the same
 * transaction, even when the value is unchanged.
 */
export function createPatchNotificationPreferencesRouteHandler(pool: Pool) {
  return async (ctx: RouteBody & RouteUser): Promise<CustomRouteResult> => {
    const patch = parseNotificationPreferencesPatch(ctx.body);
    const preferences = await withTransaction(pool, async (client) => {
      const patched = await patchNotificationPreferences(client, ctx.identity.user.id, patch);
      if (patchesBadgeSwitch(patch)) await enqueueBadgeRefresh(client, ctx.identity.user.id);
      return patched;
    });
    return { status: 200, body: preferences };
  };
}
