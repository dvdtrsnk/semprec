import type { PoolClient } from "pg";
import { readPageBlocks } from "@semprec/block-model";
import { lockLiveItem } from "../docs/lockLiveItem.js";
import { insertPlannedBlocks, type IdentifiedBlock } from "../docs/pageMarkdown.js";
import { proposalEnvelopeSchema, type ProposalEnvelope, type ProposalPageSection } from "./proposalEnvelope.js";
import { proposalBlockId } from "./proposalPageContent.js";

/**
 * The blocks of `sections` in page order, with the ids of the proposal: each section is an `h2` heading block followed
 * by one block of the section's type per item. The block ids are `proposalBlockId(proposalId, n)` for the n-th block
 * of the page (heading and items counted together), so a repeated confirm names the same ids.
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
 * `next`, the envelope a revise of a card writes, with the page sections of the card's previous assistant envelope
 * carried over (issue gh-1974). A revise replaces the whole envelope with one the caller composed from properties
 * alone, so without this a revised recipe card would be confirmed with an empty page. The sections are carried only
 * when the revision keeps the destination they were computed for: `next` has none of its own, and both envelopes are
 * single-step `database` envelopes with the same `target`. `previous` is the stored envelope as read from the card
 * (`aiProposal`, else `proposal`); one that is absent or does not parse carries nothing, because a revise may replace
 * a malformed envelope. The inputs are not changed.
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
 * Writes the sections of a confirmed `database` proposal into the page of the item the confirm created (issue
 * gh-1974): the item is locked live, then one document write appends the blocks of `buildPageSectionBlocks` at the end
 * of the page as it stands, authored `user` like the other blocks a confirm writes. The caller's transaction owns the
 * commit, so a failure leaves no block and no item. Returns the inserted block ids in order.
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
