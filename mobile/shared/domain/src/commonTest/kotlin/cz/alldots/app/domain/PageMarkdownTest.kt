package cz.alldots.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Vectors taken from `shared/block-model/fixtures/markdown.json`, the contract the TypeScript parser keeps. */
class PageMarkdownTest {
    private fun runs(markdown: String): List<InlineRun> = PageMarkdown.parse(markdown).single().runs

    @Test fun `the project notes sample reads as typed blocks`() {
        val markdown = "## Project notes\n\nBuild `0.4 (52)` is out, see [the spec](https://example.com/spec)\n\n" +
            "- Release checklist\n  - Tag the build\n- [x] Ship build `0.4 (52)`\n\n> Keep the scope small\n\n" +
            "[Roadmap](alldots://page/page-roadmap)"
        val blocks = PageMarkdown.parse(markdown)
        assertEquals(
            listOf(
                PageBlockType.H2, PageBlockType.TEXT, PageBlockType.BULLET, PageBlockType.BULLET,
                PageBlockType.TODO, PageBlockType.QUOTE, PageBlockType.PAGE,
            ),
            blocks.map { it.type },
        )
        assertEquals(listOf(0, 0, 0, 1, 0, 0, 0), blocks.map { it.indent })
        assertEquals(
            listOf(
                InlineRun("Build "),
                InlineRun("0.4 (52)", code = true),
                InlineRun(" is out, see "),
                InlineRun("the spec", link = "https://example.com/spec"),
            ),
            blocks[1].runs,
        )
        assertTrue(blocks[4].done)
        assertEquals("page-roadmap", blocks[6].pageId)
        assertEquals("Roadmap", blocks[6].plainText)
        assertEquals(listOf(0, 2, 4, 5, 6, 8, 10), blocks.map { it.firstLine })
    }

    @Test fun `inline formatting becomes runs without syntax`() {
        assertEquals(
            listOf(
                InlineRun("bold", bold = true),
                InlineRun(" and "),
                InlineRun("italic", italic = true),
                InlineRun(" and a"),
                InlineRun("b", italic = true),
                InlineRun("c and "),
                InlineRun("both", bold = true, italic = true),
            ),
            runs("**bold** and _italic_ and a*b*c and **_both_**"),
        )
    }

    @Test fun `html tags that cross are read as overlapping formats`() {
        assertEquals(
            listOf(
                InlineRun("x"),
                InlineRun("ab", bold = true),
                InlineRun("cd", bold = true, italic = true),
                InlineRun("ef", italic = true),
                InlineRun("y"),
            ),
            runs("x<strong>ab<em>cd</strong>ef</em>y"),
        )
    }

    @Test fun `escapes and unmatched delimiters stay literal text`() {
        val escaped = runs("a \\* b \\_x\\_ \\<b> \\`c\\` \\[d\\] e\\\\f snake_case")
        assertEquals("a * b _x_ <b> `c` [d] e\\f snake_case", escaped.single().text)
        assertEquals("5 * 3 and a_b and 2 ** 4", runs("5 * 3 and a_b and 2 ** 4").single().text)
    }

    @Test fun `a link with parentheses carries its formatting`() {
        assertEquals(
            listOf(
                InlineRun("bold", bold = true, link = "https://example.com/a_(b)"),
                InlineRun(" link", link = "https://example.com/a_(b)"),
            ),
            runs("[**bold** link](<https://example.com/a_(b)>)"),
        )
    }

    @Test fun `code with a backtick and soft breaks are read`() {
        assertEquals(listOf(InlineRun("a`b", code = true)), runs("``a`b``"))
        assertEquals(listOf(InlineRun("a\nb", bold = true)), runs("**a<br>b**"))
        assertEquals(listOf(InlineRun("&#x20; and "), InlineRun("&#x20;", code = true)), runs("\\&#x20; and `&#x20;`"))
    }

    @Test fun `whitespace references are read as the whitespace`() {
        assertEquals(" \tHello\r ", runs("&#x20;&#x9;Hello&#xd;&#xa0;").single().text)
    }

    @Test fun `alternative markers are accepted on read`() {
        val blocks = PageMarkdown.parse("* star bullet\n* [X] done todo\n3. third\n4. fourth")
        assertEquals(
            listOf(PageBlockType.BULLET, PageBlockType.TODO, PageBlockType.NUMBER, PageBlockType.NUMBER),
            blocks.map {
                it.type
            }
        )
        assertTrue(blocks[1].done)
    }

    @Test fun `a comment keeps an unknown type and the indent of a non list block`() {
        val unknown = PageMarkdown.parse("<!-- alldots:block id=u1 type=callout indent=2 -->\nHeads up").single()
        assertEquals(PageBlockType.TEXT, unknown.type)
        assertEquals("callout", unknown.preservedType)
        assertEquals(2, unknown.indent)
        assertEquals(0, unknown.firstLine)
        assertEquals(1, unknown.lastLine)
        val indented = PageMarkdown.parse(
            "<!-- alldots:block id=h1 type=h2 indent=3 -->\n## Title\n\n" +
                "<!-- alldots:block id=q1 type=quote indent=1 -->\n> Quoted",
        )
        assertEquals(listOf(PageBlockType.H2, PageBlockType.QUOTE), indented.map { it.type })
        assertEquals(listOf(3, 1), indented.map { it.indent })
    }

    @Test fun `a comment alone is an empty block`() {
        val block = PageMarkdown.parse("<!-- alldots:block id=e1 type=text indent=0 -->").single()
        assertEquals(PageBlockType.TEXT, block.type)
        assertEquals("", block.plainText)
        assertTrue(block.hasComment)
    }

    @Test fun `two lines without a blank line are two blocks`() {
        val blocks = PageMarkdown.parse("first line\nsecond line")
        assertEquals(listOf("first line", "second line"), blocks.map { it.plainText })
    }

    @Test fun `escaped line starts are plain text`() {
        val blocks = PageMarkdown.parse("\\# not a heading\n\n\\- not a list\n\n\\> not a quote\n\n16\\. 10. jsme...")
        assertEquals(List(4) { PageBlockType.TEXT }, blocks.map { it.type })
        val texts = listOf("# not a heading", "- not a list", "> not a quote", "16. 10. jsme...")
        assertEquals(texts, blocks.map { it.plainText })
    }

    @Test fun `an empty document has no blocks to show`() {
        assertEquals(emptyList(), PageMarkdown.parse(""))
    }

    @Test fun `a page link in the diary is a subpage block with its caption`() {
        val block = PageMarkdown.parse("[Krkonose - co sbalit](alldots://page/jv1)").single()
        assertEquals(PageBlockType.PAGE, block.type)
        assertEquals("jv1", block.pageId)
        assertEquals("Krkonose - co sbalit", block.plainText)
        assertNull(PageMarkdown.parse("plain").single().pageId)
    }
}
