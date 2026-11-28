package cz.alldots.app.presentation

import kotlin.time.Clock
import kotlin.time.ExperimentalTime

/** How long the editor waits after the last change before writing it, and the clock that stamps a write. */
internal data class NoteEditorSettings(
    val saveDelayMillis: Long = 700,
    val now: () -> String = ::currentInstant,
)

@OptIn(ExperimentalTime::class)
private fun currentInstant(): String = Clock.System.now().toString()
