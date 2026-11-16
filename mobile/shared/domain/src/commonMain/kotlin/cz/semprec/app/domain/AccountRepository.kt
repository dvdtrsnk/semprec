package cz.semprec.app.domain

import cz.semprec.app.core.AccountDeviceKind
import cz.semprec.app.core.AccountPlatform

/** The figures of the profile screen, read in one call; the trash and session counts are what the lists would show. */
data class AccountSummary(
    val activeSessions: Int,
    val mailAccountCount: Int,
    val mailAccountsNeedingReauth: Int,
    val trashItems: Int,
    val trashDatabases: Int,
    val problemCount: Int,
    val aiCostMonthUsd: Double,
)

/** One signed-in session of the person. [current] is the session of this device. */
data class AccountDevice(
    val id: String,
    val current: Boolean,
    val platform: AccountPlatform,
    val kind: AccountDeviceKind,
    val name: String?,
    val createdAt: String,
    val lastSeenAt: String,
)

/** The account calls of the profile screen and the screens below it. Every failure is a value. */
interface AccountRepository {
    suspend fun summary(): RepositoryResult<AccountSummary>

    suspend fun devices(): RepositoryResult<List<AccountDevice>>

    /** Ends the session [deviceId]; a session that is already gone is a success. */
    suspend fun revokeDevice(deviceId: String): RepositoryResult<Unit>

    /** Ends every session but this device's. */
    suspend fun revokeOtherDevices(): RepositoryResult<Unit>

    /** Sets the language of the account (`cs` or `en`). */
    suspend fun changeLocale(locale: String): RepositoryResult<Unit>
}

/** The languages the server serves, in the order the profile offers them. */
val ACCOUNT_LOCALES: List<String> = listOf("cs", "en")
