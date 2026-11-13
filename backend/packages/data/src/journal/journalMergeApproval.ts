// The approval snapshot of an agent's `page.mergeJournalDuplicates` (issue #2017), shaped like the choke point's own
// destructive checks and like the page replace's (`docs/pageReplaceApproval.ts`): the gateway asks for it when the
// agent calls the operation and again when the approved request is executed, and the two must agree. The merge itself
// is `mergeJournalDuplicates` (issue #1726), run through `mergeJournalDuplicatesForWriter`.
// Constrained by: docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
import type { PoolClient } from "pg";
import { listDatabaseLabelsByIds } from "../chokePoint/databasesStore.js";
import { buildResourceSnapshot, type DestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import type { ItemRow } from "../types.js";
import {
  mergeJournalDuplicatesForWriter,
  requireJournalForMerge,
  type ApprovedJournalPair,
  type JournalMergeOutcome,
  type JournalMergePeriod,
} from "./journalMergeForWriter.js";
import { findJournalDuplicatePair } from "./journalStore.js";

/** The approval-gated check of `page.mergeJournalDuplicates`. */
export interface JournalMergeCheck {
  operation: "page.mergeJournalDuplicates";
  input: JournalMergePeriod;
  /** The agent's project: its `write` access to the Journal database is checked as the merge itself checks it. */
  agentProjectItemId?: string;
}

/** What an approval request for a merge was computed from: the period and the two entries it would merge, `null` for each when the period has no two live entries. */
interface JournalMergeProjection {
  type: string;
  period: string;
  survivorId: string | null;
  mergedItemId: string | null;
}

function pairOfProjection(projection: unknown): ApprovedJournalPair | null {
  if (
    typeof projection === "object" &&
    projection !== null &&
    "survivorId" in projection &&
    "mergedItemId" in projection
  ) {
    const { survivorId, mergedItemId } = projection;
    if (survivorId === null && mergedItemId === null) return null;
    if (typeof survivorId === "string" && typeof mergedItemId === "string") return { survivorId, mergedItemId };
  }
  throw new Error("Invalid Journal merge projection");
}

/** The stored title of an entry, or `null` for an entry without one. Page content never reaches the description. */
function titleOf(item: ItemRow | undefined, titleKey: string): string | null {
  const title = item?.properties[titleKey];
  return typeof title === "string" ? title : null;
}

/**
 * Authorizes and projects a `page.mergeJournalDuplicates` without writing: the agent's project needs write access to
 * the Journal database and `period` has to be a canonical key of `type` (`requireJournalForMerge`), so a call that
 * would be refused creates no approval request. A period with no two live entries is projected too, with no pair: its
 * approved request replays as `{ merged: false }`, or as a conflict when a duplicate appeared in between.
 *
 * The snapshot holds the period and the ids of the two entries; the description names the period and the two entries'
 * stored titles, and holds no page content.
 */
export async function computeJournalMergeProjection(
  client: PoolClient,
  check: JournalMergeCheck,
): Promise<DestructiveResourceProjection> {
  const journal = await requireJournalForMerge(client, check.input, check);
  const pair = await findJournalDuplicatePair(client, {
    journalDatabaseId: journal.id,
    type: check.input.type,
    period: check.input.period,
  });
  const projected: JournalMergeProjection = {
    type: check.input.type,
    period: check.input.period,
    survivorId: pair?.survivorId ?? null,
    mergedItemId: pair?.duplicateId ?? null,
  };
  const items = pair ? await getItemsByIds(client, [pair.survivorId, pair.duplicateId]) : [];
  const [label] = pair ? await listDatabaseLabelsByIds(client, [journal.id]) : [];
  const titleKey = label?.titlePropertyKey ?? "name";
  return {
    snapshot: buildResourceSnapshot("journal_merge", `${check.input.type}:${check.input.period}`, projected),
    currentResource: {
      ...projected,
      approvalDescription: {
        key: "approval.journalMerge",
        params: {
          periodType: check.input.type,
          period: check.input.period,
          survivorName: titleOf(
            items.find((item) => item.id === pair?.survivorId),
            titleKey,
          ),
          mergedName: titleOf(
            items.find((item) => item.id === pair?.duplicateId),
            titleKey,
          ),
        },
      },
    },
  };
}

/**
 * Runs an approved merge in the replay's transaction: the entries the projection of the replay found (`currentResource`
 * of `computeJournalMergeProjection`) are the ones the merge has to take, see `mergeJournalDuplicatesForWriter`.
 */
export function mergeApprovedJournalDuplicates(
  client: PoolClient,
  period: JournalMergePeriod,
  currentResource: unknown,
  writer: Pick<WriterIdentity, "agentProjectItemId">,
): Promise<JournalMergeOutcome> {
  return mergeJournalDuplicatesForWriter(client, period, writer, pairOfProjection(currentResource));
}
