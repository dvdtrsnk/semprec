package cz.semprec.app.domain

import cz.semprec.app.core.AccountNotificationSwitch
import cz.semprec.app.core.AccountProblemsLevel

/** The notifications the person asked for: what is sent, the problem level and what counts on the app icon. */
data class AccountNotificationPrefs(
    val approvals: Boolean,
    val invites: Boolean,
    val reminders: Boolean,
    val calendarChanges: Boolean,
    val problemsLevel: AccountProblemsLevel,
    val problemsSummary: Boolean,
    val badgeApprovals: Boolean,
    val badgeInvites: Boolean,
    val badgeInbox: Boolean,
)

/** The preferences of the signed-in person; a change answers the preferences as the server now holds them. */
interface AccountNotificationRepository {
    suspend fun load(): RepositoryResult<AccountNotificationPrefs>

    suspend fun setSwitch(switch: AccountNotificationSwitch, on: Boolean): RepositoryResult<AccountNotificationPrefs>

    suspend fun setProblemsLevel(level: AccountProblemsLevel): RepositoryResult<AccountNotificationPrefs>
}
