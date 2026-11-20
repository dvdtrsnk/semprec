package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals

/** Strikethrough, underline, text color and highlight: what the parser reads and the writer writes back. */
class PageInlineMarksTest {
    private fun assertRoundTrip(markdown: String, runs: List<InlineRun>) {
        assertEquals(runs, PageInlineParser.parse(markdown), "read $markdown")
        assertEquals(markdown, PageInlineWriter.serialize(runs), "written $runs")
    }

    private fun assertRunsRoundTrip(runs: List<InlineRun>) =
        assertEquals(runs, PageInlineParser.parse(PageInlineWriter.serialize(runs)))

    @Test fun `each new mark alone round trips`() {
        val cases = listOf(
            "a ~~gone~~ b" to InlineRun("gone", strike = true),
            "a <u>under</u> b" to InlineRun("under", underline = true),
            "a <span data-color=\"red\">red</span> b" to InlineRun("red", color = InlineColor.RED),
            "a <mark data-color=\"yellow\">marked</mark> b" to InlineRun("marked", highlight = InlineColor.YELLOW),
        )
        for ((markdown, marked) in cases) assertRoundTrip(markdown, listOf(InlineRun("a "), marked, InlineRun(" b")))
    }

    @Test fun `every color key round trips as text color and as highlight`() {
        for (color in InlineColor.entries) {
            assertEquals(color.name.lowercase(), color.key)
            assertRoundTrip("<span data-color=\"${color.key}\">x</span>", listOf(InlineRun("x", color = color)))
            assertRoundTrip("<mark data-color=\"${color.key}\">x</mark>", listOf(InlineRun("x", highlight = color)))
        }
    }

    @Test fun `an unknown color key is dropped and its text kept`() {
        assertEquals(
            listOf(InlineRun("x and y")),
            PageInlineParser.parse("<span data-color=\"teal\">x</span> and <mark data-color=\"Red\">y</mark>"),
        )
        assertEquals(null, InlineColor.fromKey("teal"))
    }

    @Test fun `an unknown color key inside a known one clears that color as the web reads it`() {
        assertEquals(
            listOf(InlineRun("a", color = InlineColor.RED), InlineRun("b"), InlineRun("c", highlight = InlineColor.BLUE)),
            PageInlineParser.parse(
                "<span data-color=\"red\">a<span data-color=\"teal\">b</span></span>" +
                    "<mark data-color=\"blue\">c</mark>",
            ),
        )
        assertEquals(
            listOf(InlineRun("a", highlight = InlineColor.GREEN), InlineRun("b")),
            PageInlineParser.parse("<mark data-color=\"green\">a<mark data-color=\"teal\">b</mark></mark>"),
        )
    }

    @Test fun `all marks nested are written outermost first`() {
        val all = InlineRun(
            "all",
            bold = true,
            italic = true,
            link = "https://example.com",
            strike = true,
            underline = true,
            color = InlineColor.RED,
            highlight = InlineColor.YELLOW,
        )
        val runs = listOf(
            InlineRun("Plain ~~ "),
            all,
            InlineRun(" then "),
            all.copy(text = "code", code = true, link = null, color = InlineColor.BLUE, highlight = InlineColor.GRAY),
        )
        assertRoundTrip(SAMPLE, runs)
    }

    @Test fun `marks in any valid nesting order are read`() {
        val all = InlineRun(
            "x",
            bold = true,
            italic = true,
            strike = true,
            underline = true,
            color = InlineColor.GREEN,
            highlight = InlineColor.PINK,
        )
        val markdowns = listOf(
            "<u>**<mark data-color=\"pink\">~~_<span data-color=\"green\">x</span>_~~</mark>**</u>",
            "_~~<span data-color=\"green\"><u><mark data-color=\"pink\">**x**</mark></u></span>~~_",
        )
        for (markdown in markdowns) assertEquals(listOf(all), PageInlineParser.parse(markdown), markdown)
        assertEquals(
            "<span data-color=\"green\"><mark data-color=\"pink\"><u>~~**_x_**~~</u></mark></span>",
            PageInlineWriter.serialize(listOf(all)),
        )
    }

    @Test fun `overlapping marks are split so they nest`() {
        val runs = listOf(
            InlineRun("a", color = InlineColor.RED),
            InlineRun("b", color = InlineColor.RED, underline = true, strike = true),
            InlineRun("c", underline = true, strike = true, bold = true),
            InlineRun("d", bold = true),
        )
        assertRoundTrip("<span data-color=\"red\">a<u>~~b~~</u></span><u>~~**c**~~</u>**d**", runs)
    }

    @Test fun `marks that cross a link boundary stay inside the link`() {
        val runs = listOf(
            InlineRun("a", link = "https://example.com"),
            InlineRun("b", link = "https://example.com", strike = true, bold = true),
            InlineRun("c", strike = true, bold = true),
        )
        assertRoundTrip("[a~~**b**~~](https://example.com)~~**c**~~", runs)
    }

    @Test fun `strikethrough at whitespace and across breaks round trips`() {
        assertRunsRoundTrip(listOf(InlineRun("a"), InlineRun(" b ", strike = true), InlineRun("c")))
        assertRunsRoundTrip(listOf(InlineRun("one\ntwo", strike = true, color = InlineColor.ORANGE)))
    }

    @Test fun `a literal tilde is escaped where it could form a delimiter`() {
        assertRoundTrip("a \\~\\~ b ~ c\\~\\~\\~", listOf(InlineRun("a ~~ b ~ c~~~")))
        assertRoundTrip(
            "a\\~~~\\~b~~\\~ ~",
            listOf(InlineRun("a~"), InlineRun("~b", strike = true), InlineRun("~ ~")),
        )
        assertEquals(listOf(InlineRun("a ~~ b")), PageInlineParser.parse("a ~~ b"))
    }

    @Test fun `markup inside a code span stays literal code`() {
        val code = "~~x~~ <u>y</u> <span data-color=\"red\">z</span> <mark data-color=\"blue\">w</mark>"
        assertRoundTrip("`$code`", listOf(InlineRun(code, code = true)))
        val struck = listOf(
            InlineRun("a ", strike = true),
            InlineRun("~~", strike = true, code = true),
            InlineRun(" b", strike = true),
        )
        assertRoundTrip("~~a `~~` b~~", struck)
    }

    @Test fun `the fixture vectors of the shared block model read and write the same`() {
        val blue = InlineColor.BLUE
        val linked = InlineRun(
            "all",
            bold = true,
            italic = true,
            link = "https://example.com",
            strike = true,
            underline = true,
            color = InlineColor.RED,
            highlight = InlineColor.YELLOW,
        )
        val roundTrips = listOf(
            "[<span data-color=\"red\"><mark data-color=\"yellow\"><u>~~**_all_ `code`**~~</u></mark></span>]" +
                "(https://example.com)" to
                listOf(
                    linked,
                    linked.copy(text = " ", italic = false),
                    linked.copy(text = "code", italic = false, code = true),
                ),
            "~~a~~<span data-color=\"blue\">~~b~~ c</span>" to listOf(
                InlineRun("a", strike = true),
                InlineRun("b", strike = true, color = blue),
                InlineRun(" c", color = blue),
            ),
            "a~~ b ~~c" to listOf(InlineRun("a"), InlineRun(" b ", strike = true), InlineRun("c")),
            "a \\~\\~ b ~ c\\~~~d~~\\~" to
                listOf(InlineRun("a ~~ b ~ c~"), InlineRun("d", strike = true), InlineRun("~")),
        )
        for ((markdown, runs) in roundTrips) assertRoundTrip(markdown, runs)
        val canonical = listOf(
            "~~<u>**<mark data-color=\"green\"><span data-color=\"blue\">x</span></mark>**</u>~~" to
                "<span data-color=\"blue\"><mark data-color=\"green\"><u>~~**x**~~</u></mark></span>",
            "<s>a</s><del>b</del><U>c</U>" to "~~ab~~<u>c</u>",
            "<span data-color=\"teal\">a</span> <mark data-color='teal'>b</mark> <mark data-color='pink'>c</mark>" to
                "a b <mark data-color=\"pink\">c</mark>",
        )
        for ((markdown, written) in canonical) {
            assertEquals(written, PageInlineWriter.serialize(PageInlineParser.parse(markdown)), markdown)
        }
    }

    private companion object {
        const val SAMPLE = "Plain \\~\\~ [<span data-color=\"red\"><mark data-color=\"yellow\"><u>~~**_all_**~~" +
            "</u></mark></span>](https://example.com) then <span data-color=\"blue\"><mark data-color=\"gray\"><u>" +
            "~~**_`code`_**~~</u></mark></span>"
    }
}
