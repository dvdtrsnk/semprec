package cz.semprec.app.presentation

import cz.semprec.app.core.ItemKind
import cz.semprec.app.domain.CatalogRepository
import cz.semprec.app.domain.ItemChanges
import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.domain.TaskRepository
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the ViewModels of the task lists and of the Podrobnosti sheet for the SDK in the umbrella module. Hidden
 * from Objective-C and Swift so that the repositories it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class WorkViewModelFactory(
    tasks: TaskRepository,
    items: ItemRepository,
    catalog: CatalogRepository,
    private val changes: ItemChanges,
) {
    private val tasksDependencies = TasksDependencies(tasks, items, catalog, changes)
    private val detailsDependencies = ItemDetailsDependencies(items, catalog, changes)

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). [today] is `yyyy-MM-dd`. */
    fun tasksViewModel(today: () -> String, start: TasksStart): TasksViewModel =
        TasksViewModel(tasksDependencies, today, start)

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun itemDetailsViewModel(kind: ItemKind, itemId: String): ItemDetailsViewModel =
        ItemDetailsViewModel(kind, itemId, detailsDependencies)
}
