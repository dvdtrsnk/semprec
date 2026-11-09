import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { readPageBlocks, type PageBlock } from "@semprec/block-model";
import { ConflictError } from "../errors.js";
import type { PageContentV2 } from "./proposalEnvelope.js";
import { lockLiveItem } from "../docs/lockLiveItem.js";
import {
  identifyBlocks,
  insertPlannedBlocks,
  parseCheckedMarkdown,
  type IdentifiedBlock,
} from "../docs/pageMarkdown.js";

/** Heading block types by level; a section ends at the next heading of the same or a higher level. */
const HEADING_LEVELS: Readonly<Record<string, 1 | 2 | 3>> = { h1: 1, h2: 2, h3: 3 };

/**
 * The id of block number `index` of a proposal's content: the RFC 4122 version 5 UUID of `proposalId` (the namespace)
 * and `block:<index>`. The same proposal always names the same ids, so a block written for it can be recognised and a
 * repeated insert collides on them instead of adding a second copy.
 */
export function proposalBlockId(proposalId: string, index: number): string {
  const namespace = Buffer.from(proposalId.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespace).update(`block:${index}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The page's real blocks in document order. */
function realBlocks(blocks: readonly PageBlock[]): Array<PageBlock & { id: string }> {
  return blocks.flatMap((block) => (block.synthetic || block.id === null ? [] : [{ ...block, id: block.id }]));
}

/**
 * Where "under heading X" is: at the end of X's section, after the last block before the next heading of the same or a
 * higher level, or at the end of the page when there is none. Also the level the optional heading of the proposal is
 * written at: one below X, never below `h3`. A heading that is gone, or is no longer a heading block, is a
 * `ConflictError` (409): the card stays `proposed` so the client can offer a new choice.
 */
function resolveAfterHeading(blocks: readonly PageBlock[], headingId: string): { afterId: string; level: 2 | 3 } {
  const real = realBlocks(blocks);
  const index = real.findIndex((block) => block.id === headingId);
  const sectionLevel = real[index] === undefined ? undefined : HEADING_LEVELS[real[index].type];
  if (index === -1 || sectionLevel === undefined) {
    throw new ConflictError("The chosen heading no longer exists on the page", { field: "placement" });
  }
  let afterId = headingId;
  for (const block of real.slice(index + 1)) {
    const level = HEADING_LEVELS[block.type];
    if (level !== undefined && level <= sectionLevel) break;
    afterId = block.id;
  }
  return { afterId, level: sectionLevel === 1 ? 2 : 3 };
}

/**
 * Writes a confirmed v2 `pageContent` proposal into its target page (issue #1681), authored `user`: the confirming
 * user's decision, while that Semp proposed it stays recorded on the card. The target is locked live first; the blocks
 * are prepared (parsed, link-checked, given ids) before the page is created or written; then one document write
 * resolves the placement on the page as it stands and inserts the optional heading block followed by the Markdown
 * blocks. `start` and `end` map directly; `afterHeading` is resolved to the end of that heading's section, a vanished
 * heading being a `ConflictError`. Block ids come from `proposalBlockId`, heading first. The caller's transaction owns
 * the commit, so any failure leaves the card `proposed` and no block written. Returns the inserted block ids in order.
 */
export async function insertProposalPageContent(
  client: PoolClient,
  proposalId: string,
  targetItemId: string,
  content: PageContentV2,
): Promise<string[]> {
  const host = await lockLiveItem(client, targetItemId);
  const hasHeading = content.heading !== undefined && content.heading.trim() !== "";
  const idOffset = hasHeading ? 1 : 0;
  const parsed = await parseCheckedMarkdown(client, content.markdown);
  const markdownBlocks = identifyBlocks(
    parsed,
    parsed.map((_, index) => proposalBlockId(proposalId, index + idOffset)),
  );

  return insertPlannedBlocks(client, host, "user", (ydoc) => {
    const current = readPageBlocks(ydoc);
    const placement = content.placement;
    let afterId: string | null;
    let headingLevel: 2 | 3 = 2;
    if (placement === "start") {
      afterId = null;
    } else if (placement === "end") {
      afterId = realBlocks(current).at(-1)?.id ?? null;
    } else {
      ({ afterId, level: headingLevel } = resolveAfterHeading(current, placement.afterHeading));
    }
    const heading: IdentifiedBlock[] = hasHeading
      ? [
          {
            id: proposalBlockId(proposalId, 0),
            type: headingLevel === 2 ? "h2" : "h3",
            text: content.heading?.trim() ?? "",
          },
        ]
      : [];
    return { afterId, blocks: [...heading, ...markdownBlocks] };
  });
}
