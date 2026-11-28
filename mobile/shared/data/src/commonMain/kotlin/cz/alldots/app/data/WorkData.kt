package cz.alldots.app.data

import cz.alldots.app.domain.CatalogRepository
import cz.alldots.app.domain.ItemRepository
import cz.alldots.app.domain.TaskRepository

/** The task, event and catalog repositories of one signed-in session, over the generic item API. */
class WorkData(api: AuthenticatedApi) {
    private val items = ItemsApi(api)
    private val writes = ItemWrites(api)

    val tasks: TaskRepository = HttpTaskRepository(items, writes)
    val details: ItemRepository = HttpItemRepository(items, writes)
    val catalog: CatalogRepository = HttpCatalogRepository(items)
}
