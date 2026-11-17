import { collectItemLinks, type ParsedBlock } from "@semprec/block-model";
import type { Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";

/**
 * `client` must be tenant-scoped (RLS hides other tenants' items), so unknown, trashed, foreign and malformed ids all
 * raise the same `ValidationError`, which never says which it was.
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
