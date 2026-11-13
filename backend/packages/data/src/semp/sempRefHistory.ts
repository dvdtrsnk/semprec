import type { PoolClient } from "pg";
import {
  labeledSempMessageRefSchema,
  sempMessageRefSchema,
  type SempMessageRef,
  type SempRefResolution,
} from "@semprec/shared";
import { assertDescriptionShape } from "../mcp/approvalRequestsStore.js";

type StoredRef = SempMessageRef | ReturnType<typeof labeledSempMessageRefSchema.parse>;
type Entry = { page: number; index: number; ref: StoredRef };
type RefKind = SempMessageRef["kind"];

const SERIES_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** The current display metadata of an item: its title, its database's key and whether it is live, trashed or gone. */
export type SempItemResolution = SempRefResolution & { label: string | null };

const PURGED: SempItemResolution = { label: null, databaseKey: null, state: "purged" };

/**
 * Resolves item-shaped references (the item, block, transcript segment and task trace refs of a context, and the
 * changed items of a reply) in one statement, in the order given. An item that is not found under the tenant scope,
 * or not in the database a ref names, resolves as purged. A ref without a database matches the item in any database.
 */
export async function resolveSempItemRefs(
  client: PoolClient,
  refs: readonly { itemId: string; databaseId: string | null }[],
): Promise<SempItemResolution[]> {
  const { rows } = await client.query<{
    ordinal: number;
    found: boolean;
    deleted_at: Date | null;
    database_key: string | null;
    label: unknown;
  }>(
    `SELECT r.ordinal::int, i.id IS NOT NULL AS found, i.deleted_at, d.key AS database_key,
            i.properties -> title.key AS label
       FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS r(item_id, database_id, ordinal)
       LEFT JOIN items i ON i.id = r.item_id AND (r.database_id IS NULL OR i.database_id = r.database_id)
       LEFT JOIN databases d ON d.tenant_id = i.tenant_id AND d.id = i.database_id
       LEFT JOIN LATERAL (SELECT p.key FROM properties p WHERE p.tenant_id = i.tenant_id
                          AND p.database_id = i.database_id AND p.type = 'title' ORDER BY p.id LIMIT 1) title ON true
      ORDER BY r.ordinal`,
    [refs.map((ref) => ref.itemId), refs.map((ref) => ref.databaseId)],
  );
  return rows.map((row) =>
    row.found
      ? {
          label: typeof row.label === "string" ? row.label : null,
          databaseKey: row.database_key,
          state: row.deleted_at ? "trashed" : "active",
        }
      : PURGED,
  );
}

/** Enriches recognized refs on one history page without changing stored contexts. */
export async function resolveSempHistoryContexts(client: PoolClient, contexts: readonly unknown[]): Promise<unknown[]> {
  const output = contexts.map((context) => (isUnknownArray(context) ? [...context] : context));
  const grouped = new Map<RefKind, Entry[]>();
  for (const [page, context] of contexts.entries()) {
    if (!isUnknownArray(context)) continue;
    for (const [index, value] of context.entries()) {
      const unlabeled = sempMessageRefSchema.safeParse(value);
      const labeled = unlabeled.success ? null : labeledSempMessageRefSchema.safeParse(value);
      const ref = unlabeled.success ? unlabeled.data : labeled?.success ? labeled.data : null;
      if (!ref) continue;
      const entries = grouped.get(ref.kind) ?? [];
      entries.push({ page, index, ref });
      grouped.set(ref.kind, entries);
    }
  }
  for (const [kind, entries] of grouped) {
    let values: SempRefResolution[];
    if (kind === "item" || kind === "block" || kind === "transcriptSegment" || kind === "taskTrace") {
      const refs = entries.map(({ ref }) => {
        if (ref.kind !== "item" && ref.kind !== "block" && ref.kind !== "transcriptSegment" && ref.kind !== "taskTrace")
          throw new Error("Invalid item reference group");
        return ref;
      });
      values = await resolveSempItemRefs(
        client,
        refs.map((ref) => ({
          itemId: ref.itemId,
          databaseId: ref.kind === "item" || ref.kind === "taskTrace" ? ref.databaseId : null,
        })),
      );
    } else if (kind === "taskOccurrence") {
      // `series_id` is a uuid column; a stored id of any other shape names no series and resolves as purged.
      const ids = entries.map(({ ref }) => {
        if (ref.kind !== "taskOccurrence") throw new Error("Invalid occurrence reference group");
        return SERIES_ID_SHAPE.test(ref.seriesId) ? ref.seriesId : null;
      });
      const { rows } = await client.query<{ found: boolean; name: unknown }>(
        `SELECT t.series_id IS NOT NULL AS found, t.template -> 'name' AS name
           FROM unnest($1::uuid[]) WITH ORDINALITY AS r(id, ordinal)
           LEFT JOIN task_recurrence t ON t.series_id = r.id ORDER BY r.ordinal`,
        [ids],
      );
      values = rows.map((row) =>
        row.found
          ? { label: typeof row.name === "string" ? row.name : null, databaseKey: "tasks", state: "active" }
          : PURGED,
      );
    } else if (kind === "sleepNight") {
      // A night is virtual: no row can be purged, and its label is the client's to render from the night.
      values = entries.map(() => ({ label: null, databaseKey: null, state: "active" }));
    } else if (kind === "mailAttachment") {
      const ids = entries.map(({ ref }) => {
        if (ref.kind !== "mailAttachment") throw new Error("Invalid attachment reference group");
        return ref.attachmentId;
      });
      const { rows } = await client.query<{ filename: string | null; database_key: string | null }>(
        `SELECT a.filename, d.key AS database_key FROM unnest($1::uuid[]) WITH ORDINALITY AS r(id, ordinal)
         LEFT JOIN mail_attachments a ON a.id = r.id
         LEFT JOIN items i ON i.tenant_id = a.tenant_id AND i.id = a.message_item_id
         LEFT JOIN databases d ON d.tenant_id = i.tenant_id AND d.id = i.database_id ORDER BY r.ordinal`,
        [ids],
      );
      values = rows.map((row) =>
        row.filename === null ? PURGED : { label: row.filename, databaseKey: row.database_key, state: "active" },
      );
    } else if (kind === "agentRun") {
      const ids = entries.map(({ ref }) => {
        if (ref.kind !== "agentRun") throw new Error("Invalid run reference group");
        return ref.agentRunId;
      });
      const { rows } = await client.query<{ task: string | null }>(
        `SELECT a.task FROM unnest($1::uuid[]) WITH ORDINALITY AS r(id, ordinal)
         LEFT JOIN agent_runs a ON a.id = r.id ORDER BY r.ordinal`,
        [ids],
      );
      values = rows.map((row) =>
        row.task === null
          ? PURGED
          : { label: Array.from(row.task).slice(0, 120).join(""), databaseKey: null, state: "active" },
      );
    } else {
      const ids = entries.map(({ ref }) => {
        if (ref.kind !== "approvalRequest") throw new Error("Invalid approval reference group");
        return ref.approvalRequestId;
      });
      const { rows } = await client.query<{ found: boolean; description: unknown }>(
        `SELECT a.id IS NOT NULL AS found, a.description FROM unnest($1::uuid[]) WITH ORDINALITY AS r(id, ordinal)
         LEFT JOIN approval_requests a ON a.id = r.id ORDER BY r.ordinal`,
        [ids],
      );
      values = rows.map((row) =>
        row.found ? { label: assertDescriptionShape(row.description), databaseKey: null, state: "active" } : PURGED,
      );
    }
    if (values.length !== entries.length) throw new Error("Invalid reference resolution result");
    for (const [index, entry] of entries.entries()) {
      const page = output[entry.page];
      const resolved = values[index];
      if (!isUnknownArray(page) || !resolved) throw new Error("Invalid reference resolution position");
      page[entry.index] = { ...entry.ref, resolved };
    }
  }
  return output;
}
