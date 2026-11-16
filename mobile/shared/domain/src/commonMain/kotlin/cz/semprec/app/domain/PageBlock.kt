package cz.semprec.app.domain

/** The closed set of block types of a page document (docs/adr/2026-10-28-block-model-for-page-documents.md). */
enum class PageBlockType { TEXT, H1, H2, H3, BULLET, NUMBER, TODO, QUOTE, PAGE }

/** A stretch of text with the same inline formatting; a `\n` in [text] is a soft line break. */
data class InlineRun(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val link: String? = null,
)

/**
 * One block of a page as read from its canonical Markdown. [firstLine] to [lastLine] (0-based, inclusive) are the
 * lines of the Markdown the block came from, an id comment included, so an edit can replace exactly those lines and
 * leave every other block byte for byte as the server wrote it. A [PageBlockType.PAGE] block has its caption in
 * [runs] and the subpage item in [pageId]. [hasComment] is `true` when the block came with a `semprec:block`
 * comment, and [preservedType] is the type key of a block whose type this app does not know (read as text).
 */
data class PageBlock(
    val type: PageBlockType,
    val indent: Int,
    val done: Boolean,
    val runs: List<InlineRun>,
    val pageId: String?,
    val firstLine: Int,
    val lastLine: Int,
    val hasComment: Boolean = false,
    val preservedType: String? = null,
) {
    /** The text without formatting, which an edit is checked against so it never lands on a changed block. */
    val plainText: String get() = runs.joinToString("") { it.text }
}
