package cz.alldots.app.presentation

import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.LoadOverview
import cz.alldots.app.domain.RecentSearches
import cz.alldots.app.domain.RememberRecentSearch
import cz.alldots.app.domain.SearchEverything
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the overview and search ViewModels, whose constructors are internal, for the SDK in the umbrella module.
 * Hidden from Objective-C and Swift so that the domain types it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class OverviewViewModelFactory(
    private val loadOverview: LoadOverview,
    private val search: SearchEverything,
    private val recents: RecentSearches,
    private val auth: AuthRepository,
    private val changes: Flow<Unit> = emptyFlow(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun overviewViewModel(): OverviewViewModel = OverviewViewModel(loadOverview, auth, changes)

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun searchViewModel(): SearchViewModel = SearchViewModel(search, RememberRecentSearch(recents), recents)
}
