package cz.semprec.app.presentation

import cz.semprec.app.domain.LoadPlaceholderItem
import cz.semprec.app.domain.LoadPlaceholderItems
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the screen ViewModels, whose constructors are internal, for the SDK in the umbrella module. Hidden
 * from Objective-C and Swift so that the domain use cases it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class HomeViewModelFactory(
    private val loadItems: LoadPlaceholderItems,
    private val loadItem: LoadPlaceholderItem,
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun homeViewModel(): HomeViewModel = HomeViewModel(loadItems)

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun detailViewModel(itemId: String): DetailViewModel = DetailViewModel(itemId, loadItem)

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun settingsViewModel(): SettingsViewModel = SettingsViewModel()
}
