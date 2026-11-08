/**
 * Markdown to plain text for the search index. The implementation is `stripMarkdown` in `@semprec/block-model`
 * (issue #1608), which the serializer issue delivered; this module gives the index its own import path and keeps a
 * single implementation.
 */
export { stripMarkdown } from "@semprec/block-model";
