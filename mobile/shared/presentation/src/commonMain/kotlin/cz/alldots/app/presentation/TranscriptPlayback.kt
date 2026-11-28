package cz.alldots.app.presentation

import cz.alldots.app.core.AudioPlayer
import cz.alldots.app.core.PlaybackSource
import cz.alldots.app.core.PlayerListener

/** The playback speeds the player steps through, in order. */
private val PLAYBACK_RATES = listOf(1f, 1.5f, 2f)

/**
 * What the transcript screen does with the device player: [change] applies a step to the state of the player, and
 * [current] reads it. The device reports back through this object, which is the player's listener.
 */
internal class TranscriptPlayback(
    private val player: AudioPlayer,
    private val current: () -> TranscriptPlayer,
    private val change: ((TranscriptPlayer) -> TranscriptPlayer) -> Unit,
) : PlayerListener {

    fun load(source: PlaybackSource) {
        player.prepare(source, this)
        change { it.copy(available = true, failed = false) }
    }

    fun unavailable() = change { it.copy(failed = true) }

    fun toggle() {
        val now = current()
        if (!now.available || now.failed) return
        if (now.playing) player.pause() else player.play()
        change { it.copy(playing = !now.playing) }
    }

    fun seek(seconds: Double) {
        if (!current().available) return
        val target = seconds.coerceAtLeast(0.0)
        player.seekTo(target)
        change { it.copy(position = target) }
    }

    fun cycleRate() {
        val now = current()
        val next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(now.rate) + 1) % PLAYBACK_RATES.size]
        if (now.available) player.setRate(next)
        change { it.copy(rate = next) }
    }

    fun dispose() = player.dispose()

    override fun onPosition(seconds: Double) = change { it.copy(position = seconds) }

    override fun onDuration(seconds: Double) = change { it.copy(duration = seconds) }

    override fun onEnded() = change { it.copy(playing = false) }

    override fun onFailed() = change { it.copy(failed = true, playing = false) }
}
