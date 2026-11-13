import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { setTenantAiBudget } from "../../aiGateway/tenantAiBudgetsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { agentGuidanceDriftFindingsStore } from "../../guidanceDrift/agentGuidanceDriftFindingsStore.js";
import { createHeartbeat } from "../../scheduler/schedulerStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createGuidanceProblemWriter, resolveGuidanceDriftProblem } from "../guidanceProblemWriter.js";
import { raiseProblem, resolveProblem, type RaiseProblemInput } from "../sempProblemsStore.js";
import { SEMP_RESOLVED_RECENT_LIMIT } from "../sempStatusResolved.js";
import { getSempStatusReport } from "../sempStatusReport.js";
import { createSempStatusRouteHandler } from "../sempStatusRouteHandler.js";
import { getSempStatusSummary } from "../sempStatusSummary.js";
import { agentHeartbeatProblemKey } from "../agentProblemKeys.js";
import {
  BACKUP_RESTORE_PROBLEM_KEY,
  AGENTS_PROCESS_PROBLEM_KEY,
  automationProblemKey,
  guidanceProblemKey,
  mailProblemKey,
} from "../sourceProblemKeys.js";

/**
 * `resolvedRecent` of `GET /api/semp-status` (issue gh-1919). Problems are raised and resolved with the
 * production store functions; a resolution time is moved back with a raw statement only where a test needs
 * a day the clock has not reached. Isolation is asserted through the runtime role pool with two tenants.
 */

const behaviorPayload = {
  kind: "behavior" as const,
  subject: { mcpTool: "search", databaseId: null },
  claim: "Claim",
  evidence: { runIds: ["one", "two", "three"], count: 3 },
  suggestedAllowedLine: "Create tasks from new GitHub issues.",
  suggestedNotAllowedLine: "Do not create tasks.",
  severity: "warning" as const,
};
const permissionPayload = {
  kind: "permission" as const,
  subject: { operation: "item.create", databaseId: null },
  claim: "Claim",
  guidanceExcerpt: "Excerpt",
  manifestFacts: ["Fact"],
  severity: "warning" as const,
};

let admin: Pool;
let data: Pool;
let own: string;
let foreign: string;
let ownUser: string;
let foreignUser: string;

describe("Semp status resolvedRecent (issue gh-1919)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    own = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    const users = await runAsSystem("resolved status test users", () =>
      Promise.all([
        createUser(admin, {
          tenantId: own,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused",
          locale: "en",
        }),
        createUser(admin, {
          tenantId: foreign,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused",
          locale: "cs",
        }),
      ]),
    );
    ownUser = users[0].id;
    foreignUser = users[1].id;
    for (const [tenantId, updatedBy] of [
      [own, ownUser],
      [foreign, foreignUser],
    ] as const) {
      await runInTenant(tenantId, () => seedSystem(data));
      // A tenant without a budget row lists `aiBudgetMissing` first (issue gh-1871); it is not under test here.
      await runAsSystem("resolved status test budget", () =>
        withTransaction(data, (client) =>
          setTenantAiBudget(client, { tenantId, updatedBy, dailyCapUsd: null, monthlyCapUsd: null }),
        ),
      );
    }
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  const read = (tenant: string) => runInTenant(tenant, () => getSempStatusReport(data));

  /** Moves the resolution of one problem back by `days`; the API stamps `now()`, so a past day needs raw SQL. */
  async function resolvedDaysAgo(problemId: string, days: number, extraMinutes = 0) {
    const moved = await admin.query(
      "UPDATE semp_problems SET resolved_at = now() - make_interval(days => $2, mins => $3) WHERE id = $1 AND resolved_at IS NOT NULL",
      [problemId, days, extraMinutes],
    );
    expect(moved.rowCount).toBe(1);
  }

  async function raise(tenant: string, userId: string, input: Omit<RaiseProblemInput, "userId">): Promise<string> {
    return runInTenant(tenant, () =>
      withTransaction(data, async (client) => (await raiseProblem(client, { userId, ...input })).problemId),
    );
  }

  async function resolve(
    tenant: string,
    dedupeKey: string,
    resolutionKind: "recovered" | "sourceDeleted" = "recovered",
  ) {
    const changed = await runInTenant(tenant, () =>
      withTransaction(data, (client) => resolveProblem(client, { dedupeKey, resolutionKind })),
    );
    expect(changed).toBe(true);
  }

  async function createMailbox(tenant: string, name: string) {
    return runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const db = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "mailboxes");
      if (!db) throw new Error("Missing mailboxes database");
      return {
        databaseId: db.id,
        item: await cp.createItem({ databaseId: db.id, properties: { name, provider: "generic" } }),
      };
    });
  }

  async function createProject(tenant: string, name: string) {
    return runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const db = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "projects");
      if (!db) throw new Error("Missing projects database");
      return (await cp.createItem({ databaseId: db.id, properties: { name } })).id;
    });
  }

  /** A mailbox problem resolved the way a successful sync resolves it (`resolveMailboxProblem` of the sync job). */
  async function resolvedMailbox(tenant: string, userId: string, name: string) {
    const { item, databaseId } = await createMailbox(tenant, name);
    const problemId = await raise(tenant, userId, {
      category: "mail",
      kind: "mailSyncError",
      severity: "warning",
      sourceTable: "mail_account_sync_state",
      sourceId: item.id,
      dedupeKey: mailProblemKey(item.id),
    });
    await resolve(tenant, mailProblemKey(item.id));
    return { problemId, itemId: item.id, databaseId };
  }

  it("lists a mailbox problem resolved by a sync as resolved, not active, with the mailbox in its title", async () => {
    const { problemId, itemId } = await resolvedMailbox(own, ownUser, "Inbox");

    const report = await read(own);

    expect(report.problems.map((problem) => problem.id)).toEqual([]);
    expect(report.activeCount).toBe(0);
    expect(report.resolvedRecent).toEqual([
      {
        id: problemId,
        category: "mail",
        resolutionTitle: "Mailbox Inbox is syncing again",
        resolvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
      },
    ]);
    // The title is rendered at read time: no user text was stored with the problem.
    const stored = await admin.query("SELECT * FROM semp_problems WHERE id = $1", [problemId]);
    expect(JSON.stringify(stored.rows)).not.toContain("Inbox");
    expect(JSON.stringify(report.resolvedRecent)).not.toContain(itemId);
  });

  it("returns a problem resolved three days ago and not one resolved eight days ago", async () => {
    const recent = await resolvedMailbox(own, ownUser, "Recent");
    const old = await resolvedMailbox(own, ownUser, "Old");
    await resolvedDaysAgo(recent.problemId, 3);
    await resolvedDaysAgo(old.problemId, 8);

    const report = await read(own);

    expect(report.resolvedRecent.map((entry) => entry.id)).toEqual([recent.problemId]);
    expect(report.resolvedRecent[0]?.resolutionTitle).toBe("Mailbox Recent is syncing again");
  });

  it("keeps a problem resolved just inside seven days and drops one just outside", async () => {
    const inside = await resolvedMailbox(own, ownUser, "Inside");
    const outside = await resolvedMailbox(own, ownUser, "Outside");
    await resolvedDaysAgo(inside.problemId, 6, 23 * 60);
    await resolvedDaysAgo(outside.problemId, 7, 5);

    const report = await read(own);

    expect(report.resolvedRecent.map((entry) => entry.id)).toEqual([inside.problemId]);
  });

  it("orders the resolved problems newest first", async () => {
    const first = await resolvedMailbox(own, ownUser, "First");
    const second = await resolvedMailbox(own, ownUser, "Second");
    const third = await resolvedMailbox(own, ownUser, "Third");
    await resolvedDaysAgo(first.problemId, 5);
    await resolvedDaysAgo(second.problemId, 1);
    await resolvedDaysAgo(third.problemId, 3);

    const report = await read(own);

    expect(report.resolvedRecent.map((entry) => entry.id)).toEqual([
      second.problemId,
      third.problemId,
      first.problemId,
    ]);
    const instants = report.resolvedRecent.map((entry) => Date.parse(entry.resolvedAt));
    expect(instants).toEqual([...instants].sort((a, b) => b - a));
  });

  it("does not list a problem closed because its source was deleted, and lists the recovered one beside it", async () => {
    const { item } = await createMailbox(own, "Gone");
    await raise(own, ownUser, {
      category: "mail",
      kind: "mailSyncError",
      severity: "warning",
      sourceTable: "mail_account_sync_state",
      sourceId: item.id,
      dedupeKey: mailProblemKey(item.id),
    });
    await resolve(own, mailProblemKey(item.id), "sourceDeleted");
    const kept = await resolvedMailbox(own, ownUser, "Kept");

    const report = await read(own);

    expect(report.resolvedRecent.map((entry) => entry.id)).toEqual([kept.problemId]);
    expect(JSON.stringify(report.resolvedRecent)).not.toContain("Gone");
  });

  it("lists a problem that was resolved and raised again under two ids, one resolved and one active", async () => {
    const { item } = await createMailbox(own, "Flaky");
    const input = {
      category: "mail" as const,
      kind: "mailSyncError",
      severity: "warning" as const,
      sourceTable: "mail_account_sync_state",
      sourceId: item.id,
      dedupeKey: mailProblemKey(item.id),
    };
    const firstId = await raise(own, ownUser, input);
    await resolve(own, input.dedupeKey);
    const secondId = await raise(own, ownUser, input);

    const report = await read(own);

    expect(secondId).not.toBe(firstId);
    expect(report.problems.map((problem) => problem.id)).toEqual([secondId]);
    expect(report.resolvedRecent.map((entry) => entry.id)).toEqual([firstId]);
    expect(report.activeCount).toBe(1);
  });

  it("returns only the tenant's own problems, in the tenant's own locale", async () => {
    const mine = await resolvedMailbox(own, ownUser, "Mine");
    const theirs = await resolvedMailbox(foreign, foreignUser, "Theirs");

    const en = await read(own);
    const cs = await runInTenant(foreign, () => createSempStatusRouteHandler(data)());

    expect(en.resolvedRecent.map((entry) => entry.id)).toEqual([mine.problemId]);
    expect(JSON.stringify(en)).not.toContain(theirs.problemId);
    expect(JSON.stringify(en)).not.toContain("Theirs");
    expect(cs.status).toBe(200);
    expect(cs.body.resolvedRecent).toEqual([
      expect.objectContaining({ id: theirs.problemId, resolutionTitle: "Schránka Theirs se opět synchronizuje" }),
    ]);
    expect(JSON.stringify(cs.body)).not.toContain(mine.problemId);
    expect(JSON.stringify(cs.body)).not.toContain("Mine");
  });

  it("answers an empty list when nothing was resolved", async () => {
    expect((await read(own)).resolvedRecent).toEqual([]);
  });

  it("lists at most the 100 newest", async () => {
    const ids: string[] = [];
    await runInTenant(own, () =>
      withTransaction(data, async (client) => {
        for (let i = 0; i < SEMP_RESOLVED_RECENT_LIMIT + 1; i++) {
          const dedupeKey = `fixture:bulk:${i}`;
          ids.push(
            (
              await raiseProblem(client, {
                userId: ownUser,
                category: "backup",
                kind: "backupRestore",
                severity: "warning",
                sourceTable: "observability_checks",
                sourceId: randomUUID(),
                dedupeKey,
              })
            ).problemId,
          );
          await resolveProblem(client, { dedupeKey, resolutionKind: "recovered" });
        }
      }),
    );
    // Raw SQL: the API stamps `now()`; the fixture needs a distinct, known age for each of the 101 rows.
    await admin.query(
      `UPDATE semp_problems SET resolved_at = now() - make_interval(mins => ord.n::int)
         FROM unnest($1::uuid[]) WITH ORDINALITY AS ord(id, n) WHERE semp_problems.id = ord.id`,
      [ids],
    );

    const report = await read(own);

    expect(report.resolvedRecent).toHaveLength(SEMP_RESOLVED_RECENT_LIMIT);
    expect(report.resolvedRecent.map((entry) => entry.id)).toEqual(ids.slice(0, SEMP_RESOLVED_RECENT_LIMIT));
    expect(report.resolvedRecent.map((entry) => entry.id)).not.toContain(ids[SEMP_RESOLVED_RECENT_LIMIT]);
  });

  describe("titles by problem kind", () => {
    /** Resolves one problem per supported kind and returns the titles in `locale` keyed by a label. */
    async function titlesOfEveryKind(tenant: string, userId: string) {
      const byLabel = new Map<string, string>();
      const mailbox = await resolvedMailbox(tenant, userId, "Inbox");
      byLabel.set("mail", mailbox.problemId);

      const projectId = await createProject(tenant, "Home");
      const heartbeat = await runInTenant(tenant, () =>
        withTransaction(data, (client) =>
          createHeartbeat(client, {
            projectItemId: projectId,
            name: "Daily digest",
            rule: { kind: "interval", minutes: 5 },
            actionId: "noop",
          }),
        ),
      );
      byLabel.set(
        "heartbeat",
        await raise(tenant, userId, {
          category: "agents",
          kind: "agentHeartbeat",
          severity: "warning",
          sourceTable: "project_heartbeats",
          sourceId: heartbeat.id,
          dedupeKey: agentHeartbeatProblemKey(heartbeat.id),
          projectItemId: projectId,
        }),
      );
      await resolve(tenant, agentHeartbeatProblemKey(heartbeat.id));

      // The reply-problem producer is delivered later; these rows are a synthetic source fixture, as in
      // sempStatusReport.test.ts.
      const messageId = await runInTenant(tenant, () =>
        withTransaction(data, async (client) => {
          const thread = await client.query<{ id: string }>(
            "INSERT INTO semp_threads (kind, title) VALUES ('chat', 'Client meeting summary') RETURNING id",
          );
          const message = await client.query<{ id: string }>(
            "INSERT INTO semp_messages (thread_id, role, status, text) VALUES ($1, 'assistant', 'error', 'private') RETURNING id",
            [thread.rows[0]!.id],
          );
          return message.rows[0]!.id;
        }),
      );
      byLabel.set(
        "reply",
        await raise(tenant, userId, {
          category: "agents",
          kind: "reply",
          severity: "warning",
          sourceTable: "semp_messages",
          sourceId: messageId,
          dedupeKey: `agents:reply:${messageId}`,
        }),
      );
      await resolve(tenant, `agents:reply:${messageId}`);

      for (const [label, payload, fingerprint] of [
        ["guidancePermission", permissionPayload, "a".repeat(64)],
        ["guidanceBehavior", behaviorPayload, "b".repeat(64)],
      ] as const) {
        await runInTenant(tenant, () =>
          withTransaction(data, async (client) => {
            const { finding } = await agentGuidanceDriftFindingsStore.upsertActive(client, {
              projectItemId: projectId,
              fingerprint,
              payload,
              seenAt: new Date("2026-01-01T00:00:00Z"),
            });
            await createGuidanceProblemWriter().raise(client, {
              userId,
              projectItemId: projectId,
              fingerprint,
              findingId: finding.id,
              occurrenceKey: `${fingerprint}:1`,
            });
            byLabel.set(
              label,
              (
                await client.query<{ id: string }>(
                  "SELECT id FROM semp_problems WHERE dedupe_key = $1 AND resolved_at IS NULL",
                  [guidanceProblemKey(projectId, fingerprint)],
                )
              ).rows[0]!.id,
            );
            await resolveGuidanceDriftProblem(client, { projectItemId: projectId, fingerprint });
          }),
        );
      }

      const books = await runInTenant(tenant, () => createChokePoint(data).createDatabase({ name: "Books" }));
      const bookItem = await runInTenant(tenant, () =>
        createChokePoint(data).createItem({ databaseId: books.id, properties: {} }),
      );
      byLabel.set(
        "library",
        await raise(tenant, userId, {
          category: "automation",
          kind: "libraryAutomation",
          severity: "warning",
          sourceTable: "item_automation",
          sourceId: bookItem.id,
          dedupeKey: automationProblemKey(books.id),
        }),
      );
      await resolve(tenant, automationProblemKey(books.id));

      const transcriptsDb = (await runInTenant(tenant, () => createChokePoint(data).listDatabases())).find(
        (entry) => entry.ownerModuleId === "transcripts",
      );
      if (!transcriptsDb) throw new Error("Missing transcripts database");
      const transcript = await runInTenant(tenant, () =>
        createChokePoint(data).createItem({ databaseId: transcriptsDb.id, properties: { name: "Quarterly planning" } }),
      );
      byLabel.set(
        "transcription",
        await raise(tenant, userId, {
          category: "transcription",
          kind: "transcriptionFailed",
          severity: "warning",
          sourceTable: "item_automation",
          sourceId: transcript.id,
          dedupeKey: `transcription:${transcript.id}`,
        }),
      );
      await resolve(tenant, `transcription:${transcript.id}`);

      byLabel.set(
        "backup",
        await raise(tenant, userId, {
          category: "backup",
          kind: "backupRestore",
          severity: "warning",
          sourceTable: "observability_checks",
          sourceId: randomUUID(),
          dedupeKey: BACKUP_RESTORE_PROBLEM_KEY,
        }),
      );
      await resolve(tenant, BACKUP_RESTORE_PROBLEM_KEY);

      byLabel.set(
        "process",
        await raise(tenant, userId, {
          category: "agents",
          kind: "processStale",
          severity: "critical",
          sourceTable: "observability_checks",
          sourceId: randomUUID(),
          dedupeKey: AGENTS_PROCESS_PROBLEM_KEY,
        }),
      );
      await resolve(tenant, AGENTS_PROCESS_PROBLEM_KEY);

      const runKey = `agents:run:${randomUUID()}`;
      byLabel.set(
        "run",
        await raise(tenant, userId, {
          category: "agents",
          kind: "agentRun",
          severity: "warning",
          sourceTable: "agent_runs",
          sourceId: randomUUID(),
          dedupeKey: runKey,
        }),
      );
      await resolve(tenant, runKey);

      const report = await read(tenant);
      const titles: Record<string, string | undefined> = {};
      for (const [label, id] of byLabel)
        titles[label] = report.resolvedRecent.find((entry) => entry.id === id)?.resolutionTitle;
      return titles;
    }

    it("renders the catalog title of every kind in English, with names read from the sources", async () => {
      expect(await titlesOfEveryKind(own, ownUser)).toEqual({
        mail: "Mailbox Inbox is syncing again",
        heartbeat: "Automatic task 'Daily digest' ran successfully",
        reply: "Task 'Client meeting summary' completed",
        guidancePermission: "Instructions of project Home match the permissions again",
        guidanceBehavior: "Instructions of project Home match what Semp does again",
        library: "Automation of Books works again",
        transcription: "Transcript 'Quarterly planning' completed",
        backup: "Monthly backup restore test passed",
        process: "Semp is running again",
        run: "A problem was resolved",
      });
    });

    it("renders the catalog title of every kind in Czech when the tenant's user locale is Czech", async () => {
      expect(await titlesOfEveryKind(foreign, foreignUser)).toEqual({
        mail: "Schránka Inbox se opět synchronizuje",
        heartbeat: "Automatický úkol „Daily digest“ proběhl úspěšně",
        reply: "Úkol „Client meeting summary“ byl dokončen",
        guidancePermission: "Pokyny projektu Home opět odpovídají oprávněním",
        guidanceBehavior: "Pokyny projektu Home opět odpovídají tomu, co Semp dělá",
        library: "Automatizace v databázi Books opět funguje",
        transcription: "Přepis „Quarterly planning“ byl dokončen",
        backup: "Měsíční test obnovy ze zálohy proběhl úspěšně",
        process: "Semp opět běží",
        run: "Problém byl vyřešen",
      });
    });
  });

  it("writes the neutral word for a source that was deleted after the problem resolved", async () => {
    const english = await resolvedMailbox(own, ownUser, "Deleted later");
    await runInTenant(own, () => createChokePoint(data).softDeleteItem(english.databaseId, english.itemId));
    const czech = await resolvedMailbox(foreign, foreignUser, "Gone");
    await runInTenant(foreign, () => createChokePoint(data).softDeleteItem(czech.databaseId, czech.itemId));

    const englishTitles = (await read(own)).resolvedRecent;
    const czechTitles = (await read(foreign)).resolvedRecent;

    expect(englishTitles).toEqual([
      expect.objectContaining({ id: english.problemId, resolutionTitle: "Mailbox (unnamed) is syncing again" }),
    ]);
    expect(czechTitles).toEqual([
      expect.objectContaining({ id: czech.problemId, resolutionTitle: "Schránka (bez názvu) se opět synchronizuje" }),
    ]);
  });

  it("runs the resolved read for the full endpoint only, not for the summary the overview also reads", async () => {
    await resolvedMailbox(own, ownUser, "Inbox");

    /** The statements a read sends, on every client the pool hands out during it. */
    async function statementsOf<T>(run: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
      const spies: Array<{ mock: { calls: unknown[][] }; mockRestore(): void }> = [];
      const observe = (client: PoolClient) => {
        spies.push(vi.spyOn(client, "query"));
      };
      data.on("acquire", observe);
      try {
        const result = await run();
        const statements = spies
          .flatMap((spy) => spy.mock.calls)
          .map((call) => (typeof call[0] === "string" ? call[0] : JSON.stringify(call[0])));
        return { result, statements };
      } finally {
        data.off("acquire", observe);
        for (const spy of spies) spy.mockRestore();
      }
    }
    const readsResolved = (statement: string) => statement.includes("resolved_at IS NOT NULL");

    const summary = await statementsOf(() => runInTenant(own, () => getSempStatusSummary(data)));
    expect(summary.result).toEqual({ activeCount: 0, banner: null });
    expect(summary.statements.some(readsResolved)).toBe(false);

    const full = await statementsOf(() => read(own));
    expect(full.result.resolvedRecent).toHaveLength(1);
    expect(full.statements.filter(readsResolved)).toHaveLength(1);
  });

  it("reads the names in a constant number of statements however many problems are listed", async () => {
    async function resolveOneOfEach(tenant: string, userId: string, index: number) {
      await resolvedMailbox(tenant, userId, `Mailbox ${index}`);
      const projectId = await createProject(tenant, `Project ${index}`);
      const heartbeat = await runInTenant(tenant, () =>
        withTransaction(data, (client) =>
          createHeartbeat(client, {
            projectItemId: projectId,
            name: `Heartbeat ${index}`,
            rule: { kind: "interval", minutes: 5 },
            actionId: "noop",
          }),
        ),
      );
      const fingerprint = `${index}`.padStart(64, "c");
      const messageId = await runInTenant(tenant, () =>
        withTransaction(data, async (client) => {
          const thread = await client.query<{ id: string }>(
            "INSERT INTO semp_threads (kind, title) VALUES ('chat', $1) RETURNING id",
            [`Thread ${index}`],
          );
          const message = await client.query<{ id: string }>(
            "INSERT INTO semp_messages (thread_id, role, status, text) VALUES ($1, 'assistant', 'error', 'x') RETURNING id",
            [thread.rows[0]!.id],
          );
          const finding = await agentGuidanceDriftFindingsStore.upsertActive(client, {
            projectItemId: projectId,
            fingerprint,
            payload: permissionPayload,
            seenAt: new Date("2026-01-01T00:00:00Z"),
          });
          await createGuidanceProblemWriter().raise(client, {
            userId,
            projectItemId: projectId,
            fingerprint,
            findingId: finding.finding.id,
            occurrenceKey: `${fingerprint}:1`,
          });
          await resolveGuidanceDriftProblem(client, { projectItemId: projectId, fingerprint });
          return message.rows[0]!.id;
        }),
      );
      const database = await runInTenant(tenant, () =>
        createChokePoint(data).createDatabase({ name: `Database ${index}` }),
      );
      const sources = [
        {
          kind: "agentHeartbeat",
          category: "agents",
          table: "project_heartbeats",
          id: heartbeat.id,
          key: agentHeartbeatProblemKey(heartbeat.id),
        },
        { kind: "reply", category: "agents", table: "semp_messages", id: messageId, key: `agents:reply:${messageId}` },
        {
          kind: "libraryAutomation",
          category: "automation",
          table: "item_automation",
          id: randomUUID(),
          key: automationProblemKey(database.id),
        },
      ] as const;
      for (const source of sources) {
        await raise(tenant, userId, {
          category: source.category,
          kind: source.kind,
          severity: "warning",
          sourceTable: source.table,
          sourceId: source.id,
          dedupeKey: source.key,
        });
        await resolve(tenant, source.key);
      }
    }

    async function count(expected: number) {
      const spies: Array<{ mock: { calls: unknown[][] }; mockRestore(): void }> = [];
      const observe = (client: PoolClient) => {
        spies.push(vi.spyOn(client, "query"));
      };
      data.on("acquire", observe);
      try {
        const report = await read(own);
        expect(report.resolvedRecent).toHaveLength(expected);
        return spies.flatMap((spy) => spy.mock.calls).length;
      } finally {
        data.off("acquire", observe);
        for (const spy of spies) spy.mockRestore();
      }
    }

    await resolveOneOfEach(own, ownUser, 0);
    // One round resolves five problems: a mailbox, a heartbeat, a reply, a guidance finding and a library
    // automation, so every batched name query runs in both measurements.
    const perRound = 5;
    const one = await count(perRound);
    for (let i = 1; i < 6; i++) await resolveOneOfEach(own, ownUser, i);
    expect(await count(perRound * 6)).toBe(one);
    const report = await read(own);
    expect(report.resolvedRecent.map((entry) => entry.resolutionTitle)).toEqual(
      expect.arrayContaining([
        "Mailbox Mailbox 5 is syncing again",
        "Task 'Thread 5' completed",
        "Automation of Database 5 works again",
      ]),
    );
  });
});
