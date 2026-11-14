import type { Pool, PoolClient } from "pg";
import { transcriptionProblemKey } from "@semprec/shared";
import { getTenantUserId } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { PROJECTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { agentHeartbeatProblemKey } from "./agentProblemKeys.js";
import { raiseAgentHeartbeatProblem } from "./agentProblems.js";
import { createGuidanceProblemWriter } from "./guidanceProblemWriter.js";
import { lockProblemKey, raiseProblem } from "./sempProblemsStore.js";
import { automationProblemKey, guidanceProblemKey, mailProblemKey } from "./sourceProblemKeys.js";

/** Sources read per transaction; a page of this many candidates is raised and committed together. */
const PAGE_SIZE = 100;

/** Every raise of this step carries this occurrence key, so a repeat of a report adds no occurrence. */
const BACKFILL_OCCURRENCE_KEY = "backfill";

/** The check key prefix of the per-mailbox stall check (`mail:<mailboxItemId>` in `tenant_observability_checks`). */
const MAIL_CHECK_KEY_PREFIX = "mail:";

/** One failing source row, read in a page's transaction, and the raise that reports it. */
interface Candidate {
  /** The row's uuid, the keyset cursor of its source. Unique within one source. */
  id: string;
  dedupeKey: string;
  raise(client: PoolClient, userId: string): Promise<unknown>;
}

interface BackfillSource {
  name: string;
  /** Reads up to `limit` failing rows after `afterId`, in id order, and locks them `FOR SHARE` in the caller's transaction. */
  read(client: PoolClient, afterId: string | null, limit: number): Promise<Candidate[]>;
}

interface MailRow {
  id: string;
  failing_since: Date | null;
  last_activity_at: Date | null;
  last_failure_kind: string | null;
  sync_status: string | null;
}

/**
 * Mailboxes whose `syncStatus` is `error` or `needsReauthorization`, and mailboxes whose `mail:<id>` stall check is
 * alerting. The mailbox item and its sync-state row are locked `FOR SHARE`, so a write to either, such as the
 * success write of a sync pass, waits for this page's transaction. Severity follows the sync job and the stall
 * check: `critical` for a revoked credential, `warning` otherwise.
 */
const mailSource: BackfillSource = {
  name: "mail",
  async read(client, afterId, limit) {
    const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
    if (!mailboxes) return [];
    const { rows } = await client.query<MailRow>(
      `SELECT s.item_id AS id, s.failing_since, s.last_activity_at, s.last_failure_kind,
              i.properties->>'syncStatus' AS sync_status
         FROM mail_account_sync_state s
         JOIN items i ON i.tenant_id = s.tenant_id AND i.database_id = $1 AND i.id = s.item_id AND i.deleted_at IS NULL
         LEFT JOIN tenant_observability_checks c
           ON c.tenant_id = s.tenant_id AND c.check_key = $2::text || s.item_id::text
        WHERE s.tenant_id = app_tenant_default()
          AND (i.properties->>'syncStatus' IN ('error', 'needsReauthorization') OR c.status = 'alerting')
          AND ($3::uuid IS NULL OR s.item_id > $3)
        ORDER BY s.item_id
        LIMIT $4
        FOR SHARE OF s, i`,
      [mailboxes.id, MAIL_CHECK_KEY_PREFIX, afterId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      dedupeKey: mailProblemKey(row.id),
      raise: (tx, userId) =>
        raiseProblem(tx, {
          userId,
          category: "mail",
          kind: "mailSyncError",
          severity:
            row.sync_status === "needsReauthorization" || row.last_failure_kind === "reauthorization"
              ? "critical"
              : "warning",
          sourceTable: "mail_account_sync_state",
          sourceId: row.id,
          dedupeKey: mailProblemKey(row.id),
          since: row.failing_since ?? row.last_activity_at ?? undefined,
          occurrenceKey: BACKFILL_OCCURRENCE_KEY,
        }),
    }));
  },
};

interface FindingRow {
  id: string;
  project_item_id: string;
  fingerprint: string;
}

/** Active guidance drift findings of a project that is not in the trash. */
const guidanceSource: BackfillSource = {
  name: "guidance",
  async read(client, afterId, limit) {
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) return [];
    const { rows } = await client.query<FindingRow>(
      `SELECT f.id, f.project_item_id, f.fingerprint
         FROM agent_guidance_drift_findings f
         JOIN items i ON i.tenant_id = f.tenant_id AND i.database_id = $1 AND i.id = f.project_item_id AND i.deleted_at IS NULL
        WHERE f.tenant_id = app_tenant_default() AND f.status = 'active' AND ($2::uuid IS NULL OR f.id > $2)
        ORDER BY f.id
        LIMIT $3
        FOR SHARE OF f`,
      [projects.id, afterId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      dedupeKey: guidanceProblemKey(row.project_item_id, row.fingerprint),
      raise: (tx, userId) =>
        createGuidanceProblemWriter().raise(tx, {
          userId,
          projectItemId: row.project_item_id,
          fingerprint: row.fingerprint,
          findingId: row.id,
          occurrenceKey: BACKFILL_OCCURRENCE_KEY,
        }),
    }));
  },
};

interface HeartbeatRow {
  id: string;
}

/** Heartbeats whose last occurrence failed: `project_heartbeats.last_error` is set. */
const heartbeatSource: BackfillSource = {
  name: "heartbeat",
  async read(client, afterId, limit) {
    const { rows } = await client.query<HeartbeatRow>(
      `SELECT h.id FROM project_heartbeats h
        WHERE h.tenant_id = app_tenant_default() AND h.last_error IS NOT NULL AND ($1::uuid IS NULL OR h.id > $1)
        ORDER BY h.id
        LIMIT $2
        FOR SHARE OF h`,
      [afterId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      dedupeKey: agentHeartbeatProblemKey(row.id),
      raise: (tx, userId) =>
        raiseAgentHeartbeatProblem(tx, { userId, heartbeatId: row.id, occurrenceKey: BACKFILL_OCCURRENCE_KEY }),
    }));
  },
};

interface AutomationRow {
  id: string;
  database_id: string;
}

/**
 * Items outside the Transcripts database whose `item_automation` status is `error` and that are not in the trash.
 * One problem per database, as the library job raises it: the first failing item of a database raises, and the
 * database's other failing items find that problem in the page's transaction and add nothing.
 */
const automationSource: BackfillSource = {
  name: "automation",
  async read(client, afterId, limit) {
    const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    const { rows } = await client.query<AutomationRow>(
      `SELECT ia.item_id AS id, i.database_id
         FROM item_automation ia
         JOIN items i ON i.id = ia.item_id AND i.tenant_id = ia.tenant_id
        WHERE ia.tenant_id = app_tenant_default() AND ia.status = 'error' AND i.deleted_at IS NULL
          AND i.database_id IS DISTINCT FROM $1::uuid AND ($2::uuid IS NULL OR ia.item_id > $2)
        ORDER BY ia.item_id
        LIMIT $3
        FOR SHARE OF ia`,
      [transcripts?.id ?? null, afterId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      dedupeKey: automationProblemKey(row.database_id),
      raise: (tx, userId) =>
        raiseProblem(tx, {
          userId,
          category: "automation",
          kind: "libraryAutomation",
          severity: "warning",
          sourceTable: "item_automation",
          sourceId: row.id,
          dedupeKey: automationProblemKey(row.database_id),
          occurrenceKey: BACKFILL_OCCURRENCE_KEY,
        }),
    }));
  },
};

interface TranscriptRow {
  id: string;
}

/**
 * Transcripts whose `item_automation` status is `error`. Like the transcription service, which raises nothing for
 * a transcript that is already done or whose source or transcript was deleted (error code `deleted`), this reads
 * neither of those nor a transcript in the trash.
 */
const transcriptionSource: BackfillSource = {
  name: "transcription",
  async read(client, afterId, limit) {
    const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    if (!transcripts) return [];
    const { rows } = await client.query<TranscriptRow>(
      `SELECT ia.item_id AS id
         FROM item_automation ia
         JOIN items i ON i.id = ia.item_id AND i.tenant_id = ia.tenant_id AND i.database_id = $1
        WHERE ia.tenant_id = app_tenant_default() AND ia.status = 'error' AND ia.error_code IS DISTINCT FROM 'deleted'
          AND i.deleted_at IS NULL AND i.properties->>'status' IS DISTINCT FROM 'done'
          AND ($2::uuid IS NULL OR ia.item_id > $2)
        ORDER BY ia.item_id
        LIMIT $3
        FOR SHARE OF ia`,
      [transcripts.id, afterId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      dedupeKey: transcriptionProblemKey(row.id),
      raise: (tx, userId) =>
        raiseProblem(tx, {
          userId,
          category: "transcription",
          kind: "transcriptionFailed",
          severity: "warning",
          sourceTable: "item_automation",
          sourceId: row.id,
          dedupeKey: transcriptionProblemKey(row.id),
          occurrenceKey: BACKFILL_OCCURRENCE_KEY,
        }),
    }));
  },
};

const SOURCES: readonly BackfillSource[] = [
  mailSource,
  guidanceSource,
  heartbeatSource,
  automationSource,
  transcriptionSource,
];

/**
 * Whether the tenant has a problem with `dedupeKey`, active or resolved: an active one is already reported, and a
 * resolved one means the source recovered after it failed, so the source's failure row is not current any more.
 */
async function hasProblem(client: PoolClient, dedupeKey: string): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM semp_problems WHERE tenant_id = app_tenant_default() AND dedupe_key = $1
     ) AS present`,
    [dedupeKey],
  );
  return rows[0]?.present === true;
}

async function backfillSource(pool: Pool, userId: string, source: BackfillSource): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const page: Candidate[] = await withTransaction(pool, async (client) => {
      const candidates = await source.read(client, afterId, PAGE_SIZE);
      for (const candidate of candidates) {
        // The key's lock first, as `raiseProblem` takes it: a producer that raises the same key has committed
        // before the check below reads, or waits for this transaction and then merges into the problem raised here.
        await lockProblemKey(client, candidate.dedupeKey);
        if (await hasProblem(client, candidate.dedupeKey)) continue;
        await candidate.raise(client, userId);
      }
      return candidates;
    });
    const last = page[page.length - 1];
    if (page.length < PAGE_SIZE || !last) return;
    afterId = last.id;
  }
}

/**
 * Per-tenant cutover of issue gh-1958: raises the Semp status problems for failures that exist when the
 * producers (#1911, #1465, #1506, #1945) are deployed, which would stay invisible until they failed again. It
 * reads five current states and raises each under the key its producer uses, through `raiseProblem` with the
 * occurrence key `backfill`:
 *
 * - mailboxes with `syncStatus` `error` or `needsReauthorization`, or with an alerting `mail:<id>` stall check
 *   (`mail:<mailboxItemId>`; `since` is `failing_since`, else the last activity time, else now),
 * - active guidance drift findings (`guidance:<projectId>:<fingerprint>`),
 * - heartbeats with a `last_error` (`agents:heartbeat:<heartbeatId>`),
 * - items outside the Transcripts database whose automation status is `error` (`automation:<databaseId>`),
 * - transcripts whose automation status is `error` (`transcription:<transcriptId>`).
 *
 * Operator problems are not backfilled. An item in the trash is not read as a failing source, and neither is a
 * finding of a project that is in the trash. A key that already has a problem, active or resolved, is left alone:
 * `raiseProblem` counts an occurrence whose key differs from the last one stored, so a raise into a producer's
 * problem would change its count, and into a resolved one would start a new problem for a source that recovered.
 * A key whose active problem was raised at a lower severity is not escalated either. The occurrence key `backfill`
 * keeps a repeat of a backfill raise from adding an occurrence.
 *
 * Each source is read in keyset pages of `PAGE_SIZE` rows, each page in one transaction that locks the source rows
 * `FOR SHARE` and every problem key before checking it. A tenant without a user is skipped. A failing source does not
 * stop the others of the tenant; afterwards one `AggregateError` names the failed sources, and
 * `runTenantCutoverMigrations` does the same across tenants. Each created problem writes its `semp_problem`
 * notification, as every raise does.
 */
export async function runSempProblemsBackfillCutoverMigration(pool: Pool): Promise<void> {
  const userId = await withTransaction(pool, (client) => getTenantUserId(client));
  if (!userId) return;
  const failed: string[] = [];
  const errors: unknown[] = [];
  for (const source of SOURCES) {
    try {
      await backfillSource(pool, userId, source);
    } catch (err) {
      failed.push(source.name);
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Semp problems backfill failed for the sources: ${failed.join(", ")}`);
  }
}
