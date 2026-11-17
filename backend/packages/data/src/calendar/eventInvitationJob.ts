// Task `calendarSendEventInvitation`: sends iTIP `REQUEST` and `CANCEL` messages about an Event from the mailbox
// the invitation names, and records `invitation.sentAt` on the participant edge once a `REQUEST` left.
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

export const CALENDAR_SEND_EVENT_INVITATION_TASK = "calendarSendEventInvitation";

/**
 * Taken at enqueue because the Event or edge may be gone when the job runs. `start`/`end` are days for an all-day
 * Event (`end` the day after its last day), UTC instants otherwise.
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

/** A `REQUEST` reads the live Event; a `CANCEL` carries its snapshot. */
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
      /** Keys the job; not sent in the payload. */
      sequence: number;
    })
  | (InvitationTarget & { method: "CANCEL"; snapshot: EventInvitationSnapshot });

/** A `CANCEL` is keyed by the snapshot's sequence. */
function eventInvitationJobKey(input: EnqueueEventInvitationInput): string {
  const sequence = input.method === "REQUEST" ? input.sequence : input.snapshot.sequence;
  return `event-invitation:${input.eventId}:${input.personId}:${input.method}:${sequence}`;
}

/**
 * Queued in the caller's transaction, so a rolled-back change sends nothing. A repeat under the same key
 * collapses onto the queued job.
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
 * An Event without `timeFrom` is all-day. A timed Event converts its tenant-zone wall-clock times to UTC; without
 * `timeTo` it ends at the midnight ending its last day. No UID or an unreadable date/time is `validation_failed`.
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

export async function readEventInvitationSnapshot(
  client: PoolClient,
  event: ItemRow,
): Promise<EventInvitationSnapshot> {
  return eventInvitationSnapshot(event, await getSystemTimezone(client));
}

export interface EventInvitationDelivery {
  pool: Pool;
  transports: MailTransportFactory;
  /** One more attempt than entries. Tests pass zeros. */
  sentAtRetryDelaysMs?: readonly number[];
}

/** Retries for a lock timeout, deadlock or dropped connection. */
const SENT_AT_RETRY_DELAYS_MS: readonly number[] = [200, 1000];

let delivery: EventInvitationDelivery | null = null;

/**
 * `null` unbinds. The API queue runtime binds before starting its runner, because a module task handler receives
 * only its payload.
 */
export function setEventInvitationDelivery(next: EventInvitationDelivery | null): void {
  delivery = next;
}

const NO_ATTACHMENTS_MESSAGE = "An invitation message carries no attachment";

/** `buildOutgoingMime` reads it only for an attachment; invitations and replies have none. */
export const noAttachmentStorage: BlobStorageWriter = {
  writeStream: () => Promise.reject(new Error(NO_ATTACHMENTS_MESSAGE)),
  delete: () => Promise.reject(new Error(NO_ATTACHMENTS_MESSAGE)),
  readStream: () => {
    throw new Error(NO_ATTACHMENTS_MESSAGE);
  },
};

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** A failed load is not cached, so the next job retries it. */
export function getCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

/** In the tenant user's language. */
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

/** The addresses and the title stay out of the log. */
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
 * One short transaction before any network call. A missing or trashed Event or mailbox, or a mailbox without an
 * address, ends the job.
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
  // A never-synced mailbox has no sync-state row; it takes its provider's default mode, as a send does.
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
 * Locks the Event row first, as every participant edge write does, and rewrites the stored metadata plus `sentAt`,
 * so a reply recorded in between is kept. `false` when the Event, edge or invitation is gone.
 *
 * The update hook queues an updated `REQUEST` only for edges with `sentAt`, so a change while this message was in
 * flight queued nothing for this person. Under the Event lock, a higher live `icalSequence` on a not-declined
 * invitation queues the updated `REQUEST` in this transaction.
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
    // The delete hook queued the CANCEL.
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
 * Logs every failure and rethrows the last, so the queue retries rather than report a false success. A refusal no
 * retry can change (`ValidationError`/`NotFoundError` from the edge write) is logged and answered `false`:
 * rethrowing would resend the message on every attempt.
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
 * - Ends without sending, logging a reason code, when the Event or mailbox is unusable, the transport factory
 *   refuses the mailbox (`validation_failed` or `MailTransportUnavailableError`), the builders refuse the message, or
 *   the server refuses the recipient.
 * - Rethrows any other factory, MIME or transport failure, so the queue retries and the invitation stays pending.
 * - After the transport accepted, a failed `sentAt` write is retried and then rethrown. The resend carries the same
 *   UID and SEQUENCE, which iTIP clients treat as the same invitation; reporting done instead would leave the edge
 *   without `sentAt` and later Event changes would skip this person.
 *
 * No transaction is open while the message is built or sent.
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

/** With no dependencies bound it throws, and the queue retries until a runtime that bound them runs it. */
export async function handleCalendarSendEventInvitation(payload: unknown): Promise<void> {
  const parsed = calendarSendEventInvitationPayloadSchema.parse(payload);
  if (delivery === null) throw new Error("No event invitation delivery is configured for this composition root");
  await sendEventInvitation(delivery, parsed);
}
