package cz.alldots.app.domain

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf

/**
 * What the device has not brought to the server yet
 * (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection.md): whether the process is
 * [offline], how many changes of the signed-in account [waiting] for the server, and how many the server refused
 * ([failed]) since they were last forgotten.
 */
data class OfflineStatus(val offline: Boolean, val waiting: Int, val failed: Int)

/** The offline state and the queue of the signed-in account, as they change. */
interface OfflineStatusSource {
    /** The current status first, then every change. */
    val status: Flow<OfflineStatus>

    /** Forgets the refused changes recorded for the signed-in account. */
    suspend fun forgetFailures()
}

/** The status of a device that keeps nothing: online, with nothing waiting and nothing refused. */
object NoOfflineStatus : OfflineStatusSource {
    override val status: Flow<OfflineStatus> = flowOf(OfflineStatus(offline = false, waiting = 0, failed = 0))

    override suspend fun forgetFailures() = Unit
}
