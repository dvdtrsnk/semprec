/**
 * The closed registry of block type keys and their field rules
 * (`docs/adr/2026-10-28-block-model-for-page-documents.md`). Keys are stored in `sys:flavour`; labels
 * are UI copy outside the stored model. Every type carries `text`; a `page` block carries its title
 * there as plain text.
 */
export const BLOCK_TYPES = ["text", "h1", "h2", "h3", "bullet", "number", "todo", "quote", "toggle", "page"] as const;

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
  /** `toggle` is a boolean on this type: a heading that collapses the more-indented blocks after it. */
  readonly hasToggle: boolean;
  /** Runs of the `text` `Y.Text` may carry the `INLINE_ATTRIBUTES`; a `page` title is plain text. */
  readonly hasInlineAttributes: boolean;
}

const TEXT_RULE: BlockTypeRule = { hasDone: false, hasPageId: false, hasToggle: false, hasInlineAttributes: true };
const HEADING_RULE: BlockTypeRule = { ...TEXT_RULE, hasToggle: true };

export const BLOCK_TYPE_RULES: Readonly<Record<BlockType, BlockTypeRule>> = {
  text: TEXT_RULE,
  h1: HEADING_RULE,
  h2: HEADING_RULE,
  h3: HEADING_RULE,
  bullet: TEXT_RULE,
  number: TEXT_RULE,
  todo: { ...TEXT_RULE, hasDone: true },
  quote: TEXT_RULE,
  // A toggle list item; its children are the following blocks with a greater indent.
  toggle: TEXT_RULE,
  page: { hasDone: false, hasPageId: true, hasToggle: false, hasInlineAttributes: false },
};

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && (BLOCK_TYPES as readonly string[]).includes(value);
}

/**
 * Inline attribute names a `Y.Text` run may carry. `link` has the shape `{ href }`; `color` (text
 * color) and `highlight` (background) hold a `ColorKey`; the others are `true`.
 */
export const INLINE_ATTRIBUTES = [
  "bold",
  "italic",
  "code",
  "link",
  "strike",
  "underline",
  "color",
  "highlight",
] as const;

export type InlineAttributeName = (typeof INLINE_ATTRIBUTES)[number];

/** The closed registry of color keys for `color` and `highlight`. Renderers map each key to their own palette. */
export const INLINE_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

export type ColorKey = (typeof INLINE_COLORS)[number];

export function isColorKey(value: unknown): value is ColorKey {
  return typeof value === "string" && (INLINE_COLORS as readonly string[]).includes(value);
}

export interface InlineAttributes {
  bold?: true;
  italic?: true;
  code?: true;
  link?: { href: string };
  strike?: true;
  underline?: true;
  color?: ColorKey;
  highlight?: ColorKey;
}
