package cz.semprec.app.presentation

import cz.semprec.app.domain.OfflineStatusSource
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the sync status ViewModels, whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain type it takes stays out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class SyncStatusViewModelFactory(private val source: OfflineStatusSource) {
    /** One new ViewModel per call; the caller owns it. */
    fun syncStatusViewModel(): SyncStatusViewModel = SyncStatusViewModel(source)
}
