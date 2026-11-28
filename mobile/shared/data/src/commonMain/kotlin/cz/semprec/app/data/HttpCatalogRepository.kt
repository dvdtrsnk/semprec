package cz.semprec.app.data

import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.ProjectRef
import cz.semprec.app.domain.CatalogRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then

/**
 * The projects and people of the person, read from their databases of the generic item API. The projects are
 * the ones a person can tie a task or an event to: neither done, archived nor a project a module keeps for itself
 * (`systemActive`), as the `pickerFilter` of the projects database says.
 */
internal class HttpCatalogRepository(private val items: ItemsApi) : CatalogRepository {
    override suspend fun projects(): RepositoryResult<List<ProjectRef>> =
        everything(WorkKeys.PROJECTS, ItemQuery()).map { found ->
            found
                .filterNot { it.properties.text(WorkKeys.STATUS) in CLOSED_PROJECTS }
                .filterNot { it.properties.flag(WorkKeys.SYSTEM_ACTIVE) }
                .sortedBy { it.name().lowercase() }
                .map { project -> ProjectRef(project.id, project.name(), project.properties.text(WorkKeys.COLOR)) }
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
