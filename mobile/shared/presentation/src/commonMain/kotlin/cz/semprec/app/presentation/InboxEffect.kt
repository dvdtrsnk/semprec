package cz.semprec.app.presentation

/** One-time requests of the Inbox to the app. */
sealed interface InboxEffect {
    /** Show the item a decision created; [databaseKey] is its database's key when the server named it. */
    data class OpenItem(val databaseKey: String?, val itemId: String) : InboxEffect
}
