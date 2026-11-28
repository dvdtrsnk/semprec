package cz.alldots.app.presentation

import cz.alldots.app.core.SearchGroupType

sealed interface SearchEffect {
    /** The person picked a result; the app opens what it stands for. */
    data class OpenResult(
        val type: SearchGroupType,
        val itemId: String?,
        val threadId: String?,
        val databaseKey: String?,
        val journalType: String?,
        val journalPeriod: String?,
    ) : SearchEffect
}
