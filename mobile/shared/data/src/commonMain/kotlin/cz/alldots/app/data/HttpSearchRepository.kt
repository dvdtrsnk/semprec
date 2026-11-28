package cz.alldots.app.data

import cz.alldots.app.core.SearchGroupType
import cz.alldots.app.core.SearchSubtitleKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SearchGroup
import cz.alldots.app.domain.SearchRepository
import cz.alldots.app.domain.SearchResult
import cz.alldots.app.domain.SearchSubtitlePart
import io.ktor.http.HttpMethod

/** `GET /api/search`: the matches of a text among everything the person has, grouped by kind. */
class HttpSearchRepository internal constructor(private val items: ItemsApi) : SearchRepository {
    constructor(api: AuthenticatedApi) : this(ItemsApi(api))

    override suspend fun search(
        query: String,
        scope: SearchGroupType?,
        perGroupLimit: Int,
    ): RepositoryResult<List<SearchGroup>> {
        val parameters = listOfNotNull(
            "q" to query,
            scope?.let { "scope" to it.wireName },
            "perGroupLimit" to perGroupLimit.toString(),
        )
        return when (val answer = items.send(HttpMethod.Get, "/api/search", parameters).decode<SearchResponseDto>()) {
            is RepositoryResult.Failure -> answer
            is RepositoryResult.Content -> RepositoryResult.Content(answer.value.groups.mapNotNull { it.toDomain() })
        }
    }
}

private val SearchGroupType.wireName: String get() = name.lowercase()

private fun SearchGroupDto.toDomain(): SearchGroup? {
    val groupType = SearchGroupType.entries.firstOrNull { it.wireName == type } ?: return null
    return SearchGroup(groupType, total, items.map { it.toDomain() })
}

private fun SearchResultDto.toDomain() = SearchResult(
    itemId = itemId,
    threadId = threadId,
    databaseKey = databaseKey,
    title = title,
    subtitle = subtitleParts.mapNotNull { part ->
        part.kind.toSubtitleKind()?.let { SearchSubtitlePart(it, part.value, part.itemId) }
    },
    snippet = snippet,
    journalType = journal?.type,
    journalPeriod = journal?.period,
)

/** The kind of each wire name; a kind a later server adds is dropped, as it has no words yet. */
private val SUBTITLE_KINDS: Map<String, SearchSubtitleKind> = mapOf(
    "date" to SearchSubtitleKind.DATE,
    "time" to SearchSubtitleKind.TIME,
    "timeRange" to SearchSubtitleKind.TIME_RANGE,
    "place" to SearchSubtitleKind.PLACE,
    "recurrence" to SearchSubtitleKind.RECURRENCE,
    "project" to SearchSubtitleKind.PROJECT,
    "people" to SearchSubtitleKind.PEOPLE,
    "phone" to SearchSubtitleKind.PHONE,
    "relationship" to SearchSubtitleKind.RELATIONSHIP,
    "status" to SearchSubtitleKind.STATUS,
    "sender" to SearchSubtitleKind.SENDER,
    "movedFrom" to SearchSubtitleKind.MOVED_FROM,
    "missedInEvent" to SearchSubtitleKind.MISSED_IN_EVENT,
)

private fun String.toSubtitleKind(): SearchSubtitleKind? = SUBTITLE_KINDS[this]
