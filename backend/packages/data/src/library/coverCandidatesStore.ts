import type { PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { requireAffectedRows } from "../db/pool.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import { LIBRARY_AUTOMATION_SOURCES, type LibraryAutomationSource } from "./itemAutomationStore.js";

/** Must match the `idx` column's CHECK (0 to `MAX_COVER_CANDIDATES - 1`). */
export const MAX_COVER_CANDIDATES = 3;

export interface CoverCandidateInput {
  source: LibraryAutomationSource;
  title: string;
  subtitle: string | null;
  imageUrl: string;
}

/** `index` is the position the select route takes. */
export interface CoverCandidate {
  index: number;
  source: LibraryAutomationSource;
  title: string | null;
  subtitle: string | null;
  imageUrl: string;
}

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
 * Entries failing the stored-URL baseline (`isBaselineOutboundUrl`) are dropped, then the first three are kept and
 * renumbered from 0. Returns the number stored.
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

export async function listCoverCandidates(client: PoolClient, itemId: string): Promise<CoverCandidate[]> {
  const { rows } = await client.query<CoverCandidateDbRow>(
    `SELECT ${COLUMNS} FROM library_cover_candidates WHERE item_id = $1 ORDER BY idx`,
    [itemId],
  );
  return rows.map(mapRow);
}

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

export async function deleteCoverCandidatesForItem(client: PoolClient, itemId: string): Promise<number> {
  const removed = await client.query("DELETE FROM library_cover_candidates WHERE item_id = $1", [itemId]);
  return removed.rowCount ?? 0;
}
