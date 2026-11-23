package cz.semprec.app.domain.note

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

private const val TEAL = "Mind the <span data-color=\"teal\">teal</span> note"

private fun note(vararg blocks: String) = blocks.joinToString("\n\n")

class NoteMergeTest {
    @Test fun `blocks only one side changed take that side`() {
        val base = note("A", "B", "C")
        val changed = note("A", "B changed", "C")
        assertEquals(changed, NoteMerge.merge(base, changed, base))
        assertEquals(changed, NoteMerge.merge(base, base, changed))
    }

    @Test fun `different blocks changed on each side both stay`() {
        assertEquals(
            note("A changed", "B", "C changed"),
            NoteMerge.merge(note("A", "B", "C"), note("A changed", "B", "C"), note("A", "B", "C changed")),
        )
    }

    @Test fun `a block both sides changed the same way is taken once`() {
        val changed = note("A", "B changed")
        assertEquals(changed, NoteMerge.merge(note("A", "B"), changed, changed))
    }

    @Test fun `different words of one block both stay`() {
        assertEquals(
            "The quick brown fox jumps high",
            NoteMerge.merge("The quick fox jumps", "The quick brown fox jumps", "The quick fox jumps high"),
        )
    }

    @Test fun `both sides rewriting the same words keep the local words and then the remote ones`() {
        assertEquals("Call JimKay", NoteMerge.merge("Call Bob", "Call Jim", "Call Kay"))
    }

    @Test fun `characters keep their inline style`() {
        assertEquals("Hi **world**", NoteMerge.merge("Hello world", "Hello **world**", "Hi world"))
    }

    @Test fun `a character outside the basic plane stays whole`() {
        assertEquals("😁😀!", NoteMerge.merge("😀", "😁", "😀!"))
    }

    @Test fun `a block deleted on one side and changed on the other keeps the change`() {
        val base = note("A", "B", "C")
        val changed = note("A", "B changed", "C")
        assertEquals(changed, NoteMerge.merge(base, note("A", "C"), changed))
        assertEquals(changed, NoteMerge.merge(base, changed, note("A", "C")))
    }

    @Test fun `a block deleted on one side and kept on the other is deleted`() {
        assertEquals(note("A", "C"), NoteMerge.merge(note("A", "B", "C"), note("A", "C"), note("A", "B", "C")))
    }

    @Test fun `blocks both sides added are kept with the local ones first`() {
        assertEquals(note("A", "Mine", "Theirs"), NoteMerge.merge("A", note("A", "Mine"), note("A", "Theirs")))
        assertEquals(note("A", "Same"), NoteMerge.merge("A", note("A", "Same"), note("A", "Same")))
    }

    @Test fun `a block both sides added beside a block both changed is kept once`() {
        assertEquals(
            note("A", "B12", "X"),
            NoteMerge.merge(note("A", "B"), note("A", "B1", "X"), note("A", "B2", "X")),
        )
    }

    @Test fun `a block both sides changed takes each field from the side that changed it`() {
        assertEquals("# Idea two", NoteMerge.merge("Idea", "# Idea", "Idea two"))
        assertEquals("- [x] Task list", NoteMerge.merge("- [ ] Task", "- [ ] Task list", "- [x] Task"))
    }

    @Test fun `a field both sides changed takes the local value`() {
        assertEquals("# Idea!?", NoteMerge.merge("Idea", "# Idea!", "## Idea?"))
    }

    @Test fun `blank notes hold no block`() {
        assertEquals("", NoteMerge.merge("", "", ""))
        assertEquals("Mine", NoteMerge.merge("", "Mine", ""))
        assertEquals(note("Mine", "Theirs"), NoteMerge.merge("", "Mine", "Theirs"))
        assertEquals("", NoteMerge.merge("Base", "", "Base"))
        assertEquals("Base changed", NoteMerge.merge("Base", "", "Base changed"))
    }

    @Test fun `a block taken unchanged keeps the lines its side had`() {
        val base = note(TEAL, "Second")
        assertEquals(note(TEAL, "Second edited"), NoteMerge.merge(base, note(TEAL, "Second edited"), base))
        assertEquals(note(TEAL, "Second edited"), NoteMerge.merge(base, base, note(TEAL, "Second edited")))
    }

    @Test fun `blocks too many to compare take the local side`() {
        val count = 2001
        val local = note(*Array(count) { "local $it" })
        val merged = NoteMerge.merge(note(*Array(count) { "base $it" }), local, note(*Array(count) { "remote $it" }))
        assertEquals(local, merged)
    }

    @Test fun `a text too long to compare takes the local side`() {
        val local = "b".repeat(2001)
        assertEquals(local, NoteMerge.merge("a".repeat(2001), local, "c".repeat(2001)))
    }

    @Test fun `a text just short enough to compare is merged`() {
        val (base, local, remote) = listOf("a", "b", "c").map { it.repeat(1999) }
        assertEquals(local + remote, NoteMerge.merge(base, local, remote))
    }

    @Test fun `adopting keeps the ids of the blocks held unchanged and the lines they are written with`() {
        val previous = NoteDocument.parse(note(TEAL, "B", "C"), TestIds().newId).blocks
        var next = 0
        val read = NoteDocument.parse(note(TEAL, "B changed", "C", "D")) { "m${++next}" }
        val adopted = NoteMerge.adopt(previous, read)
        assertEquals(listOf("n1", "m2", "n3", "m4"), adopted.blocks.map { it.id })
        assertEquals(note(TEAL, "B changed", "C", "D"), NoteDocument.markdown(adopted.blocks, adopted.source))
    }

    @Test fun `a note too long to compare is adopted with its own ids`() {
        val previous = NoteDocument.parse(note("X", *Array(2001) { "a$it" }), TestIds().newId).blocks
        var next = 0
        val read = NoteDocument.parse(note(*Array(2001) { "b$it" }, "X")) { "m${++next}" }
        val adopted = NoteMerge.adopt(previous, read)
        assertEquals(read, adopted)
        assertNotEquals(previous.first().id, adopted.blocks.last().id)
    }
}
