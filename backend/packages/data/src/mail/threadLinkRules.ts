import type { PoolClient } from "pg";
import { z } from "zod";
import { getDatabase, getDatabaseByKey } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { listValueLinksBySourceItem } from "../chokePoint/valueLinksStore.js";
import type { LinkRuleResolution, LinkRuleResolver } from "../valueLinks/linkResolver.js";
import { enqueueLinkPropagation } from "../valueLinks/linkPropagation.js";
import { COMPANIES_MODULE_ID, PEOPLE_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { lookupPersonIdByEmail } from "./personEmailIndexStore.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";

/** Keys of the two link rules of the Threads database (`mailModuleManifest.ts`). */
export const THREAD_COMPANY_LINK_RULE_KEY = "threadCompanyFromSender";
export const THREAD_PROJECT_LINK_RULE_KEY = "threadProjectFromCompany";

/**
 * Domains of public mailbox providers. A sender on one of them says nothing about a company, so the company
 * rule never matches them. An address's domain is compared as a whole, so a subdomain of a listed name is not
 * a freemail domain.
 */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "seznam.cz",
  "email.cz",
  "centrum.cz",
  "post.cz",
  "atlas.cz",
  "volny.cz",
  "proton.me",
  "protonmail.com",
]);

/** The statuses of a project that count as active for the project rule. */
const ACTIVE_PROJECT_STATUSES: ReadonlySet<string> = new Set(["inProgress", "longTerm"]);

const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * The host of a `Companies.web` value, lowercase and without a leading `www.`: the value may be a URL with a
 * scheme, a path or a port, or a bare host. `null` for a value that holds no host.
 */
export function webHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  const host = hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return HOST_PATTERN.test(host) ? host : null;
}

/** Whether a sender's `domain` belongs to the company host `host`: it is equal to it or a subdomain of it. */
export function domainBelongsToHost(domain: string, host: string): boolean {
  return domain === host || domain.endsWith(`.${host}`);
}

/** The lowercase domain of an address, or `null` for text with no `@` or an empty domain. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  const domain =
    at < 0
      ? ""
      : address
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return domain === "" ? null : domain.replace(/^www\./, "");
}

const NO_RESOLUTION: LinkRuleResolution = { values: [], sources: [] };

const idRows = z.array(z.object({ item_id: z.uuid() }));

/** The Threads item's `mail_threads` id, or `null` when the item is bound to no thread. */
export async function mailThreadIdOfItem(client: PoolClient, threadItemId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM mail_threads WHERE item_id = $1`, [threadItemId]);
  return z.array(z.object({ id: z.uuid() })).parse(rows)[0]?.id ?? null;
}

export interface FirstInboundMessage {
  /** The Emails item of the message. */
  itemId: string;
  /** The lowercase address of its author, or `null` when the message has none. */
  senderAddress: string | null;
}

const firstInboundRow = z.object({ item_id: z.uuid(), address: z.string().nullable() });

/**
 * The first inbound message of a thread: of its live copies, those that are none of the tenant's own mail, are in
 * no Sent folder and in no Drafts folder (the thread actions' `incoming`, `mailThreadActions.ts`), the one with
 * the earliest activity, then the lowest item id. `null` when the thread has none.
 */
export async function firstInboundMessage(client: PoolClient, threadId: string): Promise<FirstInboundMessage | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `
WITH ${mailThreadCopyCtes(1)}
SELECT c.item_id, lower(btrim(c.envelope->'from'->>'address', E' \\t\\n\\r')) AS address
FROM copies c
WHERE NOT c.own AND NOT c.has_sent AND NOT EXISTS (
  SELECT 1 FROM items f
  WHERE f.tenant_id = app_tenant_default() AND f.id = ANY(c.folder_ids) AND f.properties->>'specialPurpose' = 'drafts'
)
ORDER BY c.activity ASC NULLS LAST, c.item_id ASC
LIMIT 1
`,
    [threadId],
  );
  const row = rows[0] ? firstInboundRow.parse(rows[0]) : null;
  return row ? { itemId: row.item_id, senderAddress: row.address === "" ? null : row.address } : null;
}

/** The live items related to `itemId` through the relation property `propertyKey` of database `databaseKey`. */
async function relatedLiveItems(client: PoolClient, databaseKey: string, propertyKey: string, itemId: string) {
  const database = await getDatabaseByKey(client, databaseKey);
  const property = database ? await getPropertyByKey(client, database.id, propertyKey) : null;
  const definition = property ? await getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!definition) return [];
  const edges = await listRelationsForItem(client, definition.id, itemId);
  return getItemsByIds(
    client,
    edges.map((edge) => otherSide(edge, itemId)),
  );
}

/** The companies of the tenant with a web host, as `{ id, host }`. */
async function companiesWithHost(client: PoolClient): Promise<Array<{ id: string; host: string }>> {
  const database = await getDatabaseByKey(client, COMPANIES_MODULE_ID);
  if (!database) return [];
  const { rows } = await client.query<{ item_id: string; web: string }>(
    `SELECT id AS item_id, properties->>'web' AS web FROM items
     WHERE tenant_id = app_tenant_default() AND database_id = $1 AND deleted_at IS NULL
       AND COALESCE(properties->>'web', '') <> ''
     ORDER BY id`,
    [database.id],
  );
  return z
    .array(z.object({ item_id: z.uuid(), web: z.string() }))
    .parse(rows)
    .flatMap((row) => {
      const host = webHost(row.web);
      return host === null ? [] : [{ id: row.item_id, host }];
    });
}

function onlyOne<T>(values: T[]): T | null {
  return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * The company a thread inherits from its sender (the author of its first inbound message):
 * - a freemail domain, or no sender, gives none;
 * - a sender known in `person_email_index` gives the one company of that person's `People.companies` whose web
 *   host matches the sender's domain; the source is the person (`companies`);
 * - an unknown sender gives the one company of the tenant whose web host matches; the source is the sender
 *   domain (`web`).
 * No match and several matches give none.
 */
async function resolveThreadCompany(client: PoolClient, threadItemId: string): Promise<LinkRuleResolution> {
  const threadId = await mailThreadIdOfItem(client, threadItemId);
  const first = threadId ? await firstInboundMessage(client, threadId) : null;
  const domain = first?.senderAddress ? addressDomain(first.senderAddress) : null;
  if (!first?.senderAddress || domain === null || FREEMAIL_DOMAINS.has(domain)) return NO_RESOLUTION;
  const personId = await lookupPersonIdByEmail(client, first.senderAddress);
  const [person] = personId ? await getItemsByIds(client, [personId]) : [];
  if (person) {
    const companies = await relatedLiveItems(client, PEOPLE_MODULE_ID, "companies", person.id);
    const match = onlyOne(
      companies.filter((company) => {
        const host = webHost(company.properties.web);
        return host !== null && domainBelongsToHost(domain, host);
      }),
    );
    return match
      ? { values: [match.id], sources: [{ kind: "item", sourceItemId: person.id, sourcePropertyKey: "companies" }] }
      : NO_RESOLUTION;
  }
  const match = onlyOne(
    (await companiesWithHost(client)).filter((company) => domainBelongsToHost(domain, company.host)),
  );
  return match
    ? { values: [match.id], sources: [{ kind: "senderDomain", domain, sourcePropertyKey: "web" }] }
    : NO_RESOLUTION;
}

/**
 * The project a thread inherits from its company, whether that company was inherited or entered by the user: the
 * one project of the company's `Companies.projects` whose status is `inProgress` or `longTerm`, for a thread with
 * exactly one company. The source is the company (`projects`). No company, no active project and several
 * active projects give none.
 */
async function resolveThreadProject(client: PoolClient, threadItemId: string): Promise<LinkRuleResolution> {
  const company = onlyOne(await relatedLiveItems(client, THREADS_MODULE_ID, "company", threadItemId));
  if (!company) return NO_RESOLUTION;
  const project = onlyOne(
    (await relatedLiveItems(client, COMPANIES_MODULE_ID, "projects", company.id)).filter((candidate) => {
      const status = candidate.properties.status;
      return typeof status === "string" && ACTIVE_PROJECT_STATUSES.has(status);
    }),
  );
  return project
    ? { values: [project.id], sources: [{ kind: "item", sourceItemId: company.id, sourcePropertyKey: "projects" }] }
    : NO_RESOLUTION;
}

/** The key of the database an item belongs to, `null` for a missing or trashed item. */
async function databaseKeyOfItem(client: PoolClient, itemId: string): Promise<string | null> {
  const [item] = await getItemsByIds(client, [itemId]);
  return item ? ((await getDatabase(client, item.databaseId))?.key ?? null) : null;
}

/** Ids after `afterId` in ascending order, without duplicates, at most `limit`. */
function pageOf(ids: string[], afterId: string | null, limit: number): string[] {
  return [...new Set(ids)]
    .filter((id) => afterId === null || id > afterId)
    .sort()
    .slice(0, limit);
}

/** The id of the relation definition of `Threads.company`, `null` when the tenant has no Threads database. */
async function threadCompanyDefinitionId(client: PoolClient): Promise<string | null> {
  const database = await getDatabaseByKey(client, THREADS_MODULE_ID);
  const property = database ? await getPropertyByKey(client, database.id, "company") : null;
  return property ? ((await getRelationDefinitionByPropertyId(client, property.id))?.id ?? null) : null;
}

/**
 * The Threads items bound to a thread that has a message matching `condition`, after `afterId`, in id order. With
 * `withoutCompanyDefinitionId` (the definition of `Threads.company`) only threads that hold no company are listed.
 */
async function threadItemIdsBySender(
  client: PoolClient,
  condition: "address" | "host",
  values: string[],
  afterId: string | null,
  limit: number,
  withoutCompanyDefinitionId: string | null = null,
): Promise<string[]> {
  if (values.length === 0) return [];
  // The condition is one of two fixed fragments selected by the typed `condition`; values are bound.
  const match =
    condition === "address"
      ? `lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r')) = ANY($1::text[])`
      : `EXISTS (SELECT 1 FROM unnest($1::text[]) h(host)
           WHERE split_part(lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r')), '@', 2) = h.host
              OR right(split_part(lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r')), '@', 2), length(h.host) + 1) = '.' || h.host)`;
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT DISTINCT t.item_id FROM mail_message_meta m
     JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
     WHERE m.tenant_id = app_tenant_default() AND t.item_id IS NOT NULL AND ${match}
       AND ($2::uuid IS NULL OR t.item_id > $2)
       AND ($4::uuid IS NULL OR NOT EXISTS (
         SELECT 1 FROM item_relations r
         WHERE r.tenant_id = app_tenant_default() AND r.relation_definition_id = $4
           AND (r.item_a = t.item_id OR r.item_b = t.item_id)))
     ORDER BY t.item_id LIMIT $3`,
    [values, afterId, limit, withoutCompanyDefinitionId],
  );
  return idRows.parse(rows).map((row) => row.item_id);
}

/** The threads that hold `companyId` as their company: the other side of its edges on the Threads `company` relation. */
async function threadItemIdsOfCompany(client: PoolClient, companyId: string): Promise<string[]> {
  return (await relatedLiveItems(client, THREADS_MODULE_ID, "company", companyId)).map((thread) => thread.id);
}

async function personAddresses(client: PoolClient, personId: string): Promise<string[]> {
  const { rows } = await client.query<{ email: string }>(`SELECT email FROM person_email_index WHERE item_id = $1`, [
    personId,
  ]);
  return z
    .array(z.object({ email: z.string() }))
    .parse(rows)
    .map((row) => row.email);
}

/**
 * The company rule's resolver. A change of a person's `companies` affects the threads that person wrote and the
 * threads whose company link has the person as its source. A change of a company's `web` (or the creation or
 * restore of a company) affects the threads that hold the company, the threads written from a domain of the
 * company's current host and the threads that hold no company and were written from a domain of another
 * company's host: the old host of the changed company is not known here, and a thread that matched it together
 * with that other company has no company, so it is evaluated again now that the other company may be alone.
 */
export const threadCompanyLinkResolver: LinkRuleResolver = {
  inputs: {
    edges: [{ databaseKey: PEOPLE_MODULE_ID, relationKey: "companies" }],
    properties: [{ databaseKey: COMPANIES_MODULE_ID, propertyKey: "web", onAppear: true }],
  },
  resolve: resolveThreadCompany,
  async affectedItemIds(client, changedItemId, afterId, limit) {
    const databaseKey = await databaseKeyOfItem(client, changedItemId);
    if (databaseKey === THREADS_MODULE_ID) return pageOf([changedItemId], afterId, limit);
    if (databaseKey === PEOPLE_MODULE_ID) {
      const linked = (await listValueLinksBySourceItem(client, changedItemId))
        .filter((link) => link.ruleKey === THREAD_COMPANY_LINK_RULE_KEY)
        .map((link) => link.itemId);
      const written = await threadItemIdsBySender(
        client,
        "address",
        await personAddresses(client, changedItemId),
        afterId,
        limit,
      );
      return pageOf([...linked, ...written], afterId, limit);
    }
    if (databaseKey === COMPANIES_MODULE_ID) {
      const [company] = await getItemsByIds(client, [changedItemId]);
      const host = webHost(company?.properties.web);
      const held = await threadItemIdsOfCompany(client, changedItemId);
      const written = host ? await threadItemIdsBySender(client, "host", [host], afterId, limit) : [];
      const otherHosts = [
        ...new Set((await companiesWithHost(client)).filter((other) => other.id !== changedItemId).map((o) => o.host)),
      ];
      const companyDefinitionId = otherHosts.length > 0 ? await threadCompanyDefinitionId(client) : null;
      const unclaimed = companyDefinitionId
        ? await threadItemIdsBySender(client, "host", otherHosts, afterId, limit, companyDefinitionId)
        : [];
      return pageOf([...held, ...written, ...unclaimed], afterId, limit);
    }
    return [];
  },
};

/**
 * The project rule's resolver. A change of a thread's `company` affects that thread; a change of a company's
 * `projects` affects the threads that hold the company; a change of a project's `status` affects the threads of
 * the companies the project belongs to.
 */
export const threadProjectLinkResolver: LinkRuleResolver = {
  inputs: {
    edges: [
      { databaseKey: THREADS_MODULE_ID, relationKey: "company" },
      { databaseKey: COMPANIES_MODULE_ID, relationKey: "projects" },
    ],
    properties: [{ databaseKey: PROJECTS_MODULE_ID, propertyKey: "status" }],
  },
  resolve: resolveThreadProject,
  async affectedItemIds(client, changedItemId, afterId, limit) {
    const databaseKey = await databaseKeyOfItem(client, changedItemId);
    if (databaseKey === THREADS_MODULE_ID) return pageOf([changedItemId], afterId, limit);
    if (databaseKey === COMPANIES_MODULE_ID)
      return pageOf(await threadItemIdsOfCompany(client, changedItemId), afterId, limit);
    if (databaseKey === PROJECTS_MODULE_ID) {
      const companies = await relatedLiveItems(client, PROJECTS_MODULE_ID, "company", changedItemId);
      const threads: string[] = [];
      for (const company of companies) threads.push(...(await threadItemIdsOfCompany(client, company.id)));
      return pageOf(threads, afterId, limit);
    }
    return [];
  },
};

/**
 * After a new message was ingested and put in its folder: when it is now the first inbound message of its thread,
 * queues the evaluation of both Threads link rules for the thread's item through the propagation entry point, at
 * the budget of a root write, and answers the thread's Threads item id. A message that is not the first inbound one,
 * a thread without an item and an outgoing message queue nothing and answer `null`.
 */
export async function enqueueThreadLinkRulesForFirstInbound(
  client: PoolClient,
  messageItemId: string,
): Promise<string | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
     WHERE m.tenant_id = app_tenant_default() AND m.item_id = $1`,
    [messageItemId],
  );
  const thread = z
    .array(z.object({ id: z.uuid(), item_id: z.uuid().nullable() }))
    .parse(rows)
    .at(0);
  if (!thread?.item_id) return null;
  const first = await firstInboundMessage(client, thread.id);
  if (first?.itemId !== messageItemId) return null;
  for (const ruleKey of [THREAD_COMPANY_LINK_RULE_KEY, THREAD_PROJECT_LINK_RULE_KEY])
    await enqueueLinkPropagation(client, ruleKey, thread.item_id, 1);
  return thread.item_id;
}
