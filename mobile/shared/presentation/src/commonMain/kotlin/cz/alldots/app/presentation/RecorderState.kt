package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

/**
 * Where a recording is: [IDLE] nothing happens, [RECORDING] and [PAUSED] the microphone is open, [SAVING] the take is
 * being closed into a file, [UPLOADING] the file goes to the server, [FAILED] something did not work and [problem]
 * says what.
 */
enum class RecorderPhase { IDLE, RECORDING, PAUSED, SAVING, UPLOADING, FAILED }

/** What went wrong: the microphone is not allowed or did not start, no file was left, or the upload failed. */
enum class RecorderProblem { PERMISSION_DENIED, START_FAILED, CAPTURE_FAILED, IMPORT_FAILED, UPLOAD_FAILED }

/**
 * The recorder. [elapsedSeconds] counts the take without its pauses; [levels] are the last loudness readings, newest
 * last, from `0.0` to `1.0`; [failure] is why an upload failed, when [problem] is [RecorderProblem.UPLOAD_FAILED].
 */
data class RecorderState(
    val phase: RecorderPhase = RecorderPhase.IDLE,
    val elapsedSeconds: Int = 0,
    val levels: List<Float> = emptyList(),
    val problem: RecorderProblem? = null,
    val failure: FailureKind? = null,
) {
    /** True while the screen must not be left: the take is open or its file is still on its way. */
    val busy: Boolean
        get() = phase != RecorderPhase.IDLE && phase != RecorderPhase.FAILED
}

sealed interface RecorderAction {
    /** Asks for the microphone if needed and starts a take. Only when idle. */
    data object Start : RecorderAction

    data object Pause : RecorderAction

    data object Resume : RecorderAction

    /** Ends the take and sends it to the server. */
    data object Stop : RecorderAction

    /** Throws away the take, or the file that failed to upload. */
    data object Discard : RecorderAction

    /** After a failure: sends the kept file again, or starts a new take when there is no file. */
    data object Retry : RecorderAction

    /** Sends the audio or video file at [path] (outside the app) as a recording. Only when idle. */
    data class Import(val path: String) : RecorderAction
}

sealed interface RecorderEffect {
    /** The recording reached the server; the lists of recordings should read again. */
    data object Uploaded : RecorderEffect
}
