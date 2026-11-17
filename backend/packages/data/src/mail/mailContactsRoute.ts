import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { searchMailContacts } from "./personEmailIndexStore.js";
import type { CustomRouteResult, RouteUrl } from "../customRoute.js";
import { requestUrl } from "../customRoute.js";

/** Mounted by the authenticated custom-route adapter in the session's tenant scope. */
export function createMailContactsRouteHandler(pool: Pool) {
  return async (ctx: RouteUrl): Promise<CustomRouteResult> => {
    const url = requestUrl(ctx.req);
    const q = (url.searchParams.get("q") ?? "").trim();
    const exclude = url.searchParams.get("exclude") ?? "";
    const rawLimit = url.searchParams.get("limit");
    if (q.length > 256) throw new ValidationError("q is too long", { field: "q" });
    if (exclude.length > 16_384) throw new ValidationError("exclude is too long", { field: "exclude" });
    if (rawLimit !== null && !/^[0-9]+$/.test(rawLimit))
      throw new ValidationError("limit must be a positive integer", { field: "limit" });
    const requested = rawLimit === null ? 10 : Number(rawLimit);
    if (!Number.isSafeInteger(requested) || requested < 1)
      throw new ValidationError("limit must be a positive integer", { field: "limit" });
    const contacts =
      q === ""
        ? []
        : await withTransaction(pool, (client) =>
            searchMailContacts(client, q, exclude.split(","), Math.min(requested, 50)),
          );
    return { status: 200, body: { contacts } };
  };
}
