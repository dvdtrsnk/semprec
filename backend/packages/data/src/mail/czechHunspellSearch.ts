import type { Queryable } from "../db/pool.js";

/**
 * Deploy-time activation of Hunspell-backed Czech full-text search (issue #207): runs
 * 0046_czech_hunspell_search.sql's `activate_czech_hunspell_search()`, so a database migrated
 * before provisioning installed the dictionary assets is upgraded by the next deploy. Returns
 * whether the Hunspell dictionary is active; false means the assets are still missing and the
 * unaccent/simple fallback stays in place. Repeated calls on an activated database are no-ops.
 */
export async function activateCzechHunspellSearch(client: Queryable): Promise<boolean> {
  const { rows } = await client.query<{ active: boolean }>("SELECT activate_czech_hunspell_search() AS active");
  const row = rows[0];
  if (!row) {
    throw new Error("activate_czech_hunspell_search() returned no row");
  }
  return row.active;
}
