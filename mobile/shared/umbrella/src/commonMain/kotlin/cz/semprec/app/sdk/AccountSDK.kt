package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpAccountNotificationRepository
import cz.semprec.app.data.HttpAccountRepository
import cz.semprec.app.data.HttpAccountTrashRepository
import cz.semprec.app.data.HttpAccountUsageRepository
import cz.semprec.app.domain.AuthRepository
import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.presentation.AccountViewModelFactory
import cz.semprec.app.presentation.AiUsageViewModel
import cz.semprec.app.presentation.DevicesViewModel
import cz.semprec.app.presentation.NotificationSettingsViewModel
import cz.semprec.app.presentation.ProfileViewModel
import cz.semprec.app.presentation.TrashViewModel

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
