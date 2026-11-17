package cz.semprec.app.presentation

import cz.semprec.app.core.SearchGroupType

sealed interface SearchAction {
    /** The text changed; it is searched once the person pauses typing. A blank text shows the recent searches. */
    data class QueryChanged(val text: String) : SearchAction

    /** Narrows the search to one kind, or to all of them for `null`. */
    data class SelectScope(val scope: SearchGroupType?) : SearchAction

    /** The person confirmed [text] (the return key): it is remembered and searched without waiting. */
    data class Submit(val text: String) : SearchAction

    /** Searches again after a failure. */
    data object Retry : SearchAction

    /** Opens the result with [key] of the group [type]. */
    data class Open(val type: SearchGroupType, val key: String) : SearchAction
}
