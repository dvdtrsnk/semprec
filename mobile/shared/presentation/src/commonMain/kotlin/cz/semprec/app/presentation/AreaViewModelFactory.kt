package cz.semprec.app.presentation

import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionWrites
import cz.semprec.app.domain.LoadAreaOverview
import cz.semprec.app.domain.SetAreaActive
import cz.semprec.app.domain.TaskRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the area screen, whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain ports it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class AreaViewModelFactory(
    private val reads: CollectionReads,
    private val writes: CollectionWrites,
    private val tasks: TaskRepository,
    private val changes: Flow<Unit> = emptyFlow(),
) {
    /** One new ViewModel per call; the caller owns it. [today] is `yyyy-MM-dd`, asked whenever the area is read. */
    fun areaViewModel(areaId: String, today: () -> String): AreaViewModel =
        AreaViewModel(areaId, today, LoadAreaOverview(reads, tasks), SetAreaActive(reads, writes), changes)
}
