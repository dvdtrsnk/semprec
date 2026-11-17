package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MeetingTaskStatus

enum class MeetingPhase { LOADING, CONTENT, ERROR }

/** A task of the event; [detail] is the day it was finished on or the event it went to; [busy] while it is written. */
data class MeetingTaskRow(
    val id: String,
    val title: String,
    val status: MeetingTaskStatus,
    val detail: String?,
    val busy: Boolean,
)

/** An action item of the event's transcripts that can become a task. */
data class MeetingSuggestionRow(
    val transcriptId: String,
    val actionItemId: Int,
    val text: String,
    val ownerLabel: String?,
    val due: String?,
    val busy: Boolean,
)

data class MeetingPersonRow(val id: String, val name: String)

/**
 * The page of an event: when and where it is, the tasks it hosts, the tasks its transcripts suggest, its recordings,
 * who takes part, and its project and company (`#RRGGBB` [projectColor]). [date] and [endDate] are `YYYY-MM-DD`,
 * [timeFrom] and [timeTo] `HH:MM`; no [timeFrom] is an all-day event.
 */
data class MeetingState(
    val phase: MeetingPhase = MeetingPhase.LOADING,
    val failure: FailureKind? = null,
    val title: String = "",
    val place: String = "",
    val date: String? = null,
    val endDate: String? = null,
    val timeFrom: String? = null,
    val timeTo: String? = null,
    val projectName: String? = null,
    val projectColor: String? = null,
    val companyName: String? = null,
    val people: List<MeetingPersonRow> = emptyList(),
    val tasks: List<MeetingTaskRow> = emptyList(),
    val suggestions: List<MeetingSuggestionRow> = emptyList(),
    val recordings: List<RecordingRow> = emptyList(),
    val working: Boolean = false,
    val writeFailure: Failed? = null,
)

sealed interface MeetingAction {
    data object Retry : MeetingAction

    /** Reads again in place; the page stays on screen. */
    data object Refresh : MeetingAction

    /** Finishes the task, or opens it again when it is finished. */
    data class ToggleTask(val taskId: String) : MeetingAction

    /** Makes a task of [title] that the event hosts; a blank title makes nothing. */
    data class AddTask(val title: String) : MeetingAction

    /** Makes a task of an action item the transcripts suggest. */
    data class AddSuggestion(val transcriptId: String, val actionItemId: Int) : MeetingAction

    data class OpenTask(val taskId: String) : MeetingAction

    data class OpenRecording(val recordingId: String) : MeetingAction

    data object OpenNotes : MeetingAction

    data object OpenDetails : MeetingAction

    data object DismissFailure : MeetingAction
}

/** Where the page asks the app to go. */
sealed interface MeetingEffect {
    data class ShowTask(val taskId: String) : MeetingEffect

    data class ShowRecording(val recordingId: String) : MeetingEffect

    data class ShowNotes(val eventId: String) : MeetingEffect

    data class ShowDetails(val eventId: String) : MeetingEffect
}
