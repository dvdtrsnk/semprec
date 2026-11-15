package cz.semprec.app.domain

private val TODO_MARKER = Regex("^(\\s*[-*] \\[)([ xX])(\\])")

/**
 * A change the person made to a page, addressed by the place of a block and checked against the text they saw
 * ([expectedText]), so it never lands on a block that changed meanwhile.
 */
sealed interface PageEdit {
    /** Replaces the text of a block; formatting of the parts of the text that stay is kept. */
    data class SetText(val index: Int, val expectedText: String, val text: String) : PageEdit

    data class ToggleDone(val index: Int, val expectedText: String) : PageEdit

    /** Adds a block with plain [text] after the last block. */
    data class Append(val type: PageBlockType, val text: String) : PageEdit
}

/** Applies a [PageEdit] to the Markdown of a page, changing only the lines of the edited block. */
object PageEditor {
    /** The new Markdown, or `null` when the edit no longer fits the page (the block moved, changed or is gone). */
    fun apply(markdown: String, edit: PageEdit): String? = when (edit) {
        is PageEdit.SetText -> setText(markdown, edit)
        is PageEdit.ToggleDone -> toggleDone(markdown, edit)
        is PageEdit.Append -> append(markdown, edit)
    }

    private fun setText(markdown: String, edit: PageEdit.SetText): String? {
        val block = PageMarkdown.parse(markdown).getOrNull(edit.index)
        val fits = block != null && block.type != PageBlockType.PAGE && block.plainText == edit.expectedText
        if (!fits || block == null) return null
        val changed = block.copy(runs = PageTextEdit.apply(block.runs, edit.text))
        val line = PageMarkdownWriter.contentLine(changed)
        val lines = markdown.split("\n")
        val comment = when {
            block.hasComment -> lines[block.firstLine]
            PageMarkdownWriter.needsComment(changed, line) -> PageMarkdownWriter.commentLine(changed)
            else -> null
        }
        return replaceLines(lines, block, listOfNotNull(comment, line.takeIf { it.isNotEmpty() }))
    }

    private fun toggleDone(markdown: String, edit: PageEdit.ToggleDone): String? {
        val block = PageMarkdown.parse(markdown).getOrNull(edit.index)
        val fits = block != null && block.type == PageBlockType.TODO && block.plainText == edit.expectedText
        if (!fits || block == null) return null
        val lines = markdown.split("\n")
        val toggled = TODO_MARKER.replace(lines[block.lastLine]) {
            val (open, _, close) = it.destructured
            open + (if (block.done) " " else "x") + close
        }
        return replaceLines(lines, block.copy(firstLine = block.lastLine), listOf(toggled))
    }

    private fun append(markdown: String, edit: PageEdit.Append): String? {
        if (edit.text.isBlank() || edit.type == PageBlockType.PAGE) return null
        val added = PageBlock(
            type = edit.type,
            indent = 0,
            done = false,
            runs = listOf(InlineRun(edit.text.trim())),
            pageId = null,
            firstLine = 0,
            lastLine = 0,
        )
        val lines = PageMarkdownWriter.blockLines(added).joinToString("\n")
        val last = PageMarkdown.parse(markdown).lastOrNull()
        val body = markdown.trimEnd('\n', '\r')
        val continuesList = last != null && PageMarkdownWriter.isList(last.type) &&
            PageMarkdownWriter.isList(added.type)
        return when {
            body.isBlank() -> lines
            continuesList -> "$body\n$lines"
            else -> "$body\n\n$lines"
        }
    }

    private fun replaceLines(lines: List<String>, block: PageBlock, replacement: List<String>): String {
        val result = lines.subList(0, block.firstLine) + replacement + lines.subList(block.lastLine + 1, lines.size)
        return result.joinToString("\n")
    }
}
