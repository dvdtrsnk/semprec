import type { PoolClient } from "pg";
import { ForbiddenError, NotFoundError } from "../errors.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { parseAgentDatabaseAccess, type AgentDatabaseAccess } from "./agentDatabaseGrantsStore.js";
import { isItemAllowed } from "./agentRunReadAllowancesStore.js";

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
 * The access of the project (`$1`) to the database aliased `d`, as one SQL expression so the point check and
 * the list of unreadable databases cannot disagree. A non-sensitive system database is always open and its
 * rows, if any, are ignored; otherwise the stored decision wins, and without one a sensitive database is
 * `none` and a user-created database is `write`. `lock` is appended to the stored-decision lookup.
 * The argument is a constant of this module, never a value.
 */
function effectiveAccessSql(lock: "" | " FOR SHARE"): string {
  return `CASE WHEN d.system AND NOT d.sensitive THEN 'write'
    ELSE COALESCE(
      (SELECT g.access FROM agent_database_grants g WHERE g.project_item_id = $1 AND g.database_id = d.id${lock}),
      CASE WHEN d.sensitive THEN 'none' ELSE 'write' END)
    END`;
}

/** The access of an external client to the database aliased `d`: a sensitive database is `none`, any other `write`. */
const EXTERNAL_CLIENT_ACCESS_SQL = `CASE WHEN d.sensitive THEN 'none' ELSE 'write' END`;

interface EffectiveAccessRow {
  effective_access: string;
}

interface DatabaseIdRow {
  id: string;
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
  );
}

/**
 * `assertAgentDatabaseAccess` for a `DatabaseReader`: an agent's project is decided as there, an external client
 * (issue #1998) is refused `read` and `write` of a sensitive database and allowed every other, whatever a project
 * stored. There is no decision row to lock for an external client, and it never has a `readAllowance`: the allowance
 * belongs to a run.
 */
export async function assertReaderDatabaseAccess(
  client: PoolClient,
  reader: DatabaseReader,
  databaseId: string,
  access: RequiredAgentDatabaseAccess,
  readAllowance?: AssertAgentDatabaseAccessInput["readAllowance"],
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
    if (
      access === "read" &&
      typeof reader === "string" &&
      readAllowance !== undefined &&
      (await isItemAllowed(client, readAllowance.agentRunId, readAllowance.itemId))
    ) {
      return;
    }
    throw new ForbiddenError(
      typeof reader === "string"
        ? `The agent's project has no ${access} access to database ${databaseId}`
        : `An external client has no ${access} access to database ${databaseId}`,
      { resource: "database", databaseId, access },
    );
  }
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
 * names a reader for. A person and the system pass untouched.
 */
export async function assertWriterDatabaseAccess(
  client: PoolClient,
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
  databaseId: string,
  access: RequiredAgentDatabaseAccess,
): Promise<void> {
  const reader = readerOfWriter(writer);
  if (reader === undefined) return;
  await assertReaderDatabaseAccess(client, reader, databaseId, access);
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
