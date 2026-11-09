import type { Pool } from "pg";
import { z } from "zod";
import { createChokePoint, createDocStore, listPageChanges, NotFoundError, ValidationError } from "@semprec/data";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireUuidParam } from "./adapter/requestValidation.js";

/** The most entries one request returns, and what it returns without a `limit`. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const authorSchema = z.enum(["user", "ai_agent", "system"]);

function parseSince(raw: string | null): Date {
  const parsed = z.iso.datetime({ offset: true }).safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("'since' must be an ISO 8601 timestamp", { field: "since" });
  }
  return new Date(parsed.data);
}

function parseBy(raw: string | null): z.infer<typeof authorSchema> {
  if (raw === null) return "ai_agent";
  const parsed = authorSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError("'by' must be user, ai_agent or system", { field: "by" });
  return parsed.data;
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const limit = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`'limit' must be an integer from 1 to ${MAX_LIMIT}`, { field: "limit" });
  }
  return limit;
}

/**
 * `GET /api/items/:id/page/changes?since=&by=&limit=` (issue #1680): what was written to a page since an instant, by
 * one author, as `[{ at, blockIds, kind }]`, oldest first (see `listPageChanges`). The query is checked first, with the
 * same answer for every caller; then the item is read in the caller's tenant like any item read, so a foreign item
 * answers exactly like an unknown one (404). An item with no page document has no changes (`[]`), a `since` in the
 * future is 400 and one before the retained history is 410 `history_not_retained`. The adapter supplies
 * authentication, the tenant scope and the error mapping.
 */
export function createPageChangesRoutes(pool: Pool): RouteDefinition[] {
  const chokePoint = createChokePoint(pool);
  const docStore = createDocStore(pool);
  return [
    {
      method: "GET",
      path: "/api/items/:id/page/changes",
      handler: async (ctx) => {
        const itemId = requireUuidParam(ctx.params, "id");
        const query = new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
        const since = parseSince(query.get("since"));
        const by = parseBy(query.get("by"));
        const limit = parseLimit(query.get("limit"));
        if (!(await chokePoint.findItem(itemId))) throw new NotFoundError(`Item ${itemId} not found`);
        const doc = await docStore.getDoc(itemId);
        if (!doc) {
          // Without a document there is no retained history to bound `since` by, so the future check is made here.
          if (since.getTime() > Date.now()) {
            throw new ValidationError("'since' must not be in the future", { field: "since" });
          }
          return { status: 200, body: [] };
        }
        return { status: 200, body: await listPageChanges(pool, doc.id, { since, by, limit }) };
      },
    },
  ];
}
