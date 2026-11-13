import type { PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { requireAffectedRows } from "../db/pool.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import { LIBRARY_AUTOMATION_SOURCES, type LibraryAutomationSource } from "./itemAutomationStore.js";

/** The most candidates stored for one item; the `idx` column's CHECK allows the positions 0 to `MAX_COVER_CANDIDATES - 1`. */
export const MAX_COVER_CANDIDATES = 3;

/** One alternative match as the metadata job offers it for storing. */
export interface CoverCandidateInput {
  source: LibraryAutomationSource;
  title: string;
  subtitle: string | null;
  imageUrl: string;
}

/** One stored candidate; `index` is its position in the set, the one the select route takes. */
export interface CoverCandidate {
  index: number;
  source: LibraryAutomationSource;
  title: string | null;
  subtitle: string | null;
  imageUrl: string;
}

/** The raw `library_cover_candidates` row shape this module reads back from Postgres. */
type CoverCandidateDbRow = {
  idx: number;
  source: string;
  title: string | null;
  subtitle: string | null;
  image_url: string;
};

const COLUMNS = "idx, source, title, subtitle, image_url";

function mapRow(row: CoverCandidateDbRow): CoverCandidate {
  return {
    index: row.idx,
    source: assertKnownValue(LIBRARY_AUTOMATION_SOURCES, row.source, "cover candidate source"),
    title: row.title,
    subtitle: row.subtitle,
    imageUrl: row.image_url,
  };
}

/**
 * Replaces the candidates of `itemId` with `candidates`, in the caller's transaction. An entry whose image URL does
 * not pass the stored-URL baseline (`isBaselineOutboundUrl`: https, no userinfo, no port, a DNS host) is dropped,
 * and so is every valid entry after the third. The kept entries get the positions 0, 1, 2 in order, so a set whose
 * first entry was dropped starts at 0 again. An empty or fully dropped input leaves the item with no candidates.
 * Returns the number of candidates stored.
 */
export async function replaceCoverCandidates(
  client: PoolClient,
  itemId: string,
  candidates: readonly CoverCandidateInput[],
): Promise<number> {
  await deleteCoverCandidatesForItem(client, itemId);
  const kept = candidates
    .filter((candidate) => isBaselineOutboundUrl(candidate.imageUrl))
    .slice(0, MAX_COVER_CANDIDATES);
  for (const [index, candidate] of kept.entries()) {
    const inserted = await client.query(
      `INSERT INTO library_cover_candidates (item_id, idx, source, title, subtitle, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [itemId, index, candidate.source, candidate.title, candidate.subtitle, candidate.imageUrl],
    );
    requireAffectedRows(inserted, "the insert of a cover candidate");
  }
  return kept.length;
}

/** The stored candidates of `itemId` in position order; empty when the item has none. */
export async function listCoverCandidates(client: PoolClient, itemId: string): Promise<CoverCandidate[]> {
  const { rows } = await client.query<CoverCandidateDbRow>(
    `SELECT ${COLUMNS} FROM library_cover_candidates WHERE item_id = $1 ORDER BY idx`,
    [itemId],
  );
  return rows.map(mapRow);
}

/** The candidate of `itemId` at position `index`, or `null` when the set has none there. */
export async function getCoverCandidate(
  client: PoolClient,
  itemId: string,
  index: number,
): Promise<CoverCandidate | null> {
  const { rows } = await client.query<CoverCandidateDbRow>(
    `SELECT ${COLUMNS} FROM library_cover_candidates WHERE item_id = $1 AND idx = $2`,
    [itemId, index],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Removes the candidates of `itemId` and returns how many rows it removed. Zero is a valid outcome: most items have
 * none, and a metadata run that found nothing replaces a set that may already be empty.
 */
export async function deleteCoverCandidatesForItem(client: PoolClient, itemId: string): Promise<number> {
  const removed = await client.query("DELETE FROM library_cover_candidates WHERE item_id = $1", [itemId]);
  return removed.rowCount ?? 0;
}
