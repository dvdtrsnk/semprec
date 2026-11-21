package cz.semprec.app.data

import cz.semprec.app.core.AccountNotificationSwitch
import cz.semprec.app.core.AccountProblemsLevel
import cz.semprec.app.domain.AccountNotificationPrefs
import cz.semprec.app.domain.AccountNotificationRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** `GET` and `PATCH /api/notification-preferences`: the person's own row, or the defaults while there is none. */
class HttpAccountNotificationRepository(private val api: AuthenticatedApi) : AccountNotificationRepository {

    override suspend fun load(): RepositoryResult<AccountNotificationPrefs> =
        api.send(HttpMethod.Get, PATH).decode<AccountNotificationDto>().map { it.toPrefs() }

    override suspend fun setSwitch(
        switch: AccountNotificationSwitch,
        on: Boolean,
    ): RepositoryResult<AccountNotificationPrefs> = patch(buildJsonObject { put(switch.wireName(), on) })

    override suspend fun setProblemsLevel(level: AccountProblemsLevel): RepositoryResult<AccountNotificationPrefs> =
        patch(buildJsonObject { put("problemsLevel", level.wireName()) })

    private suspend fun patch(body: JsonObject): RepositoryResult<AccountNotificationPrefs> =
        api.send(HttpMethod.Patch, PATH, body = body.toString()).decode<AccountNotificationDto>().map { it.toPrefs() }

    private companion object {
        const val PATH = "/api/notification-preferences"
    }
}

private fun AccountNotificationSwitch.wireName(): String = when (this) {
    AccountNotificationSwitch.APPROVALS -> "approvals"
    AccountNotificationSwitch.INVITES -> "invites"
    AccountNotificationSwitch.REMINDERS -> "reminders"
    AccountNotificationSwitch.CALENDAR_CHANGES -> "calendarChanges"
    AccountNotificationSwitch.PROBLEMS_SUMMARY -> "problemsSummary"
    AccountNotificationSwitch.BADGE_APPROVALS -> "badgeApprovals"
    AccountNotificationSwitch.BADGE_INVITES -> "badgeInvites"
    AccountNotificationSwitch.BADGE_INBOX -> "badgeInbox"
}

private fun AccountProblemsLevel.wireName(): String = when (this) {
    AccountProblemsLevel.OFF -> "off"
    AccountProblemsLevel.CRITICAL -> "critical"
    AccountProblemsLevel.ALL -> "all"
}

private fun AccountNotificationDto.toPrefs() = AccountNotificationPrefs(
    approvals = approvals,
    invites = invites,
    reminders = reminders,
    calendarChanges = calendarChanges,
    problemsLevel = when (problemsLevel) {
        "off" -> AccountProblemsLevel.OFF
        "all" -> AccountProblemsLevel.ALL
        else -> AccountProblemsLevel.CRITICAL
    },
    problemsSummary = problemsSummary,
    badgeApprovals = badgeApprovals,
    badgeInvites = badgeInvites,
    badgeInbox = badgeInbox,
)
