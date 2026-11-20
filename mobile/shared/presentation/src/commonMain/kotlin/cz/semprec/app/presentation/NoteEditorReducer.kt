package cz.semprec.app.presentation

import cz.semprec.app.domain.InlineRun
import cz.semprec.app.domain.note.NoteBlock
import cz.semprec.app.domain.note.NoteCaret
import cz.semprec.app.domain.note.NoteChange
import cz.semprec.app.domain.note.NoteLinks
import cz.semprec.app.domain.note.NotePaste
import cz.semprec.app.domain.note.NoteRunStyles
import cz.semprec.app.domain.note.NoteRuns
import cz.semprec.app.domain.note.NoteStructure
import cz.semprec.app.domain.note.NoteToggles
import cz.semprec.app.domain.note.NoteTyping
import cz.semprec.app.domain.note.NoteWords

/**
 * What an editing action does to the blocks: the blocks after it, whether the cursor moves (and where; `null` ends
 * editing) and a format waiting for the next typed text. The document rules are the domain's; this only routes.
 */
internal data class NoteReduction(
    val blocks: List<NoteBlock>,
    val movesCaret: Boolean = false,
    val caret: NoteCaret? = null,
    val pendingMark: NoteEditorMark? = null,
)

internal object NoteEditorReducer {

    fun typing(blocks: List<NoteBlock>, action: NoteEditorAction, newId: () -> String): NoteReduction? =
        when (action) {
            is NoteEditorAction.SetRuns -> setRuns(blocks, action)
            is NoteEditorAction.Enter ->
                NoteTyping.enter(blocks, NoteCaret(action.blockId, action.offset), newId, action.folded).moved()
            is NoteEditorAction.AddChild -> NoteToggles.addChild(blocks, action.blockId, newId).moved()
            is NoteEditorAction.BackspaceAtStart -> NoteTyping.backspaceAtStart(blocks, action.blockId, newId).moved()
            is NoteEditorAction.DeleteAtEnd -> NoteTyping.deleteAtEnd(blocks, action.blockId).moved()
            is NoteEditorAction.CommandEnter -> NoteReduction(NoteTyping.commandEnter(blocks, action.blockId))
            is NoteEditorAction.Paste ->
                NotePaste.paste(blocks, NoteCaret(action.blockId, action.offset), action.text, newId).moved()
            is NoteEditorAction.ToggleMark -> toggleMark(blocks, action)
            is NoteEditorAction.SetLink -> setLink(blocks, action)
            is NoteEditorAction.ClearFormat -> restyle(blocks, action.blockId) {
                NoteRunStyles.clear(it, action.start, action.end)
            }
            is NoteEditorAction.SetColor -> restyle(blocks, action.blockId) {
                NoteRunStyles.color(it, action.start, action.end, action.color?.toDomain())
            }
            is NoteEditorAction.SetHighlight -> restyle(blocks, action.blockId) {
                NoteRunStyles.highlight(it, action.start, action.end, action.color?.toDomain())
            }
            else -> null
        }

    fun structure(blocks: List<NoteBlock>, action: NoteEditorAction, newId: () -> String): NoteReduction? =
        when (action) {
            // A block becomes a page only through the subpage operation.
            is NoteEditorAction.SetType if action.type == NoteEditorBlockType.PAGE -> NoteReduction(blocks)
            is NoteEditorAction.ToggleType if action.type == NoteEditorBlockType.PAGE -> NoteReduction(blocks)
            is NoteEditorAction.SetType -> NoteReduction(
                NoteStructure.setType(blocks, action.blockIds.toSet(), action.type.toDomain(), action.toggle),
            )
            is NoteEditorAction.ToggleType ->
                NoteReduction(NoteStructure.toggleType(blocks, action.blockIds.toSet(), action.type.toDomain()))
            is NoteEditorAction.ShiftIndent ->
                NoteReduction(NoteStructure.shiftIndent(blocks, action.blockIds.toSet(), action.delta))
            is NoteEditorAction.ToggleDone -> NoteReduction(NoteStructure.toggleDone(blocks, action.blockId))
            is NoteEditorAction.Move ->
                NoteReduction(NoteStructure.move(blocks, action.blockIds.toSet(), action.targetIndex))
            is NoteEditorAction.Duplicate ->
                NoteReduction(NoteStructure.duplicate(blocks, action.blockIds.toSet(), newId))
            is NoteEditorAction.Delete ->
                NoteReduction(NoteStructure.delete(blocks, action.blockIds.toSet(), newId), movesCaret = true)
            NoteEditorAction.TapBelow -> NoteStructure.tapBelow(blocks, newId).moved()
            else -> null
        }

    private fun NoteChange.moved() = NoteReduction(blocks, movesCaret = true, caret = caret)

    /** The typed text; a Markdown prefix at the start of a text block then turns it into its type. */
    private fun setRuns(blocks: List<NoteBlock>, action: NoteEditorAction.SetRuns): NoteReduction {
        val typed = NoteStructure.setRuns(blocks, action.blockId, action.runs.map { it.toDomain() })
        return NoteTyping.applyPrefix(typed, action.blockId)?.moved() ?: NoteReduction(typed)
    }

    /** The runs of [blockId] changed by [change]. */
    private fun restyle(
        blocks: List<NoteBlock>,
        blockId: String,
        change: (List<InlineRun>) -> List<InlineRun>,
    ) = NoteReduction(blocks.map { if (it.id == blockId) it.copy(runs = change(it.runs)) else it })

    private fun toggleMark(blocks: List<NoteBlock>, action: NoteEditorAction.ToggleMark): NoteReduction {
        val block = blocks.firstOrNull { it.id == action.blockId } ?: return NoteReduction(blocks)
        val range = if (action.end > action.start) action.start until action.end else
            NoteWords.wordAround(block.plainText, action.start)
        return if (range == null) {
            NoteReduction(blocks, pendingMark = action.mark)
        } else {
            val runs = NoteRuns.toggle(block.runs, range.first, range.last + 1, action.mark.toDomain())
            NoteReduction(blocks.map { if (it.id == block.id) it.copy(runs = runs) else it })
        }
    }

    /**
     * A selection gets the link; without one the address is inserted at the cursor as linked text; at an existing
     * link only its address changes, and `null` takes the link away.
     */
    private fun setLink(blocks: List<NoteBlock>, action: NoteEditorAction.SetLink): NoteReduction {
        val block = blocks.firstOrNull { it.id == action.blockId } ?: return NoteReduction(blocks)
        val address = action.address?.let(NoteWords::linkAddress)
        val existing = NoteLinks.range(block.runs, action.start)
        val runs = when {
            action.end > action.start -> NoteRuns.link(block.runs, action.start, action.end, address)
            existing != null -> NoteRuns.link(block.runs, existing.first, existing.last + 1, address)
            address == null -> block.runs
            else -> {
                val inserted = NoteRuns.insert(block.runs, action.start, address)
                NoteRuns.link(inserted, action.start, action.start + address.length, address)
            }
        }
        return NoteReduction(blocks.map { if (it.id == block.id) it.copy(runs = runs) else it })
    }
}
