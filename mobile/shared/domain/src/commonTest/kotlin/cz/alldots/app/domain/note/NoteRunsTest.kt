package cz.alldots.app.domain.note

import cz.alldots.app.domain.InlineRun
import cz.alldots.app.domain.PageBlockType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NoteRunsTest {

    private val runs = listOf(InlineRun("Hello "), InlineRun("bold", bold = true), InlineRun(" world"))

    @Test fun `toggling a mark sets it on a range and takes it off when the range has it`() {
        val on = NoteRuns.toggle(runs, 0, 5, NoteMark.ITALIC)
        assertEquals(InlineRun("Hello", italic = true), on.first())
        assertEquals(runs, NoteRuns.toggle(on, 0, 5, NoteMark.ITALIC))
        assertTrue(NoteRuns.has(runs, 6, 10, NoteMark.BOLD))
        assertFalse(NoteRuns.has(runs, 4, 10, NoteMark.BOLD))
        assertEquals(listOf(InlineRun("Hello bold world")), NoteRuns.toggle(runs, 6, 10, NoteMark.BOLD))
    }

    @Test fun `links are set and taken off and found at an offset`() {
        val linked = NoteRuns.link(runs, 11, 16, "https://x.cz")
        assertEquals("https://x.cz", NoteLinks.at(linked, 12))
        assertNull(NoteLinks.at(linked, 3))
        assertEquals(runs, NoteRuns.link(linked, 11, 16, null))
    }

    @Test fun `a link range spans every run of one link and ends at a different one`() {
        val boldLink = NoteRuns.link(runs, 6, 16, "https://a.cz")
        assertEquals(6 until 16, NoteLinks.range(boldLink, 7))
        assertEquals(6 until 16, NoteLinks.range(boldLink, 16))
        val two = NoteRuns.link(boldLink, 11, 16, "https://b.cz")
        assertEquals(6 until 11, NoteLinks.range(two, 8))
        assertNull(NoteLinks.range(two, 2))
    }

    @Test fun `clearing a stretch takes its formats and its link off and leaves the rest`() {
        val linked = NoteRuns.link(runs, 6, 16, "https://x.cz")
        val cleared = NoteRunStyles.clear(linked, 3, 12)
        assertEquals(
            listOf(InlineRun("Hello bold w"), InlineRun("orld", link = "https://x.cz")),
            cleared,
        )
    }

    @Test fun `inserted text takes the format before it`() {
        val expected = listOf(InlineRun("Hello "), InlineRun("boldly", bold = true), InlineRun(" world"))
        assertEquals(expected, NoteRuns.insert(runs, 10, "ly"))
    }

    @Test fun `the word around the cursor is found only inside a word`() {
        assertEquals(6 until 10, NoteWords.wordAround("Hello bold world", 8))
        assertNull(NoteWords.wordAround("Hello bold world", 6))
        assertNull(NoteWords.wordAround("Hello bold world", 10))
    }

    @Test fun `a link address without a scheme gets https`() {
        assertEquals("https://alldots.cz", NoteWords.linkAddress(" alldots.cz "))
        assertEquals("mailto:a@b.cz", NoteWords.linkAddress("mailto:a@b.cz"))
    }

    @Test fun `pasting one line goes into the block and several lines become blocks`() {
        val ids = TestIds()
        val one = NotePaste.paste(listOf(block("a", "ab")), NoteCaret("a", 1), "XY", ids.newId)
        assertEquals(listOf("a:text:0:aXYb"), one.blocks.shape())
        assertEquals(NoteCaret("a", 3), one.caret)
        val list = listOf(block("a", "start|end", PageBlockType.BULLET, indent = 1))
        val many = NotePaste.paste(list, NoteCaret("a", 6), "one\n1. two\nthree", ids.newId)
        assertEquals(
            listOf("a:bullet:1:start|one", "n1:number:1:two", "n2:bullet:1:threeend"),
            many.blocks.shape(),
        )
        assertEquals(NoteCaret("n2", 5), many.caret)
    }

    @Test fun `nothing is pasted into a page block`() {
        val page = listOf(block("p", "Page", PageBlockType.PAGE, pageId = "p1"))
        assertEquals(page, NotePaste.paste(page, NoteCaret("p", 1), "x", TestIds().newId).blocks)
    }
}
