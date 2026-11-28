package cz.alldots.app.sdk

import cz.alldots.app.data.SyncSocket
import cz.alldots.app.presentation.SyncStatusViewModel
import cz.alldots.app.presentation.SyncStatusViewModelFactory

/**
 * The sync socket of one window and the status of its changes; [HomeSDK.sync] hands it out. Its owner starts the
 * socket when the window comes to the foreground and stops it when the window goes to the background or away. Call
 * both on the main thread.
 */
class SyncSDK internal constructor(
    private val socket: SyncSocket,
    private val statusViewModels: SyncStatusViewModelFactory,
) {
    /**
     * Connects with the signed-in session and stays connected, reconnecting after a drop, until [stop]. Signed out,
     * it does nothing; call it again after signing in. While it already runs, it does nothing either.
     */
    fun start() = socket.start()

    /** Closes the socket with a normal close frame; nothing reconnects until the next [start]. */
    fun stop() = socket.stop()

    /**
     * Whether the window is offline and how many of its changes wait or were refused; one new ViewModel per call,
     * which the caller owns. Without a data directory it is always online with nothing waiting.
     */
    fun statusViewModel(): SyncStatusViewModel = statusViewModels.syncStatusViewModel()
}
