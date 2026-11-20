package cz.semprec.app.presentation

import cz.semprec.app.core.AccountNotificationSwitch
import cz.semprec.app.core.AccountProblemsLevel
import cz.semprec.app.core.ApnsEnvironment
import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemoryPushSubscriptionStorage
import cz.semprec.app.domain.AccountNotificationPrefs
import cz.semprec.app.domain.AccountNotificationRepository
import cz.semprec.app.domain.BadgeCounts
import cz.semprec.app.domain.PushRepository
import cz.semprec.app.domain.ReminderKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.UpcomingReminder
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val PREFS = AccountNotificationPrefs(
    approvals = true,
    invites = true,
    reminders = true,
    problemsLevel = AccountProblemsLevel.CRITICAL,
    problemsSummary = true,
    badgeApprovals = true,
    badgeInvites = true,
    badgeInbox = false,
)

private class ScriptedPush(
    var registered: () -> RepositoryResult<String> = { RepositoryResult.Content("sub-1") },
    var reminders: () -> RepositoryResult<List<UpcomingReminder>> = { RepositoryResult.Content(emptyList()) },
    var counts: () -> RepositoryResult<BadgeCounts> = { RepositoryResult.Content(BadgeCounts(1, 2, 4)) },
) : PushRepository {
    override suspend fun register(deviceToken: String, environment: ApnsEnvironment, platform: AppPlatform) =
        registered()

    override suspend fun revoke(subscriptionId: String): RepositoryResult<Unit> = error("not used")

    override suspend fun upcomingReminders(from: String, hours: Int) = reminders()

    override suspend fun badgeCounts() = counts()
}

private object StoredPrefs : AccountNotificationRepository {
    override suspend fun load() = RepositoryResult.Content(PREFS)

    override suspend fun setSwitch(switch: AccountNotificationSwitch, on: Boolean) = error("not used")

    override suspend fun setProblemsLevel(level: AccountProblemsLevel) = error("not used")
}

class DeviceNotificationsTest {
    private val storage = InMemoryPushSubscriptionStorage()

    private fun notifications(push: ScriptedPush = ScriptedPush()) =
        DeviceNotificationsFactory(push, StoredPrefs, storage).deviceNotifications()

    @Test fun `a registered token is reported and its subscription kept`() = runTest {
        assertTrue(notifications().register("ab12", ApnsEnvironment.SANDBOX, AppPlatform.IOS))
        assertEquals("sub-1", storage.load())
    }

    @Test fun `a refused or crashed registration is reported as not registered`() = runTest {
        val refused = ScriptedPush(registered = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) })
        val crashed = ScriptedPush(registered = { error("boom") })
        assertFalse(notifications(refused).register("ab12", ApnsEnvironment.SANDBOX, AppPlatform.IOS))
        assertFalse(notifications(crashed).register("ab12", ApnsEnvironment.SANDBOX, AppPlatform.IOS))
        assertNull(storage.load())
    }

    @Test fun `reminders keep their key as identifier and their kind`() = runTest {
        val push = ScriptedPush(
            reminders = {
                RepositoryResult.Content(
                    listOf(
                        UpcomingReminder("e1:a", "e1", ReminderKind.EVENT, "Dinner", "2026-11-21T08:45:00Z", "s1"),
                        UpcomingReminder("t1:b", "t1", ReminderKind.TASK, "Call", "2026-11-21T10:00:00Z", "s2"),
                    ),
                )
            },
        )
        assertEquals(
            listOf(
                DeviceReminder("e1:a", DeviceReminderKind.EVENT, "e1", "Dinner", "2026-11-21T08:45:00Z", "s1"),
                DeviceReminder("t1:b", DeviceReminderKind.TASK, "t1", "Call", "2026-11-21T10:00:00Z", "s2"),
            ),
            notifications(push).reminders("2026-11-21T08:00:00Z"),
        )
    }

    @Test fun `unreadable reminders and badge are null so the device keeps what it has`() = runTest {
        val failing = ScriptedPush(
            reminders = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
            counts = { RepositoryResult.Failure(FailureKind.UNAUTHORIZED) },
        )
        assertNull(notifications(failing).reminders("now"))
        assertNull(notifications(failing).badge())
        val crashing = ScriptedPush(reminders = { error("boom") }, counts = { error("boom") })
        assertNull(notifications(crashing).reminders("now"))
        assertNull(notifications(crashing).badge())
    }

    @Test fun `the badge counts the approvals and invitations the person counts`() = runTest {
        assertEquals(3, notifications().badge())
    }

    @Test fun `a tapped notification leads to what its payload names`() {
        val cases: List<Pair<Map<String, String>, NotificationTarget?>> = listOf(
            mapOf("event_id" to "e1", "calendar_id" to "c1") to NotificationTarget.Event("e1"),
            mapOf("invitation_id" to "i1") to NotificationTarget.Invitations,
            mapOf("invitation_id" to "i1", "event_id" to "e1") to NotificationTarget.Invitations,
            mapOf("task_id" to "t1") to NotificationTarget.Task("t1"),
            mapOf("event_id" to "") to null,
            mapOf("notification_id" to "n1", "link_href" to "/approvals") to null,
            emptyMap<String, String>() to null,
        )
        val notifications = notifications()
        for ((payload, target) in cases) assertEquals(target, notifications.target(payload), "$payload")
    }

    @Test fun `the payload of a reminder leads back to its item`() {
        val notifications = notifications()
        val event = DeviceReminder("e1:a", DeviceReminderKind.EVENT, "e1", "Dinner", "f", "s")
        val task = DeviceReminder("t1:b", DeviceReminderKind.TASK, "t1", "Call", "f", "s")
        assertEquals(NotificationTarget.Event("e1"), notifications.target(notifications.payload(event)))
        assertEquals(NotificationTarget.Task("t1"), notifications.target(notifications.payload(task)))
    }

    @Test fun `only the reminders resync push asks for the reminders`() {
        val notifications = notifications()
        assertTrue(notifications.asksForReminders(mapOf("kind" to "remindersResync")))
        assertFalse(notifications.asksForReminders(mapOf("kind" to "sleepResync")))
        assertFalse(notifications.asksForReminders(mapOf("dismiss" to "n1")))
    }
}
