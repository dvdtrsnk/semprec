package cz.semprec.app.navigation

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import cz.semprec.app.feature.home.HomeRouter
import cz.semprec.app.feature.settings.SettingsRouter
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.update

/**
 * Implements the feature routers by queueing [NavigationCommand]s for the scene, which runs them on its own
 * navigation controllers while it is started. A command stays queued, and in [SavedStateHandle], until the scene
 * [acknowledge]s it, so a command not yet run survives a stopped scene, recreation and process death, and a
 * command that ran is never delivered again.
 *
 * The handle is read as untyped values and narrowed: a saved value of another type, an entry that is no readable
 * command and a second entry with a sequence already queued are dropped, and the saved state is rewritten without
 * them, the same as the unreadable commands [decodeQueued] rejects.
 */
class SceneNavigation(private val savedState: SavedStateHandle) : ViewModel() {
    private val pending = MutableStateFlow(readPending())

    /** The sequence of the next command; above every queued one, so [acknowledge] removes exactly one command. */
    private var nextSequence = maxOf(
        savedState.get<Any>(NEXT_SEQUENCE_KEY) as? Long ?: 1L,
        (pending.value.maxOfOrNull { it.sequence } ?: 0L) + 1,
    )

    /**
     * The oldest command not acknowledged yet, then the next one after each [acknowledge]; collected by one scene
     * at a time. A new collection starts again from the oldest unacknowledged command, so a command whose
     * collector was cancelled before it ran is delivered again.
     */
    val commands: Flow<QueuedNavigation> = pending.mapNotNull { it.firstOrNull() }.distinctUntilChanged()

    val home: HomeRouter = object : HomeRouter {
        override fun showDetail(id: String) = enqueue(NavigationCommand.Detail(id))

        override fun closeDetail() = enqueue(NavigationCommand.CloseDetail)
    }

    val settings: SettingsRouter = object : SettingsRouter {
        override fun showAbout() = enqueue(NavigationCommand.About)
    }

    init {
        // Rewrites the saved state without the values that could not be read back.
        persistPending()
        savedState[NEXT_SEQUENCE_KEY] = nextSequence
    }

    /** Called by the scene after it ran the command with [sequence]. */
    fun acknowledge(sequence: Long) {
        val remaining = pending.value.filterNot { it.sequence == sequence }
        if (remaining.size != pending.value.size) {
            pending.value = remaining
            persistPending()
        }
    }

    private fun enqueue(command: NavigationCommand) {
        val sequence = nextSequence++
        savedState[NEXT_SEQUENCE_KEY] = nextSequence
        pending.update { it + QueuedNavigation(sequence, command) }
        persistPending()
    }

    /** The saved queue in order, without what cannot be read back. */
    private fun readPending(): List<QueuedNavigation> {
        val saved = savedState.get<Any>(PENDING_KEY) as? List<*> ?: return emptyList()
        return saved.mapNotNull { (it as? String)?.let(::decodeQueued) }.distinctBy { it.sequence }
    }

    private fun persistPending() {
        savedState[PENDING_KEY] = ArrayList(pending.value.map { it.encode() })
    }

    internal companion object {
        const val PENDING_KEY = "pending_navigation"
        const val NEXT_SEQUENCE_KEY = "next_navigation_sequence"
    }
}
