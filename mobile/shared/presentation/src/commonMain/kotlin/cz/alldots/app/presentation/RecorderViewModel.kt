package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.AudioRecorder
import cz.alldots.app.core.CapturedAudio
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RecordingsRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** How often the clock and the level of a take are read. */
internal const val RECORDER_TICK_MILLIS = 100L

/** How many level readings the waveform keeps. */
internal const val RECORDER_LEVEL_COUNT = 40

/**
 * Makes a recording: asks for the microphone, runs the take (start, pause, resume, stop), and sends the file to the
 * server, to [eventId] when one is named. A file that failed to upload stays on the device until it is retried or
 * thrown away. Leaving the screen with the microphone open ends the take and drops it; the screen keeps people from
 * leaving while [RecorderState.busy].
 */
class RecorderViewModel internal constructor(
    private val eventId: String?,
    private val recorder: AudioRecorder,
    private val recordings: RecordingsRepository,
) : ScreenViewModel<RecorderState, RecorderAction, RecorderEffect>(RecorderState()) {
    private val take = RecorderTake(recorder, viewModelScope, { isClosed }) { seconds, level ->
        update { it.copy(elapsedSeconds = seconds, levels = (it.levels + level).takeLast(RECORDER_LEVEL_COUNT)) }
    }
    private var uploadJob: Job? = null
    private var kept: CapturedAudio? = null
    private var asking = false

    override fun onAction(action: RecorderAction) {
        if (isClosed) return
        when (action) {
            RecorderAction.Start -> start()
            RecorderAction.Pause -> setPaused(true)
            RecorderAction.Resume -> setPaused(false)
            RecorderAction.Stop -> stop()
            RecorderAction.Discard -> discard()
            RecorderAction.Retry -> retry()
            is RecorderAction.Import -> import(action.path)
        }
    }

    private fun start() {
        val phase = state.value.phase
        val free = phase == RecorderPhase.IDLE || (phase == RecorderPhase.FAILED && kept == null)
        if (asking || !free) return
        asking = true
        recorder.requestPermission { allowed -> began(allowed) }
    }

    private fun began(allowed: Boolean) {
        asking = false
        if (isClosed) return
        when {
            !allowed -> fail(RecorderProblem.PERMISSION_DENIED)
            !recorder.start() -> fail(RecorderProblem.START_FAILED)
            else -> {
                kept = null
                update { RecorderState(RecorderPhase.RECORDING) }
                take.begin()
            }
        }
    }

    private fun setPaused(paused: Boolean) {
        val from = if (paused) RecorderPhase.RECORDING else RecorderPhase.PAUSED
        if (state.value.phase != from) return
        if (paused) take.pause() else take.resume()
        update { it.copy(phase = if (paused) RecorderPhase.PAUSED else RecorderPhase.RECORDING) }
    }

    private fun stop() {
        val phase = state.value.phase
        if (phase != RecorderPhase.RECORDING && phase != RecorderPhase.PAUSED) return
        update { it.copy(phase = RecorderPhase.SAVING) }
        val audio = take.end()
        if (audio == null) fail(RecorderProblem.CAPTURE_FAILED) else upload(audio)
    }

    private fun discard() {
        when (state.value.phase) {
            RecorderPhase.RECORDING, RecorderPhase.PAUSED -> take.drop()
            RecorderPhase.FAILED -> kept?.let(recorder::delete)
            RecorderPhase.IDLE, RecorderPhase.SAVING, RecorderPhase.UPLOADING -> return
        }
        kept = null
        update { RecorderState() }
    }

    private fun retry() {
        if (state.value.phase != RecorderPhase.FAILED) return
        val audio = kept
        if (audio == null) start() else upload(audio)
    }

    private fun import(path: String) {
        if (state.value.phase != RecorderPhase.IDLE) return
        val audio = recorder.importFile(path)
        if (audio == null) fail(RecorderProblem.IMPORT_FAILED) else upload(audio)
    }

    private fun upload(audio: CapturedAudio) {
        kept = audio
        update { RecorderState(RecorderPhase.UPLOADING, audio.durationSeconds) }
        uploadJob?.cancel()
        uploadJob = viewModelScope.launch {
            val result = answer { recordings.upload(audio, eventId) }
            ensureActive()
            when (result) {
                is Answer.Done -> {
                    recorder.delete(audio)
                    kept = null
                    update { RecorderState() }
                    emit(RecorderEffect.Uploaded)
                }
                is Answer.Rejected -> fail(RecorderProblem.UPLOAD_FAILED, result.kind)
            }
        }
    }

    private fun fail(problem: RecorderProblem, failure: FailureKind? = null) {
        update { RecorderState(RecorderPhase.FAILED, it.elapsedSeconds, emptyList(), problem, failure) }
    }
}
