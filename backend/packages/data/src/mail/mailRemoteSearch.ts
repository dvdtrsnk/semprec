import { DatabaseError, type Pool, type PoolClient } from "pg";
import { z } from "zod";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { getDecryptedCredential, type CredentialActorType } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, RateLimitedError, ValidationError } from "../errors.js";
import type { CustomRouteResult, RouteUrl, RouteUser } from "../customRoute.js";
import { requestUrl } from "../customRoute.js";
import { imapConnectionLimitForProvider } from "./imapConnectionLimiter.js";
import type { ImapMailClient } from "./imapMailClient.js";
import { SYNC_MODES, type SyncMode } from "./mailAccountSyncStateStore.js";
import type { MailContentProviders } from "./mailMessageContent.js";
import { resolveMailModuleIds, type MailModuleIds } from "./mailModuleIds.js";
import { hasMailSearchTerms, parseMailSearchTerms, type MailSearchTerms } from "./mailSearchTerms.js";
import { hasInvalidMailSearchDate, listMailThreads } from "./mailThreadListQuery.js";
import { MailReauthorizationRequiredError } from "./providerTypes.js";
import { parseMailSearchQuery, type ParsedMailSearchQuery } from "./search.js";
import { logger } from "./logger.js";

/** Provider hits taken per mailbox; a provider search asks for no more. */
export const MAIL_REMOTE_SEARCH_MAX_HITS = 100;
/** Mailboxes searched at their providers at once. */
export const MAIL_REMOTE_SEARCH_CONCURRENCY = 3;
/** A mailbox whose provider has not answered by then is reported `timeout`. */
export const MAIL_REMOTE_SEARCH_DEADLINE_MS = 15_000;
/** As the thread list's `q`. */
export const MAIL_SEARCH_QUERY_MAX_LENGTH = 1000;

/** Why a mailbox's provider was not searched, or its search did not answer. */
export const MAIL_REMOTE_SEARCH_FAILURE_REASONS = [
  // Mail is switched off for the account; no provider call is made.
  "mailOff",
  // The provider refused the stored sign-in (now or at the last sync), or none is stored.
  "reauthorizationRequired",
  // The provider could not be reached, refused the search or failed it.
  "providerUnreachable",
  // The provider did not answer before the search's deadline.
  "timeout",
] as const;
export type MailRemoteSearchFailureReason = (typeof MAIL_REMOTE_SEARCH_FAILURE_REASONS)[number];

/**
 * IMAP folders searched, in this order. An account with an All Mail folder (Gmail over IMAP, which syncs only its
 * Inbox and All Mail) is searched there alone: it holds the archive and the sent mail, never Trash or Spam. Trash,
 * Junk and Drafts are never searched (what they hold is not what a search looks for, and a Trash hit could only show
 * a thread the list leaves out), nor are the user's own folders, so a search costs a bounded number of SEARCH commands.
 */
const IMAP_SEARCHED_PURPOSES = ["inbox", "archive", "sent"] as const;
const IMAP_ALL_MAIL_PURPOSE = "all";

type ThrottleAttempt = { granted: true } | { granted: false; retryAfterSeconds: number };

export interface MailSearchThrottle {
  /** Checks and counts in the same synchronous step, per user. */
  tryAcquire(action: "mailRemoteSearch", userId: string): ThrottleAttempt;
}

export interface MailSearchRouteDependencies {
  mailContent?: MailContentProviders;
  throttle?: MailSearchThrottle;
}

/** A missing member is deployment misconfiguration: a plain error (generic 500), not a domain error. */
function requireDependency<K extends keyof MailSearchRouteDependencies>(
  dependencies: MailSearchRouteDependencies,
  member: K,
): NonNullable<MailSearchRouteDependencies[K]> {
  const value = dependencies[member];
  if (value === undefined)
    throw new Error(`custom route dependency "${member}" is not configured by the composition root`);
  return value;
}

/** Counts one provider search of the user; a refusal is 429 `rate_limited`. */
export function acquireMailRemoteSearch(dependencies: MailSearchRouteDependencies, userId: string): void {
  const attempt = requireDependency(dependencies, "throttle").tryAcquire("mailRemoteSearch", userId);
  if (!attempt.granted) throw new RateLimitedError(attempt.retryAfterSeconds);
}

/** Whose access the stored IMAP password is read under in `credential_access_log`. */
export interface MailSearchCredentialActor {
  actorType: Extract<CredentialActorType, "user" | "ai_agent">;
  actorId: string;
}

interface ImapSearchFolder {
  folderItemId: string;
  path: string;
  /** The UIDVALIDITY the sync stored for the folder; `null` before its first sync. */
  uidValidity: string | null;
}

interface SearchableMailbox {
  mailboxItemId: string;
  syncMode: SyncMode;
  provider: string | undefined;
  connectionLimit: unknown;
  skipped: MailRemoteSearchFailureReason | null;
  imapFolders: ImapSearchFolder[];
}

const mailboxRow = z.object({
  id: z.uuid(),
  provider: z.string().nullable(),
  connection_limit: z.unknown(),
  sync_mode: z.enum(SYNC_MODES),
  paused: z.boolean(),
  last_failure_kind: z.string().nullable(),
});

const folderRow = z.object({
  id: z.uuid(),
  path: z.string().min(1).max(1024),
  purpose: z.string(),
  uid_validity: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .nullable(),
});

/** The live account `mailboxId` names; an unknown, foreign or trashed one is the 404 of a random id. */
async function requireLiveMailbox(client: PoolClient, ids: MailModuleIds, mailboxId: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id FROM items i
     WHERE i.tenant_id = app_tenant_default() AND i.database_id = $1 AND i.id = $2 AND i.deleted_at IS NULL`,
    [ids.mailboxesDatabaseId, mailboxId],
  );
  if (rows.length === 0) throw new NotFoundError("Mailbox not found");
}

async function readImapSearchFolders(
  client: PoolClient,
  ids: MailModuleIds,
  mailboxItemId: string,
): Promise<ImapSearchFolder[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT f.id, f.properties->>'providerId' AS path, f.properties->>'specialPurpose' AS purpose,
       state.uidvalidity::text AS uid_validity
     FROM properties p
     JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
     JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
       AND (CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END) = $2::uuid
     JOIN items f ON f.tenant_id = p.tenant_id AND f.database_id = $1
       AND f.id = CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END AND f.deleted_at IS NULL
     LEFT JOIN mail_folder_sync_state state ON state.tenant_id = f.tenant_id AND state.item_id = f.id
     WHERE p.tenant_id = app_tenant_default() AND p.database_id = $1 AND p.key = 'mailbox'
       AND f.properties->>'specialPurpose' = ANY($3::text[])
     ORDER BY f.id`,
    [ids.foldersDatabaseId, mailboxItemId, [...IMAP_SEARCHED_PURPOSES, IMAP_ALL_MAIL_PURPOSE]],
  );
  const folders = rows.flatMap((row) => {
    // A folder that does not name a path the server could hold is not searched.
    const parsed = folderRow.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const allMail = folders.filter((folder) => folder.purpose === IMAP_ALL_MAIL_PURPOSE);
  const searched =
    allMail.length > 0
      ? allMail
      : IMAP_SEARCHED_PURPOSES.flatMap((purpose) => folders.filter((folder) => folder.purpose === purpose));
  return searched.map((folder) => ({ folderItemId: folder.id, path: folder.path, uidValidity: folder.uid_validity }));
}

/**
 * The live accounts with a sync state (only those hold mail), each with why its provider is not searched: Mail off,
 * or a last sync failure that waits for the user to sign in again.
 */
async function readSearchableMailboxes(
  client: PoolClient,
  ids: MailModuleIds,
  mailboxId: string | null,
): Promise<SearchableMailbox[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT i.id, CASE WHEN jsonb_typeof(i.properties->'provider') = 'string' THEN i.properties->>'provider' END AS provider,
       i.properties->'connectionLimit' AS connection_limit, s.sync_mode, s.sync_paused_at IS NOT NULL AS paused,
       s.last_failure_kind
     FROM items i
     JOIN mail_account_sync_state s ON s.tenant_id = i.tenant_id AND s.item_id = i.id
     WHERE i.tenant_id = app_tenant_default() AND i.database_id = $1 AND i.deleted_at IS NULL
       AND ($2::uuid IS NULL OR i.id = $2::uuid)
     ORDER BY i.id`,
    [ids.mailboxesDatabaseId, mailboxId],
  );
  const mailboxes: SearchableMailbox[] = [];
  for (const raw of rows) {
    const row = mailboxRow.parse(raw);
    const skipped = row.paused
      ? "mailOff"
      : row.last_failure_kind === "reauthorization"
        ? "reauthorizationRequired"
        : null;
    mailboxes.push({
      mailboxItemId: row.id,
      syncMode: row.sync_mode,
      provider: row.provider ?? undefined,
      connectionLimit: row.connection_limit,
      skipped,
      imapFolders: skipped === null && row.sync_mode === "imap" ? await readImapSearchFolders(client, ids, row.id) : [],
    });
  }
  return mailboxes;
}

/** What one mailbox's provider found, mapped to local Emails items. */
type MailboxOutcome =
  | { kind: "searched"; emailIds: string[]; unindexed: number }
  | { kind: "failed"; reason: MailRemoteSearchFailureReason };

interface ProviderSearchContext {
  pool: Pool;
  providers: MailContentProviders;
  mailbox: SearchableMailbox;
  search: { rawQuery: string; terms: MailSearchTerms };
  actor: MailSearchCredentialActor;
  signal: AbortSignal;
}

class ProviderSearchFailed extends Error {
  constructor(readonly reason: MailRemoteSearchFailureReason) {
    super("A mail provider search failed");
    this.name = "ProviderSearchFailed";
  }
}

/**
 * Runs a provider operation. A refused sign-in is `reauthorizationRequired`; a database failure (the OAuth token
 * refresh reads and writes the credential row) keeps its identity; every other failure is a provider failure of a
 * fixed classification (the clients already replaced the original with a fixed error), `timeout` once the search's
 * deadline aborted it, else logged by name only and `providerUnreachable`.
 */
async function providerPhase<T>(context: ProviderSearchContext, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MailReauthorizationRequiredError) throw new ProviderSearchFailed("reauthorizationRequired");
    if (error instanceof DatabaseError) throw error;
    if (context.signal.aborted) throw new ProviderSearchFailed("timeout");
    logger.warn(
      {
        mailboxItemId: context.mailbox.mailboxItemId,
        syncMode: context.mailbox.syncMode,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      "A mail provider search failed",
    );
    throw new ProviderSearchFailed("providerUnreachable");
  }
}

/** A composition root without the mode's adapter cannot search it: logged, and the mailbox reported unreachable. */
function noAdapter(context: ProviderSearchContext): never {
  logger.warn(
    { mailboxItemId: context.mailbox.mailboxItemId, syncMode: context.mailbox.syncMode },
    "No provider search adapter is configured for this sync mode",
  );
  throw new ProviderSearchFailed("providerUnreachable");
}

interface ImapFolderHits {
  folder: ImapSearchFolder;
  /** Newest first. */
  uids: number[];
  /** The folder's UIDVALIDITY as the search selected it. */
  uidvalidity: string;
  /** It equals the stored one as the search began, so the stored edges' UIDs name these messages. */
  uidsComparable: boolean;
}

/**
 * Folder by folder, `UID SEARCH TEXT` for every term, the newest UIDs first until `MAIL_REMOTE_SEARCH_MAX_HITS` are
 * taken; stops at the folder boundary once the deadline passed. The client is handed back on every path.
 */
async function searchImapFolders(context: ProviderSearchContext): Promise<ImapFolderHits[]> {
  const { mailbox, providers } = context;
  const create = providers.createImapClient;
  if (!create) noAdapter(context);
  const credential = await getDecryptedCredential(context.pool, {
    itemId: mailbox.mailboxItemId,
    actorType: context.actor.actorType,
    actorId: context.actor.actorId,
    purpose: "imap_search",
  });
  if (credential === null) throw new ProviderSearchFailed("reauthorizationRequired");
  const accountLimit = imapConnectionLimitForProvider(mailbox.provider, mailbox.connectionLimit);
  const imap: ImapMailClient = await providerPhase(context, () =>
    create(mailbox.mailboxItemId, credential, accountLimit),
  );
  try {
    const searchText = imap.searchText?.bind(imap);
    if (!searchText) noAdapter(context);
    const hits: ImapFolderHits[] = [];
    let remaining = MAIL_REMOTE_SEARCH_MAX_HITS;
    for (const folder of mailbox.imapFolders) {
      if (remaining === 0 || context.signal.aborted) break;
      const { uidvalidity, uids } = await providerPhase(context, async () => {
        const selection = await imap.selectFolder(folder.path);
        return { uidvalidity: selection.uidvalidity, uids: await searchText(folder.path, context.search.terms) };
      });
      const newest = [...new Set(uids)].sort((a, b) => b - a).slice(0, remaining);
      remaining -= newest.length;
      hits.push({
        folder,
        uids: newest,
        uidvalidity: String(uidvalidity),
        uidsComparable: String(uidvalidity) === folder.uidValidity,
      });
    }
    return hits;
  } finally {
    // The search's outcome is decided; a connection that fails to close is logged and changes nothing of it.
    try {
      await imap.close();
    } catch (error) {
      logger.warn(
        { mailboxItemId: mailbox.mailboxItemId, errorName: error instanceof Error ? error.name : typeof error },
        "Closing the IMAP connection of a provider search failed",
      );
    }
  }
}

/**
 * The Emails items the found UIDs name over each folder's edges, while the folder's stored UIDVALIDITY is still the one
 * the search selected (a pass that established the folder anew since gave its edges other UIDs). A UID no edge carries
 * (the message is not ingested yet, or the folder's UIDVALIDITY changed since its last sync) counts as unindexed; a
 * trashed item is no hit.
 */
async function mapImapHits(client: PoolClient, ids: MailModuleIds, hits: ImapFolderHits[]) {
  const folderProperty = await getPropertyByKey(client, ids.emailsDatabaseId, "folder");
  const definition = folderProperty ? await getRelationDefinitionByPropertyId(client, folderProperty.id) : null;
  if (!definition) throw new Error("The Emails folder property has no relation definition");
  const emailIds: string[] = [];
  let unindexed = 0;
  for (const { folder, uids, uidvalidity, uidsComparable } of hits) {
    if (!uidsComparable) {
      unindexed += uids.length;
      continue;
    }
    if (uids.length === 0) continue;
    const { rows } = await client.query<{ uid: string; item_id: string; live: boolean }>(
      `SELECT edge.metadata->>'uid' AS uid, email.id AS item_id, email.deleted_at IS NULL AS live
       FROM item_relations edge
       JOIN items email ON email.tenant_id = edge.tenant_id AND email.database_id = $3
         AND email.id = CASE WHEN edge.item_a = $1 THEN edge.item_b ELSE edge.item_a END
       JOIN mail_folder_sync_state state ON state.tenant_id = edge.tenant_id AND state.item_id = $1
         AND state.uidvalidity = $5::bigint
       WHERE edge.tenant_id = app_tenant_default() AND edge.relation_definition_id = $2
         AND (edge.item_a = $1 OR edge.item_b = $1) AND edge.metadata->>'uid' = ANY($4::text[])`,
      [folder.folderItemId, definition.id, ids.emailsDatabaseId, uids.map(String), uidvalidity],
    );
    const mapped = new Set(rows.map((row) => row.uid));
    unindexed += uids.filter((uid) => !mapped.has(String(uid))).length;
    emailIds.push(...rows.filter((row) => row.live).map((row) => row.item_id));
  }
  return { emailIds, unindexed };
}

/** The Emails items of the mailbox the provider ids name; an id no meta row records counts as unindexed. */
async function mapProviderMessageIds(client: PoolClient, mailboxItemId: string, providerIds: string[]) {
  if (providerIds.length === 0) return { emailIds: [], unindexed: 0 };
  const { rows } = await client.query<{ provider_message_id: string; item_id: string; live: boolean }>(
    `SELECT m.provider_message_id, m.item_id, i.deleted_at IS NULL AS live
     FROM mail_message_meta m
     JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
     WHERE m.tenant_id = app_tenant_default() AND m.mailbox_item_id = $1 AND m.provider_message_id = ANY($2::text[])`,
    [mailboxItemId, providerIds],
  );
  const mapped = new Set(rows.map((row) => row.provider_message_id));
  return {
    emailIds: rows.filter((row) => row.live).map((row) => row.item_id),
    unindexed: new Set(providerIds.filter((id) => !mapped.has(id))).size,
  };
}

/** One mailbox's provider search, outside any transaction, then the mapping of its hits in a short one. */
async function searchMailboxAtProvider(context: ProviderSearchContext, ids: MailModuleIds): Promise<MailboxOutcome> {
  const { mailbox, providers, pool } = context;
  try {
    if (mailbox.syncMode === "imap") {
      const hits = await searchImapFolders(context);
      if (context.signal.aborted) return { kind: "failed", reason: "timeout" };
      return { kind: "searched", ...(await withTransaction(pool, (client) => mapImapHits(client, ids, hits))) };
    }
    let providerIds: string[];
    if (mailbox.syncMode === "gmail_api") {
      const create = providers.createGmailClient;
      if (!create) noAdapter(context);
      // Gmail reads the user's query with its own operators, which `q` shares.
      providerIds = await providerPhase(context, () =>
        create(mailbox.mailboxItemId).searchMessageIds(
          context.search.rawQuery,
          MAIL_REMOTE_SEARCH_MAX_HITS,
          context.signal,
        ),
      );
    } else {
      const create = providers.createGraphClient;
      if (!create) noAdapter(context);
      providerIds = await providerPhase(context, () =>
        create(mailbox.mailboxItemId).searchMessageIds(
          context.search.terms,
          MAIL_REMOTE_SEARCH_MAX_HITS,
          context.signal,
        ),
      );
    }
    if (context.signal.aborted) return { kind: "failed", reason: "timeout" };
    const hits = providerIds.slice(0, MAIL_REMOTE_SEARCH_MAX_HITS);
    return {
      kind: "searched",
      ...(await withTransaction(pool, (client) => mapProviderMessageIds(client, mailbox.mailboxItemId, hits))),
    };
  } catch (error) {
    if (error instanceof ProviderSearchFailed) return { kind: "failed", reason: error.reason };
    throw error;
  }
}

export interface MailRemoteSearchSummary {
  /** The mailboxes whose provider answered, in mailbox id order. */
  searched: string[];
  failed: Array<{ mailboxId: string; reason: MailRemoteSearchFailureReason }>;
  /** Provider hits no local Emails item records yet. */
  unindexed: number;
}

export interface MailRemoteSearchOptions {
  deadlineMs?: number;
}

interface RemoteSearchInput {
  search: ParsedMailSearchQuery;
  rawQuery: string;
  mailboxId: string | null;
  actor: MailSearchCredentialActor;
  /**
   * Called once before the first provider call, never when no provider would be asked. `false` searches no provider
   * (the mailboxes it would have asked are then neither searched nor failed); a throw refuses the whole search.
   */
  admit: () => boolean;
}

/**
 * Searches each live account's provider for the free text of the query, at most `MAIL_REMOTE_SEARCH_CONCURRENCY` at a
 * time, and stops waiting at the deadline: a mailbox that has not answered then is `timeout`, its Gmail or Graph
 * request is aborted and its IMAP search stops at the next folder, and whatever it finds later is dropped. A query
 * without free text asks no provider: every operator is a condition on the stored index. Mail off and a pending
 * sign-in are reported without a provider call.
 */
async function searchProviders(
  pool: Pool,
  dependencies: MailSearchRouteDependencies,
  input: RemoteSearchInput,
  options: MailRemoteSearchOptions,
): Promise<{ summary: MailRemoteSearchSummary; emailIds: string[] }> {
  const summary: MailRemoteSearchSummary = { searched: [], failed: [], unindexed: 0 };
  const terms = parseMailSearchTerms(input.search.freeText);
  if (input.search.contradictory === true || !hasMailSearchTerms(terms)) return { summary, emailIds: [] };
  const { ids, mailboxes } = await withTransaction(pool, async (client) => {
    const moduleIds = await resolveMailModuleIds(client);
    return { ids: moduleIds, mailboxes: await readSearchableMailboxes(client, moduleIds, input.mailboxId) };
  });
  const asked = mailboxes.filter((mailbox) => mailbox.skipped === null);
  if (asked.length === 0 || !input.admit()) {
    summary.failed = mailboxes.flatMap((mailbox) =>
      mailbox.skipped === null ? [] : [{ mailboxId: mailbox.mailboxItemId, reason: mailbox.skipped }],
    );
    return { summary, emailIds: [] };
  }
  const providers = requireDependency(dependencies, "mailContent");

  const controller = new AbortController();
  const outcomes = new Map<string, MailboxOutcome>();
  let next = 0;
  const worker = async () => {
    while (next < asked.length && !controller.signal.aborted) {
      const mailbox = asked[next++]!;
      const outcome = await searchMailboxAtProvider(
        {
          pool,
          providers,
          mailbox,
          search: { rawQuery: input.rawQuery, terms },
          actor: input.actor,
          signal: controller.signal,
        },
        ids,
      );
      if (!controller.signal.aborted) outcomes.set(mailbox.mailboxItemId, outcome);
    }
  };
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, options.deadlineMs ?? MAIL_REMOTE_SEARCH_DEADLINE_MS);
  });
  const work = Promise.all(Array.from({ length: Math.min(MAIL_REMOTE_SEARCH_CONCURRENCY, asked.length) }, worker)).then(
    () => undefined,
    (error: unknown) => {
      // Before the deadline the failure is this search's; after it nobody waits for it any more.
      if (!timedOut) throw error;
      logger.warn(
        { errorName: error instanceof Error ? error.name : typeof error },
        "A mail provider search failed after its deadline",
      );
    },
  );
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  const emailIds = new Set<string>();
  for (const mailbox of mailboxes) {
    const outcome: MailboxOutcome | undefined =
      mailbox.skipped !== null ? { kind: "failed", reason: mailbox.skipped } : outcomes.get(mailbox.mailboxItemId);
    if (outcome === undefined) {
      summary.failed.push({ mailboxId: mailbox.mailboxItemId, reason: "timeout" });
    } else if (outcome.kind === "failed") {
      summary.failed.push({ mailboxId: mailbox.mailboxItemId, reason: outcome.reason });
    } else {
      summary.searched.push(mailbox.mailboxItemId);
      summary.unindexed += outcome.unindexed;
      for (const id of outcome.emailIds) emailIds.add(id);
    }
  }
  return { summary, emailIds: [...emailIds] };
}

export type MailSearchThread = Awaited<ReturnType<typeof listMailThreads>>[number];

export interface MailSearchResult {
  threads: MailSearchThread[];
  /** How many of `threads` the local index matched. */
  localCount: number;
  remote: MailRemoteSearchSummary;
}

export interface MailSearchInput {
  q: string;
  mailboxId: string | null;
  limit: number;
  actor: MailSearchCredentialActor;
  /**
   * Called once before the first provider call, never when no provider would be asked: `false` asks none (the local
   * matches are answered alone), a throw refuses the whole search.
   */
  admit: () => boolean;
}

/** The query as the thread list parses `q`: an invalid `before:`/`after:` date is a 400 on `q`. */
export function parseMailSearchInput(q: string): ParsedMailSearchQuery {
  const search = parseMailSearchQuery(q, true);
  if (hasInvalidMailSearchDate(search)) throw new ValidationError("Invalid search date", { field: "q" });
  return search;
}

/** Newest first, as the thread list orders. */
function byLastMessage(a: MailSearchThread, b: MailSearchThread): number {
  if (a.lastMessageAt !== b.lastMessageAt) return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
  return a.threadId < b.threadId ? 1 : a.threadId > b.threadId ? -1 : 0;
}

/**
 * The threads the local index matches (the thread list's search over every box: a thread with a copy outside Junk and
 * Trash) together with the threads of the Emails the providers found, which must meet the query's operators too,
 * deduplicated, newest first, at most `limit`. A `mailboxId` narrows both to one account.
 */
export async function searchMail(
  pool: Pool,
  dependencies: MailSearchRouteDependencies,
  input: MailSearchInput,
  options: MailRemoteSearchOptions = {},
): Promise<MailSearchResult> {
  const search = parseMailSearchInput(input.q);
  const filters = { box: "all" as const, folderId: null, mailboxId: input.mailboxId, unread: false };
  const local = await withTransaction(pool, async (client) => {
    if (input.mailboxId !== null) await requireLiveMailbox(client, await resolveMailModuleIds(client), input.mailboxId);
    return (await listMailThreads(client, input.limit, null, { ...filters, search })).slice(0, input.limit);
  });
  const remote = await searchProviders(
    pool,
    dependencies,
    { search, rawQuery: input.q, mailboxId: input.mailboxId, actor: input.actor, admit: input.admit },
    options,
  );
  const seen = new Set(local.map((thread) => thread.threadId));
  const found =
    remote.emailIds.length === 0
      ? []
      : await withTransaction(pool, (client) =>
          listMailThreads(client, input.limit, null, {
            ...filters,
            search: { ...search, freeText: "" },
            searchMessageItemIds: remote.emailIds,
          }),
        );
  const threads = [...local, ...found.filter((thread) => !seen.has(thread.threadId))]
    .sort(byLastMessage)
    .slice(0, input.limit);
  return { threads, localCount: local.length, remote: remote.summary };
}

/** As the thread list's: an integer from 1 to 200, 50 when absent. */
function parseLimit(raw: string | null): number {
  if (raw !== null && !/^[0-9]{1,3}$/.test(raw)) throw new ValidationError("Invalid limit", { field: "limit" });
  const limit = raw === null ? 50 : Number(raw);
  if (limit < 1 || limit > 200) throw new ValidationError("Invalid limit", { field: "limit" });
  return limit;
}

/**
 * `GET /api/mail/search?q=&mailboxId=&limit=`. `q` and `limit` are read as the thread list reads them, but a search
 * needs a non-empty `q`. Only a search that asks a provider is counted by the user's throttle (`mailRemoteSearch`).
 */
export function createMailSearchRouteHandler(
  pool: Pool,
  dependencies: MailSearchRouteDependencies,
  options: MailRemoteSearchOptions = {},
) {
  return async (ctx: RouteUrl & RouteUser): Promise<CustomRouteResult<MailSearchResult>> => {
    const url = requestUrl(ctx.req);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q === "" || q.length > MAIL_SEARCH_QUERY_MAX_LENGTH) throw new ValidationError("Invalid q", { field: "q" });
    const limit = parseLimit(url.searchParams.get("limit"));
    const rawMailboxId = url.searchParams.get("mailboxId");
    if (rawMailboxId !== null && !z.uuid().safeParse(rawMailboxId).success)
      throw new ValidationError("Invalid mailboxId", { field: "mailboxId" });
    const userId = ctx.identity.user.id;
    const body = await searchMail(
      pool,
      dependencies,
      {
        q,
        mailboxId: rawMailboxId,
        limit,
        actor: { actorType: "user", actorId: userId },
        admit: () => {
          acquireMailRemoteSearch(dependencies, userId);
          return true;
        },
      },
      options,
    );
    return { status: 200, body };
  };
}

let boundAgentSearch: MailSearchRouteDependencies | undefined;

/**
 * The provider clients and throttle the `mail.search` tool of an agent run uses, whose handler is built without the
 * custom routes' container. A process that binds none searches the local index only.
 */
export function bindMailAgentRemoteSearch(dependencies: MailSearchRouteDependencies | undefined): void {
  boundAgentSearch = dependencies;
}

export function boundMailAgentRemoteSearch(): MailSearchRouteDependencies | undefined {
  return boundAgentSearch;
}
