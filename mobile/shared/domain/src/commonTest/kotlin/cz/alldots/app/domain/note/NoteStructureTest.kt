package cz.alldots.app.domain.note

import cz.alldots.app.domain.InlineRun
import cz.alldots.app.domain.PageBlockType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull

class NoteStructureTest {

    private val page = block("p", "Release", PageBlockType.PAGE, pageId = "p1")

    @Test fun `a type change resets done and leaves page blocks alone`() {
        val blocks = listOf(block("a", "x", PageBlockType.TODO, done = true), page)
        val changed = NoteStructure.setType(blocks, setOf("a", "p"), PageBlockType.H2)
        assertEquals(listOf("a:h2:0:x", "p:page:0:Release"), changed.shape())
        assertFalse(changed[0].done)
        assertFailsWith<IllegalArgumentException> { NoteStructure.setType(blocks, setOf("a"), PageBlockType.PAGE) }
    }

    @Test fun `toggling a list type switches it on for all or off when all have it`() {
        val blocks = listOf(block("a", "x"), block("b", "y", PageBlockType.TODO))
        val on = NoteStructure.toggleType(blocks, setOf("a", "b"), PageBlockType.TODO)
        assertEquals(listOf(PageBlockType.TODO, PageBlockType.TODO), on.map { it.type })
        val off = NoteStructure.toggleType(on, setOf("a", "b"), PageBlockType.TODO)
        assertEquals(listOf(PageBlockType.TEXT, PageBlockType.TEXT), off.map { it.type })
    }

    @Test fun `indent stays within 0 and 5`() {
        val blocks = listOf(block("a", indent = 5), block("b", indent = 0))
        assertEquals(listOf(5, 1), NoteStructure.shiftIndent(blocks, setOf("a", "b"), 1).map { it.indent })
        assertEquals(listOf(4, 0), NoteStructure.shiftIndent(blocks, setOf("a", "b"), -1).map { it.indent })
    }

    @Test fun `a page caption takes plain text only`() {
        val runs = listOf(InlineRun("New "), InlineRun("name", bold = true))
        assertEquals(listOf(InlineRun("New name")), NoteStructure.setRuns(listOf(page), "p", runs).single().runs)
    }

    @Test fun `moving keeps the moved blocks together in their order`() {
        val blocks = listOf(block("a"), block("b"), block("c"), block("d"), block("e"))
        assertEquals(listOf("a", "c", "d", "b", "e"), NoteStructure.move(blocks, setOf("b"), 4).map { it.id })
        assertEquals(listOf("b", "d", "a", "c", "e"), NoteStructure.move(blocks, setOf("b", "d"), 0).map { it.id })
        assertEquals(listOf("a", "c", "e", "b", "d"), NoteStructure.move(blocks, setOf("b", "d"), 5).map { it.id })
    }

    @Test fun `moved blocks shift their indent together and stay within the levels`() {
        val blocks = listOf(block("t", type = PageBlockType.TOGGLE), block("a"), block("b", indent = 1))
        val moved = NoteStructure.move(blocks, setOf("a", "b"), 1, indentDelta = 1)
        assertEquals(listOf("t:toggle:0:", "a:text:1:", "b:text:2:"), moved.shape())
        assertEquals(listOf(0, 0, 0), NoteStructure.move(blocks, setOf("b"), 1, indentDelta = -3).map { it.indent })
    }

    @Test fun `duplicates go right after the last selected block and page blocks are left to the server`() {
        val blocks = listOf(block("a", "x"), page, block("c", "y"), block("d", "z"))
        val copied = NoteStructure.duplicate(blocks, setOf("a", "p", "c"), TestIds().newId)
        assertEquals(listOf("a", "p", "c", "n1", "n2", "d"), copied.map { it.id })
        assertEquals(listOf("x", "y"), copied.subList(3, 5).map { it.plainText })
    }

    @Test fun `deleting every block leaves one empty text block`() {
        val left = NoteStructure.delete(listOf(block("a", "x"), page), setOf("a", "p"), TestIds().newId)
        assertEquals(listOf("n1:text:0:"), left.shape())
    }

    @Test fun `a tap below reuses an empty last text block or adds one`() {
        val reused = NoteStructure.tapBelow(listOf(block("a", "x"), block("b")), TestIds().newId)
        assertEquals(NoteCaret("b", 0), reused.caret)
        assertEquals(2, reused.blocks.size)
        val added = NoteStructure.tapBelow(listOf(block("a", "x", PageBlockType.BULLET)), TestIds().newId)
        assertEquals(listOf("a:bullet:0:x", "n1:text:0:"), added.blocks.shape())
        assertEquals(NoteCaret("n1", 0), added.caret)
    }

    @Test fun `ticking a block that is not a to-do changes nothing`() {
        val blocks = listOf(block("a", "x"))
        assertEquals(blocks, NoteStructure.toggleDone(blocks, "a"))
        assertNull(blocks.single().pageId)
    }
}
