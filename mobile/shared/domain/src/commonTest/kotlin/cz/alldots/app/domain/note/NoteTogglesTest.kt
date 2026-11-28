package cz.alldots.app.domain.note

import cz.alldots.app.domain.PageBlockType
import kotlin.test.Test
import kotlin.test.assertEquals

class NoteTogglesTest {

    private val blocks = listOf(
        block("t", "Plan", PageBlockType.TOGGLE),
        block("c", "child", indent = 1),
        block("after", "after"),
    )

    @Test fun `enter in an open toggle makes the rest of its text its first child`() {
        val change = NoteTyping.enter(blocks, NoteCaret("t", 2), TestIds().newId)
        assertEquals(
            listOf("t:toggle:0:Pl", "n1:text:1:an", "c:text:1:child", "after:text:0:after"),
            change.blocks.shape(),
        )
        assertEquals(NoteCaret("n1", 0), change.caret)
    }

    @Test fun `enter in a closed toggle adds the next toggle after its children`() {
        val change = NoteTyping.enter(blocks, NoteCaret("t", 4), TestIds().newId, folded = true)
        assertEquals(
            listOf("t:toggle:0:Plan", "c:text:1:child", "n1:toggle:0:", "after:text:0:after"),
            change.blocks.shape(),
        )
        assertEquals(NoteCaret("n1", 0), change.caret)
    }

    @Test fun `enter in a toggle heading adds a text child when open and text after its children when closed`() {
        val heading = listOf(block("h", "Plan", PageBlockType.H2).copy(toggle = true), block("c", "child", indent = 1))
        val open = NoteTyping.enter(heading, NoteCaret("h", 4), TestIds().newId)
        assertEquals(listOf("h:h2:0:Plan", "n1:text:1:", "c:text:1:child"), open.blocks.shape())
        val closed = NoteTyping.enter(heading, NoteCaret("h", 4), TestIds().newId, folded = true)
        assertEquals(listOf("h:h2:0:Plan", "c:text:1:child", "n1:text:0:"), closed.blocks.shape())
    }

    @Test fun `adding a child puts an empty text block indented under the toggle`() {
        val toggle = block("t", "Plan", PageBlockType.TOGGLE, indent = 1)
        val change = NoteToggles.addChild(listOf(toggle), "t", TestIds().newId)
        assertEquals(listOf("t:toggle:1:Plan", "n1:text:2:"), change.blocks.shape())
        assertEquals(NoteCaret("n1", 0), change.caret)
    }

    @Test fun `a toggle at the deepest indent holds no children and its new blocks go after it`() {
        val deepest = listOf(
            block("t", "Plan", PageBlockType.TOGGLE, indent = NOTE_MAX_INDENT),
            block("h", "Head", PageBlockType.H3, indent = NOTE_MAX_INDENT).copy(toggle = true),
        )
        val opened = NoteTyping.enter(deepest, NoteCaret("t", 2), TestIds().newId)
        assertEquals(listOf("t:toggle:5:Pl", "n1:toggle:5:an", "h:h3:5:Head"), opened.blocks.shape())
        val heading = NoteTyping.enter(deepest, NoteCaret("h", 4), TestIds().newId)
        assertEquals(listOf("t:toggle:5:Plan", "h:h3:5:Head", "n1:text:5:"), heading.blocks.shape())
        val child = NoteToggles.addChild(deepest, "t", TestIds().newId)
        assertEquals(listOf("t:toggle:5:Plan", "n1:text:5:", "h:h3:5:Head"), child.blocks.shape())
        assertEquals(NoteCaret("n1", 0), child.caret)
    }
}
