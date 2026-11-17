package cz.semprec.app.domain

import cz.semprec.app.core.SearchGroupType
import cz.semprec.app.core.SearchSubtitleKind

/** One piece of a result's subtitle: its [kind], the canonical [value] and, for a linked item, its [itemId]. */
data class SearchSubtitlePart(val kind: SearchSubtitleKind, val value: String, val itemId: String?)

/**
 * One match. An item result has [itemId] and [databaseKey]; a mail or chat result has a [threadId] (a mail result
 * also the item of its last message). A journal result names its period by [journalType] and [journalPeriod].
 */
data class SearchResult(
    val itemId: String?,
    val threadId: String?,
    val databaseKey: String?,
    val title: String,
    val subtitle: List<SearchSubtitlePart>,
    val snippet: String?,
    val journalType: String?,
    val journalPeriod: String?,
)

/** The matches of one kind: [total] counts every match, [results] the ones listed. */
data class SearchGroup(val type: SearchGroupType, val total: Int, val results: List<SearchResult>)

/** Searches everything the person has. */
interface SearchRepository {
    /** The groups with matches, in the server's order. [scope] `null` searches every kind. */
    suspend fun search(query: String, scope: SearchGroupType?, perGroupLimit: Int): RepositoryResult<List<SearchGroup>>
}
