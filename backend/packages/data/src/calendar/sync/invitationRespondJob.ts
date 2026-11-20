// Sends the answer to an invitation of a synced Event through the account's provider (task
// `calendarInvitationRespond`), which tells the organizer itself; no iTIP REPLY e-mail is sent. The respond route
// queues it in the answer's own transaction. A short read transaction plans the call, the adapter call runs with no
// transaction open, and an answer the provider cannot take makes the invitation pending again, so it is not shown
// as answered when it was not.
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getItemById, lockItemById } from "../../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../../chokePoint/relationsStore.js";
import { withTransaction, type Queryable } from "../../db/pool.js";
import { INVITATIONS_MODULE_ID } from "../../seed/invitationsKeys.js";
import type { ItemRow } from "../../types.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { logger } from "../logger.js";
import {
  CalendarSyncWriteUnsupportedError,
  type CalendarSyncAdapterRegistry,
  type InvitationResponse,
  type RemoteEventRef,
} from "./adapter.js";
import { CALENDAR_SYNC_ADAPTERS } from "./adapters/index.js";
import { enqueueCalendarAccountSync } from "./calendarAccountSyncEnqueue.js";
import { failureRecordOf, openCalendarSyncAdapter, recordCalendarAccountFailure } from "./calendarAccountSyncJob.js";
import { getEventRemoteState, resolveCalendarSyncIds } from "./calendarSyncStore.js";
import { endpointOf, type Endpoint } from "./eventPushJob.js";
import { accountOwnAddresses } from "./syncedInvitations.js";

/** The deadline of the provider call. */
const INVITATION_RESPOND_TIMEOUT_MS = 60_000;
/** Attempts of one answer before it is given up and the invitation is pending again. */
const MAX_INVITATION_RESPOND_ATTEMPTS = 5;

const RESPONSES = ["accepted", "tentative", "declined"] as const satisfies readonly InvitationResponse[];

export const calendarInvitationRespondPayloadSchema = z.strictObject({
  invitationId: z.uuid(),
  response: z.enum(RESPONSES),
  respondedAt: z.iso.datetime(),
});
export type CalendarInvitationRespondPayload = z.infer<typeof calendarInvitationRespondPayloadSchema>;

export function calendarInvitationRespondJobKey(invitationId: string): string {
  return `calendar-invitation-respond:${invitationId}`;
}

/** Queued in the answer's transaction; a newer answer replaces a queued one. */
export async function enqueueCalendarInvitationRespond(
  client: Queryable,
  input: CalendarInvitationRespondPayload,
): Promise<void> {
  const payload = calendarInvitationRespondPayloadSchema.parse(input);
  await enqueueJob(client, CORE_TASK_NAMES.CALENDAR_INVITATION_RESPOND, payload, {
    jobKey: calendarInvitationRespondJobKey(payload.invitationId),
    maxAttempts: MAX_INVITATION_RESPOND_ATTEMPTS,
  });
}

const storedAnswerSchema = z.object({ status: z.string(), respondedAt: z.string().nullish() });

export type InvitationRespondResult =
  | { kind: "answered" }
  /** The invitation was answered again, removed, or is no longer pending this answer. */
  | { kind: "superseded" }
  /** The answer cannot reach the provider; the invitation is pending again. */
  | { kind: "failed"; reason: string };

export interface InvitationRespondOptions {
  adapters?: CalendarSyncAdapterRegistry;
  /** graphile-worker's job id, so a redelivered failure adds no Semp problem occurrence. */
  jobId?: string;
  /** The queue's last attempt gives the answer up instead of rethrowing. */
  isFinalAttempt?: boolean;
  timeoutMs?: number;
}

type Plan =
  | { kind: "superseded" }
  | { kind: "failed"; reason: string }
  | { kind: "respond"; endpoint: Endpoint; ref: RemoteEventRef; attendeeEmails: string[] };

/** Whether the stored invitation still holds the payload's answer. */
function holdsAnswer(invitation: ItemRow | null, payload: CalendarInvitationRespondPayload): boolean {
  if (invitation === null || invitation.deletedAt !== null) return false;
  const stored = storedAnswerSchema.safeParse(invitation.properties);
  return (
    stored.success &&
    stored.data.status === payload.response &&
    stored.data.respondedAt != null &&
    new Date(stored.data.respondedAt).getTime() === new Date(payload.respondedAt).getTime()
  );
}

async function linkedEventId(client: PoolClient, invitationsDatabaseId: string, invitationId: string) {
  const property = await getPropertyByKey(client, invitationsDatabaseId, "event");
  if (!property) throw new Error("The invitations database has no 'event' relation");
  const definition = await getRelationDefinitionByPropertyId(client, property.id);
  if (!definition) throw new Error("The invitations 'event' relation has no definition");
  const [edge] = await listRelationsForItem(client, definition.id, invitationId);
  return edge === undefined ? null : otherSide(edge, invitationId);
}

async function planRespond(client: PoolClient, payload: CalendarInvitationRespondPayload): Promise<Plan> {
  const invitations = await getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
  const ids = await resolveCalendarSyncIds(client);
  if (invitations === null || ids === null) return { kind: "superseded" };
  const invitation = await getItemById(client, invitations.id, payload.invitationId);
  if (!holdsAnswer(invitation, payload)) return { kind: "superseded" };
  const eventItemId = await linkedEventId(client, invitations.id, payload.invitationId);
  const stored = eventItemId === null ? null : await getEventRemoteState(client, eventItemId);
  if (stored === null) return { kind: "failed", reason: "eventNotSynced" };
  const endpoint = await endpointOf(client, ids, stored.calendarItemId);
  if (endpoint === null) return { kind: "failed", reason: "accountUnavailable" };
  const account = await getItemById(client, ids.mailboxesDatabaseId, endpoint.account.accountItemId);
  return {
    kind: "respond",
    endpoint,
    ref: { remoteId: stored.remoteId, href: stored.href, etag: stored.etag },
    attendeeEmails: await accountOwnAddresses(client, endpoint.account.accountItemId, account?.properties ?? {}),
  };
}

/** Only while the invitation still holds this answer, which is then withdrawn. */
async function giveUp(
  pool: Pool,
  payload: CalendarInvitationRespondPayload,
  reason: string,
): Promise<InvitationRespondResult> {
  const withdrawn = await withTransaction(pool, async (client) => {
    const invitations = await getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
    if (invitations === null) return false;
    const invitation = await lockItemById(client, invitations.id, payload.invitationId);
    if (!holdsAnswer(invitation, payload)) return false;
    await updateItemWithClient(
      client,
      {
        databaseId: invitations.id,
        itemId: payload.invitationId,
        propertiesPatch: { status: "pending", respondedAt: null },
      },
      { allowedSystemKeys: ["status", "respondedAt"], systemOwnerProcess: CALENDAR_MODULE_ID },
    );
    return true;
  });
  logger.warn(
    { invitationId: payload.invitationId, response: payload.response, reason, withdrawn },
    "An invitation answer did not reach the provider",
  );
  return withdrawn ? { kind: "failed", reason } : { kind: "superseded" };
}

/**
 * A refused credential or grant also records the account's calendar status and Semp problem. A provider or
 * unexpected failure is rethrown so the queue retries it, until the last attempt gives the answer up; an Event the
 * provider no longer has, or one without the account as an attendee, gives it up at once.
 */
export async function handleCalendarInvitationRespondTask(
  pool: Pool,
  rawPayload: unknown,
  options: InvitationRespondOptions = {},
): Promise<InvitationRespondResult> {
  const payload = calendarInvitationRespondPayloadSchema.parse(rawPayload);
  const plan = await withTransaction(pool, (client) => planRespond(client, payload));
  if (plan.kind === "superseded") return plan;
  if (plan.kind === "failed") return giveUp(pool, payload, plan.reason);

  const { endpoint } = plan;
  const accountItemId = endpoint.account.accountItemId;
  const signal = AbortSignal.timeout(options.timeoutMs ?? INVITATION_RESPOND_TIMEOUT_MS);
  let outcome: "answered" | "gone";
  try {
    const adapter = await openCalendarSyncAdapter(pool, endpoint.account, options.adapters ?? CALENDAR_SYNC_ADAPTERS);
    outcome = await adapter.respondToInvitation(
      endpoint.remote,
      plan.ref,
      { response: payload.response, attendeeEmails: plan.attendeeEmails },
      signal,
    );
  } catch (error) {
    if (error instanceof CalendarSyncWriteUnsupportedError) return giveUp(pool, payload, "unsupported");
    const failure = failureRecordOf(error, signal);
    // Provider errors can carry request details: only ids, the error's name and the fixed code are logged.
    logger.error(
      {
        invitationId: payload.invitationId,
        accountItemId,
        errorName: error instanceof Error ? error.name : typeof error,
        code: failure.code,
      },
      "An invitation answer attempt failed",
    );
    if (failure.status !== "error") {
      try {
        await recordCalendarAccountFailure(pool, accountItemId, failure, options.jobId ?? randomUUID());
      } catch (recordError) {
        // The answer's own failure is what the queue must see.
        logger.error(
          { accountItemId, errorName: recordError instanceof Error ? recordError.name : typeof recordError },
          "An invitation answer could not record the account's failure",
        );
      }
    }
    if (options.isFinalAttempt === true) return giveUp(pool, payload, failure.code);
    throw error;
  }
  if (outcome === "gone") return giveUp(pool, payload, "eventGone");
  // The next pass brings the provider's version of the Event, with the account's answer, here.
  await withTransaction(pool, (client) => enqueueCalendarAccountSync(client, accountItemId));
  logger.info({ invitationId: payload.invitationId, response: payload.response }, "An invitation was answered");
  return { kind: "answered" };
}
