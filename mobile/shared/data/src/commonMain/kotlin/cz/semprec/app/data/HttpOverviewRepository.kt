package cz.semprec.app.data

import cz.semprec.app.domain.Overview
import cz.semprec.app.domain.OverviewArea
import cz.semprec.app.domain.OverviewCollection
import cz.semprec.app.domain.OverviewProject
import cz.semprec.app.domain.OverviewRepository
import cz.semprec.app.domain.OverviewSummary
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * The overview of the signed-in person: the counts and collections of `GET /api/overview`, the names of the collections of
 * `GET /api/databases`, the areas and the pinned projects as items. Which of them are shown and in which order is
 * decided by the use case, not here.
 */
class HttpOverviewRepository internal constructor(private val items: ItemsApi) : OverviewRepository {
    constructor(api: AuthenticatedApi) : this(ItemsApi(api))

    /** The four reads go out together; the first that fails, in this order, is the answer. */
    override suspend fun load(): RepositoryResult<Overview> = coroutineScope {
        val summary = async { items.send(HttpMethod.Get, "/api/overview").decode<OverviewDto>() }
        val databases = async { items.databases() }
        val areas = async { readItems(AREAS_KEY, ItemQuery()) }
        val projects = async { readItems(PROJECTS_KEY, pinnedProjects) }
        summary.await().andThen { read ->
            databases.await().andThen { known ->
                areas.await().andThen { areaItems ->
                    projects.await().andThen { projectItems ->
                        RepositoryResult.Content(assemble(read, known, areaItems, projectItems))
                    }
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
    val byId = databases.associateBy { it.id }
    return Overview(
        summary = OverviewSummary(
            inboxPending = summary.inboxPending,
            mailUnread = summary.mailUnread,
            problemCount = summary.problemCount,
        ),
        areas = areas.map { it.toArea() },
        projects = projects.map { it.toProject() },
        collections = summary.collections.mapNotNull { collection ->
            byId[collection.databaseId]?.let { collection.toCollection(it) }
        },
    )
}

private fun ItemDto.toArea() = OverviewArea(
    id = id,
    name = properties.text("name").orEmpty(),
    color = properties.text("color"),
    icon = properties.text("icon"),
    position = properties.number("position"),
    // An area is active unless it says otherwise.
    active = (properties["active"] as? JsonPrimitive)?.booleanOrNull ?: true,
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

private fun OverviewCollectionDto.toCollection(database: DatabaseDto) = OverviewCollection(
    databaseId = databaseId,
    ownerModuleId = ownerModuleId,
    name = database.name,
    icon = database.icon,
    color = database.color,
    order = database.overviewOrder,
    clientVisible = database.clientVisible,
    hidden = database.overviewHidden,
)
