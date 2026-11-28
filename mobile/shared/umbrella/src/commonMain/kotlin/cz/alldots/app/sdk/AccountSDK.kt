package cz.alldots.app.sdk

import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpAccountNotificationRepository
import cz.alldots.app.data.HttpAccountRepository
import cz.alldots.app.data.HttpAccountTrashRepository
import cz.alldots.app.data.HttpAccountUsageRepository
import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.CollectionReads
import cz.alldots.app.presentation.AccountViewModelFactory
import cz.alldots.app.presentation.AiUsageViewModel
import cz.alldots.app.presentation.DevicesViewModel
import cz.alldots.app.presentation.NotificationSettingsViewModel
import cz.alldots.app.presentation.ProfileViewModel
import cz.alldots.app.presentation.TrashViewModel

/** The profile and the account screens below it; [HomeSDK.account] hands it out. */
class AccountSDK internal constructor(private val factory: AccountViewModelFactory) {

    fun profileViewModel(): ProfileViewModel = factory.profileViewModel()

    fun devicesViewModel(): DevicesViewModel = factory.devicesViewModel()

    fun notificationSettingsViewModel(): NotificationSettingsViewModel = factory.notificationSettingsViewModel()

    /** [today] is `yyyy-MM-dd`, asked whenever the screen reads a period. */
    fun aiUsageViewModel(today: () -> String): AiUsageViewModel = factory.aiUsageViewModel(today)

    fun trashViewModel(): TrashViewModel = factory.trashViewModel()

    internal companion object {
        fun create(api: AuthenticatedApi, auth: AuthRepository, reads: CollectionReads): AccountSDK = AccountSDK(
            AccountViewModelFactory(
                account = HttpAccountRepository(api),
                notifications = HttpAccountNotificationRepository(api),
                usage = HttpAccountUsageRepository(api),
                trash = HttpAccountTrashRepository(api, reads),
                auth = auth,
                changes = api.changes.events,
            ),
        )
    }
}
