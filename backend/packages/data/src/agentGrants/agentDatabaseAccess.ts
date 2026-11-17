import type { PoolClient } from "pg";
import { ForbiddenError, NotFoundError } from "../errors.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { parseAgentDatabaseAccess, type AgentDatabaseAccess } from "./agentDatabaseGrantsStore.js";
import { isItemAllowed } from "./agentRunReadAllowancesStore.js";
import { sensitiveSourceDatabaseIds } from "./inheritedSensitivity.js";
import { SENSITIVITY_INHERITING_MODULE_IDS } from "../seed/sensitiveDatabaseKeys.js";

// Per-database access check for an agent (docs/architecture/agents-approvals-and-ai.md#per-database-grants).
// It runs in the transaction of the read or write it guards; a gateway pre-check followed by a separate write
// would leave a gap.

/** What a read or a write needs; `write` includes `read`. */
export type RequiredAgentDatabaseAccess = "read" | "write";

/** An external AI client on `/mcp` with the user's own token: no project, so sensitive databases are refused. */
export interface ExternalClientReader {
  externalClient: true;
}

/** An agent run's Projects item id, or an external client. A person or the system is passed as `undefined`. */
export type DatabaseReader = string | ExternalClientReader;

const ACCESS_RANK: Readonly<Record<AgentDatabaseAccess, number>> = { none: 0, read: 1, write: 2 };

/**
 * The project's access (bind parameter `project`) to the database aliased `d`, as one SQL expression so the point
 * check and the listings cannot disagree. A non-sensitive system database is always open; otherwise the stored
 * decision wins, defaulting to `none` for sensitive and `write` for user-created. Both arguments are module
 * constants, never values.
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
 * The default when no decision is stored, mirroring the `CASE` in `effectiveAccessSql`. The PATCH route removes the
 * stored decision rather than storing this value.
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
 * True when the item named by `ref` (caller's column expressions, never values) belongs to a sensitivity-inheriting
 * database and is linked to a sensitive database the project may not read, so a list leaves it out. Same links as
 * `sensitiveSourceDatabaseIds`; binds its values into `params`. Not locked: it filters listings, the point check
 * guards the item.
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
  /** From the run credential, never from a request. */
  agentProjectItemId: string;
  databaseId: string;
  access: RequiredAgentDatabaseAccess;
  /** A refused `read` still passes when the run holds a per-turn allowance for this item. Ignored for `write`. */
  readAllowance?: { agentRunId: string; itemId: string };
  /**
   * For an item of a sensitivity-inheriting database (Files, Transcripts, Inbox), access is also required on each
   * sensitive database it is linked to. Without it only the database is decided.
   */
  itemId?: string;
}

/**
 * Throws `ForbiddenError` when the project lacks `access`, `NotFoundError` when the database does not exist. The
 * stored decision row is locked `FOR SHARE`, so a revoke waits for the transaction that passed the check (a
 * not-yet-existing decision cannot be locked). Messages name no item content.
 *
 * A `readAllowance` is looked up (and locked) only after the project's access refused, and opens one item for
 * reading only. With an `itemId`, inherited sensitivity is checked as well (`assertInheritedSensitivityAccess`).
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
 * Wraps `buildFilterSql` to drop items `inheritedSensitivityDeniedSql` denies, so a page, its cursor and its count
 * cover readable items only. Names the table `items` unaliased, as `listItems` and `countItems` query it.
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
 * `assertAgentDatabaseAccess` for any reader. An external client is refused sensitive databases and allowed every
 * other: no decision row, no read allowance (that belongs to a run), and `itemId` is ignored.
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

/** Whether the run's per-turn read allowance opens the one item of a refused `read`. */
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
 * Refuses when the item is linked to a sensitive database the project lacks `access` on. Decision rows are locked
 * `FOR SHARE` as in the point check. The message names the item, not the linked database, so the refusal does not
 * reveal the link. A `readAllowance` opens a `read`.
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
 * The project for an agent writer (including a replayed approved request), the external-client reader for an `/mcp`
 * call on a human token, otherwise `undefined` (a person or the system is not checked).
 */
export function readerOfWriter(
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
): DatabaseReader | undefined {
  if (writer?.agentProjectItemId !== undefined) return writer.agentProjectItemId;
  return writer?.externalClient === true ? { externalClient: true } : undefined;
}

/** Runs `assertReaderDatabaseAccess` only for a writer `readerOfWriter` maps to a reader. */
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

/** Databases the reader may not read. Not locked: it filters listings, the point check guards the data. */
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
 * Sensitive databases the project may not read. A filter, sort or rollup reaching one would answer questions about
 * its records, so `closedSensitiveAggregationAccess.ts` closes them. Not locked, as above.
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
 * Every database a grant can matter for (sensitive or user-created; non-sensitive system ones are always open)
 * with the project's effective access. Sensitive first (system before user-created), then by name. Not locked: a
 * read model.
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
