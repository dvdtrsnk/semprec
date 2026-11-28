package cz.alldots.app.data

import cz.alldots.app.core.ItemKind
import cz.alldots.app.domain.NewTask
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.TaskRepository
import cz.alldots.app.domain.TaskScope
import cz.alldots.app.domain.WorkItem
import cz.alldots.app.domain.map
import cz.alldots.app.domain.then
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The task lists, read from the `tasks` database of the generic item API. */
internal class HttpTaskRepository(
    private val items: ItemsApi,
    private val writes: ItemWrites,
) : TaskRepository {
    override suspend fun tasks(scope: TaskScope): RepositoryResult<List<WorkItem>> =
        items.databaseId(WorkKeys.TASKS).then { database ->
            val query = ItemQuery(filter = TaskFilters.forScope(scope), relations = WorkKeys.listRelations)
            items.queryAll(database, query).map { found -> found.map { it.toWorkItem(ItemKind.TASK) } }
        }

    override suspend fun create(task: NewTask): RepositoryResult<WorkItem> =
        items.databaseId(WorkKeys.TASKS).then { database ->
            val properties = buildJsonObject {
                put(WorkKeys.NAME, task.title)
                put(WorkKeys.STATUS, "notDone")
                if (task.date != null) put(WorkKeys.DATE, task.date)
            }
            val relations = task.projectId?.let { mapOf(WorkKeys.PROJECT to listOf(it)) } ?: emptyMap()
            writes.create(database, properties, relations)
        }.then { created ->
            items.get(created.id, WorkKeys.listRelations).map { it.toWorkItem(ItemKind.TASK) }
        }
}
