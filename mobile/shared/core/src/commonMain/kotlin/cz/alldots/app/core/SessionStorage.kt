package cz.alldots.app.core

/**
 * Where a signed-in session survives a restart. The native app implements it with the platform's secure store
 * (the Keychain on Apple), because the token must also be readable by native code that hosts web content.
 * [save] with `null` forgets the session.
 */
interface SessionStorage {
    fun load(): StoredSession?
    fun save(session: StoredSession?)
}
