package cz.alldots.app.presentation

import cz.alldots.app.domain.AddMailSignal
import cz.alldots.app.domain.ProjectMailSignalsRepository
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the mail signals ViewModel, whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the repository it takes stays out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class ProjectMailSignalsViewModelFactory(private val repository: ProjectMailSignalsRepository) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun viewModel(projectId: String): ProjectMailSignalsViewModel =
        ProjectMailSignalsViewModel(projectId, repository, AddMailSignal())
}
