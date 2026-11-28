package cz.alldots.app.domain

import cz.alldots.app.core.SearchGroupType

/** The longest search text the server takes. */
const val MAX_SEARCH_LENGTH = 200

private const val ALL_SCOPES_PER_GROUP = 4
private const val ONE_SCOPE_PER_GROUP = 50

/**
 * Searches for [query]: the text is trimmed and cut to the length the server takes, and a blank one matches nothing
 * without asking. Searching all kinds lists a few of each; searching one kind lists up to fifty of it.
 */
class SearchEverything(private val repository: SearchRepository) {
    suspend operator fun invoke(query: String, scope: SearchGroupType?): RepositoryResult<List<SearchGroup>> {
        val text = query.trim().take(MAX_SEARCH_LENGTH).trim()
        if (text.isEmpty()) return RepositoryResult.Content(emptyList())
        val limit = if (scope == null) ALL_SCOPES_PER_GROUP else ONE_SCOPE_PER_GROUP
        return when (val answer = repository.search(text, scope, limit)) {
            is RepositoryResult.Failure -> answer
            is RepositoryResult.Content -> RepositoryResult.Content(answer.value.filter { it.results.isNotEmpty() })
        }
    }
}
