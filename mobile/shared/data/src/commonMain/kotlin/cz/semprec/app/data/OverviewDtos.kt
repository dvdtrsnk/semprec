package cz.semprec.app.data

import kotlinx.serialization.Serializable

/** `GET /api/overview`: the badges and counts of the overview in one read. */
@Serializable
internal data class OverviewDto(
    val inboxPending: Int = 0,
    val mailUnread: Int = 0,
    val tasksToday: Int = 0,
    val areas: List<AreaCountDto> = emptyList(),
    val collections: List<CollectionCountDto> = emptyList(),
    val problemCount: Int = 0,
    val journalTodayItemId: String? = null,
)

@Serializable
internal data class AreaCountDto(val id: String, val activeProjectCount: Int = 0)

@Serializable
internal data class CollectionCountDto(val databaseId: String, val ownerModuleId: String, val itemCount: Int = 0)

/** `GET /api/search`: the groups that have matches. */
@Serializable
internal data class SearchResponseDto(val groups: List<SearchGroupDto> = emptyList())

@Serializable
internal data class SearchGroupDto(
    val type: String,
    val total: Int = 0,
    val items: List<SearchResultDto> = emptyList(),
)

@Serializable
internal data class SearchResultDto(
    val itemId: String? = null,
    val threadId: String? = null,
    val databaseKey: String? = null,
    val title: String = "",
    val subtitleParts: List<SearchSubtitlePartDto> = emptyList(),
    val snippet: String? = null,
    val journal: SearchJournalDto? = null,
)

@Serializable
internal data class SearchSubtitlePartDto(val kind: String, val value: String = "", val itemId: String? = null)

@Serializable
internal data class SearchJournalDto(val type: String, val period: String)
