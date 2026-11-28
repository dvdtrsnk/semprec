import type { PoolClient } from "pg";
import { z } from "zod";
import type { SearchSubtitlePart } from "@alldots/shared";
import {
  COMPANIES_MODULE_ID,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";

// The structured subtitle of a search result. Not localised: the client composes the text from kinds and canonical
// values, because relative words depend on the clock and time zone.

export interface SubtitleSource {
  id: string;
  databaseId: string;
  moduleId: string;
  properties: Record<string, unknown>;
}

/** `limit` is the most linked items shown. */
interface LinkSpec {
  sourceModule: string;
  key: string;
  targetModule: string;
  kind: "project" | "people";
  limit: number;
}

/** The full list is on the event itself. */
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
  { sourceModule: PEOPLE_MODULE_ID, key: "projects", targetModule: PROJECTS_MODULE_ID, kind: "project", limit: 1 },
  { sourceModule: FILES_MODULE_ID, key: "projects", targetModule: PROJECTS_MODULE_ID, kind: "project", limit: 1 },
];

/**
 * Live items linked through `$4..$6` (source module, property key, target module as parallel arrays), from the
 * source's side. Targets in archived or agent-unreadable (`$3`) databases are left out. Every value is bound.
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

/** A date stored with a time keeps its date part. */
function calendarDate(properties: Record<string, unknown>, key: string): string | null {
  const value = text(properties, key);
  return value !== null && /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(value) ? value.slice(0, 10) : null;
}

/** `9:00` is padded; anything else is not a time. */
function wallClock(properties: Record<string, unknown>, key: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text(properties, key) ?? "");
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : null;
}

/** An end time alone is not shown. */
function timeParts(properties: Record<string, unknown>): SearchSubtitlePart[] {
  const from = wallClock(properties, "timeFrom");
  if (from === null) return [];
  const to = wallClock(properties, "timeTo");
  return [to === null ? { kind: "time", value: from } : { kind: "timeRange", value: `${from}-${to}` }];
}

/** The preset when set from one, else the fixed rule's kind, or `floating` for every-n rules. */
function recurrenceKey(properties: Record<string, unknown>): string | null {
  const parsed = recurrenceSchema.safeParse(properties.recurrence);
  if (!parsed.success) return null;
  if (parsed.data.preset) return parsed.data.preset;
  if (parsed.data.mode === "floating") return "floating";
  const rule = ruleKindSchema.safeParse(parsed.data.rule);
  return rule.success ? rule.data.kind : null;
}

/** One number per line, no reformatting. */
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

/**
 * The `subtitleParts` of every source by item id, with a constant number of statements however many results. A
 * company gets the `relationship` marker `company`, since the closed kind set has no company kind. When a module
 * shows one linked item, it is the first by title. `visibleDatabaseIds` confines linked items to the tenant's
 * databases; items of `unreadableDatabaseIds` are never shown as links.
 */
export async function buildSubtitleParts(
  client: PoolClient,
  sources: readonly SubtitleSource[],
  visibleDatabaseIds: readonly string[],
  unreadableDatabaseIds: ReadonlySet<string>,
): Promise<Map<string, SearchSubtitlePart[]>> {
  const linked = await loadLinkedItems(client, sources, visibleDatabaseIds, unreadableDatabaseIds);
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
        if (status !== null) parts.push({ kind: "status", value: status });
        break;
      }
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
