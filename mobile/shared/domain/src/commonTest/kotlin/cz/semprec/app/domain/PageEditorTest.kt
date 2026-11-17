package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PageEditorTest {
    private val diary =
        "Schuzka s Petrem dopadla dobre, **rozpocet schvaleny**.\n\nOdpoledne jsem se dostal k deniku.\n\n" +
            "[Krkonose](semprec://page/jv1)"

    @Test fun `editing a block rewrites only its own lines`() {
        val edit = PageEdit.SetText(1, "Odpoledne jsem se dostal k deniku.", "Odpoledne jsem psal denik.")
        assertEquals(
            "Schuzka s Petrem dopadla dobre, **rozpocet schvaleny**.\n\nOdpoledne jsem psal denik.\n\n" +
                "[Krkonose](semprec://page/jv1)",
            PageEditor.apply(diary, edit),
        )
    }

    @Test fun `editing keeps the formatting of the text that stays`() {
        val before = "Schuzka s Petrem dopadla dobre, rozpocet schvaleny."
        val edit = PageEdit.SetText(0, before, before.replace("dobre", "skvele"))
        val result = PageEditor.apply(diary, edit)
        assertEquals(
            "Schuzka s Petrem dopadla skvele, **rozpocet schvaleny**.",
            result?.substringBefore("\n\n"),
        )
    }

    @Test fun `a page link block is never edited as text`() {
        assertNull(PageEditor.apply(diary, PageEdit.SetText(2, "Krkonose", "Jine")))
    }

    @Test fun `an edit of a block that changed meanwhile is refused`() {
        assertNull(PageEditor.apply(diary, PageEdit.SetText(1, "Old text", "New")))
        assertNull(PageEditor.apply(diary, PageEdit.SetText(7, "x", "y")))
    }

    @Test fun `clearing a text block keeps it as an empty block with a comment`() {
        val result = PageEditor.apply("one\n\ntwo", PageEdit.SetText(0, "one", ""))
        assertEquals("<!-- semprec:block type=text indent=0 -->\n\ntwo", result)
        assertEquals(listOf("", "two"), PageMarkdown.parse(result.orEmpty()).map { it.plainText })
    }

    @Test fun `an existing comment of an edited block is kept with its id`() {
        val markdown = "<!-- semprec:block id=h1 type=h2 indent=3 -->\n## Title"
        val result = PageEditor.apply(markdown, PageEdit.SetText(0, "Title", "New title"))
        assertEquals("<!-- semprec:block id=h1 type=h2 indent=3 -->\n## New title", result)
    }

    @Test fun `special characters typed in a block are escaped`() {
        val result = PageEditor.apply("x", PageEdit.SetText(0, "x", "# not a heading *and* [this]"))
        assertEquals("\\# not a heading \\*and\\* \\[this\\]", result)
    }

    @Test fun `toggling a todo changes only its marker`() {
        val markdown = "- [ ] Pohorky\n- [x] **Bunda**\n\nText"
        val first = PageEditor.apply(markdown, PageEdit.ToggleDone(0, "Pohorky"))
        val second = PageEditor.apply(markdown, PageEdit.ToggleDone(1, "Bunda"))
        assertEquals("- [x] Pohorky\n- [x] **Bunda**\n\nText", first)
        assertEquals("- [ ] Pohorky\n- [ ] **Bunda**\n\nText", second)
    }

    @Test fun `toggling something that is not that todo is refused`() {
        assertNull(PageEditor.apply("- [ ] Pohorky\n\nText", PageEdit.ToggleDone(1, "Text")))
        assertNull(PageEditor.apply("- [ ] Pohorky", PageEdit.ToggleDone(0, "Other")))
    }

    @Test fun `a toggled todo with a comment keeps the comment`() {
        val markdown = "<!-- semprec:block id=t1 type=todo indent=2 -->\n    - [ ] Deep"
        val result = PageEditor.apply(markdown, PageEdit.ToggleDone(0, "Deep"))
        assertEquals("<!-- semprec:block id=t1 type=todo indent=2 -->\n    - [x] Deep", result)
    }

    @Test fun `appending adds a block after a blank line`() {
        assertEquals("$diary\n\nNew line", PageEditor.apply(diary, PageEdit.Append(PageBlockType.TEXT, "New line")))
        assertEquals("New line", PageEditor.apply("", PageEdit.Append(PageBlockType.TEXT, "New line")))
    }

    @Test fun `appending a list item continues the list without a blank line`() {
        assertEquals("- a\n- b\n- c", PageEditor.apply("- a\n- b", PageEdit.Append(PageBlockType.BULLET, "c")))
        assertEquals("- a\n\n## c", PageEditor.apply("- a", PageEdit.Append(PageBlockType.H2, "c")))
        assertEquals("- [ ] c", PageEditor.apply("", PageEdit.Append(PageBlockType.TODO, "c")))
        assertEquals("> c", PageEditor.apply("", PageEdit.Append(PageBlockType.QUOTE, "c")))
        assertEquals("1. c", PageEditor.apply("", PageEdit.Append(PageBlockType.NUMBER, "c")))
    }

    @Test fun `appending nothing or a page is refused`() {
        assertNull(PageEditor.apply("x", PageEdit.Append(PageBlockType.TEXT, "   ")))
        assertNull(PageEditor.apply("x", PageEdit.Append(PageBlockType.PAGE, "t")))
    }

    @Test fun `the trailing newline of the server is not duplicated by an append`() {
        assertEquals("a\n\nb", PageEditor.apply("a\n", PageEdit.Append(PageBlockType.TEXT, "b")))
    }
}

class PageTextEditTest {
    private val runs = listOf(InlineRun("Hello "), InlineRun("bold", bold = true), InlineRun(" world"))

    @Test fun `an unchanged text keeps every run`() {
        assertEquals(runs, PageTextEdit.apply(runs, "Hello bold world"))
    }

    @Test fun `text typed inside a formatted run takes its format`() {
        val result = PageTextEdit.apply(runs, "Hello boXld world")
        assertEquals(listOf(InlineRun("Hello "), InlineRun("boXld", bold = true), InlineRun(" world")), result)
    }

    @Test fun `text typed after a link does not extend the link`() {
        val linked = listOf(InlineRun("see "), InlineRun("docs", link = "https://x.test"))
        val result = PageTextEdit.apply(linked, "see docs!")
        assertEquals(listOf(InlineRun("see "), InlineRun("docs", link = "https://x.test"), InlineRun("!")), result)
    }

    @Test fun `deleting a whole formatted run removes it`() {
        assertEquals(listOf(InlineRun("Hello world")), PageTextEdit.apply(runs, "Hello world"))
    }

    @Test fun `typing into an empty block is plain text`() {
        assertEquals(listOf(InlineRun("new")), PageTextEdit.apply(emptyList(), "new"))
        assertEquals(emptyList(), PageTextEdit.apply(runs, ""))
    }
}
