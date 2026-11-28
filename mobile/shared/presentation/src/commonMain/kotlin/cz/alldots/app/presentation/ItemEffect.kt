package cz.alldots.app.presentation

sealed interface ItemEffect {
    /** Open another item; [databaseKey] is `null` for a database a person created. */
    data class OpenItem(val itemId: String, val databaseKey: String?) : ItemEffect

    /**
     * Open a collection of the items a related collection of this item holds. [filterJson] is the filter that
     * selects them, to be passed back to the collection as is.
     */
    data class OpenCollection(val databaseId: String, val databaseKey: String?, val filterJson: String?) : ItemEffect

    /** The item was deleted; its screen is to be closed. */
    data object Close : ItemEffect
}
