package cz.semprec.app.presentation

import cz.semprec.app.core.AccountNotificationSwitch
import cz.semprec.app.core.AccountProblemsLevel
import cz.semprec.app.core.AccountUsageGranularity
import cz.semprec.app.domain.AccountDevice
import cz.semprec.app.domain.AccountNotificationPrefs
import cz.semprec.app.domain.AccountNotificationRepository
import cz.semprec.app.domain.AccountRepository
import cz.semprec.app.domain.AccountRestoreResult
import cz.semprec.app.domain.AccountSummary
import cz.semprec.app.domain.AccountTrashDatabase
import cz.semprec.app.domain.AccountTrashPage
import cz.semprec.app.domain.AccountTrashRepository
import cz.semprec.app.domain.AccountUsageLimits
import cz.semprec.app.domain.AccountUsageReport
import cz.semprec.app.domain.AccountUsageRepository
import cz.semprec.app.domain.AuthRepository
import cz.semprec.app.domain.RepositoryResult

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
