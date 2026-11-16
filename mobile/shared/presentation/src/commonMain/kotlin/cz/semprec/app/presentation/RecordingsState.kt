package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.RecordingPairing
import cz.semprec.app.core.RecordingStatus

enum class RecordingsPhase { LOADING, CONTENT, ERROR }

/** One recording of a list; [date] is an ISO date-time and [eventName] is set while it belongs to an event. */
data class RecordingRow(
    val id: String,
    val name: String,
    val date: String?,
    val durationSeconds: Int?,
    val status: RecordingStatus?,
    val pairing: RecordingPairing,
    val eventName: String?,
    val shortSummary: String?,
) {
    /** True while the server is still turning the audio into a transcript. */
    val processing: Boolean
        get() = status == RecordingStatus.RECORDING || status == RecordingStatus.PROCESSING ||
            pairing == RecordingPairing.PROCESSING
}

data class RecordingsState(
    val phase: RecordingsPhase = RecordingsPhase.LOADING,
    val failure: FailureKind? = null,
    val recordings: List<RecordingRow> = emptyList(),
)

sealed interface RecordingsAction {
    data object Retry : RecordingsAction

    /** Reads again in place; the list stays on screen. */
    data object Refresh : RecordingsAction

    data class Open(val recordingId: String) : RecordingsAction
}

sealed interface RecordingsEffect {
    data class OpenTranscript(val recordingId: String) : RecordingsEffect
}
