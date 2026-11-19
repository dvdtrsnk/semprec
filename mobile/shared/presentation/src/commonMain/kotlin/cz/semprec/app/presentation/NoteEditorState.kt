package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class NoteEditorBlockType { TEXT, H1, H2, H3, BULLET, NUMBER, TODO, QUOTE, PAGE }

enum class NoteEditorMark { BOLD, ITALIC, CODE }

enum class NoteEditorPhase { LOADING, CONTENT, ERROR }

/** A stretch of text with one formatting; `\n` in [text] is a soft line break inside the block. */
data class NoteEditorRun(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val link: String? = null,
)

/** What a block shows in front of its text: a bullet whose glyph follows [level], or a number's [label]. */
sealed interface NoteEditorMarker {
    data class Bullet(val level: Int) : NoteEditorMarker
    data class Number(val label: String) : NoteEditorMarker
}

/** One block of the note. A [NoteEditorBlockType.PAGE] block has its subpage's title in [runs] and its [pageId]. */
data class NoteEditorBlock(
    val id: String,
    val type: NoteEditorBlockType,
    val indent: Int,
    val done: Boolean,
    val runs: List<NoteEditorRun>,
    val pageId: String?,
    val marker: NoteEditorMarker?,
)

/** Where the cursor goes after an edit: [offset] UTF-16 units into the text of [blockId]. */
data class NoteEditorCaret(val blockId: String, val offset: Int)

/** Why the note shows a notice: the page changed elsewhere and was read again, or a write failed. */
enum class NoteEditorProblem { RELOADED, FAILED }

/**
 * The note editor. [title] is the page's own title (a subpage's is the text of its block in the parent).
 * [lastEditedAt] is an ISO instant, `null` for a page never written. [caret] with its [caretRequest] (counted up
 * on every move) tells the screen where to put the cursor after an edit; `null` ends editing. [working] is set
 * while a subpage operation runs. [saving] is set while a change waits to be written.
 */
data class NoteEditorState(
    val phase: NoteEditorPhase = NoteEditorPhase.LOADING,
    val failure: FailureKind? = null,
    val title: String = "",
    val titleEditable: Boolean = false,
    val blocks: List<NoteEditorBlock> = emptyList(),
    val wordCount: Int = 0,
    val lastEditedAt: String? = null,
    val saving: Boolean = false,
    val working: Boolean = false,
    val problem: NoteEditorProblem? = null,
    val problemFailure: FailureKind? = null,
    val caret: NoteEditorCaret? = null,
    val caretRequest: Int = 0,
)

sealed interface NoteEditorAction {
    data object Retry : NoteEditorAction

    /** Reads the page again in place, as it is shown again, unless a change of its own waits to be written. */
    data object Refresh : NoteEditorAction
    data object DismissProblem : NoteEditorAction

    /** Typing: the block's text as the person left it; a Markdown prefix at the start of a text block applies. */
    data class SetRuns(val blockId: String, val runs: List<NoteEditorRun>) : NoteEditorAction
    data class Enter(val blockId: String, val offset: Int) : NoteEditorAction
    data class BackspaceAtStart(val blockId: String) : NoteEditorAction
    data class DeleteAtEnd(val blockId: String) : NoteEditorAction
    data class CommandEnter(val blockId: String) : NoteEditorAction
    data class Paste(val blockId: String, val offset: Int, val text: String) : NoteEditorAction

    /** Formats [start]..[end] of a block; an empty range inside a word formats the word. */
    data class ToggleMark(val blockId: String, val start: Int, val end: Int, val mark: NoteEditorMark) :
        NoteEditorAction

    /** Links [start]..[end] to [address] (a scheme is added when missing), or unlinks with `null`. */
    data class SetLink(val blockId: String, val start: Int, val end: Int, val address: String?) : NoteEditorAction

    data class SetType(val blockIds: List<String>, val type: NoteEditorBlockType) : NoteEditorAction
    data class ToggleType(val blockIds: List<String>, val type: NoteEditorBlockType) : NoteEditorAction
    data class ShiftIndent(val blockIds: List<String>, val delta: Int) : NoteEditorAction
    data class ToggleDone(val blockId: String) : NoteEditorAction
    data class Move(val blockIds: List<String>, val targetIndex: Int) : NoteEditorAction
    data class Duplicate(val blockIds: List<String>) : NoteEditorAction
    data class Delete(val blockIds: List<String>) : NoteEditorAction
    data object TapBelow : NoteEditorAction

    /** Turns a block into a subpage titled with its text; an empty block's new subpage opens at once. */
    data class MakeSubpage(val blockId: String) : NoteEditorAction
    data class OpenPage(val blockId: String) : NoteEditorAction
    data class SetTitle(val title: String) : NoteEditorAction

    /** Writes a waiting change now, as the screen goes away. */
    data object Flush : NoteEditorAction
}

sealed interface NoteEditorEffect {
    /** Opens the subpage [pageId]; [focusTitle] when it was just made from an empty block. */
    data class OpenPage(val pageId: String, val title: String, val focusTitle: Boolean) : NoteEditorEffect

    /** No word around the cursor: [mark] applies to the text typed next at this place. */
    data class PendingMark(val mark: NoteEditorMark) : NoteEditorEffect

    /** A note kept as text by its owner (not a page) changed; the owner saves [markdown]. */
    data class TextChanged(val markdown: String) : NoteEditorEffect
}

/** Where a note lives: a page of an item, the page of a Journal period, or text its owner keeps and saves. */
sealed interface NoteEditorSource {
    data class Page(val itemId: String, val titleEditable: Boolean) : NoteEditorSource
    data class Journal(val kind: JournalPeriodKind, val period: String) : NoteEditorSource
    data class Text(val markdown: String) : NoteEditorSource
}
