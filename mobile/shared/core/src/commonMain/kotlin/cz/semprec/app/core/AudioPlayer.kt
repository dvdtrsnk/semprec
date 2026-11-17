package cz.semprec.app.core

/** What a player streams: the [url] and the `Authorization` header value the server wants with it. */
class PlaybackSource(val url: String, val authorization: String)

/** What the device player reports back to the shared screen; every call comes on the main thread. */
interface PlayerListener {
    fun onPosition(seconds: Double)

    fun onDuration(seconds: Double)

    fun onEnded()

    fun onFailed()
}

/**
 * The audio player of the device, the one thing about playback that is not decided in Kotlin. The native app
 * implements it with the platform's audio framework; every call comes on the main thread. What plays, from where and
 * at which speed is `TranscriptViewModel`.
 */
interface AudioPlayer {
    /** Loads [source] for playback, replacing what was loaded; the player reports to [listener] until released. */
    fun prepare(source: PlaybackSource, listener: PlayerListener)

    fun play()

    fun pause()

    fun seekTo(seconds: Double)

    fun setRate(rate: Float)

    /** Stops playback and forgets the source and the listener. */
    fun dispose()
}

/** The player of a device that has none (tests, previews): it reports a failure at once. */
class UnavailableAudioPlayer : AudioPlayer {
    override fun prepare(source: PlaybackSource, listener: PlayerListener) = listener.onFailed()

    override fun play() = Unit

    override fun pause() = Unit

    override fun seekTo(seconds: Double) = Unit

    override fun setRate(rate: Float) = Unit

    override fun dispose() = Unit
}
