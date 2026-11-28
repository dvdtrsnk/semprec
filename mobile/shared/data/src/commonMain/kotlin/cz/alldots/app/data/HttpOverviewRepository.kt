package cz.alldots.app.data

import cz.alldots.app.domain.Overview
import cz.alldots.app.domain.OverviewCollection
import cz.alldots.app.domain.OverviewProject
import cz.alldots.app.domain.OverviewRepository
import cz.alldots.app.domain.OverviewSummary
import cz.alldots.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * The overview of the signed-in person: the counts and collections of `GET /api/overview`, the names of the collections of
 * `GET /api/databases` and the pinned projects as items. Which of them are shown and in which order is
 * decided by the use case, not here.
 */
class HttpOverviewRepository internal constructor(private val items: ItemsApi) : OverviewRepository {
    constructor(api: AuthenticatedApi) : this(ItemsApi(api))

    /** The three reads go out together; the first that fails, in this order, is the answer. */
    override suspend fun load(): RepositoryResult<Overview> = coroutineScope {
        val summary = async { items.send(HttpMethod.Get, "/api/overview").decode<OverviewDto>() }
        val databases = async { items.databases() }
        val projects = async { readItems(PROJECTS_KEY, pinnedProjects) }
        summary.await().andThen { read ->
            databases.await().andThen { known ->
                projects.await().andThen { projectItems ->
                    RepositoryResult.Content(assemble(read, known, projectItems))
                }
            }
        }
    }

    private suspend fun readItems(databaseKey: String, query: ItemQuery): RepositoryResult<List<ItemDto>> =
        items.databaseId(databaseKey).andThen { items.queryAll(it, query) }

    private companion object {
        const val PROJECTS_KEY = "projects"
        val pinnedProjects = ItemQuery(filter = Filter.equals("pinned", true))
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
    projects: List<ItemDto>,
): Overview {
    val byId = databases.associateBy { it.id }
    return Overview(
        summary = OverviewSummary(
            inboxPending = summary.inboxPending,
            mailUnread = summary.mailUnread,
            problemCount = summary.problemCount,
        ),
        projects = projects.map { it.toProject() },
        collections = summary.collections.mapNotNull { collection ->
            byId[collection.databaseId]?.let { collection.toCollection(it) }
        },
    )
}

private fun ItemDto.toProject() = OverviewProject(
    id = id,
    name = properties.text("name").orEmpty(),
    color = properties.text("color"),
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
