package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.RecordingsRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/** How long a list with a recording in process waits before it asks the server again. */
internal const val RECORDINGS_POLL_MILLIS = 5_000L

/**
 * The recordings that belong to no event or to any, newest first. A recording the server is still processing makes the
 * list read again on its own, until none is. A newer read supersedes the one before it.
 */
class RecordingsViewModel internal constructor(
    private val recordings: RecordingsRepository,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<RecordingsState, RecordingsAction, RecordingsEffect>(RecordingsState()) {
    private var loadJob: Job? = null
    private var pollJob: Job? = null

    init {
        reloadOnChanges(changes) { onAction(RecordingsAction.Refresh) }
        read(showWait = true)
    }

    override fun onAction(action: RecordingsAction) {
        if (isClosed) return
        when (action) {
            RecordingsAction.Retry -> read(showWait = true)
            RecordingsAction.Refresh -> read(showWait = state.value.phase != RecordingsPhase.CONTENT)
            is RecordingsAction.Open -> emit(RecordingsEffect.OpenTranscript(action.recordingId))
        }
    }

    private fun read(showWait: Boolean) {
        loadJob?.cancel()
        pollJob?.cancel()
        update { if (showWait) RecordingsState() else it }
        loadJob = viewModelScope.launch {
            val result = answer { recordings.list(eventId = null) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> RecordingsState(RecordingsPhase.CONTENT, null, result.value.map { it.toRow() })
                    is Answer.Rejected -> if (it.phase == RecordingsPhase.CONTENT) {
                        it
                    } else {
                        RecordingsState(RecordingsPhase.ERROR, result.kind)
                    }
                }
            }
            if (state.value.recordings.any { it.processing }) schedulePoll()
        }
    }

    private fun schedulePoll() {
        pollJob = viewModelScope.launch {
            delay(RECORDINGS_POLL_MILLIS)
            read(showWait = false)
        }
    }
}
