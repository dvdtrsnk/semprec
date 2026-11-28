package cz.alldots.app.presentation

import cz.alldots.app.domain.AccountNotificationRepository
import cz.alldots.app.domain.AccountRepository
import cz.alldots.app.domain.AccountTrashRepository
import cz.alldots.app.domain.AccountUsageRepository
import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.RequestPasswordReset
import cz.alldots.app.domain.SignOut
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the profile and the account screens below it, whose constructors are internal, for the SDK in the umbrella
 * module. Hidden from Objective-C and Swift so that the domain types it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class AccountViewModelFactory(
    private val account: AccountRepository,
    private val notifications: AccountNotificationRepository,
    private val usage: AccountUsageRepository,
    private val trash: AccountTrashRepository,
    private val auth: AuthRepository,
    private val changes: Flow<Unit> = emptyFlow(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun profileViewModel(): ProfileViewModel =
        ProfileViewModel(account, auth, RequestPasswordReset(auth), SignOut(auth))

    fun devicesViewModel(): DevicesViewModel = DevicesViewModel(account)

    fun notificationSettingsViewModel(): NotificationSettingsViewModel = NotificationSettingsViewModel(notifications)

    /** [today] is `yyyy-MM-dd`, asked whenever the screen reads a period. */
    fun aiUsageViewModel(today: () -> String): AiUsageViewModel = AiUsageViewModel(usage, today)

    fun trashViewModel(): TrashViewModel = TrashViewModel(trash, changes)
}
