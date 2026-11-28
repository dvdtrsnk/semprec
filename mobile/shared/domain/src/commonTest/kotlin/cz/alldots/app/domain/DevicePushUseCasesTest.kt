package cz.alldots.app.domain

import cz.alldots.app.core.AccountNotificationSwitch
import cz.alldots.app.core.AccountProblemsLevel
import cz.alldots.app.core.ApnsEnvironment
import cz.alldots.app.core.AppPlatform
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemoryPushSubscriptionStorage
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val ALL_ON = AccountNotificationPrefs(
    approvals = true,
    invites = true,
    reminders = true,
    calendarChanges = true,
    problemsLevel = AccountProblemsLevel.CRITICAL,
    problemsSummary = true,
    badgeApprovals = true,
    badgeInvites = true,
    badgeInbox = true,
)

private val REMINDER =
    UpcomingReminder("e1:t", "e1", ReminderKind.EVENT, "Dinner", "2026-11-21T08:45:00Z", "2026-11-21T09:00:00Z")

private class FakePush(
    val registered: RepositoryResult<String> = RepositoryResult.Content("sub-1"),
    val revoked: RepositoryResult<Unit> = RepositoryResult.Content(Unit),
    val reminders: RepositoryResult<List<UpcomingReminder>> = RepositoryResult.Content(listOf(REMINDER)),
    val counts: RepositoryResult<BadgeCounts> = RepositoryResult.Content(BadgeCounts(3, 2, 5)),
) : PushRepository {
    val registrations = mutableListOf<Triple<String, ApnsEnvironment, AppPlatform>>()
    val revocations = mutableListOf<String>()
    val windows = mutableListOf<Pair<String, Int>>()

    override suspend fun register(deviceToken: String, environment: ApnsEnvironment, platform: AppPlatform) =
        registered.also { registrations += Triple(deviceToken, environment, platform) }

    override suspend fun revoke(subscriptionId: String) = revoked.also { revocations += subscriptionId }

    override suspend fun upcomingReminders(from: String, hours: Int) = reminders.also { windows += from to hours }

    override suspend fun badgeCounts() = counts
}

private class FakePrefs(val prefs: RepositoryResult<AccountNotificationPrefs>) : AccountNotificationRepository {
    override suspend fun load() = prefs

    override suspend fun setSwitch(switch: AccountNotificationSwitch, on: Boolean) = error("not used")

    override suspend fun setProblemsLevel(level: AccountProblemsLevel) = error("not used")
}

class DevicePushUseCasesTest {

    @Test
    fun aRegisteredTokenKeepsTheIdOfItsSubscription() = runTest {
        val push = FakePush()
        val storage = InMemoryPushSubscriptionStorage()

        val result = RegisterPushSubscription(push, storage)("ab12", ApnsEnvironment.SANDBOX, AppPlatform.IOS)

        assertEquals(RepositoryResult.Content(Unit), result)
        assertEquals(listOf(Triple("ab12", ApnsEnvironment.SANDBOX, AppPlatform.IOS)), push.registrations)
        assertEquals("sub-1", storage.load())
    }

    @Test
    fun aRefusedRegistrationKeepsTheStoredIdAndABlankTokenIsNeverSent() = runTest {
        val refused = FakePush(registered = RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        val storage = InMemoryPushSubscriptionStorage().apply { save("sub-0") }

        val failed = RegisterPushSubscription(refused, storage)("ab12", ApnsEnvironment.PRODUCTION, AppPlatform.IOS)
        val blank = RegisterPushSubscription(refused, storage)(" ", ApnsEnvironment.PRODUCTION, AppPlatform.IOS)

        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), failed)
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), blank)
        assertEquals(1, refused.registrations.size)
        assertEquals("sub-0", storage.load())
    }

    @Test
    fun revokingEndsTheStoredSubscriptionAndForgetsItWhateverTheServerAnswers() = runTest {
        for (answer in listOf(RepositoryResult.Content(Unit), RepositoryResult.Failure(FailureKind.UNAVAILABLE))) {
            val push = FakePush(revoked = answer)
            val storage = InMemoryPushSubscriptionStorage().apply { save("sub-1") }

            val result = RevokePushSubscription(push, storage)()

            assertEquals(answer, result)
            assertEquals(listOf("sub-1"), push.revocations)
            assertNull(storage.load())
        }
    }

    @Test
    fun revokingWithoutASubscriptionSendsNothing() = runTest {
        val push = FakePush()

        val result = RevokePushSubscription(push, InMemoryPushSubscriptionStorage())()

        assertEquals(RepositoryResult.Content(Unit), result)
        assertTrue(push.revocations.isEmpty())
    }

    @Test
    fun theDeviceRemindsOfTheNextTwoDaysOnlyWhileRemindersAreOn() = runTest {
        val on = FakePush()
        assertEquals(
            RepositoryResult.Content(listOf(REMINDER)),
            LoadDeviceReminders(on, FakePrefs(RepositoryResult.Content(ALL_ON)))("2026-11-21T08:00:00Z"),
        )
        assertEquals(listOf("2026-11-21T08:00:00Z" to 48), on.windows)

        val off = FakePush()
        assertEquals(
            RepositoryResult.Content(emptyList()),
            LoadDeviceReminders(off, FakePrefs(RepositoryResult.Content(ALL_ON.copy(reminders = false))))("now"),
        )
        assertTrue(off.windows.isEmpty())

        val unknown = FakePush()
        assertEquals(
            RepositoryResult.Failure(FailureKind.UNAVAILABLE),
            LoadDeviceReminders(unknown, FakePrefs(RepositoryResult.Failure(FailureKind.UNAVAILABLE)))("now"),
        )
        assertTrue(unknown.windows.isEmpty())
    }

    @Test
    fun theBadgeCountsWhatItsSwitchesLeaveOn() = runTest {
        val cases = listOf(
            ALL_ON to 10,
            ALL_ON.copy(badgeInbox = false) to 5,
            ALL_ON.copy(badgeApprovals = false) to 7,
            ALL_ON.copy(badgeInvites = false) to 8,
            ALL_ON.copy(badgeApprovals = false, badgeInvites = false, badgeInbox = false) to 0,
        )
        for ((prefs, badge) in cases) {
            assertEquals(
                RepositoryResult.Content(badge),
                LoadAppBadge(FakePush(), FakePrefs(RepositoryResult.Content(prefs)))(),
                "$prefs",
            )
        }
    }

    @Test
    fun theBadgeIsUnknownWhenEitherReadFails() = runTest {
        val failure = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        assertEquals(failure, LoadAppBadge(FakePush(), FakePrefs(failure))())
        assertEquals(failure, LoadAppBadge(FakePush(counts = failure), FakePrefs(RepositoryResult.Content(ALL_ON)))())
    }
}
