package cz.semprec.app.domain

import cz.semprec.app.core.ApnsEnvironment
import cz.semprec.app.core.AppPlatform

enum class ReminderKind { EVENT, TASK }

/**
 * One reminder the server computed for an event or a task. [key] is stable for the same reminder of the same
 * occurrence; [fireAt] and [startsAt] are ISO 8601 instants.
 */
data class UpcomingReminder(
    val key: String,
    val itemId: String,
    val kind: ReminderKind,
    val title: String,
    val fireAt: String,
    val startsAt: String,
)

/** What the app icon may count, before the person's badge switches pick from it. */
data class BadgeCounts(val pendingApprovals: Int, val pendingInvites: Int, val openInboxItems: Int)

/** The push subscription of this device and what a push wakes the device to read. */
interface PushRepository {
    /** Registers [deviceToken] for the signed-in person and answers the id of its subscription. */
    suspend fun register(
        deviceToken: String,
        environment: ApnsEnvironment,
        platform: AppPlatform,
    ): RepositoryResult<String>

    suspend fun revoke(subscriptionId: String): RepositoryResult<Unit>

    /** The reminders that fire from [from] (an ISO 8601 instant) for [hours] hours, soonest first. */
    suspend fun upcomingReminders(from: String, hours: Int): RepositoryResult<List<UpcomingReminder>>

    suspend fun badgeCounts(): RepositoryResult<BadgeCounts>
}
