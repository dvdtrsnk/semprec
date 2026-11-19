package cz.semprec.app.domain.note

import cz.semprec.app.domain.InlineRun
import cz.semprec.app.domain.PageBlockType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NoteTypingTest {

    @Test fun `enter splits a block at the cursor and keeps formatting on both sides`() {
        val runs = listOf(InlineRun("Hello "), InlineRun("bold", bold = true))
        val bold = NoteBlock("a", PageBlockType.TEXT, runs = runs)
        val change = NoteTyping.enter(listOf(bold), NoteCaret("a", 8), TestIds().newId)
        assertEquals(listOf(InlineRun("Hello "), InlineRun("bo", bold = true)), change.blocks[0].runs)
        assertEquals(listOf(InlineRun("ld", bold = true)), change.blocks[1].runs)
        assertEquals(NoteCaret("n1", 0), change.caret)
    }

    @Test fun `enter keeps a list type and the indent and the new to-do is not done`() {
        val cases = listOf(
            PageBlockType.BULLET to PageBlockType.BULLET,
            PageBlockType.NUMBER to PageBlockType.NUMBER,
            PageBlockType.TODO to PageBlockType.TODO,
            PageBlockType.H1 to PageBlockType.TEXT,
            PageBlockType.QUOTE to PageBlockType.TEXT,
            PageBlockType.TEXT to PageBlockType.TEXT,
        )
        for ((type, next) in cases) {
            val start = block("a", "abcd", type, indent = 2, done = true)
            val created = NoteTyping.enter(listOf(start), NoteCaret("a", 2), TestIds().newId).blocks[1]
            assertEquals(next, created.type, "$type")
            assertEquals(2, created.indent)
            assertFalse(created.done)
        }
    }

    @Test fun `enter at the start of a block with text puts an empty block above it`() {
        val change = NoteTyping.enter(listOf(block("a", "text")), NoteCaret("a", 0), TestIds().newId)
        assertEquals(listOf("n1:text:0:", "a:text:0:text"), change.blocks.shape())
        assertEquals(NoteCaret("a", 0), change.caret)
    }

    @Test fun `enter on an empty block steps out before it adds a new text block`() {
        val ids = TestIds()
        var blocks = listOf(block("a", type = PageBlockType.BULLET, indent = 1))
        blocks = NoteTyping.enter(blocks, NoteCaret("a", 0), ids.newId).blocks
        assertEquals(listOf("a:bullet:0:"), blocks.shape())
        blocks = NoteTyping.enter(blocks, NoteCaret("a", 0), ids.newId).blocks
        assertEquals(listOf("a:text:0:"), blocks.shape())
        val change = NoteTyping.enter(blocks, NoteCaret("a", 0), ids.newId)
        assertEquals(listOf("a:text:0:", "n1:text:0:"), change.blocks.shape())
        assertEquals(NoteCaret("n1", 0), change.caret)
    }

    @Test fun `enter on a page block only ends editing`() {
        val page = block("p", "Release", PageBlockType.PAGE, pageId = "p1")
        val change = NoteTyping.enter(listOf(page), NoteCaret("p", 3), TestIds().newId)
        assertEquals(listOf(page), change.blocks)
        assertNull(change.caret)
    }

    @Test fun `backspace at the start outdents then becomes text then joins the block above`() {
        val ids = TestIds()
        var blocks = listOf(
            block("a", "one", PageBlockType.H2, indent = 1),
            block("b", "two", PageBlockType.TODO, 1, true),
        )
        blocks = NoteTyping.backspaceAtStart(blocks, "b", ids.newId).blocks
        assertEquals("b:todo:0:two", blocks.shape()[1])
        blocks = NoteTyping.backspaceAtStart(blocks, "b", ids.newId).blocks
        assertEquals("b:text:0:two", blocks.shape()[1])
        assertFalse(blocks[1].done)
        val change = NoteTyping.backspaceAtStart(blocks, "b", ids.newId)
        assertEquals(listOf("a:h2:1:onetwo"), change.blocks.shape())
        assertEquals(NoteCaret("a", 3), change.caret)
    }

    @Test fun `backspace never writes into a page block`() {
        val page = block("p", "Release", PageBlockType.PAGE, pageId = "p1")
        val withText = listOf(page, block("b", "keep"))
        assertEquals(withText, NoteTyping.backspaceAtStart(withText, "b", TestIds().newId).blocks)
        val empty = listOf(block("t", "top"), page, block("b"))
        val change = NoteTyping.backspaceAtStart(empty, "b", TestIds().newId)
        assertEquals(listOf("t:text:0:top", "p:page:0:Release"), change.blocks.shape())
        assertEquals(NoteCaret("t", 3), change.caret)
    }

    @Test fun `backspace at the start of the first block changes nothing`() {
        val blocks = listOf(block("a", "only"))
        assertEquals(blocks, NoteTyping.backspaceAtStart(blocks, "a", TestIds().newId).blocks)
    }

    @Test fun `delete at the end joins the next block but never a page block`() {
        val blocks = listOf(block("a", "one"), block("b", "two"), block("p", "Page", PageBlockType.PAGE, pageId = "p1"))
        val joined = NoteTyping.deleteAtEnd(blocks, "a")
        assertEquals(listOf("a:text:0:onetwo", "p:page:0:Page"), joined.blocks.shape())
        assertEquals(joined.blocks, NoteTyping.deleteAtEnd(joined.blocks, "a").blocks)
    }

    @Test fun `markdown prefixes turn a text block into their type and are removed`() {
        val cases = mapOf(
            "# " to PageBlockType.H1, "## " to PageBlockType.H2, "### " to PageBlockType.H3,
            "- " to PageBlockType.BULLET, "* " to PageBlockType.BULLET, "• " to PageBlockType.BULLET,
            "1. " to PageBlockType.NUMBER, "1) " to PageBlockType.NUMBER,
            "[] " to PageBlockType.TODO, "[ ] " to PageBlockType.TODO, "[x] " to PageBlockType.TODO,
            "> " to PageBlockType.QUOTE,
        )
        for ((prefix, type) in cases) {
            val change = NoteTyping.applyPrefix(listOf(block("a", "${prefix}Milk")), "a")
            assertEquals(type, change?.blocks?.single()?.type, prefix)
            assertEquals("Milk", change?.blocks?.single()?.plainText)
            assertEquals(prefix == "[x] ", change?.blocks?.single()?.done)
            assertEquals(NoteCaret("a", 0), change?.caret)
        }
        assertNull(NoteTyping.applyPrefix(listOf(block("a", "-no space")), "a"))
        assertNull(NoteTyping.applyPrefix(listOf(block("a", "# Title", PageBlockType.BULLET)), "a"))
    }

    @Test fun `command enter ticks a to-do and makes any other line one`() {
        val blocks = listOf(block("a", "x", PageBlockType.TODO), block("b", "y", PageBlockType.H1))
        val once = NoteTyping.commandEnter(NoteTyping.commandEnter(blocks, "a"), "b")
        assertTrue(once[0].done)
        assertEquals(PageBlockType.TODO, once[1].type)
        assertFalse(once[1].done)
    }
}
