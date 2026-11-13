import type { PoolClient } from "pg";
import { z } from "zod";
import type { SearchSubtitlePart } from "@semprec/shared";
import {
  AREAS_MODULE_ID,
  COMPANIES_MODULE_ID,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";

// The structured subtitle of a global search result (issue #1842). Nothing here is localised: the client composes the
// text from the kinds and the canonical values, because relative words depend on the clock and the time zone.

/** One result whose subtitle is built: the owning module of its database and its stored properties. */
export interface SubtitleSource {
  id: string;
  databaseId: string;
  moduleId: string;
  properties: Record<string, unknown>;
}

/** A relation the subtitle shows: `key` is the property on the source database, `limit` the most linked items shown. */
interface LinkSpec {
  sourceModule: string;
  key: string;
  targetModule: string;
  kind: "project" | "area" | "people";
  limit: number;
}

/** The most participants one event result names; the full list is on the event itself. */
const MAX_EVENT_PEOPLE = 5;

const LINK_SPECS: readonly LinkSpec[] = [
  { sourceModule: TASKS_MODULE_ID, key: "project", targetModule: PROJECTS_MODULE_ID, kind: "project", limit: 1 },
  {
    sourceModule: EVENTS_MODULE_ID,
    key: "people",
    targetModule: PEOPLE_MODULE_ID,
    kind: "people",
    limit: MAX_EVENT_PEOPLE,
  },
  { sourceModule: PROJECTS_MODULE_ID, key: "area", targetModule: AREAS_MODULE_ID, kind: "area", limit: 1 },
  { sourceModule: PEOPLE_MODULE_ID, key: "projects", targetModule: PROJECTS_MODULE_ID, kind: "project", limit: 1 },
  { sourceModule: FILES_MODULE_ID, key: "projects", targetModule: PROJECTS_MODULE_ID, kind: "project", limit: 1 },
];

/**
 * The live items linked to the sources through the properties in `$4..$6` (source module, property key, target
 * module as three parallel arrays), seen from the source's side of each edge. Targets in an archived database or in
 * a database the agent cannot read (`$3`) are left out. The text is a closed constant; every value is bound.
 */
const LINKED_ITEMS_FROM_SQL = `
  FROM items source
  JOIN databases source_db ON source_db.id = source.database_id
  JOIN item_relations edge ON edge.item_a = source.id OR edge.item_b = source.id
  JOIN relation_definitions definition ON definition.id = edge.relation_definition_id
  JOIN properties source_property
    ON source_property.id = CASE WHEN edge.item_a = source.id THEN definition.property_id_a ELSE definition.property_id_b END
    AND source_property.database_id = source.database_id AND source_property.type = 'relation'
  JOIN items target ON target.id = CASE WHEN edge.item_a = source.id THEN edge.item_b ELSE edge.item_a END
    AND target.database_id = ANY($2::uuid[]) AND target.deleted_at IS NULL
  JOIN databases target_db
    ON target_db.id = target.database_id AND target_db.archived_at IS NULL AND target_db.id <> ALL($3::uuid[])
  JOIN unnest($4::text[], $5::text[], $6::text[]) AS spec(source_module, key, target_module)
    ON spec.source_module = source_db.owner_module_id AND spec.key = source_property.key
    AND spec.target_module = target_db.owner_module_id
  WHERE source.id = ANY($1::uuid[]) AND source.database_id = ANY($7::uuid[])`;

interface LinkedItemDbRow {
  source_id: string;
  property_key: string;
  target_id: string;
  title: string | null;
}

interface ProjectCountDbRow {
  source_id: string;
  total: number;
}

const COUNTED_LINK = { sourceModule: AREAS_MODULE_ID, key: "projects", targetModule: PROJECTS_MODULE_ID } as const;

const recurrenceSchema = z.object({
  preset: z.string().min(1).nullable().optional(),
  mode: z.string().optional(),
  rule: z.unknown(),
});
const ruleKindSchema = z.object({ kind: z.string().min(1) });

function text(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `YYYY-MM-DD` of a stored calendar date; a date stored with a time keeps its date part. */
function calendarDate(properties: Record<string, unknown>, key: string): string | null {
  const value = text(properties, key);
  return value !== null && /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(value) ? value.slice(0, 10) : null;
}

/** `HH:mm` of a stored wall-clock time (`9:00` is padded); anything else is not a time. */
function wallClock(properties: Record<string, unknown>, key: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text(properties, key) ?? "");
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : null;
}

/** The start time alone is a `time`; with an end time it is a `timeRange` written `HH:mm-HH:mm`. An end time alone is not shown. */
function timeParts(properties: Record<string, unknown>): SearchSubtitlePart[] {
  const from = wallClock(properties, "timeFrom");
  if (from === null) return [];
  const to = wallClock(properties, "timeTo");
  return [to === null ? { kind: "time", value: from } : { kind: "timeRange", value: `${from}-${to}` }];
}

/**
 * The stored key of a task's recurrence: its preset when it was set from one, otherwise the kind of a fixed rule, or
 * `floating` for a rule that repeats every n days, weeks or months. A value that is not a recurrence shows nothing.
 */
function recurrenceKey(properties: Record<string, unknown>): string | null {
  const parsed = recurrenceSchema.safeParse(properties.recurrence);
  if (!parsed.success) return null;
  if (parsed.data.preset) return parsed.data.preset;
  if (parsed.data.mode === "floating") return "floating";
  const rule = ruleKindSchema.safeParse(parsed.data.rule);
  return rule.success ? rule.data.kind : null;
}

/** The first line of the stored phone numbers, as stored: one number per line, no reformatting. */
function firstPhone(properties: Record<string, unknown>): string | null {
  const value = properties.phones;
  if (typeof value !== "string") return null;
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? null
  );
}

function linkedParts(
  kind: LinkSpec["kind"],
  linked: readonly { id: string; title: string | null }[],
  limit: number,
): SearchSubtitlePart[] {
  return linked
    .filter((target): target is { id: string; title: string } => target.title !== null && target.title !== "")
    .slice(0, limit)
    .map((target) => ({ kind, value: target.title, itemId: target.id }));
}

/** Groups the linked items of each source under the source's property key, in the order the statement returned them. */
async function loadLinkedItems(
  client: PoolClient,
  sources: readonly SubtitleSource[],
  visibleDatabaseIds: readonly string[],
  unreadableDatabaseIds: ReadonlySet<string>,
): Promise<Map<string, { id: string; title: string | null }[]>> {
  const specs = LINK_SPECS.filter((spec) => sources.some((source) => source.moduleId === spec.sourceModule));
  const linked = new Map<string, { id: string; title: string | null }[]>();
  if (specs.length === 0) return linked;
  const { rows } = await client.query<LinkedItemDbRow>(
    `SELECT source.id AS source_id, source_property.key AS property_key, target.id AS target_id,
       (SELECT target.properties ->> title_property.key FROM properties title_property
         WHERE title_property.database_id = target.database_id AND title_property.type = 'title'
         ORDER BY title_property.id LIMIT 1) AS title
     ${LINKED_ITEMS_FROM_SQL}
     ORDER BY source.id, source_property.key, title, target.id`,
    [
      sources.map((source) => source.id),
      visibleDatabaseIds,
      [...unreadableDatabaseIds],
      specs.map((spec) => spec.sourceModule),
      specs.map((spec) => spec.key),
      specs.map((spec) => spec.targetModule),
      [...new Set(sources.map((source) => source.databaseId))],
    ],
  );
  for (const row of rows) {
    const mapKey = `${row.source_id}:${row.property_key}`;
    const list = linked.get(mapKey) ?? [];
    list.push({ id: row.target_id, title: row.title });
    linked.set(mapKey, list);
  }
  return linked;
}

/** The number of live, user-visible projects of each area: a system project is never searched and is not counted. */
async function countAreaProjects(
  client: PoolClient,
  areas: readonly SubtitleSource[],
  visibleDatabaseIds: readonly string[],
  unreadableDatabaseIds: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (areas.length === 0) return counts;
  const { rows } = await client.query<ProjectCountDbRow>(
    `SELECT source.id AS source_id, count(DISTINCT target.id)::int AS total
     ${LINKED_ITEMS_FROM_SQL}
       AND target.properties ->> 'systemActive' IS DISTINCT FROM 'true'
     GROUP BY source.id`,
    [
      areas.map((area) => area.id),
      visibleDatabaseIds,
      [...unreadableDatabaseIds],
      [COUNTED_LINK.sourceModule],
      [COUNTED_LINK.key],
      [COUNTED_LINK.targetModule],
      [...new Set(areas.map((area) => area.databaseId))],
    ],
  );
  for (const row of rows) counts.set(row.source_id, row.total);
  return counts;
}

/**
 * The `subtitleParts` of every source, by item id, read in the caller's transaction with a constant number of
 * statements however many results there are. A source whose module has no subtitle (a journal day) gets none.
 * Per module, in this order:
 * - tasks: date, time or timeRange, recurrence, project;
 * - events: date, time or timeRange, place, up to five people;
 * - projects: area, status;
 * - areas: count of their projects;
 * - people: relationship, project, phone; companies: the `relationship` marker `company` (the closed set of kinds has
 *   no company kind and a company has no relationship of its own, so the marker is the stored key `company`);
 * - files: project, date.
 * A linked item is shown with its title and `itemId`; the first by title when several are linked and the module shows
 * one. `visibleDatabaseIds` is the list of the tenant's databases (it lets the statement prune item partitions) and
 * `unreadableDatabaseIds` the databases an agent actor cannot read, whose items are never shown as links.
 */
export async function buildSubtitleParts(
  client: PoolClient,
  sources: readonly SubtitleSource[],
  visibleDatabaseIds: readonly string[],
  unreadableDatabaseIds: ReadonlySet<string>,
): Promise<Map<string, SearchSubtitlePart[]>> {
  const linked = await loadLinkedItems(client, sources, visibleDatabaseIds, unreadableDatabaseIds);
  const projectCounts = await countAreaProjects(
    client,
    sources.filter((source) => source.moduleId === AREAS_MODULE_ID),
    visibleDatabaseIds,
    unreadableDatabaseIds,
  );
  const linkedOf = (source: SubtitleSource, kind: LinkSpec["kind"]): SearchSubtitlePart[] => {
    const spec = LINK_SPECS.find((candidate) => candidate.sourceModule === source.moduleId && candidate.kind === kind);
    if (spec === undefined) return [];
    return linkedParts(kind, linked.get(`${source.id}:${spec.key}`) ?? [], spec.limit);
  };
  const result = new Map<string, SearchSubtitlePart[]>();
  for (const source of sources) {
    const { properties } = source;
    const date = calendarDate(properties, "date");
    const dateParts: SearchSubtitlePart[] = date === null ? [] : [{ kind: "date", value: date }];
    const parts: SearchSubtitlePart[] = [];
    switch (source.moduleId) {
      case TASKS_MODULE_ID: {
        const recurrence = recurrenceKey(properties);
        parts.push(
          ...dateParts,
          ...timeParts(properties),
          ...(recurrence === null ? [] : [{ kind: "recurrence" as const, value: recurrence }]),
          ...linkedOf(source, "project"),
        );
        break;
      }
      case EVENTS_MODULE_ID: {
        const place = text(properties, "place");
        parts.push(
          ...dateParts,
          ...timeParts(properties),
          ...(place === null ? [] : [{ kind: "place" as const, value: place }]),
          ...linkedOf(source, "people"),
        );
        break;
      }
      case PROJECTS_MODULE_ID: {
        const status = text(properties, "status");
        parts.push(
          ...linkedOf(source, "area"),
          ...(status === null ? [] : [{ kind: "status" as const, value: status }]),
        );
        break;
      }
      case AREAS_MODULE_ID:
        parts.push({ kind: "count", value: String(projectCounts.get(source.id) ?? 0) });
        break;
      case PEOPLE_MODULE_ID: {
        const relationship = text(properties, "relationship");
        const phone = firstPhone(properties);
        parts.push(
          ...(relationship === null ? [] : [{ kind: "relationship" as const, value: relationship }]),
          ...linkedOf(source, "project"),
          ...(phone === null ? [] : [{ kind: "phone" as const, value: phone }]),
        );
        break;
      }
      case COMPANIES_MODULE_ID:
        parts.push({ kind: "relationship", value: "company" });
        break;
      case FILES_MODULE_ID:
        parts.push(...linkedOf(source, "project"), ...dateParts);
        break;
      default:
        break;
    }
    result.set(source.id, parts);
  }
  return result;
}
