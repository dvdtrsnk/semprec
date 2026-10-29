import { collectItemLinks, type ParsedBlock } from "@semprec/block-model";
import type { Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";

/**
 * Write guard for page Markdown that was just parsed: every `semprec://items/<uuid>` link must
 * name a live item of the caller's tenant. `client` must be tenant-scoped (row-level security
 * hides other tenants' items), so an unknown id, a soft-deleted item, an id of another tenant and
 * a malformed id all raise the same `ValidationError` (HTTP 400 `validation_failed`) with the
 * same body, which never says which of them it was. `field` is the request field that carried
 * the Markdown. Reads only; it writes no relation.
 */
export async function assertItemLinksExist(
  client: Queryable,
  blocks: readonly Pick<ParsedBlock, "text">[],
  field: string,
): Promise<void> {
  const { ids, malformed } = collectItemLinks(blocks);
  let valid = !malformed;
  if (valid && ids.length > 0) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT DISTINCT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    valid = rows.length === ids.length;
  }
  if (!valid) {
    throw new ValidationError("Invalid item link", {
      issues: [{ path: field, code: "item_link_invalid", message: "links an item that does not exist" }],
    });
  }
}
