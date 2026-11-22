// Project mail signals: what marks a mail thread as one project's. A project's own signals (domains, addresses,
// keywords in `project_mail_signals`) and the addresses of its people count. A thread matches when one of its counted
// messages (not a draft, not only in Junk or Trash) has a sender or recipient that is one of the addresses, or at one
// of the domains or a subdomain of one, or when its search text matches a keyword (`mailSignalKeywords.ts`). The
// tenant's own mailbox addresses never match, and a freemail domain is no domain signal.
import type { PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById, getItemsByIds, lockItemForShare } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItems } from "../chokePoint/relationsStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { draftAddress } from "./mailDraftFields.js";
import { keywordTerms, keywordTsQuery } from "./mailSignalKeywords.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import type { MailSignalSet } from "./projectMailSignalsStore.js";
import { FREEMAIL_DOMAINS, webHost } from "./threadLinkRules.js";

export const MAX_SIGNAL_DOMAINS = 50;
export const MAX_SIGNAL_ADDRESSES = 100;
export const MAX_SIGNAL_KEYWORDS = 50;
const MAX_DOMAIN_INPUT_LENGTH = 2048;
const MAX_KEYWORD_LENGTH = 100;

export const EMPTY_MAIL_SIGNALS: MailSignalSet = Object.freeze({ domains: [], addresses: [], keywords: [] });

function invalid(field: keyof MailSignalSet, message: string): ValidationError {
  return new ValidationError(message, { field });
}

function stringList(value: unknown, field: keyof MailSignalSet, max: number): string[] {
  if (value === undefined) return [];
  const parsed = z.array(z.string()).max(max).safeParse(value);
  if (!parsed.success) throw invalid(field, `'${field}' must be an array of at most ${max} strings`);
  return parsed.data;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Validates a signal set from a request and normalizes it: a domain may be given as a URL or a bare host and is kept
 * as its lower-case host without `www.`, it needs a dot; an address is trimmed and lower-cased; a keyword is trimmed,
 * its inner whitespace collapsed, and it needs a letter or digit. Duplicates go (keywords compared case-insensitively).
 * Each list is optional and defaults to empty; another key is a 400 naming it.
 */
export function parseMailSignalSet(value: unknown): MailSignalSet {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ValidationError("The signals must be a JSON object", { field: "signals" });
  const unknownKey = Object.keys(value).find((key) => key !== "domains" && key !== "addresses" && key !== "keywords");
  if (unknownKey !== undefined) throw new ValidationError("Unexpected signals field", { field: unknownKey });
  const record: { domains?: unknown; addresses?: unknown; keywords?: unknown } = value;

  const domains = stringList(record.domains, "domains", MAX_SIGNAL_DOMAINS).map((raw) => {
    const host = raw.length <= MAX_DOMAIN_INPUT_LENGTH ? webHost(raw) : null;
    if (host === null || !host.includes(".") || host.length > 253)
      throw invalid("domains", "'domains' must hold domain names");
    return host;
  });

  const addresses = stringList(record.addresses, "addresses", MAX_SIGNAL_ADDRESSES).map((raw) => {
    const parsed = draftAddress.safeParse(raw);
    if (!parsed.success) throw invalid("addresses", "'addresses' must hold e-mail addresses");
    return normalizeEmailAddress(parsed.data);
  });

  const seenKeywords = new Set<string>();
  const keywords = stringList(record.keywords, "keywords", MAX_SIGNAL_KEYWORDS).flatMap((raw) => {
    const keyword = raw.trim().replace(/\s+/gu, " ");
    if (keyword.length > MAX_KEYWORD_LENGTH || keywordTerms(keyword).length === 0)
      throw invalid("keywords", `'keywords' must hold words of at most ${MAX_KEYWORD_LENGTH} characters`);
    const folded = keyword.toLocaleLowerCase("cs");
    if (seenKeywords.has(folded)) return [];
    seenKeywords.add(folded);
    return [keyword];
  });

  return { domains: unique(domains), addresses: unique(addresses), keywords };
}

/** 404 for an id that names no live Projects item of the tenant: unknown, trashed and foreign ids alike. */
export async function requireLiveProject(client: PoolClient, projectItemId: string, lock: boolean): Promise<void> {
  const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  if (!projects) throw new Error("The Projects database is not seeded");
  if (lock) await lockItemForShare(client, projects.id, projectItemId);
  const project = await getItemById(client, projects.id, projectItemId);
  if (!project || project.deletedAt) throw new NotFoundError("Project not found");
}

export interface PersonMailAddress {
  personId: string;
  name: string;
  address: string;
}

const personAddressRow = z.object({ item_id: z.uuid(), email: z.string() });

/** The indexed addresses of each project's live people, ordered by address; a project without any is absent. */
export async function listProjectPeopleAddresses(
  client: PoolClient,
  projectItemIds: readonly string[],
): Promise<Map<string, PersonMailAddress[]>> {
  const result = new Map<string, PersonMailAddress[]>();
  if (projectItemIds.length === 0) return result;
  const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  const property = projects ? await getPropertyByKey(client, projects.id, "people") : null;
  const definition = property ? await getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!property || !definition) throw new Error("Projects.people is not seeded as a relation");
  const projectIsA = definition.propertyIdA === property.id;
  const wanted = new Set(projectItemIds);
  const peopleOf = new Map<string, Set<string>>();
  for (const edge of await listRelationsForItems(client, definition.id, [...wanted])) {
    const [projectId, personId] = projectIsA ? [edge.itemA, edge.itemB] : [edge.itemB, edge.itemA];
    if (!wanted.has(projectId)) continue;
    const projectsOfPerson = peopleOf.get(personId) ?? new Set<string>();
    projectsOfPerson.add(projectId);
    peopleOf.set(personId, projectsOfPerson);
  }
  const people = await getItemsByIds(client, [...peopleOf.keys()]);
  if (people.length === 0) return result;
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT item_id, email FROM person_email_index
      WHERE tenant_id = app_tenant_default() AND item_id = ANY($1::uuid[]) ORDER BY email`,
    [people.map((person) => person.id)],
  );
  const names = new Map(
    people.map((person) => [person.id, typeof person.properties.name === "string" ? person.properties.name : ""]),
  );
  for (const raw of rows) {
    const row = personAddressRow.parse(raw);
    for (const projectId of peopleOf.get(row.item_id) ?? []) {
      const list = result.get(projectId) ?? [];
      list.push({ personId: row.item_id, name: names.get(row.item_id) ?? "", address: row.email });
      result.set(projectId, list);
    }
  }
  return result;
}

/** What the match query reads of one project; `null` from `signalCriteria` when nothing could match. */
interface SignalCriteria {
  projectId: string;
  addresses: string[];
  domains: string[];
  query: string | null;
}

function signalCriteria(
  projectId: string,
  signals: MailSignalSet,
  people: readonly PersonMailAddress[],
): SignalCriteria | null {
  const addresses = unique([...signals.addresses, ...people.map((person) => person.address)]);
  const domains = signals.domains.filter((domain) => !FREEMAIL_DOMAINS.has(domain));
  const query = keywordTsQuery(signals.keywords);
  if (addresses.length === 0 && domains.length === 0 && query === null) return null;
  return { projectId, addresses, domains, query };
}

/**
 * The matches of every criteria set over the counted messages. `$1` is a thread id or NULL (one thread, or all of
 * them), `$2` the criteria as JSON, `$3` NULL or the thread ids to look at. `matched_thread` has one row per project
 * and live thread with the thread's latest activity and whether it is open: no `Threads.project` edge and no project
 * value link in any state, the condition triage and the assignment write under.
 */
const SIGNAL_MATCH_CTES = `
WITH ${mailThreadCopyCtes(1)}, signal AS (
  SELECT s.project_id, s.addresses, s.domains, s.query
  FROM jsonb_to_recordset($2::jsonb) AS s(project_id uuid, addresses text[], domains text[], query text)
), counted AS (
  SELECT c.thread_id, c.item_id, c.envelope FROM copies c
  WHERE c.has_non_junk AND ($3::uuid[] IS NULL OR c.thread_id = ANY($3::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM items f WHERE f.tenant_id = app_tenant_default() AND f.id = ANY(c.folder_ids)
      AND f.properties->>'specialPurpose' = 'drafts')
    AND NOT EXISTS (SELECT 1 FROM mail_drafts d
      WHERE d.tenant_id = app_tenant_default() AND d.email_item_id = c.item_id AND d.sent_at IS NULL)
), counted_address AS (
  SELECT c.item_id, a.address, split_part(a.address, '@', 2) AS domain
  FROM counted c CROSS JOIN LATERAL (
    SELECT DISTINCT lower(btrim(entry.value->>'address', E' \\t\\n\\r')) AS address
    FROM jsonb_array_elements(
      jsonb_build_array(c.envelope->'from') ||
      CASE WHEN jsonb_typeof(c.envelope->'to') = 'array' THEN c.envelope->'to' ELSE '[]'::jsonb END ||
      CASE WHEN jsonb_typeof(c.envelope->'cc') = 'array' THEN c.envelope->'cc' ELSE '[]'::jsonb END
    ) entry(value)
    WHERE jsonb_typeof(entry.value) = 'object' AND jsonb_typeof(entry.value->'address') = 'string'
  ) a
  WHERE a.address <> '' AND NOT EXISTS (SELECT 1 FROM own_addresses o WHERE o.address = a.address)
), signal_match AS (
  SELECT DISTINCT s.project_id, c.thread_id
  FROM signal s CROSS JOIN counted c
  WHERE EXISTS (
      SELECT 1 FROM counted_address a
      WHERE a.item_id = c.item_id AND (a.address = ANY(s.addresses) OR EXISTS (
        SELECT 1 FROM unnest(s.domains) d(host)
        WHERE a.domain = d.host OR right(a.domain, length(d.host) + 1) = '.' || d.host)))
    OR (s.query IS NOT NULL AND EXISTS (
      SELECT 1 FROM item_search_index si
      WHERE si.tenant_id = app_tenant_default() AND si.database_id = (SELECT emails FROM schema_ids)
        AND si.item_id = c.item_id AND si.search_vector @@ to_tsquery('czech_simple', s.query)))
), project_definition AS (
  SELECT rd.id FROM properties p
  JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT threads FROM schema_ids) AND p.key = 'project'
), matched_thread AS (
  SELECT sm.project_id, sm.thread_id, mt.item_id AS thread_item_id,
    (SELECT max(c.activity) FROM copies c WHERE c.thread_id = sm.thread_id) AS activity,
    NOT EXISTS (
      SELECT 1 FROM project_definition pd JOIN item_relations r
        ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = pd.id
       AND (r.item_a = mt.item_id OR r.item_b = mt.item_id))
    AND NOT EXISTS (
      SELECT 1 FROM value_links vl
      WHERE vl.tenant_id = app_tenant_default() AND vl.item_id = mt.item_id AND vl.property_key = 'project') AS open
  FROM signal_match sm
  JOIN mail_threads mt ON mt.tenant_id = app_tenant_default() AND mt.id = sm.thread_id
  JOIN items ti ON ti.tenant_id = mt.tenant_id AND ti.id = mt.item_id
    AND ti.database_id = (SELECT threads FROM schema_ids) AND ti.deleted_at IS NULL
)`;

function criteriaJson(criteria: readonly SignalCriteria[]): string {
  return JSON.stringify(
    criteria.map((entry) => ({
      project_id: entry.projectId,
      addresses: entry.addresses,
      domains: entry.domains,
      query: entry.query,
    })),
  );
}

export interface MailSignalPreviewMatches {
  /** Matching open threads. */
  total: number;
  /** Matching threads that have a project, or a project link. */
  alreadyAssigned: number;
  /** The newest `limit` matching open threads, newest first. */
  newestThreadIds: string[];
}

const previewRow = z.object({ total: z.number().int(), assigned: z.number().int(), newest: z.array(z.uuid()) });

/** Over every thread of the tenant. */
export async function previewMailSignalMatches(
  client: PoolClient,
  projectId: string,
  signals: MailSignalSet,
  people: readonly PersonMailAddress[],
  limit: number,
): Promise<MailSignalPreviewMatches> {
  const criteria = signalCriteria(projectId, signals, people);
  if (criteria === null) return { total: 0, alreadyAssigned: 0, newestThreadIds: [] };
  const { rows } = await client.query<Record<string, unknown>>(
    `${SIGNAL_MATCH_CTES}
SELECT count(*) FILTER (WHERE open)::int AS total, count(*) FILTER (WHERE NOT open)::int AS assigned,
  COALESCE((array_agg(thread_id ORDER BY activity DESC NULLS LAST, thread_id DESC) FILTER (WHERE open))[1:$4::int],
    ARRAY[]::uuid[]) AS newest
FROM matched_thread`,
    [null, criteriaJson([criteria]), null, limit],
  );
  const row = previewRow.parse(rows[0]);
  return { total: row.total, alreadyAssigned: row.assigned, newestThreadIds: row.newest };
}

export interface MatchedMailThread {
  threadId: string;
  threadItemId: string;
  open: boolean;
}

const matchedRow = z.object({ thread_id: z.uuid(), thread_item_id: z.uuid(), open: z.boolean() });

/** Those of `threadIds` the signals match, in Threads item id order. */
export async function mailThreadsMatchingSignals(
  client: PoolClient,
  projectId: string,
  signals: MailSignalSet,
  people: readonly PersonMailAddress[],
  threadIds: readonly string[],
): Promise<MatchedMailThread[]> {
  const criteria = signalCriteria(projectId, signals, people);
  if (criteria === null || threadIds.length === 0) return [];
  const { rows } = await client.query<Record<string, unknown>>(
    `${SIGNAL_MATCH_CTES}
SELECT thread_id, thread_item_id, open FROM matched_thread ORDER BY thread_item_id`,
    [null, criteriaJson([criteria]), threadIds],
  );
  return rows.map((raw) => {
    const row = matchedRow.parse(raw);
    return { threadId: row.thread_id, threadItemId: row.thread_item_id, open: row.open };
  });
}
