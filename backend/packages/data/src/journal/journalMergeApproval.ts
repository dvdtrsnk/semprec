// Approval snapshot of an agent's `page.mergeJournalDuplicates`: computed when the agent calls the operation and
// again when the approved request executes, and the two must agree.
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

export interface JournalMergeCheck {
  operation: "page.mergeJournalDuplicates";
  input: JournalMergePeriod;
  /** Its `write` access to the Journal database is checked as the merge itself checks it. */
  agentProjectItemId?: string;
}

/** Ids are `null` when the period has no two live entries. */
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

/** Page content never reaches the description. */
function titleOf(item: ItemRow | undefined, titleKey: string): string | null {
  const title = item?.properties[titleKey];
  return typeof title === "string" ? title : null;
}

/**
 * Authorizes without writing, so a call that would be refused creates no approval request. A period with no pair is
 * projected too: its approved request replays as `{ merged: false }`, or a conflict if a duplicate appeared since.
 * The description holds stored titles only, no page content.
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

/** The merge must take the entries the replay's projection found (`currentResource`). */
export function mergeApprovedJournalDuplicates(
  client: PoolClient,
  period: JournalMergePeriod,
  currentResource: unknown,
  writer: Pick<WriterIdentity, "agentProjectItemId">,
): Promise<JournalMergeOutcome> {
  return mergeJournalDuplicatesForWriter(client, period, writer, pairOfProjection(currentResource));
}
