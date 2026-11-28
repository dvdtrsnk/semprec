package cz.alldots.app.presentation

import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.LoadPlaceholderItem
import cz.alldots.app.domain.LoadPlaceholderItems
import cz.alldots.app.domain.RequestPasswordReset
import cz.alldots.app.domain.RestoreSession
import cz.alldots.app.domain.SignIn
import cz.alldots.app.domain.SignOut
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
    private val auth: AuthRepository,
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun homeViewModel(): HomeViewModel = HomeViewModel(loadItems)

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun detailViewModel(itemId: String): DetailViewModel = DetailViewModel(itemId, loadItem)

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun settingsViewModel(): SettingsViewModel = SettingsViewModel()

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun sessionViewModel(): SessionViewModel = SessionViewModel(auth, RestoreSession(auth), SignOut(auth))

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun loginViewModel(): LoginViewModel = LoginViewModel(SignIn(auth), RequestPasswordReset(auth))
}
