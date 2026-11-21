package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TestTimeSource

/** Answers the scripted accounts and records the syncs it is asked for; nothing else is used. */
private class SyncRecordingAccounts(
    var accounts: RepositoryResult<List<InternetAccount>>,
    val syncAnswers: Map<String, RepositoryResult<Unit>> = emptyMap(),
) : InternetAccountRepository {
    val calls = mutableListOf<String>()

    override suspend fun accounts(): RepositoryResult<List<InternetAccount>> {
        calls += "accounts"
        return accounts
    }

    override suspend fun syncCalendars(accountId: String): RepositoryResult<Unit> {
        calls += "sync $accountId"
        return syncAnswers[accountId] ?: RepositoryResult.Content(Unit)
    }

    override suspend fun account(accountId: String) = error("not used")

    override suspend fun setServiceEnabled(accountId: String, service: InternetService, enabled: Boolean) =
        error("not used")

    override suspend fun startSignIn(provider: OAuthProvider, services: Set<InternetService>) = error("not used")

    override suspend fun startReauthorization(accountId: String, services: Set<InternetService>) =
        error("not used")

    override suspend fun finishSignIn(signIn: OAuthSignIn, callbackUrl: String) = error("not used")
}

private fun account(id: String, calendars: Boolean) = InternetAccount(
    MailAccount(id, id, "gmail", null, "full", MailSyncStatus.OK, false, null, null, 5, true, 0),
    mailEnabled = true,
    calendarsEnabled = calendars,
    calendarStatus = if (calendars) CalendarSyncStatus.OK else CalendarSyncStatus.OFF,
)

class SyncAccountCalendarsTest {
    private val time = TestTimeSource()

    @Test fun `asks to sync every account with calendars switched on`() = runTest {
        val accounts = SyncRecordingAccounts(
            RepositoryResult.Content(listOf(account("a", true), account("b", false), account("c", true))),
        )
        SyncAccountCalendars(accounts, time)()
        assertEquals(listOf("accounts", "sync a", "sync c"), accounts.calls)
    }

    @Test fun `asks at most once a minute`() = runTest {
        val accounts = SyncRecordingAccounts(RepositoryResult.Content(listOf(account("a", true))))
        val sync = SyncAccountCalendars(accounts, time)
        sync()
        time += 59.seconds
        sync()
        assertEquals(listOf("accounts", "sync a"), accounts.calls)
        time += 1.seconds
        sync()
        assertEquals(listOf("accounts", "sync a", "accounts", "sync a"), accounts.calls)
    }

    @Test fun `a refused or missing sync of one account does not stop the others or the pause`() = runTest {
        val accounts = SyncRecordingAccounts(
            RepositoryResult.Content(listOf(account("a", true), account("b", true), account("c", true))),
            mapOf(
                "a" to RepositoryResult.Failure(FailureKind.NOT_FOUND),
                "b" to RepositoryResult.Failure(FailureKind.UNAVAILABLE),
            ),
        )
        val sync = SyncAccountCalendars(accounts, time)
        sync()
        sync()
        assertEquals(listOf("accounts", "sync a", "sync b", "sync c"), accounts.calls)
    }

    @Test fun `accounts that could not be read let the next request through at once`() = runTest {
        val accounts = SyncRecordingAccounts(RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        val sync = SyncAccountCalendars(accounts, time)
        sync()
        accounts.accounts = RepositoryResult.Content(listOf(account("a", true)))
        sync()
        assertEquals(listOf("accounts", "accounts", "sync a"), accounts.calls)
    }
}
