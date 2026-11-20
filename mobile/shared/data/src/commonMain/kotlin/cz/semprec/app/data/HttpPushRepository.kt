package cz.semprec.app.data

import cz.semprec.app.core.ApnsEnvironment
import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.BadgeCounts
import cz.semprec.app.domain.PushRepository
import cz.semprec.app.domain.ReminderKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.UpcomingReminder
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * `POST /api/push-subscriptions` and `POST /api/push-subscriptions/:id/revoke` for this device's APNs token,
 * `GET /api/calendar/reminders` and `GET /api/badge-counts`.
 */
class HttpPushRepository(private val api: AuthenticatedApi) : PushRepository {

    override suspend fun register(
        deviceToken: String,
        environment: ApnsEnvironment,
        platform: AppPlatform,
    ): RepositoryResult<String> {
        val body = ApiJson.encodeToString(
            PushSubscriptionRequest(
                channel = "apns",
                platform = platform.wireName,
                deviceToken = deviceToken,
                apnsEnvironment = environment.wireName,
            ),
        )
        return api.send(HttpMethod.Post, SUBSCRIPTIONS_PATH, body = body).decode<PushSubscriptionResponse>()
            .then { answer ->
                val id = answer.subscription.id
                if (id.isBlank()) RepositoryResult.Failure(FailureKind.INVALID_DATA) else RepositoryResult.Content(id)
            }
    }

    override suspend fun revoke(subscriptionId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "$SUBSCRIPTIONS_PATH/${subscriptionId.encodeURLPathPart()}/revoke").ignoreBody()

    override suspend fun upcomingReminders(from: String, hours: Int): RepositoryResult<List<UpcomingReminder>> =
        api.send(HttpMethod.Get, REMINDERS_PATH, query = listOf("from" to from, "hours" to hours.toString()))
            .decode<List<UpcomingReminderDto>>()
            .map { reminders -> reminders.mapNotNull { it.toReminder() } }

    override suspend fun badgeCounts(): RepositoryResult<BadgeCounts> =
        api.send(HttpMethod.Get, BADGE_COUNTS_PATH).decode<BadgeCountsDto>()
            .map { BadgeCounts(it.pendingApprovals, it.pendingInvites, it.openInboxItems) }

    private companion object {
        const val SUBSCRIPTIONS_PATH = "/api/push-subscriptions"
        const val REMINDERS_PATH = "/api/calendar/reminders"
        const val BADGE_COUNTS_PATH = "/api/badge-counts"
    }
}

@Serializable
private data class PushSubscriptionRequest(
    val channel: String,
    val platform: String,
    val deviceToken: String,
    val apnsEnvironment: String,
)

@Serializable
private data class PushSubscriptionResponse(val subscription: PushSubscriptionDto)

@Serializable
private data class PushSubscriptionDto(val id: String)

@Serializable
private data class UpcomingReminderDto(
    val key: String,
    val itemId: String,
    val kind: String,
    val title: String = "",
    val fireAt: String,
    val startsAt: String,
)

@Serializable
private data class BadgeCountsDto(
    val pendingApprovals: Int = 0,
    val pendingInvites: Int = 0,
    val openInboxItems: Int = 0,
)

/** A kind this app does not know is left out rather than shown as the wrong thing. */
private fun UpcomingReminderDto.toReminder(): UpcomingReminder? {
    val kind = when (kind) {
        "event" -> ReminderKind.EVENT
        "task" -> ReminderKind.TASK
        else -> return null
    }
    return UpcomingReminder(key, itemId, kind, title, fireAt, startsAt)
}
