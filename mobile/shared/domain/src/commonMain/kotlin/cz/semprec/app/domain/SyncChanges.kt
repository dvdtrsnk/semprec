package cz.semprec.app.domain

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

/**
 * Data a screen shows that the server reports as changed when it changes outside this window. [MAIL_THREADS] is a
 * change of a mail thread's row in the thread lists.
 */
enum class SyncTopic { CALENDAR, INVITATIONS, MAIL_ACCOUNTS, MAIL_THREADS }

/**
 * The change bus of the sync socket: one revision per [SyncTopic], raised when the server reports a change of that
 * data, whoever made it (another device, Semp, a background sync). A screen that shows the data reloads when the
 * revision of its topic moves.
 */
class SyncChanges {
    private val revisions = SyncTopic.entries.associateWith { MutableStateFlow(0) }

    /**
     * Emits once after each raise of [topic] that follows the start of the collection. Raises that come faster than
     * the collector reads them arrive as one, so a burst of changes costs one reload.
     */
    fun changes(topic: SyncTopic): Flow<Unit> = revisions.getValue(topic).drop(1).map { }

    fun raise(topics: Set<SyncTopic>) {
        topics.forEach { topic -> revisions.getValue(topic).update { it + 1 } }
    }
}
