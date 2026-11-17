package cz.semprec.app.presentation

sealed interface CollectionEffect {
    /** Open the item; [databaseKey] is `null` for a database a person created. */
    data class OpenItem(val itemId: String, val databaseKey: String?) : CollectionEffect
}
