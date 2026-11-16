package cz.semprec.app.presentation

sealed interface CollectionAction {
    data object Retry : CollectionAction

    /** Runs the current query again over the rows on screen, for when the screen appears again. */
    data object Refresh : CollectionAction

    /** The text of the search field, sent when the person submits it; an empty text clears the search. */
    data class Search(val text: String) : CollectionAction
    data class SelectQuickFilter(val key: String) : CollectionAction

    /** Orders by [axis]; choosing the order that is already active reverses it. */
    data class SelectSort(val axis: SortAxis) : CollectionAction
    data class SelectLayout(val layout: CollectionLayout) : CollectionAction
    data object LoadMore : CollectionAction
    data class OpenItem(val id: String) : CollectionAction
    data object DismissWriteFailure : CollectionAction

    /** The filter sheet. */
    sealed interface Filter : CollectionAction {
        /** Opens the sheet: loads the choices of every filterable property under the current filter. */
        data object Open : Filter
        data object Close : Filter
        data class Toggle(val propertyKey: String, val value: String) : Filter

        /** Chooses one relative date for a date property, or clears it when it is the chosen one. */
        data class ToggleDate(val propertyKey: String, val preset: String) : Filter
        data class Clear(val propertyKey: String) : Filter
        data object ClearAll : Filter
    }

    /** Adding to the collection. */
    sealed interface Write : CollectionAction {
        /** Creates an item with this title (in the area or relation the collection is scoped to) and opens it. */
        data class Create(val title: String) : Write

        /** Uploads a file, given as Base64 text of its bytes, attached to what the collection is scoped to. */
        data class Upload(val filename: String, val mimeType: String, val base64: String) : Write
    }
}
