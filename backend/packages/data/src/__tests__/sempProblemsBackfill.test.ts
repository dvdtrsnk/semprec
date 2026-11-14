import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant, transcriptionProblemKey } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import "../domainWriteHooks.js";
import { agentGuidanceDriftFindingsStore } from "../guidanceDrift/agentGuidanceDriftFindingsStore.js";
import {
  ensureItemAutomation,
  markItemAutomationDone,
  markItemAutomationError,
  recordItemAutomationFailure,
} from "../library/itemAutomationStore.js";
import { ensureMailAccountSyncState, recordSyncError } from "../mail/mailAccountSyncStateStore.js";
import { transitionTenantObservabilityCheck } from "../observability/observabilityChecksStore.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import { createHeartbeat, recordHeartbeatFailure } from "../scheduler/schedulerStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { raiseAgentHeartbeatProblem, resolveAgentHeartbeatProblem } from "../semp/agentProblems.js";
import { createGuidanceProblemWriter } from "../semp/guidanceProblemWriter.js";
import { runSempProblemsBackfillCutoverMigration } from "../semp/sempProblemsBackfillCutoverMigration.js";
import { raiseProblem } from "../semp/sempProblemsStore.js";
import { agentHeartbeatProblemKey } from "../semp/agentProblemKeys.js";
import { automationProblemKey, guidanceProblemKey, mailProblemKey } from "../semp/sourceProblemKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";

// `raiseProblem` fails for the keys in `poisoned`, so that a failing step can be told from a failing tenant.
const mocks = vi.hoisted(() => ({ poisoned: new Set<string>() }));
vi.mock("../semp/sempProblemsStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../semp/sempProblemsStore.js")>();
  return {
    ...actual,
    raiseProblem: (...args: Parameters<typeof actual.raiseProblem>) => {
      if (mocks.poisoned.has(args[1].dedupeKey)) return Promise.reject(new Error("poisoned raise"));
      return actual.raiseProblem(...args);
    },
  };
});

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;

interface TenantFixture {
  id: string;
  userId: string;
}

interface ProblemRow {
  dedupe_key: string;
  user_id: string;
  category: string;
  kind: string;
  severity: string;
  source_table: string;
  source_id: string;
  project_item_id: string | null;
  occurrence_count: number;
  first_seen_at: Date;
  last_seen_at: Date;
  last_occurrence_key: string | null;
  resolved_at: Date | null;
  resolution_kind: string | null;
}

/** The problems of one tenant, read on the superuser pool by tenant id, in a fixed order. */
async function problemsOf(tenantId: string): Promise<ProblemRow[]> {
  const { rows } = await admin.query<ProblemRow>(
    `SELECT dedupe_key, user_id, category, kind, severity, source_table, source_id, project_item_id, occurrence_count,
            first_seen_at, last_seen_at, last_occurrence_key, resolved_at, resolution_kind
       FROM semp_problems WHERE tenant_id = $1 ORDER BY dedupe_key`,
    [tenantId],
  );
  return rows;
}

async function notificationCount(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    "SELECT count(*) AS count FROM notifications WHERE tenant_id = $1 AND kind = 'semp_problem'",
    [tenantId],
  );
  return Number(rows[0]?.count);
}

async function createTenant(options: { withUser?: boolean } = {}): Promise<TenantFixture> {
  const id = await createTestTenant(admin);
  const userId =
    options.withUser === false
      ? randomUUID()
      : (await createUser(admin, { email: `${randomUUID()}@example.test`, passwordHash: "hash", tenantId: id })).id;
  await runInTenant(id, () => seedSystem(runtime));
  return { id, userId };
}

/** The id of the system database `moduleId` of the tenant. */
async function databaseId(tenantId: string, moduleId: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = $2",
    [tenantId, moduleId],
  );
  const row = rows[0];
  if (!row) throw new Error(`The seed has no ${moduleId} database`);
  return row.id;
}

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

function backfill(tenantId: string): Promise<void> {
  return runInTenant(tenantId, () => runSempProblemsBackfillCutoverMigration(runtime));
}

async function createItem(tenantId: string, moduleId: string, name: string): Promise<string> {
  const databaseIdOfModule = await databaseId(tenantId, moduleId);
  return inTenant(
    tenantId,
    async (client) => (await createItemWithClient(client, { databaseId: databaseIdOfModule, properties: { name } })).id,
  );
}

interface MailboxOptions {
  syncStatus?: "ok" | "error" | "needsReauthorization";
  /** Records a failure of this kind through the store the sync job uses, which starts the failure streak. */
  failureKind?: "reauthorization" | "other";
  /** The sync-state row; a mailbox that never connected has none. Defaults to true. */
  withSyncState?: boolean;
  checkStatus?: "ok" | "alerting";
}

/** A Mailboxes item and its sync state, written the way the sync job and the stall check write them. */
async function createMailbox(tenantId: string, options: MailboxOptions = {}): Promise<string> {
  const mailboxesDatabaseId = await databaseId(tenantId, "mailboxes");
  const mailboxId = await createItem(tenantId, "mailboxes", "Mailbox");
  await inTenant(tenantId, async (client) => {
    if (options.withSyncState !== false) {
      await ensureMailAccountSyncState(client, { itemId: mailboxId, syncMode: "imap" });
      if (options.failureKind) await recordSyncError(client, mailboxId, "boom", options.failureKind);
    }
    if (options.syncStatus) {
      await updateItemWithClient(
        client,
        { databaseId: mailboxesDatabaseId, itemId: mailboxId, propertiesPatch: { syncStatus: options.syncStatus } },
        { allowedSystemKeys: ["syncStatus"] },
      );
    }
    if (options.checkStatus) {
      await transitionTenantObservabilityCheck(client, `mail:${mailboxId}`, () => ({
        status: options.checkStatus ?? "ok",
        detail: { mailboxItemId: mailboxId },
      }));
    }
  });
  return mailboxId;
}

/** Sets the two times a failing mailbox keeps; raw SQL because the store only writes `now()`. */
async function setMailTimes(
  mailboxId: string,
  times: { failingSince: string | null; lastActivityAt: string | null },
): Promise<void> {
  await admin.query("UPDATE mail_account_sync_state SET failing_since = $2, last_activity_at = $3 WHERE item_id = $1", [
    mailboxId,
    times.failingSince,
    times.lastActivityAt,
  ]);
}

const behaviorPayload = {
  kind: "behavior" as const,
  subject: { mcpTool: "search", databaseId: null },
  claim: "Claim",
  evidence: { runIds: ["one", "two", "three"], count: 3 },
  suggestedAllowedLine: "Create tasks from new GitHub issues.",
  suggestedNotAllowedLine: "Do not create tasks.",
  severity: "warning" as const,
};

/** An active guidance drift finding of `projectItemId`, as a drift pass stores it (without its problem). */
function createFinding(tenant: TenantFixture, projectItemId: string, fingerprint: string): Promise<string> {
  return inTenant(tenant.id, async (client) => {
    const { finding } = await agentGuidanceDriftFindingsStore.upsertActive(client, {
      projectItemId,
      fingerprint,
      payload: behaviorPayload,
      seenAt: new Date("2026-01-01T00:00:00Z"),
    });
    return finding.id;
  });
}

async function createFailedHeartbeat(tenantId: string, projectItemId: string, name = "Heartbeat"): Promise<string> {
  return inTenant(tenantId, async (client) => {
    const heartbeat = await createHeartbeat(client, {
      projectItemId,
      name,
      rule: { kind: "interval", minutes: 5 },
      actionId: CORE_AGENT_RUN_ACTION_ID,
      actionConfig: { task: "do it" },
    });
    await recordHeartbeatFailure(client, heartbeat.id, "boom");
    return heartbeat.id;
  });
}

/** A library item whose automation failed the way `libraryMetadataJob` records it. */
async function createFailedLibraryItem(tenantId: string, moduleId: "movies" | "books", name: string): Promise<string> {
  const itemId = await createItem(tenantId, moduleId, name);
  await inTenant(tenantId, async (client) => {
    await ensureItemAutomation(client, itemId);
    await markItemAutomationError(client, itemId, "boom");
  });
  return itemId;
}

/** A transcript whose automation failed permanently the way the transcription service records it. */
async function createFailedTranscript(
  tenantId: string,
  options: { errorCode?: "providerFailed" | "deleted"; done?: boolean } = {},
): Promise<string> {
  const transcriptsDatabaseId = await databaseId(tenantId, "transcripts");
  const transcriptId = await createItem(tenantId, "transcripts", "Transcript");
  await inTenant(tenantId, async (client) => {
    await ensureItemAutomation(client, transcriptId);
    await recordItemAutomationFailure(client, transcriptId, "boom", "error", options.errorCode ?? "providerFailed");
    if (options.done) {
      await updateItemWithClient(
        client,
        { databaseId: transcriptsDatabaseId, itemId: transcriptId, propertiesPatch: { status: "done" } },
        { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
    }
  });
  return transcriptId;
}

/** Moves an item of the module's database to the trash through the choke point. */
async function trash(tenantId: string, moduleId: string, itemId: string): Promise<void> {
  const databaseIdOfModule = await databaseId(tenantId, moduleId);
  await runInTenant(tenantId, () => chokePoint.softDeleteItem(databaseIdOfModule, itemId));
}

function keysOf(problems: ProblemRow[]): string[] {
  return problems.map((problem) => problem.dedupe_key).sort();
}

describe("the Semp problems backfill (issue gh-1958)", () => {
  let a: TenantFixture;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    mocks.poisoned.clear();
    await resetDatabase(admin);
    a = await createTenant();
  });

  describe("mailboxes", () => {
    it("raises a critical problem for a mailbox in needsReauthorization, since its failing_since", async () => {
      const mailboxId = await createMailbox(a.id, {
        syncStatus: "needsReauthorization",
        failureKind: "reauthorization",
      });
      await setMailTimes(mailboxId, { failingSince: "2026-05-01T08:00:00Z", lastActivityAt: "2026-05-03T08:00:00Z" });

      await backfill(a.id);

      const problems = await problemsOf(a.id);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        dedupe_key: mailProblemKey(mailboxId),
        user_id: a.userId,
        category: "mail",
        kind: "mailSyncError",
        severity: "critical",
        source_table: "mail_account_sync_state",
        source_id: mailboxId,
        project_item_id: null,
        occurrence_count: 1,
        last_occurrence_key: "backfill",
        resolved_at: null,
        resolution_kind: null,
      });
      expect(problems[0]?.first_seen_at.toISOString()).toBe("2026-05-01T08:00:00.000Z");
    });

    it("raises a critical problem for a revoked credential while syncStatus still says error", async () => {
      const mailboxId = await createMailbox(a.id, { syncStatus: "error", failureKind: "reauthorization" });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxId), severity: "critical" }]);
    });

    it("raises a warning for a mailbox in error, since its last activity when its failing_since is unknown", async () => {
      const mailboxId = await createMailbox(a.id, { syncStatus: "error", failureKind: "other" });
      await setMailTimes(mailboxId, { failingSince: null, lastActivityAt: "2026-05-03T08:00:00Z" });

      await backfill(a.id);

      const problems = await problemsOf(a.id);
      expect(problems).toMatchObject([{ dedupe_key: mailProblemKey(mailboxId), severity: "warning" }]);
      expect(problems[0]?.first_seen_at.toISOString()).toBe("2026-05-03T08:00:00.000Z");
    });

    it("starts the problem now for a failing mailbox with neither time", async () => {
      const mailboxId = await createMailbox(a.id, { syncStatus: "error", failureKind: "other" });
      await setMailTimes(mailboxId, { failingSince: null, lastActivityAt: null });
      const before = (await admin.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]?.now;

      await backfill(a.id);

      const problems = await problemsOf(a.id);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.first_seen_at.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? Infinity);
    });

    it("raises a warning for a mailbox whose stall check is alerting while its syncStatus is ok", async () => {
      const mailboxId = await createMailbox(a.id, { syncStatus: "ok", checkStatus: "alerting" });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toMatchObject([
        { dedupe_key: mailProblemKey(mailboxId), severity: "warning", kind: "mailSyncError" },
      ]);
    });

    it("raises a critical problem for an alerting stall check that stores a revoked credential", async () => {
      const mailboxId = await createMailbox(a.id, { checkStatus: "alerting", failureKind: "reauthorization" });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxId), severity: "critical" }]);
    });

    it("raises one problem for a mailbox that is in error and whose stall check is alerting", async () => {
      const mailboxId = await createMailbox(a.id, {
        syncStatus: "error",
        failureKind: "other",
        checkStatus: "alerting",
      });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxId), occurrence_count: 1 }]);
    });

    it("raises nothing for a healthy mailbox whose stall check is ok", async () => {
      await createMailbox(a.id, { syncStatus: "ok", checkStatus: "ok" });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });

    it("raises nothing for a failing mailbox that is in the trash", async () => {
      const mailboxId = await createMailbox(a.id, { syncStatus: "error", failureKind: "other" });
      await trash(a.id, "mailboxes", mailboxId);

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });

    it("raises nothing for a mailbox in error that never connected and has no sync state", async () => {
      await createMailbox(a.id, { syncStatus: "error", withSyncState: false });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });
  });

  describe("guidance drift findings", () => {
    it("raises a warning for an active finding and none for a resolved or a dismissed one", async () => {
      const projectItemId = await createItem(a.id, "projects", "Project");
      const activeId = await createFinding(a, projectItemId, "a".repeat(64));
      const resolvedId = await createFinding(a, projectItemId, "b".repeat(64));
      const dismissedId = await createFinding(a, projectItemId, "c".repeat(64));
      await inTenant(a.id, async (client) => {
        await agentGuidanceDriftFindingsStore.resolve(client, resolvedId, new Date());
        await agentGuidanceDriftFindingsStore.decide(client, dismissedId, {
          status: "dismissed",
          choice: "dismiss",
          userId: a.userId,
          at: new Date(),
        });
      });

      await backfill(a.id);

      const problems = await problemsOf(a.id);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        dedupe_key: guidanceProblemKey(projectItemId, "a".repeat(64)),
        user_id: a.userId,
        category: "guidance",
        kind: "guidanceDrift",
        severity: "warning",
        source_table: "agent_guidance_drift_findings",
        source_id: activeId,
        project_item_id: projectItemId,
        occurrence_count: 1,
        last_occurrence_key: "backfill",
      });
    });

    it("raises nothing for an active finding of a project that is in the trash", async () => {
      const projectItemId = await createItem(a.id, "projects", "Project");
      await createFinding(a, projectItemId, "a".repeat(64));
      await trash(a.id, "projects", projectItemId);

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });
  });

  describe("heartbeats", () => {
    it("raises a warning for a heartbeat whose last occurrence failed and none for a healthy one", async () => {
      const projectItemId = await createItem(a.id, "projects", "Project");
      const failedId = await createFailedHeartbeat(a.id, projectItemId, "Failed");
      await inTenant(a.id, (client) =>
        createHeartbeat(client, {
          projectItemId,
          name: "Healthy",
          rule: { kind: "interval", minutes: 5 },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "do it" },
        }),
      );

      await backfill(a.id);

      const problems = await problemsOf(a.id);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        dedupe_key: agentHeartbeatProblemKey(failedId),
        user_id: a.userId,
        category: "agents",
        kind: "agentHeartbeat",
        severity: "warning",
        source_table: "project_heartbeats",
        source_id: failedId,
        project_item_id: null,
        occurrence_count: 1,
        last_occurrence_key: "backfill",
      });
    });

    it("raises a problem for every failed heartbeat when they fill more than one page", async () => {
      const projectItemId = await createItem(a.id, "projects", "Project");
      const heartbeatIds = await inTenant(a.id, async (client) => {
        const ids: string[] = [];
        for (let index = 0; index < 101; index += 1) {
          const heartbeat = await createHeartbeat(client, {
            projectItemId,
            name: `Heartbeat ${index}`,
            rule: { kind: "interval", minutes: 5 },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "do it" },
          });
          await recordHeartbeatFailure(client, heartbeat.id, "boom");
          ids.push(heartbeat.id);
        }
        return ids;
      });

      await backfill(a.id);

      expect(keysOf(await problemsOf(a.id))).toEqual(heartbeatIds.map(agentHeartbeatProblemKey).sort());
    });
  });

  describe("library automation", () => {
    it("raises one problem per database with failing items, and none for a trashed, a done or a not found item", async () => {
      const firstMovie = await createFailedLibraryItem(a.id, "movies", "First");
      const secondMovie = await createFailedLibraryItem(a.id, "movies", "Second");
      const book = await createFailedLibraryItem(a.id, "books", "Book");
      const trashedMovie = await createFailedLibraryItem(a.id, "movies", "Trashed");
      await trash(a.id, "movies", trashedMovie);
      const doneBook = await createItem(a.id, "books", "Done");
      await inTenant(a.id, async (client) => {
        await ensureItemAutomation(client, doneBook);
        await markItemAutomationDone(client, doneBook);
      });
      const moviesId = await databaseId(a.id, "movies");
      const booksId = await databaseId(a.id, "books");

      await backfill(a.id);

      const problems = await problemsOf(a.id);
      expect(keysOf(problems)).toEqual([automationProblemKey(booksId), automationProblemKey(moviesId)].sort());
      const moviesProblem = problems.find((problem) => problem.dedupe_key === automationProblemKey(moviesId));
      const booksProblem = problems.find((problem) => problem.dedupe_key === automationProblemKey(booksId));
      expect(moviesProblem).toMatchObject({
        user_id: a.userId,
        category: "automation",
        kind: "libraryAutomation",
        severity: "warning",
        source_table: "item_automation",
        occurrence_count: 1,
        last_occurrence_key: "backfill",
      });
      expect([firstMovie, secondMovie]).toContain(moviesProblem?.source_id);
      expect(booksProblem).toMatchObject({ source_id: book, occurrence_count: 1 });
    });

    it("raises nothing for a database whose only failing item is in the trash", async () => {
      const movie = await createFailedLibraryItem(a.id, "movies", "Trashed");
      await trash(a.id, "movies", movie);

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });
  });

  describe("transcriptions", () => {
    it("raises a warning for a transcript whose automation failed, and no automation problem for it", async () => {
      const transcriptId = await createFailedTranscript(a.id);
      const transcriptsId = await databaseId(a.id, "transcripts");

      await backfill(a.id);

      const problems = await problemsOf(a.id);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        dedupe_key: transcriptionProblemKey(transcriptId),
        user_id: a.userId,
        category: "transcription",
        kind: "transcriptionFailed",
        severity: "warning",
        source_table: "item_automation",
        source_id: transcriptId,
        occurrence_count: 1,
        last_occurrence_key: "backfill",
      });
      expect(keysOf(problems)).not.toContain(automationProblemKey(transcriptsId));
    });

    it("keeps a failed transcript out of the automation problem of the library databases", async () => {
      await createFailedTranscript(a.id);
      const movie = await createFailedLibraryItem(a.id, "movies", "Movie");
      const moviesId = await databaseId(a.id, "movies");

      await backfill(a.id);

      expect(await problemsOf(a.id)).toHaveLength(2);
      expect((await problemsOf(a.id)).find((p) => p.dedupe_key === automationProblemKey(moviesId))).toMatchObject({
        source_id: movie,
        occurrence_count: 1,
      });
    });

    it("raises nothing for a transcript that is already done", async () => {
      await createFailedTranscript(a.id, { done: true });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });

    it("raises nothing for a transcript whose failure says the source was deleted", async () => {
      await createFailedTranscript(a.id, { errorCode: "deleted" });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });

    it("raises nothing for a failed transcript in the trash", async () => {
      const transcriptId = await createFailedTranscript(a.id);
      await trash(a.id, "transcripts", transcriptId);

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });
  });

  describe("running again, producers and resolved sources", () => {
    /** One failing source of each kind, so that a repeat is judged over every source. */
    async function createAllFailures(tenant: TenantFixture): Promise<void> {
      await createMailbox(tenant.id, { syncStatus: "needsReauthorization", failureKind: "reauthorization" });
      const projectItemId = await createItem(tenant.id, "projects", "Project");
      await createFinding(tenant, projectItemId, "a".repeat(64));
      await createFailedHeartbeat(tenant.id, projectItemId);
      await createFailedLibraryItem(tenant.id, "movies", "Movie");
      await createFailedTranscript(tenant.id);
    }

    it("creates a problem for each of the five sources", async () => {
      await createAllFailures(a);

      await backfill(a.id);

      expect((await problemsOf(a.id)).map((problem) => problem.category).sort()).toEqual([
        "agents",
        "automation",
        "guidance",
        "mail",
        "transcription",
      ]);
    });

    it("changes nothing, and writes no notification, when it runs a second time", async () => {
      await createAllFailures(a);
      await backfill(a.id);
      const problems = await problemsOf(a.id);
      const notifications = await notificationCount(a.id);
      expect(problems).toHaveLength(5);
      expect(notifications).toBe(5);

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual(problems);
      expect(await notificationCount(a.id)).toBe(notifications);
    });

    it("leaves the count, the times and the severity of a problem a producer already raised", async () => {
      const mailboxId = await createMailbox(a.id, {
        syncStatus: "needsReauthorization",
        failureKind: "reauthorization",
      });
      const projectItemId = await createItem(a.id, "projects", "Project");
      const findingId = await createFinding(a, projectItemId, "a".repeat(64));
      const heartbeatId = await createFailedHeartbeat(a.id, projectItemId);
      await inTenant(a.id, async (client) => {
        // The mailbox problem as the sync job raised it: a warning, reported by two jobs.
        for (const jobId of ["job-1", "job-2"]) {
          await raiseProblem(client, {
            userId: a.userId,
            category: "mail",
            kind: "mailSyncError",
            severity: "warning",
            sourceTable: "mail_account_sync_state",
            sourceId: mailboxId,
            dedupeKey: mailProblemKey(mailboxId),
            since: new Date("2026-05-01T08:00:00Z"),
            occurrenceKey: jobId,
          });
        }
        for (const occurrenceKey of ["run-1", "run-2", "run-3"]) {
          await raiseAgentHeartbeatProblem(client, { userId: a.userId, heartbeatId, occurrenceKey });
        }
        await createGuidanceProblemWriter().raise(client, {
          userId: a.userId,
          projectItemId,
          fingerprint: "a".repeat(64),
          findingId,
          occurrenceKey: "a:1",
        });
      });
      const raised = await problemsOf(a.id);
      expect(raised.map((problem) => problem.occurrence_count).sort()).toEqual([1, 2, 3]);

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual(raised);
    });

    it("creates no problem for a source whose problem was resolved when the source recovered", async () => {
      const projectItemId = await createItem(a.id, "projects", "Project");
      const heartbeatId = await createFailedHeartbeat(a.id, projectItemId);
      await inTenant(a.id, async (client) => {
        await raiseAgentHeartbeatProblem(client, { userId: a.userId, heartbeatId, occurrenceKey: "run-1" });
        await resolveAgentHeartbeatProblem(client, heartbeatId);
      });
      const resolved = await problemsOf(a.id);
      expect(resolved).toMatchObject([{ resolution_kind: "recovered" }]);

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual(resolved);
    });

    it("creates no problem for a healthy source of any kind", async () => {
      await createMailbox(a.id, { syncStatus: "ok", checkStatus: "ok" });
      const projectItemId = await createItem(a.id, "projects", "Project");
      await createFinding(a, projectItemId, "a".repeat(64)).then((findingId) =>
        inTenant(a.id, (client) => agentGuidanceDriftFindingsStore.resolve(client, findingId, new Date())),
      );
      const movie = await createItem(a.id, "movies", "Movie");
      await inTenant(a.id, async (client) => {
        await ensureItemAutomation(client, movie);
        await markItemAutomationDone(client, movie);
      });

      await backfill(a.id);

      expect(await problemsOf(a.id)).toEqual([]);
    });
  });

  describe("tenants", () => {
    it("skips a tenant without a user", async () => {
      const noUser = await createTenant({ withUser: false });
      await createMailbox(noUser.id, { syncStatus: "error", failureKind: "other" });

      await expect(backfill(noUser.id)).resolves.toBeUndefined();

      expect(await problemsOf(noUser.id)).toEqual([]);
      expect(await notificationCount(noUser.id)).toBe(0);
    });

    it("raises only the problems of the tenant it runs in, for that tenant's user", async () => {
      const b = await createTenant();
      const mailboxA = await createMailbox(a.id, { syncStatus: "error", failureKind: "other" });
      const mailboxB = await createMailbox(b.id, { syncStatus: "error", failureKind: "other" });
      const projectB = await createItem(b.id, "projects", "Project B");
      const heartbeatB = await createFailedHeartbeat(b.id, projectB);

      await backfill(a.id);

      expect(await problemsOf(a.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxA), user_id: a.userId }]);
      expect(await problemsOf(b.id)).toEqual([]);

      await backfill(b.id);

      expect(await problemsOf(a.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxA), user_id: a.userId }]);
      expect(keysOf(await problemsOf(b.id))).toEqual(
        [agentHeartbeatProblemKey(heartbeatB), mailProblemKey(mailboxB)].sort(),
      );
      expect((await problemsOf(b.id)).every((problem) => problem.user_id === b.userId)).toBe(true);
    });
  });

  describe("the tenant cutover migrations", () => {
    it("runs the backfill for every maintained tenant", async () => {
      const b = await createTenant();
      const mailboxA = await createMailbox(a.id, { syncStatus: "error", failureKind: "other" });
      const mailboxB = await createMailbox(b.id, {
        syncStatus: "needsReauthorization",
        failureKind: "reauthorization",
      });

      await runAsSystem("test cutover", () => runTenantCutoverMigrations(runtime));

      expect(await problemsOf(a.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxA), severity: "warning" }]);
      expect(await problemsOf(b.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxB), severity: "critical" }]);
    });

    it("completes the other tenants and the other sources when the backfill of one source of one tenant fails", async () => {
      const b = await createTenant();
      const mailboxA = await createMailbox(a.id, { syncStatus: "error", failureKind: "other" });
      const projectA = await createItem(a.id, "projects", "Project A");
      const heartbeatA = await createFailedHeartbeat(a.id, projectA);
      const mailboxB = await createMailbox(b.id, { syncStatus: "error", failureKind: "other" });
      // The raise of tenant A's mailbox problem fails; its heartbeat and tenant B's mailbox do not.
      mocks.poisoned.add(mailProblemKey(mailboxA));

      const failure = await runAsSystem("test cutover", () => runTenantCutoverMigrations(runtime)).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure instanceof AggregateError ? failure.message : "").toContain(a.id);
      expect(failure instanceof AggregateError ? failure.message : "").not.toContain(b.id);
      const inner = failure instanceof AggregateError ? failure.errors[0] : null;
      expect(inner).toBeInstanceOf(AggregateError);
      expect(inner instanceof AggregateError ? inner.message : "").toContain("mail");
      expect(keysOf(await problemsOf(a.id))).toEqual([agentHeartbeatProblemKey(heartbeatA)]);
      expect(await problemsOf(b.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxB) }]);
    });

    it("raises the problem of the failed source on the next run", async () => {
      const mailboxA = await createMailbox(a.id, { syncStatus: "error", failureKind: "other" });
      mocks.poisoned.add(mailProblemKey(mailboxA));
      await expect(backfill(a.id)).rejects.toBeInstanceOf(AggregateError);
      expect(await problemsOf(a.id)).toEqual([]);
      expect(await notificationCount(a.id)).toBe(0);

      mocks.poisoned.clear();
      await backfill(a.id);

      expect(await problemsOf(a.id)).toMatchObject([{ dedupe_key: mailProblemKey(mailboxA) }]);
    });
  });
});
