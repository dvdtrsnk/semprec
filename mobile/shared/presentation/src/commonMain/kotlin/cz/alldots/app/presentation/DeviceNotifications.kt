package cz.alldots.app.presentation

import cz.alldots.app.core.ApnsEnvironment
import cz.alldots.app.core.AppPlatform
import cz.alldots.app.domain.LoadAppBadge
import cz.alldots.app.domain.LoadDeviceReminders
import cz.alldots.app.domain.RegisterPushSubscription
import cz.alldots.app.domain.ReminderKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.UpcomingReminder

enum class DeviceReminderKind { EVENT, TASK }

/**
 * A reminder the device shows itself. [identifier] names its local notification and is the same for the same
 * reminder on every read; [fireAt] and [startsAt] are ISO 8601 instants.
 */
data class DeviceReminder(
    val identifier: String,
    val kind: DeviceReminderKind,
    val itemId: String,
    val title: String,
    val fireAt: String,
    val startsAt: String,
)

/** What a silent push asks the device to read again. */
enum class DeviceResync { REMINDERS, SLEEP_ALARMS }

/** Where a tapped notification leads. */
sealed interface NotificationTarget {
    data class Event(val eventId: String) : NotificationTarget

    data class Task(val taskId: String) : NotificationTarget

    data object Invitations : NotificationTarget
}

/**
 * What the device does with notifications, apart from showing them: it registers its APNs token for the
 * signed-in person, reads the reminders it schedules itself and the number on its icon, and tells where a tapped
 * notification leads. Every call answers a value; a failed read is `null`, and cancellation is rethrown.
 */
class DeviceNotifications internal constructor(
    private val registerSubscription: RegisterPushSubscription,
    private val loadReminders: LoadDeviceReminders,
    private val loadBadge: LoadAppBadge,
) {
    /** Uploads [deviceToken] (the token's bytes in lower-case hex); answers whether the server registered it. */
    suspend fun register(deviceToken: String, environment: ApnsEnvironment, platform: AppPlatform): Boolean =
        guarded { registerSubscription(deviceToken, environment, platform) } is RepositoryResult.Content

    /**
     * The reminders to schedule from [from] (an ISO 8601 instant) on, soonest first; they replace every reminder
     * scheduled before. `null` when they could not be read, so the scheduled ones stay.
     */
    suspend fun reminders(from: String): List<DeviceReminder>? =
        when (val read = guarded { loadReminders(from) }) {
            is RepositoryResult.Content -> read.value.map { it.toDeviceReminder() }
            is RepositoryResult.Failure, null -> null
        }

    /** The number for the app icon, `0` for none; `null` when it could not be read, so the icon keeps its number. */
    suspend fun badge(): Int? = when (val read = guarded { loadBadge() }) {
        is RepositoryResult.Content -> read.value
        is RepositoryResult.Failure, null -> null
    }

    /**
     * Where a notification with [payload] (its custom keys with their string values) leads: an invitation opens
     * the invitations, a change of an event or an event's reminder opens the event, a task's reminder the task.
     * `null` for a notification that leads nowhere in particular.
     */
    fun target(payload: Map<String, String>): NotificationTarget? {
        fun named(key: String): String? = payload[key]?.takeIf { it.isNotBlank() }
        val eventId = named(EVENT_ID)
        val taskId = named(TASK_ID)
        return when {
            named(INVITATION_ID) != null -> NotificationTarget.Invitations
            eventId != null -> NotificationTarget.Event(eventId)
            taskId != null -> NotificationTarget.Task(taskId)
            else -> null
        }
    }

    /** The custom keys of the local notification of [reminder], which [target] reads back when it is tapped. */
    fun payload(reminder: DeviceReminder): Map<String, String> = when (reminder.kind) {
        DeviceReminderKind.EVENT -> mapOf(EVENT_ID to reminder.itemId)
        DeviceReminderKind.TASK -> mapOf(TASK_ID to reminder.itemId)
    }

    /** What a silent push with [payload] asks the device to read again, or `null` when it asks for nothing. */
    fun resync(payload: Map<String, String>): DeviceResync? = when (payload[KIND]) {
        REMINDERS_RESYNC -> DeviceResync.REMINDERS
        SLEEP_RESYNC -> DeviceResync.SLEEP_ALARMS
        else -> null
    }

    private companion object {
        const val INVITATION_ID = "invitation_id"
        const val EVENT_ID = "event_id"
        const val TASK_ID = "task_id"
        const val KIND = "kind"
        const val REMINDERS_RESYNC = "remindersResync"
        const val SLEEP_RESYNC = "sleepResync"
    }
}

private fun UpcomingReminder.toDeviceReminder() = DeviceReminder(
    identifier = key,
    kind = when (kind) {
        ReminderKind.EVENT -> DeviceReminderKind.EVENT
        ReminderKind.TASK -> DeviceReminderKind.TASK
    },
    itemId = itemId,
    title = title,
    fireAt = fireAt,
    startsAt = startsAt,
)
