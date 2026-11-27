package cz.semprec.app.presentation

import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.ProjectRef
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.domain.CatalogRepository
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.ItemChanges
import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.domain.NewTask
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.TaskRepository
import cz.semprec.app.domain.TaskScope
import cz.semprec.app.domain.WorkItem

const val WORK_TODAY = "2026-10-16"

val WORK_PROJECT = ProjectRef("p-work", "Semprec iOS", "#007AFF")
val HOME_PROJECT = ProjectRef("p-home", "Koupelna", "#AF52DE")

fun aTask(
    id: String,
    date: String? = WORK_TODAY,
    from: String? = null,
    effective: String? = date,
    status: TaskStatus = TaskStatus.NOT_DONE,
    project: ProjectRef? = null,
    flagged: Boolean = false,
    version: String = "v1",
) = WorkItem(
    kind = ItemKind.TASK,
    id = id,
    version = version,
    title = "Task $id",
    schedule = Schedule(date, from, null),
    status = status,
    effectiveDate = effective,
    project = project,
    flagged = flagged,
)

/** Scripted work repositories: every call runs the lambda of its operation, which a test replaces. */
class FakeWork {
    var onTasks: suspend (TaskScope) -> RepositoryResult<List<WorkItem>> = { RepositoryResult.Content(emptyList()) }
    var onCreate: suspend (
        NewTask
    ) -> RepositoryResult<WorkItem> = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
    var onLoad: suspend (
        ItemKind,
        String
    ) -> RepositoryResult<WorkItem> = { _, _ -> RepositoryResult.Failure(FailureKind.NOT_FOUND) }
    var onUpdate: suspend (
        WorkItem,
        ItemChange
    ) -> RepositoryResult<WorkItem> = { item, _ -> RepositoryResult.Content(item) }
    var onDelete: suspend (ItemKind, String) -> RepositoryResult<Unit> = { _, _ -> RepositoryResult.Content(Unit) }
    var projectAnswer: RepositoryResult<List<ProjectRef>> = RepositoryResult.Content(listOf(WORK_PROJECT, HOME_PROJECT))
    var peopleAnswer: RepositoryResult<List<EntityRef>> = RepositoryResult.Content(listOf(EntityRef("u1", "Karel")))

    val scopes = mutableListOf<TaskScope>()
    val created = mutableListOf<NewTask>()
    val updates = mutableListOf<Pair<WorkItem, ItemChange>>()
    val deleted = mutableListOf<String>()
    var catalogCalls = 0
    val changes = ItemChanges()

    private val taskRepository = object : TaskRepository {
        override suspend fun tasks(scope: TaskScope): RepositoryResult<List<WorkItem>> {
            scopes += scope
            return onTasks(scope)
        }

        override suspend fun create(task: NewTask): RepositoryResult<WorkItem> {
            created += task
            return onCreate(task)
        }
    }

    private val itemRepository = object : ItemRepository {
        override suspend fun load(kind: ItemKind, id: String): RepositoryResult<WorkItem> = onLoad(kind, id)

        override suspend fun update(item: WorkItem, change: ItemChange): RepositoryResult<WorkItem> {
            updates += item to change
            return onUpdate(item, change)
        }

        override suspend fun delete(kind: ItemKind, id: String): RepositoryResult<Unit> {
            deleted += id
            return onDelete(kind, id)
        }
    }

    private val catalogRepository = object : CatalogRepository {
        override suspend fun projects(): RepositoryResult<List<ProjectRef>> {
            catalogCalls += 1
            return projectAnswer
        }

        override suspend fun people(): RepositoryResult<List<EntityRef>> = peopleAnswer
    }

    fun factory() = WorkViewModelFactory(taskRepository, itemRepository, catalogRepository, changes)
}
