package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.NoteBlockType

enum class NotesPhase { LOADING, CONTENT, ERROR }

/**
 * One block of a page. [marker] is what the renderer draws before a numbered block (`1.`, `2.1.`), `null` for any
 * other type; [pageId] is the item of a subpage block.
 */
data class NoteBlockItem(
    val id: String,
    val type: NoteBlockType,
    val indent: Int,
    val done: Boolean,
    val text: String,
    val pageId: String?,
    val marker: String?,
)

/**
 * A page of notes. While [selecting], [selected] holds the ids of the blocks to move into a subpage; [working] is true
 * while a change runs; [writeFailure] is the last one that failed.
 */
data class NotesState(
    val phase: NotesPhase = NotesPhase.LOADING,
    val failure: FailureKind? = null,
    val title: String = "",
    val blocks: List<NoteBlockItem> = emptyList(),
    val selecting: Boolean = false,
    val selected: List<String> = emptyList(),
    val working: Boolean = false,
    val writeFailure: Failed? = null,
)

sealed interface NotesAction {
    data object Retry : NotesAction

    /** Reloads in place; the page stays on screen. */
    data object Refresh : NotesAction

    /**
     * Adds a block of [type] with [text] (Markdown) after [afterBlockId], or at the end without one. A subpage is made
     * with [CreateSubpage], and a blank text adds nothing.
     */
    data class Add(val type: NoteBlockType, val text: String, val afterBlockId: String?) : NotesAction

    /** Adds an empty subpage after [afterBlockId], or at the end without one. */
    data class CreateSubpage(val title: String, val afterBlockId: String?) : NotesAction

    /** Starts or ends choosing blocks to move into a subpage; ending it forgets the choice. */
    data object ToggleSelecting : NotesAction

    data class Toggle(val blockId: String) : NotesAction

    /** Moves the chosen blocks into subpages, one for each. */
    data object MoveSelectedToSubpages : NotesAction

    /** Opens the subpage of a subpage block; any other block does nothing. */
    data class Open(val blockId: String) : NotesAction

    /** Turns the subpage block into a block of [type]; its subpage goes to the trash. */
    data class ConvertToBlock(val blockId: String, val type: NoteBlockType) : NotesAction

    data class RenameSubpage(val blockId: String, val title: String) : NotesAction

    /** Asks the app for the page as one Markdown text. */
    data object OpenAsText : NotesAction

    data object DismissFailure : NotesAction
}

/** Where the notes ask the app to go. */
sealed interface NotesEffect {
    data class OpenPage(val itemId: String) : NotesEffect

    data object OpenAsText : NotesEffect
}
