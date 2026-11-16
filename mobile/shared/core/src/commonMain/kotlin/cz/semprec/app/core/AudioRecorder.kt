package cz.semprec.app.core

/**
 * A finished recording the device holds as a file: [path] for the adapter, [fileName] and [mimeType] for the upload,
 * [recordedAt] (an ISO date-time with its offset) for the moment it began and [durationSeconds] for the length.
 */
class CapturedAudio(
    val path: String,
    val fileName: String,
    val mimeType: String,
    val recordedAt: String,
    val durationSeconds: Int,
)

/**
 * The microphone of the device and the file it writes, the one thing about recording that is not decided in Kotlin.
 * The native app implements it with the platform's audio framework; every call comes on the main thread. The state
 * machine (when to ask, when to upload, what a failure leaves behind) is `RecorderViewModel`.
 */
interface AudioRecorder {
    /** Asks for the microphone when the person was never asked; [answer] is whether recording is allowed. */
    fun requestPermission(answer: (Boolean) -> Unit)

    /** Starts a new recording; `false` when the device could not start one. */
    fun start(): Boolean

    fun pause()

    fun resume()

    /** Ends the recording and answers the file it wrote, or `null` when there is none. */
    fun stop(): CapturedAudio?

    /** Ends the recording in progress, if any, and deletes what it wrote. */
    fun cancel()

    /** Deletes the file of a recording that was kept for a retry. */
    fun delete(audio: CapturedAudio)

    /** Seconds recorded so far, a pause not counted. */
    fun elapsedSeconds(): Double

    /** The loudness of the input right now, from `0.0` to `1.0`. */
    fun level(): Float

    /** Copies the audio or video file at [path] (outside the app) into a file the app owns, or `null` if it cannot. */
    fun importFile(path: String): CapturedAudio?
}

/** The recorder of a device that has none (tests, previews): the microphone is never allowed. */
class UnavailableAudioRecorder : AudioRecorder {
    override fun requestPermission(answer: (Boolean) -> Unit) = answer(false)

    override fun start(): Boolean = false

    override fun pause() = Unit

    override fun resume() = Unit

    override fun stop(): CapturedAudio? = null

    override fun cancel() = Unit

    override fun delete(audio: CapturedAudio) = Unit

    override fun elapsedSeconds(): Double = 0.0

    override fun level(): Float = 0f

    override fun importFile(path: String): CapturedAudio? = null
}
