package cz.alldots.app.core

/** The server a person signed in to and the bearer token that server issued for this device. */
data class StoredSession(val serverUrl: String, val token: String)
