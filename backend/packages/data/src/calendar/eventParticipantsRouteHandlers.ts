import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { parseAddressListProperty } from "../mail/addressListParsing.js";
import { normalizeEmailAddress } from "../mail/personEmailIndexStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  EVENT_PEOPLE_PROPERTY_KEY,
  readEventParticipantMetadata,
  type EventParticipantInvitation,
  type EventParticipantRole,
} from "./eventParticipantEdgeHook.js";
import { inviteEventPerson, replaceEventPeople } from "./eventParticipantsWrites.js";

/** One participant of an Event, as `GET /api/events/:id/people` returns it. */
interface EventParticipant {
  personId: string;
  /** The person's `name`, or `null` when it has none. */
  name: string | null;
  /** The person's stored `relationship` option value, or `null` when it has none. */
  relationship: string | null;
  /** The distinct addresses of the person's `emails`, trimmed and in lower case, in their stored order. */
  emails: string[];
  role: EventParticipantRole;
  invitation: EventParticipantInvitation | null;
}

const participantRow = z.object({
  personId: z.string(),
  properties: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
});

/**
 * One statement: the edges of the Events `people` relation that the Event `$2` holds, each with its
 * person. `$1` is the Events database. A person in the trash is left out, and so is an edge whose other
 * end is not an item of the relation's target database.
 */
const EVENT_PARTICIPANTS_SQL = `
SELECT person.id AS "personId", person.properties AS properties, r.metadata AS metadata
FROM properties p
JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
  AND $2::uuid = CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END
JOIN items person ON person.tenant_id = p.tenant_id
  AND person.database_id = (p.config->>'targetDatabaseId')::uuid
  AND person.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END
  AND person.deleted_at IS NULL
WHERE p.tenant_id = app_tenant_default() AND p.database_id = $1 AND p.key = $3
`;

function toParticipant(row: z.infer<typeof participantRow>): EventParticipant {
  const { name, relationship, emails } = row.properties;
  return {
    personId: row.personId,
    name: typeof name === "string" && name.length > 0 ? name : null,
    relationship: typeof relationship === "string" && relationship.length > 0 ? relationship : null,
    emails: [...new Set(parseAddressListProperty(emails).map(normalizeEmailAddress))],
    ...readEventParticipantMetadata(row.metadata),
  };
}

/**
 * The participants of a live Event of the tenant in scope, unordered, or `null` when `eventId` names no such
 * Event: an unknown id, an item of another database, an Event in the trash, another tenant's Event
 * (row-level security hides it) and a tenant without an Events database all answer the same way.
 */
async function readEventParticipants(client: PoolClient, eventId: string): Promise<EventParticipant[] | null> {
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (events === null) return null;
  const event = await getItemById(client, events.id, eventId);
  if (event === null || event.deletedAt !== null) return null;
  const { rows } = await client.query<Record<string, unknown>>(EVENT_PARTICIPANTS_SQL, [
    events.id,
    event.id,
    EVENT_PEOPLE_PROPERTY_KEY,
  ]);
  return rows.map((row) => toParticipant(participantRow.parse(row)));
}

/** The organizer first, then the other participants by name as `locale` collates it; equal names are ordered by person id. */
function orderParticipants(participants: EventParticipant[], locale: string): EventParticipant[] {
  const collator = new Intl.Collator(locale);
  const rank = (participant: EventParticipant): number => (participant.role === "organizer" ? 0 : 1);
  return [...participants].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      collator.compare(left.name ?? "", right.name ?? "") ||
      (left.personId < right.personId ? -1 : 1),
  );
}

/**
 * Duck-typed the same way `transcriptionRouteHandlers.ts` is: matches `semprec-api`'s
 * `AdapterRequestContext` structurally, with no dependency on that service's HTTP types.
 */
interface EventPeopleRouteRequestContext {
  params: Record<string, string>;
  identity: { user: { locale: string } };
}

const eventIdSchema = z.uuid();

/**
 * `GET /api/events/:id/people` (issue #1757): the participants of a live Event of the caller's tenant as
 * `{ people: [{ personId, name, relationship, emails, role, invitation }] }`. `role` is `attendee` for an
 * edge that stores no role, and `invitation` is `null` for a person who was not invited by email. The
 * organizer comes first and the others follow by name, collated in Czech or English by the caller's
 * `users.locale` (`toManifestLocale`). The lookup runs in the caller's tenant scope, so another tenant's
 * Event answers exactly like an unknown id: the same `not_found` body. An `id` that is not a UUID is
 * `validation_failed` on `id`.
 */
export function createListEventPeopleRouteHandler(pool: Pool) {
  return async (ctx: EventPeopleRouteRequestContext): Promise<{ status: number; body: unknown }> => {
    const parsedId = eventIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const participants = await withTransaction(pool, (client) => readEventParticipants(client, parsedId.data));
    if (participants === null) throw new NotFoundError("Event not found");
    const people = orderParticipants(participants, toManifestLocale(ctx.identity.user.locale));
    return { status: 200, body: { people } };
  };
}

/** The most people one `PUT /api/events/:id/people` may name; a longer list is refused before any lookup. */
const MAX_REPLACED_PEOPLE = 200;

const replaceBodySchema = z
  .object({
    people: z.array(z.object({ personId: z.uuid() }).strict()).max(MAX_REPLACED_PEOPLE),
    sendInvites: z.boolean(),
    mailboxId: z.uuid().optional(),
  })
  .strict();

const inviteBodySchema = z.object({ mailboxId: z.uuid() }).strict();

/** The field a failed body parse names: the first segment of the first issue's path, or the unknown key of the body itself. */
function bodyField(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path[0] ?? (issue?.code === "unrecognized_keys" ? issue.keys[0] : undefined);
  return typeof field === "string" ? field : "body";
}

/** The identity and request of the two write routes, duck-typed like `EventPeopleRouteRequestContext`. */
interface EventPeopleWriteRouteRequestContext extends EventPeopleRouteRequestContext {
  body: unknown;
  identity: { user: { id: string; locale: string } };
}

/** The Event's participants as the read endpoint lists them, read in the open transaction of a write. */
async function participantsAfterWrite(
  client: PoolClient,
  eventId: string,
  locale: string,
): Promise<EventParticipant[]> {
  const participants = await readEventParticipants(client, eventId);
  if (participants === null) throw new Error("The Event vanished inside the transaction that wrote its participants");
  return orderParticipants(participants, toManifestLocale(locale));
}

/**
 * `PUT /api/events/:id/people` (issue #1790) with the body `{ people: [{ personId }], sendInvites, mailboxId? }`:
 * makes `people` the Event's non-organizer participants, invites the new ones that have an address when `sendInvites`
 * is true and answers `{ people, invited, linkedOnly }`, where `people` is what the read endpoint lists after the
 * write. `replaceEventPeople` describes the diff, the organizer edge and the one transaction the whole request runs in.
 *
 * An `id` that is not a UUID or a body of another shape (an unknown key, a list over 200 people, a `personId` or
 * `mailboxId` that is not a UUID) is `400 validation_failed` on the field, before the transaction starts.
 */
export function createReplaceEventPeopleRouteHandler(pool: Pool) {
  return async (ctx: EventPeopleWriteRouteRequestContext): Promise<{ status: number; body: unknown }> => {
    const eventId = eventIdSchema.safeParse(ctx.params.id);
    if (!eventId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const body = replaceBodySchema.safeParse(ctx.body);
    if (!body.success) {
      throw new ValidationError("The body must be { people: [{ personId }], sendInvites, mailboxId? }", {
        field: bodyField(body.error),
      });
    }
    return withTransaction(pool, async (client) => {
      const counts = await replaceEventPeople(client, {
        eventId: eventId.data.toLowerCase(),
        personIds: body.data.people.map((entry) => entry.personId.toLowerCase()),
        sendInvites: body.data.sendInvites,
        mailboxId: body.data.mailboxId?.toLowerCase(),
        actingUserId: ctx.identity.user.id,
      });
      const people = await participantsAfterWrite(client, eventId.data.toLowerCase(), ctx.identity.user.locale);
      return { status: 200, body: { people, invited: counts.invited, linkedOnly: counts.linkedOnly } };
    });
  };
}

/**
 * `POST /api/events/:id/people/:personId/invite` (issue #1790) with the body `{ mailboxId }`: invites a person who is
 * already linked to the Event and answers `{ people }`, the participants as the read endpoint lists them after the
 * write. `inviteEventPerson` describes the refusals (404, 400 and the 409 `conflict` for a person who already has an
 * invitation) and the transaction. An `id` or `personId` that is not a UUID and a body that is not `{ mailboxId }` with
 * a UUID are `400 validation_failed` on the field, before the transaction starts.
 */
export function createInviteEventPersonRouteHandler(pool: Pool) {
  return async (ctx: EventPeopleWriteRouteRequestContext): Promise<{ status: number; body: unknown }> => {
    const eventId = eventIdSchema.safeParse(ctx.params.id);
    if (!eventId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const personId = eventIdSchema.safeParse(ctx.params.personId);
    if (!personId.success) throw new ValidationError("'personId' must be a UUID string", { field: "personId" });
    const body = inviteBodySchema.safeParse(ctx.body);
    if (!body.success) {
      throw new ValidationError("The body must be { mailboxId }, a mailbox UUID", { field: bodyField(body.error) });
    }
    return withTransaction(pool, async (client) => {
      await inviteEventPerson(client, {
        eventId: eventId.data.toLowerCase(),
        personId: personId.data.toLowerCase(),
        mailboxId: body.data.mailboxId.toLowerCase(),
        actingUserId: ctx.identity.user.id,
      });
      const people = await participantsAfterWrite(client, eventId.data.toLowerCase(), ctx.identity.user.locale);
      return { status: 200, body: { people } };
    });
  };
}
