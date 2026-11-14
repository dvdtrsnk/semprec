// `POST /api/calendar/invitations/:id/respond` (issue gh-1944): the user's answer to an incoming invitation, and the
// Event that follows from it, in one transaction. A custom route because the status change and the Event write must
// commit together, which the generic item endpoints cannot express.
// Constrained by: docs/adr/2026-09-10-single-writer-ownership-model.md,
// docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-11-11-new-events-get-their-calendar-in-a-create-hook.md
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

/**
 * Duck-typed the same way `duplicateCalendarItemRouteHandler.ts` is: matches `semprec-api`'s `AdapterRequestContext`
 * structurally, with no dependency on that service's HTTP types.
 */
interface RespondToInvitationRequestContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

const invitationIdSchema = z.uuid();

const RESPONSES = ["accepted", "tentative", "declined", "acknowledged"] as const;
type InvitationResponse = (typeof RESPONSES)[number];

const bodySchema = z.object({ response: z.enum(RESPONSES), calendarId: z.uuid().optional() }).strict();

/** The stored fields that decide whether and how an answer applies. */
const stateSchema = z.object({
  status: z.enum(["pending", "accepted", "tentative", "declined", "acknowledged", "cancelled"]),
  kind: z.enum(["invite", "sharedCalendarNotice"]).nullish(),
});

const USER_WRITER: WriterIdentity = { writerKind: "user" };
const CALENDAR_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: CALENDAR_MODULE_ID };
/** The invitation properties this route writes as the calendar module's owner process. */
const ANSWER_KEYS = ["status", "respondedAt"] as const;

/** The ids on the other end of the edges `itemId` holds on its relation `key`, trashed ones included. */
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
}

/**
 * Applies one answer inside the caller's transaction and returns the invitation as stored afterwards.
 *
 * The invitation row is locked first; an unknown id, another tenant's id (row-level security hides it) and a trashed
 * invitation are the same `NotFoundError`. `acknowledged` fits only a `sharedCalendarNotice` and the other three
 * answers only an `invite` (`validation_failed` on `response`); a `cancelled` invitation is 409 `conflict`; an answer
 * equal to the stored status writes nothing.
 *
 * `accepted` and `tentative` give the invitation one Event, `meeting`, written as the user: a new one in the calendar
 * `calendarId` or else the invitation's `suggestedCalendar` (the default calendar when it has none), linked through the
 * invitation's `event` relation; a live linked Event stays as it is and `calendarId` is not read; a trashed one is
 * restored. `declined` trashes the linked Event, if any. A failure of the Event write or its validation propagates and
 * rolls the whole transaction back, so the invitation keeps its status.
 *
 * `status` and `respondedAt` are written last, as the calendar module's owner process, and the invitation's
 * notification is then resolved (read, and a silent dismiss push follows after commit) in the same transaction. An
 * answer equal to the stored status returns before any of that.
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

  if (input.response !== "acknowledged") {
    const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) throw new Error("The tenant has no Events database");
    const [linkedId] = await relatedIds(client, invitations.id, invitation.id, "event");
    const linked = linkedId === undefined ? null : await itemsStore.lockItemById(client, events.id, linkedId);
    const options = { writer: USER_WRITER, actingUserId: input.userId, humanWriterUserId: input.userId };
    if (input.response === "declined") {
      if (linked !== null && linked.deletedAt === null) {
        await itemDeleteWithClient(client, events.id, linked.id, {
          queueAffinity: createActionQueueAffinity(),
          actingUserId: input.userId,
          writer: USER_WRITER,
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
          USER_WRITER,
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

  await updateItemWithClient(
    client,
    {
      databaseId: invitations.id,
      itemId: invitation.id,
      propertiesPatch: { status: input.response, respondedAt: now.toISOString() },
    },
    { allowedSystemKeys: ANSWER_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID, actingUserId: input.userId },
  );
  await resolveNotificationsBySource(client, { sourceTable: "items", sourceId: invitation.id });
  const stored = await itemsStore.getItemById(client, invitations.id, invitation.id);
  if (!stored) throw new Error(`Invitation ${invitation.id} disappeared during its answer`);
  return stored;
}

/**
 * `POST /api/calendar/invitations/:id/respond` (issue gh-1944). The body is `{ response, calendarId? }`: `response` is
 * `accepted`, `tentative`, `declined` or `acknowledged` and `calendarId` the calendar of the new Event; any other key is
 * refused. The answer is 200 with the invitation item. `respondToInvitation` describes what an answer does and which
 * answers are refused; an `id` or `calendarId` that is not a UUID and a body of another shape are `400
 * validation_failed` on the field before the transaction starts, and so are a `calendarId` that is not one of the
 * tenant's own live calendars and an Event whose dates or times the Events rules refuse.
 */
export function createRespondToInvitationRouteHandler(pool: Pool) {
  return async (ctx: RespondToInvitationRequestContext): Promise<{ status: number; item: ItemRow }> => {
    const id = invitationIdSchema.safeParse(ctx.params.id);
    if (!id.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
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
          invitationId: id.data,
          response: body.data.response,
          calendarId: body.data.calendarId,
          userId: ctx.identity.user.id,
        },
        new Date(),
      ),
    );
    return { status: 200, item };
  };
}
