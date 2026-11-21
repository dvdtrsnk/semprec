package cz.semprec.app.sdk

import cz.semprec.app.data.SyncSocket

/**
 * The sync socket of one window; [HomeSDK.sync] hands it out. Its owner starts it when the window comes to the
 * foreground and stops it when the window goes to the background or away. Call both on the main thread.
 */
class SyncSDK internal constructor(private val socket: SyncSocket) {
    /**
     * Connects with the signed-in session and stays connected, reconnecting after a drop, until [stop]. Signed out,
     * it does nothing; call it again after signing in. While it already runs, it does nothing either.
     */
    fun start() = socket.start()

    /** Closes the socket with a normal close frame; nothing reconnects until the next [start]. */
    fun stop() = socket.stop()
}
