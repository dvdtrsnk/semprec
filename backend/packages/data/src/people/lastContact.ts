// Issue #1660: People's derived `lastContact` — the calendar date, in the tenant time zone, of the latest
// past Event, Email or Transcript a person took part in. Only `recomputePersonLastContact` writes it,
// through the choke point as the declared `people` owner process; the hooks in `lastContactHooks.ts`,
// the daily sweep and the cutover only queue that recompute.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md and
// docs/adr/2026-09-10-single-writer-ownership-model.md
import type { Pool, PoolClient } from "pg";
import { DateTime } from "luxon";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { withTransaction, type Queryable } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { dayBounds, instantToWallClock, wallClockToInstant } from "../calendarTime.js";
import { ValidationError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** The People property this module owns. */
export const LAST_CONTACT_PROPERTY_KEY = "lastContact";

const LAST_CONTACT_LANE = "people-last-contact";

/** The relation properties whose edges make a person a participant of their item, each on its source database. */
const SOURCE_RELATIONS: ReadonlyArray<{ moduleId: string; key: string }> = [
  { moduleId: EVENTS_MODULE_ID, key: "people" },
  { moduleId: EMAILS_MODULE_ID, key: "senderPeople" },
  { moduleId: EMAILS_MODULE_ID, key: "recipientsPeople" },
  { moduleId: TRANSCRIPTS_MODULE_ID, key: "speakers" },
];

/** A source relation resolved in the current tenant: which end of its edges is the person. */
export interface SourceRelation {
  relationDefinitionId: string;
  sourceDatabaseId: string;
  sourceModuleId: string;
  /** `b` when the source property is side A of its definition, so the person is `item_b`. */
  personSide: "a" | "b";
}

export interface LastContactSources {
  peopleDatabaseId: string;
  eventsDatabaseId: string | null;
  relations: SourceRelation[];
}

const SOURCE_RELATION_ROW = z.object({
  relation_definition_id: z.string(),
  source_database_id: z.string(),
  source_module_id: z.string(),
  source_is_a: z.boolean(),
});

/**
 * The current tenant's source relations whose relation property points at its system People database, or
 * only the one with id `relationDefinitionId`. A source whose database or relation property does not exist
 * (a tenant without the mail module) is simply absent. Row-level security and the explicit tenant filter
 * confine the read to the current tenant.
 */
async function querySourceRelations(client: Queryable, relationDefinitionId: string | null): Promise<SourceRelation[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT rd.id AS relation_definition_id, d.id AS source_database_id, d.owner_module_id AS source_module_id,
            rd.property_id_a = p.id AS source_is_a
     FROM properties p
     JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id AND d.system
     JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND (rd.property_id_a = p.id OR rd.property_id_b = p.id)
     JOIN databases pd ON pd.tenant_id = p.tenant_id AND pd.system AND pd.owner_module_id = $3
       AND pd.id::text = p.config ->> 'targetDatabaseId'
     WHERE p.tenant_id = app_tenant_default() AND p.type = 'relation'
       AND (d.owner_module_id, p.key) IN (SELECT * FROM unnest($1::text[], $2::text[]))
       AND ($4::uuid IS NULL OR rd.id = $4::uuid)
     ORDER BY rd.id`,
    [
      SOURCE_RELATIONS.map((source) => source.moduleId),
      SOURCE_RELATIONS.map((source) => source.key),
      PEOPLE_MODULE_ID,
      relationDefinitionId,
    ],
  );
  return rows.map((raw) => {
    const row = SOURCE_RELATION_ROW.parse(raw);
    return {
      relationDefinitionId: row.relation_definition_id,
      sourceDatabaseId: row.source_database_id,
      sourceModuleId: row.source_module_id,
      personSide: row.source_is_a ? "b" : "a",
    };
  });
}

/** The source relation with id `relationDefinitionId` in the current tenant; `null` for any other relation. */
export async function findLastContactSourceRelation(
  client: Queryable,
  relationDefinitionId: string,
): Promise<SourceRelation | null> {
  return (await querySourceRelations(client, relationDefinitionId))[0] ?? null;
}

/** The current tenant's People and Events databases and its source relations; `null` without a People database. */
export async function resolveLastContactSources(client: PoolClient): Promise<LastContactSources | null> {
  const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
  if (!people) return null;
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  return {
    peopleDatabaseId: people.id,
    eventsDatabaseId: events?.id ?? null,
    relations: await querySourceRelations(client, null),
  };
}

export function peopleLastContactJobKey(personId: string): string {
  return `people-last-contact:${personId}`;
}

/** Queues one person's recompute; called in the same transaction as the write that triggered it. */
export async function enqueuePersonLastContactRecompute(client: Queryable, personId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE,
    { personId },
    { jobKey: peopleLastContactJobKey(personId), maxAttempts: 3, queueName: tenantLane(LAST_CONTACT_LANE) },
  );
}

/** The people (trashed ones included) linked to `itemId` through a source relation, in id order. */
export async function listLinkedPersonIds(
  client: Queryable,
  sources: LastContactSources,
  itemId: string,
): Promise<string[]> {
  const { personB, personA } = definitionsBySide(sources);
  if (personB.length === 0 && personA.length === 0) return [];
  const { rows } = await client.query<{ person_id: string }>(
    `SELECT DISTINCT CASE WHEN ir.item_a = $1 THEN ir.item_b ELSE ir.item_a END AS person_id
     FROM item_relations ir
     WHERE ir.tenant_id = app_tenant_default()
       AND ((ir.relation_definition_id = ANY($2::uuid[]) AND ir.item_a = $1)
         OR (ir.relation_definition_id = ANY($3::uuid[]) AND ir.item_b = $1))
     ORDER BY person_id`,
    [itemId, personB, personA],
  );
  return rows.map((row) => row.person_id);
}

/** Enqueues a recompute for every person linked to `itemId` through a source relation. */
export async function enqueueLinkedPeopleLastContactRecompute(client: PoolClient, itemId: string): Promise<void> {
  const sources = await resolveLastContactSources(client);
  if (!sources) return;
  for (const personId of await listLinkedPersonIds(client, sources, itemId)) {
    await enqueuePersonLastContactRecompute(client, personId);
  }
}

function definitionsBySide(sources: LastContactSources): { personB: string[]; personA: string[] } {
  return {
    personB: sources.relations.filter((r) => r.personSide === "b").map((r) => r.relationDefinitionId),
    personA: sources.relations.filter((r) => r.personSide === "a").map((r) => r.relationDefinitionId),
  };
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** When a source took place and the calendar date it counts as, in the tenant zone. */
export interface ContactMoment {
  instantMs: number;
  date: string;
}

/**
 * The moment a source is dated, read with the calendar owners (`calendarTime.ts`) in `zone`; `null` for a
 * value that is not a readable date. A date-only `date` (every Event since issue #1598) starts at its
 * `timeFrom` wall-clock time when the source is an Event with a valid `HH:MM` start, otherwise at the start
 * of that day, and counts as that date. A date with a time of day (an Email, a Transcript, an Event written
 * before #1598) is an instant when it carries an offset and wall-clock time in `zone` when it does not; it
 * counts as its date in `zone`.
 */
export function readContactMoment(date: unknown, timeFrom: unknown, zone: string): ContactMoment | null {
  if (typeof date !== "string") return null;
  try {
    if (DATE_ONLY_PATTERN.test(date)) {
      const start =
        typeof timeFrom === "string" && TIME_OF_DAY_PATTERN.test(timeFrom)
          ? wallClockToInstant(date, timeFrom, zone)
          : dayBounds(date, zone).start;
      return { instantMs: start.toMillis(), date };
    }
  } catch (error) {
    // An impossible calendar date (2026-02-30) is unreadable user input, like any other malformed value.
    if (error instanceof ValidationError) return null;
    throw error;
  }
  if (!DATE_TIME_PATTERN.test(date)) return null;
  const parsed = DateTime.fromISO(date, { zone });
  if (!parsed.isValid) return null;
  const instantMs = parsed.toMillis();
  return { instantMs, date: instantToWallClock(new Date(instantMs), zone).date };
}

interface SourceDateRow {
  database_id: string;
  date: string | null;
  time_from: string | null;
}

/** The latest moment at or before `nowMs` among the live sources linked to `personId`; `null` when none qualifies. */
async function latestContact(
  client: PoolClient,
  sources: LastContactSources,
  personId: string,
  zone: string,
  nowMs: number,
): Promise<ContactMoment | null> {
  const { personB, personA } = definitionsBySide(sources);
  if (personB.length === 0 && personA.length === 0) return null;
  const { rows } = await client.query<SourceDateRow>(
    `SELECT s.database_id, s.properties ->> 'date' AS date, s.properties ->> 'timeFrom' AS time_from
     FROM item_relations ir
     JOIN items s ON s.tenant_id = ir.tenant_id AND s.database_id = ANY($4::uuid[]) AND s.deleted_at IS NULL
       AND s.id = CASE WHEN ir.relation_definition_id = ANY($2::uuid[]) THEN ir.item_a ELSE ir.item_b END
     WHERE ir.tenant_id = app_tenant_default()
       AND ((ir.relation_definition_id = ANY($2::uuid[]) AND ir.item_b = $1)
         OR (ir.relation_definition_id = ANY($3::uuid[]) AND ir.item_a = $1))
       AND s.properties ->> 'date' IS NOT NULL`,
    [personId, personB, personA, [...new Set(sources.relations.map((r) => r.sourceDatabaseId))]],
  );
  let latest: ContactMoment | null = null;
  for (const row of rows) {
    const moment = readContactMoment(
      row.date,
      row.database_id === sources.eventsDatabaseId ? row.time_from : null,
      zone,
    );
    if (moment === null || moment.instantMs > nowMs) continue;
    if (latest === null || moment.instantMs > latest.instantMs) latest = moment;
  }
  return latest;
}

async function readTenantZone(client: Queryable): Promise<string> {
  const zone = await getSystemTimezone(client);
  assertValidTimezone(zone);
  return zone;
}

export interface LastContactClockOptions {
  /** The current moment; defaults to the time of the call. A test seam for the clock. */
  now?: Date;
}

/**
 * Recomputes one person's `lastContact` in one transaction: locks the person row, computes the latest
 * qualifying date from the linked Events, Emails and Transcripts (live, dated at or before now), and writes
 * it through the choke point only when it differs from the stored value, clearing it when no source
 * qualifies. A missing or trashed person is a no-op; a People database without the property is an error.
 */
export async function recomputePersonLastContact(
  pool: Pool,
  personId: string,
  options: LastContactClockOptions = {},
): Promise<void> {
  const nowMs = (options.now ?? new Date()).getTime();
  await withTransaction(pool, async (client) => {
    const sources = await resolveLastContactSources(client);
    if (!sources) return;
    const person = await lockItemById(client, sources.peopleDatabaseId, personId);
    if (!person || person.deletedAt) return;
    if (!(await getPropertyByKey(client, sources.peopleDatabaseId, LAST_CONTACT_PROPERTY_KEY))) {
      throw new Error("The People database has no lastContact property");
    }
    const zone = await readTenantZone(client);
    const latest = await latestContact(client, sources, personId, zone, nowMs);
    const next = latest?.date ?? null;
    const stored = person.properties[LAST_CONTACT_PROPERTY_KEY];
    const current = typeof stored === "string" ? stored : null;
    if (next === current) return;
    await updateItemWithClient(
      client,
      {
        databaseId: sources.peopleDatabaseId,
        itemId: personId,
        propertiesPatch: { [LAST_CONTACT_PROPERTY_KEY]: next },
      },
      { allowedSystemKeys: [LAST_CONTACT_PROPERTY_KEY], systemOwnerProcess: PEOPLE_MODULE_ID },
    );
  });
}

const recomputePayloadSchema = z.object({ personId: z.uuid() }).strict();

/** `peopleLastContactRecompute`: runs in the job envelope's tenant. */
export async function handlePeopleLastContactRecomputeTask(pool: Pool, payload: unknown): Promise<void> {
  const { personId } = recomputePayloadSchema.parse(payload);
  await recomputePersonLastContact(pool, personId);
}

const SWEEP_BATCH_SIZE = 500;
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface SweepEdgeRow {
  edge_id: string;
  person_id: string;
  database_id: string;
  date: string | null;
  time_from: string | null;
}

function utcDay(ms: number, shiftDays: number): string {
  return DateTime.fromMillis(ms, { zone: "utc" }).plus({ days: shiftDays }).toISODate() as string;
}

/**
 * One committed batch of the sweep in the current tenant: the next `SWEEP_BATCH_SIZE` source edges after
 * `afterEdgeId`, and a recompute queued for each person whose linked live source is dated within
 * `(now - 24 h, now]`. The text prefilter widens the window by a day on each side, because a stored instant's
 * written date can differ from its date in the tenant zone; the exact window is checked with the calendar owners.
 */
async function sweepBatch(
  pool: Pool,
  nowMs: number,
  afterEdgeId: string | null,
): Promise<{ lastEdgeId: string | null; count: number }> {
  return withTransaction(pool, async (client) => {
    const sources = await resolveLastContactSources(client);
    if (!sources || sources.relations.length === 0) return { lastEdgeId: null, count: 0 };
    const { personB, personA } = definitionsBySide(sources);
    const zone = await readTenantZone(client);
    const { rows } = await client.query<SweepEdgeRow>(
      `SELECT ir.id AS edge_id, s.database_id, s.properties ->> 'date' AS date,
              s.properties ->> 'timeFrom' AS time_from,
              CASE WHEN ir.relation_definition_id = ANY($1::uuid[]) THEN ir.item_b ELSE ir.item_a END AS person_id
       FROM item_relations ir
       JOIN items s ON s.tenant_id = ir.tenant_id AND s.database_id = ANY($3::uuid[]) AND s.deleted_at IS NULL
         AND s.id = CASE WHEN ir.relation_definition_id = ANY($1::uuid[]) THEN ir.item_a ELSE ir.item_b END
       WHERE ir.tenant_id = app_tenant_default()
         AND (ir.relation_definition_id = ANY($1::uuid[]) OR ir.relation_definition_id = ANY($2::uuid[]))
         AND left(s.properties ->> 'date', 10) BETWEEN $4 AND $5
         AND ($6::uuid IS NULL OR ir.id > $6)
       ORDER BY ir.id LIMIT $7`,
      [
        personB,
        personA,
        [...new Set(sources.relations.map((r) => r.sourceDatabaseId))],
        utcDay(nowMs - SWEEP_WINDOW_MS, -1),
        utcDay(nowMs, 1),
        afterEdgeId,
        SWEEP_BATCH_SIZE,
      ],
    );
    const people = new Set<string>();
    for (const row of rows) {
      const moment = readContactMoment(
        row.date,
        row.database_id === sources.eventsDatabaseId ? row.time_from : null,
        zone,
      );
      if (moment !== null && moment.instantMs > nowMs - SWEEP_WINDOW_MS && moment.instantMs <= nowMs) {
        people.add(row.person_id);
      }
    }
    for (const personId of [...people].sort()) await enqueuePersonLastContactRecompute(client, personId);
    return { lastEdgeId: rows.at(-1)?.edge_id ?? null, count: rows.length };
  });
}

/**
 * `peopleLastContactSweep` (daily): for every active tenant, in its own scope and in committed batches,
 * queues a recompute for each person linked to a live source whose date fell within the last 24 hours, so a
 * future Event that has since passed reaches `lastContact` without any other write. One tenant's failure
 * does not skip the others (`forEachActiveTenant`).
 */
export async function handlePeopleLastContactSweep(pool: Pool, options: LastContactClockOptions = {}): Promise<void> {
  const nowMs = (options.now ?? new Date()).getTime();
  await forEachActiveTenant(pool, async () => {
    let after: string | null = null;
    for (;;) {
      const batch = await sweepBatch(pool, nowMs, after);
      if (batch.count < SWEEP_BATCH_SIZE || batch.lastEdgeId === null) return;
      after = batch.lastEdgeId;
    }
  });
}
