package cz.semprec.app.data

import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.ProjectRef
import cz.semprec.app.domain.CatalogRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then

/** The areas, projects and people of the person, read from their databases of the generic item API. */
internal class HttpCatalogRepository(private val items: ItemsApi) : CatalogRepository {
    override suspend fun areas(): RepositoryResult<List<EntityRef>> =
        everything(WorkKeys.AREAS, ItemQuery()).map { found ->
            found
                .filter { it.properties.checkedByDefault("active") }
                .sortedWith(compareBy({ it.properties.number("position") ?: Double.MAX_VALUE }, { it.name() }))
                .map { EntityRef(it.id, it.name(), it.properties.text(WorkKeys.COLOR)) }
        }

    override suspend fun projects(): RepositoryResult<List<ProjectRef>> =
        everything(WorkKeys.PROJECTS, ItemQuery(relations = mapOf(WorkKeys.AREA to emptyList()))).map { found ->
            found
                .filterNot { it.properties.text(WorkKeys.STATUS) in CLOSED_PROJECTS }
                .sortedBy { it.name().lowercase() }
                .map { project ->
                    val area = project.relations[WorkKeys.AREA]?.firstOrNull { !it.hidden }
                    val color = project.properties.text(WorkKeys.COLOR)
                    ProjectRef(project.id, project.name(), color, area?.id, area?.title)
                }
        }

    override suspend fun people(): RepositoryResult<List<EntityRef>> =
        everything(WorkKeys.PEOPLE, ItemQuery()).map { found ->
            found.sortedBy { it.name().lowercase() }.map { EntityRef(it.id, it.name()) }
        }

    private suspend fun everything(key: String, query: ItemQuery): RepositoryResult<List<ItemDto>> =
        items.databaseId(key).then { items.queryAll(it, query) }

    private fun ItemDto.name(): String = properties.text(WorkKeys.NAME).orEmpty()

    private companion object {
        val CLOSED_PROJECTS = setOf("done", "archived")
    }
}
