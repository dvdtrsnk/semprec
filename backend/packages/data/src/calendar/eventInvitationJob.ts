// The `calendarSendEventInvitation` task (issue #1774): sends the iTIP messages about an Event, a `REQUEST` that
// invites a person or updates the invitation and a `CANCEL` that withdraws it, from the mailbox the invitation
// names, and records `invitation.sentAt` on the participant edge once a `REQUEST` left.
// Constrained by: docs/adr/2026-11-12-module-queue-tasks-read-their-composition-root-dependencies-from-a-binding.md,
// docs/adr/2026-11-11-event-participant-invitations-are-written-by-system-writers.md,
// docs/adr/2026-09-10-side-effects-follow-the-commit.md
import type { Pool, PoolClient } from "pg";
import { DateTime } from "luxon";
import { z } from "zod";
import { enqueueJob } from "@semprec/queue";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { updateRelationWithClient } from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { wallClockToInstant } from "../calendarTime.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { parseAddressListProperty } from "../mail/addressListParsing.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import {
  getMailAccountSyncState,
  defaultSyncModeForProvider,
  type SyncMode,
} from "../mail/mailAccountSyncStateStore.js";
import type { MailTransport, MailTransportFactory } from "../mail/mailTransport.js";
import { buildOutgoingMime, generateOutgoingMessageId } from "../mail/outgoingMime.js";
import { MailRecipientRejectedError, MailTransportUnavailableError } from "../mail/providerTypes.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { ItemRow } from "../types.js";
import { buildItipCancel, buildItipRequest, type ItipEventInput } from "./icalendarWriter.js";
import { EVENT_PEOPLE_PROPERTY_KEY, readEventParticipantMetadata } from "./eventParticipantEdgeHook.js";
import { logger } from "./logger.js";

/** The queue name of the task, as `calendarModuleManifest.ts` declares it. */
export const CALENDAR_SEND_EVENT_INVITATION_TASK = "calendarSendEventInvitation";

/**
 * What an outgoing `CANCEL` says about the Event, taken when the job is enqueued because the Event or the edge may
 * be gone when it runs. `start` and `end` are what the message carries (`ItipEventInput`): days for an all-day Event
 * (`end` the day after its last day), UTC instants otherwise.
 */
const eventInvitationSnapshotSchema = z
  .object({
    uid: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    title: z.string(),
    start: z.string().min(1),
    end: z.string().min(1),
    place: z.string().nullable(),
    allDay: z.boolean(),
  })
  .strict();

export type EventInvitationSnapshot = z.infer<typeof eventInvitationSnapshotSchema>;

const invitationTarget = {
  eventId: z.uuid(),
  personId: z.uuid(),
  mailboxId: z.uuid(),
  attendeeEmail: z.string().min(1),
};

/** The payload of the task: a `REQUEST` reads the live Event, a `CANCEL` carries its snapshot. */
export const calendarSendEventInvitationPayloadSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("REQUEST"), ...invitationTarget }).strict(),
  z.object({ method: z.literal("CANCEL"), ...invitationTarget, snapshot: eventInvitationSnapshotSchema }).strict(),
]);

export type EventInvitationPayload = z.infer<typeof calendarSendEventInvitationPayloadSchema>;

interface InvitationTarget {
  eventId: string;
  personId: string;
  mailboxId: string;
  attendeeEmail: string;
}

export type EnqueueEventInvitationInput =
  | (InvitationTarget & {
      method: "REQUEST";
      /** The Event's `icalSequence` at the change that queues the message; it keys the job and is not sent in the payload. */
      sequence: number;
    })
  | (InvitationTarget & { method: "CANCEL"; snapshot: EventInvitationSnapshot });

/** `event-invitation:<eventId>:<personId>:<method>:<sequence>`; a `CANCEL` is keyed by the snapshot's sequence. */
function eventInvitationJobKey(input: EnqueueEventInvitationInput): string {
  const sequence = input.method === "REQUEST" ? input.sequence : input.snapshot.sequence;
  return `event-invitation:${input.eventId}:${input.personId}:${input.method}:${sequence}`;
}

/**
 * Queues one invitation message in the caller's open transaction, so the job exists only when that transaction
 * commits and a rolled-back change sends nothing. A repeat under the same job key collapses onto the queued job.
 * The payload is validated before it is queued; an input that does not fit it throws and rolls the caller back.
 */
export async function enqueueEventInvitation(client: PoolClient, input: EnqueueEventInvitationInput): Promise<void> {
  if (input.method === "REQUEST" && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) {
    throw new ValidationError("'sequence' must be a non-negative integer", { field: "sequence" });
  }
  const { method, eventId, personId, mailboxId, attendeeEmail } = input;
  const payload = calendarSendEventInvitationPayloadSchema.parse(
    input.method === "REQUEST"
      ? { method, eventId, personId, mailboxId, attendeeEmail }
      : { method, eventId, personId, mailboxId, attendeeEmail, snapshot: input.snapshot },
  );
  await enqueueJob(client, CALENDAR_SEND_EVENT_INVITATION_TASK, payload, { jobKey: eventInvitationJobKey(input) });
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * What the message about an Event carries: the UID, the sequence, the title, the place and the times. An Event with
 * no `timeFrom` is all-day, with `DATE` values and the day after its last day as the end. A timed Event converts its
 * wall-clock start and end in the tenant zone to UTC instants; without a `timeTo` it ends at the midnight that ends
 * its last day. An Event without a UID or with an unreadable date or time is `validation_failed`.
 */
export function eventInvitationSnapshot(event: ItemRow, zone: string): EventInvitationSnapshot {
  const properties = event.properties;
  const uid = text(properties.icalUid);
  const date = text(properties.date);
  if (uid === null) throw new ValidationError("The Event has no iCalendar UID", { field: "icalUid" });
  if (date === null || !DATE_PATTERN.test(date)) {
    throw new ValidationError("The Event has no readable date", { field: "date" });
  }
  const lastDay = text(properties.endDate) ?? date;
  const sequence = properties.icalSequence;
  const base = {
    uid,
    sequence: typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
    title: text(properties.name) ?? "",
    place: text(properties.place),
  };
  const timeFrom = text(properties.timeFrom);
  if (timeFrom === null) {
    const last = DateTime.fromISO(lastDay, { zone: "utc" });
    if (!DATE_PATTERN.test(lastDay) || !last.isValid) {
      throw new ValidationError("The Event has no readable end date", { field: "endDate" });
    }
    return { ...base, allDay: true, start: date, end: last.plus({ days: 1 }).toFormat("yyyy-MM-dd") };
  }
  const start = wallClockToInstant(date, timeFrom, zone).toJSDate().toISOString();
  const end = wallClockToInstant(lastDay, text(properties.timeTo) ?? "24:00", zone)
    .toJSDate()
    .toISOString();
  return { ...base, allDay: false, start, end };
}

/**
 * The snapshot of the Event in the tenant's zone, for a `CANCEL` enqueued while the Event can still be read.
 */
export async function readEventInvitationSnapshot(
  client: PoolClient,
  event: ItemRow,
): Promise<EventInvitationSnapshot> {
  return eventInvitationSnapshot(event, await getSystemTimezone(client));
}

/** What the task needs from the composition root that runs it. */
export interface EventInvitationDelivery {
  pool: Pool;
  transports: MailTransportFactory;
  /**
   * The pauses, in milliseconds, between the attempts to record `sentAt` after a message left; one more attempt than
   * entries. Defaults to `SENT_AT_RETRY_DELAYS_MS`; tests pass zeros.
   */
  sentAtRetryDelaysMs?: readonly number[];
}

/** Two retries of the `sentAt` write, a short wait apart, for a lock timeout, a deadlock or a dropped connection. */
const SENT_AT_RETRY_DELAYS_MS: readonly number[] = [200, 1000];

let delivery: EventInvitationDelivery | null = null;

/**
 * Binds the dependencies the task handler uses to the process (`null` unbinds). The API queue runtime binds them
 * before it starts its runner, because a module task handler is an export of the manifest module and receives only
 * its payload.
 */
export function setEventInvitationDelivery(next: EventInvitationDelivery | null): void {
  delivery = next;
}

const NO_ATTACHMENTS_MESSAGE = "An invitation message carries no attachment";

/** Attachment storage for `buildOutgoingMime`, which reads it only for an attachment; an invitation has none. */
const noAttachmentStorage: BlobStorageWriter = {
  writeStream: () => Promise.reject(new Error(NO_ATTACHMENTS_MESSAGE)),
  delete: () => Promise.reject(new Error(NO_ATTACHMENTS_MESSAGE)),
  readStream: () => {
    throw new Error(NO_ATTACHMENTS_MESSAGE);
  },
};

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Loaded once per process; a failed load is not cached, so the next job retries it. */
function getCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

/** The subject and the plain-text body of a message in the tenant user's language; the title stands in `{title}`. */
async function renderInvitationText(
  method: EventInvitationPayload["method"],
  locale: string,
  title: string,
): Promise<{ subject: string; text: string }> {
  const catalogs = await getCatalogs();
  const kind = method === "REQUEST" ? "request" : "cancel";
  const resolve = (part: "subject" | "text"): string =>
    resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, `calendar.invitation.${kind}.${part}`);
  // A header takes no line break; a replacer function keeps `$` sequences in the title literal.
  const oneLine = title.replace(/\s+/g, " ").trim();
  return {
    subject: resolve("subject").replaceAll("{title}", () => oneLine),
    text: resolve("text").replaceAll("{title}", () => oneLine),
  };
}

type PermanentReason =
  | "eventMissing"
  | "eventTrashed"
  | "mailboxMissing"
  | "noMailboxAddress"
  | "invalidMessage"
  | "noTransport"
  | "recipientRejected";

interface SendPlan {
  organizerEmail: string;
  syncMode: SyncMode;
  locale: string;
  snapshot: EventInvitationSnapshot;
}

type Planned = { kind: "send"; plan: SendPlan } | { kind: "end"; reason: PermanentReason };

/** Logs why a job ended without sending, by reason code and ids; the addresses and the title stay out of the log. */
function endWithoutSending(payload: EventInvitationPayload, reason: PermanentReason): void {
  logger.warn(
    {
      reason,
      method: payload.method,
      eventId: payload.eventId,
      personId: payload.personId,
      mailboxId: payload.mailboxId,
    },
    "An event invitation message was not sent",
  );
}

/**
 * Reads, in one short transaction and before any network call, everything the message is made of: the live Event for
 * a `REQUEST` (the snapshot for a `CANCEL`), the mailbox with its first address and its sync mode, and the tenant
 * user's language. A missing or trashed Event, a missing or trashed mailbox and a mailbox with no address end the job.
 */
async function planMessage(client: PoolClient, payload: EventInvitationPayload): Promise<Planned> {
  let snapshot: EventInvitationSnapshot;
  if (payload.method === "CANCEL") {
    snapshot = payload.snapshot;
  } else {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    const event = events === null ? null : await getItemById(client, events.id, payload.eventId);
    if (event === null) return { kind: "end", reason: "eventMissing" };
    if (event.deletedAt !== null) return { kind: "end", reason: "eventTrashed" };
    try {
      snapshot = await readEventInvitationSnapshot(client, event);
    } catch (error) {
      if (error instanceof ValidationError) return { kind: "end", reason: "invalidMessage" };
      throw error;
    }
  }
  const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  const mailbox = mailboxes === null ? null : await getItemById(client, mailboxes.id, payload.mailboxId);
  if (mailbox === null || mailbox.deletedAt !== null) return { kind: "end", reason: "mailboxMissing" };
  const organizerEmail = parseAddressListProperty(mailbox.properties.addresses)[0];
  if (organizerEmail === undefined) return { kind: "end", reason: "noMailboxAddress" };
  // A mailbox that has never synced has no sync-state row; it takes the default mode of its provider, as a send does.
  const syncState = await getMailAccountSyncState(client, payload.mailboxId);
  const provider = typeof mailbox.properties.provider === "string" ? mailbox.properties.provider : "generic";
  return {
    kind: "send",
    plan: {
      organizerEmail,
      syncMode: syncState?.syncMode ?? defaultSyncModeForProvider(provider),
      locale: (await getTenantUserLocale(client)) ?? "cs",
      snapshot,
    },
  };
}

/**
 * Sets `invitation.sentAt` on the participant edge, as the system writer, after a `REQUEST` left. It locks the Event
 * row first, as every participant edge write does, and replaces the stored metadata with itself plus the new `sentAt`,
 * so a reply recorded in between is kept. Returns `false` when the Event (or its trash) or the edge or its invitation is gone: the
 * message was sent and there is nothing to mark.
 *
 * The message that left carried `sentSequence`. The Events update hook queues an updated `REQUEST` only for an edge
 * that already has `sentAt`, so an Event changed while this message was on its way queued nothing for this person. The
 * lock makes the check here atomic with every Event update: when the live Event has a higher `icalSequence`, the edge
 * had no `sentAt` before this write (so no hook queued the update) and the invitation is not declined, the updated
 * `REQUEST` is queued in this transaction. A trashed Event is `false` too: its delete hook queued the `CANCEL`.
 */
async function recordInvitationSent(
  pool: Pool,
  payload: EventInvitationPayload,
  sentSequence: number,
  sentAt: Date,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (events === null) return false;
    const event = await lockItemById(client, events.id, payload.eventId);
    // A trashed Event takes no edge write, and the delete hook queued the CANCEL: there is nothing to mark.
    if (event === null || event.deletedAt !== null) return false;
    const property = await getPropertyByKey(client, events.id, EVENT_PEOPLE_PROPERTY_KEY);
    const reldef = property === null ? null : await getRelationDefinitionByPropertyId(client, property.id);
    if (property === null || reldef === null) return false;
    const edges = await listRelationsForItem(client, reldef.id, payload.eventId);
    const edge = edges.find((candidate) => otherSide(candidate, payload.eventId) === payload.personId);
    const invitation = edge === undefined ? null : readEventParticipantMetadata(edge.metadata).invitation;
    if (edge === undefined || invitation === null) return false;
    await updateRelationWithClient(
      client,
      {
        relationPropertyId: property.id,
        callerItemId: payload.eventId,
        targetItemId: payload.personId,
        metadata: { ...edge.metadata, invitation: { ...invitation, sentAt: sentAt.toISOString() } },
      },
      undefined,
      SYSTEM_WRITER,
    );
    const currentSequence = event.properties.icalSequence;
    if (
      invitation.sentAt === undefined &&
      invitation.status !== "declined" &&
      typeof currentSequence === "number" &&
      currentSequence > sentSequence
    ) {
      await enqueueEventInvitation(client, {
        method: "REQUEST",
        eventId: payload.eventId,
        personId: payload.personId,
        mailboxId: invitation.mailboxId,
        attendeeEmail: invitation.email,
        sequence: currentSequence,
      });
    }
    return true;
  });
}

const wait = (milliseconds: number): Promise<void> =>
  milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();

/**
 * Records `sentAt` with the attempts `delaysMs` allows. Every failure is logged with its error name and the ids; the
 * last one is rethrown, so the job fails and the queue retries it rather than report a success that did not happen.
 *
 * A refusal that no retry can change (`ValidationError` or `NotFoundError` from the edge write: the person is in the
 * trash, a database is archived, the edge went away) is not retried and not rethrown. It is logged with its reason
 * and answered `false`, "nothing to mark": rethrowing it would make the queue send the same message again on every
 * attempt, each time to be refused again.
 */
async function recordInvitationSentWithRetries(
  deps: EventInvitationDelivery,
  payload: EventInvitationPayload,
  sentSequence: number,
  now: () => Date,
): Promise<boolean> {
  const delays = deps.sentAtRetryDelaysMs ?? SENT_AT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await recordInvitationSent(deps.pool, payload, sentSequence, now());
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        logger.warn(
          {
            errorName: error.name,
            reason: "sentAtRefused",
            eventId: payload.eventId,
            personId: payload.personId,
            mailboxId: payload.mailboxId,
          },
          "An event invitation was sent but its sentAt write is refused, so there is nothing to mark",
        );
        return false;
      }
      const willRetry = attempt < delays.length;
      logger.error(
        {
          errorName: error instanceof Error ? error.name : "unknown",
          eventId: payload.eventId,
          personId: payload.personId,
          mailboxId: payload.mailboxId,
          attempt: attempt + 1,
          willRetry,
        },
        "An event invitation was sent but its sentAt could not be recorded",
      );
      if (!willRetry) throw error;
      await wait(delays[attempt]!);
    }
  }
}

/**
 * Sends one invitation message and, for a `REQUEST`, records that it left.
 *
 * - Ends without sending, logging a reason code: a `REQUEST` whose Event is missing, trashed or unreadable, a mailbox
 *   that is missing, trashed or has no address, a transport factory that refuses the mailbox as `validation_failed`
 *   (the way it refuses one with no SMTP settings) or as `MailTransportUnavailableError` (no OAuth client for the
 *   provider, no stored SMTP credential, a sync mode without a transport), a message the builders refuse, and a recipient the server refused.
 * - Rethrows every other failure of the factory (a read that failed, as opposed to a refusal), of the MIME build and
 *   of the transport, so the queue retries with backoff and the invitation stays `pending` without `sentAt`.
 * - Once the transport accepted the message, a failed `sentAt` write is attempted again a bounded number of times and
 *   logged each time; when the last attempt fails the error is rethrown and the queue retries the job. A refusal no
 *   retry can change (a trashed Person, an archived database) is logged and ends the job instead. A rethrow sends the
 *   message once more with the same UID and SEQUENCE, which an iTIP client treats as the same invitation, whereas a
 *   job reported as done would leave the edge without `sentAt` and every later change of the Event would skip this
 *   person.
 *
 * The job runs in the tenant scope of its envelope; the transaction that reads and the one that writes are separate
 * and no transaction is open while the message is built or sent.
 */
export async function sendEventInvitation(
  deps: EventInvitationDelivery,
  payload: EventInvitationPayload,
  now: () => Date = () => new Date(),
): Promise<void> {
  const planned = await withTransaction(deps.pool, (client) => planMessage(client, payload));
  if (planned.kind === "end") return endWithoutSending(payload, planned.reason);
  const { organizerEmail, syncMode, locale, snapshot } = planned.plan;

  let raw: Buffer;
  let envelope: { from: string; recipients: string[] };
  try {
    const { subject, text: body } = await renderInvitationText(payload.method, locale, snapshot.title);
    const event: ItipEventInput = {
      uid: snapshot.uid,
      // A cancellation is the revision after the last one that was sent.
      sequence: payload.method === "REQUEST" ? snapshot.sequence : snapshot.sequence + 1,
      stamp: now(),
      title: snapshot.title,
      place: snapshot.place,
      allDay: snapshot.allDay,
      start: snapshot.start,
      end: snapshot.end,
      organizerEmail,
      attendeeEmail: payload.attendeeEmail,
    };
    const mime = await buildOutgoingMime(
      {
        from: { address: organizerEmail },
        to: [{ address: payload.attendeeEmail }],
        subject,
        text: body,
        messageId: generateOutgoingMessageId(organizerEmail),
        calendar: {
          method: payload.method,
          content: payload.method === "REQUEST" ? buildItipRequest(event) : buildItipCancel(event),
        },
      },
      { client: deps.pool, files: noAttachmentStorage, mailAttachments: noAttachmentStorage },
    );
    raw = mime.raw;
    envelope = { from: organizerEmail, recipients: mime.envelopeRecipients };
  } catch (error) {
    if (error instanceof ValidationError) return endWithoutSending(payload, "invalidMessage");
    throw error;
  }

  let transport: MailTransport;
  try {
    transport = await deps.transports.forMailbox(payload.mailboxId, syncMode);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof MailTransportUnavailableError) {
      return endWithoutSending(payload, "noTransport");
    }
    throw error;
  }
  try {
    await transport.send({ raw, envelope });
  } catch (error) {
    if (error instanceof MailRecipientRejectedError) return endWithoutSending(payload, "recipientRejected");
    throw error;
  }
  if (payload.method === "CANCEL") return;

  if (!(await recordInvitationSentWithRetries(deps, payload, snapshot.sequence, now))) {
    logger.info(
      { eventId: payload.eventId, personId: payload.personId },
      "An event invitation was sent but no sentAt was recorded for it: there is no invitation to mark",
    );
  }
}

/**
 * The handler the calendar manifest names for the `calendarSendEventInvitation` task. It runs `sendEventInvitation`
 * with the dependencies bound by `setEventInvitationDelivery`; with none bound it throws, and the queue retries the job
 * until a runtime that bound them runs it.
 */
export async function handleCalendarSendEventInvitation(payload: unknown): Promise<void> {
  const parsed = calendarSendEventInvitationPayloadSchema.parse(payload);
  if (delivery === null) throw new Error("No event invitation delivery is configured for this composition root");
  await sendEventInvitation(delivery, parsed);
}
