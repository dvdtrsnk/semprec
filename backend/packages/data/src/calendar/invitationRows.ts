// Invitations rows that more than one writer of the calendar module shares: the iMIP ingest and the calendar sync.
import type { PoolClient } from "pg";
import { getTenantUserId } from "../auth/usersStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { writeNotification } from "../notifications/notify.js";
import type { ItemRow } from "../types.js";
import { logger } from "./logger.js";

const NOTIFICATION_TITLE_MAX_CHARACTERS = 120;

/**
 * Runs in the caller's transaction, so the notification commits or rolls back with the invitation. `link_href` is
 * `null`: the app opens the invitation from `payload.invitationId`. One notification per invitation and
 * `transitionInstance`.
 */
export async function notifyInvitation(
  client: PoolClient,
  input: {
    invitationItemId: string;
    organizerName: string | null;
    organizerEmail: string | null;
    title: string | null;
    transitionInstance: string;
    /** The ids of the source logged with a skip. */
    logIds: Record<string, string>;
  },
): Promise<void> {
  const { invitationItemId } = input;
  const userId = await getTenantUserId(client);
  if (userId === null) {
    logger.warn({ ...input.logIds, invitationItemId, reason: "no_tenant_user" }, "calendar invitation not notified");
    return;
  }
  await writeNotification(client, {
    userId,
    kind: "calendar_invitation",
    titleParams: {
      organizer: input.organizerName ?? input.organizerEmail ?? "",
      title: Array.from(input.title ?? "")
        .slice(0, NOTIFICATION_TITLE_MAX_CHARACTERS)
        .join(""),
    },
    linkHref: null,
    sourceTable: "items",
    sourceId: invitationItemId,
    transitionInstance: input.transitionInstance,
    payload: { invitationId: invitationItemId },
  });
}

/**
 * The advisory lock serializes every writer that may create the invitation of one `UID` (deliveries by mail, the
 * calendar sync); trashed invitations count. The invitation found is locked.
 */
export async function lockInvitationOfUid(
  client: PoolClient,
  invitationsDatabaseId: string,
  uid: string,
): Promise<ItemRow | null> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('invitationUid:' || app_tenant_default()::text || ':' || $1::text, 0))",
    [uid],
  );
  const [existing] = await itemsStore.listItemsByTextProperty(client, invitationsDatabaseId, "uid", uid, true);
  return existing ?? null;
}
