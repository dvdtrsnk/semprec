package cz.semprec.app.domain

import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.ProjectRef
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.merge

/** The task lists. */
interface TaskRepository {
    /** The tasks of [scope] the person may see, each with its project and the area of it. */
    suspend fun tasks(scope: TaskScope): RepositoryResult<List<WorkItem>>

    suspend fun create(task: NewTask): RepositoryResult<WorkItem>
}

/** Reading and changing one task or event: the shared Podrobnosti sheet. */
interface ItemRepository {
    suspend fun load(kind: ItemKind, id: String): RepositoryResult<WorkItem>

    /** Writes [change] to [item] (naming its version) and answers the item as the server now holds it. */
    suspend fun update(item: WorkItem, change: ItemChange): RepositoryResult<WorkItem>

    /** Moves the item to the trash, from where it can be restored for 30 days. */
    suspend fun delete(kind: ItemKind, id: String): RepositoryResult<Unit>
}

/** The areas, projects and people a task or an event can be filtered or tied by. */
interface CatalogRepository {
    suspend fun areas(): RepositoryResult<List<EntityRef>>

    suspend fun projects(): RepositoryResult<List<ProjectRef>>

    suspend fun people(): RepositoryResult<List<EntityRef>>
}

/**
 * Tells the open screens of a window that its data changed, so that they load again: the window's signed-in API
 * client announces every write it made, and the Podrobnosti sheet its own saves
 * (docs/adr/2026-11-16-open-mobile-screens-reload-after-any-write-of-their-window.md). Every window has its own
 * instance. [elsewhere] adds the changes the window learns of from outside itself: the offline layer every window of
 * the process shares emits when the connection came back
 * (docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md).
 */
class ItemChanges(elsewhere: Flow<Unit> = emptyFlow()) {
    private val mutable = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: Flow<Unit> = merge(mutable.asSharedFlow(), elsewhere)

    fun announce() {
        mutable.tryEmit(Unit)
    }
}
