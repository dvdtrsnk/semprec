package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Toggle blocks and toggle headings: the lines the writer gives them and how they read back. */
class PageToggleMarkdownTest {
    private fun block(type: PageBlockType, text: String, indent: Int = 0, toggle: Boolean = false) = PageBlock(
        type = type,
        indent = indent,
        done = false,
        runs = if (text.isEmpty()) emptyList() else listOf(InlineRun(text)),
        pageId = null,
        firstLine = 0,
        lastLine = 0,
        toggle = toggle,
    )

    private fun readBack(block: PageBlock): PageBlock =
        PageMarkdown.parse(PageMarkdownWriter.blockLines(block).joinToString("\n")).single()

    @Test fun `a toggle always carries its comment and reads back as a toggle`() {
        val cases = listOf(
            block(PageBlockType.TOGGLE, "Details", indent = 0) to
                listOf("<!-- semprec:block type=toggle indent=0 -->", "Details"),
            block(PageBlockType.TOGGLE, "# Not a heading", indent = 2) to
                listOf("<!-- semprec:block type=toggle indent=2 -->", "\\# Not a heading"),
            block(PageBlockType.TOGGLE, "", indent = 1) to listOf("<!-- semprec:block type=toggle indent=1 -->"),
        )
        for ((toggle, lines) in cases) {
            assertEquals(lines, PageMarkdownWriter.blockLines(toggle))
            val read = readBack(toggle)
            assertEquals(PageBlockType.TOGGLE, read.type)
            assertEquals(toggle.indent, read.indent)
            assertEquals(toggle.plainText, read.plainText)
            assertFalse(PageMarkdownWriter.isList(read.type))
        }
    }

    @Test fun `a toggle keeps its inline marks`() {
        val runs = listOf(InlineRun("Open "), InlineRun("me", strike = true, color = InlineColor.PURPLE))
        val toggle = block(PageBlockType.TOGGLE, "").copy(runs = runs)
        assertEquals(
            listOf("<!-- semprec:block type=toggle indent=0 -->", "Open <span data-color=\"purple\">~~me~~</span>"),
            PageMarkdownWriter.blockLines(toggle),
        )
        assertEquals(runs, readBack(toggle).runs)
    }

    @Test fun `the children of a toggle are the following blocks with greater indent`() {
        val blocks = PageMarkdown.parse(
            "<!-- semprec:block id=t1 type=toggle indent=0 -->\nTrip\n\n" +
                "<!-- semprec:block id=c1 type=text indent=1 -->\nPack boots\n\n  - Socks",
        )
        assertEquals(listOf(PageBlockType.TOGGLE, PageBlockType.TEXT, PageBlockType.BULLET), blocks.map { it.type })
        assertEquals(listOf(0, 1, 1), blocks.map { it.indent })
    }

    @Test fun `a toggle heading carries toggle in its comment and reads back`() {
        for (type in listOf(PageBlockType.H1, PageBlockType.H2, PageBlockType.H3)) {
            val heading = block(type, "Section", toggle = true)
            val marker = "#".repeat(type.ordinal)
            assertEquals(
                listOf("<!-- semprec:block type=${type.name.lowercase()} indent=0 toggle=true -->", "$marker Section"),
                PageMarkdownWriter.blockLines(heading),
            )
            val read = readBack(heading)
            assertEquals(type, read.type)
            assertTrue(read.toggle)
            assertEquals(listOf("$marker Section"), PageMarkdownWriter.blockLines(heading.copy(toggle = false)))
            assertFalse(readBack(heading.copy(toggle = false)).toggle)
        }
        val empty = PageMarkdown.parse("<!-- semprec:block id=e1 type=h2 indent=0 toggle=true -->").single()
        assertEquals(PageBlockType.H2, empty.type)
        assertTrue(empty.toggle)
    }

    @Test fun `toggle true is ignored on blocks that are not headings`() {
        val markdown = "<!-- semprec:block id=a type=text indent=0 toggle=true -->\nplain\n\n" +
            "<!-- semprec:block id=b type=bullet indent=0 toggle=true -->\n- item\n\n" +
            "<!-- semprec:block id=c type=toggle indent=0 toggle=true -->\nfold\n\n" +
            "<!-- semprec:block id=d type=quote indent=0 toggle=true -->"
        val blocks = PageMarkdown.parse(markdown)
        assertEquals(
            listOf(PageBlockType.TEXT, PageBlockType.BULLET, PageBlockType.TOGGLE, PageBlockType.QUOTE),
            blocks.map { it.type },
        )
        assertEquals(List(4) { false }, blocks.map { it.toggle })
        assertEquals(listOf("plain"), PageMarkdownWriter.blockLines(block(PageBlockType.TEXT, "plain", toggle = true)))
        assertEquals(
            listOf("<!-- semprec:block type=toggle indent=0 -->", "fold"),
            PageMarkdownWriter.blockLines(block(PageBlockType.TOGGLE, "fold", toggle = true)),
        )
    }
}
