// A custom route because the invitation status change and the Event write must commit together, which the generic
// item endpoints cannot express.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../chokePoint/itemTrash.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { getCalendarClock } from "../calendarTime.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { resolveNotificationsBySource } from "../notifications/notificationsStore.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { createEventInCalendar } from "./defaultCalendarCreateHook.js";
import { invitationEventFields } from "./invitationEventFields.js";
import { enqueueInvitationReply } from "./invitationReplyJob.js";
import { getEventAccountCalendar, getEventRemoteState, resolveCalendarSyncIds } from "./sync/calendarSyncStore.js";
import { enqueueCalendarInvitationRespond } from "./sync/invitationRespondJob.js";
import type { RouteParams, RouteBody, RouteUser } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";

/** The calendar agent tool accepts the same answers. */
export const INVITATION_RESPONSES = ["accepted", "tentative", "declined", "acknowledged"] as const;
type InvitationResponse = (typeof INVITATION_RESPONSES)[number];

const bodySchema = z.object({ response: z.enum(INVITATION_RESPONSES), calendarId: z.uuid().optional() }).strict();

const stateSchema = z.object({
  status: z.enum(["pending", "accepted", "tentative", "declined", "acknowledged", "cancelled"]),
  kind: z.enum(["invite", "sharedCalendarNotice"]).nullish(),
});

const USER_WRITER: WriterIdentity = { writerKind: "user" };
const CALENDAR_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: CALENDAR_MODULE_ID };
const ANSWER_KEYS = ["status", "respondedAt"] as const;

/** Trashed counterparts included. */
async function relatedIds(client: PoolClient, databaseId: string, itemId: string, key: string): Promise<string[]> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new Error(`The invitations database has no '${key}' relation`);
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
  if (!definition) throw new Error(`The invitations '${key}' relation has no definition`);
  const edges = await relationsStore.listRelationsForItem(client, definition.id, itemId);
  return edges.map((edge) => relationsStore.otherSide(edge, itemId));
}

interface RespondInput {
  invitationId: string;
  response: InvitationResponse;
  calendarId: string | undefined;
  userId: string;
  /** The user for the route, the run's agent for the calendar tool. */
  writer: WriterIdentity;
}

/**
 * How an answer reaches the organizer: through the provider for an invitation whose Event an account calendar holds
 * (the calendar sync's), by an iTIP REPLY e-mail otherwise. A synced Event the provider no longer has cannot be
 * answered.
 */
async function answerChannel(client: PoolClient, linkedId: string | undefined): Promise<"provider" | "mail"> {
  if (linkedId === undefined) return "mail";
  const ids = await resolveCalendarSyncIds(client);
  if (ids === null || (await getEventAccountCalendar(client, ids, linkedId)) === null) return "mail";
  if ((await getEventRemoteState(client, linkedId)) === null) {
    throw new ConflictError("The meeting is no longer in the account's calendar", { field: "event" }, "conflict");
  }
  return "provider";
}

/**
 * The invitation row is locked first; another tenant's id is hidden by RLS and reads as not found. An existing
 * linked Event is kept (or restored) and `calendarId` is then ignored. A failed Event write rolls the whole
 * transaction back, so the invitation keeps its status; `status` and `respondedAt` are written last.
 *
 * An invitation of a synced Event leaves the Event to its provider: the answer is queued for the provider, which
 * changes the account's attendance there, and the Event follows it with the next sync (a provider that removes a
 * declined meeting removes it here too).
 */
async function respondToInvitation(client: PoolClient, input: RespondInput, now: Date): Promise<ItemRow> {
  const invitations = await databasesStore.getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
  const invitation = invitations ? await itemsStore.lockItemById(client, invitations.id, input.invitationId) : null;
  if (!invitations || !invitation || invitation.deletedAt !== null) throw new NotFoundError("Invitation not found");
  const state = stateSchema.safeParse(invitation.properties);
  if (!state.success) throw new Error(`Invitation ${invitation.id} has an unreadable status or kind`);
  const kind = state.data.kind ?? "invite";
  if ((input.response === "acknowledged") !== (kind === "sharedCalendarNotice")) {
    throw new ValidationError(`The answer '${input.response}' does not fit an invitation of kind '${kind}'`, {
      field: "response",
    });
  }
  if (state.data.status === "cancelled") {
    throw new ConflictError("The invitation was cancelled by the organizer", { field: "status" }, "conflict");
  }
  if (state.data.status === input.response) return invitation;

  const [linkedId] =
    input.response === "acknowledged" ? [] : await relatedIds(client, invitations.id, invitation.id, "event");
  const channel = input.response === "acknowledged" ? null : await answerChannel(client, linkedId);
  if (channel === "mail") {
    const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) throw new Error("The tenant has no Events database");
    const linked = linkedId === undefined ? null : await itemsStore.lockItemById(client, events.id, linkedId);
    const { writer } = input;
    // Only a human writer is a `humanWriterUserId`: it is absent for every agent (`chokePoint/hooks.ts`).
    const options = {
      writer,
      actingUserId: input.userId,
      ...(writer.writerKind === "user" ? { humanWriterUserId: input.userId } : {}),
    };
    if (input.response === "declined") {
      if (linked !== null && linked.deletedAt === null) {
        await itemDeleteWithClient(client, events.id, linked.id, {
          queueAffinity: createActionQueueAffinity(),
          actingUserId: input.userId,
          writer,
        });
      }
    } else if (linked !== null) {
      if (linked.deletedAt !== null) {
        const restored = await restoreItemWithClient(
          client,
          events.id,
          linked.id,
          createActionQueueAffinity(),
          input.userId,
          writer,
        );
        if (restored === null) throw new Error(`Event ${linked.id} disappeared during its restore`);
      }
    } else {
      const properties = invitationEventFields(invitation, (await getCalendarClock(client)).zone);
      const [calendarId] =
        input.calendarId === undefined
          ? await relatedIds(client, invitations.id, invitation.id, "suggestedCalendar")
          : [input.calendarId];
      const event =
        calendarId === undefined
          ? await createItemWithClient(client, { databaseId: events.id, properties }, options)
          : await createEventInCalendar(client, { properties }, calendarId, options);
      const property = await propertiesStore.getPropertyByKey(client, invitations.id, "event");
      if (!property) throw new Error("The invitations database has no 'event' relation");
      await createRelationWithClient(
        client,
        { relationPropertyId: property.id, callerItemId: invitation.id, targetItemId: event.id },
        CALENDAR_RELATION_CONTEXT,
      );
    }
  }

  const respondedAt = now.toISOString();
  await updateItemWithClient(
    client,
    {
      databaseId: invitations.id,
      itemId: invitation.id,
      propertiesPatch: { status: input.response, respondedAt },
    },
    { allowedSystemKeys: ANSWER_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID, actingUserId: input.userId },
  );
  // The job exists only when this transaction commits.
  if (input.response !== "acknowledged") {
    const answer = { invitationId: invitation.id, response: input.response, respondedAt };
    if (channel === "provider") await enqueueCalendarInvitationRespond(client, answer);
    else await enqueueInvitationReply(client, answer);
  }
  await resolveNotificationsBySource(client, { sourceTable: "items", sourceId: invitation.id });
  const stored = await itemsStore.getItemById(client, invitations.id, invitation.id);
  if (!stored) throw new Error(`Invitation ${invitation.id} disappeared during its answer`);
  return stored;
}

/**
 * `POST /api/calendar/invitations/:id/respond`. The calendar agent tool passes the run's agent as `writer`, so no
 * human writer is recorded.
 */
export function createRespondToInvitationRouteHandler(pool: Pool) {
  return async (
    ctx: RouteParams & RouteBody & RouteUser,
    writer: WriterIdentity = USER_WRITER,
  ): Promise<{ status: number; item: ItemRow }> => {
    const id = requireUuidParam(ctx.params, "id");
    const body = bodySchema.safeParse(ctx.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      const field = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path[0];
      throw new ValidationError("The body must be { response, calendarId? }", {
        field: typeof field === "string" ? field : "body",
      });
    }
    const item = await withTransaction(pool, (client) =>
      respondToInvitation(
        client,
        {
          invitationId: id,
          response: body.data.response,
          calendarId: body.data.calendarId,
          userId: ctx.identity.user.id,
          writer,
        },
        new Date(),
      ),
    );
    return { status: 200, item };
  };
}
