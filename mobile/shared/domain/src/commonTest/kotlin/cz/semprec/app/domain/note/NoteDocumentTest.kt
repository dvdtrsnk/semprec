package cz.semprec.app.domain.note

import cz.semprec.app.domain.InlineRun
import cz.semprec.app.domain.PageBlockType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NoteDocumentTest {

    @Test fun `an empty page reads as one empty text block`() {
        assertEquals(listOf("n1:text:0:"), NoteDocument.read("", TestIds().newId).shape())
        assertTrue(NoteDocument.isBlank(NoteDocument.read("", TestIds().newId)))
    }

    @Test fun `normalizing clamps the indent keeps done only on a to-do and a page id only on a page`() {
        val blocks = listOf(
            block("a", "x", indent = 9, done = true),
            block("b", "y", PageBlockType.TODO, indent = -1, done = true),
            NoteBlock("c", PageBlockType.TEXT, pageId = "p1"),
            NoteBlock("d", PageBlockType.PAGE, pageId = null, runs = listOf(InlineRun("Orphan"))),
        )
        val normalized = NoteDocument.normalize(blocks, TestIds().newId)
        assertEquals(listOf("a:text:5:x", "b:todo:0:y", "c:text:0:", "d:text:0:Orphan"), normalized.shape())
        assertEquals(listOf(false, true), normalized.take(2).map { it.done })
        assertEquals(listOf(null, null), normalized.drop(2).map { it.pageId })
    }

    @Test fun `a block of an unknown type reads as text and keeps its type when written back`() {
        val markdown = "<!-- semprec:block type=callout indent=0 -->\nWatch out"
        val blocks = NoteDocument.read(markdown, TestIds().newId)
        assertEquals(PageBlockType.TEXT, blocks.single().type)
        assertEquals("callout", blocks.single().preservedType)
        assertEquals(markdown, NoteDocument.markdown(blocks))
    }

    @Test fun `markdown round-trips every type formatting soft breaks and list runs`() {
        val markdown = listOf(
            "# Title", "", "Some **bold** and _italic_ and `code` and [a link](https://x.cz)<br>next line", "",
            "- one", "  - two", "1. first", "- [x] done", "- [ ] open", "", "> quoted", "",
            "[Release checklist](semprec://page/p1)",
        ).joinToString("\n")
        val blocks = NoteDocument.read(markdown, TestIds().newId)
        assertEquals(markdown, NoteDocument.markdown(blocks))
        assertEquals("Some bold and italic and code and a link\nnext line", blocks[1].plainText)
    }

    @Test fun `words are counted over every block`() {
        val blocks = listOf(block("a", "Hello  world"), block("b", "  "), block("c", "one\ntwo"))
        assertEquals(4, NoteDocument.wordCount(blocks))
    }

    @Test fun `bullets cycle by indent and numbers nest under numbers`() {
        val blocks = listOf(
            block("a", "x", PageBlockType.BULLET), block("b", "x", PageBlockType.BULLET, 1),
            block("c", "x", PageBlockType.BULLET, 2), block("d", "x", PageBlockType.BULLET, 3),
            block("e", "x", PageBlockType.NUMBER), block("f", "x", PageBlockType.NUMBER, 1),
            block("g", "x", PageBlockType.NUMBER, 1), block("h", "x", PageBlockType.NUMBER),
            block("i", "x"), block("j", "x", PageBlockType.NUMBER),
        )
        val expected = listOf(
            NoteMarker.Bullet(0), NoteMarker.Bullet(1), NoteMarker.Bullet(2), NoteMarker.Bullet(0),
            NoteMarker.Number("1."), NoteMarker.Number("1.1."), NoteMarker.Number("1.2."), NoteMarker.Number("2."),
            null, NoteMarker.Number("1."),
        )
        assertEquals(expected, NoteMarkers.of(blocks))
    }

    @Test fun `lists inside a toggle count from the toggle's children and nested toggles start again`() {
        val blocks = listOf(
            block("t", "Plan", PageBlockType.TOGGLE),
            block("n1", "a", PageBlockType.NUMBER, indent = 1),
            block("n2", "b", PageBlockType.NUMBER, indent = 2),
            block("n3", "c", PageBlockType.NUMBER, indent = 1),
            block("b1", "d", PageBlockType.BULLET, indent = 1),
            block("inner", "More", PageBlockType.TOGGLE, indent = 1),
            block("n4", "e", PageBlockType.NUMBER, indent = 2),
            block("b2", "f", PageBlockType.BULLET, indent = 3),
            block("out", "g", PageBlockType.NUMBER),
        )
        val expected = listOf(
            null, NoteMarker.Number("1."), NoteMarker.Number("1.1."), NoteMarker.Number("2."), NoteMarker.Bullet(0),
            null, NoteMarker.Number("1."), NoteMarker.Bullet(1), NoteMarker.Number("1."),
        )
        assertEquals(expected, NoteMarkers.of(blocks))
    }
}
