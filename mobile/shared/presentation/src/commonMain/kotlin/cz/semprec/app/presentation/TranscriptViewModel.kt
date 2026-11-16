package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.AudioPlayer
import cz.semprec.app.core.RecordingStatus
import cz.semprec.app.core.TranscriptActionState
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TranscriptDetail
import cz.semprec.app.domain.TranscriptRepository
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The transcript [transcriptId]: the notes Semp wrote (summary, decisions, action items), the words by speaker with a
 * search, the player that follows them, and the choice of who a voice is. Every change is a request and the transcript
 * is read again after it, so what is shown is what the server holds. A newer read supersedes the one before it.
 * Leaving the screen releases the player.
 */
class TranscriptViewModel internal constructor(
    private val transcriptId: String,
    private val transcripts: TranscriptRepository,
    player: AudioPlayer,
) : ScreenViewModel<TranscriptState, TranscriptAction, TranscriptEffect>(TranscriptState()) {
    private var loadJob: Job? = null
    private var detail: TranscriptDetail? = null
    private var audioRequested = false
    private val playback = TranscriptPlayback(player, { state.value.player }, ::changePlayer)

    init {
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                playback.release()
            }
        }
        read(showWait = true)
    }

    override fun onAction(action: TranscriptAction) {
        if (isClosed) return
        when (action) {
            TranscriptAction.Retry -> read(showWait = true)
            TranscriptAction.Refresh -> read(showWait = state.value.phase != TranscriptPhase.CONTENT)
            is TranscriptAction.SelectTab -> update { it.copy(tab = action.tab) }
            is TranscriptAction.Search -> search(action.query)
            is TranscriptAction.Player -> player(action)
            is TranscriptAction.Speaker -> speaker(action)
            is TranscriptAction.AddTask -> change(action.itemId) { transcripts.addTask(transcriptId, action.itemId) }
            is TranscriptAction.Follow -> change(action.itemId) { transcripts.note(transcriptId, action.itemId, true) }
            is TranscriptAction.Undo -> undo(action.itemId)
            TranscriptAction.OpenEvent -> state.value.eventId?.let { emit(TranscriptEffect.OpenEvent(it)) }
            TranscriptAction.DismissFailure -> update { it.copy(writeFailure = null) }
        }
    }

    private fun player(action: TranscriptAction.Player) {
        when (action) {
            is TranscriptAction.Player.Seek -> playback.seek(action.seconds)
            TranscriptAction.Player.TogglePlay -> playback.toggle()
            TranscriptAction.Player.CycleRate -> playback.cycleRate()
        }
    }

    private fun speaker(action: TranscriptAction.Speaker) {
        when (action) {
            is TranscriptAction.Speaker.OpenMenu -> openSpeakerMenu(action.speaker)
            TranscriptAction.Speaker.CloseMenu -> update { it.copy(speakerMenu = null, candidates = emptyList()) }
            is TranscriptAction.Speaker.Assign -> assign(action.personId)
        }
    }

    private fun search(query: String) {
        update { it.copy(query = query) }
        detail?.let { found -> update { it.withSegments(found) } }
    }

    private fun changePlayer(step: (TranscriptPlayer) -> TranscriptPlayer) {
        if (isClosed) return
        update { current ->
            val moved = current.copy(player = step(current.player))
            detail?.let { moved.withSegments(it) } ?: moved
        }
    }

    private fun read(showWait: Boolean) {
        loadJob?.cancel()
        update { if (showWait) TranscriptState(tab = it.tab, query = it.query) else it }
        loadJob = viewModelScope.launch {
            val result = answer { transcripts.detail(transcriptId) }
            ensureActive()
            when (result) {
                is Answer.Done -> show(result.value)
                is Answer.Rejected -> update {
                    if (it.phase == TranscriptPhase.CONTENT) it else TranscriptState(TranscriptPhase.ERROR, result.kind)
                }
            }
        }
    }

    private suspend fun show(found: TranscriptDetail) {
        detail = found
        update { found.toState(it) }
        val blob = found.blobId
        if (audioRequested || blob == null || found.status != RecordingStatus.DONE) return
        audioRequested = true
        when (val source = answer { transcripts.playback(blob) }) {
            is Answer.Done -> playback.load(source.value)
            is Answer.Rejected -> playback.unavailable()
        }
    }

    private fun openSpeakerMenu(speaker: String) {
        update { it.copy(speakerMenu = speaker, candidates = emptyList()) }
        viewModelScope.launch {
            val result = answer { transcripts.candidates(transcriptId) }
            ensureActive()
            update { current ->
                if (current.speakerMenu != speaker) {
                    current
                } else {
                    when (result) {
                        is Answer.Done -> current.copy(candidates = result.value.toRows(speaker))
                        is Answer.Rejected -> current.copy(speakerMenu = null, writeFailure = Failed(result.kind))
                    }
                }
            }
        }
    }

    private fun assign(personId: String?) {
        val speaker = state.value.speakerMenu ?: return
        update { it.copy(speakerMenu = null, candidates = emptyList()) }
        change(itemId = null) { transcripts.assignSpeaker(transcriptId, speaker, personId) }
    }

    /** Takes back what was done to an action item: the task of an added one, the following of a followed one. */
    private fun undo(itemId: Int) {
        val row = state.value.actionItems.firstOrNull { it.id == itemId } ?: return
        when (row.state) {
            TranscriptActionState.ADDED -> change(itemId) { transcripts.removeTask(transcriptId, itemId) }
            TranscriptActionState.NOTED -> change(itemId) { transcripts.note(transcriptId, itemId, false) }
            TranscriptActionState.OPEN, TranscriptActionState.DISMISSED -> Unit
        }
    }

    /** Runs a change, then reads the transcript again; one that fails leaves it as it was and says why. */
    private fun change(itemId: Int?, call: suspend () -> RepositoryResult<Unit>) {
        if (state.value.working || state.value.phase != TranscriptPhase.CONTENT) return
        update { current ->
            current.copy(
                working = true,
                writeFailure = null,
                actionItems = current.actionItems.map { if (it.id == itemId) it.copy(busy = true) else it },
            )
        }
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            val result = answer { call() }
            ensureActive()
            when (result) {
                is Answer.Rejected -> update { it.copy(working = false, writeFailure = Failed(result.kind)).idle() }
                is Answer.Done -> {
                    val fresh = answer { transcripts.detail(transcriptId) }
                    ensureActive()
                    when (fresh) {
                        is Answer.Done -> {
                            detail = fresh.value
                            update { fresh.value.toState(it.idle()).copy(working = false) }
                        }
                        is Answer.Rejected ->
                            update { it.copy(working = false, writeFailure = Failed(fresh.kind)).idle() }
                    }
                }
            }
        }
    }
}

private fun TranscriptState.idle(): TranscriptState = copy(actionItems = actionItems.map { it.copy(busy = false) })
