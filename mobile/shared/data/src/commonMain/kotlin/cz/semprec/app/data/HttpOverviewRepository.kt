package cz.semprec.app.data

import cz.semprec.app.domain.Overview
import cz.semprec.app.domain.OverviewArea
import cz.semprec.app.domain.OverviewCollection
import cz.semprec.app.domain.OverviewProject
import cz.semprec.app.domain.OverviewRepository
import cz.semprec.app.domain.OverviewSummary
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * The overview of the signed-in person: the counts of `GET /api/overview`, the names of the collections of
 * `GET /api/databases`, the areas and the pinned projects as items. Which of them are shown and in which order is
 * decided by the use case, not here.
 */
class HttpOverviewRepository internal constructor(private val items: ItemsApi) : OverviewRepository {
    constructor(api: AuthenticatedApi) : this(ItemsApi(api))

    override suspend fun load(): RepositoryResult<Overview> =
        items.send(HttpMethod.Get, "/api/overview").decode<OverviewDto>().andThen { summary ->
            items.databases().andThen { databases ->
                readItems(AREAS_KEY, ItemQuery()).andThen { areas ->
                    readItems(PROJECTS_KEY, pinnedProjects).andThen { projects ->
                        RepositoryResult.Content(assemble(summary, databases, areas, projects))
                    }
                }
            }
        }

    private suspend fun readItems(databaseKey: String, query: ItemQuery): RepositoryResult<List<ItemDto>> =
        items.databaseId(databaseKey).andThen { items.queryAll(it, query) }

    private companion object {
        const val AREAS_KEY = "areas"
        const val PROJECTS_KEY = "projects"
        val pinnedProjects = ItemQuery(
            filter = Filter.equals("pinned", true),
            relations = mapOf("area" to emptyList()),
        )
    }
}

private inline fun <T, R> RepositoryResult<T>.andThen(next: (T) -> RepositoryResult<R>): RepositoryResult<R> =
    when (this) {
        is RepositoryResult.Failure -> this
        is RepositoryResult.Content -> next(value)
    }

private fun assemble(
    summary: OverviewDto,
    databases: List<DatabaseDto>,
    areas: List<ItemDto>,
    projects: List<ItemDto>,
): Overview {
    val counts = summary.areas.associate { it.id to it.activeProjectCount }
    val byId = databases.associateBy { it.id }
    return Overview(
        summary = OverviewSummary(
            inboxPending = summary.inboxPending,
            mailUnread = summary.mailUnread,
            tasksToday = summary.tasksToday,
            problemCount = summary.problemCount,
            journalTodayItemId = summary.journalTodayItemId,
        ),
        areas = areas.map { it.toArea(counts[it.id] ?: 0) },
        projects = projects.map { it.toProject() },
        collections = summary.collections.mapNotNull { count ->
            byId[count.databaseId]?.let { count.toCollection(it) }
        },
    )
}

private fun ItemDto.toArea(activeProjectCount: Int) = OverviewArea(
    id = id,
    name = properties.text("name").orEmpty(),
    color = properties.text("color"),
    icon = properties.text("icon"),
    position = properties.number("position"),
    // An area is active unless it says otherwise.
    active = (properties["active"] as? JsonPrimitive)?.booleanOrNull ?: true,
    activeProjectCount = activeProjectCount,
)

private fun ItemDto.toProject() = OverviewProject(
    id = id,
    name = properties.text("name").orEmpty(),
    color = properties.text("color"),
    areaName = relations["area"]?.firstOrNull { !it.hidden }?.title,
    status = properties.text("status"),
    pinned = properties.flag("pinned"),
    pinnedOrder = properties.number("pinnedOrder"),
)

private fun CollectionCountDto.toCollection(database: DatabaseDto) = OverviewCollection(
    databaseId = databaseId,
    ownerModuleId = ownerModuleId,
    name = database.name,
    icon = database.icon,
    color = database.color,
    itemCount = itemCount,
    order = database.overviewOrder,
    clientVisible = database.clientVisible,
    hidden = database.overviewHidden,
)
