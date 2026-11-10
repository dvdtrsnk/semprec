/**
 * The closed registry of block type keys and their field rules, from
 * `docs/adr/2026-10-28-block-model-for-page-documents.md`. The keys are stored in
 * `sys:flavour`; labels are UI copy and live outside the stored model. Every type carries `text`; a `page` block
 * carries its title there as plain text (`docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md`).
 */
export const BLOCK_TYPES = ["text", "h1", "h2", "h3", "bullet", "number", "todo", "quote", "page"] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

/** `indent` is an integer in `0..MAX_INDENT` on every block type; the default is 0. */
export const MIN_INDENT = 0;
export const MAX_INDENT = 5;

/** Which optional fields a block type carries. `indent` applies to every type. */
export interface BlockTypeRule {
  /** `done` is a boolean on this type. */
  readonly hasDone: boolean;
  /** `pageId` is a string on this type. */
  readonly hasPageId: boolean;
  /** Runs of the `text` `Y.Text` may carry `bold`, `italic`, `code` and `link`; a `page` title is plain text. */
  readonly hasInlineAttributes: boolean;
}

const TEXT_RULE: BlockTypeRule = { hasDone: false, hasPageId: false, hasInlineAttributes: true };

export const BLOCK_TYPE_RULES: Readonly<Record<BlockType, BlockTypeRule>> = {
  text: TEXT_RULE,
  h1: TEXT_RULE,
  h2: TEXT_RULE,
  h3: TEXT_RULE,
  bullet: TEXT_RULE,
  number: TEXT_RULE,
  todo: { hasDone: true, hasPageId: false, hasInlineAttributes: true },
  quote: TEXT_RULE,
  page: { hasDone: false, hasPageId: true, hasInlineAttributes: false },
};

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && (BLOCK_TYPES as readonly string[]).includes(value);
}

/** Inline attribute names a `Y.Text` run may carry. `link` has the shape `{ href }`. */
export const INLINE_ATTRIBUTES = ["bold", "italic", "code", "link"] as const;

export type InlineAttributeName = (typeof INLINE_ATTRIBUTES)[number];

export interface InlineAttributes {
  bold?: true;
  italic?: true;
  code?: true;
  link?: { href: string };
}
