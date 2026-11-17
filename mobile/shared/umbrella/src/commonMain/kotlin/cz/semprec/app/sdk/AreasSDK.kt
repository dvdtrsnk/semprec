package cz.semprec.app.sdk

import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionWrites
import cz.semprec.app.domain.ItemChanges
import cz.semprec.app.domain.TaskRepository
import cz.semprec.app.presentation.AreaViewModel
import cz.semprec.app.presentation.AreaViewModelFactory

/** The area screen; [HomeSDK.areas] hands it out. */
class AreasSDK internal constructor(private val factory: AreaViewModelFactory) {

    /** [today] is `yyyy-MM-dd`, asked whenever the area is read. */
    fun areaViewModel(areaId: String, today: () -> String): AreaViewModel = factory.areaViewModel(areaId, today)

    internal companion object {
        fun create(
            reads: CollectionReads,
            writes: CollectionWrites,
            tasks: TaskRepository,
            changes: ItemChanges,
        ): AreasSDK = AreasSDK(AreaViewModelFactory(reads, writes, tasks, changes.events))
    }
}
