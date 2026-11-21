package cz.semprec.app.domain

import cz.semprec.app.core.ApnsEnvironment
import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.PushSubscriptionStorage

/** Uploads the device token APNs issued and keeps the id of the subscription, which signing out revokes. */
class RegisterPushSubscription(private val push: PushRepository, private val storage: PushSubscriptionStorage) {
    suspend operator fun invoke(
        deviceToken: String,
        environment: ApnsEnvironment,
        platform: AppPlatform,
    ): RepositoryResult<Unit> {
        if (deviceToken.isBlank()) return RepositoryResult.Failure(FailureKind.INVALID_DATA)
        return when (val registered = push.register(deviceToken, environment, platform)) {
            is RepositoryResult.Failure -> registered
            is RepositoryResult.Content -> {
                storage.save(registered.value)
                RepositoryResult.Content(Unit)
            }
        }
    }
}

/**
 * Ends the push subscription of this device. The stored id is forgotten whatever the server answers: after the
 * sign-out that runs this, no session is left that could retry it.
 */
class RevokePushSubscription(private val push: PushRepository, private val storage: PushSubscriptionStorage) {
    suspend operator fun invoke(): RepositoryResult<Unit> {
        val subscriptionId = storage.load() ?: return RepositoryResult.Content(Unit)
        storage.save(null)
        return push.revoke(subscriptionId)
    }
}

/**
 * The reminders this device shows itself, for the next [REMINDER_HOURS] hours from [from]; none while the person
 * has turned reminders off.
 */
class LoadDeviceReminders(
    private val push: PushRepository,
    private val preferences: AccountNotificationRepository,
) {
    suspend operator fun invoke(from: String): RepositoryResult<List<UpcomingReminder>> =
        when (val prefs = preferences.load()) {
            is RepositoryResult.Failure -> prefs
            is RepositoryResult.Content -> if (prefs.value.reminders) {
                push.upcomingReminders(from, REMINDER_HOURS)
            } else {
                RepositoryResult.Content(emptyList())
            }
        }

    companion object {
        /** The server's default window; a silent push asks for a new read whenever a reminder in it changes. */
        const val REMINDER_HOURS = 48
    }
}

/** The number on the app icon: the sum of the counts whose badge switch the person left on. */
class LoadAppBadge(private val push: PushRepository, private val preferences: AccountNotificationRepository) {
    suspend operator fun invoke(): RepositoryResult<Int> {
        val prefs = when (val loaded = preferences.load()) {
            is RepositoryResult.Failure -> return loaded
            is RepositoryResult.Content -> loaded.value
        }
        return when (val counts = push.badgeCounts()) {
            is RepositoryResult.Failure -> counts
            is RepositoryResult.Content -> RepositoryResult.Content(
                (if (prefs.badgeApprovals) counts.value.pendingApprovals else 0) +
                    (if (prefs.badgeInvites) counts.value.pendingInvites else 0) +
                    (if (prefs.badgeInbox) counts.value.openInboxItems else 0),
            )
        }
    }
}
