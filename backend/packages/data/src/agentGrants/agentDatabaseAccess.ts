import type { PoolClient } from "pg";
import { ForbiddenError, NotFoundError } from "../errors.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { parseAgentDatabaseAccess, type AgentDatabaseAccess } from "./agentDatabaseGrantsStore.js";
import { isItemAllowed } from "./agentRunReadAllowancesStore.js";
import { sensitiveSourceDatabaseIds } from "./inheritedSensitivity.js";
import { SENSITIVITY_INHERITING_MODULE_IDS } from "../seed/sensitiveDatabaseKeys.js";

// The per-database access check for an agent (issue #1810; docs/adr/2026-11-12-per-database-agent-grants.md).
// It lives in the data layer and runs in the transaction of the read or write it guards, because a check
// in the gateway followed by a separate write would be a pre-check outside the write's transaction
// (docs/adr/2026-09-17-generic-application-service-port.md).

/** What a read or a write needs; `write` includes `read`. */
export type RequiredAgentDatabaseAccess = "read" | "write";

/**
 * An external AI client on `/mcp` with the user's own token (issue #1998). It has no project, so no grant can
 * exist for it and it is decided like an agent project without a grant for a sensitive database: refused. Every
 * other database is open to it.
 */
export interface ExternalClientReader {
  externalClient: true;
}

/**
 * Whom a database read is decided for: the Projects item of an agent's run (a string), or an external AI client
 * (`ExternalClientReader`). A person and the system are no reader and are passed as `undefined`.
 */
export type DatabaseReader = string | ExternalClientReader;

const ACCESS_RANK: Readonly<Record<AgentDatabaseAccess, number>> = { none: 0, read: 1, write: 2 };

/**
 * The access of the project (the bind parameter `project`, `$1` unless the caller says otherwise) to the database
 * aliased `d`, as one SQL expression so the point check and the list of unreadable databases cannot disagree. A
 * non-sensitive system database is always open and its rows, if any, are ignored; otherwise the stored decision
 * wins, and without one a sensitive database is `none` and a user-created database is `write`. `lock` is appended to
 * the stored-decision lookup. Both arguments are constants of this module (a lock clause and a parameter
 * placeholder), never a value.
 */
function effectiveAccessSql(lock: "" | " FOR SHARE", project = "$1"): string {
  return `CASE WHEN d.system AND NOT d.sensitive THEN 'write'
    ELSE COALESCE(
      (SELECT g.access FROM agent_database_grants g WHERE g.project_item_id = ${project} AND g.database_id = d.id${lock}),
      CASE WHEN d.sensitive THEN 'none' ELSE 'write' END)
    END`;
}

/** The access of an external client to the database aliased `d`: a sensitive database is `none`, any other `write`. */
const EXTERNAL_CLIENT_ACCESS_SQL = `CASE WHEN d.sensitive THEN 'none' ELSE 'write' END`;

/**
 * What a project may do with a database while the user has made no decision: a sensitive database is closed and a
 * user-created one open. It is the `CASE` inside `effectiveAccessSql`, and the PATCH route removes the stored
 * decision instead of storing this value (`agentDatabaseGrantsForProject.ts`).
 */
export function defaultAgentDatabaseAccess(database: { sensitive: boolean }): AgentDatabaseAccess {
  return database.sensitive ? "none" : "write";
}

interface EffectiveAccessRow {
  effective_access: string;
}

interface DatabaseIdRow {
  id: string;
}

interface DatabaseAccessRow {
  id: string;
  effective_access: string;
}

/**
 * A SQL condition that is true when the item whose id and database id the SQL expressions `ref` name is an item of
 * a sensitivity-inheriting database that is linked to a sensitive database the agent's project may not read
 * (issue #1999), so a list leaves the item out. It reads the same links as `sensitiveSourceDatabaseIds` and decides
 * the access with the expression of the point check. The project and the owner module ids are appended to `params`
 * and bound; `ref` is made of the caller's own column names, never of a value. Not locked: it filters what is
 * listed, while the point check guards the item itself.
 */
export function inheritedSensitivityDeniedSql(
  params: unknown[],
  ref: { itemId: string; databaseId: string },
  agentProjectItemId: string,
): string {
  params.push(agentProjectItemId);
  const project = `$${params.length}`;
  params.push(SENSITIVITY_INHERITING_MODULE_IDS);
  const modules = `$${params.length}`;
  return `EXISTS (SELECT 1 FROM databases self_db
    JOIN item_relations e ON e.item_a = ${ref.itemId} OR e.item_b = ${ref.itemId}
    JOIN items o ON o.id = CASE WHEN e.item_a = ${ref.itemId} THEN e.item_b ELSE e.item_a END AND o.deleted_at IS NULL
    JOIN databases d ON d.id = o.database_id AND d.sensitive
    WHERE self_db.id = ${ref.databaseId} AND self_db.system AND self_db.owner_module_id = ANY(${modules}::text[])
      AND ${effectiveAccessSql("", project)} = 'none')`;
}

export interface AssertAgentDatabaseAccessInput {
  /** The Projects item of the agent's run, taken from the run credential, never from a request. */
  agentProjectItemId: string;
  databaseId: string;
  access: RequiredAgentDatabaseAccess;
  /**
   * The run and the one item of the read that is guarded (issue #1849). A `read` that the project's access refuses
   * still passes when the run holds a per-turn allowance for that item. Never consulted for a `write`.
   */
  readAllowance?: { agentRunId: string; itemId: string };
  /**
   * The item the access is for (issue #1999). For an item of a database that inherits sensitivity (Files,
   * Transcripts, Inbox) the access is also required on each sensitive database the item is linked to, after the
   * database itself passed and in the same transaction. Without it only the database is decided.
   */
  itemId?: string;
}

/**
 * Refuses with a `ForbiddenError` (403 `forbidden`) when the agent's project lacks `access` to the database,
 * and with a `NotFoundError` when the caller's tenant has no such database. One statement reads the database
 * and the project's stored decision and locks that decision row `FOR SHARE`, so a revoke that updates the row
 * waits for the transaction that passed the check. A decision that does not exist yet cannot be locked: the
 * insert of a first row for a database on its default is not held back. The message and details name no content
 * of any item.
 *
 * A `read` with a `readAllowance` is also allowed when the run holds an allowance for that item
 * (`agentRunReadAllowancesStore.ts`, docs/adr/2026-11-13-a-user-attached-ref-grants-one-turn-read-access.md); the
 * allowance row is looked up, and locked `FOR SHARE`, in the same transaction only after the project's access refused.
 * It opens the one item for a read and never a write.
 *
 * With an `itemId` of an item in a sensitivity-inheriting database (Files, Transcripts, Inbox) that is linked to a
 * sensitive database, the project also needs `access` on that database (issue #1999,
 * `assertInheritedSensitivityAccess`); a `readAllowance` for the item opens that refusal for a `read` as well.
 */
export async function assertAgentDatabaseAccess(
  client: PoolClient,
  input: AssertAgentDatabaseAccessInput,
): Promise<void> {
  await assertReaderDatabaseAccess(
    client,
    input.agentProjectItemId,
    input.databaseId,
    input.access,
    input.readAllowance,
    input.itemId,
  );
}

/**
 * `buildFilterSql` (`ListItemsOptions`) with the items left out that `inheritedSensitivityDeniedSql` denies the agent's
 * project (issue #1999), so a page, its cursor and its count cover the readable items only. The returned builder
 * names the table `items` unaliased, as `itemsStore.listItems` and `countItems` query it.
 */
export function excludeInheritedSensitiveItems(
  buildFilterSql: ((params: unknown[]) => string | undefined) | undefined,
  agentProjectItemId: string,
): (params: unknown[]) => string | undefined {
  return (params) => {
    const base = buildFilterSql?.(params);
    const visible = `NOT ${inheritedSensitivityDeniedSql(params, { itemId: "items.id", databaseId: "items.database_id" }, agentProjectItemId)}`;
    return base ? `(${base}) AND ${visible}` : visible;
  };
}

/**
 * `assertAgentDatabaseAccess` for a `DatabaseReader`: an agent's project is decided as there, an external client
 * (issue #1998) is refused `read` and `write` of a sensitive database and allowed every other, whatever a project
 * stored. There is no decision row to lock for an external client, and it never has a `readAllowance`: the allowance
 * belongs to a run. `itemId` names the item the access is for and applies to an agent's project only (issue #1999,
 * `AssertAgentDatabaseAccessInput.itemId`); an external client is decided by the database alone.
 */
export async function assertReaderDatabaseAccess(
  client: PoolClient,
  reader: DatabaseReader,
  databaseId: string,
  access: RequiredAgentDatabaseAccess,
  readAllowance?: AssertAgentDatabaseAccessInput["readAllowance"],
  itemId?: string,
): Promise<void> {
  const { rows } =
    typeof reader === "string"
      ? await client.query<EffectiveAccessRow>(
          `SELECT ${effectiveAccessSql(" FOR SHARE")} AS effective_access FROM databases d WHERE d.id = $2`,
          [reader, databaseId],
        )
      : await client.query<EffectiveAccessRow>(
          `SELECT ${EXTERNAL_CLIENT_ACCESS_SQL} AS effective_access FROM databases d WHERE d.id = $1`,
          [databaseId],
        );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`Database ${databaseId} not found`, { resource: "database", databaseId });
  }
  if (ACCESS_RANK[parseAgentDatabaseAccess(row.effective_access)] < ACCESS_RANK[access]) {
    if (await allowanceOpens(client, reader, access, readAllowance)) return;
    throw new ForbiddenError(
      typeof reader === "string"
        ? `The agent's project has no ${access} access to database ${databaseId}`
        : `An external client has no ${access} access to database ${databaseId}`,
      { resource: "database", databaseId, access },
    );
  }
  if (typeof reader === "string" && itemId !== undefined) {
    await assertInheritedSensitivityAccess(client, reader, itemId, access, readAllowance);
  }
}

/** Whether the run's per-turn read allowance (issue #1849) opens the one item of a `read` the project's access refused. */
async function allowanceOpens(
  client: PoolClient,
  reader: DatabaseReader,
  access: RequiredAgentDatabaseAccess,
  readAllowance: AssertAgentDatabaseAccessInput["readAllowance"],
): Promise<boolean> {
  return (
    access === "read" &&
    typeof reader === "string" &&
    readAllowance !== undefined &&
    (await isItemAllowed(client, readAllowance.agentRunId, readAllowance.itemId))
  );
}

/**
 * Refuses with a `ForbiddenError` when the item, which belongs to a sensitivity-inheriting database, is linked to a
 * sensitive database on which the agent's project lacks `access` (issue #1999). The decisions of all the linked
 * databases are read in one statement and their rows locked `FOR SHARE`, as in the point check. The message names the
 * item and the access, not the linked database, so the refusal does not reveal what the item is linked to. A
 * `readAllowance` for the item opens a `read`, as it does for the database itself.
 */
async function assertInheritedSensitivityAccess(
  client: PoolClient,
  agentProjectItemId: string,
  itemId: string,
  access: RequiredAgentDatabaseAccess,
  readAllowance: AssertAgentDatabaseAccessInput["readAllowance"],
): Promise<void> {
  const sourceDatabaseIds = await sensitiveSourceDatabaseIds(client, itemId);
  if (sourceDatabaseIds.length === 0) return;
  const { rows } = await client.query<DatabaseAccessRow>(
    `SELECT d.id, ${effectiveAccessSql(" FOR SHARE")} AS effective_access FROM databases d WHERE d.id = ANY($2::uuid[])`,
    [agentProjectItemId, sourceDatabaseIds],
  );
  const refused = rows.some((row) => ACCESS_RANK[parseAgentDatabaseAccess(row.effective_access)] < ACCESS_RANK[access]);
  if (!refused) return;
  if (await allowanceOpens(client, agentProjectItemId, access, readAllowance)) return;
  throw new ForbiddenError(`The agent's project has no ${access} access to item ${itemId}`, {
    resource: "item",
    itemId,
    access,
  });
}

/**
 * The reader a writer stands for: its project when it carries an `agentProjectItemId` (an agent under a run, or
 * an approved request replayed for one), the external-client reader when it carries `externalClient` (an `/mcp`
 * call on a human token, issue #1998), otherwise `undefined`: a person and the system are not checked.
 */
export function readerOfWriter(
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
): DatabaseReader | undefined {
  if (writer?.agentProjectItemId !== undefined) return writer.agentProjectItemId;
  return writer?.externalClient === true ? { externalClient: true } : undefined;
}

/**
 * `assertReaderDatabaseAccess` for the writer of a choke-point write: it runs only for a writer `readerOfWriter`
 * names a reader for. A person and the system pass untouched. `itemId` is the item the write is for (issue #1999).
 */
export async function assertWriterDatabaseAccess(
  client: PoolClient,
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
  databaseId: string,
  access: RequiredAgentDatabaseAccess,
  itemId?: string,
): Promise<void> {
  const reader = readerOfWriter(writer);
  if (reader === undefined) return;
  await assertReaderDatabaseAccess(client, reader, databaseId, access, undefined, itemId);
}

/**
 * The ids of the tenant's databases the reader may not read (access `none`): for an agent's project the databases
 * its decisions and defaults close, for an external client (issue #1998) the sensitive ones. Not locked: it only
 * filters what is listed or expanded, while the point check guards the data itself.
 */
export async function listUnreadableDatabaseIds(client: PoolClient, reader: DatabaseReader): Promise<Set<string>> {
  const { rows } =
    typeof reader === "string"
      ? await client.query<DatabaseIdRow>(`SELECT d.id FROM databases d WHERE ${effectiveAccessSql("")} = 'none'`, [
          reader,
        ])
      : await client.query<DatabaseIdRow>(`SELECT d.id FROM databases d WHERE ${EXTERNAL_CLIENT_ACCESS_SQL} = 'none'`);
  return new Set(rows.map((row) => row.id));
}

/**
 * The ids of the tenant's sensitive databases the agent's project may not read (access `none`), decided by the
 * expression of the point check (issue #2000). A filter, a sort or a rollup value of another database that reaches one
 * of them would answer questions about its records without returning one, so `closedSensitiveAggregationAccess.ts`
 * closes them for the agent. A user-created database that is not sensitive is never in the set, whatever the project
 * stored for it. Not locked: it filters what is compiled or returned, while the point check guards the data itself.
 */
export async function listClosedSensitiveDatabaseIds(
  client: PoolClient,
  agentProjectItemId: string,
): Promise<ReadonlySet<string>> {
  const { rows } = await client.query<DatabaseIdRow>(
    `SELECT d.id FROM databases d WHERE d.sensitive AND ${effectiveAccessSql("")} = 'none'`,
    [agentProjectItemId],
  );
  return new Set(rows.map((row) => row.id));
}

/** One database a grant can matter for, with the access the project currently has to it. */
export interface ProjectDatabaseAccessRow {
  databaseId: string;
  key: string | null;
  /** The stored name; `null` for a system database whose label comes from the module catalog. */
  name: string | null;
  sensitive: boolean;
  system: boolean;
  access: AgentDatabaseAccess;
}

interface ProjectDatabaseAccessDbRow {
  id: string;
  key: string | null;
  name: string | null;
  sensitive: boolean;
  system: boolean;
  effective_access: string;
}

/**
 * Every database of the tenant a grant can matter for, the sensitive ones and the user-created ones, with the
 * access of the project (`effectiveAccessSql`, the expression the point check uses). A non-sensitive system
 * database is always open and not listed. Sensitive databases first (system before user-created), then the
 * user-created ones by name. Not locked: it is a read model, while the point check guards the data itself.
 */
export async function listProjectDatabaseAccess(
  client: PoolClient,
  projectItemId: string,
): Promise<ProjectDatabaseAccessRow[]> {
  const { rows } = await client.query<ProjectDatabaseAccessDbRow>(
    `SELECT d.id, d.key, d.name, d.sensitive, d.system, ${effectiveAccessSql("")} AS effective_access
       FROM databases d
      WHERE d.sensitive OR NOT d.system
      ORDER BY d.sensitive DESC, d.system DESC, d.key, d.name, d.id`,
    [projectItemId],
  );
  return rows.map((row) => ({
    databaseId: row.id,
    key: row.key,
    name: row.name,
    sensitive: row.sensitive,
    system: row.system,
    access: parseAgentDatabaseAccess(row.effective_access),
  }));
}
