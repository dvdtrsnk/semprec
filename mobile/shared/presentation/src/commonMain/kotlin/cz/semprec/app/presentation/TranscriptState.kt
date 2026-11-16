package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.RecordingStatus
import cz.semprec.app.core.TranscriptActionState

enum class TranscriptPhase { LOADING, CONTENT, ERROR }

enum class TranscriptTab { SUMMARY, TRANSCRIPT }

/** A project, company or person of the transcript; [inherited] is true while it follows the event. */
data class TranscriptContextItem(val id: String, val name: String, val inherited: Boolean)

/** One action item of the notes; [busy] while a request about it runs. */
data class TranscriptActionRow(
    val id: Int,
    val text: String,
    val ownerLabel: String?,
    val due: String?,
    val state: TranscriptActionState,
    val isMine: Boolean,
    val busy: Boolean,
)

/** What one voice said at [startsAt] seconds; [mapped] is false while the voice is nobody yet. */
data class TranscriptSegmentRow(
    val index: Int,
    val speaker: String,
    val label: String,
    val text: String,
    val startsAt: Double,
    val mapped: Boolean,
    val active: Boolean,
)

/** A person the open voice can be given to. */
data class TranscriptCandidateRow(val personId: String, val name: String, val current: Boolean)

/** The player: [available] once the audio is loaded, [failed] when it cannot play; times are seconds. */
data class TranscriptPlayer(
    val available: Boolean = false,
    val failed: Boolean = false,
    val playing: Boolean = false,
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val rate: Float = 1f,
)

/**
 * A transcript. [segments] are the ones that match [query] (all without one) and [matchCount] is how many. While
 * [speakerMenu] names a voice, [candidates] are the people it can be given to. [working] is true while a change runs
 * and [writeFailure] is the last one that failed.
 */
data class TranscriptState(
    val phase: TranscriptPhase = TranscriptPhase.LOADING,
    val failure: FailureKind? = null,
    val title: String = "",
    val date: String? = null,
    val durationSeconds: Int? = null,
    val language: String? = null,
    val status: RecordingStatus? = null,
    val eventId: String? = null,
    val eventName: String? = null,
    val project: TranscriptContextItem? = null,
    val company: TranscriptContextItem? = null,
    val people: List<TranscriptContextItem> = emptyList(),
    val summary: String? = null,
    val decisions: List<String> = emptyList(),
    val actionItems: List<TranscriptActionRow> = emptyList(),
    val tab: TranscriptTab = TranscriptTab.SUMMARY,
    val query: String = "",
    val segments: List<TranscriptSegmentRow> = emptyList(),
    val matchCount: Int = 0,
    val speakerMenu: String? = null,
    val candidates: List<TranscriptCandidateRow> = emptyList(),
    val player: TranscriptPlayer = TranscriptPlayer(),
    val working: Boolean = false,
    val writeFailure: Failed? = null,
)

sealed interface TranscriptAction {
    data object Retry : TranscriptAction

    /** Reads again in place; the transcript stays on screen. */
    data object Refresh : TranscriptAction

    data class SelectTab(val tab: TranscriptTab) : TranscriptAction

    /** Narrows the transcript to the segments that contain [query]. */
    data class Search(val query: String) : TranscriptAction

    /** What the person does with the player. */
    sealed interface Player : TranscriptAction {
        /** Moves the player to [seconds]. */
        data class Seek(val seconds: Double) : Player

        data object TogglePlay : Player

        /** Goes to the next playback speed. */
        data object CycleRate : Player
    }

    /** What the person does with the menu that says who a voice is. */
    sealed interface Speaker : TranscriptAction {
        /** Opens the menu that says who the voice [speaker] is. */
        data class OpenMenu(val speaker: String) : Speaker

        data object CloseMenu : Speaker

        /** Gives the open voice to [personId], or takes the assignment back with `null`. */
        data class Assign(val personId: String?) : Speaker
    }

    /** Makes a task of the action item [itemId]. */
    data class AddTask(val itemId: Int) : TranscriptAction

    /** Follows the action item [itemId] without making a task. */
    data class Follow(val itemId: Int) : TranscriptAction

    /** Takes back the task or the following of the action item [itemId]. */
    data class Undo(val itemId: Int) : TranscriptAction

    data object OpenEvent : TranscriptAction

    data object DismissFailure : TranscriptAction
}

sealed interface TranscriptEffect {
    data class OpenEvent(val eventId: String) : TranscriptEffect
}
