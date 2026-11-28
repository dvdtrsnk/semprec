package cz.alldots.app.presentation

import cz.alldots.app.core.AccountNotificationSwitch
import cz.alldots.app.core.AccountProblemsLevel
import cz.alldots.app.core.AccountUsageGranularity
import cz.alldots.app.domain.AccountDevice
import cz.alldots.app.domain.AccountNotificationPrefs
import cz.alldots.app.domain.AccountNotificationRepository
import cz.alldots.app.domain.AccountRepository
import cz.alldots.app.domain.AccountRestoreResult
import cz.alldots.app.domain.AccountSummary
import cz.alldots.app.domain.AccountTrashDatabase
import cz.alldots.app.domain.AccountTrashPage
import cz.alldots.app.domain.AccountTrashRepository
import cz.alldots.app.domain.AccountUsageLimits
import cz.alldots.app.domain.AccountUsageReport
import cz.alldots.app.domain.AccountUsageRepository
import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.RepositoryResult

/** Stands in for the repositories a test of one account screen does not use, so that a call to one is a failure. */
internal object AccountUnusedNotifications : AccountNotificationRepository {
    override suspend fun load(): RepositoryResult<AccountNotificationPrefs> = error("not used")

    override suspend fun setSwitch(
        switch: AccountNotificationSwitch,
        on: Boolean,
    ): RepositoryResult<AccountNotificationPrefs> = error("not used")

    override suspend fun setProblemsLevel(level: AccountProblemsLevel): RepositoryResult<AccountNotificationPrefs> =
        error("not used")
}

internal object AccountUnusedUsage : AccountUsageRepository {
    override suspend fun report(
        from: String,
        to: String,
        granularity: AccountUsageGranularity,
    ): RepositoryResult<AccountUsageReport> = error("not used")

    override suspend fun limits(): RepositoryResult<AccountUsageLimits> = error("not used")
}

internal object AccountUnusedTrash : AccountTrashRepository {
    override suspend fun items(cursor: String?): RepositoryResult<AccountTrashPage> = error("not used")

    override suspend fun databases(): RepositoryResult<List<AccountTrashDatabase>> = error("not used")

    override suspend fun restore(
        itemIds: List<String>,
        databaseIds: List<String>,
    ): RepositoryResult<List<AccountRestoreResult>> = error("not used")
}

internal object AccountUnusedAccount : AccountRepository {
    override suspend fun summary(): RepositoryResult<AccountSummary> = error("not used")

    override suspend fun devices(): RepositoryResult<List<AccountDevice>> = error("not used")

    override suspend fun revokeDevice(deviceId: String): RepositoryResult<Unit> = error("not used")

    override suspend fun revokeOtherDevices(): RepositoryResult<Unit> = error("not used")

    override suspend fun changeLocale(locale: String): RepositoryResult<Unit> = error("not used")
}

/** The factory of a test of the screens that use [account] only. */
internal fun accountFactory(account: AccountRepository, auth: AuthRepository) =
    AccountViewModelFactory(account, AccountUnusedNotifications, AccountUnusedUsage, AccountUnusedTrash, auth)
