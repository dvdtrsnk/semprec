package cz.alldots.app.core

/** A [SessionStorage] that forgets everything with the process; the default where no secure store is wired. */
class InMemorySessionStorage : SessionStorage {
    private var current: StoredSession? = null

    override fun load(): StoredSession? = current

    override fun save(session: StoredSession?) {
        current = session
    }
}
