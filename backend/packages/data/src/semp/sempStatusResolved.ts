import type { PoolClient } from "pg";
import type { ModuleCatalogs } from "@semprec/module-registry";
import { z } from "zod";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { renderResolutionTitle, type ResolutionTitleParams } from "./sempResolutionTitles.js";
import type { SempProblemCategory } from "./sempProblemsStore.js";

/** How long a resolved problem stays in `resolvedRecent`. */
export const SEMP_RESOLVED_RECENT_DAYS = 7;

export const SEMP_RESOLVED_RECENT_LIMIT = 100;

/** Left out of `resolvedRecent`: the source was deleted, so there was no recovery to report. */
const SOURCE_DELETED_RESOLUTION_KIND = "sourceDeleted";

const categories = [
  "mail",
  "agents",
  "guidance",
  "automation",
  "transcription",
  "backup",
] as const satisfies readonly SempProblemCategory[];

const resolvedRowSchema = z.object({
  id: z.uuid(),
  category: z.enum(categories),
  kind: z.string(),
  resolution_kind: z.string(),
  source_id: z.uuid(),
  dedupe_key: z.string(),
  project_item_id: z.uuid().nullable(),
  resolved_at: z.date(),
});

const nameRowsSchema = z.array(z.object({ id: z.uuid(), name: z.string().nullable() }));

function ids(
  rows: readonly z.infer<typeof resolvedRowSchema>[],
  kind: string,
  pick: (row: z.infer<typeof resolvedRowSchema>) => string | null,
) {
  return [
    ...new Set(
      rows.flatMap((row) => {
        const id = row.kind === kind ? pick(row) : null;
        return id === null ? [] : [id];
      }),
    ),
  ];
}

function keyedId(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const parsed = z.uuid().safeParse(key.slice(prefix.length));
  return parsed.success ? parsed.data : null;
}

/**
 * The tenant's recently resolved problems, newest first, without `sourceDeleted` ones. A problem resolved and
 * raised again appears here under its resolved row's id and as an active problem under another.
 *
 * Titles are rendered at read time from kinds and source names, so no user text is stored. Names are read in
 * batches per source type, only when needed, so the statement count is bounded independent of the problem
 * count. A vanished source gets the neutral word.
 */
export async function readSempResolvedRecent(client: PoolClient, catalogs: ModuleCatalogs, locale: "cs" | "en") {
  const { rows: rawRows } = await client.query<Record<string, unknown>>(
    `SELECT id, category, kind, resolution_kind, source_id, dedupe_key, project_item_id, resolved_at
       FROM semp_problems
      WHERE tenant_id = app_tenant_default() AND resolved_at IS NOT NULL
        AND resolved_at >= now() - make_interval(days => $1) AND resolution_kind <> $2
      ORDER BY resolved_at DESC, id DESC LIMIT $3`,
    [SEMP_RESOLVED_RECENT_DAYS, SOURCE_DELETED_RESOLUTION_KIND, SEMP_RESOLVED_RECENT_LIMIT],
  );
  const rows = z.array(resolvedRowSchema).parse(rawRows);
  if (rows.length === 0) return [];

  const itemIds = [
    ...ids(rows, "mailSyncError", (row) => row.source_id),
    ...ids(rows, "transcriptionFailed", (row) => row.source_id),
    ...ids(rows, "guidanceDrift", (row) => row.project_item_id),
  ];
  const items = new Map((await getItemsByIds(client, itemIds)).map((item) => [item.id, item.properties.name]));

  const heartbeatIds = ids(rows, "agentHeartbeat", (row) => row.source_id);
  const heartbeatNames =
    heartbeatIds.length === 0
      ? []
      : nameRowsSchema.parse(
          (
            await client.query<Record<string, unknown>>(
              `SELECT id, name FROM project_heartbeats WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])`,
              [heartbeatIds],
            )
          ).rows,
        );

  const replyIds = ids(rows, "reply", (row) => row.source_id);
  const threadTitles =
    replyIds.length === 0
      ? []
      : nameRowsSchema.parse(
          (
            await client.query<Record<string, unknown>>(
              `SELECT m.id, t.title AS name FROM semp_messages m
                 JOIN semp_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
                WHERE m.tenant_id = app_tenant_default() AND m.id = ANY($1::uuid[])`,
              [replyIds],
            )
          ).rows,
        );

  const databaseIds = ids(rows, "libraryAutomation", (row) => keyedId(row.dedupe_key, "automation:"));
  const databaseNames =
    databaseIds.length === 0
      ? []
      : nameRowsSchema.parse(
          (
            await client.query<Record<string, unknown>>(
              `SELECT id, name FROM databases WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])`,
              [databaseIds],
            )
          ).rows,
        );

  const findingIds = ids(rows, "guidanceDrift", (row) => row.source_id);
  const findingKinds =
    findingIds.length === 0
      ? []
      : z.array(z.object({ id: z.uuid(), finding_kind: z.string().nullable() })).parse(
          (
            await client.query<Record<string, unknown>>(
              `SELECT id, payload->>'kind' AS finding_kind FROM agent_guidance_drift_findings
                  WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])`,
              [findingIds],
            )
          ).rows,
        );

  const heartbeatNameById = new Map(heartbeatNames.map((row) => [row.id, row.name]));
  const threadTitleByMessageId = new Map(threadTitles.map((row) => [row.id, row.name]));
  const databaseNameById = new Map(databaseNames.map((row) => [row.id, row.name]));
  const findingKindById = new Map(findingKinds.map((row) => [row.id, row.finding_kind]));
  const itemName = (id: string | null): string | null => {
    const name = id === null ? undefined : items.get(id);
    return typeof name === "string" ? name : null;
  };

  const paramsOf = (row: z.infer<typeof resolvedRowSchema>): ResolutionTitleParams => {
    switch (row.kind) {
      case "mailSyncError":
        return { mailbox: itemName(row.source_id) };
      case "transcriptionFailed":
        return { name: itemName(row.source_id) };
      case "reply":
        return { title: threadTitleByMessageId.get(row.source_id) };
      case "agentHeartbeat":
        return { name: heartbeatNameById.get(row.source_id) };
      case "guidanceDrift":
        return { project: itemName(row.project_item_id), findingKind: findingKindById.get(row.source_id) };
      case "libraryAutomation":
        return { database: databaseNameById.get(keyedId(row.dedupe_key, "automation:") ?? "") };
      default:
        return {};
    }
  };

  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    resolutionTitle: renderResolutionTitle(catalogs, row.kind, row.resolution_kind, paramsOf(row), locale),
    resolvedAt: row.resolved_at.toISOString(),
  }));
}
