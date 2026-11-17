package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals

/** The inline vectors of `shared/block-model/fixtures/markdown.json`: what the parser reads, the writer writes back. */
class PageInlineWriterTest {
    private fun roundTrip(markdown: String) {
        val runs = PageInlineParser.parse(markdown)
        assertEquals(markdown, PageInlineWriter.serialize(runs))
    }

    @Test fun `emphasis and mixed formatting round trip`() = roundTrip("**bold** and _italic_ and a*b*c and **_both_**")

    @Test fun `crossed formats are written as html tags`() = roundTrip("x<strong>ab<em>cd</strong>ef</em>y")

    @Test fun `escaped specials round trip`() = roundTrip("a \\* b \\_x\\_ \\<b> \\`c\\` \\[d\\] e\\\\f snake_case")

    @Test fun `links with brackets in the destination round trip`() =
        roundTrip("[**bold** link](<https://example.com/a_(b)>)")

    @Test fun `code with a backtick round trips`() = roundTrip("``a`b``")

    @Test fun `soft breaks round trip also inside code and bold`() {
        roundTrip("`a`<code><br></code>`b`")
        roundTrip("**a<br>b**")
        roundTrip("one<br>two")
    }

    @Test fun `significant boundary whitespace is written as references`() =
        roundTrip("&#x20;&#x9;Hello&#xd;&#xa0;")

    @Test fun `a literal whitespace reference stays literal`() = roundTrip("\\&#x20; and `&#x20;`")

    @Test fun `an item link round trips`() =
        roundTrip("Meeting: [Standup](semprec://items/3f2b8c1e-5a47-4d0b-9c61-7e2a1b9d4f10) at 9")

    @Test fun `typed runs are written without surprises`() {
        val runs = listOf(
            InlineRun("Schuzka "),
            InlineRun("dobra", bold = true),
            InlineRun(" a "),
            InlineRun("_x_", code = true),
        )
        assertEquals("Schuzka **dobra** a `_x_`", PageInlineWriter.serialize(runs))
    }
}
