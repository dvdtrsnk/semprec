import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { z } from "zod";
import { getAiUsageSummary } from "../aiGateway/aiUsageSummary.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { readRestoreTestOutcome, RESTORE_TEST_CHECK_KEY } from "../observability/restoreTestResult.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { readSempResolvedRecent } from "./sempStatusResolved.js";
import { readTranscriptionQueueCounts } from "./sempTranscriptionQueue.js";

const problemSchema = z.object({
  id: z.uuid(),
  category: z.enum(["mail", "agents", "guidance", "automation", "transcription", "backup"]),
  kind: z.string(),
  severity: z.enum(["critical", "warning"]),
  source_table: z.string(),
  source_id: z.uuid(),
  project_item_id: z.uuid().nullable(),
  dedupe_key: z.string(),
  occurrence_count: z.number().int(),
  first_seen_at: z.date(),
});
const kinds = new Set([
  "mailSyncError",
  "agentHeartbeat",
  "agentRun",
  "reply",
  "guidanceDrift",
  "libraryAutomation",
  "backupRestore",
  "processStale",
  "transcriptionFailed",
]);
const causes = new Set(["budgetExceeded", "modelError", "cancelled", "interrupted", "internal"]);
type StatusAction = { kind: string; target: string | { threadId: string; messageId: string } };

/**
 * The AI budget problem of the current tenant (issue gh-1871), or null when there is none. It is
 * derived on every read from the budget summary of issue gh-1456 and has no `semp_problems` row
 * (docs/adr/2026-11-10-semp-status-problems-derived-at-read-time.md): `aiBudgetMissing` while the
 * tenant has no budget row, `aiBudgetExhausted` while a cap of its own is reached. The summary sets
 * `resetsAt` exactly while a window is exhausted, so that field alone selects the second problem.
 * The summary does not read the operator-wide caps, so reaching them produces no problem.
 *
 * `id` is the problem key, followed for an exhausted window by its reset instant, so the next
 * exhausted window is a different problem to a client. `replacements.resetTime` is that instant in
 * the tenant's time zone, written in `language`.
 *
 * Luxon writes the reset time, because the settings writer validates the zone with Luxon
 * (`assertValidTimezone`): a fixed offset such as `UTC+2` is a zone a tenant can store, and
 * `Intl.DateTimeFormat` throws for it as a `timeZone`. The zone is validated only for an exhausted
 * window, where the text needs it: a stored zone Luxon cannot read throws `ValidationError` then,
 * instead of putting "Invalid DateTime" into the text.
 */
async function readAiBudgetProblem(
  client: PoolClient,
  language: "cs" | "en",
): Promise<{ id: string; kind: "aiBudgetMissing" | "aiBudgetExhausted"; replacements: Record<string, string> } | null> {
  const usage = await getAiUsageSummary(client);
  if (!usage.hasBudget) return { id: "aiBudgetMissing", kind: "aiBudgetMissing", replacements: {} };
  if (usage.resetsAt === null) return null;
  const zone = await getSystemTimezone(client);
  assertValidTimezone(zone);
  const resetTime = DateTime.fromISO(usage.resetsAt, { zone, locale: language }).toLocaleString({
    dateStyle: "long",
    timeStyle: "short",
  });
  return { id: `aiBudgetExhausted:${usage.resetsAt}`, kind: "aiBudgetExhausted", replacements: { resetTime } };
}

/**
 * The Semp status report of the current tenant (issue #1555), together with the stored `kind` of
 * every stored problem it lists, keyed by problem id. The summary (issue #1631) derives its banner
 * from this same read, so the count, the order and the rendered text have one source.
 *
 * The list starts with the AI budget problem when the tenant has one (`readAiBudgetProblem`), which
 * is derived in this read and written nowhere. The stored active problems follow, `critical` first,
 * then the latest `last_seen_at`. `activeCount` counts both. `services` take their state from the
 * stored problems only; the `transcription` service also carries the tenant's queued and running
 * transcription jobs as its `detail` (issue gh-1945, `readTranscriptionQueueCounts`) and no
 * `lastActivityAt`. The report does not carry `resolvedRecent`: only the full endpoint lists the
 * problems resolved in the last seven days (`getSempStatusReport`, issue gh-1919), so the summary
 * and the overview, which read only the count and the banner, never run the resolved read.
 */
export async function readSempStatusReport(pool: Pool) {
  const { report, problemKinds } = await readSempStatus(pool, async () => null);
  return { report, problemKinds };
}

/**
 * The one transaction behind `readSempStatusReport` and `getSempStatusReport`. `readExtra` runs last,
 * in the same transaction, so the full endpoint reads its extra list from the same snapshot as the
 * active problems; the summary passes a reader that reads nothing.
 */
async function readSempStatus<Extra>(
  pool: Pool,
  readExtra: (client: PoolClient, catalogs: ModuleCatalogs, language: "cs" | "en") => Promise<Extra>,
) {
  const catalogs = await loadModuleCatalogs(import.meta.url);
  const mailCatalogs = await loadModuleCatalogs(new URL("../mail/mailModuleManifest.js", import.meta.url).href);
  return withTransaction(pool, async (client) => {
    const locale = await getTenantUserLocale(client);
    const rows = await client.query<Record<string, unknown>>(
      `SELECT id, category, kind, severity, source_table, source_id, project_item_id, dedupe_key, occurrence_count, first_seen_at
       FROM semp_problems WHERE tenant_id = app_tenant_default() AND resolved_at IS NULL
       ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, last_seen_at DESC, id DESC`,
    );
    const problems = z.array(problemSchema).parse(rows.rows);
    const mailboxRows = await client.query<Record<string, unknown>>(
      `SELECT i.id, i.properties->>'name' AS name, i.properties->>'provider' AS provider, s.last_activity_at
       FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
       LEFT JOIN mail_account_sync_state s ON s.item_id = i.id AND s.tenant_id = i.tenant_id
       WHERE i.tenant_id = app_tenant_default() AND d.owner_module_id = 'mailboxes' AND i.deleted_at IS NULL
       ORDER BY i.id`,
    );
    const mailboxes = z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string().nullable(),
          provider: z.string().nullable(),
          last_activity_at: z.date().nullable(),
        }),
      )
      .parse(mailboxRows.rows);
    const latestRun = await client.query<Record<string, unknown>>(
      `SELECT max(started_at) AS last_activity_at FROM agent_runs WHERE tenant_id = app_tenant_default()`,
    );
    const latestActivity = z.object({ last_activity_at: z.date().nullable() }).parse(latestRun.rows[0]);
    const backupRows = await client.query<Record<string, unknown>>(
      `SELECT status, detail FROM observability_checks WHERE check_key = $1`,
      [RESTORE_TEST_CHECK_KEY],
    );
    const backup = backupRows.rows[0];
    const backupDetail = backup
      ? readRestoreTestOutcome(
          z.record(z.string(), z.unknown()).parse(backup.detail),
          z.enum(["ok", "alerting"]).parse(backup.status),
        )
      : null;
    const keyedId = (key: string, prefix: string): string | null => {
      if (!key.startsWith(prefix)) return null;
      const parsed = z.string().uuid().safeParse(key.slice(prefix.length));
      return parsed.success ? parsed.data : null;
    };
    const ids = [...new Set(problems.flatMap((p) => [p.source_id, ...(p.project_item_id ? [p.project_item_id] : [])]))];
    const items = new Map((await getItemsByIds(client, ids)).map((item) => [item.id, item]));
    const heartbeats = await client.query<Record<string, unknown>>(
      `SELECT h.id, h.origin, h.enabled, t.id AS thread_id, r.id AS run_id, r.error_code
       FROM project_heartbeats h
       LEFT JOIN semp_threads t ON t.tenant_id = h.tenant_id AND t.heartbeat_id = h.id AND t.kind = 'tick'
       LEFT JOIN LATERAL (SELECT id, error_code FROM agent_runs ar WHERE ar.tenant_id = h.tenant_id AND ar.heartbeat_id = h.id AND ar.status = 'error' ORDER BY ar.started_at DESC, ar.attempt DESC, ar.id DESC LIMIT 1) r ON true
       WHERE h.tenant_id = app_tenant_default() AND h.id = ANY($1::uuid[])`,
      [
        problems.flatMap((p) =>
          p.kind === "agentHeartbeat"
            ? [keyedId(p.dedupe_key, "agents:heartbeat:")].filter((id): id is string => id !== null)
            : [],
        ),
      ],
    );
    const messages = await client.query<Record<string, unknown>>(
      `SELECT m.id, m.thread_id, t.title AS thread_title, r.error_code FROM semp_messages m
       JOIN semp_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
       LEFT JOIN agent_runs r ON r.tenant_id = m.tenant_id AND r.id = m.agent_run_id
       WHERE m.tenant_id = app_tenant_default() AND m.id = ANY($1::uuid[])`,
      [problems.filter((p) => p.kind === "reply").map((p) => p.source_id)],
    );
    const runs = await client.query<Record<string, unknown>>(
      `WITH RECURSIVE chain AS (
         SELECT r.id AS root, r.id, r.thread_id, r.error_code, r.status, r.started_at FROM agent_runs r
          WHERE r.tenant_id = app_tenant_default() AND r.id = ANY($1::uuid[])
         UNION
         SELECT c.root, r.id, r.thread_id, r.error_code, r.status, r.started_at FROM chain c
          JOIN agent_runs r ON r.retry_of_run_id = c.id AND r.tenant_id = app_tenant_default()
       ) SELECT DISTINCT ON (root) root, id, thread_id, error_code FROM chain WHERE status = 'error' ORDER BY root, started_at DESC, id DESC`,
      [
        problems.flatMap((p) =>
          p.kind === "agentRun" ? [keyedId(p.dedupe_key, "agents:run:")].filter((id): id is string => id !== null) : [],
        ),
      ],
    );
    const heartbeatById = new Map(
      z
        .array(
          z.object({
            id: z.uuid(),
            origin: z.string(),
            enabled: z.boolean(),
            thread_id: z.uuid().nullable(),
            run_id: z.uuid().nullable(),
            error_code: z.string().nullable(),
          }),
        )
        .parse(heartbeats.rows)
        .map((row) => [row.id, row]),
    );
    const messageById = new Map(
      z
        .array(
          z.object({
            id: z.uuid(),
            thread_id: z.uuid(),
            thread_title: z.string().nullable(),
            error_code: z.string().nullable(),
          }),
        )
        .parse(messages.rows)
        .map((row) => [row.id, row]),
    );
    const runById = new Map(
      z
        .array(
          z.object({ root: z.uuid(), id: z.uuid(), thread_id: z.uuid().nullable(), error_code: z.string().nullable() }),
        )
        .parse(runs.rows)
        .map((row) => [row.root, row]),
    );
    const budgetProblem = await readAiBudgetProblem(client, locale === "cs" ? "cs" : "en");
    const label = (key: string) =>
      resolveCatalogLabel(undefined, locale === "cs" ? catalogs.cs : catalogs.en, catalogs.en, key);
    const renderLabel = (key: string, replacements: Record<string, string>) =>
      label(key)
        .replace(/\{(\w+)\}/g, (_, name: string) => replacements[name] ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const itemName = (id: string | null) => {
      const name = id ? items.get(id)?.properties.name : undefined;
      return typeof name === "string" ? name : "";
    };
    const serviceState = (key: string) => {
      const matching = problems.filter((problem) =>
        key.startsWith("mail:") ? problem.category === "mail" && problem.dedupe_key === key : problem.category === key,
      );
      const first = matching.reduce<Date | null>(
        (earliest, problem) => (!earliest || problem.first_seen_at < earliest ? problem.first_seen_at : earliest),
        null,
      );
      return { state: first ? "error" : "ok", since: first?.toISOString() ?? null };
    };
    const providers = new Set(["gmail", "outlook", "icloud", "generic"]);
    const services = [
      {
        key: "agents",
        name: label("status.service.agents"),
        ...serviceState("agents"),
        lastActivityAt: latestActivity.last_activity_at?.toISOString() ?? null,
        detail: null,
      },
      ...mailboxes.map((mailbox) => {
        const key = `mail:${mailbox.id}`;
        const provider =
          mailbox.provider && providers.has(mailbox.provider)
            ? resolveCatalogLabel(
                undefined,
                locale === "cs" ? mailCatalogs.cs : mailCatalogs.en,
                mailCatalogs.en,
                `property.mailboxes.provider.option.${mailbox.provider}`,
              )
            : "";
        return {
          key,
          name: label("status.service.mail")
            .replace("{name}", mailbox.name ?? "")
            .replace("{provider}", provider),
          ...serviceState(key),
          lastActivityAt: mailbox.last_activity_at?.toISOString() ?? null,
          detail: null,
        };
      }),
      {
        key: "transcription",
        name: label("status.service.transcription"),
        ...serviceState("transcription"),
        lastActivityAt: null,
        detail: await readTranscriptionQueueCounts(client),
      },
      {
        key: "backup",
        name: label("status.service.backup"),
        ...serviceState("backup"),
        lastActivityAt: backupDetail?.lastTestAt ?? null,
        detail: backupDetail,
      },
    ];
    const stored = {
      activeCount: problems.length,
      services,
      problems: problems.map((problem) => {
        const heartbeatId = keyedId(problem.dedupe_key, "agents:heartbeat:");
        const runId = keyedId(problem.dedupe_key, "agents:run:");
        const heartbeat = heartbeatId ? heartbeatById.get(heartbeatId) : undefined;
        const message = messageById.get(problem.source_id);
        const run = runId ? runById.get(runId) : undefined;
        const kind = kinds.has(problem.kind) ? problem.kind : "unknown";
        const rawCause = heartbeat?.error_code ?? message?.error_code ?? run?.error_code;
        const cause = rawCause && causes.has(rawCause) ? rawCause : "generic";
        const projectName = itemName(problem.project_item_id);
        const replacements: Record<string, string> = {
          sourceName: itemName(problem.source_id),
          projectName,
          threadName: message?.thread_title ?? "",
          cause: label(`status.cause.${cause}`),
        };
        const render = (field: "title" | "text" | "shortText") => {
          const catalogField = kind === "reply" && field === "text" && !message?.thread_title ? "textUnnamed" : field;
          return renderLabel(`status.${kind}.${catalogField}`, replacements);
        };
        const actions: StatusAction[] = [];
        if (kind === "mailSyncError") actions.push({ kind: "reauthMailbox", target: problem.source_id });
        if (kind === "reply" && message)
          actions.push(
            { kind: "retryPrompt", target: message.id },
            { kind: "openChat", target: { threadId: message.thread_id, messageId: message.id } },
          );
        if (kind === "agentHeartbeat" && heartbeat) {
          if (heartbeat.run_id) actions.push({ kind: "retryRun", target: heartbeat.run_id });
          if (heartbeat.thread_id) actions.push({ kind: "openThread", target: heartbeat.thread_id });
          if (heartbeat.origin === "user" && heartbeat.enabled)
            actions.push({ kind: "disableHeartbeat", target: heartbeat.id });
        }
        if (kind === "agentRun" && run) {
          actions.push({ kind: "retryRun", target: run.id });
          if (run.thread_id) actions.push({ kind: "openThread", target: run.thread_id });
        }
        if (kind === "transcriptionFailed") actions.push({ kind: "retryTranscription", target: problem.source_id });
        if (kind === "guidanceDrift" && problem.project_item_id)
          actions.push({ kind: "openProject", target: problem.project_item_id });
        return {
          id: problem.id,
          category: problem.category,
          severity: problem.severity,
          title: render("title"),
          text: render("text"),
          shortText: render("shortText"),
          since: problem.first_seen_at.toISOString(),
          mergedCount: problem.occurrence_count,
          projectName: projectName || null,
          source: { table: problem.source_table, id: problem.source_id },
          affectedService: problem.category,
          actions,
        };
      }),
    };
    const derivedProblems = budgetProblem
      ? [
          {
            id: budgetProblem.id,
            category: "agents" as const,
            severity: "critical" as const,
            title: renderLabel(`status.${budgetProblem.kind}.title`, budgetProblem.replacements),
            text: renderLabel(`status.${budgetProblem.kind}.text`, budgetProblem.replacements),
            shortText: renderLabel(`status.${budgetProblem.kind}.shortText`, budgetProblem.replacements),
            since: null,
            mergedCount: 1,
            projectName: null,
            source: { table: "tenant_ai_budgets", id: null },
            affectedService: "agents" as const,
            actions: [] as StatusAction[],
          },
        ]
      : [];
    const report = {
      ...stored,
      activeCount: derivedProblems.length + stored.activeCount,
      problems: [...derivedProblems, ...stored.problems],
    };
    const extra = await readExtra(client, catalogs, locale === "cs" ? "cs" : "en");
    return { report, extra, problemKinds: new Map(problems.map((problem) => [problem.id, problem.kind])) };
  });
}

/**
 * The body of `GET /api/semp-status`: the report and `resolvedRecent`, the problems resolved in the last
 * seven days with their resolution titles (issue gh-1919, `readSempResolvedRecent`). `resolvedRecent`
 * is not part of `activeCount`.
 */
export async function getSempStatusReport(pool: Pool) {
  const { report, extra } = await readSempStatus(pool, readSempResolvedRecent);
  return { ...report, resolvedRecent: extra };
}
