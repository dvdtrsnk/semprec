package cz.alldots.app.sdk

import cz.alldots.app.presentation.HomeViewModelFactory
import cz.alldots.app.presentation.PasswordResetViewModel

/** The "Set a new password" form of reset links, of [HomeSDK]. Every call creates a new ViewModel its caller owns. */
class PasswordResetSDK internal constructor(private val viewModels: HomeViewModelFactory) {
    /**
     * The form for the [token] of a reset link, set at [serverUrl] (`https://host`): the server the link came from,
     * whichever server the window is signed in to.
     */
    fun viewModel(serverUrl: String, token: String): PasswordResetViewModel =
        viewModels.passwordResetViewModel(serverUrl, token)
}
