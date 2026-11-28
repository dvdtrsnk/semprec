import type { PoolClient } from "pg";
import { readPageBlocks } from "@alldots/block-model";
import { lockLiveItem } from "../docs/lockLiveItem.js";
import { insertPlannedBlocks, type IdentifiedBlock } from "../docs/pageMarkdown.js";
import { proposalEnvelopeSchema, type ProposalEnvelope, type ProposalPageSection } from "./proposalEnvelope.js";
import { proposalBlockId } from "./proposalPageContent.js";

/**
 * The blocks of `sections`: an `h2` heading then one block per item, with ids `proposalBlockId(proposalId, n)`, so a
 * repeated confirm names the same ids.
 */
export function buildPageSectionBlocks(
  proposalId: string,
  sections: readonly ProposalPageSection[],
): IdentifiedBlock[] {
  const blocks: IdentifiedBlock[] = [];
  const add = (type: IdentifiedBlock["type"], text: string): void => {
    blocks.push({ id: proposalBlockId(proposalId, blocks.length), type, indent: 0, text });
  };
  for (const section of sections) {
    add("h2", section.heading);
    for (const item of section.items) add(section.blockType, item);
  }
  return blocks;
}

/**
 * `next` (a revise's envelope, composed from properties alone) with the previous assistant envelope's page sections
 * carried over, so a revised recipe card does not confirm with an empty page. Only when `next` has none and both are
 * single-step `database` envelopes with the same `target`; an absent or unparsable `previous` carries nothing.
 */
export function carryPageSections(previous: unknown, next: ProposalEnvelope): ProposalEnvelope {
  if (next.pageSections !== undefined || next.entityKind !== "database" || next.operations !== undefined) return next;
  const parsed = proposalEnvelopeSchema.safeParse(previous);
  if (!parsed.success) return next;
  const { entityKind, target, operations, pageSections } = parsed.data;
  if (pageSections === undefined || entityKind !== "database" || operations !== undefined || target !== next.target) {
    return next;
  }
  return { ...next, pageSections };
}

/**
 * Appends the sections' blocks to the page of the item the confirm created (item locked live), authored `user`. The
 * caller's transaction owns the commit. Returns the inserted block ids in order.
 */
export async function insertProposalPageSections(
  client: PoolClient,
  proposalId: string,
  itemId: string,
  sections: readonly ProposalPageSection[],
): Promise<string[]> {
  const host = await lockLiveItem(client, itemId);
  const blocks = buildPageSectionBlocks(proposalId, sections);
  return insertPlannedBlocks(client, host, "user", (ydoc) => ({
    afterId:
      readPageBlocks(ydoc)
        .filter((block) => !block.synthetic && block.id !== null)
        .at(-1)?.id ?? null,
    blocks,
  }));
}
