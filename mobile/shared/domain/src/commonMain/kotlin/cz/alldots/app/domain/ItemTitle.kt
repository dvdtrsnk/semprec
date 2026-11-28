package cz.alldots.app.domain

private val lineBreak = Regex("""\s*[\r\n  ]+\s*""")

/**
 * A title as it is saved: on one line, each line break with the whitespace around it turned into one space, and
 * trimmed. A pasted title keeps its words apart instead of its lines.
 */
fun singleLineTitle(text: String): String = text.replace(lineBreak, " ").trim()
