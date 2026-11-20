package cz.semprec.app.domain

private const val SPAN_TAG = "span"
private val FORMAT_TAG = Regex("<(/?)(strong|b|em|i|u|s|del)>", RegexOption.IGNORE_CASE)
private val COLOR_OPEN = Regex("<(span|mark) data-color=(?:\"([^\"<>]*)\"|'([^'<>]*)')>", RegexOption.IGNORE_CASE)
private val COLOR_CLOSE = Regex("</(span|mark)>", RegexOption.IGNORE_CASE)

/** An HTML tag of the inline Markdown: how it changes the formatting in effect, and how long it is. */
internal class InlineTag(val length: Int, val apply: (InlineRun) -> InlineRun)

/**
 * The HTML tags the inline Markdown carries formatting in: `<strong>`/`<b>`, `<em>`/`<i>`, `<u>`, `<s>`/`<del>`,
 * `<span data-color="…">` for text color and `<mark data-color="…">` for highlight (either quote). A tag switches
 * its format on or off wherever it stands, so tags read the same in any nesting order. A color key this app does not
 * know is dropped as `shared/block-model` drops it: its tag is read and the text after it has no color of that kind,
 * not the color of a tag around it.
 */
internal object PageInlineTags {
    fun at(source: String, index: Int): InlineTag? {
        val format = FORMAT_TAG.matchAt(source, index)
        val open = COLOR_OPEN.matchAt(source, index)
        val close = COLOR_CLOSE.matchAt(source, index)
        return when {
            format != null -> InlineTag(format.value.length) {
                withFormat(it, format.groupValues[2].lowercase(), format.groupValues[1].isEmpty())
            }
            open != null -> InlineTag(open.value.length) { run ->
                val key = open.groupValues.drop(2).firstOrNull { it.isNotEmpty() }.orEmpty()
                withColor(run, open.groupValues[1], InlineColor.fromKey(key))
            }
            close != null -> InlineTag(close.value.length) { withColor(it, close.groupValues[1], null) }
            else -> null
        }
    }

    private fun withFormat(run: InlineRun, name: String, on: Boolean): InlineRun = when (name) {
        "strong", "b" -> run.copy(bold = on)
        "u" -> run.copy(underline = on)
        "s", "del" -> run.copy(strike = on)
        else -> run.copy(italic = on)
    }

    private fun withColor(run: InlineRun, name: String, color: InlineColor?): InlineRun =
        if (name.equals(SPAN_TAG, ignoreCase = true)) run.copy(color = color) else run.copy(highlight = color)
}
