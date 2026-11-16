package cz.semprec.app.presentation

import cz.semprec.app.core.AudioRecorder
import cz.semprec.app.core.CapturedAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * One take on the device [recorder]: it reads the clock and the loudness while the take runs ([onTick]) and, when
 * [scopeClosed] says the screen is gone with the take still open, ends the take and drops it so that the microphone
 * is never left open.
 */
internal class RecorderTake(
    private val recorder: AudioRecorder,
    private val scope: CoroutineScope,
    private val scopeClosed: () -> Boolean,
    private val onTick: (seconds: Int, level: Float) -> Unit,
) {
    private var ticker: Job? = null
    private var guard: Job? = null
    private var open = false

    /** The microphone is open and a new take runs. */
    fun begin() {
        open = true
        guard?.cancel()
        guard = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                if (open && scopeClosed()) recorder.cancel()
            }
        }
        startTicker()
    }

    fun pause() {
        ticker?.cancel()
        recorder.pause()
    }

    fun resume() {
        recorder.resume()
        startTicker()
    }

    private fun startTicker() {
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive) {
                delay(RECORDER_TICK_MILLIS)
                onTick(recorder.elapsedSeconds().toInt(), recorder.level())
            }
        }
    }

    /** Ends the take and answers its file, or `null` when the device left none. */
    fun end(): CapturedAudio? {
        stopWatching()
        return recorder.stop()
    }

    /** Ends the take and deletes what it wrote. */
    fun drop() {
        stopWatching()
        recorder.cancel()
    }

    private fun stopWatching() {
        open = false
        ticker?.cancel()
        guard?.cancel()
    }
}
